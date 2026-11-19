'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { HttpError } = require('./storage');
const execFileAsync = promisify(execFile);

const MAX_PLUGIN_BYTES = 32 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.dll$/i;
const KINDS = new Set(['exiled', 'labapi-port', 'labapi-global', 'labapi-dependency-port', 'labapi-dependency-global']);

function validateName(name) {
  if (typeof name !== 'string' || !NAME.test(name) || name.includes('..')) throw new HttpError(400, '仅接受文件名安全的 .dll 插件');
  return name;
}

function validateKind(kind) {
  if (!KINDS.has(kind)) throw new HttpError(400, '插件类型无效');
  return kind;
}

function pluginRoot(roots, kind, port) {
  validateKind(kind);
  const scope = kind.endsWith('-global') ? 'global' : String(port);
  if (!/^(global|[0-9]{1,5})$/.test(scope) || (scope !== 'global' && (Number(scope) < 1 || Number(scope) > 65535))) {
    throw new HttpError(400, '游戏端口无效');
  }
  if (kind === 'exiled') return path.resolve(process.env.SCP_PANEL_EXILED_PLUGINS_ROOT || path.join(path.dirname(roots.exiled), 'Plugins'));
  const base = path.resolve(process.env.SCP_PANEL_LABAPI_ROOT || path.join(path.dirname(roots.game), 'LabAPI'));
  return path.join(base, kind.startsWith('labapi-dependency') ? 'dependencies' : 'plugins', scope);
}

function target(roots, kind, port, name, enabled = true) {
  return path.join(pluginRoot(roots, kind, port), validateName(name) + (enabled ? '' : '.disabled'));
}

function descriptionPath(dataDir, kind, port, name) {
  validateKind(kind);
  validateName(name);
  const scope = kind === 'exiled' || kind.endsWith('-global') ? 'global' : String(port);
  if (!/^(global|[0-9]{1,5})$/.test(scope) || (scope !== 'global' && (Number(scope) < 1 || Number(scope) > 65535))) {
    throw new HttpError(400, '游戏端口无效');
  }
  return path.join(dataDir, 'plugin-descriptions', kind, scope, `${name}.txt`);
}

function validateDescription(description) {
  if (typeof description !== 'string' || description.length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(description)) {
    throw new HttpError(400, '插件作用说明不能超过 500 字，且不能包含控制字符');
  }
  return description.trim();
}

async function readDescription(dataDir, kind, port, name) {
  const full = descriptionPath(dataDir, kind, port, name);
  try {
    const info = await fs.lstat(full);
    if (!info.isFile() || info.size > 2048) return '';
    return (await fs.readFile(full, 'utf8')).trim().slice(0, 500);
  } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

async function fileDescriptions(files) {
  if (process.platform !== 'win32' || !files.length) return new Map();
  // FileVersionInfo reads PE resources; it does not load or execute the DLL.
  const script = '$files = @((ConvertFrom-Json $env:SCP_PANEL_PLUGIN_FILES)); $items = foreach ($file in $files) { try { $info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo([string]$file); [pscustomobject]@{ file = [string]$file; description = [string]$info.FileDescription } } catch {} }; @($items) | ConvertTo-Json -Compress';
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, SCP_PANEL_PLUGIN_FILES: JSON.stringify(files) }, windowsHide: true,
      timeout: 7000, maxBuffer: 256 * 1024,
    });
    const items = JSON.parse(stdout.trim() || '[]');
    return new Map((Array.isArray(items) ? items : [items]).filter(item => item?.file)
      .map(item => [item.file, String(item.description || '').trim().slice(0, 500)]));
  } catch { return new Map(); }
}

async function safeFile(full) {
  const item = await fs.lstat(full);
  if (!item.isFile() || item.isSymbolicLink()) throw new HttpError(400, '插件路径不是普通文件');
  return item;
}

async function exists(full) {
  try { await fs.lstat(full); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function list(roots, port, dataDir) {
  const result = [];
  const files = [];
  for (const kind of KINDS) {
    const root = pluginRoot(roots, kind, port);
    let entries;
    try { entries = await fs.readdir(root, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const enabled = !entry.name.endsWith('.dll.disabled');
      const name = enabled ? entry.name : entry.name.slice(0, -'.disabled'.length);
      if (!NAME.test(name) || name.includes('..')) continue;
      const full = path.join(root, entry.name);
      const info = await safeFile(full);
      const manual = dataDir ? await readDescription(dataDir, kind, port, name) : '';
      result.push({ kind, name, enabled, bytes: info.size, modified: info.mtime.toISOString(),
        description: manual, descriptionSource: manual ? 'admin' : null });
      if (!manual) files.push(full);
    }
  }
  const automatic = await fileDescriptions(files);
  for (const row of result) {
    if (row.description) continue;
    const full = target(roots, row.kind, port, row.name, row.enabled);
    row.description = automatic.get(full) || '';
    row.descriptionSource = row.description ? 'dll' : null;
  }
  return result.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

function validateBinary(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.length > MAX_PLUGIN_BYTES || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw new HttpError(400, '插件必须是有效的 Windows .dll 文件（最大 32 MB）');
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset > bytes.length - 4 || bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new HttpError(400, '插件文件缺少 PE 标记');
  }
}

async function upload(roots, dataDir, port, kind, name, bytes, replace = false) {
  validateBinary(bytes);
  const full = target(roots, kind, port, name);
  const disabled = target(roots, kind, port, name, false);
  const root = path.dirname(full);
  await fs.mkdir(root, { recursive: true });
  if (await exists(disabled)) throw new HttpError(409, '同名插件已停用，请先启用或改名');
  const present = await exists(full);
  if (present && !replace) throw new HttpError(409, '同名插件已存在，确认替换后再上传');
  if (present) await safeFile(full);
  const temporary = path.join(root, `.${crypto.randomBytes(8).toString('hex')}.tmp`);
  const displaced = temporary + '.old';
  let backup = null;
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx' });
    if (present) {
      const backupDir = path.join(dataDir, 'plugin-backups', kind);
      await fs.mkdir(backupDir, { recursive: true });
      backup = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}-${name}`;
      await fs.copyFile(full, path.join(backupDir, backup));
      await fs.rename(full, displaced);
    }
    try { await fs.rename(temporary, full); }
    catch (error) { if (present) await fs.rename(displaced, full); throw error; }
    if (present) await fs.rm(displaced);
    else await fs.rm(descriptionPath(dataDir, kind, port, name), { force: true });
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  return { kind, name, enabled: true, backup, restartRequired: true };
}

async function setEnabled(roots, port, kind, name, enabled) {
  if (typeof enabled !== 'boolean') throw new HttpError(400, '插件状态无效');
  const source = target(roots, kind, port, name, !enabled);
  const destination = target(roots, kind, port, name, enabled);
  await safeFile(source);
  if (await exists(destination)) throw new HttpError(409, '目标文件已存在，请先处理同名插件');
  await fs.rename(source, destination);
  return { kind, name, enabled, restartRequired: true };
}

async function setDescription(roots, dataDir, port, kind, name, description) {
  const text = validateDescription(description);
  const enabled = target(roots, kind, port, name);
  const disabled = target(roots, kind, port, name, false);
  if (!await exists(enabled) && !await exists(disabled)) throw new HttpError(404, '找不到该插件');
  await safeFile(await exists(enabled) ? enabled : disabled);
  const full = descriptionPath(dataDir, kind, port, name);
  if (text) {
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, text, { mode: 0o600 });
  } else await fs.rm(full, { force: true });
  return { kind, name, description: text, descriptionSource: text ? 'admin' : null };
}

async function remove(roots, dataDir, port, kind, name, enabled) {
  if (typeof enabled !== 'boolean') throw new HttpError(400, '插件状态无效');
  const full = target(roots, kind, port, name, enabled);
  await safeFile(full);
  const backupDir = path.join(dataDir, 'plugin-backups', kind);
  await fs.mkdir(backupDir, { recursive: true });
  const backup = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(6).toString('hex')}-deleted-${name}${enabled ? '' : '.disabled'}`;
  await fs.copyFile(full, path.join(backupDir, backup), fs.constants.COPYFILE_EXCL);
  await fs.rm(full);
  return { kind, name, backup, restartRequired: true };
}

async function download(roots, port, kind, name, enabled) {
  if (typeof enabled !== 'boolean') throw new HttpError(400, '插件状态无效');
  const full = target(roots, kind, port, name, enabled);
  const info = await safeFile(full);
  if (info.size > MAX_DOWNLOAD_BYTES) throw new HttpError(413, '插件超过 128 MB，无法通过面板下载');
  const bytes = await fs.readFile(full);
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new HttpError(413, '插件超过 128 MB，无法通过面板下载');
  return { name, bytes };
}

module.exports = { MAX_PLUGIN_BYTES, pluginRoot, list, upload, setEnabled, setDescription, remove, download, validateName, validateBinary };
