'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const storage = require('./storage');
const { HttpError } = storage;
const { PlayerStore } = require('./players');

const execFileAsync = promisify(execFile);
const CONSOLE_ENCODINGS = new Set(['auto', 'utf8', 'gb18030']);

function encodeQqConsoleCommand(command) {
  const match = /^qqmsg[ \t]+(.+)$/i.exec(command);
  if (!match) return command;
  // LocalAdmin reads the panel's UTF-8 stdin as a Windows code page on some
  // servers. ASCII Base64 keeps the complete message intact across that pipe.
  return `qqmsg64 ${Buffer.from(match[1], 'utf8').toString('base64')}`;
}

class ConsoleLineDecoder {
  constructor(encoding = 'auto') {
    this.encoding = encoding;
    this.pending = Buffer.alloc(0);
    this.utf8 = new TextDecoder('utf-8', { fatal: true });
    this.gb18030 = new TextDecoder('gb18030');
  }

  decode(line) {
    if (this.encoding === 'gb18030') return this.gb18030.decode(line);
    if (this.encoding === 'utf8') return new TextDecoder('utf-8').decode(line);
    try { return this.utf8.decode(line); }
    catch { return this.gb18030.decode(line); }
  }

  feed(chunk) {
    this.pending = Buffer.concat([this.pending, chunk]);
    const lines = [];
    let start = 0;
    for (let i = 0; i < this.pending.length; i++) {
      if (this.pending[i] !== 10 && this.pending[i] !== 13) continue;
      if (i > start) lines.push(this.decode(this.pending.subarray(start, i)) + '\n');
      start = i + 1;
    }
    this.pending = this.pending.subarray(start);
    // A console command can print without a newline. Keep a bounded tail.
    if (this.pending.length > 65536) this.pending = this.pending.subarray(-65536);
    return lines;
  }

  flush() {
    if (!this.pending.length) return [];
    const line = this.decode(this.pending) + '\n';
    this.pending = Buffer.alloc(0);
    return [line];
  }
}

class GameManager {
  constructor(dataDir, roots = null) {
    this.dataDir = dataDir;
    this.roots = roots;
    this.pendingFile = path.join(dataDir, 'pending-player-edits.json');
    this.pendingEdits = [];
    this.pendingError = null;
    this.pendingLock = Promise.resolve();
    this.pendingScheduleSent = false;
    this.pendingExitRequested = false;
    this.restartAfterPending = false;
    this.applyAfterExit = false;
    this.configFile = path.join(dataDir, 'game-control.json');
    this.config = { executable: '', port: 7777, playersCommand: 'players', consoleEncoding: 'auto' };
    this.child = null;
    this.started = 0;
    this.ready = false;
    this.lines = [];
    this.sequence = 0;
    this.pending = '';
    this.externalCache = { expires: 0, items: [] };
    this.cpuSample = null;
    this.playerStore = new PlayerStore(dataDir);
    this.playerQuery = null;
  }

  async init() {
    await this.playerStore.init();
    try {
      const saved = JSON.parse(await fs.readFile(this.configFile, 'utf8'));
      if (typeof saved.executable === 'string' && Number.isInteger(saved.port)) {
        this.config = { executable: saved.executable, port: saved.port,
          playersCommand: typeof saved.playersCommand === 'string' && /^[A-Za-z0-9_ ]{1,80}$/.test(saved.playersCommand) ? saved.playersCommand : 'players',
          consoleEncoding: CONSOLE_ENCODINGS.has(saved.consoleEncoding) ? saved.consoleEncoding : 'auto' };
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try {
      const saved = JSON.parse(await fs.readFile(this.pendingFile, 'utf8'));
      if (!Array.isArray(saved.items) || saved.items.length > 500 || saved.items.some(item =>
        !Number.isInteger(item.port) || item.port < 1 || item.port > 65535 ||
        !['level', 'badge'].includes(item.kind) || !/^7656119\d{10}$/.test(item.steam64 || ''))) {
        throw new Error('待生效玩家修改文件格式无效');
      }
      this.pendingEdits = saved.items;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.pendingError = `无法读取待生效修改：${error.message}`;
        this.pendingEdits = null;
      }
    }
  }

  pendingFor(kind, steam64) {
    return this.pendingEdits?.find(item => item.port === this.config.port && item.kind === kind && item.steam64 === steam64) || null;
  }

  pendingStatus() {
    return { count: this.pendingEdits?.filter(item => item.port === this.config.port).length || 0,
      scheduled: this.pendingScheduleSent, error: this.pendingError };
  }

  async pendingTask(action) {
    const job = this.pendingLock.catch(() => {}).then(action);
    this.pendingLock = job.catch(() => {});
    return job;
  }

  async savePending() {
    await fs.mkdir(this.dataDir, { recursive: true });
    const temp = `${this.pendingFile}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ version: 1, items: this.pendingEdits }, null, 2), { mode: 0o600 });
    try { await fs.rename(temp, this.pendingFile); }
    catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
      await fs.copyFile(temp, this.pendingFile);
      await fs.rm(temp, { force: true });
    }
  }

  schedulePendingRestart() {
    if (!this.child || !this.ready || this.pendingScheduleSent || !this.pendingStatus().count) return;
    try { this.sendCommand('stopnextround'); }
    catch (error) {
      this.pendingError = `修改已保存，但安排回合结束重启失败：${error.message}`;
      this.append(`[面板] ${this.pendingError}\n`);
      return;
    }
    this.pendingScheduleSent = true;
    this.restartAfterPending = true;
    this.append('[面板] 玩家修改已排队；本回合结束时将停止游戏、写入修改并重新启动。\n');
  }

  async queuePlayerEdit(kind, steam64, value) {
    if (!this.roots) throw new HttpError(503, '面板未配置游戏文件目录');
    if (!this.child) throw new HttpError(409, '请先由面板启动游戏服务');
    if (kind === 'level') {
      storage.validatePlayerLevel(steam64, value.level);
      await storage.getPlayerLevel(this.roots, this.config.port, steam64);
    } else if (kind === 'badge') {
      value = { name: storage.validatePlayerBadge(steam64, value.name, value.color), color: value.color };
      await storage.getPlayerBadge(this.roots, this.config.port, steam64);
    } else throw new HttpError(400, '玩家修改类型无效');
    return this.pendingTask(async () => {
      if (!this.pendingEdits) throw new HttpError(503, this.pendingError || '待生效修改文件无法读取');
      const item = { kind, port: this.config.port, steam64, ...value, queuedAt: new Date().toISOString() };
      const index = this.pendingEdits.findIndex(row => row.kind === kind && row.port === item.port && row.steam64 === steam64);
      const previous = index >= 0 ? this.pendingEdits[index] : null;
      if (index >= 0) this.pendingEdits[index] = item;
      else {
        if (this.pendingEdits.length >= 500) throw new HttpError(409, '待生效修改已满');
        this.pendingEdits.push(item);
      }
      try { await this.savePending(); }
      catch (error) {
        if (index >= 0) this.pendingEdits[index] = previous;
        else this.pendingEdits.pop();
        throw error;
      }
      this.pendingError = null;
      this.schedulePendingRestart();
      return { ...item, pending: true, scheduled: this.pendingScheduleSent };
    });
  }

  async applyPending() {
    if (!this.roots || !this.pendingEdits?.length || this.child) return;
    await this.pendingTask(async () => {
      if (this.child) return;
      const failures = [];
      for (const item of [...this.pendingEdits]) {
        if (item.port !== this.config.port) continue;
        try {
          if (item.kind === 'level') {
            const current = await storage.getPlayerLevel(this.roots, item.port, item.steam64);
            await storage.setPlayerLevel(this.roots, this.dataDir, item.port, item.steam64, item.level, current.revision);
            if (this.playerStore.records.has(item.steam64)) await this.playerStore.edit(item.steam64, { level: item.level });
          } else {
            const current = await storage.getPlayerBadge(this.roots, item.port, item.steam64);
            await storage.setPlayerBadge(this.roots, this.dataDir, item.port, item.steam64, item.name, item.color, current.revision);
            if (this.playerStore.records.has(item.steam64)) await this.playerStore.setPluginBadge(item.steam64, item.name, item.color);
          }
          const index = this.pendingEdits.indexOf(item);
          this.pendingEdits.splice(index, 1);
          try { await this.savePending(); }
          catch (error) { this.pendingEdits.splice(index, 0, item); throw error; }
          this.append(`[面板] 已应用 ${item.steam64} 的${item.kind === 'level' ? '等级' : '标签'}修改。\n`);
        } catch (error) {
          failures.push(`${item.steam64} ${item.kind}: ${error.message}`);
        }
      }
      this.pendingError = failures.length ? `部分玩家修改未生效：${failures.join('；').slice(0, 500)}` : null;
      if (this.pendingError) this.append(`[面板] ${this.pendingError}\n`);
    });
  }

  async configure(executable, port, playersCommand = 'players', consoleEncoding = 'auto') {
    if (this.child) throw new HttpError(409, '请先停止由面板管理的游戏服务');
    if (typeof executable !== 'string' || !path.isAbsolute(executable) || path.basename(executable).toLowerCase() !== 'localadmin.exe') {
      throw new HttpError(400, '请输入服务器上 LocalAdmin.exe 的完整路径');
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, '游戏端口无效');
    if (typeof playersCommand !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_ ]{0,79}$/.test(playersCommand.trim())) throw new HttpError(400, '玩家查询命令无效');
    if (!CONSOLE_ENCODINGS.has(consoleEncoding)) throw new HttpError(400, '控制台文字编码无效');
    const info = await fs.stat(executable).catch(() => null);
    if (!info?.isFile()) throw new HttpError(400, '服务器上找不到 LocalAdmin.exe');
    this.config = { executable: path.resolve(executable), port, playersCommand: playersCommand.trim(), consoleEncoding };
    await fs.writeFile(this.configFile, JSON.stringify(this.config, null, 2), { mode: 0o600 });
    return this.config;
  }

  async externalProcesses() {
    if (process.platform !== 'win32') return [];
    if (Date.now() < this.externalCache.expires) return this.externalCache.items;
    try {
      const run = script => execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true, timeout: 7000, maxBuffer: 256 * 1024,
      });
      let stdout;
      try {
        ({ stdout } = await run("Get-CimInstance Win32_Process -Filter \"Name='LocalAdmin.exe'\" -ErrorAction Stop | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"));
      } catch {
        ({ stdout } = await run("Get-Process -Name LocalAdmin -ErrorAction SilentlyContinue | Select-Object @{Name='ProcessId';Expression={$_.Id}},@{Name='ExecutablePath';Expression={$_.Path}} | ConvertTo-Json -Compress"));
      }
      const raw = stdout.trim() ? JSON.parse(stdout.trim()) : [];
      const all = Array.isArray(raw) ? raw : [raw];
      const items = all.filter(item => item && Number(item.ProcessId) !== this.child?.pid).map(item => ({
        pid: Number(item.ProcessId), executable: item.ExecutablePath || '', commandLine: item.CommandLine || '',
      }));
      this.externalCache = { expires: Date.now() + 12000, items };
      return items;
    } catch (error) {
      try {
        const { stdout } = await execFileAsync('tasklist.exe', ['/FI', 'IMAGENAME eq LocalAdmin.exe', '/FO', 'CSV', '/NH'], {
          windowsHide: true, timeout: 7000, maxBuffer: 256 * 1024,
        });
        const items = stdout.split(/\r?\n/).map(line => /^"LocalAdmin\.exe","(\d+)"/i.exec(line.trim())).filter(Boolean)
          .map(match => ({ pid: Number(match[1]), executable: '', commandLine: '' }))
          .filter(item => item.pid !== this.child?.pid);
        this.externalCache = { expires: Date.now() + 12000, items };
        return items;
      } catch {
        throw new HttpError(503, `无法检查现有 LocalAdmin 进程：${error.message}`);
      }
    }
  }

  append(chunk) {
    this.pending += String(chunk).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '\n');
    const parts = this.pending.split('\n');
    this.pending = parts.pop().slice(-4096);
    for (const part of parts) {
      if (!part.trim()) continue;
      const line = part.slice(0, 4096);
      this.lines.push({ sequence: ++this.sequence, time: new Date().toISOString(), text: line });
      if (/waiting for players/i.test(line)) {
        this.ready = true;
        this.schedulePendingRestart();
      }
      if (/Game process exited and has been killed/i.test(line)) {
        this.ready = false;
        this.playerStore.clearOnline();
      }
      if (this.pendingScheduleSent && !this.pendingExitRequested && /Game process exited and has been killed/i.test(line)) {
        this.pendingExitRequested = true;
        try { this.sendCommand('exit'); } catch (error) { this.pendingError = error.message; }
      }
      Promise.resolve(this.playerStore.observeLogLine(line)).catch(error => {
        this.playerStore.error = `保存玩家记录失败：${error.message}`;
      });
    }
    if (this.lines.length > 400) this.lines.splice(0, this.lines.length - 400);
  }

  async start() {
    if (this.child) throw new HttpError(409, '游戏服务已由面板启动');
    if (!this.config.executable) throw new HttpError(400, '请先设置 LocalAdmin.exe 路径');
    this.externalCache.expires = 0;
    const external = await this.externalProcesses();
    if (external.length) throw new HttpError(409, '检测到已运行的 LocalAdmin。请先在原窗口正常关闭它，再从面板启动');
    await this.applyPending();
    const info = await fs.stat(this.config.executable).catch(() => null);
    if (!info?.isFile()) throw new HttpError(400, 'LocalAdmin.exe 路径已失效');
    const child = spawn(this.config.executable, [String(this.config.port), '--noSetCursor', '--noTerminalTitle', '--disableTrueColor'], {
      cwd: path.dirname(this.config.executable), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.started = Date.now();
    this.ready = false;
    this.pendingScheduleSent = false;
    this.pendingExitRequested = false;
    this.pending = '';
    this.append(`[面板] 正在启动 LocalAdmin.exe，游戏端口 ${this.config.port}\n`);
    const stdoutDecoder = new ConsoleLineDecoder(this.config.consoleEncoding);
    const stderrDecoder = new ConsoleLineDecoder(this.config.consoleEncoding);
    child.stdout.on('data', data => stdoutDecoder.feed(data).forEach(line => this.append(line)));
    child.stderr.on('data', data => stderrDecoder.feed(data).forEach(line => this.append(line)));
    child.once('exit', (code, signal) => {
      stdoutDecoder.flush().forEach(line => this.append(line));
      stderrDecoder.flush().forEach(line => this.append(line));
      this.append(`[面板] LocalAdmin 已退出（代码 ${code ?? '无'}，信号 ${signal ?? '无'}）\n`);
      if (this.child === child) this.child = null;
      this.ready = false;
      this.externalCache.expires = 0;
      this.playerStore.clearOnline();
      const shouldRestart = this.restartAfterPending;
      const shouldApply = shouldRestart || this.applyAfterExit;
      this.restartAfterPending = false;
      this.applyAfterExit = false;
      this.pendingScheduleSent = false;
      this.pendingExitRequested = false;
      if (shouldApply && this.pendingStatus().count) {
        this.applyPending().then(async () => {
          if (shouldRestart) await this.start();
        }).catch(error => {
          this.pendingError = `自动应用或重启失败：${error.message}`;
          this.append(`[面板] ${this.pendingError}\n`);
        });
      } else if (shouldRestart) {
        this.start().catch(error => {
          this.pendingError = `自动重启失败：${error.message}`;
          this.append(`[面板] ${this.pendingError}\n`);
        });
      }
    });
    try {
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    } catch (error) {
      if (this.child === child) this.child = null;
      throw new HttpError(500, `LocalAdmin 启动失败：${error.message}`);
    }
    return { started: true, pid: child.pid };
  }

  sendCommand(command) {
    if (!this.child || !this.child.stdin.writable) throw new HttpError(409, '请先从面板启动游戏服务');
    this.child.stdin.write(encodeQqConsoleCommand(command) + '\n');
  }

  restart() {
    if (this.pendingStatus().count) {
      this.sendCommand('exit');
      this.restartAfterPending = true;
      this.pendingScheduleSent = false;
      this.ready = false;
      this.append('[面板] 正在重启游戏，以应用待生效的玩家修改。\n');
      return { accepted: true, applyingPending: true };
    }
    this.sendCommand('restart');
    this.ready = false;
    this.append('[面板] 已发送 LocalAdmin 重启命令\n');
    this.playerStore.clearOnline();
    return { accepted: true };
  }

  stop() {
    this.sendCommand('exit');
    this.restartAfterPending = false;
    this.pendingScheduleSent = false;
    this.applyAfterExit = Boolean(this.pendingStatus().count);
    this.ready = false;
    this.append('[面板] 已发送 LocalAdmin 关闭命令\n');
    return { accepted: true };
  }

  async players() {
    if (this.playerQuery) return this.playerQuery;
    this.playerQuery = (async () => {
      const before = this.sequence;
      this.sendCommand(this.config.playersCommand);
      await new Promise(resolve => setTimeout(resolve, 1700));
      const lines = this.lines.filter(line => line.sequence > before).map(line => line.text);
      await this.playerStore.observe(lines);
      return { lines, ...this.playerStore.view() };
    })();
    try { return await this.playerQuery; }
    finally { this.playerQuery = null; }
  }

  playerStatus(search = '') { return this.playerStore.view(search); }

  logs(after = 0) {
    return { lines: this.lines.filter(line => line.sequence > after).slice(-200), latest: this.sequence };
  }

  async status() {
    let external = [];
    let discoveryError = null;
    if (!this.child) {
      try { external = await this.externalProcesses(); }
      catch (error) { discoveryError = error.message; }
    }
    const ticks = os.cpus().reduce((sum, cpu) => {
      const values = Object.values(cpu.times);
      return { total: sum.total + values.reduce((a, b) => a + b, 0), idle: sum.idle + cpu.times.idle };
    }, { total: 0, idle: 0 });
    let cpuPercent = null;
    if (this.cpuSample) {
      const total = ticks.total - this.cpuSample.total;
      if (total > 0) cpuPercent = Math.round(100 * (1 - (ticks.idle - this.cpuSample.idle) / total));
    }
    this.cpuSample = ticks;
    return {
      config: this.config,
      mode: this.child ? 'managed' : external.length ? 'external' : 'stopped',
      ready: this.ready,
      pid: this.child?.pid || external[0]?.pid || null,
      uptimeSeconds: this.child ? Math.floor((Date.now() - this.started) / 1000) : null,
      external,
      discoveryError,
      machine: { cpuPercent, memoryTotal: os.totalmem(), memoryFree: os.freemem() },
      latest: this.sequence,
      pendingEdits: this.pendingStatus(),
    };
  }
}

module.exports = { GameManager, ConsoleLineDecoder, encodeQqConsoleCommand };
