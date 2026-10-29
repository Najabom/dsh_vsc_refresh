# scripts — 工具脚本区

| 项 | 说明 |
|---|---|
| **谁可见** | 公开（仓库里有，但 vsix 打包排除） |
| **为谁负责** | 维护者（校验 / 自测），不面向终端用户 |
| **行为边界** | 只放开发/运维脚本：官方本体校验、合同检查、生命周期自测 |

## 放这里 ✅

- `record-pristine.mjs` — 升级 dsh 后从**已安装的**官方包重新记录 overlay 完整性表。
  跨平台（`$DSH_VSC_DSH_ROOT` / `npm root -g` / `npm prefix -g` / 常见全局前缀，
  Windows 与 POSIX 分别调用 npm）。无参数只校验并显示差异；
  `npm run record-pristine -- --write` 改写 `src/harness/overlay/pristine.ts`
  并**生成**下面的 `restore-dsh-pristine.ps1`（两者版本与哈希永远一致）。
- `restore-dsh-pristine.ps1` — **只读**校验官方 `@deepseek-ai/dsh` 安装树与 npm 发布版
  字节一致（`-VerifyOnly` 为兼容保留、始终只读）。由 record-pristine 生成，
  记录版本见 `pristine.ts` 的 `PRISTINE_HOST_VERSION`；不一致时提示
  `npm i -g @deepseek-ai/dsh@<记录版本>`。可用 `$env:DSH_VSC_DSH_ROOT` 指定 dsh 包目录。
- `contract-check.mjs` — 对指定 DSH 版本做接口合同检查（CI 每周跑矩阵
  `0.1.7-rc.2` / `0.2.1-rc.4` / `0.2.2-alpha.2`；用法
  `node scripts/contract-check.mjs 0.2.2-alpha.2`）。退出码：0 = 通过，
  1 = 合同破坏，2 = 无法核验（网络等）。
- `verify-sandbox.mjs` — 在 Windows 上验证 `dsh-sandbox-windows-acl` 沙箱链路可用且无窗口。
  workspace 取参数 / `$DSH_VSC_SANDBOX_WORKSPACE` / 当前目录；node 取
  `$DSH_VSC_NODE_PATH` / 当前 node；dsh 安装根取 `$DSH_ROOT` /
  `$DSH_VSC_DSH_ROOT` / npm 全局前缀。**非 Windows、或用该包的 DSH 构建时，
  打印 "skipped" 并以 0 退出**，不再写死任何机器路径。
- `lifecycle-test.ps1` — 维护者本机（Windows + 桌面）的生命周期自测：
  空端口自启 → 无窗口断言 → 杀掉受管 harness 后确认**同一窗口内不会自行重生**
  （当前契约：重载窗口或 `DSH: 启动 Web Harness` 才恢复）。全部路径可通过参数覆盖
  （`-RepoRoot` 默认为脚本上一级、`-CodeCmd` 自动探测、`-Vsix` 默认取仓库里最新的
  `dsh-vsc-*.vsix`、`-Port`、`-TestRoot`），结束时总会清理测试实例与临时目录。
- `install-local.mjs` — 开发便利：取仓库里最新的 `dsh-vsc-*.vsix`，先卸载旧开发版 ID
  `local.dsh-vsc`（避免两份扩展争同一组视图/命令），再
  `code --install-extension <vsix> --force` 装进本机 VS Code，并打印已装版本。
  通常通过 `npm run install:local`（= 构建 + 打包 + 安装）使用；装完需重载窗口。

## 不放这里 ❌

- 一次性调试探针 → `scratch/`
- 源码 → `src/`

## 背景（如实记录）

- 曾有两个补丁脚本（`patch-dsh-windowless.ps1` / `patch-dsh-client-count.ps1`）**直接改写官方安装包文件**，违反"纯桥接：绝不写 DSH 官方文件"，已删除。
- 现在唯一的行为补丁是**对本地回环请求放开 DSH 浏览器鉴权的 bypass**（0.1.7-rc.2+ 引入进程级浏览器 token），由**运行时内存覆盖**实现（`src/harness/overlay/`，经 NODE_OPTIONS 注入 harness 进程，磁盘官方文件全程只读）。设计说明见 `src/harness/overlay/README.md`。
- `restore-dsh-pristine.ps1` 只做校验（不写盘）；"还原"一词沿用历史命名，磁盘补丁时代已结束。
