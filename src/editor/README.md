# src/editor — 编辑器桥

| 项 | 说明 |
|---|---|
| **谁可见** | 公开（源码） |
| **为谁负责** | 扩展原生桥功能 |
| **行为边界** | 只放"编辑器 ↔ harness"桥接代码 |

## 放这里 ✅

- `askSelection.ts` — 选区右键 Ask DSH（结构化上下文；菜单标题跟随 VS Code 语言；选取面向问题对话窗口）
- `askSessions.ts` — 每工作区专属「问题对话」会话的解析与持久映射（AskSessions；stale id 自动重建）
- `context.ts` — 上下文构建（文件/选区/工作区/分支）
- `changeTracker.ts` / `diff.ts` / `diffCount.ts` — 改动追踪 + git diff 审查 + +N-M 统计
- `externalChanges.ts` — 任务期间工作区文件监控（shell 等外部写入 → 改动批次；目录/大小过滤）

## 不放这里 ❌

- harness 连接/启动 → `../harness/`；面板渲染 → `../panel/`
