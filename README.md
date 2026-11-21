# SCP:SL 手机管理面板 2.7.9

一个安装在 **Windows 游戏服务器**上的轻量网页面板。用电脑或手机浏览器管理 SCP: Secret Laboratory 配置、EXILED / LabAPI 插件，并通过 LocalAdmin.exe 查看游戏状态、重启和查询玩家。完整包已包含 Node.js 运行环境，不需要另外安装 Node.js 或 npm 依赖。

## 功能

- 自动识别 `%APPDATA%\SCP Secret Laboratory\config\<端口>\config_*.txt`
- 自动识别 `%APPDATA%\EXILED\Configs\*.yml` / `*.yaml`
- 浏览和编辑 EXILED 子目录及 LabAPI `configs` 中的 YAML / TXT 配置
- 配置文件默认显示中文表单，布尔值用“是 / 否”选择；可按中文名称或原始键名搜索
- 在手机上下载服务器当前保存的配置原文件，保留 UTF-8 BOM、换行和注释；下载权限与查看配置权限相同
- 复杂列表、多行文本和未识别的格式可切换到“原文编辑”；表单修改只替换对应值，保留原文件注释和换行
- 从手机上传 EXILED / LabAPI `.dll` 插件及 LabAPI 依赖，启用、停用和替换插件
- 插件列表显示 DLL 自带的文件说明；管理员可以填写中文作用说明，也可以先备份再删除插件
- 在手机上下载服务器当前安装的插件 DLL，已启用和已停用的插件都可下载；下载权限与查看插件权限相同
- 从面板启动 LocalAdmin.exe，查看 Windows CPU / 内存、控制台输出，重启游戏和查询玩家
- 从手机关闭 SCP:SL 游戏服务；关闭命令只作用于面板启动的 LocalAdmin.exe，不会关闭 Windows
- “总控制”可设置无人自动重启时长（默认 1 天，即 1440 分钟；0 为关闭）。游戏由面板启动、在线人数为 0 且达到时长时，面板正常退出并重新启动 LocalAdmin.exe；同一次无人期间只重启一次，有玩家加入后重新计时。运行中可直接修改时长
- 游戏运行时根据 LocalAdmin 的连接、离开日志更新在线玩家，不再每 15 秒自动发送 `players` 命令；仍可手动查询核对。按 Steam64 ID 保存最新名称、最近连接 IP 和首次/最近记录时间；相同 ID 改名或更换 IP 时更新已有记录
- 点击在线或历史玩家即可编辑等级、累计游戏时长、标签和颜色；面板按每名玩家的进服到离服时段累积时长，也可手动修正
- 可在游戏运行时排队修改 PlayerLevels 等级与 PlayerBadge 标签；本回合结束后自动完整重启游戏并写入新值，保存前自动备份
- 主账号或获单独授权的服管理员可以从手机输入 LocalAdmin 单行命令，并查看游戏控制台输出
- 主账号可在玩家资料中选择当前游戏配置已有的 Remote Admin 权限组，自动为 Steam64 ID 写入管理员身份并备份原配置
- 自动识别 LocalAdmin 的 UTF-8 或简体中文 Windows 控制台文字编码；修复玩家名称在输出分段时变成乱码的问题
- 在手机上选择新版面板 ZIP 包安装，自动备份旧代码并重启面板；密码、证书和玩家记录继续保留
- 多账号登录：主账号创建服管理员，自行设置账号名、初始密码和功能权限；可调整权限、重设密码、停用或删除服管理员
- 玩家历史和 IP、控制台记录单独授权；服管理员没有相应权限时，网页和服务器接口均不能读取
- 主账号在“操作记录”页查看账号登录、来源 IP、管理操作、时间和成功/失败结果；记录保存在服务器本地
- “游戏管理记录”独立页面显示游戏内 Remote Admin 操作，标明管理员、操作类型、目标玩家和物品，并保留日志原文；可搜索管理员、玩家或操作
- “玩家”页单独显示在线玩家、历史玩家、玩家搜索与资料编辑
- 密码登录、手机适配、文件搜索、保存冲突提醒
- 每次保存和恢复前备份原文件；网页内可恢复
- 限定配置目录与文件类型，默认只监听服务器本机

## 从 2.1.1 或更早版本更新

1. 在服务器上关闭旧面板启动窗口。游戏的原 LocalAdmin 窗口可以先保持运行。
2. 将更新包内的文件解压到原目录（例如 `D:\SCP-SL-Mobile-Panel`），同名文件选择覆盖。**保留原目录的 `data` 文件夹**，其中有面板密码、证书和备份。
3. 仍用原来的 **`PUBLIC-IP.cmd`** 启动面板。手机刷新原地址即可，面板密码无需重设。
4. 想用手机管理游戏和自动记录玩家时，先在“总控制”页保存 `LocalAdmin.exe` 的绝对路径和真实游戏端口，再在原 LocalAdmin 窗口输入 `exit` 正常关闭游戏，最后点击面板的“启动游戏”。之后请保持面板启动窗口运行。

升级到 2.2.0 后，可在手机面板的“总控制 → 更新手机面板”选择新版**更新包 ZIP**。更新前先关闭由面板启动的游戏服务；上传安装后，面板会自动重启。首次从更早版本升级仍需按上面的覆盖文件步骤，因为旧版没有手机更新入口。

**本次 2.7.9 同时提供完整包和精简更新包。** 已安装 2.7.8 的服务器，可先在面板关闭由它启动的游戏，然后在手机“总控制 → 更新手机面板”上传 `SCP-SL-Mobile-Panel-v2.7.9-update.zip`；面板会保留 `data` 和 `config.ps1`，安装后自动重新启动。全新安装请下载 `SCP-SL-Mobile-Panel-v2.7.9-full.zip`，解压后按下文启动。完整包超过更新接口的 8 MB 限制，不能从手机更新入口上传。

**无人自动重启：** 在“总控制 → 游戏控制”设置 0–1440 分钟并保存，运行中也能更改。默认 1 天；从 2.7.8 升级时，旧设置若为 30 分钟会自动改成 1 天，该版本无法区分原默认值和手动保存的 30 分钟。升级后手动设置的时长会保留，包括手动选择的 30 分钟。面板从 LocalAdmin 的玩家连接与离开日志判断是否有人在线。游戏进入可接待玩家状态且当前无人时开始计时；达到时长后发送 `exit`，等待 LocalAdmin 退出，再由面板重新启动。一次无人时段最多执行一次；玩家加入后重新计时。此功能只控制由面板启动的 SCP:SL 游戏进程，不重启 Windows。若游戏没有输出可识别的离开日志，在线名单可能滞后，可点击“立即查询玩家”校准。

**玩家资料：** 在“玩家 → 已记录玩家”搜索并点击“选择玩家”。游戏由面板管理且正在运行时，等级和标签修改会先保存在 `data/pending-player-edits.json`。面板向游戏发送官方 `stopnextround` 命令；本回合结束、LocalAdmin 完全退出后，面板用最新插件存档应用修改、备份原文件，再自动启动游戏。普通回合重开不保证重新读取插件文件，因此这里安排完整的游戏进程重启。可连续修改多个玩家；同一玩家同一项目的后一次保存会替换前一次待生效值。等级生效时当前经验归零，累计积分保留；标签在玩家重新加入后显示。若应用失败，队列不会被删除，页面会显示错误，可检查后再重启游戏。游戏原窗口运行时无法安排自动重启，需先由面板接管。游戏已停止时直接写入插件文件，启动游戏后生效。该流程依据 [官方 `stopnextround` 命令说明](https://techwiki.scpslgame.com/books/server-guides/page/remote-admin-panel) 和 [LabAPI 插件加载代码](https://github.com/northwood-studios/LabAPI/blob/master/LabApi/Loader/PluginLoader.cs)。

**累计时长：** 面板在收到玩家验证成功日志时开始计时；缺少该日志时，从手动查询首次发现玩家在线时开始。收到离线日志、服务器进入无人在线状态、游戏进程退出，或手动 `players` 查询确认玩家不在名单时结束本次计时。各次进服时长按 Steam64 ID 相加；如果游戏没有输出可识别的离开日志，名单可能暂时保留该玩家，需要手动查询核对。也可手动修正。当前 PlayerLevels 和 PlayerBadge DLL 都没有可编辑的累计时长存档；PlayerLevels 在游戏内显示的游玩时间是当前会话时间，所以修改面板累计时长不会改变游戏内的会话计时。

**插件安装位置：** 你提供的 `PlayerLevels.dll` 和 `LabAPI_PlayerBadge_x64.dll` 都是 LabAPI 插件。可在面板“插件 → 上传插件”中选“LabAPI 插件 · 当前端口”上传两个 DLL，启动游戏一次，让插件生成对应配置。面板使用运行游戏账户下的 `%APPDATA%\SCP Secret Laboratory\LabAPI\configs\<端口>\PlayerLevels\players.txt` 和 `...\Player Badge Plugin\configs.yml`。插件配置目录依据 [LabAPI 官方源码](https://github.com/northwood-studios/LabAPI/blob/master/LabApi/Loader/ConfigurationLoader.cs)的每端口规则。请确认面板与游戏使用同一个 Windows 账户。

完整安装包的 `optional-plugins` 文件夹和单独的 `SCP-SL-Mobile-Panel-v2.6.0-plugins.zip` 中均放有你提供的两个原始 DLL。已有面板更新包只含面板代码；如服务器上还没有这两个插件，请解压插件包并在面板“插件”页分别上传。面板不会自动把 DLL 安装进游戏。

**游戏管理员组：** 主账号选择玩家后，可以从该端口的 `config_remoteadmin.txt` 中已有的组选择权限；选“普通玩家”可移除该 Steam64 ID 的管理员身份。保存前自动备份原文件。此项修改的是 SCP:SL 游戏内 Remote Admin 身份，与网页登录的服管理员账号是两套权限。若配置文件缺失或没有定义组，先启动一次游戏并在游戏配置中建立管理员组。按 [SCP:SL 官方远程管理配置说明](https://techwiki.scpslgame.com/books/server-guides/page/3-remote-admin-config-setup)，Windows 文件位于运行 LocalAdmin 的账户下 `%APPDATA%\SCP Secret Laboratory\config\<端口>\config_remoteadmin.txt`。修改后让玩家重新登录游戏；若未生效，重启游戏服务。

插件页新增“编辑作用”和“删除”；删除会先把 DLL 复制到 `data/plugin-backups/`，再移除原文件。DLL 没有内置说明时，面板会显示“暂无说明”，不会猜测插件功能。管理员写的作用说明保存在 `data/plugin-descriptions/`，会优先显示。

打开“配置文件”页并选择一个文件后，点击“下载文件”，手机浏览器会保存服务器上当前已保存的原文件。若正在编辑而未保存，下载内容不包含这些修改。

打开“插件”页，在目标插件一行点击“下载 DLL”，手机浏览器会保存对应的服务器 DLL 原文件。已停用的插件也会以 `.dll` 文件名下载，方便日后上传复用。

## 主账号与服管理员

旧版的管理员密码会自动成为主账号 `owner` 的密码。升级后登录时账号名填写 `owner`，密码仍用原密码。新安装时首次运行 `START-HERE.cmd` 设置的密码也属于 `owner`。

主账号在“账号管理”页创建服管理员，设置 3–32 位英文字母、数字或下划线的账号名，以及至少 6 位的初始密码。每个账号可勾选查看服务器、控制游戏、输入 LocalAdmin 命令、查看在线玩家、查看玩家历史/IP/控制台、编辑玩家资料、查看/修改配置、查看/管理插件等固定权限。主账号始终拥有全部权限；只有主账号能管理账号、分配游戏内管理员组和安装面板更新。账号权限变化会立即生效；重设密码或停用账号后，已有登录会失效。

主账号可在“账号管理”页修改自己的密码；在服务器上再次运行 `setup.ps1` 也会重设主账号密码，同时保留已有服管理员。账号密码以加盐哈希保存，不在网页显示。

“游戏管理记录”读取当前端口的 `%APPDATA%\SCP Secret Laboratory\ServerLogs\<端口>` 中的 `Remote Admin` 及 `Remote Admin - Misc` 事件，显示游戏日志里的时间、管理员、Steam64 ID、操作类型、目标玩家与原文，并将已识别的记录保存到 `data/game-admin-actions/<端口>.json`。仅主账号可见。旧版已保存的记录会在读取时补充操作分类。游戏没有写入回合日志的操作无法补录；面板和游戏应使用同一个 Windows 账号。若游戏日志使用自定义位置，可设置环境变量 `SCP_PANEL_SERVER_LOGS_ROOT` 指向 `ServerLogs` 目录。管理员名称由日志原文识别，日志没有名称时显示“未识别管理员”。

“面板操作记录”与游戏内记录分开，仅对主账号开放，可按账号、IP 或操作搜索并分页查看。它记录面板登录、账号调整、配置文件查看与修改、插件操作、游戏控制、面板更新和手动查询玩家；玩家资料变更还显示玩家名称、Steam64 ID 和新值。页面自动刷新的服务器状态与玩家列表不会反复写入记录。记录按日期存放在 `data/audit/*.jsonl`。记录不会保存账号密码、会话令牌、上传文件内容或配置正文；控制台命令会保留命令及参数，但消息正文和疑似密码、令牌参数会隐藏。IP 取自面板实际收到的连接；通过 SSH 隧道访问时，通常只能看到隧道的本地地址。控制台命令显示“成功”只表示已交给 LocalAdmin，游戏是否执行请检查控制台输出。

仅覆盖代码文件不会自动接管已经在运行的 LocalAdmin 进程。面板会显示“原窗口运行中”并阻止重复启动，以免争用同一游戏端口。

## 在 Windows 服务器上安装

1. 在 Windows 游戏服务器上下载并解压完整包。建议用**运行 SCP:SL 服务的同一 Windows 账户**登录。
2. 双击 **`START-HERE.cmd`**。首次启动时，按提示设置至少 6 位的管理员密码。之后会自动启动面板。
3. 在服务器本机打开 `http://127.0.0.1:3767`，输入刚设置的密码。要持续使用，保持启动窗口运行。这里的 `127.0.0.1` 指**服务器自身**，不是你的电脑或手机。

再次运行 `setup.ps1` 可更改密码；随后重启面板。`runtime/node.exe` 是随包附带的 Windows x64 Node.js v24.19.0，完整授权见 `runtime/LICENSE`。

## 用手机连接

### 直接通过服务器公网 IP

在 Windows 游戏服务器上双击 **`PUBLIC-IP.cmd`**。首次使用时输入这台服务器的公网 IPv4 地址。脚本会为该 IP 生成 HTTPS 证书、尝试添加 Windows 防火墙入站规则，并启动面板。再次启动时会自动使用已保存的 IP。随后手机打开：

```text
https://<服务器公网IP>:3767
```

服务器的公网 IP 和你电脑的 IP 不同是正常的。面板必须在服务器上运行。雨云的独立 IP 实例无需 NAT 端口映射；如果雨云安全组或云防火墙启用了白名单，请允许入站 **TCP 3767**。脚本只能尝试配置 Windows 防火墙，无法修改雨云控制台设置。

**证书说明：** 一键脚本生成的是自签名证书，手机浏览器首次访问会提示证书不受信任。请先在服务器窗口查看证书指纹，并与手机浏览器显示的指纹核对，再决定是否继续登录。自签名证书无法自动证明服务器身份；长期公网使用建议改用受信任的 IP 证书。证书与受保护的私钥文件保存在 `data/`，请不要分享。

若端口 3767 已被占用，可复制 `config.ps1.example` 为 `config.ps1` 并设置 `SCP_PANEL_PORT`，然后重新启动；手机 URL 的端口也要随之修改。

### 通过 Tailscale

推荐使用 [Tailscale](https://tailscale.com/docs/install/windows)：服务器和手机都安装并登录同一个 Tailscale 网络，在服务器 PowerShell 运行：

```powershell
tailscale serve --bg http://127.0.0.1:3767
```

命令会显示一个 `https://...ts.net` 地址。手机开启 Tailscale 后，用浏览器打开这个地址，再输入面板密码。**不需要开放公网端口，也不需要使用服务器公网 IP。** Tailscale Serve 提供 HTTPS；面板仍只监听本机。

如果已有受信任的 HTTPS 证书和私钥，可设置 `SCP_PANEL_TLS_CERT`、`SCP_PANEL_TLS_KEY`、`SCP_PANEL_BIND=0.0.0.0`，再通过 `START-HERE.cmd` 启动。没有证书时，程序拒绝直接对公网监听。

## 配置文件不显示

SCP:SL 与 EXILED 默认把配置写在**运行游戏的 Windows 账户**的 `%APPDATA%` 下。若面板以另一个账户运行，可在启动前指定绝对路径：

把 `config.ps1.example` 复制为 `config.ps1`，去掉前两行变量前的 `#` 并修改路径，然后重新双击 `START-HERE.cmd`。例如：

```powershell
$env:SCP_PANEL_GAME_ROOT = 'C:\Users\GameUser\AppData\Roaming\SCP Secret Laboratory\config'
$env:SCP_PANEL_EXILED_ROOT = 'C:\Users\GameUser\AppData\Roaming\EXILED\Configs'
$env:SCP_PANEL_LABAPI_CONFIG_ROOT = 'C:\Users\GameUser\AppData\Roaming\SCP Secret Laboratory\LabAPI\configs'
$env:SCP_PANEL_EXILED_PLUGINS_ROOT = 'C:\Users\GameUser\AppData\Roaming\EXILED\Plugins'
$env:SCP_PANEL_LABAPI_ROOT = 'C:\Users\GameUser\AppData\Roaming\SCP Secret Laboratory\LabAPI'
```

其中游戏目录应包含 `7777` 之类的端口文件夹。指定的账户需要对配置文件有读写权限。只有已存在的配置文件会显示；请先启动一次 SCP:SL / EXILED，让它们生成配置。

## 数据与限制

- 主账号和服管理员密码以加盐 PBKDF2 哈希保存到 `data/accounts.json`；旧版的 `data/settings.json` 用于主账号迁移和本机密码重置。备份保存到 `data/backups/`，操作记录保存到 `data/audit/`。玩家的 Steam64 ID、最新名称、最近 IP、等级、累计时长和标签保存到 `data/players.json`。请保管整个 `data` 目录，不要公开分享，更不要把它上传到 GitHub。
- 仅支持 UTF-8、最大 1 MB 的配置文件。原有 UTF-8 BOM 会保留。中文表单仅编辑可安全识别的单行键值；对于不熟悉的插件设置，界面显示原始键名，建议对照插件文档。复杂内容请使用原文编辑。
- 插件上传限制为 32 MB、文件名安全的 Windows PE `.dll`。替换或删除旧版插件前会备份到 `data/plugin-backups/`；停用插件会把扩展名改为 `.dll.disabled`。作用说明来自 DLL 文件属性或管理员填写，不保证插件实际行为与说明一致。不要把不可信插件上传到游戏服务器。
- 插件启停和新增默认在下一次游戏服务启动后生效。部分插件需要额外配置或依赖；LabAPI 插件可选择当前游戏端口或全局目录。
- 游戏控制使用 Northwood LocalAdmin.exe 的标准输入和控制台输出。面板只能重启或关闭由它启动的 LocalAdmin；对原窗口启动的游戏仅显示“原窗口运行中”。玩家页显示控制台玩家命令的原始响应，默认命令为 `players`；如游戏版本不同，可在“高级设置”中调整。自动记录连接 IP 依赖 LocalAdmin 输出包含 IP 的玩家连接日志；面板启动前的历史玩家不会自动补录 IP。
- 控制台输入仅发送单行命令给面板启动的 LocalAdmin。输入 `qqmsg 中文消息` 时，面板会把正文转换成 UTF-8 Base64，并向 LocalAdmin 发送 `qqmsg64`，避免 LocalAdmin 的输入编码破坏中文；服务器需安装支持 `qqmsg64` 的 QqConsoleBridge 插件。其他命令保持原样。主账号或具有“输入 LocalAdmin 控制台命令”权限的账号可使用；操作记录保存命令和参数，但会隐藏消息正文和疑似密码、令牌参数。是否被游戏接受取决于 LocalAdmin 和插件实际支持的命令。
- 手机更新只替换面板代码文件，不会更新 SCP:SL 游戏程序。更新包限 8 MB，安装前检查版本和文件，并把旧代码备份到 `data/panel-update-backups/`。只上传你信任的更新包。
- 面板显示的 CPU / 内存是**整台 Windows 服务器**的指标。游戏是否已完全可加入，需等待 LocalAdmin 控制台出现 `Waiting for players`。
- LocalAdmin.exe 路径和端口保存在 `data/game-control.json`。运行面板的 Windows 账户需能执行游戏程序并访问同一账户的 AppData。
- 若多个管理员同时编辑同一文件，后保存的人会收到冲突提示，需要重新加载。

## 开发验证

在项目目录执行 `.\runtime\node.exe --test`。

参考：[SCP:SL 官方配置路径](https://techwiki.scpslgame.com/books/server-guides/page/2-gameplay-config-setup)、[LocalAdmin](https://github.com/northwood-studios/LocalAdmin-V2)、[EXILED 插件安装](https://github.com/Exiled-Team/EXILED)、[LabAPI](https://github.com/northwood-studios/LabAPI)。
