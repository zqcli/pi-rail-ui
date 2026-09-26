# Team Actor v2：协议与阶段性交接

> **底层 Runtime/driver 的 C1b 控制与安全结算已落地；Team 用户入口仍未迁移，不是可发布功能。** `TeamMemberDriver.launch` 现驱动完整 Team lifetime；旧 `subagent_team` 入口和 D 层父级 stop/delete/UI 路由尚未迁移，Broker 仍拒绝旧 v1 dispatch。
>
> `pi-rail-ui-team-actor-development-spec.md` 是完整目标，本文不替代它，也不缩减其契约；C1b 的离线验证包括 Runtime/fake-latch、真实 Pi 合成 provider 与现有普通 subagent 回归。

## 对象和权威状态

- **Member** 持有稳定 alias、角色、私有 epoch、Broker-owned 原生 Pi session。请求完成不代表成员关闭。
- **WorkRequest** 是可执行消息本身。`WorkLedger` 保存 WorkRecord、版本、父子关系、依赖及不可变 ResultRecord；UI 事件尾部不是义务的来源。
- **Activation** 是一次原生 send，精确绑定 WorkRef 或管理事件批次。同一成员从预约到 settlement、reset、deactivate 完成都只允许一个 activation。
- **Delivery** 精确标识本次公开输入。activate ACK 仅证明安装，不能冒充 `input_ready`。

当前主实现文件：

| 文件 | 当前职责 |
| --- | --- |
| `tools/subagents/team-protocol.ts` | v2 类型、容量与预算默认值、公开/私有协议 |
| `tools/subagents/team-codec.ts` | JSON/字段/字节校验、动作规范化、Team 工具 schema |
| `tools/subagents/team-work-ledger.ts` | WorkRef、结果索引、父子约束与等待图 |
| `tools/subagents/team-runtime.ts` | 同步接受、预约、交付、暂存意图、结算、修订、取消和条件关闭 |
| `tools/subagents/team-member-driver.ts` | 原生 lifetime handle 与 Runtime 预约之间的执行桥 |
| `tools/subagents/team-rpc-v2.ts` | bind/activate/reply/deactivate/unbind、ACK、局部幂等及 native 证据 |
| `tools/subagents/team-extension-v2.ts` | 原生 custom input、Team 工具、sole batch 核验、gate、禁止预热 |
| `tools/subagents/session-broker.ts` | 独占 member handle，阻止普通调用插入 lifetime |

`team-protocol-v1.ts` 与旧 hub/runner/extension/RPC 仍是迁移遗留，**并非已经实现“历史只读兼容”**。最终入口迁移后必须删除旧实时机制，不能同时运行两套调度器。

## v2 公开动作

以下是模型工具动作形状，不是已经可用的父层 launcher：

```json
{"action":"request","to":"review","task":"审查当前变更","inputRefs":[]}
```

在管理 activation 中创建 root；在 work activation 中创建 owned child。请求身份、parent/root/depth 来自绑定，不由模型提供。接受立即返回 WorkRef，不等待收件成员。

```json
{"action":"reply","result":{"status":"succeeded","summary":"审查结果","evidence":[{"source":"local test","basis":"verified"}]}}
```

只对应当前 WorkRef。没有未完成 child 且必要 child outcome 已交付后才可 stage。`staged` 不是已提交。

```json
{"action":"yield","waitingFor":[{"workId":"宿主返回的ID","revision":1}],"checkpoint":"收到依赖结果后继续"}
```

work 必须有具体依赖，或使用 `attention` 与 checkpoint；不允许无生产者的空等待。管理 activation 可空 yield。成功 yield 结束一次原生运行，不结束成员。已经交付的相同 outcome 不能制造新唤醒。

```json
{"action":"status","view":"result","id":"宿主返回的resultRef"}
```

只读查询不确认 child outcome 已经交付，不推进业务状态。

```json
{"action":"control","command":"close_team","resultRefs":["宿主返回的resultRef"],"outcome":"succeeded"}
```

Manager-only 控制还包括 pause/resume、修订、取消、resume_work、验收和成员关闭。暂停只在 provider 安全点确认：已获准工具先完成，未获准工具被拒绝；native activation 停驻期间仍归原 WorkRef 所有并释放 worker permit。恢复先重新取得 permit，再放行同一有效 WorkRef；等待 permit 期间再次 pause 会撤销该恢复。不会解除依赖或预算 hold。已暂存的 reply/yield 在暂停请求下照常提交，不被中止。peer 等待仍必须显式 yield，不能用 pause 停驻。

`resume_work` 与宿主 `release_hold` 只解除当前 WorkRef 上精确 incident 的 `attention`/`protocol` hold；`budget` 返回 `BUDGET_BLOCKED`，`manager_unavailable` 被拒绝；该版本仍有 native activation/settling 或旧清理未确认时拒绝；Manager 不可用时宿主也不能解除任何 hold，以免绕过故障安全暂停。所有拒绝在修改账本前完成。

修订/取消（含宿主整队取消）先向 native 发送 activation-only abort，再等待 settled 与清理，不等待已获准工具自行结束；超过 `activationStopTimeoutMs` 仍未收敛时，driver 终止该成员的原生进程，由该次 send 以真实退出结果报告（确认退出为 faulted/released，未确认为 cleanup_failed 并保留所有权）。真实 provider error/length 优先于任何控制标志分类为 `native_failure`。close_team 已提交后的宿主取消保持关闭决定，不中止 Manager 的收尾，只为其加上同一停止期限。

宿主另有非模型 HostControl：`cancel_team`、`release_hold`、`message_manager`，不会伪装成 Manager；预算 grant 留待后续阶段。

## 原生输入及提交边界

当前路径为：

1. lifetime `bind`，每次运行前 `activate` 安装 scope/delivery/public input。
2. 发固定无业务正文的 native trigger prompt。
3. `before_agent_start` 返回 `rail-team-activation` custom message，通过 Pi writer 进入分支。
4. receiving context 核验公开消息与 canonical branch 的来源，精确发送 `input_ready`；provider/tool gate 受 Runtime scope 约束。
5. reply/yield/close_team 核验最终 assistant 批次的唯一工具调用，成功工具结果返回原生 `terminate:true`。
6. 使用本次最后真实 assistant/工具结果及 `agent_settled`；随后等待 context reset、deactivate 和 send 清理，再提交结果或等待意图。

ACK 超时只约束私有命令，不给正常业务运行附加五秒期限。连接没有自动重连/工具重放。重复请求在有限缓存内幂等，pending 不被已完成项挤掉。

正常资源关闭保留 persistent session 和 descriptor。未知 exit 不能作为 ownership 释放证据。Manager 只装载 Team 工具；worker 保留已有允许的基础工具但禁用递归 subagent；绑定期间停用 cache warming，不修改全局设置。

## 当前只可用于底层开发验证

`TeamMemberDriver.launch` 绑定全部 native member 后启动 Runtime effect drain，并返回等待已确认 Team 关闭/取消的 lifetime Promise；`runNext` 只保留为纯/手动测试 seam。宿主可通过非模型 `HostControl` 发起 `cancel_team`、`release_hold`、`message_manager`；Manager pause/resume、精确 `resume_work`、激活级取消/修订、deadline 和 Manager fault 停驻均由 Runtime 管理。

`TeamMemberDriver.stopTeam` 是 D 层可调用的有限停止接口。对已启动 lifetime 发起宿主取消；对尚未 launch 的 prepared Team 直接取消（不启动 provider、初始请求记为 cancelled），只关闭经 `claimNativeLifetime` 实际签发过的成员 lifetime（含仍在打开中的），未签发的成员不持有资源；关闭失败保留为 `cleanup_failed`，不报告虚假释放。取消后的 Team 不能再 launch 或打开新成员，需要新 prepare。成员 alias 对应的 persistent session/descriptor 在关闭后保留为历史，Broker 不允许新 Team 复用已有同名 session（固定新成员约束）；重新 prepare 时应选择新的 alias。

Broker handle 的 `close()` 只在原生进程退出被确认后才释放 Team 所有权，并返回 `{ protocolError? }`：私有 unbind 失败或成员此前已被终止/transport 故障时，资源已释放但结果带 `protocolError`，Runtime 记为 faulted/released（close_team 期间 Team 为 failed），绝不记为正常 closed。退出未知时 `close()` 拒绝并保留所有权；迟到的退出只在下一次明确的清理重试（`TeamMemberDriver.close`/`closeMember`）时按事实释放，不自动重试或重开，driver 随即以 `TeamRuntime.memberExitConfirmed(binding)` 让 Runtime 从 `cleanup_failed` 更新为 `released`；该 API 只接受同一 lifetime 的 faulted 未知退出成员，不改变工作结果或 outcomeUnknown 记录。宿主取消/停止释放 faulted 成员仍持有的资源时，成员保持 `faulted`（资源为 `released`），不会改写为正常 `closed`。已确认退出的故障成员由 driver 立即释放 Broker 所有权（保留 session/descriptor 历史），此后只允许用户明确以普通 subagent 打开其历史，Team 不会复用该 handle；宿主取消不会对它再次执行关闭。`TeamMemberDriver.close()` 会取消仍 active 的已启动 Team 并等待 native cleanup。**目前 SessionBroker/root/UI 的 stop/delete/shutdown 尚未接到该路由**，不得直接操作 Team-owned native member；这是入口迁移剩余工作。

真实 Pi 合成 provider 测试位于 `tests/subagent/team-member-driver.test.ts`，Responses WebSocket 合成测试位于 `tests/subagent/team-websocket-integration.test.ts`。它们使用本地离线 provider/loopback，不需要真实付费模型 API。

## 后续必须完成

### C1b 剩余边界

- D 层需将 Team-owned `stop/delete/shutdown` 路由到 `TeamMemberDriver.stopTeam`；该接口现有，但父级 lifecycle 和 UI 尚未接线。

- Host budget grant API、预算增加/审计策略及全量 root/activation model/tool usage 计数仍未提供。budget hold 不能由 `resume_member`、`resume_work` 或 `release_hold` 隐式清除。
- 旧 C1a validation report 属于此前阶段，不能代替本工作树的全量测试结果或视为剩余项已完成。

### D：入口及最终验收

- 新 manager/roleDescription/initialRequests prepare，固定并验证真实策略；launch 入口替换。
- `/rail-team`、成员 stop/delete 路由、UI、历史只读兼容、session tree/reload。
- 删除旧总结 continuation、finish/afterSeq/parked peer wait/stall 路径，更新旧文档和 README。
- 完成 100 场景及 I01–I30 的对应测试，包括 seed/trace 性质测试、原生 context_edit 和完整取消竞态。

测试清理仍有需要改进的地方：部分 harness teardown 捕获并忽略清理异常，不能据此宣称全部资源都已验证收敛。具体限制见验证报告。
