'use strict';

// A conservative line editor: only simple key/value scalars are changed. All other
// text, including comments, whitespace, line endings and YAML collections, stays put.
const ConfigEditor = (() => {
  const descriptions = {
    server_name: ['服务器名称', '显示在服务器列表中的名称', '基本设置'],
    player_list_title: ['玩家列表标题', '玩家列表中显示的标题', '基本设置'],
    player_list_title_rate: ['玩家列表标题刷新间隔', '单位：秒', '基本设置'],
    serverinfo_pastebin_id: ['服务器介绍 Pastebin ID', '服务器列表介绍所用的 Pastebin ID', '基本设置'],
    server_ip: ['服务器公网 IP', '公布到服务器列表的地址；自动检测时保持原值', '基本设置'],
    max_players: ['最大玩家数', '允许同时加入的人数', '基本设置'],
    server_tickrate: ['服务器刷新率', '每秒处理次数', '基本设置'],
    use_reserved_slots: ['启用预留位置', '是否启用保留给指定玩家的位置', '基本设置'],
    lobby_waiting_time: ['大厅等待时间', '等待玩家界面的时长，单位：秒', '基本设置'],
    ipv4_bind_ip: ['IPv4 监听地址', '通常保持 0.0.0.0', '网络设置'],
    ipv6_bind_ip: ['IPv6 监听地址', '通常保持原值', '网络设置'],
    contact_email: ['联系邮箱', '服务器管理者的联系邮箱', '基本设置'],
    custom_whitelist: ['自定义白名单', '', '网络与安全'],
    server_access_restriction: ['服务器访问限制', '', '网络与安全'],
    transparently_modded_server: ['公开标记为修改版服务器', '请按游戏社区服务器规则设置', '基本设置'],
    use_native_sockets: ['使用原生网络套接字', '', '网络设置'],
    friendly_fire: ['允许队友伤害', '玩家能否伤害同阵营队友', '游戏玩法'],
    friendly_fire_multiplier: ['队友伤害倍率', '队友伤害使用的倍率', '游戏玩法'],
    auto_round_restart_time: ['回合结束后重开时间', '单位：秒', '游戏玩法'],
    intercom_cooldown: ['广播室冷却时间', '单位：秒', '游戏玩法'],
    intercom_max_speech_time: ['广播室最长发言时间', '单位：秒', '游戏玩法'],
    map_seed: ['地图种子', '控制地图生成；-1 通常表示随机', '游戏玩法'],
    late_join_time: ['中途加入时限', '回合开始后允许补入的时长，单位：秒', '玩家与复活'],
    minimum_mtf_time_to_spawn: ['九尾狐最早增援时间', '单位：秒', '玩家与复活'],
    maximum_mtf_time_to_spawn: ['九尾狐最晚增援时间', '单位：秒', '玩家与复活'],
    maximum_mtf_respawn_amount: ['九尾狐单次最大增援人数', '', '玩家与复活'],
    maximum_ci_respawn_amount: ['混沌分裂者单次最大增援人数', '', '玩家与复活'],
    priority_mtf_respawn: ['优先九尾狐增援', '', '玩家与复活'],
    team_respawn_queue: ['队伍增援队列', '请按原文件格式填写', '玩家与复活'],
    respawn_tickets_enable: ['启用增援票数', '控制增援队伍的票数系统', '玩家与复活'],
    respawn_tickets_mtf_initial_count: ['九尾狐初始票数', '', '玩家与复活'],
    respawn_tickets_ci_initial_count: ['混沌分裂者初始票数', '', '玩家与复活'],
    player_info_range: ['玩家信息显示距离', '', '玩家与复活'],
    stamina_balance_use: ['冲刺体力消耗', '每秒消耗比例', '游戏玩法'],
    stamina_balance_immunity: ['出生后体力免消耗时间', '单位：秒', '游戏玩法'],
    stamina_balance_regen_cd: ['体力恢复等待时间', '停止冲刺后开始恢复的等待时长，单位：秒', '游戏玩法'],
    stamina_balance_regen_speed: ['体力恢复速度', '相对于默认值的倍率', '游戏玩法'],
    afk_time: ['挂机踢出时间', '玩家多久无操作后踢出，单位：秒', '玩家与复活'],
    constantly_check_afk: ['持续检测挂机', '', '玩家与复活'],
    afk_kick_message: ['挂机踢出提示', '玩家因挂机被踢出时显示', '玩家与复活'],
    spawn_protect_enabled: ['启用出生保护', '', '玩家与复活'],
    spawn_protect_time: ['出生保护时长', '单位：秒', '玩家与复活'],
    spawn_protect_can_shoot: ['持枪时取消出生保护', '', '玩家与复活'],
    spawn_protect_prevent_all: ['出生保护阻止全部伤害', '', '玩家与复活'],
    warhead_tminus_start_duration: ['核弹启动倒计时', '单位：秒', '游戏玩法'],
    lock_gates_on_countdown: ['倒计时期间锁定大门', '', '游戏玩法'],
    isolate_zones_on_countdown: ['倒计时期间隔离区域', '', '游戏玩法'],
    open_doors_on_countdown: ['倒计时期间打开门', '', '游戏玩法'],
    keep_items_after_escaping: ['逃脱后保留物品', '', '游戏玩法'],
    allow_playing_as_tutorial: ['允许使用教学角色', '', '游戏玩法'],
    disable_decontamination: ['关闭轻收容区净化', '', '游戏玩法'],
    allow_disarmed_interaction: ['允许被缴械玩家交互', '', '游戏玩法'],
    sinkhole_spawn_chance: ['陷坑生成概率', '', '游戏玩法'],
    disconnect_drop: ['断线时掉落物品', '', '游戏玩法'],
    end_round_on_one_player: ['仅剩一人时结束回合', '', '游戏玩法'],
    cuffed_escapee_change_team: ['被铐逃脱者更换阵营', '', '游戏玩法'],
    pd_exit_count: ['口袋空间出口数', '', '游戏玩法'],
    auto_warhead_start_minutes: ['自动核弹倒计时', '单位：分钟', '游戏玩法'],
    auto_warhead_lock: ['锁定自动核弹', '是否阻止取消自动核弹', '游戏玩法'],
    auto_warhead_broadcast_enabled: ['自动核弹广播', '', '游戏玩法'],
    auto_warhead_broadcast_message: ['自动核弹广播内容', '', '游戏玩法'],
    auto_warhead_broadcast_time: ['自动核弹广播时长', '单位：秒', '游戏玩法'],
    auto_decon_broadcast_enabled: ['自动净化广播', '', '游戏玩法'],
    auto_decon_broadcast_message: ['自动净化广播内容', '', '游戏玩法'],
    auto_decon_broadcast_time: ['自动净化广播时长', '单位：秒', '游戏玩法'],
    dms_enabled: ['启用末日开关', '', '游戏玩法'],
    dms_activation_time: ['末日开关触发时间', '单位：秒', '游戏玩法'],
    save_metrics: ['保存游戏统计数据', '在本机保存用于平衡分析的数据', '基本设置'],
    online_mode: ['启用在线模式', '控制与中央服务器的连接', '网络与安全'],
    ip_banning: ['启用 IP 封禁', '', '网络与安全'],
    enable_whitelist: ['启用白名单', '仅允许白名单玩家加入', '网络与安全'],
    enable_query: ['启用查询协议', '', '网络与安全'],
    query_port_shift: ['查询端口偏移', '相对于游戏端口的偏移量', '网络与安全'],
    forward_ports: ['自动转发端口', '需路由器支持 UPnP', '网络与安全'],
    query_administrator_password: ['查询协议管理员密码', '敏感设置，请妥善保管', '网络与安全'],
    enable_ip_ratelimit: ['限制同一 IP 的连接频率', '', '网络与安全'],
    enable_userid_ratelimit: ['限制同一玩家账号的连接频率', '', '网络与安全'],
    ip_ratelimit_window: ['同一 IP 连接间隔', '单位：秒', '网络与安全'],
    userid_ratelimit_window: ['同一账号连接间隔', '单位：秒', '网络与安全'],
    enforce_same_ip: ['验证连接与认证 IP 一致', '', '网络与安全'],
    enforce_same_asn: ['验证连接与认证运营商一致', '', '网络与安全'],
    anticheat_console_output: ['在控制台显示反作弊信息', '', '网络与安全'],
    same_account_joining: ['允许同一账号重复加入', '', '网络与安全'],
    enable_fast_round_restart: ['快速重开回合', '', '游戏玩法'],
    restart_after_rounds: ['自动重启回合数', '0 表示关闭', '游戏玩法'],
    full_restart_rejoin_time: ['完整重启后的重新连接时间', '单位：秒', '游戏玩法'],
    geoblocking_mode: ['地区限制模式', '', '网络与安全'],
    geoblocking_ignore_whitelisted: ['地区限制放行白名单玩家', '', '网络与安全'],
    report_send_using_discord_webhook: ['通过 Discord Webhook 发送玩家举报', '', '玩家举报'],
    report_discord_webhook_url: ['玩家举报 Webhook 地址', '敏感设置，请勿分享', '玩家举报'],
    report_username: ['玩家举报发送者名称', '', '玩家举报'],
    report_server_name: ['玩家举报中的服务器名称', '', '玩家举报'],
    report_header: ['玩家举报标题', '', '玩家举报'],
    report_content: ['玩家举报内容', '', '玩家举报'],
    enable_predefined_ban_templates: ['启用预设封禁模板', '', '管理员权限'],
    is_enabled: ['启用插件', '插件是否加载', '插件设置'],
    enabled: ['启用功能', '', '插件设置'],
    debug: ['调试日志', '记录更多调试信息', '插件设置'],
    show_debug_messages: ['显示调试消息', '', '插件设置'],
    language: ['语言', '', '插件设置'],
    prefix: ['消息前缀', '', '插件设置'],
    command: ['命令', '', '插件设置'],
    cooldown: ['冷却时间', '请查看插件说明确认单位', '插件设置'],
  };

  function description(key, fileId) {
    const known = descriptions[key.toLowerCase()];
    if (known) return { label: known[0], help: known[1], group: known[2], known: true };
    if (/_badge$/i.test(key)) return { label: '管理员身份标识', help: '游戏中显示的身份文字', group: '管理员权限', known: true };
    if (/_color$/i.test(key)) return { label: '管理员身份颜色', help: '请使用游戏支持的颜色名', group: '管理员权限', known: true };
    if (/_kick_power$/i.test(key)) return { label: '踢出权限等级', help: '数值越大权限越高', group: '管理员权限', known: true };
    if (/_required_kick_power$/i.test(key)) return { label: '被踢出所需权限等级', help: '', group: '管理员权限', known: true };
    return {
      label: fileId?.startsWith('game:') ? '其他游戏设置' : '插件自定义设置',
      help: '此项没有可靠的中文说明，请对照下方原始键名和插件文档修改。',
      group: '其他配置', known: false,
    };
  }

  function splitLines(content) {
    const lines = [];
    const expression = /([^\r\n]*)(\r\n|\n|\r|$)/g;
    let match;
    while ((match = expression.exec(content)) && match[0]) lines.push({ text: match[1], ending: match[2] });
    return lines;
  }

  function inlineComment(value) {
    let quote = '';
    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      if (quote) {
        if (char === '\\') { i++; continue; }
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '#' && (i === 0 || /\s/.test(value[i - 1]))) return i;
    }
    return -1;
  }

  function hasUnsupportedEscape(value) {
    for (let i = 0; i < value.length; i++) {
      if (value[i] !== '\\') continue;
      if (value[i + 1] !== '"' && value[i + 1] !== '\\') return true;
      i++;
    }
    return false;
  }

  function parse(content, fileId = '') {
    const lines = splitLines(content);
    const entries = [];
    const groups = [];
    let skipped = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].text;
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const match = /^(\s*)([A-Za-z0-9_.-]+)(\s*:\s*)(.*)$/.exec(line);
      if (!match) { skipped++; continue; }
      const indent = match[1].replace(/\t/g, '    ').length;
      while (groups.length && groups.at(-1).indent >= indent) groups.pop();
      const raw = match[4];
      const commentAt = inlineComment(raw);
      const valuePart = commentAt < 0 ? raw : raw.slice(0, commentAt);
      const value = valuePart.trim();
      const next = lines.slice(i + 1).find(item => item.text.trim() && !/^\s*#/.test(item.text));
      const nextIndent = next ? next.text.match(/^\s*/)[0].replace(/\t/g, '    ').length : -1;
      if (!value && nextIndent > indent) { groups.push({ indent, key: match[2] }); continue; }
      if (/^(?:[|>][+-]?|[\[{!&*])/.test(value)) { skipped++; continue; }
      if ((fileId.startsWith('exiled:') || fileId.startsWith('labapi:')) && !match[3].includes(':')) { skipped++; continue; }
      const leading = valuePart.match(/^\s*/)[0];
      const trailing = valuePart.slice(leading.length).match(/\s*$/)[0];
      const prefix = match[1] + match[2] + match[3] + leading;
      const suffix = trailing + (commentAt < 0 ? '' : (trailing ? '' : ' ') + raw.slice(commentAt));
      const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0] ? value[0] : '';
      if (quoted === '"' && hasUnsupportedEscape(value.slice(1, -1))) { skipped++; continue; }
      const display = quoted ? value.slice(1, -1).replace(quoted === '"' ? /\\(["\\])/g : /''/g, quoted === '"' ? '$1' : "'") : value;
      const parent = groups.map(item => item.key).join(' / ');
      entries.push({ line: i, key: match[2], parent, path: [...groups.map(item => item.key), match[2]].join('.'), value: display,
        rawValue: value, type: /^(?:true|false)$/i.test(value) ? 'boolean' : /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) ? 'number' : 'text',
        prefix, suffix, quote: quoted, ...description(match[2], fileId) });
    }
    return { entries, skipped };
  }

  function replace(content, fileId, lineNumber, key, newValue) {
    if (typeof newValue !== 'string' || /[\r\n]/.test(newValue)) throw new Error('表单值不能换行；请用原文编辑处理多行配置。');
    const lines = splitLines(content);
    const entry = parse(content, fileId).entries.find(item => item.line === lineNumber && item.key === key);
    if (!entry) throw new Error('配置项已变化，请重新打开文件。');
    if (entry.type === 'boolean' && !['true', 'false'].includes(newValue)) throw new Error('请选择“是”或“否”。');
    if (entry.type === 'number' && !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(newValue)) throw new Error('请输入有效数字。');
    let serialized = newValue;
    if (entry.quote === '"') serialized = '"' + newValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    else if (entry.quote === "'") serialized = "'" + newValue.replace(/'/g, "''") + "'";
    else if ((fileId.startsWith('exiled:') || fileId.startsWith('labapi:')) && entry.type === 'text' &&
      (newValue === '' || newValue !== newValue.trim() || /\s#|:\s|^[\[{!&*#>|%@`'"-]|^(?:true|false|null|~|-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/i.test(newValue))) {
      serialized = '"' + newValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    }
    lines[lineNumber].text = entry.prefix + serialized + entry.suffix;
    return lines.map(item => item.text + item.ending).join('');
  }

  return { parse, replace };
})();

if (typeof module !== 'undefined') module.exports = ConfigEditor;
if (typeof window !== 'undefined') window.ConfigEditor = ConfigEditor;
