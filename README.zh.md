# DSH Bridge · DeepSeek Harness for VS Code

**把 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) —— 本地的 AI 智能体 —— 直接放进 VS Code。** 一个原生侧边栏面板 + 编辑器桥，以**协议客户端**的方式连接 DSH，不重写它、也不另起第二个服务端。

语言：**简体中文** · [English](README.md)

> **衍生说明** —— 本项目基于
> [zhibailu/dsh-vsc](https://github.com/zhibailu/dsh-vsc) 二次开发，由
> [Najabom](https://github.com/Najabom) 维护。保留原项目「纯协议桥」设计，
> 新增对 DSH 0.1.7-rc.2+ 的完整协议适配、启动时更新检查（接口预检 + 失败
> 回滚）、Windows 沙箱工作区 ACL 自动修复、编辑器跟随 agent 编辑，以及全面
> 的面板与交互改进。原作品 © 2026 zhibailu（MIT）。逐版本变更见
> [CHANGELOG.md](CHANGELOG.md)。

---

![version](https://img.shields.io/badge/version-1.0.0-2ea44f)
![license](https://img.shields.io/badge/license-MIT-blue)
![vs code](https://img.shields.io/badge/VS%20Code-%5E1.90.0-007ACC)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![node](https://img.shields.io/badge/node-%E2%89%A518-339933)

> **一句话** —— DeepSeek Harness（DSH）是一个住在你电脑里的 AI「工人」（默认 `http://127.0.0.1:3080`）。DSH 自带一个网页，但那个网页只是它「协议」的**一个客户端**。`dsh-vsc` 是**另一个客户端**——一张真正属于 VS Code 的侧边栏。它不重写 DSH、不模仿它的 UI，而是读懂协议、把干活的过程用原生面板画给你，并接上针对**你的代码**的原生编辑器桥。

---

## 目录

- [为什么用它](#为什么用它)
- [功能](#功能)
- [截图](#截图)
- [安装](#安装)
- [快速上手](#快速上手)
- [它怎么工作](#它怎么工作)
- [设计哲学——「纯桥接」](#设计哲学纯桥接)
- [命令](#命令)
- [配置](#配置)
- [刻意不做的事](#刻意不做的事)
- [开发](#开发)
- [文档](#文档)
- [参与贡献](#参与贡献)
- [许可证](#许可证)

---

## 为什么用它

多数「AI 进 IDE」的工具是在**重造一个 AI**。这个项目正好相反：

- **不 fork、不重写 DSH**：DSH 保持字节级一致（npm 原版）。它能做的事，这个扩展都能呈现。
- **不把网页 iframe 当主力体验**：侧边栏是一张**原生 VS Code 面板** + 原生编辑器桥——选中代码、右键、提问；看着工具干活、审批操作、审阅 diff。
- **DSH 升级也不怕**：它消费 DSH 的**协议契约（wire contract）**，而不是 UI。DSH 界面随便改版，这个扩展都不必跟着改。

如果你已经在用 DSH（网页或命令行）、又在 VS Code 里写代码，`dsh-vsc` 把你的编辑器变成 DSH 的一等表面——**一份历史、一套契约、绝无第二个服务端**。

## 功能

**原生侧边栏面板**
- 流式回复、可折叠的**思考（reasoning）**栏与每轮**实时计时**。
- 相邻工具调用合并成「**⚙ 动作**」折叠块；每轮 **`+N-M`** 改动统计。
- **审批卡片**：agent 请求执行需审批的操作时弹出——允许一次 / 拒绝。
- **选择题卡片**：单选用数字键、多选勾选、推荐徽章、自定义回答（↑↓ 找回）、跳过——经 `/api/respond` 回传。
- **会话模式**（标准 / PTC / 极简 / 创造）、**推理等级**切换、**权限预设**切换（只读 / workspace-write / full-access）。
- **输入栏接管**：agent 提问时主输入栏整体隐藏，防止误发消息。

**原生编辑器桥**
- **Ask DSH（选区）**：选中代码 → 右键 → *DSH: Ask about selection*，弹结构化上下文卡片（文件 / 选区 / 工作区 / 分支）送入最新会话；解释 / 审查 / 修复 / 自定义。
- **Review Agent Changes**：监控 `write` / `edit` / `str_replace_editor` 工具调用，每轮提示改动数，一键打开 VS Code 原生 **git diff**。

**harness 生命周期**
- 复用正在运行的 DSH（共享客户端，不另起服务端）；只有确实没有才自拉一个；**自愈**（死了按退避重启）；**引用计数关闭**（绝不杀掉还被别的客户端用着的 harness）。详见[它怎么工作](#它怎么工作)。

## 截图

**侧边栏与对话**——原生 DSH 面板：会话列表、流式回复、可折叠的「⚙ 动作」、每轮实时计时、`+N-M` 统计

<p align="center"><img src="docs/screenshots/sidebar.png" width="290" alt="DSH 侧边栏与对话" /></p>

**右键提问**——在编辑器里选中代码，右键 → *DSH: Ask about selection*

<p align="center"><img src="docs/screenshots/ask-menu.png" width="380" alt="右键 Ask DSH 菜单" /></p>

**Ask 卡片**——面板里弹出的结构化上下文卡片（文件 / 选区 / 工作区 / 分支）

<p align="center"><img src="docs/screenshots/ask-card.png" width="290" alt="面板中的 Ask 卡片" /></p>

**审批卡片**——agent 请求执行需审批的操作时，允许一次 / 拒绝

<p align="center"><img src="docs/screenshots/approval.png" width="460" alt="审批卡片" /></p>

**选择题卡片**——单选 / 多选、推荐徽章、自定义回答

<p align="center"><img src="docs/screenshots/question.png" width="290" alt="选择题卡片" /></p>

**Review Agent Changes**——每轮改动的文件 → 一键打开原生 git diff

<p align="center"><img src="docs/screenshots/review.png" width="440" alt="Review Agent Changes" /></p>

**会话模式**——标准 / PTC / 极简 / 创造

<p align="center"><img src="docs/screenshots/mode-picker.png" width="400" alt="会话模式选择" /></p>

## 安装

> 需要 Windows / macOS / Linux + VS Code `^1.90.0`。DSH 本体**不用单独装**——没有 harness 在跑时扩展会自动拉起一个。

**方式 A —— Release 安装包（推荐）**

1. 从 [Releases](https://github.com/zhibailu/dsh-vsc/releases) 下载最新的 `dsh-vsc-<版本号>.vsix`。
2. 安装（VS Code `Ctrl+Shift+P` → **Install from VSIX**，或命令行）：

   ```bash
   code --install-extension dsh-vsc-<版本号>.vsix --force
   ```

3. 重载窗口（`Ctrl+Shift+P` → **Reload Window**），左侧活动栏点 **DSH** 图标即可。

> 会自动复用正在运行的 harness（`npm i -g @deepseek-ai/dsh` 或 `npx @deepseek-ai/dsh web`），默认 `http://127.0.0.1:3080`，可用 `DSH_WEB_URL` 或 `dshVsc.url` 覆盖。

**方式 B —— 源码构建**

```bash
git clone https://github.com/zhibailu/dsh-vsc.git
cd dsh-vsc
npm install
npm run package        # esbuild 构建 + vsce 打包 → dsh-vsc-<版本号>.vsix
code --install-extension dsh-vsc-<版本号>.vsix --force
```

## 快速上手

1. **重载窗口**——装完必须重载才生效。
2. 左侧活动栏点 **DSH** 图标打开侧边栏。
3. 没有 harness 在跑时，扩展会自动静默拉起一个（不弹窗）；有则直接复用。
4. 发消息，看 agent 干活。

**扩展里不用配 API key**：key 在 DSH 侧配置（第一次 `dsh web` 时按提示设置）。扩展只是它的共享客户端，不碰你的 key。

## 它怎么工作

DSH 对外暴露两样东西：**RPC 接口**（`POST /api/<method>`）和**实时事件流**（`/api/events.mux`）。网页只是这份契约的一个消费方。

`dsh-vsc` 是第二个消费方：

- **`src/harness/client.ts` —— 约 200 行的最小协议客户端**：在 Node（≥ 18，全局 `fetch`）里重实现 DSH 的 wire contract，**不 import 任何 DSH 内部包**，刻意做得很薄——实现协议，而不是插件框架。
- **无损事件**：面板拿到的是事件流的**原始帧**，不做二次建模；渲染交给面板自己。桥接层越透明，越不会跟官方语义脱节。
- **协议优先、UI 无关**：官方 README 写明"没有协议版本字段，因为客户端与服务端一起发布——直到出现独立发布的客户端"。这个扩展正是那个独立发布的客户端，站的是**稳定契约**那一层，不是**易变 UI**那一层。
- **唯一的例外 —— `overlay`**：协议没暴露的 4 个能力（`clientCount`、隐藏工具控制台）由**内存运行时补丁**提供，并上了三把锁——只改内存、磁盘官方文件一行不碰；启动时校验官方文件 **SHA-256**，对不上整体放弃；patch 前查**金丝雀锚点**，找不到就降级。且有明确退役路线（等官方补上对应字段，如 `hostInstanceId`，就删对应 delta）。
- **第二个客户端，绝不做第二个服务端**：真实事故证明，两个 DSH 进程共用 `~/.dsh` 会互相写坏历史（`corrupt session log: seq gap`）。所以扩展绝不另起一个服务端去写同一份历史：能复用就复用，只有确实没有才自拉，关闭时用**引用计数**（问 `host.describe` 的 `clientCount`）决定停不停，绝不错杀正在被别人用着的 harness。

给想理解这套设计的人写的完整架构说明，见 [docs/design.md](docs/design.md)。

## 设计哲学——「纯桥接」

> **我不抢 DSH 的活，我只当它最好的那个客户。**

- **不重写 DSH** → 它保持字节级一致；它的稳定就是你的稳定，它升级你不必跟着重写。
- **不模仿 DSH 的 UI 框架** → 替官方重写一套插件系统，既不讨好官方、也累死自己。
- **不另起第二个 DSH** → 两个进程共用一份历史会互相写坏。
- 实在要改（overlay）就**可验证、可降级**：校验、金丝雀护栏、失败就放弃、上游补上就退役。

## 命令

| 命令 | 作用 |
|---|---|
| `DSH: Open Sidebar` | 聚焦 DSH 侧边栏 |
| `DSH: Start Web Harness` | 显式启动/连接 harness（清除"不再重启"闩） |
| `DSH: Stop Auto-started Harness` | 只停本扩展自拉的那个；共享的绝不杀 |
| `DSH: Refresh Connection Status` | 重新探测 harness |
| `DSH: Open Web GUI (advanced)` | 把完整 DSH 网页作为标签页打开 |
| `DSH: Ask about selection` | 询问选中的代码（右键菜单里也有） |
| `DSH: Review Agent Changes` | 打开 agent 改动文件的原生 git diff |

## 配置

| 设置 | 默认 | 说明 |
|---|---|---|
| `dshVsc.url` | `http://127.0.0.1:3080` | DSH harness 的地址；也认 `DSH_WEB_URL` |
| `dshVsc.autoStart` | `true` | 配置地址无人应答时自动启动 `dsh web` |

## 刻意不做的事

- 不重写聊天 UI、不截断/白名单事件、不要求重输 API key。
- 不另起第二个 harness——能复用就复用，只有没有才自拉；关 VS Code 时若还有别的客户端连着，自拉实例会保留。
- 改动追踪只识别 `write` / `edit` / `str_replace_editor` 工具事件；shell 里改的文件不计入（git diff 审查仍可手工用）。
- `+N-M` 统计只覆盖上述文件工具；计时器是桥接侧纯展示（挂最新进行中的一轮，任务结束即固化为历史用时）。
- Ask DSH 发送到"最近更新的会话"（不一定是 webview 当前打开的那个）。
- 审批/选择题只在**当前选中会话**弹出。

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit（两套配置）
npm run build       # esbuild → dist/extension.js + dist/media
npm run package     # 构建 + 打包 vsix
```

F5 调试（[`.vscode/launch.json`](.vscode/launch.json)）→ Extension Development Host。

自动回归测试（jsdom 模拟 webview，喂真实事件流验证面板渲染）：

```bash
node scratch/auto-test.mjs <sessionId> <turnNo>
```

## 文档

- [设计与架构说明](docs/design.md)——为什么采用「纯桥接」、如何应对 DSH 升级保持稳定、各模块如何配合。
- [源码地图](src/README.md)——`src/` 里各目录管什么。
- [截图](docs/screenshots/)——本 README 用到的图片素材。
- [`llms.txt`](llms.txt)——给 LLM / AI 抓取器用的机器可读文档索引。
- [`AGENTS.md`](AGENTS.md)——给 AI 编码代理的仓库上手说明。
- [更新日志](CHANGELOG.md)——版本历史。
- 维护者可见：[GITHUB-SETUP.md](GITHUB-SETUP.md)——在 GitHub 上设置仓库元数据与 topics 以提升可发现性。

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。欢迎 issue、PR、文档改进——尤其是帮新人讲清架构的。

## 许可证

MIT © 2026 zhibailu — 详见 [LICENSE](LICENSE)。
