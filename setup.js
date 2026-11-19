'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

async function main() {
  const password = process.env.SCP_PANEL_SETUP_PASSWORD;
  delete process.env.SCP_PANEL_SETUP_PASSWORD;
  if (!password || password.length < 6) throw new Error('密码至少 6 个字符；请运行 setup.ps1 完成设置。');
  const dataDir = path.resolve(process.env.SCP_PANEL_DATA_DIR || path.join(__dirname, 'data'));
  const settingsFile = path.join(dataDir, 'settings.json');
  await fs.mkdir(dataDir, { recursive: true });
  const salt = crypto.randomBytes(32);
  const passwordHash = crypto.pbkdf2Sync(password, salt, 310000, 32, 'sha256');
  await fs.writeFile(settingsFile, JSON.stringify({
    salt: salt.toString('hex'),
    passwordHash: passwordHash.toString('hex'),
  }, null, 2), { mode: 0o600 });
  const { AccountStore } = require('./storage');
  const accounts = new AccountStore(dataDir);
  await accounts.init(settingsFile);
  const owner = accounts.users.find(user => user.owner);
  owner.salt = salt.toString('hex');
  owner.passwordHash = passwordHash.toString('hex');
  owner.authVersion++;
  await accounts.save();
  console.log(`管理员密码已设置。数据目录：${dataDir}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
