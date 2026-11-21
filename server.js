'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const storage = require('./storage');
const plugins = require('./plugins');
const updater = require('./updater');
const { GameManager } = require('./game');
const { AccountStore, PERMISSIONS, publicUser } = storage;
const { AuditStore } = storage;
const panelVersion = require('./package.json').version;

const dataDir = path.resolve(process.env.SCP_PANEL_DATA_DIR || path.join(__dirname, 'data'));
const settingsFile = path.join(dataDir, 'settings.json');
const port = Number(process.env.SCP_PANEL_PORT || 3767);
const host = process.env.SCP_PANEL_BIND || '127.0.0.1';
const tlsCert = process.env.SCP_PANEL_TLS_CERT;
const tlsKey = process.env.SCP_PANEL_TLS_KEY;
const tlsPfx = process.env.SCP_PANEL_TLS_PFX;
const tlsPfxPassword = process.env.SCP_PANEL_TLS_PFX_PASSWORD;
const sessions = new Map();
const failures = new Map();
const writeQueues = new Map();

async function serializeAction(key, action) {
  const previous = writeQueues.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  writeQueues.set(key, current);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (writeQueues.get(key) === current) writeQueues.delete(key);
  }
}

function serializeWrite(id, action) {
  storage.parseId(id);
  return serializeAction(`file:${id}`, action);
}

function send(res, status, body, type = 'application/json; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
    ...extraHeaders,
  });
  const output = Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body);
  const auditContext = res.auditContext;
  if (!auditContext) return res.end(output);
  res.auditContext = null;
  auditContext.store.record({ ...auditContext, store: undefined, status }).then(
    () => res.end(output),
    error => { console.error('写入操作记录失败：', error); res.end(output); },
  );
}

function fail(res, status, message) { send(res, status, { error: message }); }

async function bodyJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new storage.HttpError(415, '需要 JSON 请求');
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 1.5 * 1024 * 1024) throw new storage.HttpError(413, '请求过大');
    parts.push(part);
  }
  try {
    const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('JSON object required');
    return value;
  }
  catch { throw new storage.HttpError(400, 'JSON 格式错误'); }
}

async function bodyBinary(req, limit, type = '插件', format = '.dll') {
  if (req.headers['content-type'] !== 'application/octet-stream') throw new storage.HttpError(415, `请上传 ${format} 文件`);
  if (Number(req.headers['content-length']) > limit) throw new storage.HttpError(413, `${type}文件过大`);
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw new storage.HttpError(413, `${type}文件过大`);
    parts.push(part);
  }
  return Buffer.concat(parts);
}

function checkOrigin(req) {
  if (!req.headers.origin) return;
  let origin;
  try { origin = new URL(req.headers.origin); }
  catch { throw new storage.HttpError(403, '来源无效'); }
  if (origin.host !== req.headers.host || !['http:', 'https:'].includes(origin.protocol)) {
    throw new storage.HttpError(403, '跨站请求已拒绝');
  }
}

function cookie(req, name) {
  const raw = String(req.headers.cookie || '').split(';').map(s => s.trim());
  const found = raw.find(s => s.startsWith(name + '='));
  return found ? found.slice(name.length + 1) : null;
}

function session(req, accounts) {
  const token = cookie(req, 'scp_session');
  const entry = token && sessions.get(token);
  if (!entry) return null;
  const user = accounts.byId(entry.id);
  if (Date.now() > entry.expires || !user || user.authVersion !== entry.authVersion) { sessions.delete(token); return null; }
  return user;
}

function setSessionCookie(req, res, value, age) {
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const secure = req.socket.encrypted || (loopback && (req.headers['x-forwarded-proto'] === 'https' || String(req.headers.origin || '').startsWith('https://')));
  res.setHeader('Set-Cookie', `scp_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure ? '; Secure' : ''}`);
}

function loginAllowed(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const entry = failures.get(ip);
  if (!entry || Date.now() - entry.start > 15 * 60 * 1000) { failures.set(ip, { start: Date.now(), count: 0 }); return true; }
  return entry.count < 8;
}

function recordFailure(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const entry = failures.get(ip) || { start: Date.now(), count: 0 };
  entry.count++;
  failures.set(ip, entry);
}

async function serveStatic(res, name, type) {
  const bytes = await fsp.readFile(path.join(__dirname, 'public', name));
  send(res, 200, bytes.toString('utf8'), type);
}

const AUDIT_ACTIONS = Object.freeze({
  'POST /api/login': '登录',
  'POST /api/logout': '退出登录',
  'POST /api/accounts': '创建服管理员',
  'POST /api/accounts/update': '修改服管理员',
  'POST /api/accounts/delete': '删除服管理员',
  'POST /api/account/password': '修改自己的密码',
  'POST /api/file': '保存配置文件',
  'POST /api/restore': '恢复配置备份',
  'POST /api/game/config': '修改游戏控制设置',
  'POST /api/game/idle-restart': '修改无人自动重启设置',
  'POST /api/game/start': '启动游戏服务器',
  'POST /api/game/restart': '重启游戏服务器',
  'POST /api/game/stop': '关闭游戏服务器',
  'POST /api/game/players': '手动查询玩家',
  'POST /api/game/command': '发送 LocalAdmin 控制台命令',
  'POST /api/player/profile': '修改玩家资料',
  'POST /api/player/level': '修改 PlayerLevels 游戏等级',
  'POST /api/player/badge': '修改 PlayerBadge 游戏标签',
  'POST /api/player/admin': '修改游戏管理员组',
  'POST /api/panel/update': '更新面板',
  'POST /api/plugins/upload': '上传插件',
  'POST /api/plugins/toggle': '更改插件状态',
  'POST /api/plugins/description': '修改插件作用说明',
  'POST /api/plugins/delete': '删除插件',
  'GET /api/file': '查看配置文件',
  'GET /api/file/download': '下载配置文件',
  'GET /api/plugins/download': '下载插件',
  'GET /api/backups': '查看配置备份',
});

function auditAction(req, url) {
  if (req.method === 'GET' && url.pathname === '/api/players' && url.searchParams.get('q')) return '搜索玩家记录';
  return AUDIT_ACTIONS[`${req.method} ${url.pathname}`] || null;
}

function auditCommand(command) {
  const line = command.trim().replace(/\s+/g, ' ');
  const name = line.split(' ', 1)[0];
  if (/(?:pass(?:word|wd)?|token|secret|auth|key|credential|login|qqmsg|message|broadcast|whisper|\bpm\b|say|hint)/i.test(name)
    || /(?:^|[\s;,&?])(?:pass(?:word|wd)?|token|secret|api[_-]?key|auth|credential|private[_-]?key)(?:[\s:=]|$)/i.test(line)
    || /https?:\/\//i.test(line)) return `${name}（参数已隐藏）`;
  return line;
}

function auditPlayer(game, steam64) {
  const id = String(steam64 || '');
  const name = game.playerStore.records.get(id)?.name;
  return name ? `${name} (${id})` : id;
}

async function start() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SCP_PANEL_PORT 无效');
  if ((tlsCert && !tlsKey) || (!tlsCert && tlsKey)) throw new Error('TLS 证书和私钥必须同时设置');
  if (tlsPfx && (tlsCert || tlsKey)) throw new Error('PFX 和 PEM 证书不能同时设置');
  if (tlsPfx && !tlsPfxPassword) throw new Error('PFX 缺少密码');
  const hasTls = Boolean(tlsCert || tlsPfx);
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !hasTls) {
    throw new Error('对外监听需要 HTTPS：设置 SCP_PANEL_TLS_CERT 和 SCP_PANEL_TLS_KEY。推荐保持 127.0.0.1 并使用 Tailscale Serve。');
  }
  const accounts = new AccountStore(dataDir);
  await accounts.init(settingsFile);
  const audit = new AuditStore(dataDir);
  const roots = storage.rootsFromEnvironment();
  const game = new GameManager(dataDir, roots);
  await game.init();
  const gameAdminStores = new Map();
  async function gameAdminStore(port) {
    if (!gameAdminStores.has(port)) {
      const store = new storage.GameAdminLogStore(dataDir, roots, port);
      const loading = store.init().then(() => store).catch(error => { gameAdminStores.delete(port); throw error; });
      gameAdminStores.set(port, loading);
    }
    return gameAdminStores.get(port);
  }
  let updating = false;
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST' || req.method === 'PUT') checkOrigin(req);
      const action = auditAction(req, url);
      if (action) res.auditContext = { store: audit, action, username: '未登录', actorId: '',
        ip: String(req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, ''),
        target: url.searchParams.get('id') || url.searchParams.get('name') || '' };
      if (req.method === 'GET' && url.pathname === '/') return serveStatic(res, 'index.html', 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/app.js') return serveStatic(res, 'app.js', 'text/javascript; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/config-editor.js') return serveStatic(res, 'config-editor.js', 'text/javascript; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/manage.js') return serveStatic(res, 'manage.js', 'text/javascript; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/style.css') return serveStatic(res, 'style.css', 'text/css; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/api/session') {
        const user = session(req, accounts);
        return send(res, 200, { authenticated: Boolean(user), user: user ? publicUser(user) : null });
      }

      if (req.method === 'POST' && url.pathname === '/api/login') {
        if (!loginAllowed(req)) { res.auditContext = null; return fail(res, 429, '尝试次数过多，请 15 分钟后再试'); }
        const body = await bodyJson(req);
        res.auditContext.target = String(body.username || 'owner');
        const user = accounts.login(body.username || 'owner', body.password);
        if (!user) {
          recordFailure(req);
          return fail(res, 401, '账号或密码错误');
        }
        failures.delete(req.socket.remoteAddress || 'unknown');
        res.auditContext.username = user.username;
        res.auditContext.actorId = user.id;
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, { id: user.id, authVersion: user.authVersion, expires: Date.now() + 12 * 60 * 60 * 1000 });
        setSessionCookie(req, res, token, 12 * 60 * 60);
        return send(res, 200, { ok: true, user: publicUser(user) });
      }

      const user = session(req, accounts);
      if (!user) { res.auditContext = null; return fail(res, 401, '请先登录'); }
      if (res.auditContext) { res.auditContext.username = user.username; res.auditContext.actorId = user.id; }
      const requirePermission = permission => {
        if (!accounts.can(user, permission)) throw new storage.HttpError(403, '当前账号没有此操作权限');
      };
      const requireOwner = () => { if (!user.owner) throw new storage.HttpError(403, '仅主账号可以执行此操作'); };
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        sessions.delete(cookie(req, 'scp_session'));
        setSessionCookie(req, res, '', 0);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/accounts/permissions') { requireOwner(); return send(res, 200, { permissions: PERMISSIONS }); }
      if (req.method === 'GET' && url.pathname === '/api/accounts') { requireOwner(); return send(res, 200, { users: accounts.list() }); }
      if (req.method === 'GET' && url.pathname === '/api/audit') {
        requireOwner();
        return send(res, 200, await audit.list({ limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset'), search: url.searchParams.get('q') || '' }));
      }
      if (req.method === 'GET' && url.pathname === '/api/game/admin-logs') {
        requireOwner();
        const logs = await gameAdminStore(game.config.port);
        return send(res, 200, await logs.list(url.searchParams.get('q') || '', url.searchParams.get('limit') || 100));
      }
      if (req.method === 'POST' && url.pathname === '/api/accounts') {
        requireOwner(); const body = await bodyJson(req);
        res.auditContext.target = String(body.username || '');
        return send(res, 200, await serializeAction('accounts', () => accounts.create(body.username, body.password, body.permissions)));
      }
      if (req.method === 'POST' && url.pathname === '/api/accounts/update') {
        requireOwner(); const body = await bodyJson(req);
        res.auditContext.target = accounts.users.find(row => row.id === body.id)?.username || '';
        return send(res, 200, await serializeAction('accounts', () => accounts.update(body.id, body)));
      }
      if (req.method === 'POST' && url.pathname === '/api/accounts/delete') {
        requireOwner(); const body = await bodyJson(req);
        res.auditContext.target = accounts.users.find(row => row.id === body.id)?.username || '';
        await serializeAction('accounts', () => accounts.remove(body.id));
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/account/password') {
        const body = await bodyJson(req);
        await serializeAction('accounts', () => accounts.changeOwnPassword(user.id, body.oldPassword, body.newPassword));
        sessions.delete(cookie(req, 'scp_session'));
        setSessionCookie(req, res, '', 0);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/files') { requirePermission('config.read'); return send(res, 200, { files: await storage.listFiles(roots) }); }
      if (req.method === 'GET' && url.pathname === '/api/file') { requirePermission('config.read'); return send(res, 200, await storage.readFile(roots, url.searchParams.get('id'))); }
      if (req.method === 'GET' && url.pathname === '/api/file/download') {
        requirePermission('config.read');
        const file = await storage.downloadFile(roots, url.searchParams.get('id'));
        return send(res, 200, file.bytes, 'application/octet-stream', {
          'Content-Disposition': `attachment; filename="${file.name}"`,
          'Content-Length': file.bytes.length,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/backups') { requirePermission('config.read'); return send(res, 200, { backups: await storage.listBackups(dataDir, url.searchParams.get('id')) }); }
      if (req.method === 'POST' && url.pathname === '/api/file') {
        requirePermission('config.write');
        const body = await bodyJson(req);
        res.auditContext.target = String(body.id || '');
        return send(res, 200, await serializeWrite(body.id, () => storage.saveFile(roots, dataDir, body.id, body.content, body.revision)));
      }
      if (req.method === 'POST' && url.pathname === '/api/restore') {
        requirePermission('config.write');
        const body = await bodyJson(req);
        res.auditContext.target = String(body.id || '');
        return send(res, 200, await serializeWrite(body.id, () => storage.restoreBackup(roots, dataDir, body.id, body.name, body.revision)));
      }
      if (req.method === 'GET' && url.pathname === '/api/game/status') { requirePermission('server.view'); return send(res, 200, await game.status()); }
      if (req.method === 'GET' && url.pathname === '/api/game/logs') {
        if (!accounts.can(user, 'players.records') && !accounts.can(user, 'server.console')) throw new storage.HttpError(403, '当前账号没有查看控制台的权限');
        return send(res, 200, game.logs(Number(url.searchParams.get('after') || 0)));
      }
      if (req.method === 'POST' && url.pathname === '/api/game/command') {
        requirePermission('server.console');
        const body = await bodyJson(req);
        const command = body.command;
        if (typeof command !== 'string' || !command.trim() || command.length > 200 || /[\x00-\x1f\x7f]/.test(command)) {
          throw new storage.HttpError(400, '命令必须是 1 到 200 字符的单行文本');
        }
        res.auditContext.target = auditCommand(command);
        game.sendCommand(command.trim());
        return send(res, 200, { accepted: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/game/config') {
        requirePermission('server.control');
        const body = await bodyJson(req);
        return send(res, 200, await game.configure(body.executable, body.port, body.playersCommand, body.consoleEncoding));
      }
      if (req.method === 'POST' && url.pathname === '/api/game/idle-restart') {
        requirePermission('server.control');
        const body = await bodyJson(req);
        res.auditContext.target = `${body.minutes} 分钟`;
        return send(res, 200, await game.configureIdleRestart(body.minutes));
      }
      if (req.method === 'POST' && url.pathname === '/api/game/start') { requirePermission('server.control'); return send(res, 200, await game.start()); }
      if (req.method === 'POST' && url.pathname === '/api/game/restart') { requirePermission('server.control'); return send(res, 200, game.restart()); }
      if (req.method === 'POST' && url.pathname === '/api/game/stop') { requirePermission('server.control'); return send(res, 200, game.stop()); }
      if (req.method === 'POST' && url.pathname === '/api/game/players') {
        requirePermission('players.online');
        const result = await game.players();
        if (accounts.can(user, 'players.records')) return send(res, 200, result);
        const status = game.playerStatus();
        return send(res, 200, { lines: [], online: status.online.map(({ steam64, name }) => ({ steam64, name })),
          known: [], totalKnown: 0, lastChecked: status.lastChecked,
          lastEventAt: status.lastEventAt, lastEvent: status.lastEvent, error: status.error });
      }
      if (req.method === 'GET' && url.pathname === '/api/players') {
        if (!accounts.can(user, 'players.online') && !accounts.can(user, 'players.records')) throw new storage.HttpError(403, '当前账号没有查看玩家的权限');
        const result = game.playerStatus(url.searchParams.get('q') || '');
        return send(res, 200, accounts.can(user, 'players.records') ? result :
          { online: result.online.map(({ steam64, name }) => ({ steam64, name })), known: [], totalKnown: 0,
            lastChecked: result.lastChecked, lastEventAt: result.lastEventAt, lastEvent: result.lastEvent, error: result.error });
      }
      if (req.method === 'POST' && url.pathname === '/api/player/profile') {
        requirePermission('players.manage');
        const body = await bodyJson(req);
        res.auditContext.target = `${auditPlayer(game, body.steam64)} · 累计时长 ${body.playMinutes} 分钟`;
        try { await game.playerStore.edit(body.steam64, body); }
        catch (error) { throw new storage.HttpError(400, error.message); }
        return send(res, 200, { player: game.playerStore.view(body.steam64).known.find(row => row.steam64 === body.steam64) });
      }
      if (req.method === 'GET' && url.pathname === '/api/player/level') {
        requirePermission('players.records');
        const steam64 = url.searchParams.get('steam64');
        return send(res, 200, { ...await storage.getPlayerLevel(roots, game.config.port, steam64),
          pending: game.pendingFor('level', steam64), pendingError: game.pendingError });
      }
      if (req.method === 'POST' && url.pathname === '/api/player/level') {
        requirePermission('players.manage');
        const body = await bodyJson(req);
        res.auditContext.target = `${auditPlayer(game, body.steam64)} · 等级 ${body.level}`;
        if (!game.playerStore.records.has(body.steam64)) throw new storage.HttpError(404, '玩家记录不存在');
        if (game.child) {
          const queued = await game.queuePlayerEdit('level', body.steam64, { level: body.level });
          return send(res, 200, { ...queued, revision: body.revision });
        }
        if ((await game.externalProcesses()).length) throw new storage.HttpError(409, '原窗口运行中；请先从面板接管游戏服务，才能安排回合结束后自动生效');
        const id = `labapi:${game.config.port}/PlayerLevels/players.txt`;
        const result = await serializeWrite(id, () => storage.setPlayerLevel(roots, dataDir, game.config.port,
          body.steam64, body.level, body.revision));
        await game.playerStore.edit(body.steam64, { level: body.level });
        return send(res, 200, result);
      }
      if (req.method === 'GET' && url.pathname === '/api/player/badge') {
        requirePermission('players.records');
        const steam64 = url.searchParams.get('steam64');
        return send(res, 200, { ...await storage.getPlayerBadge(roots, game.config.port, steam64),
          pending: game.pendingFor('badge', steam64), pendingError: game.pendingError });
      }
      if (req.method === 'POST' && url.pathname === '/api/player/badge') {
        requirePermission('players.manage');
        const body = await bodyJson(req);
        res.auditContext.target = `${auditPlayer(game, body.steam64)} · 标签 ${body.name || '移除'} · ${body.color || ''}`;
        if (!game.playerStore.records.has(body.steam64)) throw new storage.HttpError(404, '玩家记录不存在');
        if (game.child) {
          const queued = await game.queuePlayerEdit('badge', body.steam64, { name: body.name, color: body.color });
          return send(res, 200, { ...queued, revision: body.revision, restartRequired: true });
        }
        if ((await game.externalProcesses()).length) throw new storage.HttpError(409, '原窗口运行中；请先从面板接管游戏服务，才能安排回合结束后自动生效');
        const id = `badge:${game.config.port}:configs.yml`;
        const result = await serializeWrite(id, () => storage.setPlayerBadge(roots, dataDir, game.config.port,
          body.steam64, body.name, body.color, body.revision));
        await game.playerStore.setPluginBadge(body.steam64, result.name, result.color);
        return send(res, 200, { ...result, restartRequired: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/player/admin') {
        requireOwner();
        return send(res, 200, await storage.getRemoteAdmin(roots, game.config.port, url.searchParams.get('steam64')));
      }
      if (req.method === 'POST' && url.pathname === '/api/player/admin') {
        requireOwner();
        const body = await bodyJson(req);
        res.auditContext.target = `${auditPlayer(game, body.steam64)} · 管理员组 ${body.group || '普通玩家'}`;
        const id = `game:${game.config.port}:config_remoteadmin.txt`;
        const result = await serializeWrite(id, () => storage.setRemoteAdmin(roots, dataDir, game.config.port,
          body.steam64, body.group, body.revision));
        return send(res, 200, result);
      }
      if (req.method === 'GET' && url.pathname === '/api/panel/version') { requireOwner(); return send(res, 200, { version: panelVersion }); }
      if (req.method === 'POST' && url.pathname === '/api/panel/update') {
        requireOwner();
        if (updating) throw new storage.HttpError(409, '面板正在更新');
        if (game.child) throw new storage.HttpError(409, '请先关闭由面板启动的游戏服务器，再更新面板');
        updating = true;
        try {
          const bytes = await bodyBinary(req, updater.MAX_UPDATE_BYTES, '更新包', '.zip');
          const result = await updater.installUpdate(dataDir, bytes);
          send(res, 200, result);
          await audit.queue.catch(() => {});
          setTimeout(() => process.exit(42), 1200).unref();
          return;
        } catch (error) { updating = false; throw error; }
      }
      if (req.method === 'GET' && url.pathname === '/api/plugins') { requirePermission('plugins.read'); return send(res, 200, { plugins: await plugins.list(roots, game.config.port, dataDir) }); }
      if (req.method === 'GET' && url.pathname === '/api/plugins/download') {
        requirePermission('plugins.read');
        const kind = url.searchParams.get('kind');
        const name = url.searchParams.get('name');
        const state = url.searchParams.get('enabled');
        if (state !== 'true' && state !== 'false') throw new storage.HttpError(400, '插件状态无效');
        res.auditContext.target = `${kind || ''} / ${name || ''}`;
        const file = await plugins.download(roots, game.config.port, kind, name, state === 'true');
        return send(res, 200, file.bytes, 'application/octet-stream', {
          'Content-Disposition': `attachment; filename="${file.name}"`,
          'Content-Length': file.bytes.length,
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/plugins/upload') {
        requirePermission('plugins.manage');
        const kind = url.searchParams.get('kind');
        const name = url.searchParams.get('name');
        plugins.pluginRoot(roots, kind, game.config.port);
        plugins.validateName(name);
        const bytes = await bodyBinary(req, plugins.MAX_PLUGIN_BYTES);
        const replace = url.searchParams.get('replace') === 'true';
        res.auditContext.target = `${kind} / ${name}${replace ? ' · 替换旧插件' : ''}`;
        return send(res, 200, await serializeAction(`plugin:${kind}:${name}`, () => plugins.upload(roots, dataDir, game.config.port, kind, name, bytes, replace)));
      }
      if (req.method === 'POST' && url.pathname === '/api/plugins/toggle') {
        requirePermission('plugins.manage');
        const body = await bodyJson(req);
        res.auditContext.target = `${body.kind || ''} / ${body.name || ''} · ${body.enabled ? '启用' : '停用'}`;
        plugins.pluginRoot(roots, body.kind, game.config.port);
        plugins.validateName(body.name);
        return send(res, 200, await serializeAction(`plugin:${body.kind}:${body.name}`, () => plugins.setEnabled(roots, game.config.port, body.kind, body.name, body.enabled)));
      }
      if (req.method === 'POST' && url.pathname === '/api/plugins/description') {
        requirePermission('plugins.manage');
        const body = await bodyJson(req);
        res.auditContext.target = `${body.kind || ''} / ${body.name || ''}`;
        plugins.pluginRoot(roots, body.kind, game.config.port);
        plugins.validateName(body.name);
        return send(res, 200, await serializeAction(`plugin:${body.kind}:${body.name}`, () => plugins.setDescription(roots, dataDir, game.config.port, body.kind, body.name, body.description)));
      }
      if (req.method === 'POST' && url.pathname === '/api/plugins/delete') {
        requirePermission('plugins.manage');
        const body = await bodyJson(req);
        res.auditContext.target = `${body.kind || ''} / ${body.name || ''}`;
        plugins.pluginRoot(roots, body.kind, game.config.port);
        plugins.validateName(body.name);
        return send(res, 200, await serializeAction(`plugin:${body.kind}:${body.name}`, () => plugins.remove(roots, dataDir, game.config.port, body.kind, body.name, body.enabled)));
      }
      return fail(res, 404, '页面不存在');
    } catch (error) {
      const status = error.status || (error.code === 'ENOENT' ? 404 : 500);
      if (status === 500) console.error(error);
      fail(res, status, status === 500 ? '服务器内部错误' : error.message);
    }
  };
  const server = hasTls
    ? https.createServer(tlsPfx
      ? { pfx: fs.readFileSync(tlsPfx), passphrase: tlsPfxPassword }
      : { cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) }, handler)
    : http.createServer(handler);
  server.listen(port, host, () => console.log(`SCP:SL 面板已启动：http${hasTls ? 's' : ''}://${host}:${port}`));
  return server;
}

if (require.main === module) start().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { start, auditCommand };
