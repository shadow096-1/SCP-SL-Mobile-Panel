'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { GameManager } = require('../game');

test('idle restart is once per empty period and rearms after a player joins', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scp-panel-idle-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const game = new GameManager(dir);
  const commands = [];
  game.child = { pid: 1234 };
  game.ready = true;
  game.config.idleRestartMinutes = 0.001;
  game.sendCommand = command => commands.push(command);
  t.after(() => game.clearIdleRestartTimer());

  game.updateIdleRestart();
  assert.ok(game.idleRestartTimer);
  game.playerStore.online.push({ steam64: '76561199169036816', joinedAt: Date.now() });
  game.updateIdleRestart();
  assert.equal(game.idleRestartTimer, null);
  assert.equal(game.idleSince, null);
  game.playerStore.online = [];
  game.updateIdleRestart();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(commands, ['exit']);
  assert.equal(game.idleRestartTriggered, true);

  game.ready = true;
  game.updateIdleRestart();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(commands, ['exit']);

  game.playerStore.online.push({ steam64: '76561199169036816', joinedAt: Date.now() });
  game.updateIdleRestart();
  assert.equal(game.idleRestartTriggered, false);
  game.playerStore.online = [];
  game.updateIdleRestart();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(commands, ['exit', 'exit']);
});

test('idle restart setting persists and rejects invalid durations', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scp-panel-idle-config-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const game = new GameManager(dir);
  assert.equal(game.config.idleRestartMinutes, 1440);
  await game.configureIdleRestart(0);
  const restored = new GameManager(dir);
  await restored.init();
  assert.equal(restored.config.idleRestartMinutes, 0);
  await fs.writeFile(game.configFile, JSON.stringify({ executable: '', port: 7777, idleRestartMinutes: 30 }));
  const upgraded = new GameManager(dir);
  await upgraded.init();
  assert.equal(upgraded.config.idleRestartMinutes, 1440);
  await upgraded.configureIdleRestart(30);
  const selected = new GameManager(dir);
  await selected.init();
  assert.equal(selected.config.idleRestartMinutes, 30);
  assert.equal(selected.config.idleRestartCustomized, true);
  await assert.rejects(game.configureIdleRestart(-1), /0 到 1440/);
  await assert.rejects(game.configureIdleRestart(1441), /0 到 1440/);
  await assert.rejects(game.configureIdleRestart(0.5), /0 到 1440/);
});
