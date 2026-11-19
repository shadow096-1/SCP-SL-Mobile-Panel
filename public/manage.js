'use strict';

const byId = id => document.getElementById(id);
const panelApi = (...args) => window.panelApi(...args);
const panelToast = (...args) => window.panelToast(...args);
let activeView = 'dashboard';
let pluginRows = [];
let configLoaded = false;
let playerSearchTimer;
let permissionLabels = {};
let auditOffset = 0;
let auditGeneration = 0;
let auditSearchTimer;
let gameAdminLoading = false;
let gameAdminSearchTimer;
let selectedPlayerId = '';
let selectedPlayer = null;
let remoteAdminRevision = '';
let levelRevision = '';
let badgeRevision = '';
let gameMode = 'unknown';
const badgeColorNames = { pink: '粉色', red: '红色', brown: '棕色', silver: '银色', light_green: '浅绿',
  crimson: '绯红', cyan: '青色', aqua: '水蓝', deep_pink: '深粉', tomato: '番茄红', yellow: '黄色',
  magenta: '品红', blue_green: '蓝绿', orange: '橙色', lime: '黄绿', green: '绿色', emerald: '祖母绿',
  carmine: '胭脂红', nickel: '镍灰', mint: '薄荷绿', army_green: '军绿', pumpkin: '南瓜橙', white: '白色', rainbow: '彩虹' };

byId('players-content').append(byId('online-card'), byId('player-records-card'), byId('player-editor-card'));
byId('game-admin-content').append(byId('game-admin-card'));

async function selectPlayer(player) {
  selectedPlayerId = player.steam64;
  selectedPlayer = player;
  byId('player-editor-card').hidden = false;
  byId('player-editor-name').textContent = player.name;
  byId('player-editor-id').textContent = `${player.steam64}@steam · 最近 IP：${player.ip || '未知'}`;
  levelRevision = '';
  badgeRevision = '';
  byId('player-level').value = player.level || 1;
  byId('player-minutes').value = Math.floor((player.playSeconds || 0) / 60);
  byId('player-tag').value = player.tag || '';
  byId('player-profile-form').querySelectorAll('input').forEach(input => { input.disabled = !window.panelCan('players.manage'); });
  byId('player-profile-save').hidden = !window.panelCan('players.manage');
  byId('player-level').disabled = !window.panelCan('players.manage');
  byId('player-tag').disabled = !window.panelCan('players.manage');
  byId('player-badge-color').disabled = !window.panelCan('players.manage');
  byId('player-level-save').hidden = !window.panelCan('players.manage');
  byId('player-badge-save').hidden = !window.panelCan('players.manage');
  byId('player-level-save').disabled = true;
  byId('player-badge-save').disabled = true;
  byId('player-level-status').textContent = '正在读取 PlayerLevels 存档…';
  byId('player-badge-status').textContent = '正在读取 PlayerBadge 配置…';
  const requests = await Promise.allSettled([
    panelApi(`/api/player/level?steam64=${encodeURIComponent(player.steam64)}`),
    panelApi(`/api/player/badge?steam64=${encodeURIComponent(player.steam64)}`),
  ]);
  if (selectedPlayerId !== player.steam64) return;
  if (requests[0].status === 'fulfilled') {
    const data = requests[0].value;
    levelRevision = data.revision;
    byId('player-level').value = data.pending?.level || data.level || 1;
    byId('player-level-save').disabled = !window.panelCan('players.manage') || gameMode === 'external';
    byId('player-level-status').textContent = data.pending
      ? `待生效等级：${data.pending.level}；插件当前等级：${data.level ?? '无'}。本回合结束后自动应用。`
      : data.level === null ? '插件中尚无此玩家记录；保存后会新增。' : `插件当前等级：${data.level} · 经验：${data.experience} · 累计积分：${data.totalPoints}`;
  } else byId('player-level-status').textContent = `无法读取插件等级：${requests[0].reason.message}`;
  if (requests[1].status === 'fulfilled') {
    const data = requests[1].value;
    badgeRevision = data.revision;
    byId('player-tag').value = data.pending?.name ?? data.name;
    const color = byId('player-badge-color');
    color.replaceChildren();
    for (const value of data.colors) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = `${badgeColorNames[value] || value} · ${value}`;
      color.append(option);
    }
    color.value = data.colors.includes(data.pending?.color || data.color) ? (data.pending?.color || data.color) : 'white';
    byId('player-badge-save').disabled = !window.panelCan('players.manage') || gameMode === 'external';
    byId('player-badge-status').textContent = data.pending
      ? `待生效标签：${data.pending.name || '移除'} · 颜色：${data.pending.color}。本回合结束后自动应用。`
      : data.name ? `插件当前标签：${data.name} · 颜色：${data.color}` : '插件中尚无此玩家标签。';
  } else byId('player-badge-status').textContent = `无法读取插件标签：${requests[1].reason.message}`;
  byId('player-admin-box').hidden = !window.panelUser?.owner;
  if (window.panelUser?.owner) {
    byId('player-admin-status').textContent = '正在读取游戏管理员组…';
    try {
      const result = await panelApi(`/api/player/admin?steam64=${encodeURIComponent(player.steam64)}`);
      if (selectedPlayerId !== player.steam64) return;
      remoteAdminRevision = result.revision;
      const select = byId('player-admin-group');
      select.replaceChildren();
      for (const role of ['', ...result.roles]) {
        const option = document.createElement('option');
        option.value = role;
        option.textContent = role || '普通玩家（无管理权限）';
        select.append(option);
      }
      select.value = result.group || '';
      byId('player-admin-save').disabled = result.roles.length === 0;
      byId('player-admin-status').textContent = result.roles.length ? `当前组：${result.group || '普通玩家'}` : '未找到已定义的管理员组，请检查 config_remoteadmin.txt。';
    } catch (error) {
      if (selectedPlayerId !== player.steam64) return;
      remoteAdminRevision = '';
      byId('player-admin-save').disabled = true;
      byId('player-admin-status').textContent = `无法读取管理员配置：${error.message}`;
    }
  }
  byId('player-editor-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderPlayerRows(target, players, emptyText, showDate = false) {
  const list = byId(target);
  list.replaceChildren();
  if (!players.length) {
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = emptyText;
    list.append(note);
    return;
  }
  for (const player of players) {
    const row = document.createElement('div');
    row.className = 'player-row';
    row.classList.toggle('selected', player.steam64 === selectedPlayerId);
    const detail = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = player.name;
    const id = document.createElement('small');
    id.textContent = `${player.steam64}@steam`;
    detail.append(name, id);
    if (player.tag) {
      const tag = document.createElement('span');
      tag.className = 'player-tag-preview';
      tag.textContent = player.tag;
      const color = /^#[0-9a-f]{6}$/i.test(player.tagColor || '') ? player.tagColor : '#72C9FF';
      const swatch = document.createElement('img');
      swatch.alt = '';
      swatch.src = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12" rx="3" fill="${color}"/></svg>`)}`;
      tag.prepend(swatch);
      detail.append(tag);
    }
    if (window.panelCan('players.records') || window.panelCan('server.console')) {
      const stats = document.createElement('small');
      stats.textContent = `等级 ${player.level || 0} · 累计 ${Math.floor((player.playSeconds || 0) / 60)} 分钟`;
      detail.append(stats);
    }
    if (player.ip) {
      const ip = document.createElement('small');
      ip.textContent = `最近 IP：${player.ip}`;
      detail.append(ip);
    }
    if (showDate && player.updatedAt) {
      const date = document.createElement('small');
      date.textContent = `最近记录：${new Date(player.updatedAt).toLocaleString('zh-CN')}`;
      detail.append(date);
    }
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'secondary';
    copy.textContent = '复制 ID';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(player.steam64); panelToast('Steam64 ID 已复制'); }
      catch { panelToast('复制失败，请手动选择 ID', true); }
    });
    const actions = document.createElement('div');
    actions.className = 'player-actions';
    if (window.panelCan('players.records')) {
      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'secondary';
      select.textContent = '选择玩家';
      select.addEventListener('click', () => selectPlayer(player).catch(error => panelToast(error.message, true)));
      actions.append(select);
    }
    actions.append(copy);
    row.append(detail, actions);
    list.append(row);
  }
}

async function refreshPlayerRecords() {
  if (byId('app').hidden || activeView !== 'players') return;
  if (!window.panelCan('players.online')) return;
  try {
    const status = await panelApi('/api/game/status');
    gameMode = status.mode;
    byId('game-players').disabled = gameMode !== 'managed';
    byId('player-level-save').disabled = gameMode === 'external' || !levelRevision || !window.panelCan('players.manage');
    byId('player-badge-save').disabled = gameMode === 'external' || !badgeRevision || !window.panelCan('players.manage');
    const q = byId('player-search').value.trim();
    const result = await panelApi(`/api/players?q=${encodeURIComponent(q)}`);
    byId('online-count').textContent = result.online.length;
    byId('known-count').textContent = result.totalKnown;
    const eventTime = result.lastEventAt ? new Date(result.lastEventAt).toLocaleTimeString('zh-CN') : '';
    byId('players-monitor-status').textContent = result.error || (gameMode === 'managed'
      ? `根据连接和离开日志实时更新${eventTime ? ` · 最近${result.lastEvent}：${eventTime}` : ' · 等待玩家进退'}；可手动查询核对。`
      : gameMode === 'external' ? '游戏在原窗口运行；请由面板启动游戏才能监听玩家进退。' : '游戏未运行；启动后自动监听玩家进退。');
    renderPlayerRows('online-player-list', result.online, '暂无在线玩家记录。');
    renderPlayerRows('known-player-list', result.known, q ? '没有匹配的玩家。' : '尚无记录。', true);
    const latest = [...result.online, ...result.known].find(player => player.steam64 === selectedPlayerId);
    if (latest) { selectedPlayer = latest; byId('player-editor-name').textContent = latest.name; }
  } catch (error) { byId('players-monitor-status').textContent = `读取玩家失败：${error.message}`; }
}

function viewAllowed(view) {
  if (view === 'accounts' || view === 'audit' || view === 'game_admin') return Boolean(window.panelUser?.owner);
  if (view === 'dashboard') return window.panelCan('server.view');
  if (view === 'players') return window.panelCan('players.online');
  if (view === 'plugins') return window.panelCan('plugins.read');
  if (view === 'config') return window.panelCan('config.read');
  return false;
}

function chooseView(view) {
  if (!viewAllowed(view)) return;
  activeView = view;
  for (const name of ['dashboard', 'players', 'game_admin', 'plugins', 'config', 'accounts', 'audit']) byId(`${name}-view`).hidden = name !== view;
  for (const tab of document.querySelectorAll('.page-tab')) tab.classList.toggle('active', tab.dataset.view === view);
  if (view === 'dashboard') refreshGame();
  if (view === 'players') refreshPlayerRecords();
  if (view === 'game_admin') refreshGameAdminLogs();
  if (view === 'plugins') refreshPlugins();
  if (view === 'accounts') refreshAccounts();
  if (view === 'audit') refreshAudit(true);
}

function bytesText(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

async function refreshGame() {
  if (byId('app').hidden || activeView !== 'dashboard') return;
  if (!window.panelCan('server.view')) return;
  try {
    const result = await panelApi('/api/game/status');
    const mode = result.mode;
    gameMode = mode;
    byId('game-state').textContent = mode === 'managed' ? (result.ready ? '运行中' : '启动中') : mode === 'external' ? '原窗口运行中' : '已停止';
    byId('game-detail').textContent = mode === 'managed' ? `由面板管理 · PID ${result.pid} · 已运行 ${Math.floor(result.uptimeSeconds / 60)} 分钟` :
      mode === 'external' ? `检测到 LocalAdmin.exe · PID ${result.pid}` : '尚未从面板启动游戏';
    byId('machine-cpu').textContent = result.machine.cpuPercent === null ? '计算中…' : `${result.machine.cpuPercent}%`;
    byId('machine-memory').textContent = `${bytesText(result.machine.memoryTotal - result.machine.memoryFree)} / ${bytesText(result.machine.memoryTotal)}`;
    if (!configLoaded) {
      byId('game-executable').value = result.config.executable || result.external[0]?.executable || '';
      const detectedPort = /LocalAdmin\.exe"?\s+(\d{1,5})(?:\s|$)/i.exec(result.external[0]?.commandLine || '');
      byId('game-port').value = result.config.executable ? result.config.port : detectedPort ? Number(detectedPort[1]) : result.config.port || 7777;
      byId('players-command').value = result.config.playersCommand || 'players';
      byId('console-encoding').value = result.config.consoleEncoding || 'auto';
      configLoaded = true;
    }
    byId('game-start').disabled = mode !== 'stopped' || !result.config.executable;
    byId('game-restart').disabled = mode !== 'managed';
    byId('game-stop').disabled = mode !== 'managed';
    byId('game-players').disabled = mode !== 'managed';
    byId('console-send').disabled = mode !== 'managed';
    byId('player-level-save').disabled = mode === 'external' || !levelRevision || !window.panelCan('players.manage');
    byId('player-badge-save').disabled = mode === 'external' || !badgeRevision || !window.panelCan('players.manage');
    const pending = byId('pending-edits-status');
    pending.hidden = !result.pendingEdits?.count && !result.pendingEdits?.error;
    pending.textContent = result.pendingEdits?.error || (result.pendingEdits?.scheduled
      ? `${result.pendingEdits.count} 项玩家修改待生效：本回合结束后将自动重启游戏。`
      : `${result.pendingEdits.count} 项玩家修改待生效；下次启动游戏前自动写入。`);
    byId('panel-update').disabled = mode === 'managed';
    byId('game-config-form').querySelector('button').disabled = mode === 'managed';
    const hint = byId('external-hint');
    hint.hidden = mode !== 'external' && !result.discoveryError;
    hint.textContent = result.discoveryError || '原 LocalAdmin.exe 仍在运行。请在原窗口输入 exit 正常关闭，再从此面板启动。';
    if (window.panelCan('players.records')) {
      const logs = await panelApi('/api/game/logs?after=0');
      byId('game-logs').textContent = logs.lines.length ? logs.lines.slice(-80).map(item => item.text).join('\n') : '暂无记录。';
    }
    if (window.panelUser?.owner) {
      const panel = await panelApi('/api/panel/version');
      byId('panel-version').textContent = `v${panel.version}`;
    }
  } catch (error) {
    byId('game-state').textContent = '读取失败';
    byId('game-detail').textContent = error.message;
  }
}

const labels = {
  exiled: 'EXILED',
  'labapi-port': 'LabAPI · 当前端口',
  'labapi-global': 'LabAPI · 全局',
  'labapi-dependency-port': 'LabAPI 依赖 · 当前端口',
  'labapi-dependency-global': 'LabAPI 依赖 · 全局',
};

async function refreshPlugins() {
  if (byId('app').hidden || activeView !== 'plugins') return;
  if (!window.panelCan('plugins.read')) return;
  try {
    const data = await panelApi('/api/plugins');
    pluginRows = data.plugins;
    const list = byId('plugin-list');
    list.replaceChildren();
    if (!pluginRows.length) {
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent = '尚未发现插件。请确认面板与游戏服务使用同一 Windows 账户。';
      list.append(note);
      return;
    }
    for (const plugin of pluginRows) {
      const row = document.createElement('div');
      row.className = 'plugin-row';
      const main = document.createElement('div');
      main.className = 'plugin-info';
      const name = document.createElement('strong');
      name.textContent = plugin.name;
      const meta = document.createElement('small');
      meta.textContent = `${labels[plugin.kind]} · ${(plugin.bytes / 1024).toFixed(0)} KB · ${plugin.enabled ? '已启用' : '已停用'}`;
      const purpose = document.createElement('small');
      purpose.className = 'plugin-purpose';
      purpose.textContent = plugin.description
        ? `作用：${plugin.description}${plugin.descriptionSource === 'dll' ? '（DLL 文件说明）' : ''}`
        : '作用：暂无说明，可由管理员填写';
      main.append(name, meta, purpose);
      const actions = document.createElement('div');
      actions.className = 'plugin-actions';
      const download = document.createElement('a');
      download.className = 'secondary';
      download.textContent = '下载 DLL';
      download.href = `/api/plugins/download?kind=${encodeURIComponent(plugin.kind)}&name=${encodeURIComponent(plugin.name)}&enabled=${plugin.enabled}`;
      download.download = plugin.name;
      download.title = '下载服务器上的插件原文件';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = plugin.enabled ? 'secondary' : 'primary';
      button.textContent = plugin.enabled ? '停用' : '启用';
      button.hidden = !window.panelCan('plugins.manage');
      button.addEventListener('click', async () => {
        if (!confirm(`${plugin.enabled ? '停用' : '启用'} ${plugin.name}？需要重启游戏服务才能生效。`)) return;
        button.disabled = true;
        try {
          await panelApi('/api/plugins/toggle', { method: 'POST', body: JSON.stringify({ kind: plugin.kind, name: plugin.name, enabled: !plugin.enabled }) });
          panelToast('插件状态已更改；重启游戏服务后生效');
          await refreshPlugins();
        } catch (error) { panelToast(error.message, true); button.disabled = false; }
      });
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'secondary';
      edit.textContent = '编辑作用';
      edit.hidden = !window.panelCan('plugins.manage');
      edit.addEventListener('click', async () => {
        const description = prompt(`填写 ${plugin.name} 的作用说明（最多 500 字；留空可清除手动说明）`, plugin.descriptionSource === 'admin' ? plugin.description : '');
        if (description === null) return;
        if (description.length > 500) return panelToast('作用说明不能超过 500 字', true);
        edit.disabled = true;
        try {
          await panelApi('/api/plugins/description', { method: 'POST', body: JSON.stringify({ kind: plugin.kind, name: plugin.name, description }) });
          panelToast('插件作用说明已保存');
          await refreshPlugins();
        } catch (error) { panelToast(error.message, true); edit.disabled = false; }
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'secondary danger';
      remove.textContent = '删除';
      remove.hidden = !window.panelCan('plugins.manage');
      remove.addEventListener('click', async () => {
        if (!confirm(`删除 ${plugin.name}？面板会先备份 DLL；重启游戏服务后生效。`)) return;
        remove.disabled = true;
        try {
          await panelApi('/api/plugins/delete', { method: 'POST', body: JSON.stringify({ kind: plugin.kind, name: plugin.name, enabled: plugin.enabled }) });
          panelToast('插件已删除并备份；重启游戏服务后生效');
          await refreshPlugins();
        } catch (error) { panelToast(error.message, true); remove.disabled = false; }
      });
      actions.append(download, edit, button, remove);
      row.append(main, actions);
      list.append(row);
    }
  } catch (error) { panelToast(error.message, true); }
}

function permissionBoxes(target, selected = []) {
  target.replaceChildren();
  for (const [key, label] of Object.entries(permissionLabels)) {
    const item = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = key;
    input.checked = selected.includes(key);
    item.append(input, document.createTextNode(label));
    target.append(item);
  }
}

function selectedPermissions(target) {
  return [...target.querySelectorAll('input:checked')].map(input => input.value);
}

async function refreshAccounts() {
  if (!window.panelUser?.owner || activeView !== 'accounts') return;
  try {
    const [available, data] = await Promise.all([panelApi('/api/accounts/permissions'), panelApi('/api/accounts')]);
    permissionLabels = available.permissions;
    permissionBoxes(byId('new-account-permissions'), ['server.view', 'players.online']);
    const list = byId('account-list');
    list.replaceChildren();
    for (const account of data.users) {
      const row = document.createElement('div');
      row.className = 'account-row';
      const title = document.createElement('strong');
      title.textContent = `${account.username} · ${account.owner ? '主账号 · 全部权限' : account.enabled ? '已启用' : '已停用'}`;
      row.append(title);
      if (!account.owner) {
        const box = document.createElement('div');
        box.className = 'account-permissions';
        permissionBoxes(box, account.permissions);
        const enabled = document.createElement('label');
        enabled.className = 'account-enabled';
        const enabledInput = document.createElement('input');
        enabledInput.type = 'checkbox';
        enabledInput.checked = account.enabled;
        enabled.append(enabledInput, document.createTextNode('允许登录'));
        const password = document.createElement('input');
        password.type = 'password';
        password.placeholder = '留空则不修改密码；新密码至少 6 位';
        password.autocomplete = 'new-password';
        const actions = document.createElement('div');
        actions.className = 'control-actions';
        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'primary';
        save.textContent = '保存权限和状态';
        save.addEventListener('click', async () => {
          save.disabled = true;
          try {
            await panelApi('/api/accounts/update', { method: 'POST', body: JSON.stringify({ id: account.id,
              permissions: selectedPermissions(box), enabled: enabledInput.checked, password: password.value }) });
            panelToast('账号已更新');
            await refreshAccounts();
          } catch (error) { panelToast(error.message, true); save.disabled = false; }
        });
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'secondary';
        remove.textContent = '删除账号';
        remove.addEventListener('click', async () => {
          if (!confirm(`确定删除账号 ${account.username}？该账号会立即失去访问权限。`)) return;
          try {
            await panelApi('/api/accounts/delete', { method: 'POST', body: JSON.stringify({ id: account.id }) });
            panelToast('账号已删除');
            await refreshAccounts();
          } catch (error) { panelToast(error.message, true); }
        });
        actions.append(save, remove);
        row.append(box, enabled, password, actions);
      }
      list.append(row);
    }
  } catch (error) { panelToast(error.message, true); }
}

async function refreshGameAdminLogs() {
  if (!window.panelUser?.owner || activeView !== 'game_admin' || gameAdminLoading) return;
  gameAdminLoading = true;
  try {
    const query = byId('game-admin-search').value.trim();
    const result = await panelApi(`/api/game/admin-logs?limit=100&q=${encodeURIComponent(query)}`);
    if (query !== byId('game-admin-search').value.trim() || activeView !== 'game_admin') return;
    const list = byId('game-admin-list');
    list.replaceChildren();
    byId('game-admin-note').textContent = result.error || (result.entries.length
      ? '来自游戏回合日志；按时间从新到旧显示，最多 100 条。'
      : `暂无游戏内 Remote Admin 操作记录。已检查：${result.source}`);
    for (const entry of result.entries) {
      const row = document.createElement('div');
      row.className = 'audit-row';
      const title = document.createElement('strong');
      title.textContent = `${new Date(entry.time).toLocaleString('zh-CN', { hour12: false })} · ${entry.actor} · ${entry.action || '其他管理操作'}`;
      const target = document.createElement('small');
      target.textContent = [entry.target ? `目标：${entry.target}` : '', entry.item ? `物品：${entry.item}` : ''].filter(Boolean).join(' · ');
      const details = document.createElement('small');
      details.textContent = `日志原文：${entry.detail}`;
      const source = document.createElement('small');
      source.textContent = `${entry.type}${entry.actorId ? ` · ${entry.actorId}` : ''} · ${entry.source}`;
      row.append(title);
      if (target.textContent) row.append(target);
      row.append(details, source);
      list.append(row);
    }
  } catch (error) { byId('game-admin-note').textContent = `读取游戏日志失败：${error.message}`; }
  finally { gameAdminLoading = false; }
}

async function refreshAudit(reset = true) {
  if (!window.panelUser?.owner || activeView !== 'audit') return;
  if (reset) { auditOffset = 0; auditGeneration++; byId('audit-list').replaceChildren(); }
  const generation = auditGeneration;
  const button = byId('audit-more');
  button.disabled = true;
  const query = byId('audit-search').value.trim();
  try {
    const result = await panelApi(`/api/audit?limit=100&offset=${auditOffset}&q=${encodeURIComponent(query)}`);
    if (generation !== auditGeneration || query !== byId('audit-search').value.trim()) return;
    if (reset && !result.entries.length) byId('audit-note').textContent = '暂无记录。';
    else byId('audit-note').textContent = result.error ? `审计记录写入异常：${result.error}` : '按时间从新到旧显示。';
    for (const entry of result.entries) {
      const row = document.createElement('div');
      row.className = 'audit-row';
      const title = document.createElement('strong');
      title.textContent = `${entry.action} · ${entry.result}`;
      title.classList.toggle('audit-failed', entry.result !== '成功');
      const details = document.createElement('small');
      details.textContent = `${new Date(entry.time).toLocaleString('zh-CN')} · ${entry.username} · ${entry.ip} · HTTP ${entry.status}`;
      row.append(title, details);
      if (entry.target) {
        const target = document.createElement('small');
        target.textContent = `${entry.action === '发送 LocalAdmin 控制台命令' ? '命令' : '对象'}：${entry.target}`;
        row.append(target);
      }
      byId('audit-list').append(row);
    }
    auditOffset = result.nextOffset;
    button.hidden = !result.hasMore;
  } catch (error) { panelToast(error.message, true); }
  finally { button.disabled = false; }
}

function applyAccess() {
  const can = window.panelCan;
  selectedPlayerId = '';
  selectedPlayer = null;
  remoteAdminRevision = '';
  levelRevision = '';
  badgeRevision = '';
  gameMode = 'unknown';
  byId('player-editor-card').hidden = true;
  byId('player-editor-name').textContent = '';
  byId('player-editor-id').textContent = '';
  byId('player-admin-group').replaceChildren();
  byId('player-badge-color').replaceChildren();
  byId('online-player-list').replaceChildren();
  byId('known-player-list').replaceChildren();
  for (const tab of document.querySelectorAll('.page-tab')) {
    tab.hidden = !viewAllowed(tab.dataset.view);
  }
  byId('game-control-card').hidden = !can('server.control');
  byId('online-card').hidden = !can('players.online');
  byId('console-card').hidden = !(can('players.records') || can('server.console'));
  byId('console-command-form').hidden = !can('server.console');
  byId('player-records-card').hidden = !can('players.records');
  byId('players-raw').hidden = !can('players.records');
  byId('panel-update-card').hidden = !window.panelUser?.owner;
  byId('game-admin-card').hidden = !window.panelUser?.owner;
  byId('plugin-upload-card').hidden = !can('plugins.manage');
  const configWrite = can('config.write');
  byId('save').hidden = !configWrite;
  byId('save-bottom').hidden = !configWrite;
  byId('editor').readOnly = !configWrite;
  byId('backups').textContent = configWrite ? '历史备份' : '查看备份';
  const available = [...document.querySelectorAll('.page-tab')].find(tab => !tab.hidden);
  if (available) chooseView(available.dataset.view);
}

for (const tab of document.querySelectorAll('.page-tab')) tab.addEventListener('click', () => chooseView(tab.dataset.view));
byId('game-refresh').addEventListener('click', refreshGame);
byId('players-refresh').addEventListener('click', refreshPlayerRecords);
byId('plugins-refresh').addEventListener('click', refreshPlugins);
byId('accounts-refresh').addEventListener('click', refreshAccounts);
byId('audit-refresh').addEventListener('click', () => refreshAudit(true));
byId('game-admin-refresh').addEventListener('click', refreshGameAdminLogs);
byId('game-admin-search').addEventListener('input', () => {
  clearTimeout(gameAdminSearchTimer);
  gameAdminSearchTimer = setTimeout(refreshGameAdminLogs, 250);
});
byId('audit-more').addEventListener('click', () => refreshAudit(false));
byId('audit-search').addEventListener('input', () => {
  clearTimeout(auditSearchTimer);
  auditSearchTimer = setTimeout(() => refreshAudit(true), 250);
});
byId('account-create-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  try {
    await panelApi('/api/accounts', { method: 'POST', body: JSON.stringify({ username: byId('new-account-name').value.trim(),
      password: byId('new-account-password').value, permissions: selectedPermissions(byId('new-account-permissions')) }) });
    byId('new-account-name').value = '';
    byId('new-account-password').value = '';
    panelToast('服管理员账号已创建');
    await refreshAccounts();
  } catch (error) { panelToast(error.message, true); }
  finally { button.disabled = false; }
});
byId('own-password-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await panelApi('/api/account/password', { method: 'POST', body: JSON.stringify({ oldPassword: byId('own-old-password').value,
      newPassword: byId('own-new-password').value }) });
    panelToast('密码已修改，请重新登录');
    window.location.reload();
  } catch (error) { panelToast(error.message, true); }
});
byId('game-config-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await panelApi('/api/game/config', { method: 'POST', body: JSON.stringify({ executable: byId('game-executable').value.trim(), port: Number(byId('game-port').value), playersCommand: byId('players-command').value.trim(), consoleEncoding: byId('console-encoding').value }) });
    panelToast('游戏路径和端口已保存');
    await refreshGame();
  } catch (error) { panelToast(error.message, true); }
});
byId('game-start').addEventListener('click', async () => {
  try { await panelApi('/api/game/start', { method: 'POST' }); panelToast('正在启动游戏服务'); await refreshGame(); }
  catch (error) { panelToast(error.message, true); }
});
byId('game-restart').addEventListener('click', async () => {
  if (!confirm('确认重启 SCP:SL 游戏服务？在线玩家会暂时断开。')) return;
  try { await panelApi('/api/game/restart', { method: 'POST' }); panelToast('已发送重启命令'); await refreshGame(); }
  catch (error) { panelToast(error.message, true); }
});
byId('game-stop').addEventListener('click', async () => {
  if (!confirm('确认关闭 SCP:SL 游戏服务器？在线玩家会断开，Windows 电脑仍保持运行。')) return;
  try { await panelApi('/api/game/stop', { method: 'POST' }); panelToast('已发送正常关闭命令'); await refreshGame(); }
  catch (error) { panelToast(error.message, true); }
});
byId('game-players').addEventListener('click', async () => {
  byId('players-output').textContent = '正在查询玩家…';
  try {
    const result = await panelApi('/api/game/players', { method: 'POST' });
    byId('players-output').textContent = result.lines.length ? result.lines.join('\n') :
      result.online?.length ? result.online.map(player => `${player.name} (${player.steam64}@steam)`).join('\n') : '暂无在线玩家。';
    await refreshPlayerRecords();
  } catch (error) { byId('players-output').textContent = error.message; panelToast(error.message, true); }
});
byId('console-command-form').addEventListener('submit', async event => {
  event.preventDefault();
  const command = byId('console-command').value.trim();
  if (!command) return;
  const button = byId('console-send');
  button.disabled = true;
  try {
    await panelApi('/api/game/command', { method: 'POST', body: JSON.stringify({ command }) });
    byId('console-command').value = '';
    panelToast('命令已发送');
    setTimeout(() => refreshGame(), 600);
  } catch (error) { panelToast(error.message, true); }
  finally { button.disabled = false; }
});
byId('player-search').addEventListener('input', () => {
  clearTimeout(playerSearchTimer);
  playerSearchTimer = setTimeout(() => refreshPlayerRecords().catch(error => panelToast(error.message, true)), 250);
});
byId('player-profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!selectedPlayerId || !window.panelCan('players.manage')) return;
  const button = byId('player-profile-save');
  button.disabled = true;
  try {
    const result = await panelApi('/api/player/profile', { method: 'POST', body: JSON.stringify({
      steam64: selectedPlayerId, playMinutes: Number(byId('player-minutes').value),
    }) });
    selectedPlayer = result.player;
    panelToast('累计时长已保存到面板');
    await refreshPlayerRecords();
  } catch (error) { panelToast(error.message, true); }
  finally { button.disabled = false; }
});
byId('player-level-save').addEventListener('click', async () => {
  if (!selectedPlayerId || !levelRevision || !window.panelCan('players.manage')) return;
  const playerId = selectedPlayerId;
  const button = byId('player-level-save');
  button.disabled = true;
  try {
    const result = await panelApi('/api/player/level', { method: 'POST', body: JSON.stringify({
      steam64: playerId, level: Number(byId('player-level').value), revision: levelRevision,
    }) });
    if (selectedPlayerId !== playerId) return;
    levelRevision = result.revision;
    byId('player-level-status').textContent = result.pending
      ? `等级 ${result.level} 已排队，本回合结束后自动写入并重启游戏。`
      : `已写入插件等级 ${result.level}。启动游戏后生效。`;
    panelToast(result.pending ? '等级已保存；本回合结束后自动生效' : '游戏等级已保存；启动游戏后生效');
    await refreshPlayerRecords();
  } catch (error) { panelToast(error.message, true); byId('player-level-status').textContent = error.message; }
  finally { if (selectedPlayerId === playerId) button.disabled = gameMode === 'external' || !levelRevision; }
});
byId('player-badge-save').addEventListener('click', async () => {
  if (!selectedPlayerId || !badgeRevision || !window.panelCan('players.manage')) return;
  const playerId = selectedPlayerId;
  const button = byId('player-badge-save');
  button.disabled = true;
  try {
    const result = await panelApi('/api/player/badge', { method: 'POST', body: JSON.stringify({
      steam64: playerId, name: byId('player-tag').value, color: byId('player-badge-color').value, revision: badgeRevision,
    }) });
    if (selectedPlayerId !== playerId) return;
    badgeRevision = result.revision;
    byId('player-badge-status').textContent = result.pending
      ? `标签修改已排队：${result.name || '移除'} · ${result.color}。本回合结束后自动生效。`
      : result.name ? `已写入插件标签：${result.name} · 颜色：${result.color}。重启游戏后生效。` : '已移除插件标签，重启游戏后生效。';
    panelToast(result.pending ? '标签已保存；本回合结束后自动生效' : '游戏标签已保存；重启游戏后生效');
    await refreshPlayerRecords();
  } catch (error) { panelToast(error.message, true); byId('player-badge-status').textContent = error.message; }
  finally { if (selectedPlayerId === playerId) button.disabled = gameMode === 'external' || !badgeRevision; }
});
byId('player-admin-save').addEventListener('click', async () => {
  if (!selectedPlayerId || !window.panelUser?.owner || !remoteAdminRevision) return;
  const button = byId('player-admin-save');
  button.disabled = true;
  try {
    const result = await panelApi('/api/player/admin', { method: 'POST', body: JSON.stringify({
      steam64: selectedPlayerId, group: byId('player-admin-group').value, revision: remoteAdminRevision,
    }) });
    remoteAdminRevision = result.revision;
    byId('player-admin-status').textContent = `已保存：${result.group || '普通玩家'}。请在游戏内重新登录后确认权限。`;
    panelToast('游戏管理员组已保存，原配置已备份');
  } catch (error) { panelToast(error.message, true); byId('player-admin-status').textContent = error.message; }
  finally { button.disabled = false; }
});
byId('panel-update-form').addEventListener('submit', async event => {
  event.preventDefault();
  const file = byId('panel-update-file').files[0];
  if (!file || !/\.zip$/i.test(file.name)) return panelToast('请选择 .zip 更新包', true);
  if (file.size > 8 * 1024 * 1024) return panelToast('更新包不能超过 8 MB', true);
  if (!confirm(`确认安装面板更新包 ${file.name}？安装后面板会短暂断开并自动重启。`)) return;
  const button = byId('panel-update');
  button.disabled = true;
  try {
    const result = await panelApi('/api/panel/update', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    panelToast(`已安装 v${result.version}，面板正在重启；请稍后刷新页面`);
    setTimeout(() => window.location.reload(), 5000);
  } catch (error) { panelToast(error.message, true); button.disabled = false; }
});
byId('plugin-upload-form').addEventListener('submit', async event => {
  event.preventDefault();
  const file = byId('plugin-file').files[0];
  if (!file) return;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.dll$/i.test(file.name) || file.name.includes('..')) return panelToast('请选择文件名安全的 .dll 文件', true);
  if (file.size > 32 * 1024 * 1024) return panelToast('插件不能超过 32 MB', true);
  const kind = byId('plugin-kind').value;
  const existing = pluginRows.find(item => item.kind === kind && item.name.toLowerCase() === file.name.toLowerCase());
  let replace = false;
  if (existing) {
    if (!existing.enabled) return panelToast('同名插件当前已停用，请先启用后再替换', true);
    replace = confirm(`同名插件 ${file.name} 已存在。确认备份旧文件并替换？`);
    if (!replace) return;
  }
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  try {
    await panelApi(`/api/plugins/upload?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(file.name)}&replace=${replace}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
    });
    panelToast('插件上传成功；重启游戏服务后生效');
    byId('plugin-file').value = '';
    await refreshPlugins();
  } catch (error) { panelToast(error.message, true); }
  finally { button.disabled = false; }
});

window.addEventListener('panel-login', () => {
  applyAccess();
});
setInterval(() => {
  if (byId('app').hidden) return;
  if (activeView === 'dashboard') refreshGame();
  if (activeView === 'players') refreshPlayerRecords();
  if (activeView === 'game_admin') refreshGameAdminLogs();
}, 8000);
