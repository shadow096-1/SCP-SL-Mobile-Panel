'use strict';

const $ = id => document.getElementById(id);
let files = [];
let current = null;
let original = '';
let revision = '';
let toastTimer;
let editorMode = 'structured';

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
  });
  let data;
  try { data = await response.json(); }
  catch { throw new Error('服务器响应无法读取'); }
  if (!response.ok) {
    if (response.status === 401 && url !== '/api/login') showLogin();
    throw new Error(data.error || `请求失败：${response.status}`);
  }
  return data;
}
window.panelApi = api;
window.panelUser = null;
window.panelCan = permission => {
  const user = window.panelUser;
  if (!user) return false;
  if (user.owner) return true;
  const implied = { 'config.read': 'config.write', 'plugins.read': 'plugins.manage' };
  if (permission === 'players.online' && (user.permissions.includes('players.records') || user.permissions.includes('players.manage'))) return true;
  if (permission === 'players.records' && user.permissions.includes('players.manage')) return true;
  if (permission === 'server.view' && ['server.control', 'server.console', 'players.online', 'players.records', 'players.manage'].some(key => user.permissions.includes(key))) return true;
  return user.permissions.includes(permission) || user.permissions.includes(implied[permission]);
};

function toast(message, bad = false) {
  const box = $('toast');
  box.textContent = message;
  box.classList.toggle('bad', bad);
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), 4200);
}
window.panelToast = toast;

function showLogin() {
  window.panelUser = null;
  $('app').hidden = true;
  $('login').hidden = false;
  $('password').focus();
}

function showApp(user) {
  window.panelUser = user;
  $('login').hidden = true;
  $('app').hidden = false;
  $('password').value = '';
  window.dispatchEvent(new Event('panel-login'));
}

function isDirty() { return current && $('editor').value !== original; }

function updateEditorState() {
  const dirty = Boolean(isDirty());
  $('save').disabled = !dirty || !window.panelCan('config.write');
  $('save-bottom').disabled = !dirty || !window.panelCan('config.write');
  $('change-state').textContent = dirty ? '未保存' : '已同步';
  $('change-state').classList.toggle('dirty', dirty);
  $('char-count').textContent = `${$('editor').value.length.toLocaleString('zh-CN')} 字符`;
}

function setEditorMode(mode) {
  editorMode = mode;
  $('config-fields').hidden = mode !== 'structured';
  $('raw-editor').hidden = mode !== 'raw';
  $('config-search').closest('label').hidden = mode !== 'structured';
  $('structured-mode').classList.toggle('selected', mode === 'structured');
  $('raw-mode').classList.toggle('selected', mode === 'raw');
  if (mode === 'structured') renderConfigFields();
  else $('config-note').textContent = '原始文件模式：可编辑复杂列表、多行文本和未识别的配置项。保存前请检查格式。';
}

function renderConfigFields() {
  if (!current || editorMode !== 'structured') return;
  const parsed = window.ConfigEditor.parse($('editor').value, current.id);
  const filter = $('config-search').value.trim().toLowerCase();
  const visible = parsed.entries.filter(entry => !filter || `${entry.label} ${entry.key} ${entry.path} ${entry.help} ${entry.value}`.toLowerCase().includes(filter));
  const root = $('config-fields');
  root.replaceChildren();
  if (!parsed.entries.length) {
    $('config-note').textContent = '此文件没有可安全识别的单行设置，请切换到“原文编辑”。';
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = '没有可显示的表单项。';
    root.append(empty);
    return;
  }
  $('config-note').textContent = `${parsed.entries.length} 项可在表单中修改${parsed.skipped ? `，另有 ${parsed.skipped} 行复杂内容保留在原文中` : ''}。未知插件设置会显示原始键名。`;
  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = '没有匹配的配置项。';
    root.append(empty);
    return;
  }
  let lastGroup = '';
  for (const entry of visible) {
    const group = entry.parent || entry.group;
    if (group !== lastGroup) {
      const heading = document.createElement('h2');
      heading.className = 'config-group-heading';
      heading.textContent = group;
      root.append(heading);
      lastGroup = group;
    }
    const row = document.createElement('div');
    row.className = 'config-row';
    const detail = document.createElement('div');
    detail.className = 'config-detail';
    const label = document.createElement('label');
    label.className = 'config-label';
    const inputId = `config-input-${entry.line}`;
    label.htmlFor = inputId;
    label.textContent = entry.label;
    const key = document.createElement('small');
    key.className = 'config-key';
    key.textContent = entry.path;
    detail.append(label, key);
    if (entry.help) {
      const help = document.createElement('p');
      help.className = 'config-help';
      help.textContent = entry.help;
      detail.append(help);
    }
    const control = entry.type === 'boolean' ? document.createElement('select') : document.createElement('input');
    control.id = inputId;
    control.className = 'config-control';
    control.disabled = !window.panelCan('config.write');
    if (entry.type === 'boolean') {
      for (const [value, text] of [['true', '是'], ['false', '否']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        control.append(option);
      }
      control.value = entry.rawValue.toLowerCase();
    } else {
      control.type = 'text';
      control.value = entry.value;
      if (entry.type === 'number') control.inputMode = 'decimal';
      control.autocomplete = 'off';
    }
    control.setAttribute('aria-label', `${entry.label} (${entry.path})`);
    control.addEventListener('change', () => {
      try {
        $('editor').value = window.ConfigEditor.replace($('editor').value, current.id, entry.line, entry.key, control.value);
        updateEditorState();
      } catch (error) {
        control.value = entry.type === 'boolean' ? entry.rawValue.toLowerCase() : entry.value;
        toast(error.message, true);
      }
    });
    row.append(detail, control);
    root.append(row);
  }
}

function renderFiles() {
  const list = $('files');
  list.replaceChildren();
  const filter = $('search').value.trim().toLowerCase();
  let previousGroup = '';
  let visible = 0;
  for (const file of files) {
    if (filter && !`${file.group} ${file.name}`.toLowerCase().includes(filter)) continue;
    visible++;
    if (file.group !== previousGroup) {
      const title = document.createElement('p');
      title.className = 'group-title';
      title.textContent = file.group;
      list.append(title);
      previousGroup = file.group;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'file-button' + (current?.id === file.id ? ' active' : '');
    button.title = `${file.group} / ${file.name}`;
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = file.name.endsWith('.txt') ? 'TXT' : 'YML';
    const labels = document.createElement('span');
    labels.className = 'file-labels';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;
    const group = document.createElement('span');
    group.className = 'file-group';
    group.textContent = file.group;
    labels.append(name, group);
    button.append(icon, labels);
    button.addEventListener('click', () => openFile(file));
    list.append(button);
  }
  if (!visible) {
    const note = document.createElement('p');
    note.className = 'sidebar-note';
    note.textContent = filter ? '没有匹配文件。' : '未找到配置文件。请确认面板和游戏使用同一 Windows 账户。';
    list.append(note);
  }
}

async function refreshFiles() {
  if (!window.panelCan('config.read')) return;
  const result = await api('/api/files');
  files = result.files;
  renderFiles();
}

async function openFile(file) {
  if (current?.id === file.id) return;
  if (isDirty() && !confirm('当前修改尚未保存，确定放弃吗？')) return;
  try {
    const data = await api(`/api/file?id=${encodeURIComponent(file.id)}`);
    current = file;
    original = data.content;
    revision = data.revision;
    $('editor').value = data.content;
    $('config-search').value = '';
    $('group-label').textContent = file.group;
    $('file-name').textContent = file.name;
    $('file-hint').textContent = `${file.group} 配置 · 下载的是服务器上已保存的原文件`;
    $('download').href = `/api/file/download?id=${encodeURIComponent(file.id)}`;
    $('download').download = file.name.split('/').at(-1);
    $('empty').hidden = true;
    $('editor-panel').hidden = false;
    updateEditorState();
    setEditorMode(window.ConfigEditor.parse(data.content, file.id).entries.length ? 'structured' : 'raw');
    renderFiles();
  } catch (error) { toast(error.message, true); }
}

async function reloadCurrent() {
  if (!current) return;
  if (isDirty() && !confirm('确定放弃未保存的修改并重新加载吗？')) return;
  try {
    const data = await api(`/api/file?id=${encodeURIComponent(current.id)}`);
    original = data.content;
    revision = data.revision;
    $('editor').value = data.content;
    updateEditorState();
    if (editorMode === 'structured') renderConfigFields();
    toast('已加载服务器上的最新版本');
  } catch (error) { toast(error.message, true); }
}

async function save() {
  if (!window.panelCan('config.write')) return;
  if (!isDirty()) return;
  const content = $('editor').value;
  $('save').disabled = true;
  $('save-bottom').disabled = true;
  try {
    const data = await api('/api/file', { method: 'POST', body: JSON.stringify({ id: current.id, content, revision }) });
    original = content;
    revision = data.revision;
    updateEditorState();
    toast('保存成功，原版本已备份');
  } catch (error) { toast(error.message, true); updateEditorState(); }
}

async function showBackups() {
  if (!current) return;
  try {
    const data = await api(`/api/backups?id=${encodeURIComponent(current.id)}`);
    const list = $('backup-list');
    list.replaceChildren();
    if (!data.backups.length) {
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent = '还没有备份。第一次保存后会自动创建。';
      list.append(note);
    }
    for (const name of data.backups) {
      const row = document.createElement('div');
      row.className = 'backup-row';
      const label = document.createElement('span');
      label.textContent = name.replace('.bak', '').replace(/-[a-f0-9]{8}$/, '').replace('T', ' ');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = '恢复';
      button.hidden = !window.panelCan('config.write');
      button.addEventListener('click', () => restore(name));
      row.append(label, button);
      list.append(row);
    }
    $('backup-dialog').showModal();
  } catch (error) { toast(error.message, true); }
}

async function restore(name) {
  if (!confirm('确定恢复这个备份吗？当前文件也会先备份。未保存的编辑将丢失。')) return;
  try {
    await api('/api/restore', { method: 'POST', body: JSON.stringify({ id: current.id, name, revision }) });
    const data = await api(`/api/file?id=${encodeURIComponent(current.id)}`);
    original = data.content;
    revision = data.revision;
    $('editor').value = data.content;
    updateEditorState();
    if (editorMode === 'structured') renderConfigFields();
    $('backup-dialog').close();
    toast('已恢复备份');
  } catch (error) { toast(error.message, true); }
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('login-error').textContent = '';
  try {
    const result = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('username').value.trim(), password: $('password').value }) });
    showApp(result.user);
    await refreshFiles();
  } catch (error) { $('login-error').textContent = error.message; }
});
$('logout').addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch {} current = null; window.panelUser = null; showLogin(); });
$('refresh').addEventListener('click', () => refreshFiles().catch(error => toast(error.message, true)));
$('search').addEventListener('input', renderFiles);
$('editor').addEventListener('input', updateEditorState);
$('structured-mode').addEventListener('click', () => setEditorMode('structured'));
$('raw-mode').addEventListener('click', () => setEditorMode('raw'));
$('config-search').addEventListener('input', renderConfigFields);
$('save').addEventListener('click', save);
$('save-bottom').addEventListener('click', save);
$('backups').addEventListener('click', showBackups);
$('reload').addEventListener('click', reloadCurrent);
$('download').addEventListener('click', () => { if (isDirty()) toast('下载的是服务器上已保存的文件，不包含当前未保存的修改'); });
$('close-backups').addEventListener('click', () => $('backup-dialog').close());
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); } });
window.addEventListener('beforeunload', event => { if (isDirty()) { event.preventDefault(); event.returnValue = ''; } });

api('/api/session').then(async state => { if (state.authenticated) { showApp(state.user); await refreshFiles(); } else showLogin(); }).catch(error => { showLogin(); toast(error.message, true); });
