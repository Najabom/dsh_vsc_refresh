# src/panel — 侧边栏面板

| 项 | 说明 |
|---|---|
| **谁可见** | 公开（源码） |
| **为谁负责** | 侧边栏 UI 与 webview 生命周期 |
| **行为边界** | 只放面板相关代码与资源 |

## 结构

| 文件/目录 | 职责 |
|---|---|
| `NativePanelProvider.ts` | 原生侧边栏面板（webview 宿主）；同一实现也承载「问题对话」编辑器分屏窗口（askMode：固定会话 + 精简界面） |
| `renderer.ts` | 面板消息渲染/嵌入辅助 |
| `embed.ts` | 嵌入 DSH Web GUI 的高级视图 |
| `protocol.ts` | 面板 ↔ 宿主消息协议 |
| `media/` | webview 内嵌资源（shell.html、图标） |
| `native/` | 原生面板本体（`panel.html` 主面板、`settings.html` 设置页） |

## 放这里 ✅

- 面板 webview、渲染、协议代码

## 不放这里 ❌

- harness 连接 → `../harness/`；扩展级图标 → `media/`（仓库根）
