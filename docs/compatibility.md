# DSH 版本与接口兼容性

DSH Bridge 是 DSH 的协议客户端：能力由 DSH 提供的 RPC 决定。本文记录哪些能力
依赖哪些接口、在哪些 DSH 版本上验证过，以及版本不匹配时扩展如何报告。

## 已验证版本区间

| 项目 | 值 |
|---|---|
| 最低验证版本 | `0.1.7-rc.2` |
| 最高验证版本（开区间） | `0.2.2`（即含 0.2.1 / 0.2.0 全部功能） |
| 运行形态 | 0.2.x（`@deepseek-ai/dsh`） |

版本低于下限或高于上限时，扩展照常连接并保留全部入口，只在面板顶部、设置页横幅
与日志（`compat:` 行）中**如实报告**「低于/高于已验证范围」，绝不会隐藏按钮。

## 能力矩阵

图例：✔ = 已验证可用；◐ = 可用但取决于部署配置；— = 该版本没有此接口。

| 能力 | 接口组 | 0.1.7-rc.2 | 0.2.0 | 0.2.1 | 0.2.2 |
|---|---|:-:|:-:|:-:|:-:|
| 会话、历史分页、流式事件 | `session/*`、`session/control`、`remote.mux` | ✔ | ✔ | ✔ | ✔ |
| 提示、插队、停止 | `session/prompt`、`session/control` | ✔ | ✔ | ✔ | ✔ |
| 审批与提问（含永久允许） | `$events` waterfall + `$events/result` | ✔ | ✔ | ✔ | ✔ |
| 权限预设与计划模式 | `permissionPresets/*`、`commands/execute` | ✔ | ✔ | ✔ | ✔ |
| 模型目录、推理强度、Agent 预设 | `session/modelCatalog`、`agentPresets/*` | ✔ | ✔ | ✔ | ✔ |
| 附件（图片内联 / 文件引用） | `fileUploads/upload`、`session/attachment` | ✔ | ✔ | ✔ | ✔ |
| 插件管理（安装/启停/豁免/市场） | `pluginManager/*`、`plugin-market/*` | ✔ | ✔ | ✔ | ✔ |
| 后台作业 | `job/*` | ✔ | ✔ | ✔ | ✔ |
| 定时任务 | `schedule/*` | ✔ | ✔ | ✔ | ✔ |
| 目标（Goal） | `goals/*` | ✔ | ✔ | ✔ | ✔ |
| 每轮变更与产物 | `workspace/changes`、`/api/changes.*` | ✔ | ✔ | ✔ | ✔ |
| 工作区管理、置顶 | `workspace/*`、`workspace/follow` | ✔ | ✔ | ✔ | ✔ |
| 会话搜索 | `session/search` | ◐ | ◐ | ◐ | ◐ |
| 分叉 | `session/fork` | ✔ | ✔ | ✔ | ✔ |
| 子代理会话（continuable） | `session/follow`（subagent 地址） | ✔ | ✔ | ✔ | ✔ |
| @ 文件/会话引用、技能菜单 | `fileReferences/*`、`sessionReferenceResolver/*`、`skills/*` | ✔ | ✔ | ✔ | ✔ |
| 轮次大纲、上下文分解 | `turnOutline`、`contextBreakdown` 投影 | ✔ | ✔ | ✔ | ✔ |
| 账户与余额 | `account/*` | ✔ | ✔ | ✔ | ✔ |
| 设置 schema 表单 | `settings/describe`、`settings/*` | ✔ | ✔ | ✔ | ✔ |
| Agent Team 面板 | `sessionProjections`（team 键）+ `agentPresets` | ✔ | ✔ | ✔ | ✔ |
| MCP 服务器管理 | 无 RPC（官方暂无） | — | — | — | — |

`◐ 会话搜索`：部分部署在会话索引上禁用了全文搜索，此时 RPC 返回明确的
`gateway/internal` 原因，选择框灰显并展示官方原因——扩展不猜测、不隐藏入口。

## 版本不匹配如何报告

扩展内置能力台账（`src/harness/capabilities.ts`）：

- 特性 → RPC 组的映射（上表左两列）；
- 网关错误分类：`not-found` → 该接口在新版本中不存在（不支持）；
  `arguments-invalid` → 参数形状已变化（不兼容）；`disabled` → 能力被部署停用；
- 记录**发生时刻**的 DSH 版本与服务端原始原因，取最严重级别。

上报位置：面板顶部黄色兼容条（悬停看全部原因）、设置页横幅、「DSH Bridge」输出
日志的 `compat:` 行。`DSH: 导出诊断报告` 命令会把台账、连接状态、harness 记录与
日志尾部打包成一份 Markdown，便于反馈问题。

## 更新与合同测试

- 扩展自更新前会做接口预检（`src/harness/updatePreflight.ts`）：扫描目标版本的
  发布说明与关键包内容，命中本扩展使用的接口标识时先提示风险。
- CI 合同任务（`.github/workflows/contract.yml`）每周对固定版本
  `0.1.7-rc.2` 与 `0.2.1-rc.4` 运行 `scripts/contract-check.mjs`：任一接口标识缺失
  或能力映射引用了未知接口，流水线报红。新增 DSH 版本时把该版本加入矩阵并
  扩展已验证区间。
