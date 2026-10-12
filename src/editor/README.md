# src/editor — 编辑器桥

| 项 | 说明 |
|---|---|
| **谁可见** | 公开（源码） |
| **为谁负责** | 扩展原生桥功能 |
| **行为边界** | 只放"编辑器 ↔ harness"桥接代码 |

## 放这里 ✅

- `askSelection.ts` — 选区右键 Ask DSH（结构化上下文）
- `context.ts` — 上下文构建（文件/选区/工作区/分支）
- `changeTracker.ts` / `diff.ts` / `diffCount.ts` — 改动追踪 + git diff 审查 + +N-M 统计
- `followEdits.ts` — 跟随 agent 编辑（直接 write/edit 与 PTC 嵌套 tool/ptc-dispatch 成功后自动打开对应文件并定位到首个修改行，磁盘更新实时刷新）

## 不放这里 ❌

- harness 连接/启动 → `../harness/`；面板渲染 → `../panel/`
