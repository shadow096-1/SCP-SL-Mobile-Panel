'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { HttpError } = require('./storage');

const execFileAsync = promisify(execFile);
const MAX_UPDATE_BYTES = 8 * 1024 * 1024;

async function installUpdate(dataDir, bytes) {
  if (process.platform !== 'win32') throw new HttpError(400, '面板更新仅支持 Windows');
  if (process.env.SCP_PANEL_LAUNCHER !== '1') throw new HttpError(409, '请通过 START-HERE.cmd 或 PUBLIC-IP.cmd 启动面板后再更新');
  if (!Buffer.isBuffer(bytes) || bytes.length < 100 || bytes.length > MAX_UPDATE_BYTES || bytes.subarray(0, 4).toString('hex') !== '504b0304') {
    throw new HttpError(400, '请选择有效的面板 ZIP 更新包');
  }
  await fs.mkdir(dataDir, { recursive: true });
  const archive = path.join(dataDir, `panel-update-${crypto.randomBytes(8).toString('hex')}.zip`);
  try {
    await fs.writeFile(archive, bytes, { flag: 'wx', mode: 0o600 });
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'update-panel.ps1'), '-Archive', archive, '-InstallDir', __dirname, '-DataDir', dataDir], {
      windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024,
    });
    const version = stdout.trim().split(/\r?\n/).at(-1)?.trim();
    if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new HttpError(500, '更新完成后未能确认版本，请检查面板文件');
    return { version, restarting: true };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, `更新失败：${String(error.stderr || error.message).trim().slice(-700)}`);
  } finally { await fs.rm(archive, { force: true }).catch(() => {}); }
}

module.exports = { MAX_UPDATE_BYTES, installUpdate };
