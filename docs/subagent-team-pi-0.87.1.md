# Team 与最新 dev：Pi 0.87.1 整合

Team 分支先合入 `dev@8bb5470` 的 Responses WebSocket 与 pi-ai loader 修复，再合入最新 `dev@21981b3`：WebSocket 代理、grouped per-item Fast、Pi 0.87 canonical session history/compaction 和 0.87.1 依赖。此文记录 Team 交叉行为；[共享迁移说明](pi-0.87.0-migration.md)及[0.87.1 核查](pi-0.87.1-compatibility.md)仍按原始 dev 范围解释。[旧 Team 0.86 报告](subagent-team-pi-0.86.0.md)是历史证据，不代表此次验收。

## 适配要点

- Parent 与 child 的完整 native loader 路径在无扩展本地 pi-ai 的部署副本中分别注册 `subagent_team`、动态 Team helper 的私有 bind/unbind 命令与应用 ACK、工具及 Responses WebSocket provider。测试也检查声明和工具启停；不只测试 TypeScript 导入。
- 实际 Pi RPC coordinator A + workers B1/B2 通过本地 WSS loopback 执行 pause、wait、redirect、resume，B1/B2 原生终态后 A 才生成最终总结。B2 响应由测试闩锁在等待安全点，避免定时器自动释放导致虚假的“等待时轮询”失败。取消时无多余模型请求、连接和 lease 均收尾。provider fixture 只读当前 native transcript，不持有隐式模型侧跨轮记忆。
- WebSocket session cleanup 跟踪活跃 cached 与 overflow socket，并取消尚未完成的握手。旧 generation 不得在 cleanup 后发请求；同 session ID 的新 generation 可以重新连接。代理来源遵循 Pi 使用的 `getProxyForUrl` 约定：支持 HTTP(S) CONNECT 代理，**不支持 SOCKS**。loopback 测试清除代理变量并设置 `NO_PROXY`。
- Team durable delivery 重建遵守 0.87 canonical `context_edit`：null omission 不复活，替换使用最新内容，仍在 Team binding 及有界原生 branch 内恢复。0.87 tool continuation 会直接看见已写入的 custom message；旧 0.85 测试断言已改为“仅出现一次”，保留无额外 provider turn 与 writer 排序检查。
- Team 协调者轮间屏障仍保持 native terminal 之后总结，shutdown/delete 会在等待排队维护操作前中止 parked operation。0.87 subagent 结果把 child 原生 usage 作为 nested tool usage 回传，错误结果恢复最后一次流式 details；grouped worker item 的 Fast policy 通过预检并传给 child，grouped 顶层 Fast 仍在入队之前拒绝。
- Native GPT compaction 的修复切点基于 canonical projection 查找 checkpoint 后首条仍存在的记录；Team 和共享 dev 压缩行为均在本次测试中验收。

## 验证范围

本次使用临时 HOME 与 `PI_CODING_AGENT_DIR`，`PI_OFFLINE=1`、`PI_TELEMETRY=0`、npm offline。四个仓库 Pi 依赖安装版本均为 **0.87.1**；检查使用原生 bundle CLI 和本地模拟 provider，不调用付费模型。提交前隔离门禁：`npm_config_offline=true npm run check` 类型检查通过且 **873/873 tests** 通过；`PI_SUBAGENT_DEPTH=1 npm_config_offline=true npm test` **873/873 tests** 通过；两套均无失败、取消、跳过或 todo。`git diff --check` 和 staged diff check 均通过。验证日志位于本机临时目录 `/tmp/team087-release.bBzFJs/`，不是运行依赖。

尚未在 Windows、真实外部模型或交互 fullscreen TUI 实测；本地 WSS 服务器只验证真实 native 子进程与协议流程，不验证外部服务的语义质量。此次只创建本地提交，不推送或改动 `dev` 工作区。
