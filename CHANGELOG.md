# Changelog

All notable changes to **dsh-vsc (DSH Bridge)**.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.8] - 2026-10-31

### 计划模式可彻底退出

- **计划菜单新增「退出计划模式」**：计划模式下打开底部计划开关的菜单，可直接选择「退出计划模式」（执行官方 `/plan off`），从软引导或强制只读模式一步回到默认执行模式；已退出时该行不再重复提交。计划开关的悬停提示与中英文 README 同步说明退出方式。
- **排队消息按钮中文化**：排队行上的 `steer` / `del` 按钮改为「插入」/「删除」，与面板其它文案保持一致。

## [1.5.7-v2] - 2026-10-31

### 契约 CI 修复 · 旧 DSH 行优雅降级

- **契约检查区分必选/可选接口**：静态接口检查现在只把非 capability 接口的缺失判为失败；能力组（本次新增「排队消息」`session/state`）缺失只记录降级，`scripts/contract-check.mjs` 输出警告而非失败。修复 v1.5.7 在 DSH `0.1.7-rc.2` / `0.2.1-rc.4` 上的 Contract CI 红。
- **「只发排队」在旧版本上优雅降级**：`session/state` 不可用时直接提示改用「一起发送」或升级 DSH，不再先把 `⏳` 标记行排进队列。
- **更新预检**：升级提示会把「该版本不含可选接口（相关功能会降级）」写进风险说明，而不是误报接口断裂。

## [1.5.7] - 2026-10-31

### 计划评审可批准 · 保持计划保留输出 · 排队消息合并发送

- **计划评审卡**：重新提供「**批准并开始执行**」——批准这次评审即退出计划模式，模型从下一步开始执行计划；「**保持计划模式**」保持原有行为（不退出计划模式、不要求模型重新规划），并且计划书不再随弹窗消失，而是以「计划（已保留，未执行）」卡片留在对话里。
- **移除计划菜单里的「退出计划模式」条目**：退出计划模式现在走评审卡的「批准并开始执行」，或随时用 `/plan off`／底部计划开关，避免从菜单误触。
- **排队消息唤醒**：会话空闲但还有排队消息时，点击发送（或按 Enter）只唤醒排队消息，输入框里的文字与附件保持原样。
- **一起发送开关**：当「有排队消息 + 输入框有内容」同时成立时，输入框右下角出现一个小按钮：红色「只发排队」或绿色「一起发送」。绿色会把输入框里的文字和附件与排队消息一起发出。

## [1.5.6] - 2026-10-30

### 计划评审卡：只保留「保持计划模式」

- 计划评审题（`exit_plan_mode`）现在只提供一个按钮「**保持计划模式**」：保留当前计划输出、**不退出计划模式**，也不会要求模型重新规划——模型只问一次；点击后按官方网页的「关闭评审」语义拒绝这次提问（`UserQuestionError / ASK_CANCELLED`），当前回合直接结束，计划模式保持激活。
- 移除「批准并退出计划模式」按钮：要退出计划模式，请用底栏计划开关或 `/plan off`，避免从评审卡误退出。

## [1.5.5] - 2026-10-29

### 团队条目自动隐藏修复 · 更新预检 · 设置页可靠性

- **智能体团队条目自动隐藏修复**：此前只要会话的团队成员名册里还留着已完成/已失败的成员（历史记录），「团队」条目就会一直显示（即使团队已结束、只剩 lead）。现在改为按「是否有进行中的团队工作」判断——存在非 lead 成员处于 running/provisioning、有成员失败、或存在未完成的共享任务时才显示；团队全部结束（仅剩历史名册）后自动隐藏。新增 jsdom 回归测试。
- **更新检查新增「新功能不兼容」预检**：升级 DSH 前，除原有的接口预检（接口 ID 比对）外，还会拉取目标版本 `@deepseek-ai/dsh` 的依赖清单，与插件已知的功能包基线（`src/harness/featureBaseline.ts`，基线 0.2.2-alpha.2，83 个功能包）比对。发现插件尚未适配的新功能包时，升级确认对话框会写明「插件尚未适配的新功能：…，请等待插件更新后再升级」。
- **设置页可靠性**：修复首次打开设置页时偶发「插件列表读取失败」——设置面板先注册消息监听再加载页面，消除丢失首个 `settingsReady` 的竞态。新增连接状态横幅（DSH 未连接/启动中/重连时提示），重连成功后自动重新加载设置数据；插件列表增加「正在读取插件列表…」加载占位；插件列表、API 密钥、预设、工作区、通用设置各 tab 失败时显示行内错误 + 「重试」按钮；插件市场加载失败会释放缓存并显示重试按钮，同时修复市场索引字段不匹配（`{value}`）。
- **日志修复**：DSH 重启后旧会话的 `changes.summary` 请求返回 404（DSH 只在内存中保留变更概要），此前每次打开面板回放历史都会重复打印；现在同一 session+seq 只记录一次并说明属预期。
## [1.5.4] - 2026-10-29

### 底栏：任务条恢复自动隐藏 + 独立团队条目

- 任务条不再常显：当前会话没有待办时自动隐藏（与「命令」「计划」「变更」一致），不再占用输入框上方的空间。
- 智能体团队从任务条中拆出，改为底栏独立的「**团队**」可展开条目：有团队时显示（队长 + 至少一名成员），没有团队或处于 ask 精简界面时自动隐藏；成员与共享任务仍复用 TODO 的 `t-item` 行样式，点击成员仍可直接进入其会话。
- 底栏任务条标题不再附带「· 团队 N」计数。

## [1.5.3] - 2026-10-29

### 底栏常显与余额预警

- 底栏任务条改为常显：没有待办与团队时也显示「☑ 任务」，展开后给出空状态提示，不再因当前会话没有任务/团队而整条消失。
- 新增余额预警设置 `dshVsc.balanceWarningThreshold`（默认 0 = 关闭）：登录 DeepSeek 账户后，人民币余额降到预警线及以下时弹一次 VS Code 通知，附「去充值」按钮直达充值页；余额恢复后重新武装，不会重复弹。DSH 本身不提供余额预警线，该阈值由扩展侧配置。
- 排队条移除 copy 按钮：排队消息与命令通知都不再显示复制按钮。

## [1.5.2] - 2026-10-29

### 底栏措辞与排队条

- 底栏「后台任务」条改名为「**命令**」（`▸ 命令 N`）：它显示的是 AI 执行中的后台
  shell 命令，与「☑ 任务」（待办清单与智能体团队）不再同名；对应通知文案改为
  「命令通知」/「后台命令通知」，运行中命令的停止按钮提示同步更新。
- 修复调整工作区后排队条误显示「插入中」：DSH 在切换工作目录时会注入一条
  「工作目录已变更」的系统用户消息（例如 `d:\...` 规范化成 `D:\...`），此前被
  当成真正的用户插入消息显示。现在排队条只显示真正的用户消息
  （`source.kind === "user"`，与官方网页一致），系统注入通知不再出现；
  `tool-jobs` 完成通知仍按「命令通知」展示。
- 补充回归用例：注入的系统通知不会进入排队条。

## [1.5.1] - 2026-10-29

### 底栏间距修复

- 修复「后台任务（▸ 任务 N）/ 计划 / 变更」卡片贴住输入框：此前只有待办任务条
  （☑ 任务）加了对称内边距，后台任务条的下内边距仍是 0；现在三种底栏卡片统一
  上下对称间距（footer 上内边距 6px，卡片下内边距 6px），无论哪张卡片最后可见，
  任务文字与输入框的上下间距都一致。

## [1.5.0] - 2026-10-29

首个面向公众的版本：从公开的 GitHub Release 安装即可用，不再依赖维护者机器。

### 发行、运行环境与供应商设置

- **运行环境自检卡片**：设置页「通用设置」新增「运行环境」卡片，逐项显示
  Node.js（≥24.9）/ `@deepseek-ai/dsh` / pnpm（≥11）的探测结果与**确切的安装命令**，
  并在托管实例上提供「重启 DSH 服务」（等价命令 `DSH: 重启 DSH 服务`，只重启扩展
  自启的实例；手动启动的 `dsh web` 明确提示由用户自行重启）。**外部依赖一律由用户
  自行安装**：扩展只探测、只如实说明缺什么，绝不下载/代装任何工具。
- **发行身份**：`package.json` 的 publisher 从 `local` 改为 `najabom`，扩展 ID 变为
  `najabom.dsh-vsc`（旧开发版 `local.dsh-vsc` 需先卸载）；README 安装章节已写明。
- **跨平台启动引导**：Node / `@deepseek-ai/dsh` / pnpm 的探测重写为按平台进行
  （PATH、npm 全局前缀、VS Code 自带 Node、macOS/Linux 常见布局），不再写死
  `where.exe`、`C:\Program Files\nodejs`、cmd 脚本等 Windows 专用假设，也不再要求
  注册表里的 `GITHUB_TOKEN`；macOS / Linux 也能自启 harness。新增配置
  `dshVsc.nodePath`、`dshVsc.dshScriptPath`、`dshVsc.pnpmPath`，
  缺依赖时输出通道给出一次可操作的安装指引。
- **pnpm 11+ 是显式环境要求（不代装）**：DSH 插件管理器安装插件需要 pnpm，且检索时调用
  `pnpm view ... --config.fetch-retries=0`——pnpm 9/10 的 `view` 会转调 npm 并拒绝该参数
  （npm `EUNKNOWNCONFIG`），导致检索/安装规划失败。扩展探测 PATH / PNPM_HOME 上
  **版本 ≥ 11** 的 pnpm，缺失或过旧时只给安装指引（`npm i -g pnpm@11` /
  `dshVsc.pnpmPath`），并把用户已装好的 pnpm 注入 harness PATH。实测 pnpm 11.28.9 下
  DSH 插件检索与 `installBundle` 全流程成功；「运行环境」卡片会显示 pnpm 版本并提示
  过旧版本。删除了上一轮设计中的「扩展在自身存储里准备私有 pnpm」行为——外部环境
  诚实写进需求、由用户自己装。
- **第一方伴生插件随包提供**：`dsh-vsc-companion` 始终打包在 VSIX 内（无需外部下载），
  由扩展通过官方插件管理器安装/同步进用户的 DSH profile。
- **扩展自更新加固**：按 `name: dsh-vsc` 动态定位当前运行的扩展（换 publisher 也能用），
  `code` CLI 探测覆盖 Windows / macOS / Linux 及 PATH；GitHub 检查把 403（限流，
  显示重置时间）、404（无 Release）、401（token 失效）与网络错误分开提示，并支持
  可选的 `GITHUB_TOKEN` 提高限额。
- **供应商设置改版**：API 页改为官方「模型」页式的**一个供应商下拉 + 一个 API Key
  输入 + 状态行**（含凭证引用、默认端点与「由 DSH 登录管理 / 已配置 / 未配置 / 只读」
  状态），上方保留已配置供应商摘要；内置目录合并进下拉分组。新建供应商改为
  无预设向导的纯表单（仅「协议」是下拉，路由 ID 即设置项、Key 存 `<ROUTE>_API_KEY`）。
  设置页各标签页渲染加固：单个渲染器异常只显示一行错误，不再整页空白。
- **兼容性**：`TESTED_DSH_MAX` 提升至 `0.2.3`——`0.2.2-alpha.2` 合同检查全绿
  （79 个接口标识全部存在于官方包），维持 `TESTED_DSH_MIN = 0.1.7-rc.2`；
  `docs/compatibility.md` 补充验证区间维护规则、当前 npm dist-tags 与前置条件速查。
- **overlay 完整性表**：按已安装的 `0.2.2-alpha.2` 重新记录
  （`dsh-client-connection/lib/index.js` 的 SHA256 与 `0.2.1-rc.4` 相同，行为无变化），
  `PRISTINE_HOST_VERSION` 与 `scripts/restore-dsh-pristine.ps1` 同步更新。
- **维护脚本跨平台**：`record-pristine` 支持 Windows/POSIX 与 `$DSH_VSC_DSH_ROOT`
  覆盖，并在 `--write` 时**生成**只读的 `restore-dsh-pristine.ps1`（版本与哈希永远
  一致，保留 `-VerifyOnly` 语义）；`verify-sandbox.mjs` 动态解析 node / dsh 安装根 /
  工作区，非 Windows 或 DSH 未带 `dsh-sandbox-windows-acl` 时打印 skipped 并以 0 退出；
  `lifecycle-test.ps1` 参数化（`-RepoRoot` / `-CodeCmd` / `-Vsix` / `-Port` /
  `-TestRoot`，默认从脚本位置推导）并修正「杀掉 harness 后同一窗口自动重生」的过时预期
  （当前契约：重载窗口或 `DSH: 启动 Web Harness` 才恢复）。
- **文档**：README 双语更新环境要求（VS Code ≥1.90、Node ≥24.9、全局 DSH、
  **pnpm 11+（自行安装）**）与安装章节（GitHub Releases / VSIX + SHA256SUMS 校验、
  扩展 ID 变更），新增「常见问题与故障排查」小节；明确外部依赖只探测不代装、
  第一方伴生插件随 VSIX 提供。
- **本地开发自动安装**：新增 `npm run install:local`（构建 + 打包 + 卸载旧开发版 ID +
  `code --install-extension --force`），每次改完代码可一条命令把新构建装进本机 VS Code。
- **CI**：合同矩阵加入 `0.2.2-alpha.2`（当前 alpha 通道）；发布流水线在打包前执行
  `npm run typecheck`，并随 Release 发布 `SHA256SUMS.txt`。

### 账户、团队与工作区

- **DeepSeek 账户登录/退出就在扩展内**：设置页「工作区」标签的账户卡不再只读：未登录时给出「登录 DeepSeek 账户」，点按后通过 `account/startSignIn` 打开浏览器完成授权（回调走 DSH 自身注册的 `/oauth/callback`，扩展不额外起服务），期间显示阶段（等待浏览器 / 交换凭据 / 完成）、可「打开浏览器」重开授权页或「取消」；登录成功后显示昵称、联系方式与账户余额，并提供「退出登录」确认（有正在运行的账户任务时会先提示）。状态来自 `account/getState` / `getProfile` / `getBalance`，登录尝试期间按 1.5s 轮询 `getState`，到期或面板销毁即停。
- **智能体团队并入任务栏**：头部的「团队」按钮与独立团队卡已移除；底部任务栏改用与 TODO 相同的行样式，按「任务 / 成员 / 共享任务」分组——成员行（队长在前，运行中 / 空闲 / 启动中 / 失败、模型、错误明细）、共享任务行（状态标记、负责人、阻塞、写入范围、可展开描述）点击即打开对应会话。未启用 agent team 包时只显示任务，行为与旧版一致。
- **工作区路径输入框恢复主题底色**：设置页「工作区」的绝对路径输入框此前缺少 `type="text"`，未命中主题化输入框样式而显示浏览器默认白底；现已补上，白底问题消失。
- **文档与兼容性**：账户接口纳入既有能力映射与版本告警（`account/*` 失败时照常显示不兼容信息）；README 中英文 / design.md / compatibility.md 同步本版行为。

### 输入区

- **任务栏与输入框间距对称**：折叠态「▸ 任务 N」下边缘到输入框的间距与上边缘对齐——`#todo-bar` 底部内边距由 2px 改为 8px，与「footer 上内边距 6px + 任务栏上内边距 2px」一致。
- **待发送附件贴近输入框**：草稿图片/文件缩略图栏（AttachmentRail）从任务栏之上移到队列行与输入框之间，附件紧贴输入框显示，不再压住任务栏。
- **「计划」按钮改为「计划模式」**：底部按钮文案与菜单、title 一致（激活态显示「计划模式·引导 / 计划模式·只读」）。
- **跟随编辑功能已彻底移除**：上一版把「正在修改的文件」提前到修改开始（`tool/call`）时打开；实际使用中它会在交互时抢开预览标签、打断编辑，反馈后已整体移除——`dshVsc.followAgentEdits` 配置、跟随打开与光标定位、工作区文件监控的跟随逻辑、相关文档与截图一并删除；改动追踪（changes 徽章 / Review Agent Changes）保留。
- **对话区图片读取修复**：DSH 0.2.x 的 `session/attachment` 要求**完整的**附件引用（id、媒体类型、字节数、尺寸全部校验），此前面板只回传 `attachmentId`，导致对话里的图片——用户随消息发送的、工具结果里的、伴生插件截图的——一律显示「🖼 图片读取失败」；现在面板把日志里的完整引用交给宿主、宿主用 `readAttachment` 取字节，旧版宿主仍回退到 id 形式，错误占位仅在真正失败时出现。

### 排队消息

- **排队消息显示附件**：待发送队列行（输入框上方）除文本外，现在渲染随消息附带的图片缩略图与文件标签（名称 + 大小）——与草稿栏、官方网页队列一致；纯附件消息不再显示「(图片)」占位。宿主按 `session/attachment` 用完整 `ImageAttachmentRef` 取回图片字节并转 data URL（有上限缓存、失败只降级不报错），`NativePanelProvider.postQueue` 识别 inbox 内容块的 `attachment` 引用并把附件透传给面板。
- **排队行限高三行**：`.q-item .qtext` 最大高度 4.65em（13px × 1.55 行高 × 3 行），超出在该行内滚动；队列行与队列容器本身不设高度上限，整体布局不变。
- **测试**：新增 `scratch/queue-jsdom.mjs`（18 项断言：缩略图 src/title、文件标签、附件先于文本、纯附件行、三行钳制、CSP data: 图片）；设置页 jsdom 211/211、队列 18/18 均通过。

## [1.4.1] - 2026-10-27

- **诊断导出**：命令「DSH: 导出诊断报告」把扩展/VS Code/系统版本、连接阶段与
  DSH 版本、兼容台账、harness 记录、本窗口心跳与日志尾部打包成 Markdown，
  便于反馈问题（不含任何凭据）。
- **伴生插件防爆**：任务清单投影与页面工具全部改为特性探测 + 逐项 try/catch
  注册；宿主 API 缺失时只关闭对应能力并记录原因，不会再让 harness 启动失败。
- **合同测试入 CI**：每周对固定 DSH 版本（0.1.7-rc.2 / 0.2.2）运行
  `scripts/contract-check.mjs`，任一被扩展使用的接口标识缺失即报红。
- **兼容矩阵文档**：新增 `docs/compatibility.md`（能力 → RPC 映射、已验证版本
  区间、不匹配报告方式），README 双语链接。

## [1.4.0] - 2026-10-27

- **低活性保活**：窗口心跳改为自适应——前台 30 秒、后台 120 秒，焦点变化与会话活动即时补写；
  守卫轮询 20 秒、失联宽限 60 秒（孤儿 harness 清理延迟约 3.5 分钟）。面板存活探针只在
  「可见且窗口聚焦」时每 60 秒一次，失焦/隐藏即静默，聚焦时立即探测并 6 秒内自愈。
  空闲桌面从每分钟十余次磁盘写降到约半次。
- **DSH 版本兼容台账**：每个可选功能（插件页、作业、定时任务、搜索、分叉、账户、高级设置等）
  对应一组 RPC；网关报 not-found / arguments-invalid 时逐项记入兼容台账，面板顶栏与设置页
  用中文如实说明「当前 DSH 版本过高/过低、哪个接口不兼容、服务端原文」——入口仍然保留，
  不因版本不匹配而隐藏或假装可用；版本超出已验证区间（0.1.7-rc.2 起）也会提示未经验证。
- **面板自愈**：显示器断开/切换后 webview 可能白屏到重开窗口——现在 ping/pong 探活，
  渲染进程失联或屏幕拓扑变化时自动重建 webview（内容自动重拉），窗口重新聚焦时即时探测；
  另加命令「DSH: 重新加载侧边栏面板」作为手动逃生口。
- **供应商全量目录**：设置 → API 页列出 DSH 内置的全部供应商（默认休眠），为任一供应商
  填写 Key 即自动写入路由配置并发现模型；新建供应商的预设列表由官方目录动态生成。
- 作业/定时/变更卡默认折叠并显示运行中计数；安装插件包卡片移到插件页顶部；分叉按钮
  移到归档左侧；会话搜索框与卡片标题行高统一为常规字号。
- **默认折叠的任务面**：后台作业与新增的**定时任务**卡都收成一行汇总（总数、
  运行中 / 失败计数），展开状态记在本地；实时任务多时不再淹没对话。
- **定时任务**：会话的 `schedule/catalog` 列出（每天 / 每周 / 间隔 / 一次性 / cron
  中文描述），支持改名与改指令、删除；「新建」预填一条交给 agent 的创建指令
  （DSH 仅允许模型工具创建计划）。
- **会话搜索**：会话选择框顶部全文搜索历史（`session/search`，最多 20 条带片段）；
  部署禁用查询索引时灰显并给出官方原因。
- **置顶与分叉**：会话可 ☆ 置顶（置顶优先、★ 金色）；头部「分叉」在当前完成轮
  处创建新会话。
- **子代理树**：子代理会话在选择框按 `parentSessionId` 缩进嵌套，点击以
  continuable 地址在面板中打开，可继续对话。
- **@ 引用与技能菜单**：`@` 列出工作区文件与会话候选（会话候选插入 DSH 的正式
  mention 文本）；`/` 列出可用技能并插入 `/名称 `。
- **轮次大纲与上下文分解**：点击轮次分隔行弹出全部轮次跳转；上下文环 tooltip
  分解系统 / 工具 / 消息 token。
- **工作区管理与账户卡**：设置页新增「工作区」标签（新增目录、上移排序、重命名、
  删除）与只读账户卡（登录状态、昵称 / 联系方式、用量 / 充值入口）。
- **高级设置**：由 `settings/describe` schema 驱动的表单（agent-loop、终端沙箱、
  子代理、网页搜索、会话日志、思考强度等），支持恢复默认。
- 兼容性：全部新协议为可选调用，旧 harness 缺路由时静默降级。

## [1.3.0] - 2026-10-27

- **后台作业状态栏**：`job/registered` / `job/settled` 事件折叠成输入框上方的紧凑状态栏
  （类型、名称、运行中 / 停止中 / 已完成 / 已终止 / 失败、输出量与起止时间），运行中的任务
  可一键停止（`job/kill`）。
- **目标（Goal）**：`goals/*` 全生命周期接入——目标条显示目标文本、阶段
  （进行中 / 已暂停 / 受阻 / 已完成）与轮次，支持暂停 / 恢复 / 完成 / 清除；输入栏 ◎ 按钮
  就地创建目标。与官方网页共用同一份会话目标状态。
- **每轮变更与产物**：`workspace/changes` 生成可折叠变更卡（文件数、+/− 合计），展开后
  逐文件列出，点击即以统一 diff 编辑器标签打开该轮开始/结束对比；`deliverables/presented`
  声明的产物文件同卡列出并可直接打开。
- **即时失效**：设置页、模型 / 凭据、权限目录、Agent 预设、插件市场订阅 `$events` 官方
  失效事件，DSH 侧变化会立即反映到界面，无需手动刷新。
- 兼容性：新协议均为可选调用——旧 harness 缺少对应路由时静默降级，不影响既有功能。

## [1.2.0] - 2026-10-27

- **官方可选插件包正式接入**：插件页按官方语义重做——实验性插件包（智能体团队、
  语音输入、自动评审、Inspector、会话搜索 / 标题、终端、ralph、徽章技能、思维链
  翻译、worktree、插件市场）单独成组并带实验徽标；勾选启用直接从安装副本生效
  （`pluginManager/setBundleEnabled`，无需重装）；按需子代理供应商（Codex、Claude
  Code）按固定版本 spec 安装；已安装且落后的包提供**更新**；新增「检查安装状态」
  找回丢失的安装响应（`pluginManager/waitForInstall`）；版本豁免警告、安装源、
  availability、行数与错误诊断均展示；内置模块清单（`pluginInventory/list`）按
  Agent 预设分组折叠。
- **插件市场**（可选）：启用官方 *plugin market* 包后，插件页出现索引管理
  （`pluginMarket/listIndexes` / `setIndexes`）与市场检索 / 安装 / 更新
  （`pluginMarket/search`），带兼容性与版本豁免保护。
- **智能体团队面板**：启用 *agent team* 包后，头部**团队**按钮（人数）打开实时
  团队卡——成员（队长在前、运行中 / 空闲 / 启动中 / 失败、所用模型、错误明细）与
  共享任务（状态标记、负责人、阻塞关系、写入范围、可展开描述）。点击队友在面板内
  打开其**可续聊会话**：直接发送（`subagents/prompt`）、停止
  （`subagents/interruptByParent`）、返回队长；子会话隐藏主工具栏，历史分页走
  `subagent` 地址；团队/成员/任务事件实时刷新，投影缓存兜底。对齐官方 Web 团队
  对话框（任务只读），并保留既有视图（不启用该包时完全无感）。
- 兼容性：全部新 RPC 均为「有则用、无则静默降级」，旧 harness 不受影响。

## [1.1.8] - 2026-10-24

- **失败不再伪装成完成**：此前 `turn/end` 的原因（reason）被忽略——余额耗尽
  （`QUOTA` / HTTP 402）等错误会渲染成绿色 ✓「完成」，运行中的工具也被翻成成功。
  现在失败轮显示「✗ 第 N 轮失败（账户余额不足）」并附居中的错误卡（原始错误
  消息、HTTP 状态、错误码），余额类错误带「打开充值页」按钮；被停止、被中断
  （服务重启）、达到输出上限、被阻止各有对应文案；运行中的工具随轮次结果关闭
  （失败红点、中止黄点）。历史回放路径与实时渲染一致。
- **失败轮通知**：后台标签页也能知道失败——每轮一次 VS Code 通知（余额类附
  充值入口），`dshVsc.notifyTurnFailures` 可关闭。
- 完成轮照常显示用时（含失败轮）。

## [1.1.7] - 2026-10-26

- **DSH 0.2.1-rc.3 适配**：overlay 金丝雀锚点同时匹配 v0.1.7-rc.2 与 v0.2.1-rc.3
  两种上游形状（`void` 返回 / `Peer` 返回），升级后不再每次启动 `CANARY-FAIL`。
- **完整性校验版本感知**：记录 0.2.1-rc.3 的 SHA256；版本与记录不一致时报告
  「此版本尚未核验」而不是误报「官方文件被修改」；新增 `npm run record-pristine`
  维护工具（`-- --write` 同时更新校验脚本）。
- **更新失败自动恢复**：npm 失败后若全局树停在半装状态，自动重装回原版本并告知；
  EBUSY 守卫区分「另一个 VS Code 窗口自管的 harness」与外部实例。
- **更新检查更稳**：npmjs 元数据不可达时回退 npmmirror；自动检测结果写入状态栏
  提示（上次检测时间/结果）；npm 改用已知绝对路径解析，找不到时给出明确错误。
- **后台任务通知不再伪装成「插入中」**：`tool-jobs` 完成通知显示为「任务通知」
  （灰色虚线、仅保留复制），≥3 条自动折叠为「后台任务通知 ×N」可展开/收起。

## [1.1.6] - 2026-10-23

### Fixed

- **DSH updates no longer leave a broken install**: the npm retry after a peer
  conflict now uses `--force` instead of `--legacy-peer-deps` (the latter also
  skips peer provisioning, e.g. `dsh-scope`/`dsh-attachment`, and installs a
  tree that cannot boot).
- **Registry-mirror lag is handled**: when npm reports `ETARGET`/“no matching
  version”, the update retries once against the official npm registry (China
  mirrors can trail a fresh publish by minutes to hours).
- **Half-published upstream versions are preflighted**: before installing, the
  exact version's dependencies are probed on npmjs; a release missing a tandem
  package is skipped (stable channels) or reported clearly (next/alpha) instead
  of failing mid-install.
- **Clear failure classification** for npm errors (ETARGET, ERESOLVE, EBUSY
  files locked by a running dsh, permissions, network) instead of raw npm walls.
- **Updating while an external dsh runs is refused with instructions**: npm
  would hit locked koffi/worker files and the new version could not take effect
  until that process restarted.

## [1.1.5] - 2026-10-16

- **修复：自动链接吞掉后文**。URL 后紧跟全角标点、第二个 URL 或中文时，
  GFM 直链会把整段（甚至后续整段消息）吞进一个链接，导致整条消息变蓝。
  现在直链在全角/排版标点处收窄；中文国际化域名与 IDN 路径保持完整
  （只有紧贴在 ASCII 字母数字后的中文被视为后文），后续裸 URL 仍各自成为链接；
  显式 markdown 链接不受影响。
- **粘贴 URL 自动分隔**：输入框粘贴「纯 URL 且光标后紧跟文本」时自动补一个
  全角分号，保证直链在 URL 边界结束、不吞掉后文。
- **原生 dsh web 自动鉴别**：检测到由用户/官方启动的 `dsh web`（需要浏览器
  会话鉴权）时，不再只提示关闭——用本机持久的浏览器会话密钥自签一个短时
  Cookie（仅回环地址）直接接入，原生实例与浏览器界面可继续并用。
  可用 `dshVsc.nativeWebAuth` 关闭（关闭后退回提示行为）。
- **左侧边栏入口兜底**：活动栏 DSH 图标被隐藏时，状态栏新增
  `$(comment-discussion) DSH` 入口（点击打开面板）；可用
  `dshVsc.statusBarEntry` 关闭。
- **DSH 更新检查感知通道**：默认跟随已安装版本（`auto`）——0.2.1-rc.x
  安装会比较最新预发布，而不是永远对照过时的 `latest` 标签；也可显式选择
  `stable` / `next` / `alpha`（`dshVsc.dshUpdateChannel`）。启动检查之外，
  窗口存续期间每 6 小时复查一次，harness 重连后 30 分钟限频内补查。
- **通用设置新增更新中心**：「扩展更新」与「DSH 更新」两张卡片，各带
  检测 / 安装按钮；扩展更新自动下载 GitHub 发布的 VSIX 并通过 VS Code CLI
  安装（重载后生效），DSH 更新沿用预检与自检回滚流程。

## [1.1.4] - 2026-10-16

- **多窗口生命周期**：多个 VS Code 窗口共享同一个 harness——每个窗口写心跳，
  关一个窗口不再停掉大家共用的服务，关最后一个窗口才停。所有窗口崩溃/被强杀时，
  守卫包装进程（dist/harness-guard.mjs）会在约 45 秒后杀掉整棵进程树，后台实例
  不会成为孤儿；手动启动的 harness 依旧绝不被碰。
- **待发消息不再进入聊天转录**：排队/插队消息只显示在输入框上方的待发条
  （「排队」绿色高亮、「插入中」，字体与行高和聊天内容一致），消息被真正送达后
  才落入转录。此前乐观气泡会卡在流中间，令聊天窗看起来被拦腰截断。
  历史回放与已送达消息现在也正确渲染文件附件块。
- **todo 计数跨「继续」累计**：x/n 不再因每轮重置归零（重建的清单读数只增不减）；
  「进行中」显示条目序号（如 `3# 进行中 · 5/8`），转录里的任务清单卡同步使用序号；
  全新任务自动重置计数。
- 修复：已发送附件在历史回放中丢失文件块（现在 text/file/image 块都持久渲染）。

## [1.1.3] - 2026-10-15

- **计费余额完整显示**：余额 chip 与官方账户面板一致——充值余额之外，赠送余额以
  「赠 ¥x」可见展示（title 内分「余额/赠送余额」两行）；钱包通用渲染（按接口返回
  顺序显示所有币种，不再硬绑首个 CNY 钱包），适用于所有账户渠道；**无赠金时完全
  不显示赠金部分**。
- **拖拽彻底修复**（根因：VS Code webview 宿主的拖拽窃取——内层 host 把文件拖拽
  上报 `drag-start` 后外层把 iframe 设为 `pointer-events:none`，"闪一下即失效"）：
  捕获拦截 + `stopImmediatePropagation` 使宿主状态机不会启动；补齐 VS Code Explorer
  的 `ResourceURLs`（JSON 数组）与 `application/vnd.code.*` 类型、仅有
  `DataTransferItemList` 的数据源、空类型拖拽；drop 时全类型兜底扫描；未识别内容的
  诊断提示。系统/资源管理器/VS Code 资源管理器拖入均可用，纯文本不被劫持。
- **输入框**：余额作为框内最下一行（不可输入，左对齐，整个输入框共享焦点环）；
  附件条高度自适应——含图片时文件 chip 与缩略图同高并使用大图标，纯文件时保持
  紧凑；已发送的文件行位于气泡上方独立一行，chip 高度与单行气泡一致、与气泡
  间隔半个行高；回形针按钮改为跟随主题着色的内联 SVG（此前保持浏览器默认白底）。
- **模式下拉详情**：窄面板下提示框自动移到悬停行下方，不再遮挡光标所在的模式项。

## [1.1.2] - 2026-10-15

- **内置伴生插件 `dsh-vsc-companion`**（VSIX 内置、自动安装与更新、随扩展版本走，
  零手动配置）：任务清单实时化（每个请求注入实时清单快照 + 增量更新纪律；
  中断续接时提醒先重建清单）＋宿主侧浏览器工具 `page_screenshot` / `page_eval`
  （绕开 Windows 沙箱无法启动浏览器的问题；截图既落盘也作为图片附件返回给模型）。
  可用 `dshVsc.companion` 关闭；设置页「插件」标签显示其状态。
- **输入框附件**：粘贴/拖入图片（内联发送，与官方网页一致）；拖入或经 📎 选择
  文档作为耐久文件引用发送（fileUploads/upload → receipt）；附件草稿栏（缩略图/
  大小/移除、点击看大图）；发送后图片与文件在对话中渲染；工具结果里的图片
  （如 `page_screenshot`）与伴生截图消息也在对话中显示。
- **修复**：`autoGrow()` 引用未定义函数 `scrollPos` 的历史遗留错误（每次输入抛
  ReferenceError，输入框贴底保持逻辑从未生效）。
- README（双语）：新增「内置伴生插件」章节与配置表 `dshVsc.companion`。

## [1.1.1] - 2026-10-15

- **思考框实时滚动**：展开正在流式输出的思考框会直接跳到当前思考位置，并随
  内容增长自动跟随；手动向上滚动回看时不会被拽回（anti-hijack），滚回底部
  自动恢复跟随；已完成的（历史）思考框仍从开头展开。

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
