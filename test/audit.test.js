'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const { AccountStore } = require('../storage');
const { GameManager } = require('../game');

function request(server, { method = 'GET', url, headers = {}, body = '' }) {
  return new Promise(resolve => {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    req.method = method;
    req.url = url;
    req.headers = { host: `127.0.0.1:${server.address().port}`, ...headers };
    req.socket = { remoteAddress: '127.0.0.1' };
    const res = {
      headers: {},
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      writeHead(status, values) {
        this.status = status;
        for (const [name, value] of Object.entries(values)) this.headers[name.toLowerCase()] = value;
      },
      end(value) { this.body = value; resolve(this); },
    };
    server.emit('request', req, res);
  });
}

test('owner sees panel actions with command details; admin cannot read them', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scp-panel-audit-'));
  const oldData = process.env.SCP_PANEL_DATA_DIR;
  const oldPort = process.env.SCP_PANEL_PORT;
  const oldBind = process.env.SCP_PANEL_BIND;
  const oldGameRoot = process.env.SCP_PANEL_GAME_ROOT;
  const originalSendCommand = GameManager.prototype.sendCommand;
  let server;
  try {
    const salt = crypto.randomBytes(32);
    const settings = path.join(dir, 'settings.json');
    await fs.writeFile(settings, JSON.stringify({ salt: salt.toString('hex'),
      passwordHash: crypto.pbkdf2Sync('Owner123', salt, 310000, 32, 'sha256').toString('hex') }));
    const accounts = new AccountStore(dir);
    await accounts.init(settings);
    await accounts.create('Moderator_1', 'Admin123', ['server.console']);
    const gameRoot = path.join(dir, 'config');
    const roundLogs = path.join(dir, 'ServerLogs', '7777');
    await fs.mkdir(roundLogs, { recursive: true });
    await fs.writeFile(path.join(roundLogs, 'Round 2026-11-09.txt'),
      '2026-11-09 13:01:02.345 +08:00 | Remote Admin | Administrative | InGameAdmin (76561198000000001@steam) banned player Max (76561198000000002@steam).\n');

    const free = net.createServer();
    free.listen(0, '127.0.0.1');
    await once(free, 'listening');
    const port = free.address().port;
    await new Promise(resolve => free.close(resolve));
    process.env.SCP_PANEL_DATA_DIR = dir;
    process.env.SCP_PANEL_PORT = String(port);
    process.env.SCP_PANEL_BIND = '127.0.0.1';
    process.env.SCP_PANEL_GAME_ROOT = gameRoot;
    const { start, auditCommand } = require('../server');
    const command = 'give 76561199169036816 36';
    assert.equal(auditCommand(command), command);
    assert.equal(auditCommand('qqmsg hello world'), 'qqmsg（参数已隐藏）');
    assert.equal(auditCommand('plugin password=secret'), 'plugin（参数已隐藏）');
    assert.equal(auditCommand('plugin set password secret'), 'plugin（参数已隐藏）');
    GameManager.prototype.sendCommand = function (line) { this.testLastCommand = line; };
    server = await start();
    if (!server.listening) await once(server, 'listening');
    async function login(username, password) {
      const response = await request(server, { method: 'POST', url: '/api/login', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }) });
      assert.equal(response.status, 200);
      return response.headers['set-cookie'].split(';', 1)[0];
    }
    const ownerCookie = await login('owner', 'Owner123');
    const adminCookie = await login('Moderator_1', 'Admin123');
    const gameActions = await request(server, { url: '/api/game/admin-logs', headers: { cookie: ownerCookie } });
    assert.equal(gameActions.status, 200);
    assert.equal(JSON.parse(gameActions.body).entries[0].actor, 'InGameAdmin');
    assert.equal((await request(server, { url: '/api/game/admin-logs', headers: { cookie: adminCookie } })).status, 403);
    const sent = await request(server, { method: 'POST', url: '/api/game/command',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ command }) });
    assert.equal(sent.status, 200);
    const visible = await request(server, { url: '/api/audit?q=give', headers: { cookie: ownerCookie } });
    assert.equal(visible.status, 200);
    const result = JSON.parse(visible.body);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].username, 'Moderator_1');
    assert.equal(result.entries[0].target, command);
    assert.equal(result.entries[0].ip, '127.0.0.1');

    const message = await request(server, { method: 'POST', url: '/api/game/command',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'qqmsg private message' }) });
    assert.equal(message.status, 200);
    const masked = JSON.parse((await request(server, { url: '/api/audit?q=qqmsg',
      headers: { cookie: ownerCookie } })).body);
    assert.equal(masked.entries[0].target, 'qqmsg（参数已隐藏）');
    assert.equal(JSON.stringify(masked).includes('private message'), false);
    const hidden = await request(server, { url: '/api/audit', headers: { cookie: adminCookie } });
    assert.equal(hidden.status, 403);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    GameManager.prototype.sendCommand = originalSendCommand;
    if (oldData === undefined) delete process.env.SCP_PANEL_DATA_DIR; else process.env.SCP_PANEL_DATA_DIR = oldData;
    if (oldPort === undefined) delete process.env.SCP_PANEL_PORT; else process.env.SCP_PANEL_PORT = oldPort;
    if (oldBind === undefined) delete process.env.SCP_PANEL_BIND; else process.env.SCP_PANEL_BIND = oldBind;
    if (oldGameRoot === undefined) delete process.env.SCP_PANEL_GAME_ROOT; else process.env.SCP_PANEL_GAME_ROOT = oldGameRoot;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
