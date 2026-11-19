'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PlayerStore, parseSnapshot } = require('../players');

const STEAM_ID = '76561198000000000';

test('the server players command reports an empty list', () => {
  assert.deepEqual(parseSnapshot(['<color=cyan>List of players (0):</color>']),
    { players: [], complete: true, idsWithoutName: 0 });
  assert.equal(parseSnapshot(['unrelated console message']).complete, false);
});

test('a player accumulates only their connected sessions', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scp-panel-players-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const store = new PlayerStore(dir);
  await store.init();
  const joined = Date.now();
  await store.observeLogLine(`[2026-10-20 19:00:00] ${STEAM_ID}@steam authenticated from endpoint localhost:7777.`);
  await store.observeLogLine(`Nickname of ${STEAM_ID}@steam is now Alice.`);
  assert.equal(store.online.length, 1);
  assert.ok(store.online[0].joinedAt >= joined);

  store.online[0].joinedAt = Date.now() - 23_400;
  store.observeLogLine('Server has entered the idle mode.');
  await store.writeQueue;
  assert.equal(store.online.length, 0);
  const first = store.records.get(STEAM_ID).playSeconds;
  assert.ok(first >= 23 && first <= 24);
  assert.equal(store.view().known[0].playSeconds, first);

  await store.observeLogLine(`${STEAM_ID}@steam authenticated from endpoint localhost:7777.`);
  store.online[0].joinedAt = Date.now() - 31_400;
  await store.observe(['<color=cyan>List of players (0):</color>']);
  assert.equal(store.online.length, 0);
  const total = store.records.get(STEAM_ID).playSeconds;
  assert.ok(total >= first + 31 && total <= first + 32);
  assert.equal(store.view().known[0].playSeconds, total);
});

test('an incomplete players response does not end a session', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scp-panel-players-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const store = new PlayerStore(dir);
  await store.init();
  await store.observeLogLine(`${STEAM_ID}@steam authenticated from endpoint localhost:7777.`);
  await store.observe(['unrelated console message']);
  assert.equal(store.online.length, 1);
});

test('a player leaving while teammates remain stops only their timer', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scp-panel-players-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const other = '76561198000000001';
  const store = new PlayerStore(dir);
  await store.init();
  await store.observeLogLine(`${STEAM_ID}@steam authenticated from endpoint localhost:7777.`);
  await store.observeLogLine(`${other}@steam authenticated from endpoint localhost:7777.`);
  store.online.find(row => row.steam64 === STEAM_ID).joinedAt = Date.now() - 40_400;
  store.online.find(row => row.steam64 === other).joinedAt = Date.now() - 30_400;
  await store.observe(['<color=cyan>List of players (1):</color>', `- Bob: ${other}@steam [3]`]);
  assert.deepEqual(store.online.map(row => row.steam64), [other]);
  assert.ok(store.records.get(STEAM_ID).playSeconds >= 40);
  assert.equal(store.records.get(other).playSeconds || 0, 0);
  await store.observe(['<color=cyan>List of players (0):</color>']);
  assert.equal(store.online.length, 0);
  assert.ok(store.records.get(other).playSeconds >= 30);
});

test('connection and departure logs update the online list without a players command', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scp-panel-players-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const store = new PlayerStore(dir);
  await store.init();
  await store.observeLogLine(`[2026-10-21 14:29:05.425 +08:00] Nickname of`);
  await store.observeLogLine(`${STEAM_ID}@steam is now Dr. Hannibal Lecter.`);
  await store.observeLogLine('[2026-10-21 14:29:05.435 +08:00] Player Dr. Hannibal Lecter');
  await store.observeLogLine(`(${STEAM_ID}@steam) (6) connected with the IP:`);
  await store.observeLogLine('115.238.116.137');
  await store.writeQueue;
  assert.equal(store.view().online.length, 1);
  assert.equal(store.view().online[0].name, 'Dr. Hannibal Lecter');
  assert.equal(store.view().online[0].ip, '115.238.116.137');
  assert.equal(store.view().lastEvent, '玩家加入');
  assert.equal(store.view().lastChecked, null);
  store.online[0].joinedAt = Date.now() - 12_400;
  await store.observeLogLine(`${STEAM_ID}@steam disconnected.`);
  await store.writeQueue;
  assert.equal(store.view().online.length, 0);
  assert.equal(store.view().lastEvent, '玩家离开');
  assert.ok(store.records.get(STEAM_ID).playSeconds >= 12);
});
