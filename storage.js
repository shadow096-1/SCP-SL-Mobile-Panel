'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');

const MAX_FILE_BYTES = 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function rootsFromEnvironment(env = process.env) {
  const roaming = env.APPDATA;
  if (!roaming && (!env.SCP_PANEL_GAME_ROOT || !env.SCP_PANEL_EXILED_ROOT)) {
    throw new Error('缺少 APPDATA，请设置 SCP_PANEL_GAME_ROOT 和 SCP_PANEL_EXILED_ROOT。');
  }
  return {
    game: path.resolve(env.SCP_PANEL_GAME_ROOT || path.join(roaming, 'SCP Secret Laboratory', 'config')),
    exiled: path.resolve(env.SCP_PANEL_EXILED_ROOT || path.join(roaming, 'EXILED', 'Configs')),
    labapi: path.resolve(env.SCP_PANEL_LABAPI_CONFIG_ROOT || path.join(
      path.dirname(env.SCP_PANEL_GAME_ROOT || path.join(roaming, 'SCP Secret Laboratory', 'config')), 'LabAPI', 'configs')),
  };
}

function safeSegments(relative) {
  const parts = relative.split('/');
  if (parts.length > 4 || parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')) {
    throw new HttpError(400, '无效文件');
  }
  return parts;
}

function parseId(id) {
  if (typeof id !== 'string') throw new HttpError(400, '无效文件');
  let badge = /^badge:([0-9]{1,5}):configs\.yml$/.exec(id);
  if (badge && Number(badge[1]) >= 1 && Number(badge[1]) <= 65535) {
    return { kind: 'badge', port: badge[1], name: 'configs.yml' };
  }
  let match = /^game:([0-9]{1,5}):(config_[A-Za-z0-9_-]+\.txt)$/.exec(id);
  if (match && Number(match[1]) >= 1 && Number(match[1]) <= 65535) {
    return { kind: 'game', port: match[1], name: match[2] };
  }
  match = /^(exiled|labapi):(.+)$/.exec(id);
  if (match) {
    const parts = safeSegments(match[2]);
    if (!/\.(?:ya?ml|txt)$/i.test(parts.at(-1)) || (match[1] === 'exiled' && !/\.ya?ml$/i.test(parts.at(-1)))) {
      throw new HttpError(400, '无效文件');
    }
    return { kind: match[1], name: match[2], parts };
  }
  throw new HttpError(400, '无效文件');
}

function filePath(roots, id) {
  const item = parseId(id);
  return { item, full: item.kind === 'game'
    ? path.join(roots.game, item.port, item.name)
    : item.kind === 'badge' ? path.join(roots.labapi, item.port, 'Player Badge Plugin', 'configs.yml')
    : path.join(roots[item.kind], ...item.parts) };
}

async function checkedPath(roots, id) {
  const { item, full } = filePath(roots, id);
  const root = await fs.realpath(roots[item.kind === 'badge' ? 'labapi' : item.kind]);
  const real = await fs.realpath(full);
  const relative = path.relative(root, real);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
    throw new HttpError(403, '文件不在配置目录中');
  }
  const stat = await fs.stat(real);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new HttpError(400, '文件过大或不是普通文件');
  return real;
}

async function listFiles(roots) {
  const result = [];
  try {
    for (const dir of await fs.readdir(roots.game, { withFileTypes: true })) {
      if (!dir.isDirectory() || !/^[0-9]{1,5}$/.test(dir.name) || Number(dir.name) < 1 || Number(dir.name) > 65535) continue;
      for (const file of await fs.readdir(path.join(roots.game, dir.name), { withFileTypes: true })) {
        if (file.isFile() && /^config_[A-Za-z0-9_-]+\.txt$/.test(file.name)) {
          result.push({ id: `game:${dir.name}:${file.name}`, group: `游戏 · ${dir.name}`, name: file.name });
        }
      }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  async function scan(root, kind, group, parts = []) {
    let entries;
    try { entries = await fs.readdir(path.join(root, ...parts), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (!/^[A-Za-z0-9_.-]+$/.test(entry.name) || entry.name === '.' || entry.name === '..') continue;
      const next = [...parts, entry.name];
      if (entry.isDirectory() && next.length < 4) await scan(root, kind, group, next);
      else if (entry.isFile() && (kind === 'exiled' ? /\.ya?ml$/i : /\.(?:ya?ml|txt)$/i).test(entry.name)) {
        const relative = next.join('/');
        result.push({ id: `${kind}:${relative}`, group, name: relative });
      }
      if (result.length >= 500) return;
    }
  }
  await scan(roots.exiled, 'exiled', 'EXILED');
  if (roots.labapi) await scan(roots.labapi, 'labapi', 'LabAPI');
  return result.sort((a, b) => a.group.localeCompare(b.group, 'zh') || a.name.localeCompare(b.name, 'zh'));
}

function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

async function readFile(roots, id) {
  const full = await checkedPath(roots, id);
  const bytes = await fs.readFile(full);
  if (bytes.length > MAX_FILE_BYTES) throw new HttpError(400, '文件过大');
  let content;
  try { content = decoder.decode(bytes); }
  catch { throw new HttpError(415, '仅支持 UTF-8 文本配置文件'); }
  return { id, content, revision: digest(bytes) };
}

async function downloadFile(roots, id) {
  const full = await checkedPath(roots, id);
  const bytes = await fs.readFile(full);
  if (bytes.length > MAX_FILE_BYTES) throw new HttpError(400, '文件过大');
  return { name: path.posix.basename(parseId(id).name), bytes };
}

function backupFolder(dataDir, id) {
  const folder = id.includes('/') ? digest(Buffer.from(id)).slice(0, 32) : id.replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(dataDir, 'backups', folder);
}

async function backupBytes(dataDir, id, bytes) {
  const dir = backupFolder(dataDir, id);
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${stamp}-${crypto.randomBytes(4).toString('hex')}.bak`;
  await fs.writeFile(path.join(dir, name), bytes, { flag: 'wx', mode: 0o600 });
  return name;
}

async function atomicReplace(full, bytes) {
  const temporary = path.join(path.dirname(full), `.${path.basename(full)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const displaced = `${temporary}.old`;
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx' });
    if (process.platform === 'win32') {
      await fs.rename(full, displaced);
      try { await fs.rename(temporary, full); }
      catch (error) { await fs.rename(displaced, full); throw error; }
      await fs.rm(displaced).catch(() => {});
    } else {
      await fs.rename(temporary, full);
    }
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

async function saveFile(roots, dataDir, id, content, revision) {
  if (typeof content !== 'string' || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) {
    throw new HttpError(400, '保存数据无效');
  }
  const full = await checkedPath(roots, id);
  const original = await fs.readFile(full);
  if (digest(original) !== revision) throw new HttpError(409, '文件已被其他人修改，请重新加载');
  const textBytes = Buffer.from(content, 'utf8');
  const bytes = original.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), textBytes])
    : textBytes;
  if (bytes.length > MAX_FILE_BYTES) throw new HttpError(413, '文件超过 1 MB');
  const backup = await backupBytes(dataDir, id, original);
  await atomicReplace(full, bytes);
  return { revision: digest(bytes), backup };
}

function remoteAdminId(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, '游戏端口无效');
  return `game:${port}:config_remoteadmin.txt`;
}

function remoteAdminInfo(content, steam64) {
  const lines = content.split(/\r?\n/);
  const members = lines.findIndex(line => /^Members:\s*(?:#.*)?$/i.test(line));
  if (members < 0) throw new HttpError(422, '管理员配置缺少 Members: 区域');
  let end = members + 1;
  while (end < lines.length && !/^[A-Za-z][A-Za-z0-9_ -]*:/.test(lines[end])) end++;
  const roles = new Set();
  const roleStart = lines.findIndex(line => /^Roles:\s*(?:#.*)?$/i.test(line));
  if (roleStart >= 0) {
    for (let i = roleStart + 1; i < lines.length && !/^[A-Za-z][A-Za-z0-9_ -]*:/.test(lines[i]); i++) {
      const match = /^\s+-\s+([A-Za-z0-9_-]+)\s*(?:#.*)?$/.exec(lines[i]);
      if (match) roles.add(match[1]);
    }
  }
  for (const line of lines) {
    const match = /^([A-Za-z0-9_-]+)_badge\s*:/.exec(line);
    if (match) roles.add(match[1]);
  }
  let group = '';
  for (let i = members + 1; i < end; i++) {
    const match = /^\s+-\s+(7656119\d{10})@steam:\s*([A-Za-z0-9_-]+)\s*(?:#.*)?$/i.exec(lines[i]);
    if (match?.[1] === steam64) group = match[2];
  }
  if (group) roles.add(group);
  return { lines, members, end, roles: [...roles].sort(), group };
}

async function getRemoteAdmin(roots, port, steam64) {
  if (!/^7656119\d{10}$/.test(steam64 || '')) throw new HttpError(400, 'Steam64 ID 无效');
  const id = remoteAdminId(port);
  const file = await readFile(roots, id);
  const info = remoteAdminInfo(file.content, steam64);
  return { roles: info.roles, group: info.group, revision: file.revision };
}

async function setRemoteAdmin(roots, dataDir, port, steam64, group, revision) {
  if (!/^7656119\d{10}$/.test(steam64 || '')) throw new HttpError(400, 'Steam64 ID 无效');
  if (typeof group !== 'string' || (group && !/^[A-Za-z0-9_-]+$/.test(group))) throw new HttpError(400, '管理员组无效');
  const id = remoteAdminId(port);
  const file = await readFile(roots, id);
  if (file.revision !== revision) throw new HttpError(409, '管理员配置已变化，请重新加载玩家信息');
  const info = remoteAdminInfo(file.content, steam64);
  if (group && !info.roles.includes(group)) throw new HttpError(400, '只能选择配置文件中已有的管理员组');
  const kept = info.lines.filter((line, index) => index <= info.members || index >= info.end ||
    !new RegExp(`^\\s+-\\s+${steam64}@steam:`, 'i').test(line));
  if (group) kept.splice(info.members + 1, 0, ` - ${steam64}@steam: ${group}`);
  const newline = file.content.includes('\r\n') ? '\r\n' : '\n';
  const result = await saveFile(roots, dataDir, id, kept.join(newline), revision);
  return { ...result, group };
}

const BADGE_COLORS = Object.freeze(['pink', 'red', 'brown', 'silver', 'light_green', 'crimson', 'cyan', 'aqua',
  'deep_pink', 'tomato', 'yellow', 'magenta', 'blue_green', 'orange', 'lime', 'green', 'emerald',
  'carmine', 'nickel', 'mint', 'army_green', 'pumpkin', 'white', 'rainbow']);

function playerLevelsId(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, '游戏端口无效');
  return `labapi:${port}/PlayerLevels/players.txt`;
}

function badgeId(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, '游戏端口无效');
  return `badge:${port}:configs.yml`;
}

async function pluginText(roots, id, label) {
  try { return await readFile(roots, id); }
  catch (error) {
    if (error.code === 'ENOENT') throw new HttpError(404, `${label} 存档未生成；请确认插件已安装并至少启动过一次游戏`);
    throw error;
  }
}

function levelLineInfo(content, steam64) {
  const lines = content.split(/\r?\n/);
  const id = `${steam64}@steam`;
  let index = -1;
  let experience = 0;
  let totalPoints = 0;
  let level = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!new RegExp(`^\\s*${id}\\s*\\|`, 'i').test(line)) continue;
    const match = /^\s*(7656119\d{10}@steam)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*$/.exec(line);
    if (!match || match[1].toLowerCase() !== id.toLowerCase()) throw new HttpError(422, `PlayerLevels 第 ${i + 1} 行格式无效`);
    if (index >= 0) throw new HttpError(422, 'PlayerLevels 中有重复 Steam64 ID');
    index = i;
    level = Number(match[2]);
    experience = Number(match[3]);
    totalPoints = Number(match[4]);
    if (![level, experience, totalPoints].every(Number.isSafeInteger)) throw new HttpError(422, 'PlayerLevels 数值无效');
  }
  return { lines, index, level, experience, totalPoints };
}

async function getPlayerLevel(roots, port, steam64) {
  if (!/^7656119\d{10}$/.test(steam64 || '')) throw new HttpError(400, 'Steam64 ID 无效');
  const file = await pluginText(roots, playerLevelsId(port), 'PlayerLevels');
  const info = levelLineInfo(file.content, steam64);
  return { level: info.level, experience: info.experience, totalPoints: info.totalPoints, revision: file.revision };
}

function validatePlayerLevel(steam64, level) {
  if (!/^7656119\d{10}$/.test(steam64 || '')) throw new HttpError(400, 'Steam64 ID 无效');
  if (!Number.isInteger(level) || level < 1 || level > 99999) throw new HttpError(400, '游戏等级必须为 1 到 99999');
}

async function setPlayerLevel(roots, dataDir, port, steam64, level, revision) {
  validatePlayerLevel(steam64, level);
  const id = playerLevelsId(port);
  const file = await pluginText(roots, id, 'PlayerLevels');
  if (file.revision !== revision) throw new HttpError(409, 'PlayerLevels 存档已变化，请重新选择玩家');
  const info = levelLineInfo(file.content, steam64);
  if (info.level === level) return { level, revision };
  const newline = file.content.includes('\r\n') ? '\r\n' : '\n';
  const replacement = `${steam64}@steam | ${level} | 0 | ${info.totalPoints}`;
  if (info.index >= 0) info.lines[info.index] = replacement;
  else {
    if (info.lines.at(-1) === '') info.lines.splice(info.lines.length - 1, 0, replacement);
    else info.lines.push(replacement);
  }
  return { ...await saveFile(roots, dataDir, id, info.lines.join(newline), revision), level };
}

function yamlScalar(raw) {
  raw = String(raw || '').trim();
  if (/^'.*'$/.test(raw)) return raw.slice(1, -1).replace(/''/g, "'");
  if (/^".*"$/.test(raw)) { try { return JSON.parse(raw); } catch { throw new HttpError(422, 'PlayerBadge 配置中的引号格式无法解析'); } }
  return raw.replace(/\s+#.*$/, '').trim();
}

function badgeListInfo(content, steam64) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex(line => /^player_badge_list:\s*(?:\[\s*\]|#.*)?$/i.test(line));
  if (start < 0) throw new HttpError(422, 'PlayerBadge 配置缺少 player_badge_list');
  let end = start + 1;
  while (end < lines.length && !/^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(lines[end])) end++;
  const starts = [];
  for (let i = start + 1; i < end; i++) {
    if (/^\s*-\s*(?:[A-Za-z_]+\s*:)?/.test(lines[i]) && lines[i].trim().startsWith('-')) starts.push(i);
  }
  let found = null;
  for (let j = 0; j < starts.length; j++) {
    const from = starts[j];
    const to = starts[j + 1] ?? end;
    const fields = {};
    for (let i = from; i < to; i++) {
      const match = /^\s*(?:-\s*)?(player_id|badge_name|badge_color)\s*:\s*(.*?)\s*$/i.exec(lines[i]);
      if (match) fields[match[1].toLowerCase()] = { index: i, value: yamlScalar(match[2]) };
    }
    if (fields.player_id?.value?.toLowerCase() === `${steam64}@steam`.toLowerCase()) {
      if (found) throw new HttpError(422, 'PlayerBadge 中有重复 Steam64 ID');
      found = { from, to, fields };
    }
  }
  return { lines, start, end, starts, found };
}

async function getPlayerBadge(roots, port, steam64) {
  if (!/^7656119\d{10}$/.test(steam64 || '')) throw new HttpError(400, 'Steam64 ID 无效');
  const file = await pluginText(roots, badgeId(port), 'PlayerBadge');
  const info = badgeListInfo(file.content, steam64);
  return { name: info.found?.fields.badge_name?.value || '', color: info.found?.fields.badge_color?.value || 'white',
    colors: BADGE_COLORS, revision: file.revision };
}

function validatePlayerBadge(steam64, name, color) {
  if (!/^7656119\d{10}$/.test(steam64 || '')) throw new HttpError(400, 'Steam64 ID 无效');
  if (typeof name !== 'string' || name.length > 48 || /[\x00-\x1f\x7f]/.test(name)) throw new HttpError(400, '标签最多 48 字且不能含控制字符');
  if (!BADGE_COLORS.includes(color)) throw new HttpError(400, '此插件不支持该标签颜色');
  return name.trim();
}

async function setPlayerBadge(roots, dataDir, port, steam64, name, color, revision) {
  name = validatePlayerBadge(steam64, name, color);
  const id = badgeId(port);
  const file = await pluginText(roots, id, 'PlayerBadge');
  if (file.revision !== revision) throw new HttpError(409, 'PlayerBadge 配置已变化，请重新选择玩家');
  const info = badgeListInfo(file.content, steam64);
  if (!name && !info.found) return { name, color, revision };
  if (info.found?.fields.badge_name?.value === name && info.found?.fields.badge_color?.value === color) return { name, color, revision };
  const lines = info.lines;
  if (!name) {
    lines.splice(info.found.from, info.found.to - info.found.from);
    if (info.starts.length === 1) lines[info.start] = 'player_badge_list: []';
  }
  else if (info.found) {
    for (const [key, value] of [['badge_name', `'${name.replace(/'/g, "''")}'`], ['badge_color', color]]) {
      const field = info.found.fields[key];
      if (!field) throw new HttpError(422, `PlayerBadge 当前玩家缺少 ${key} 字段`);
      lines[field.index] = lines[field.index].replace(/^(\s*(?:-\s*)?\w+\s*:\s*).*/, (_, prefix) => prefix + value);
    }
  } else {
    const indent = info.starts.length ? /^\s*/.exec(lines[info.starts[0]])[0] : '';
    const item = [`${indent}- player_id: ${steam64}@steam`, `${indent}  badge_name: '${name.replace(/'/g, "''")}'`, `${indent}  badge_color: ${color}`];
    if (/^player_badge_list:\s*\[\s*\]/i.test(lines[info.start])) lines[info.start] = 'player_badge_list:';
    lines.splice(info.end, 0, ...item);
  }
  const newline = file.content.includes('\r\n') ? '\r\n' : '\n';
  return { ...await saveFile(roots, dataDir, id, lines.join(newline), revision), name, color };
}

async function listBackups(dataDir, id) {
  parseId(id);
  try {
    return (await fs.readdir(backupFolder(dataDir, id)))
      .filter(name => /^\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9]{8}\.bak$/.test(name))
      .sort().reverse().slice(0, 50);
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function restoreBackup(roots, dataDir, id, name, revision) {
  if (!/^\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9]{8}\.bak$/.test(name || '')) throw new HttpError(400, '无效备份');
  if (!/^[a-f0-9]{64}$/.test(revision || '')) throw new HttpError(400, '版本信息无效');
  const full = await checkedPath(roots, id);
  const current = await fs.readFile(full);
  if (digest(current) !== revision) throw new HttpError(409, '文件已被其他人修改，请重新加载');
  const bytes = await fs.readFile(path.join(backupFolder(dataDir, id), name));
  if (bytes.length > MAX_FILE_BYTES) throw new HttpError(400, '备份文件过大');
  await backupBytes(dataDir, id, current);
  await atomicReplace(full, bytes);
  return { revision: digest(bytes) };
}

const PERMISSIONS = Object.freeze({
  'server.view': '查看服务器状态',
  'server.control': '启动、重启、关闭游戏',
  'server.console': '输入 LocalAdmin 控制台命令并查看输出',
  'players.online': '查看在线玩家',
  'players.records': '查看玩家历史、IP 和控制台',
  'players.manage': '编辑玩家等级、时长和标签',
  'config.read': '查看配置文件',
  'config.write': '修改和恢复配置文件',
  'plugins.read': '查看插件',
  'plugins.manage': '上传、启停、删除插件和编辑说明',
});

function hashPassword(password) {
  const salt = crypto.randomBytes(32).toString('hex');
  return { salt, passwordHash: crypto.pbkdf2Sync(password, Buffer.from(salt, 'hex'), 310000, 32, 'sha256').toString('hex') };
}

function validPassword(password) {
  if (typeof password !== 'string' || password.length < 6 || password.length > 256) throw new HttpError(400, '密码需要 6 到 256 个字符');
}

function verify(password, user) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const expected = Buffer.from(user.passwordHash, 'hex');
  const actual = crypto.pbkdf2Sync(password, Buffer.from(user.salt, 'hex'), 310000, 32, 'sha256');
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

function publicUser(user) {
  return { id: user.id, username: user.username, owner: user.owner, enabled: user.enabled,
    permissions: user.owner ? Object.keys(PERMISSIONS) : user.permissions.slice() };
}

class AccountStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'accounts.json');
    this.users = [];
  }

  async init(settingsFile) {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!Array.isArray(data.users) || data.users.filter(user => user.owner).length !== 1) throw new Error('账号文件无效');
      this.users = data.users;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const legacy = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
      if (!/^[a-f0-9]{64}$/i.test(legacy.salt) || !/^[a-f0-9]{64}$/i.test(legacy.passwordHash)) throw new Error('主账号密码数据无效，请运行 setup.ps1');
      this.users = [{ id: 'owner', username: 'owner', owner: true, enabled: true, permissions: [],
        salt: legacy.salt, passwordHash: legacy.passwordHash, authVersion: 1 }];
      await this.save();
    }
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ version: 1, users: this.users }, null, 2), { flag: 'wx', mode: 0o600 });
    try { await fs.rename(temp, this.file); }
    catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
      await fs.copyFile(temp, this.file);
      await fs.rm(temp, { force: true });
    }
  }

  byId(id) { return this.users.find(user => user.id === id && user.enabled); }
  login(username, password) {
    const user = this.users.find(row => row.username.toLowerCase() === String(username || '').toLowerCase() && row.enabled);
    if (!user || !verify(password, user)) return null;
    return user;
  }
  can(user, permission) {
    if (user?.owner) return true;
    const implied = { 'config.read': 'config.write', 'plugins.read': 'plugins.manage' };
    if (permission === 'players.online' && (user?.permissions?.includes('players.records') || user?.permissions?.includes('players.manage'))) return true;
    if (permission === 'players.records' && user?.permissions?.includes('players.manage')) return true;
    if (permission === 'server.view' && ['server.control', 'server.console', 'players.online', 'players.records', 'players.manage'].some(key => user?.permissions?.includes(key))) return true;
    return Boolean(user?.permissions?.includes(permission) || user?.permissions?.includes(implied[permission]));
  }
  list() { return this.users.map(publicUser); }

  async create(username, password, permissions) {
    username = String(username || '').trim();
    if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) throw new HttpError(400, '账号名需为 3 到 32 位英文字母、数字或下划线');
    if (this.users.some(user => user.username.toLowerCase() === username.toLowerCase())) throw new HttpError(409, '账号名已存在');
    if (this.users.length >= 21) throw new HttpError(409, '最多创建 20 个服管理员账号');
    validPassword(password);
    const user = { id: crypto.randomUUID(), username, owner: false, enabled: true,
      permissions: this.validatePermissions(permissions), ...hashPassword(password), authVersion: 1 };
    this.users.push(user);
    await this.save();
    return publicUser(user);
  }

  validatePermissions(permissions) {
    if (!Array.isArray(permissions) || permissions.some(value => typeof value !== 'string' || !Object.hasOwn(PERMISSIONS, value))) throw new HttpError(400, '权限列表无效');
    if (!permissions.length) throw new HttpError(400, '至少选择一项权限；如需收回全部权限，可停用账号');
    return [...new Set(permissions)];
  }

  async update(id, changes) {
    const user = this.users.find(row => row.id === id);
    if (!user) throw new HttpError(404, '账号不存在');
    if (user.owner) throw new HttpError(403, '主账号权限不可更改');
    const permissions = Object.hasOwn(changes, 'permissions') ? this.validatePermissions(changes.permissions) : null;
    if (Object.hasOwn(changes, 'enabled') && typeof changes.enabled !== 'boolean') throw new HttpError(400, '账号状态无效');
    if (changes.password !== undefined && changes.password !== '') validPassword(changes.password);
    if (permissions) user.permissions = permissions;
    if (Object.hasOwn(changes, 'enabled')) {
      user.enabled = changes.enabled;
    }
    if (changes.password !== undefined && changes.password !== '') {
      Object.assign(user, hashPassword(changes.password));
      user.authVersion++;
    }
    if (!user.enabled) user.authVersion++;
    await this.save();
    return publicUser(user);
  }

  async remove(id) {
    const index = this.users.findIndex(row => row.id === id);
    if (index < 0) throw new HttpError(404, '账号不存在');
    if (this.users[index].owner) throw new HttpError(403, '不能删除主账号');
    this.users.splice(index, 1);
    await this.save();
  }

  async changeOwnPassword(id, oldPassword, newPassword) {
    const user = this.byId(id);
    if (!user || !verify(oldPassword, user)) throw new HttpError(403, '当前密码错误');
    validPassword(newPassword);
    Object.assign(user, hashPassword(newPassword));
    user.authVersion++;
    await this.save();
    return user;
  }
}

class AuditStore {
  constructor(dataDir) {
    this.folder = path.join(dataDir, 'audit');
    this.queue = Promise.resolve();
    this.lastError = null;
  }

  record(event) {
    const entry = {
      time: new Date().toISOString(),
      username: String(event.username || '未登录').slice(0, 64),
      actorId: String(event.actorId || '').slice(0, 64),
      ip: String(event.ip || 'unknown').slice(0, 64),
      action: String(event.action || '').slice(0, 80),
      target: String(event.target || '').slice(0, 240),
      status: Number(event.status) || 500,
      result: Number(event.status) < 400 ? '成功' : '失败',
    };
    const file = path.join(this.folder, `${entry.time.slice(0, 10)}.jsonl`);
    const task = this.queue.catch(() => {}).then(async () => {
      await fs.mkdir(this.folder, { recursive: true });
      await fs.appendFile(file, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
      this.lastError = null;
    });
    this.queue = task;
    task.catch(error => { this.lastError = error.message; });
    return task;
  }

  async list({ limit = 100, offset = 0, search = '' } = {}) {
    await this.queue.catch(() => {});
    limit = Math.min(200, Math.max(1, Number(limit) || 100));
    offset = Math.min(100000, Math.max(0, Number(offset) || 0));
    search = String(search).trim().toLowerCase().slice(0, 80);
    let names;
    try { names = (await fs.readdir(this.folder)).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().reverse(); }
    catch (error) { if (error.code === 'ENOENT') return { entries: [], nextOffset: 0, hasMore: false, error: this.lastError }; throw error; }
    const entries = [];
    let skipped = 0;
    for (const name of names) {
      const lines = (await fs.readFile(path.join(this.folder, name), 'utf8')).trim().split('\n');
      for (let index = lines.length - 1; index >= 0; index--) {
        let entry;
        try { entry = JSON.parse(lines[index]); } catch { continue; }
        if (search && !`${entry.username} ${entry.ip} ${entry.action} ${entry.target} ${entry.result}`.toLowerCase().includes(search)) continue;
        if (skipped < offset) { skipped++; continue; }
        entries.push(entry);
        if (entries.length > limit) return { entries: entries.slice(0, limit), nextOffset: offset + limit, hasMore: true, error: this.lastError };
      }
    }
    return { entries, nextOffset: offset + entries.length, hasMore: false, error: this.lastError };
  }
}

function describeGameAdminAction(detail) {
  if (detail === '[敏感内容已隐藏]') return { action: '敏感操作', target: '', item: '' };
  const actor = /^.+?\s*\([^()]+@(?:steam|northwood|discord)\)\s*/i.exec(detail);
  const operation = actor ? detail.slice(actor[0].length).trim() : detail;
  const actions = [
    [/\b(?:unbanned|unban)\b/i, '解除封禁'],
    [/\b(?:banned|ban)\b/i, '封禁玩家'],
    [/\b(?:kicked|kick)\b/i, '踢出玩家'],
    [/\b(?:unmuted|unmute)\b/i, '解除禁言'],
    [/\b(?:muted|mute)\b/i, '禁言玩家'],
    [/\b(?:gave|given|give)\b/i, '发放物品'],
    [/\b(?:spawned|spawning|spawn)\b/i, '生成物品或实体'],
    [/\b(?:teleported|teleport)\b/i, '传送玩家'],
    [/\b(?:forceclass|forced\s+class|changed\s+(?:the\s+)?class)\b/i, '更改职业'],
    [/\b(?:setgroup|changed\s+(?:the\s+)?group)\b/i, '更改管理组'],
    [/\b(?:healed|heal)\b/i, '治疗玩家'],
    [/\b(?:broadcasted|broadcast)\b/i, '发送广播'],
    [/\b(?:roundrestart|restarted\s+(?:the\s+)?round)\b/i, '重启回合'],
    [/\b(?:executed|ran)\s+(?:a\s+)?command\b/i, '执行管理命令']
  ];
  const action = actions.find(([pattern]) => pattern.test(operation))?.[1] || '其他管理操作';
  const targetId = /\b(7656119\d{10}@steam|[^\s()]+@(?:northwood|discord))\b/i.exec(operation)?.[1] || '';
  const targetName = targetId
    ? new RegExp(`\\b(?:player|to|for|on|target)\\s+([^()]{1,60}?)\\s*\\(${targetId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`, 'i').exec(operation)?.[1].trim() || ''
    : '';
  const target = targetId ? `${targetName ? `${targetName} ` : ''}(${targetId})` : '';
  const item = action === '发放物品'
    ? /\b(?:gave|given|give)\s+(?:an?\s+)?(?:item\s+)?(.+?)\s+(?:to|for)\b/i.exec(operation)?.[1].trim() || ''
    : '';
  return { action, target, item: /^(?:item|an?\s+item)$/i.test(item) ? '' : item };
}

function parseGameAdminLine(line, fileName = '') {
  const match = /^\s*(.+?)\s*\|\s*(Remote Admin(?:\s*-\s*[^|]+)?)\s*\|\s*([^|]*)\|\s*(.+?)\s*$/i.exec(line);
  if (!match) return null;
  const rawTime = match[1].trim();
  const parsedTime = Date.parse(rawTime);
  if (!Number.isFinite(parsedTime)) return null;
  const original = match[4].trim();
  const actorMatch = /^(.+?)\s*\((7656119\d{10}@steam|[^()]+@(?:northwood|discord))\)/i.exec(original);
  const sensitive = /(?:password|passwd|token|secret|auth(?:entication)?\s*(?:key|token))\b/i.test(original);
  const detail = sensitive ? '[敏感内容已隐藏]' : original.slice(0, 1000);
  const type = match[2].trim();
  const id = crypto.createHash('sha256').update(`${fileName}\0${rawTime}\0${original}`).digest('hex');
  return { id, time: new Date(parsedTime).toISOString(), type, actor: actorMatch?.[1].trim() || '未识别管理员',
    actorId: actorMatch?.[2] || '', detail, source: fileName, ...describeGameAdminAction(detail) };
}

class GameAdminLogStore {
  constructor(dataDir, roots, port) {
    this.port = port;
    this.file = path.join(dataDir, 'game-admin-actions', `${port}.json`);
    this.folder = path.resolve(process.env.SCP_PANEL_SERVER_LOGS_ROOT || path.join(path.dirname(roots.game), 'ServerLogs'), String(port));
    this.entries = [];
    this.known = new Set();
    this.scanned = new Map();
    this.queue = Promise.resolve();
  }

  async init() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!Array.isArray(saved.entries)) throw new Error('游戏内管理记录格式无效');
      this.entries = saved.entries.filter(row => row && typeof row.id === 'string' && typeof row.time === 'string')
        .slice(-5000).map(row => ({ ...row, ...describeGameAdminAction(row.detail || '') }));
      this.known = new Set(this.entries.map(row => row.id));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ version: 1, entries: this.entries }), { flag: 'wx', mode: 0o600 });
    try { await fs.rename(temp, this.file); }
    catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
      await fs.copyFile(temp, this.file);
      await fs.rm(temp, { force: true });
    }
  }

  scan() {
    const task = this.queue.catch(() => {}).then(async () => {
      let files;
      try { files = (await fs.readdir(this.folder, { withFileTypes: true }))
        .filter(row => row.isFile() && /\.(?:txt|log)$/i.test(row.name))
        .sort((a, b) => b.name.localeCompare(a.name)).slice(0, 40); }
      catch (error) {
        if (error.code === 'ENOENT') return `未找到游戏回合日志：${this.folder}`;
        throw error;
      }
      if (!files.length) return `游戏回合日志目录中暂无日志：${this.folder}`;
      let changed = false;
      let readError = null;
      for (const file of files) {
        const full = path.join(this.folder, file.name);
        const stat = await fs.stat(full).catch(error => { readError = `无法检查 ${file.name}：${error.message}`; return null; });
        if (!stat?.isFile() || this.scanned.get(file.name) === `${stat.size}:${stat.mtimeMs}`) continue;
        const length = Math.min(stat.size, 2 * 1024 * 1024);
        const offset = stat.size - length;
        const handle = await fs.open(full, 'r').catch(error => { readError = `无法读取 ${file.name}：${error.message}`; return null; });
        if (!handle) continue;
        let bytes;
        try {
          const buffer = Buffer.alloc(length);
          const result = await handle.read(buffer, 0, length, offset);
          bytes = buffer.subarray(0, result.bytesRead);
        } finally { await handle.close(); }
        let content;
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { content = new TextDecoder('gb18030').decode(bytes); }
        if (offset) content = content.slice(content.indexOf('\n') + 1);
        for (const line of content.split(/\r?\n/)) {
          const entry = parseGameAdminLine(line, `${this.port}/${file.name}`);
          if (!entry || this.known.has(entry.id)) continue;
          this.entries.push(entry);
          this.known.add(entry.id);
          changed = true;
        }
        this.scanned.set(file.name, `${stat.size}:${stat.mtimeMs}`);
      }
      if (changed) {
        this.entries.sort((a, b) => a.time.localeCompare(b.time));
        this.entries = this.entries.slice(-5000);
        this.known = new Set(this.entries.map(row => row.id));
        await this.save();
      }
      return readError;
    });
    this.queue = task;
    return task;
  }

  async list(search = '', limit = 100) {
    const error = await this.scan();
    const query = String(search).trim().toLowerCase().slice(0, 80);
    const count = Math.min(200, Math.max(1, Number(limit) || 100));
    const entries = this.entries.filter(row => !query || `${row.actor} ${row.actorId} ${row.detail} ${row.type} ${row.action} ${row.target} ${row.item}`.toLowerCase().includes(query))
      .slice(-count).reverse();
    return { entries, error, source: this.folder };
  }
}

module.exports = { HttpError, rootsFromEnvironment, parseId, listFiles, readFile, downloadFile, saveFile, listBackups, restoreBackup,
  getRemoteAdmin, setRemoteAdmin, getPlayerLevel, setPlayerLevel, getPlayerBadge, setPlayerBadge,
  validatePlayerLevel, validatePlayerBadge,
  AccountStore, PERMISSIONS, publicUser, AuditStore, GameAdminLogStore, parseGameAdminLine };
