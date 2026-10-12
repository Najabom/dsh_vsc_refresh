# src/panel/native — 原生面板本体

| 项 | 说明 |
|---|---|
| **谁可见** | 公开（源码，编译后进 dist/media） |
| **为谁负责** | 原生侧边栏面板 UI（渲染/交互核心） |
| **行为边界** | 只放原生面板的页面与脚本 |

## 放这里 ✅

- `panel.html` — 主面板全部 UI/JS（~3600 行，含渲染同步、事件处理、计时器、合并分组）
- `settings.html` — 设置页 UI/JS（~950 行，模型/权限/预设/插件管理）
- 后续拆出的面板 JS/CSS（如需）

## 不放这里 ❌

- 宿主逻辑（webview 生命周期）→ `../NativePanelProvider.ts`；协议 → `../protocol.ts`
