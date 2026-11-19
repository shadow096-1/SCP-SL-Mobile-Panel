'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { isIP } = require('node:net');

const STEAM_ID = /\b(7656119\d{10})@steam\b/i;
const UNKNOWN_NAME = '名称待重新识别';

function usableName(name) {
  return typeof name === 'string' && name.trim().length > 0 && name.length <= 80 && !name.includes('\uFFFD');
}

function cleanName(value) {
  return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/^(?:\s*(?:#?\d+[.)\]:-]?|player\s*#?\d+|玩家\s*#?\d+)\s*[:.)\]-]?\s*)/i, '')
    .replace(/^(?:name|nickname|昵称)\s*[:=]\s*/i, '')
    .replace(/[\s([{:#-]+$/g, '')
    .replace(/^[\s)\]}:#-]+/g, '')
    .trim();
}

function parsePlayerLine(line) {
  line = String(line).replace(/^\[[^\]]+\]\s*/, '').trim();
  if (/\b(?:Nickname of|is now|connected|disconnected)\b/i.test(line)) return null;
  const match = STEAM_ID.exec(line);
  if (!match) return null;
  let before = cleanName(line.slice(0, match.index));
  let after = cleanName(line.slice(match.index + match[0].length));
  if (/^(?:steamid|userid|id)\s*[:=]?$/i.test(before)) before = '';
  if (/^(?:steamid|userid|id)\s*[:=]?$/i.test(after)) after = '';
  const name = before || after;
  if (!usableName(name) || /^(?:players?|online|steam|\d+)$/i.test(name)) return null;
  return { steam64: match[1], name };
}

function parseSnapshot(lines) {
  const players = new Map();
  let idsWithoutName = 0;
  for (const line of lines) {
    const found = parsePlayerLine(line);
    if (found) players.set(found.steam64, found);
    else if (STEAM_ID.test(line)) idsWithoutName++;
  }
  const zero = lines.some(line => /\blist of players\s*\(\s*0\s*\)|\b(?:players?|online)\s*[:：]?\s*0\b|\b0\s+(?:players?|online)\b|没有玩家|无人在线/i.test(line));
  return { players: [...players.values()], complete: players.size > 0 || zero, idsWithoutName };
}

function connectionIp(details) {
  const match = /\bIP\s*:\s*(\S+)/i.exec(details);
  const value = match?.[1]?.replace(/^\[|\]$/g, '');
  return isIP(value || '') ? value : null;
}

class PlayerStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'players.json');
    this.records = new Map();
    this.online = [];
    this.lastChecked = null;
    this.lastEventAt = null;
    this.lastEvent = null;
    this.error = null;
    this.pendingLog = null;
    this.pendingIpSteam64 = null;
    this.writeQueue = Promise.resolve();
  }

  async init() {
    let repaired = false;
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!Array.isArray(data.records)) throw new Error('玩家记录格式无效');
      for (const row of data.records) {
        if (typeof row.steam64 === 'string' && /^7656119\d{10}$/.test(row.steam64) && typeof row.name === 'string') {
          const name = usableName(row.name) ? row.name : UNKNOWN_NAME;
          if (name !== row.name) repaired = true;
          const playSeconds = Number.isSafeInteger(row.playSeconds) && row.playSeconds >= 0 && row.playSeconds <= 2147483647 ? row.playSeconds : 0;
          const level = Number.isInteger(row.level) && row.level >= 0 && row.level <= 99999 ? row.level : 0;
          const tag = typeof row.tag === 'string' && row.tag.length <= 48 && !/[\r\n\x00-\x1f]/.test(row.tag) ? row.tag : '';
          const tagColor = /^#[0-9A-Fa-f]{6}$/.test(row.tagColor || '') ? row.tagColor.toUpperCase() : '#72C9FF';
          this.records.set(row.steam64, { ...row, name, ip: isIP(row.ip || '') ? row.ip : null, playSeconds, level, tag, tagColor });
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (repaired) await this.queueSave();
  }

  async save() {
    const dir = path.dirname(this.file);
    await fs.mkdir(dir, { recursive: true });
    const temp = `${this.file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const old = `${temp}.old`;
    try {
      await fs.writeFile(temp, JSON.stringify({ version: 1, records: [...this.records.values()] }, null, 2), { flag: 'wx', mode: 0o600 });
      try { await fs.rename(this.file, old); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await fs.rename(temp, this.file); }
      catch (error) { if (await fs.stat(old).catch(() => null)) await fs.rename(old, this.file); throw error; }
      await fs.rm(old, { force: true });
    } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
  }

  queueSave() {
    this.writeQueue = this.writeQueue.catch(() => {}).then(() => this.save());
    return this.writeQueue;
  }

  record(player, now = new Date().toISOString()) {
    const previous = this.records.get(player.steam64);
    const name = usableName(player.name) ? player.name : previous?.name || UNKNOWN_NAME;
    const ip = isIP(player.ip || '') ? player.ip : previous?.ip || null;
    const changed = !previous || previous.name !== name || previous.ip !== ip;
    if (changed) this.records.set(player.steam64, { ...previous, steam64: player.steam64, name, ip,
      firstSeen: previous?.firstSeen || now, updatedAt: now });
    const onlineIndex = this.online.findIndex(row => row.steam64 === player.steam64);
    if (onlineIndex >= 0) this.online[onlineIndex] = { ...this.online[onlineIndex], name, ip };
    return changed;
  }

  settleOnline(row, now = Date.now(), minimumSeconds = 0) {
    const record = this.records.get(row.steam64);
    if (!record || !row.joinedAt) return false;
    const seconds = Math.max(0, Math.floor((now - row.joinedAt) / 1000));
    if (!seconds || seconds < minimumSeconds) return false;
    record.playSeconds = Math.min(2147483647, (record.playSeconds || 0) + seconds);
    row.joinedAt += seconds * 1000;
    return true;
  }

  edit(steam64, fields) {
    if (typeof steam64 !== 'string' || !/^7656119\d{10}$/.test(steam64)) throw new Error('Steam64 ID 无效');
    const row = this.records.get(steam64);
    if (!row) throw new Error('玩家记录不存在');
    const level = fields?.level === undefined ? row.level || 0 : fields.level;
    const playMinutes = fields?.playMinutes;
    const tag = fields?.tag === undefined ? row.tag || '' : fields.tag;
    const tagColor = fields?.tagColor === undefined ? row.tagColor || '#72C9FF' : fields.tagColor;
    if (!Number.isInteger(level) || level < 0 || level > 99999) throw new Error('等级必须为 0 到 99999 的整数');
    if (playMinutes !== undefined && (!Number.isInteger(playMinutes) || playMinutes < 0 || playMinutes > 35791394)) throw new Error('累计时长必须为有效的整数分钟');
    if (typeof tag !== 'string' || tag.length > 48 || /[\r\n\x00-\x1f]/.test(tag)) throw new Error('标签最多 48 个字符且不能包含换行');
    if (typeof tagColor !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(tagColor)) throw new Error('标签颜色需为 #RRGGBB');
    const online = this.online.find(player => player.steam64 === steam64);
    if (online && playMinutes !== undefined) online.joinedAt = Date.now();
    Object.assign(row, { level, tag: tag.trim(), tagColor: tagColor.toUpperCase(), profileUpdatedAt: new Date().toISOString() });
    if (playMinutes !== undefined) row.playSeconds = playMinutes * 60;
    return this.queueSave();
  }

  setPluginBadge(steam64, name, color) {
    const palette = { pink: '#FF80BF', red: '#F44336', brown: '#8D6E63', silver: '#B0BEC5', light_green: '#9CCC65',
      crimson: '#DC143C', cyan: '#00BCD4', aqua: '#00FFFF', deep_pink: '#FF1493', tomato: '#FF6347', yellow: '#FFD54F',
      magenta: '#E040FB', blue_green: '#00A693', orange: '#FF9800', lime: '#C0CA33', green: '#4CAF50',
      emerald: '#50C878', carmine: '#960018', nickel: '#727472', mint: '#98FF98', army_green: '#4B5320',
      pumpkin: '#FF7518', white: '#FFFFFF', rainbow: '#72C9FF' };
    if (!Object.hasOwn(palette, color)) throw new Error('此插件不支持该标签颜色');
    const row = this.records.get(steam64);
    if (!row) throw new Error('玩家记录不存在');
    row.badgeColor = color;
    return this.edit(steam64, { tag: name, tagColor: palette[color] });
  }

  observeLogLine(text) {
    const line = String(text).replace(/^\[[^\]]+\]\s*/, '').trim();
    if (!line) return;
    if (/\bServer has entered the idle mode\b/i.test(line)) {
      this.clearOnline();
      this.pendingLog = null;
      this.pendingIpSteam64 = null;
      return;
    }
    const leaving = STEAM_ID.exec(line);
    if (leaving && /\b(?:disconnected|left the server)\b/i.test(line)) {
      const online = this.online.find(row => row.steam64 === leaving[1]);
      const changed = online && this.settleOnline(online);
      this.online = this.online.filter(row => row.steam64 !== leaving[1]);
      if (online) this.noteEvent('玩家离开');
      this.pendingLog = null;
      this.pendingIpSteam64 = null;
      if (changed) return this.queueSave();
      return;
    }
    const authenticated = /^(7656119\d{10})@steam authenticated from endpoint\b/i.exec(line);
    if (authenticated) {
      const steam64 = authenticated[1];
      const previous = this.records.get(steam64);
      const changed = this.record({ steam64, name: previous?.name || UNKNOWN_NAME });
      if (!this.online.some(row => row.steam64 === steam64)) {
        const record = this.records.get(steam64);
        this.online.push({ steam64, name: record.name, ip: record.ip, joinedAt: Date.now() });
        this.noteEvent('玩家加入');
      }
      this.pendingLog = null;
      if (changed) return this.queueSave();
      return;
    }
    if (this.pendingIpSteam64) {
      const candidate = line.replace(/^\[|\]$/g, '').trim();
      if (isIP(candidate)) {
        const old = this.records.get(this.pendingIpSteam64);
        const changed = old && this.record({ steam64: old.steam64, name: old.name, ip: candidate });
        const online = this.online.find(row => row.steam64 === this.pendingIpSteam64);
        if (online) online.ip = candidate;
        this.pendingIpSteam64 = null;
        if (changed) return this.queueSave();
        return;
      }
      this.pendingIpSteam64 = null;
    }
    const nickname = /^Nickname of\s+(7656119\d{10})@steam\s+is now\s+(.+?)\.?$/i.exec(line);
    if (nickname) {
      const player = { steam64: nickname[1], name: nickname[2].trim() };
      this.pendingLog = null;
      if (this.record(player)) return this.queueSave();
      return;
    }
    const connection = /^Player\s+(.+?)\s+\((7656119\d{10})@steam\)\s+(?:\(\d+\)\s+)?connected\b(.*)$/i.exec(line);
    if (connection) {
      const player = { steam64: connection[2], name: connection[1].trim(), ip: connectionIp(connection[3]) };
      const changed = this.record(player);
      if (!this.online.some(row => row.steam64 === player.steam64)) {
        this.online.push({ ...player, name: this.records.get(player.steam64).name, ip: this.records.get(player.steam64).ip, joinedAt: Date.now() });
        this.noteEvent('玩家加入');
      }
      this.pendingIpSteam64 = /\bIP\s*:\s*$/i.test(connection[3]) ? player.steam64 : null;
      this.pendingLog = null;
      if (changed) return this.queueSave();
      return;
    }
    if (this.pendingLog?.kind === 'nickname') {
      const follow = /^(7656119\d{10})@steam\s+is now\s+(.+?)\.?$/i.exec(line);
      this.pendingLog = null;
      if (follow) {
        if (this.record({ steam64: follow[1], name: follow[2].trim() })) return this.queueSave();
        return;
      }
    } else if (this.pendingLog?.kind === 'connection') {
      const follow = /^\((7656119\d{10})@steam\)\s+(?:\(\d+\)\s+)?connected\b(.*)$/i.exec(line);
      const name = this.pendingLog.name;
      this.pendingLog = null;
      if (follow) {
        const player = { steam64: follow[1], name, ip: connectionIp(follow[2]) };
        const changed = this.record(player);
        if (!this.online.some(row => row.steam64 === player.steam64)) {
          this.online.push({ ...player, name: this.records.get(player.steam64).name, ip: this.records.get(player.steam64).ip, joinedAt: Date.now() });
          this.noteEvent('玩家加入');
        }
        this.pendingIpSteam64 = /\bIP\s*:\s*$/i.test(follow[2]) ? player.steam64 : null;
        if (changed) return this.queueSave();
        return;
      }
    }
    if (/^Nickname of\s*$/i.test(line)) this.pendingLog = { kind: 'nickname' };
    else if (/^Player\s+.+$/i.test(line)) this.pendingLog = { kind: 'connection', name: line.slice(7).trim() };
    else this.pendingLog = null;
  }

  async observe(lines) {
    const snapshot = parseSnapshot(lines);
    this.lastChecked = new Date().toISOString();
    if (!snapshot.complete) {
      this.error = snapshot.idsWithoutName ? '读取到 Steam64 ID，但未能从同一行识别玩家名称。请检查 players 原始输出。' : '未能识别玩家列表；请检查 players 原始输出。';
      return snapshot;
    }
    const now = this.lastChecked;
    let changed = false;
    this.error = snapshot.idsWithoutName ? `有 ${snapshot.idsWithoutName} 条玩家记录缺少可识别名称。` : null;
    for (const player of snapshot.players) {
      if (this.record(player, now)) changed = true;
    }
    const previous = new Map(this.online.map(player => [player.steam64, player]));
    for (const online of this.online) if (this.settleOnline(online, Date.now(),
      snapshot.players.some(player => player.steam64 === online.steam64) ? 60 : 0)) changed = true;
    this.online = snapshot.players.map(player => ({ ...player, ip: this.records.get(player.steam64)?.ip || null,
      joinedAt: previous.get(player.steam64)?.joinedAt || Date.now() }));
    if (changed) await this.queueSave();
    return snapshot;
  }

  view(search = '') {
    const q = String(search).trim().toLowerCase().slice(0, 80);
    const records = [...this.records.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const live = new Map(this.online.map(row => [row.steam64, row]));
    const project = row => ({ ...row, playSeconds: Math.min(2147483647, (row.playSeconds || 0) +
      (live.has(row.steam64) ? Math.max(0, Math.floor((Date.now() - live.get(row.steam64).joinedAt) / 1000)) : 0)) });
    return { online: this.online.map(row => project(this.records.get(row.steam64) || row)), known: records.filter(row => !q || `${row.name} ${row.steam64} ${row.ip || ''} ${row.tag || ''}`.toLowerCase().includes(q)).slice(0, 100).map(project),
      totalKnown: records.length, lastChecked: this.lastChecked,
      lastEventAt: this.lastEventAt, lastEvent: this.lastEvent, error: this.error };
  }

  noteEvent(label) {
    this.lastEventAt = new Date().toISOString();
    this.lastEvent = label;
  }

  clearOnline() {
    if (this.online.length) this.noteEvent('在线名单已清空');
    let changed = false;
    for (const row of this.online) if (this.settleOnline(row)) changed = true;
    this.online = [];
    if (changed) this.queueSave().catch(error => { this.error = `保存游玩时长失败：${error.message}`; });
  }
}

module.exports = { parsePlayerLine, parseSnapshot, PlayerStore };
