'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { AccountStore } = require('../storage');

const execFileAsync = promisify(execFile);

test('six-character passwords work for setup and account changes; five are rejected', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scp-panel-password-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await execFileAsync(process.execPath, [path.join(__dirname, '..', 'setup.js')], {
    env: { ...process.env, SCP_PANEL_DATA_DIR: dir, SCP_PANEL_SETUP_PASSWORD: '123456' },
    timeout: 10000,
  });
  const accounts = new AccountStore(dir);
  await accounts.init(path.join(dir, 'settings.json'));
  assert.equal(accounts.login('owner', '123456').owner, true);

  await assert.rejects(accounts.create('mod1', '12345', ['server.view']), error => error.status === 400);
  const admin = await accounts.create('mod1', 'abcdef', ['server.view']);
  assert.equal(accounts.login('mod1', 'abcdef').id, admin.id);
  await assert.rejects(accounts.update(admin.id, { password: 'abcde' }), error => error.status === 400);
  await accounts.update(admin.id, { password: '654321' });
  assert.equal(accounts.login('mod1', '654321').id, admin.id);

  await assert.rejects(accounts.changeOwnPassword('owner', '123456', '12345'), error => error.status === 400);
  await accounts.changeOwnPassword('owner', '123456', 'abc123');
  assert.equal(accounts.login('owner', 'abc123').owner, true);
});
