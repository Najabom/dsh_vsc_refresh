# 项目状态说明：已停止维护（2026-11-04）

> **English summary** — This project is **no longer maintained** (as of 2026-11-04).
> The maintainer's focus has moved to developing plugins **natively for DSH** instead of
> maintaining a VS Code–compatible DSH client. The repository, README and all published
> releases stay online; the last release is **v1.5.10**. No further fixes or feature work
> will be made. Compatibility as of the last release: VS Code `^1.90.0`, Node.js `>= 24.9.0`,
> pnpm `>= 11.0.0`, DSH `0.1.7-rc.2` through `0.2.2-alpha.2` (last verified). Future DSH
> protocol changes may break the extension and will not be fixed. See below for details.

## 为什么停止维护

这是一个**产品方向调整**，不是代码质量或兼容性问题：维护者后续将精力转向**直接针对 DSH 开发插件**（DSH 原生插件形态），而不是继续维护一个「针对 VS Code 开发、兼容 DSH 协议」的客户端。

## 保留的内容

- 本仓库、`README` 和全部历史发布（GitHub Releases）**均保留**，不删除。
- 最后一个版本是 **v1.5.10**（2026-11-04），安装包、校验和与更新日志都仍可下载/查看：
  <https://github.com/Najabom/dsh_vsc_refresh/releases>
- 源码按 MIT 许可继续开放；欢迎自行 fork 继续维护。

## 对正在使用者的影响

- 已安装的版本**不会主动失效**；在下方验证过的 DSH 版本上，现有功能可以继续使用。
- 不再接受新功能、问题修复、issue 或 PR；DSH 后续若改动协议（RPC、事件、投影等），插件可能部分失效，**不会再跟进修复**。
- 建议：要么把 DSH 固定在验证过的版本，要么迁移到 DSH 官方/原生插件。

## 兼容性现状（截至 2026-11-04，最后版本 v1.5.10）

| 项目 | 要求 / 验证范围 |
| --- | --- |
| VS Code | `^1.90.0` |
| Node.js | `>= 24.9.0`（DSH 自身要求；扩展只检测，不代装） |
| pnpm | `>= 11.0.0`（DSH 插件管理的外部依赖，用户自装） |
| DSH | 实测 `0.1.7-rc.2`、`0.2.1-rc.4`、`0.2.2-alpha.2`（最后验证版本）；官方支持上限标注为 `< 0.2.3` |
| 平台 | Windows / macOS / Linux |

- DSH **0.2.2-alpha.2** 是最后完整验证的版本（接口契约 CI 覆盖 0.1.7-rc.2 → 0.2.2-alpha.2）。
- **更新于 0.2.3 及以上**的 DSH 未经验证；若其协议有变化，扩展可能无法连接或部分功能失效。
- 更细的兼容级别与能力组降级说明见 [docs/compatibility.md](docs/compatibility.md)。

## 安装最后一个版本（如果需要）

从 Releases 下载 `dsh-vsc-1.5.10.vsix` 后任选其一：

1. 命令行：`code --install-extension dsh-vsc-1.5.10.vsix`
2. VS Code → 扩展视图 → `...` → **从 VSIX 安装…** → 选择该文件

卸载扩展不会删除 DSH 数据（`~/.dsh`、会话历史、登录凭据），也不影响网页端使用。

## 致谢

感谢所有尝试、使用和反馈过这个插件的朋友。原项目 © 2026 zhibailu（MIT），本 fork 由 [Najabom](https://github.com/Najabom) 维护。
