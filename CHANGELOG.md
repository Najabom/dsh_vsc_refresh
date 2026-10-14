# Changelog

All notable changes to **dsh-vsc (DSH Bridge)**.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- _(nothing yet)_

## [1.1.0] - 2026-10-14

- **外部文件改动追踪**：任务运行期间，工作区文件监控会捕获 shell 命令等外部写入
  （如 `pwsh` 写文件）——变化文件计入改动徽章（`reviewChanges` 列表）并自动在
  编辑器跟随打开（预览标签、不抢焦点、定位首个改动行）；过滤 `.git`、
  `node_modules`、`.pio` 等目录与工作区外路径，与文件工具的批次合并去重。
- **API 与自定义供应商**（设置页新增「API」标签）：三态密钥管理（环境变量来源只读、
  DSH 凭据存储可写入/撤销）；一键创建自定义供应商（路由 ID、显示名、协议、
  baseURL、模型列表 + 《发现模型》自动拉取）；保存后立即出现在会话模型目录。
  管理算法镜像官方「模型」设置页（apiKeyEnv 解析、派生引用、冲突保护）。
- **问题对话窗口（Ask 专属会话）**：每个工作区一个持久映射的专属「问题对话」；
  「选中代码就问」在编辑器侧边新列分屏打开该会话窗口（隐藏会话选择器/工作区条/
  工具按钮的简洁模式），询问卡片、意图选择与回答全在其中；该工作区的后续询问
  复用同一对话；侧边栏自动打开时会跳过问题对话，不会再混入编码会话。
- 内置渠道行的密钥管理按“仅已声明的路由”过滤目录噪声（官方同款 40+ 路由
  目录不刷屏）。
- 新建供应商提供常用预设下拉（OpenAI / Anthropic / DeepSeek / Ollama（本地））：
  选中即自动填好路由、协议与端点；仅选择「自定义…」时才展开完整配置。
- **内嵌工具调用显示**：`run_code` 程序里的嵌套调用（`pwsh`、`read`、`write` 等）
  现在以缩进的 `↳` 子卡片实时出现在转录里（参数、结果、错误点、运行计时），与
  父级 `run_code` 卡片同组；历史页同样渲染——shell 命令做了什么一目了然。
- **计划只读的手动降级**：计划+强制只读期间手动切换权限（如改为工作区可写入）
  时自动降级为软引导，退出计划模式不再恢复陈旧预设。
- 问题对话窗口标题简化为「问题对话」。
- **问题对话会话钉名**：每个工作区的提问会话经官方 `session/rename` 把标题恒定
  为「问题对话」（用户归属标题，自动生成不再覆盖）；此前自动生成的标题会在下次
  提问时被重新钉回。窗口内补齐 ➤ 发送与运行中的 ✕ 停止按钮（此前整组控件被隐藏）。
- 修复：无限滚动预插更早历史时，若工具组的首卡变化导致组容器重建，已复用的
  组内卡片会被旧容器一并移除、从视图消失——现在自动归位到新容器。
- **问题对话按工作区严格隔离**：映射指向的会话若属于其他工作区（或已失效）则
  自动新建；无编辑器文件夹上下文时回退到当前窗口的首个工作区根，避免不同工作区
  共用同一提问会话。
- **问题对话跟随“当前工作区”**：以面板「工作区」按钮选择的项目文件夹为准
  （而非编辑器文件所在文件夹），当前工作区没有提问对话时自动创建；选择的工作区
  现在跨窗口重载保持，工作区条、新会话与问题对话从此对齐同一路径。
- 思考强度按钮文字改为紫色。
- **问题对话窗口宽度对齐**：窗口打开后自动按侧边栏宽度调整分屏比例（以面板自测
  宽度为准，一次性调整；多编辑列布局时不打扰）。
- **会话选择栏实时刷新**：`api-session` 事件去抖驱动列表重取——问题对话、新建
  会话及其运行圆点/时间在侧边栏即时出现，不再需要重载窗口（只刷新列表层，
  转录滚动不受影响）。
- 修复：新建会话「＋」模式菜单的悬停提示浮层会盖在菜单行文字上——出现文本光标
  且点击落不到菜单行（提示闪烁）——提示层改为不接收鼠标事件（纯悬停显示）。

## [1.0.2] - 2026-10-14

- **计划模式**：权限按钮右侧新增计划开关，三种状态——**计划（软引导）**、
  **计划 + 强制只读**（进入时把会话权限锁为仅可查看，退出时恢复此前预设）、
  退出恢复默认执行。按钮实时反映 DSH 的计划投影（排队切换显示待生效态）。
- **计划评审卡片**：计划评审题按标记语言渲染为可滚动卡片（标题/列表/代码/
  引用），选项汉化为**批准并退出计划模式** / **继续规划**；回传值保持原文，
  不影响 DSH 的审批校验。
- **题卡取消修复**：取消会提交一整批**跳过**答案（官方跳过语义，空选择、无
  自定义）——此前只做本地隐藏，问题永远悬空、agent 卡死，之后发送的消息排队后
  无法继续；改用拒绝（`ASK_CANCELLED`）后模型又会把问题当作没送达重问一遍，
  故按官方「用户已看过并跳过」的语义上送。
- **计划按钮过渡修复**：通过题卡批准退出计划模式时，按钮也会先显示虚线「待生效」
  态（与菜单切换一致），投影落地后正常落定。
- **任务清单转录卡片**：`todo_write` 的每次快照在对话里保留一张可展开卡片
  （✓/●/○ + n/m 进度），底部任务栏每轮清空后仍可回看历史任务。
- **账户余额显示**：计划按钮右侧新增余额文字（`deepseek-account` 渠道钱包，
  人民币优先、按官方口径两位截断显示；纯文字只读展示，略微加粗、不可点击；
  悬停看赠金明细；每轮结束自动更新；打开面板（含冷启动、侧边栏重新可见）时先
  拉取一次再显示）。

## [1.0.1] - 2026-10-13

- Docs: README（中/英）、docs/design.md、llms.txt 按现状全量重写；README 截图
  区换成 7 张 v1.0.0 新 UI 实拍（旧图已删除）。
- **Ask 流程本地化**：命令标题与右键菜单改用 `package.nls`，跟随 VS Code 显示
  语言（中文界面显示「DSH: 询问选中内容」等；英文界面显示英文）；配置项描述
  （4 项）同步本地化；面板 Ask 卡片标题「✎ 询问 DSH」。
- **状态行精简**：移除运行中总结区顶部的独立「读秒 + 首 token」行；实时 tok/s
  与全部统计保持在总结行内。

## [1.0.0] - 2026-10-12

**首个正式版本** —— 版本号由 0.3.21 重置为 1.0.0，功能与 0.3.21 完全一致。

本版本汇总了自 0.2.7 起 fork 的全部开发：

- **DSH 0.1.7-rc.2+ 协议适配**：typert RPC（`{args}` 信封）、`remote.mux`
  多流事件、waterfall 审批与提问、`session/page` 历史分页、按会话投影
  （模型选择 / 权限预设 / 用量统计）。
- **启动时更新检查**：查询 npm registry，发现新版本时弹窗；升级前做接口
  预检（官方 Release Notes 扫描 + 新版本包内接口核验），预检未通过时警告
  并保留“仍要更新（自检失败自动回滚）”通道；更新后自动重启并验证通信。
- **Windows 沙箱工作区 ACL 自动修复**：打开/切换工作区时自动授予沙箱所需
  目录权限；无法自动修复时提示以管理员身份修复一次（`autoFixWorkspaceAcl`）。
- **跟随 agent 编辑**：DSH 修改文件时自动打开对应文件并把光标定位到首个
  修改行（覆盖直接写入/编辑与 PTC 嵌套调用；`followAgentEdits`）。
- **工作区集成**：harness 默认 cwd 跟随首个 VS Code 文件夹；手动工作区
  选择；会话选择器按工作区分组，工作区条显示当前工作区。
- **面板与交互**：会话永久删除、归档、插件版本豁免与构建批准、“永久允许”
  审批（提升会话权限）、中文右键菜单、每轮摘要标注模型、上下文占用环 +
  实时 tok/s 状态行、统一控件高度、输出着色等。
- **稳定性**：审批应答修复（mux clientId）、工具结果 v4 形状适配、401 与
  离线区分、孤儿 harness 治理、冷启动重试等。

## [0.3.21] - 2026-10-12

- 状态行：上下文占用（环形图 + 百分比）不再单独占行，并入总结行行首，百分比后
  紧跟当前上下文长度（如 `42% · 52.3K`）；运行中的实时进度仍独占上一行。

## [0.3.20] - 2026-10-12

- **权限按钮修复**：切换权限后按钮立即显示新预设（乐观回显，不再依赖投影增量
  的到达时机）；当前值改为按活动会话的投影缓存解析，切换会话不会残留上一会话
  的预设；会话列表快照作为冷启动兜底填充缓存；日志新增权限投影/切换记录。

## [0.3.19] - 2026-10-12

- **底部状态行**：字号加大（11px→13px）；从实时速度起的统计内容（实时速度、
  轮/步、耗时、平均速度、缓存、输入/输出）整体换到第二行显示；状态行变高时
  上方元素自动上移。

## [0.3.18] - 2026-10-12

- 权限按钮（显示当前权限预设）默认用蓝色文字显示。

## [0.3.17] - 2026-10-12

- 「归档」按钮悬浮边框改为黄色（彻底删除按钮保持红色警告色）。

## [0.3.16] - 2026-10-12

- **会话菜单**：当前工作区的会话标题加粗显示；「其他工作区」展开按钮改为正常文字
  颜色（不再用强调蓝）。

## [0.3.15] - 2026-10-12

- **工作区条重排**：「工作区」按钮从头部移入工作区显示行右端（右缘与下方按钮
  列对齐），启动即显示、无需等待 harness 状态；头部空出的宽度让当前会话选择框
  更宽。

## [0.3.14] - 2026-10-12

- **按钮/下拉框高度统一**：面板与设置页的全部按钮、下拉框、单行输入框统一为
  28px 高度（与发送/停止按钮一致）——会话选择器、工作区/设置/新建/归档/
  彻底删除、权限/模型/推理等级选择器、审批与提问卡片按钮、提问分页按钮，
  以及设置页的 select/输入框/保存按钮/标签页/插件与预设行按钮。

## [0.3.13] - 2026-10-12

- **修复更新后的「API 探活失败」误报**：更新到 0.2.0-rc.2 后冷启动需约 45 秒，
  原 30 秒等待超时即立刻判定失败并弹窗（功能实际正常）。现在更新后的重启验证
  分两段等待：启动最长 90 秒（每 10 秒输出进度日志），端口就绪后网关路由仍有
  最多 45 秒重试窗口；「API 拒绝访问」（overlay 不匹配）仍立即判定不重试。

## [0.3.12] - 2026-10-12

- **更新前接口预检**：发现新版本后先做两项检查再弹窗——
  ①官方通告扫描：从 GitHub Releases 拉取 (当前, 最新] 区间的 release notes
  （中文+英文），精确匹配本扩展使用的全部接口标识符（session/*、pluginManager/*、
  approval/request 等 33 项）；
  ②新版本包静态核验：下载新版 `dsh-api-remotes` / `dsh-api-gateway` /
  `dsh-client-connection` 的 npm tarball，内存解压核验全部接口字符串存在。
- **弹窗分级**：预检通过 → 直接提供「立即更新」；预检未通过（接口缺失/通告命中）
  → 提示"先更新 dsh-vsc 插件适配后再升级 DSH"，保留「仍要更新（自检失败自动回滚）」
  逃生选项；预检不可用（断网等）→ 照常弹窗，更新后仍自动验证通信。
- **网络韧性**：GitHub 请求支持 curl.exe 回退（应对 TLS 中间链导致 node fetch
  无法验证证书的 Windows 网络），通告源支持 API → releases.atom 双通道。

## [0.3.11] - 2026-10-12

- **启动时检查 DSH 更新**：每次打开窗口后查询 npm registry，发现有新版本时弹窗
  选择「立即更新 / 暂不更新」（暂不更新会记住该版本，新版本发布后会再询问）。
- **一键更新**：暂停扩展启动的 harness → `npm install -g @deepseek-ai/dsh@latest`
  → 重启 harness → **通信自检**（API 探活 + 一次真实 RPC + WebSocket 事件流重建）。
- **更新后自检失败可一键回滚**：自动重装旧版本、重启并再次自检；非扩展启动的
  运行实例会提示其重启后新版本才生效。

## [0.3.10] - 2026-10-12

- **跟随编辑：自动定位到修改位置**。工具开始前读取文件旧内容、完成后读新内容
  做行级对比，打开文件时把光标落在第一个修改行（新建文件落在文件头）；不再
  只是打开文件顶部。嵌套与直接工具均生效。

## [0.3.9] - 2026-10-12

- **跟随编辑修复（PTC 模式）**：此前只识别 `tool/call`/`tool/result`，而代码执行
  预设（run_code）里的嵌套写文件走 `tool/ptc-dispatch` 事件，导致跟随不生效。
  现在两种事件形状都追踪（嵌套 `tools.write`/`tools.edit` 等成功后同样自动
  打开文件）；无法识别路径的 shell 命令（如 `pwsh Set-Content`）仍除外。

## [0.3.8] - 2026-10-12

- **工作区 ACL 守护**：打开/切换工作区时自动确保 DSH 沙箱所需的目录权限（当前用户完全控制 =
  WRITE_OWNER，沙箱给工作区写 Low 完整性标签所必需）。从其他电脑拷贝来的文件夹往往只给
  “修改”权限，会导致沙箱在启动阶段就失败（`SetNamedSecurityInfoW failed (Win32 5)`、
  `run_code` worker 起不来，连 echo 都跑不了）。现在扩展会在激活、切换工作区、“工作区”按钮
  选目录时静默修复；若目录属于其他身份（需要 UAC），会弹出提示一键“以管理员身份修复”。
  可用 `dshVsc.autoFixWorkspaceAcl` 关闭。

## [0.3.7] - 2026-10-12

- **右键菜单**：面板内右键改为中文自定义菜单（输入框：剪切/复制/粘贴/全选；对话区：复制选中内容/
  复制本条消息/复制整个对话/全选对话），修复默认右键复制无效的问题。
- **元消息过滤**：模型切换通知（model-selection）与审批策略变更通知（user-approval）等系统注入的
  user/message 不再显示为对话。
- **每轮模型标注**：轮次分隔线与总结行显示当轮使用的模型（来自 request/header）。
- 工作区条文字加粗（15px）。
- **输出着色**：工具卡名称按类别着色（执行=琥珀/读=蓝/写=绿/子代理=紫），内联代码沿用 VS Code
  预格式化文本颜色。
- **空工作区留空**：当前工作区没有对话时不再自动打开其他工作区的上一个对话。
- 计时统一保留一位小数（整数显示为 .0s）。

## [0.3.6] - 2026-10-12

代码审查修复批次（P0+P1+P2）：

- **工具结果形状修复**（v4 协议）：`tool/result` 帧的 `message.toolCallId` /
  `message.isError` 现在被正确读取（此前工具卡一直转圈、错误显示为成功、结果
  空白）——覆盖面板渲染、历史分页、diff 提取与「跟随编辑」。
- **WebSocket 运行时兜底**：改用 `ws` 包（宿主 Node 20 无全局 WebSocket），
  修复 VS Code 内置 Node 上事件流完全不可用的问题；流被服务端 `end` 后自动
  重建（follow 流 500ms、基础流触发重连）。
- **401 鉴权区分**：isAlive 改为三态探活；harness 在跑但拒绝鉴权（overlay
  未生效）时不再误判离线——不再触发 EADDRINUSE 自启风暴，只弹一次提示。
- **孤儿 harness 修复**：自启进程退出时只清理自己的句柄；stopHarness 增加
  PID 复用守卫（校验命令行端口），避免误杀或漏杀。
- **插件安装补全**：支持 `approvedBuilds` 流转（安装时被要求构建批准的插件
  现在可在设置页一键批准并重试）；`installBundle` 选项透传。
- **待处理交互不丢失**：切换会话时重新下发该会话未决的审批/提问卡；webview
  重建时路由去重；断连时未决卡自动结算，不再悬挂。
- **其它**：投影更新（token 用量/统计/上下文压力）实时上屏；删除会话时同步
  归档集合、api-session/added 过滤已删除会话；权限选择错误不再被吞；预设
  列表透传 trust/broken；diff 临时目录退出清理；状态栏审查徽章不再被重置；
  删除死代码（pickedFile、queue context 分支、无操作分支、askSelection
  死导出）；apply_patch 归入变更跟踪；大量注释/README/AGENTS.md 文档与
  实际协议对齐。

## [0.3.5] - 2026-10-12

- **审批应答修复**：$events 流从未保存 ready 帧里的 mux clientId，导致所有应答
  被网关拒绝（`api gateway: invalid Remote event result`）。现在正确记录并随
  `$events/result` 上送。
- **永久允许**：沙箱升级类审批卡新增第三个按钮——应答本次并将会话权限提升为
  升级目标模式（如 danger-full-access），同类操作之后不再询问。
- **跟随 agent 编辑**：DSH 通过直接写入/编辑工具改动的文件自动在编辑器打开
  （预览标签、不抢焦点），磁盘实时更新时同步刷新；可用 `dshVsc.followAgentEdits`
  开关。
- **隐藏运行时上下文快照**：每轮自动注入的 "Current runtime context…" 不再渲染
  为用户气泡。
- 工作区条字体加大到 15px。

## [0.3.4] - 2026-10-12

- **Workspace strip**: the current workspace path (VS Code folder, or the folder
  picked with the 工作区 button) now shows in a slim strip above the header.
  Long paths truncate from the head so the leaf folder stays visible; the full
  path lives in the tooltip.

## [0.3.3] - 2026-10-12

- **彻底删除 button** next to 归档: archive-and-hide the session, then remove its
  on-disk history (`~/.dsh/sessions/<cwd>--/<sessionId>`, honoring `DSH_HOME`).
  The harness has no session-delete RPC (only archive/unarchive), so the
  extension deletes the session log the same way a user would — the harness's
  session index reconciles the missing log as a delete. Two-step confirm; the
  running turn is stopped first. Verified against a live harness: the session
  disappears from `session/list` immediately after the directory is removed.

## [0.3.2] - 2026-10-12

- **Plugin version exemptions**: when the harness refuses an install with
  `incompatible-version`, the 插件 tab now names the offending peers and offers
  「授予版本豁免并重试」 — the same flow as `dsh plugin allow-version`
  (`pluginManager/setVersionExemption` with the risk explicitly accepted), then
  retries the install. Granted exemptions are listed with a 撤销 button
  (`pluginManager/listVersionExemptions`).
- **Delete session renamed to 归档**: the button always called
  `workspace/archiveSession`; it now says so. Nothing is hard-deleted.
- **Status bar wraps per item**: the stats line under the composer wraps whole
  chips (never mid-text), at most two rows, then scrolls.

## [0.3.1] - 2026-10-12

- **Session picker grouped by workspace**: the session dropdown lists the
  current editor folder's sessions first; sessions from other folders stay
  collapsed behind "其他工作区（N）" and expand on click (grouped by folder),
  so the open folder's conversations are one click away.

## [0.3.0] - 2026-10-12

- **Workspace follows the editor**: the harness now starts with the open VS
  Code folder as its working directory; sessions created from the web GUI land
  there too, and when the harness has no sessions at all the panel creates one
  in the open folder instead of waiting for a manual pick. A new `工作区`
  button (left of ⚙) opens a folder dialog — the chosen folder backs a fresh
  session and later `＋` sessions.
- Plugin tab: deployment-supplied bundles now read `内置` instead of `未安装`,
  and the tab notes that client-UI bundles (`dsh-drop-caret`,
  `dsh-webview-clipboard`) only render in the web GUI, not in the VS Code panel.

## [0.2.9] - 2026-10-12

- **Bigger composer**: the message box now starts 5 lines tall, grows with the
  text up to 10 lines, then scrolls (sizes derived from the textarea's computed
  line-height/padding, so it stays correct if the font changes).

## [0.2.8] - 2026-10-12

- **Model picker shows the session's real selection**: the composer's model/effort
  buttons now read the `modelSelection` projection (`next ?? lastUsed`) instead of the
  static catalog default — switching models applies on the first click, and changing
  the reasoning effort no longer resets the model back to the default.
- **Model menu provider sections**: the same model id ships under each provider route
  (`deepseek-official` / `deepseek-account`); the popup now renders a section header per
  provider so models no longer look duplicated. Effort entries show their display names.
- **Delete session (删除) works on running sessions**: archives with `stopActivity: true`
  (the harness otherwise refuses an active session); the header button now carries a
  clear 删除 label and a wider, non-wrapping 确认删除 state.
- **Permission switch fixed**: `commands/execute` now sends the descriptor's
  `submittedAttachments` field (the old `images` was rejected with
  `gateway/arguments-invalid`).

## [0.2.7] - 2026-10-11

- **Plugin manager in the settings tab (插件)**: search → install → toggle → remove rides the
  harness's own `pluginManager/*` RPCs (the mechanism behind the web GUI's plugin panel):
  inspect a spec (npm name / path / git / tarball) against a chosen registry, install with live
  `install-state` / `install-log` progress, enable/disable bundles and Loader entries, and
  remove removable bundles.
- **Settings page rebuilt on server rosters**: 默认模型 provider/model/reasoningEffort and
  默认权限 render as dropdowns fed by `session/modelCatalog` + `permissionPresets/catalog`;
  the 模型 tab's `model` field picks from the provider's own model list.
- **Agent presets can be switched**: rows list official copy and a 设为默认 button writes
  `agent-preset-registry.selectedDefault` via `settings/update` (the official client's own
  mechanism; the old dead `agent-presets.default` namespace is gone in 0.1.7).

- **Compatibility: DSH 0.1.7 (`typert` remote gateway).** Rewrote the wire layer: slash
  endpoints (`session/list`, `session/page`, `session/follow`, `session/control`,
  `workspace/follow`, `agentPresets/list`, `permissionPresets/catalog`, …), `payload.args`
  wrapping, and the `/api/remote.mux` stream client ($events emits + approval/question
  waterfalls; answers via `$events/result`).
- Overlay rework: the only delta is now the browser-auth bypass on
  `dsh-client-connection` (0.1.7 requires a launch-token cookie on `/api`); the
  retired apiproxy/subprocess/sandbox deltas were absorbed upstream.
- Session history rides `session/page` (cursor-bounded); todos/permissions/inbox/
  title/model deltas ride `session/control`; archived-session filtering rides
  `workspace/follow`; session creation takes the workspace folder as `cwd`.
- Shutdown: `host.describe`/`clientCount` no longer exist, so an extension-spawned
  harness is always stopped on exit (no orphaned windowless instance).

## [0.2.1] - 2026-08-30

- Docs: design-philosophy deep-dive and index pointer; install-from-Releases-first guidance; version placeholder for vsix filenames.
- Fix: activity-bar container id without a dot; untrusted-workspace support; sidebar focus command.

## [0.2.0] - 2026-08-30

- **Settings panel** + composer layout rework; model / effort split; agent-preset **mode picker**.
- Single-source wire schema (`src/harness/protocol.ts`); drop dead `agentPreset.select`.
- Grafted the official **micromark** markdown engine so GFM renders like the web GUI (headings, italics, strikethrough, tables, block margins).
- **Permission-preset** select (read-only / workspace-write / full-access) via permissions projection + `/permission` command; read `agentPreset.list` by official schema.
- In-panel **Ask card**, approval & question interaction cards, reasoning-effort switch.
- Runtime **in-memory patch loader** replaces disk-patch scripts (overlay).
- CI: auto-build and publish `.vsix` on version tags.

## [0.1.0] - 2026-08-23

- Initial release: DSH in the VS Code sidebar (embedded web GUI) + native bridge.
- Harness lifecycle: discover, reuse-or-auto-start, self-heal, reference-counted shutdown (`clientCount`).
- Native sidebar chat panel: streaming, session picker, queue/steer/edit/copy, task bar (todos projection), slash commands, `@` file-mention picker, per-turn timing, `+N-M` stats, collapsible tool actions.
- Editor bridge: **Ask DSH about selection** (structured context), **Review Agent Changes** (write/edit/str_replace_editor → native git diff).
- Overlay v1: client-count + window/console hiding, guarded by SHA-256 + canary anchors.
