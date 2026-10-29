# src/harness — harness 连接与生命周期

| 项 | 说明 |
|---|---|
| **谁可见** | 公开（源码） |
| **为谁负责** | 扩展与 dsh harness 的一切连接/生命周期 |
| **行为边界** | 只放 harness 侧：客户端、发现、启动、协议 |

## 放这里 ✅

- `client.ts` — JSON-RPC 客户端（`POST /api/<endpoint>`，args 信封）
- `discover.ts` — 端口探测 / 发现
- `deps.ts` — **跨平台启动依赖解析**：Node.js（dsh 要求 ≥ 24.9）、`@deepseek-ai/dsh/lib/bin.js` 入口、pnpm（官方插件管理器从 PATH 调 `pnpm`，要求 ≥ 11）。三者都是**外部依赖，只探测不代装**：缺失/过旧时返回可操作的安装命令。纯 Node 内置模块、不 import `vscode`（设置由 launcher 传入）也不 import DSH；`diagnoseDeps()` 是设置页「运行环境」卡片的稳定接口
- `launcher.ts` — 自启动（windowless、detached、跨平台）、PID 记录、停止（Windows `taskkill /T`；POSIX 进程组 SIGTERM→SIGKILL）
- `storage.ts` — 会话历史文件的彻底删除（无 RPC，直接操作 `~/.dsh/sessions`）
- `workspaceAcl.ts` — 工作区 ACL 守护（DSH 沙箱需要的 WRITE_OWNER；icacls 自动修复 + 可选 UAC 修复）
- `updater.ts` — dsh 更新检查（npm registry）+ `npm install -g` 安装/回滚
- `updatePreflight.ts` — 更新前接口预检（GitHub 通告扫描 + 新版本包接口静态核验）
- `capabilities.ts` — DSH 版本兼容台账（特性 → RPC 组、gateway 错误分类、已验证版本区间）
- `clientRegistry.ts` / `guard.ts` — 多窗口心跳注册表与 harness 守卫进程（自适应心跳 30s/120s，FRESH=150s）
- `protocol.ts` — 协议类型（0.1.7 typert 端点 + settings / pluginManager 视图）

## 启动依赖的跨平台引导（deps.ts + launcher.ts）

启动一个**受管** harness 需要三样东西，全部由 `deps.ts` 探测、`launcher.ts` 在真实 spawn 前强制重新解析：

| 依赖 | 探测顺序 | 缺失/不满足时 |
|---|---|---|
| Node.js（dsh `engines` 要求 **≥ 24.9.0**） | `dshVsc.nodePath` → PATH（`where`/`which`，含 Windows shim）→ 常见安装位置（Program Files、nvm、Homebrew…）→ VS Code 自带 Electron 运行时（仅当内置 Node ≥ 24.9，配 `ELECTRON_RUN_AS_NODE=1` 使用） | 日志给出安装命令与链接（nodejs.org），本次会话只提示一次；**不消耗**自动重启次数 |
| `@deepseek-ai/dsh/lib/bin.js` | `dshVsc.dshScriptPath` → PATH 上的 `dsh`（**解析** npm `.cmd`/`.ps1`/POSIX 符号链接到真实 `lib/bin.js`，不执行 shim）→ `npm prefix -g` 布局 → 常见全局前缀 | 提示 `npm i -g @deepseek-ai/dsh` 或设置 `dshVsc.dshScriptPath` |
| pnpm（**插件安装必需，≥ 11**） | `dshVsc.pnpmPath` → PATH（`where pnpm.cmd`/`which pnpm`）→ `PNPM_HOME` → corepack shims（node 同目录）→ npm 全局 bin | 只检测、**不代装**：未安装或只有 pnpm 9/10（它们的 `view` 会转调 npm，DSH 的 `--config.fetch-retries` 会被拒绝）时给出 `npm i -g pnpm@11` / `dshVsc.pnpmPath` 指引；pnpm 只影响插件安装，不影响 harness 启动 |

要点：

- **不靠 npm `.cmd` / `npx` 启动**：Windows 的 shim 会 `cmd.exe → shim → cmd.exe` 再弹一个控制台，POSIX 也白白多一层 shell。launcher 直接 `node <lib/bin.js> web --no-open --port N`（Windows `windowsHide`，POSIX detached → 自成一个进程组）。
- **不再要求 GITHUB_TOKEN**：旧实现从注册表读 token 并以「缺了 dsh web 起不来」为由注入，经实机验证是错误假设。现在只透传承继环境里已有的 token（有就记一行日志，没有也无所谓）。
- **外部依赖由用户自行安装，扩展只做探测与说明**：Node / DSH / pnpm 缺失时分别给出确切的安装命令（`npm i -g @deepseek-ai/dsh`、`npm i -g pnpm@11`…），并写入 README 的环境要求；pnpm 未就绪时 harness 照常启动，仅插件与伴生插件的安装/更新不可用。第一方伴生插件本身随 VSIX 打包，不依赖外部下载。
- **配置变更即失效**：`dshVsc.nodePath/dshScriptPath/pnpmPath` 变化会清空依赖诊断缓存；命令 `dsh.restart`（设置页「重启 DSH 服务」）停掉受管实例后重新探测并拉起，是让新工具链 PATH 生效的标准入口。
- **设置页接口**：`diagnoseDeps(): Promise<DepStatus>`（平铺状态，缓存 ~5s，`invalidateDepsCache()` 可强制刷新）供「运行环境」卡片使用。
- **仍存在的平台差异（如实说明）**：Windows 上进程树用 `taskkill /T`，POSIX 用进程组信号；PID 复用护栏读取命令行（Windows 走 CIM，POSIX 用 `/proc` 或 `ps`）。macOS/Linux 分支是代码级实现 + 严格类型检查，未在真机回归。

## 不放这里 ❌

- 事件流 WS → `../events/`；编辑器桥 → `../editor/`；面板/设置页 UI → `../panel/`
