# src/harness — harness 连接与生命周期

| 项 | 说明 |
|---|---|
| **谁可见** | 公开（源码） |
| **为谁负责** | 扩展与 dsh harness 的一切连接/生命周期 |
| **行为边界** | 只放 harness 侧：客户端、发现、启动、协议 |

## 放这里 ✅

- `client.ts` — JSON-RPC 客户端（`POST /api/<endpoint>`，args 信封）
- `discover.ts` — 端口探测 / 发现
- `launcher.ts` — 自启动（windowless、detached）、PID 记录、停止
- `storage.ts` — 会话历史文件的彻底删除（无 RPC，直接操作 `~/.dsh/sessions`）
- `workspaceAcl.ts` — 工作区 ACL 守护（DSH 沙箱需要的 WRITE_OWNER；icacls 自动修复 + 可选 UAC 修复）
- `updater.ts` — dsh 更新检查（npm registry）+ `npm install -g` 安装/回滚
- `updatePreflight.ts` — 更新前接口预检（GitHub 通告扫描 + 新版本包接口静态核验）
- `capabilities.ts` — DSH 版本兼容台账（特性 → RPC 组、gateway 错误分类、已验证版本区间）
- `clientRegistry.ts` / `guard.ts` — 多窗口心跳注册表与 harness 守卫进程（自适应心跳 30s/120s，FRESH=150s）
- `protocol.ts` — 协议类型（0.1.7 typert 端点 + settings / pluginManager 视图）

## 不放这里 ❌

- 事件流 WS → `../events/`；编辑器桥 → `../editor/`
