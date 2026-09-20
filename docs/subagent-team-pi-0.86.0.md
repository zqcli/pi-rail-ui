# Team 分支：Pi 0.86.0 适配与验收

## 结果与基线

- 日期：2026-09-20。
- 工作分支：`feat/subagent-team-coordination`，迁移前为 `9f04f9f`。
- 合入最新 `dev@d73de73`，保留 Team 历史与公共协议；共同基点为 `b93d171`。
- 四个 Pi 包精确固定为 `0.86.0`，在 Team worktree 执行 `npm ci --ignore-scripts --no-audit --no-fund` 后验证。
- 最终类型检查通过；普通与 `PI_SUBAGENT_DEPTH=1` 两套完整测试均为 **832/832 通过**，没有失败、取消、跳过或 todo。
- 实现与独立审查使用 grouped `cus-resp/deepseek-v4-flash:max`，按文件划分所有权；父会话负责合并、核验和本地提交。

[共享 Pi 迁移报告](pi-0.86.0-migration.md) 中的 659/659 是原 compat 分支记录，不是 Team 合入后的成绩。[初始 Team 方案](subagent-team-plan.md) 和[交付记忆修复报告](subagent-team-delivery-regression.md) 中的 0.85.1 及旧验收数字保留为历史记录。

## 实现范围

### 共享迁移

从 dev 保留 provider `TranscriptContext` 类型、system/tool declaration 重建、真实工具结果配对、native history 的 system snapshot 边界、remote-to-native repair、模型级预算与 project trust、独立 usage 及工具 usage 统计修复。不重新实现原生 TUI、agent loop、RPC、session writer 或 compaction。

### Team 与新版生命周期的整合

- `rpc-worker.ts`：保留 Team bind/ACK、每轮 unbind 和失败清理，同时合入实际模型预算验证、模型切换互斥及 contextWindow 规范化。预算 prepare 之前绑定 Team，prepare 失败仍清理绑定并 fail closed。
- `session-broker.ts`：保留 coordinator 的完整续轮操作、组合取消信号及累计 usage；模型变更不能插入两轮之间。显式预算按实际 child cwd/model/trust 预检，并在操作队列内复核。
- `tool.ts`：自动合并后的预算模型固定逻辑同时适用于 Team，异步预检前选择的模型也用于实际 dispatch。
- shutdown 在等待排队 maintenance 之前取消 Team 操作，并先停止活动 worker，避免 coordinator 停在轮间结果屏障时无法退出。
- delete 同样先取消对应 Team 操作，再等待已有 maintenance 收敛，最后清除会话、descriptor 和 roster link，避免等待排队模型变更造成死锁或删除后的状态复活。

shutdown/delete 的轮间等待问题均有先失败后通过的有限回归。删除路径在修复前触发 2000ms 测试超时，修复后正常完成；没有吞掉超时或放宽断言。

### Team 专属测试迁移

- Provider fixture 使用 `getCurrentSystemPrompt(context.messages)` 和 `getCurrentTools(context.messages)`，不再读取旧的顶层字段。
- Native parent 的 `AgentContext` 使用 transcript system message，而不是已移除的 `systemPrompt` 属性。
- Team 集成测试使用包的 `dist/bundle/cli.js`，与已安装 CLI、其余 native 测试及版本匹配的启动说明一致。0.86.0 的 unbundled `dist/cli.js` 加载 Pi AI 子路径导入时存在 alias 路径问题，不将该入口列为本次验收支持路径。
- 保留 provider 实际收到 Team guidance 与工具 schema 的强断言。记忆回归每轮只依据实际 provider context 与成功的原生工具调用，不使用外部 Map 或 step 计数代替模型记忆。
- 新增 8 项交叉回归，覆盖 Team 绑定与模型预算、双向模型切换互斥、失败清理、续轮排队、shutdown/delete 和预算随模型变更。

## 验证证据

Node `v24.15.0`，实际安装的 `pi-coding-agent`、`pi-agent-core`、`pi-ai`、`pi-tui` 均为 `0.86.0`。最终命令使用清空继承环境后的临时 HOME/agent 目录，启用 `PI_OFFLINE=1`、`PI_TELEMETRY=0` 和 npm offline，不读取个人 Pi 设置。

| 检查 | 实际结果 |
| --- | --- |
| `npm run check` | 类型检查通过；832 tests / 28 suites，832 passed |
| `PI_SUBAGENT_DEPTH=1 npm test` | 832 tests / 28 suites，832 passed |
| failed / cancelled / skipped / todo | 两套均为 0 |
| 测试耗时 | 普通与 depth-1 均约 30.2 秒，不含类型检查 |
| `git diff HEAD --check` | 通过 |

最终本机日志：

- `/tmp/rail-team086-final.zlw36c/check.log`
- `/tmp/rail-team086-final.zlw36c/depth1.log`

这些临时路径仅记录本次证据，不是仓库运行依赖。早期 RPC 聚焦验证曾用临时 stub 隔离尚未解决的 broker 冲突；上述最终两套测试均使用真实合并后的模块，没有该 stub。

### 关键覆盖

- 真实 Pi bundle 子进程的 1A+8B 依赖等待与全 worker 结果屏障。
- pause 确认、redirect 不解除暂停、显式 resume，以及取消和 lease 清理。
- READY/PAUSED 等自动交付跨无关工具轮次及 native compaction 的持久化、恢复、去重与生命周期隔离。0.86.0 下仍不能把临时 context transform 当作持久历史；原生 custom message 与 branch 恢复路径继续保留。
- ACK、private command 在工具等待期间的处理、原生 retry 与 `agent_settled`。
- Team 临时 64K context window、native compaction 落盘及后续恢复到 128K。
- 真实 native repair、工具声明变更、system snapshot 恢复及 usage 累计；broker/RPC 队列交叉行为另有明确的 fake worker/transport 单元测试。

## 使用与验证边界

- 目标支持版本是 Pi **0.86.0**，未保留 0.85.1 双版本兼容层。
- 版本匹配的启动入口为 `node node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`，或相同版本的全局 `pi`。升级 runtime 后应启动新进程，不能靠旧进程内 `/reload` 完成升级。
- 自动验收使用本地 mock provider，不代表真实外部模型的协作决策质量、OpenAI/Codex 远端接受情况或真实缓存预热计费。本轮没有额外进行付费模型的 A/B1/B2 Team 在线验收，也未进行人工 iTerm2 长会话测试。
- 没有修改全局 Pi、用户配置、凭据或已有用户会话；没有推送。本次正常创建的开发助手会话与隔离测试产物不属于这些已有会话。
