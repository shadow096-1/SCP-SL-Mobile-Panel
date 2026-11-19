'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { GameAdminLogStore, parseGameAdminLine } = require('../storage');

test('game Remote Admin round logs become searchable persistent panel records', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scp-panel-game-admin-'));
  t.after(async () => {
    assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const logFolder = path.join(dir, 'ServerLogs', '7777');
  await fs.mkdir(logFolder, { recursive: true });
  const file = path.join(logFolder, 'Round 2026-11-09.txt');
  const ban = '2026-11-09 13:01:02.345 +08:00 | Remote Admin | Administrative | AdminName (76561198000000001@steam) banned player Max (76561198000000002@steam). Ban duration: 1d.';
  const give = '2026-11-09 13:04:02.345 +08:00 | Remote Admin - Misc | Administrative | AdminName (76561198000000001@steam) gave item to Max (76561198000000002@steam).';
  await fs.writeFile(file, `${ban}\n2026-11-09 13:02:00Z | Game Event | Game logic | Round started.\n${give}\n`);
  assert.equal(parseGameAdminLine(ban)?.actor, 'AdminName');
  assert.equal(parseGameAdminLine(ban)?.action, '封禁玩家');
  assert.equal(parseGameAdminLine(ban)?.target, 'Max (76561198000000002@steam)');
  assert.equal(parseGameAdminLine(give)?.action, '发放物品');
  assert.equal(parseGameAdminLine(give)?.target, 'Max (76561198000000002@steam)');
  assert.equal(parseGameAdminLine('unrelated console output'), null);
  const roots = { game: path.join(dir, 'config') };
  const store = new GameAdminLogStore(dir, roots, 7777);
  await store.init();
  const first = await store.list('', 20);
  assert.equal(first.error, null);
  assert.equal(first.entries.length, 2);
  assert.equal(first.entries[0].type, 'Remote Admin - Misc');
  assert.equal((await store.list('Max')).entries.length, 2);
  assert.equal((await store.list('发放物品')).entries.length, 1);
  assert.equal((await store.list('not-here')).entries.length, 0);
  assert.equal((await store.list()).entries.length, 2);

  const restored = new GameAdminLogStore(dir, roots, 7777);
  await restored.init();
  assert.equal((await restored.list()).entries.length, 2);
  assert.equal((await restored.list('封禁玩家')).entries.length, 1);
  const another = '2026-11-09 13:05:02.345 +08:00 | Remote Admin | Administrative | OtherAdmin (76561198000000003@steam) kicked player Max.';
  await fs.appendFile(file, `${another}\n`);
  assert.equal((await restored.list()).entries.length, 3);
  assert.equal((await restored.list()).entries.length, 3);
  assert.equal((await restored.list('踢出玩家')).entries.length, 1);
});

test('old saved game records gain labels without changing the original log text', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scp-panel-game-admin-old-'));
  t.after(async () => {
    assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const folder = path.join(dir, 'game-admin-actions');
  await fs.mkdir(folder, { recursive: true });
  const detail = 'AdminName (76561198000000001@steam) gave Medkit to Max (76561198000000002@steam).';
  await fs.writeFile(path.join(folder, '7777.json'), JSON.stringify({ entries: [{ id: 'old', time: '2026-11-09T05:00:00.000Z', actor: 'AdminName', actorId: '76561198000000001@steam', detail }] }));
  const store = new GameAdminLogStore(dir, { game: path.join(dir, 'config') }, 7777);
  await store.init();
  const [record] = (await store.list('Medkit')).entries;
  assert.equal(record.action, '发放物品');
  assert.equal(record.item, 'Medkit');
  assert.equal(record.target, 'Max (76561198000000002@steam)');
  assert.equal(record.detail, detail);
});
