# Team Actor v2：协议与阶段性交接

> **D1 Team 父层入口、session lifecycle 接线、结果分页和成员级 Broker 路由已进入当前实现；仍处于父级审查，不应据此视为发布验收完成。** `subagent_team` 使用 Manager/worker prepare→launch；Team 专属 100 场景/I01–I30 矩阵并未在本轮宣称通过。
>
> `pi-rail-ui-team-actor-development-spec.md` 是完整目标，本文不替代它，也不缩减其契约。当前离线证据包括 Runtime、真实 Pi 合成 provider、实际 SessionBroker/TeamMemberDriver 成员 stop/delete、index 注册 lifecycle hooks、历史 round-trip 及普通 subagent 回归。

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

旧 v1 实时机制（`team-hub.ts`、`team-runner.ts`、`team-extension.ts`、`team-rpc.ts`、`team-protocol-v1.ts` 及其专属测试/fixture）已在 D2 删除；只有 `team-history.ts` 把旧 `rail-subagent-team` 快照只读映射为 legacy（未完成者显示 interrupted），不恢复任何 live 状态。

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

宿主另有非模型 HostControl：`cancel_team`、`release_hold`、`message_manager`、`grant`，不会伪装成 Manager。

## 执行预算、usage 与 journal（C2）

`TeamBudget`（`team-budget.ts`）是计数器的唯一归属，WorkLedger 仍是 work 的权威；计数从 launch 起只增不减，revise/yield/新 ID/新 root/idle 都不重置。每次 activation 在预留时计入 Team/Manager/root activation；provider gate 每放行一次（含 Pi 可观察的自动重试、暂停恢复后的放行）计一次模型请求；每个真实 native toolCallId 在 tool gate 放行时计一次工具调用（含随后业务校验失败的 reply/yield/close_team），同一 ID 重复预检不重复计数，被预算拒绝的尝试不计。工具额度耗尽后，每个 activation 仍放行并计入**一次**结束意图尝试，使合法 reply/yield/close_team 能收尾；之后的任何工具尝试被拒，且下一次 provider 请求以 `budget` 停止，重复的无效结束意图无法绕过预算。

每个 ActivationInput 带 `budget` 摘要：`modelRequests`/`toolCalls` 为本 activation 在 activation、root、Team 限额中最紧的剩余值，`activations` 为该作用域在本次之后还可预留的 activation 数（work 取 root/Team，管理取 Manager/Team，紧急取剩余紧急额度），`emergency` 与 scope 一致。

- 运行中命中上限：拒绝下一次 provider/tool，已发出的步骤正常收尾；该 activation 以 `budget_hold` 结束，未暂存意图的 WorkRef 变为 `blocked`/`budget`，成员不 faulted，不是协议错误。暂停与预算互不绕过：恢复停驻的 gate 仍需通过预算。
- 预留时耗尽：work 直接 hold。incident 按作用域去重：root 耗尽为该 root 一条（`rootId`，无 `work`），Team 耗尽为一条 Team 级。root 耗尽不影响其他 root。
- Manager/Team 耗尽：最多 `emergencyManagerActivations`（默认 3）次紧急管理 activation，输入 `emergency: true`，只允许 status、cancel_work、accept_result、close_member、close_team、yield，其余返回 `BUDGET_BLOCKED`；紧急 activation 单独计数，仅受单 activation 步数限制。用完后不再自动调用 Manager，仅宿主可 grant/cancel。只阻塞于预算、不持有 work 的 `BUDGET_HIT` 不阻止 succeeded close。
- `HostControl.grant(scope, increments, reason)`：scope 为 Team 或已知 root（无 parent 的 work）；增量为正安全整数；Team grant 只接受 Team 计数器（teamActivations、managerActivations、teamModelRequests、teamToolCalls、emergencyManagerActivations），root grant 只接受该 root 的计数器（rootChildren、rootActivations、rootModelRequests、rootToolCalls）；reason 必填（≤512 字节）。先完整校验（每个增加后的有效上限不超出安全整数）再写 journal，最后应用，任一字段失败时整体拒绝、无任何副作用；actor 固定 `@host`，root grant 只影响该 root，计数器不重置。之后只重新排队预算不再耗尽的 budget hold，并解除对应 incident；attention/protocol/pause/Manager 故障 hold 不受影响。Team 非 active 时拒绝。
- A09：已暂存结束意图后若有第三方/原生 continuation 请求 provider，Runtime 保持 settling，放行并计数（受单 activation 模型请求限制），首次记录一条已解决的 `POST_INTENT_CONTINUATION` 诊断 incident（不通知 Manager、不影响 health），工具和业务动作仍被拒绝；预算中止该 continuation 时，已在 transcript 确认的意图照常提交。不会自动 prompt 或重发。

usage 由 `team-rpc-v2` 以 `RunResultCollector` 只收集本次 send 的 native 事件，`agent_settled` 时冻结并随 `NativeCompletion.usage` 上报；send 在 settle 前失败时冻结已观察到的部分 usage，放在 `TeamActivationFailure.usage`，driver 转交 `activationLost(..., usage)`。Runtime 对一个 activation 只累加一次（settle 与 lost 互斥：已 settle 的不能再按 lost 计费，已隔离的迟到 settle 被拒绝；重复报告幂等；格式错误的 lost usage 不计费也不阻止隔离），`contextTokens` 取最近非零值而不求和；取消/中止的 activation 保留其真实成本。

公开 team view 是有界摘要，保证放入一个 1 MiB 私有 reply 帧：`incidents` 最多 32 条（先 open 后最近 resolved，`incidentsOmitted` 计余数），`budget.roots` 最多 32 个（先耗尽、再有 grant、再有使用，`rootsOmitted`），`budget.grants` 为最近 16 条（`grantsOmitted`）。Manager 的 work/result/incident 查询使用分页 status；完整 ResultRecord 通过显式 resultRef 获取。父层 `subagent_team status` 只返回有界 resultRef 页，`/rail-team budget` 可检查全部 root 预算。Team view 中被截断的 root 预算明细由该宿主命令读取，不作为模型动作。incident 消息、成员错误和 Team reason 超过 4 KiB 时截为预览。

`TeamRuntimeOptions.journal` 接收 `TeamJournalGeneration`（`team-journal.ts`）。同步写入的仅为有界历史事实：launched、result（提交前）、revise/cancel 决定、close_decision、grant、terminal；gate/ACK/status/cleanup 不写，也不序列化整个账本。写入失败时 fail closed：launch 保持 prepared；结果版本为 `failed`/`JOURNAL_FAILURE` 且不发布；决定和 grant 不生效；Team 在安全点转为 failed；terminal 写失败时报告 failed 而非 closed。generation 可永久 `deactivate()`，之后写入均失败。`TeamSessionHost` 将 generation 接入当前 session branch；tree/switch/shutdown 会先尝试写 interruption marker，再封存 writer，并等待原生资源清理。marker 写失败会记录可见的 host diagnostic，不伪装为 durable success。

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

## D1 当前入口与行为边界

`subagent_team.prepare` 校验 Manager/worker、brief、initialRequests 和所有固定策略；通过后不启动 native member/provider。`launch` 由 `TeamMemberDriver` 打开每个持久成员的原生 lifetime，再启动 Runtime effect drain，并等待整个 Team 终止；`runNext` 只保留为纯/手动测试 seam。宿主可通过非模型 `HostControl` 与 `/rail-team` 发起 `cancel_team`、`release_hold`、`message_manager`、grant/resume 等操作；Manager pause/resume、精确 `resume_work`、激活级取消/修订、deadline 和 Manager fault 停驻均由 Runtime 管理。

`TeamMemberDriver.stopTeam` 是 Team host 使用的有限停止接口。对已启动 lifetime 发起宿主取消；对尚未 launch 的 prepared Team 直接取消（不启动 provider、初始请求记为 cancelled），只关闭经 `claimNativeLifetime` 实际签发过的成员 lifetime（含仍在打开中的），未签发的成员不持有资源；关闭失败保留为 `cleanup_failed`，不报告虚假释放。取消后的 Team 不能再 launch 或打开新成员，需要新 prepare。成员 alias 对应的 persistent session/descriptor 在关闭后保留为历史，Broker 不允许新 Team 复用已有同名 session（固定新成员约束）；重新 prepare 时应选择新的 alias。

Broker handle 的 `close()` 只在原生进程退出被确认后才释放 Team 所有权，并返回 `{ protocolError? }`：私有 unbind 失败或成员此前已被终止/transport 故障时，资源已释放但结果带 `protocolError`，Runtime 记为 faulted/released（close_team 期间 Team 为 failed），绝不记为正常 closed。退出未知时 `close()` 拒绝并保留所有权；迟到的退出只在下一次明确的清理重试（`TeamMemberDriver.close`/`closeMember`）时按事实释放，不自动重试或重开，driver 随即以 `TeamRuntime.memberExitConfirmed(binding)` 让 Runtime 从 `cleanup_failed` 更新为 `released`；该 API 只接受同一 lifetime 的 faulted 未知退出成员，不改变工作结果或 outcomeUnknown 记录。宿主取消/停止释放 faulted 成员仍持有的资源时，成员保持 `faulted`（资源为 `released`），不会改写为正常 `closed`。已确认退出的故障成员由 driver 立即释放 Broker 所有权（保留 session/descriptor 历史），此后只允许用户明确以普通 subagent 打开其历史，Team 不会复用该 handle；宿主取消不会对它再次执行关闭。`TeamMemberDriver.close()` 会取消仍 active 的已启动 Team 并等待 native cleanup。

`/rail-agent` 面板的 Stop/Delete 操作经 `SessionBroker` lifecycle route 进入对应 Team host：worker stop 只结束其自身 assigned work/owned children（active work 记 `outcomeUnknown`），siblings 和其它 Team 保持运行；Manager stop 记录 `MANAGER_UNAVAILABLE`、hold Manager work 并暂停 worker，而非隐式 cancel Team。delete 必须等 member exit 明确确认并释放 ownership 后才可删除 session/descriptor。whole-Team shutdown/branch transition 使用独立 Team scope，不能复用 member stop 语义。

真实 Pi 合成 provider 测试位于 `tests/subagent/team-member-driver.test.ts`，Responses WebSocket 合成测试位于 `tests/subagent/team-websocket-integration.test.ts`。它们使用本地离线 provider/loopback，不需要真实付费模型 API。

## 当前剩余与验证边界

- 当前 focused tests 覆盖本次父审查列出的 abort 时序、成员 stop/delete 隔离、Manager unavailable、index 生命周期 hook、journal codec round-trip、结果分页和 N09 策略 drift；这不等同于完整 Team 验收矩阵。
- **100 场景及 I01–I30、seed/trace 性质测试、原生 context_edit 和完整取消竞态尚未在本轮作为整体验收执行或宣称通过。** 历史 C1a/C1b 报告也不能替代当前工作树的验证结果。
- v1 Team inbox/wait/finish 操作已退役；历史记录只读，不能恢复旧 Promise 或复用旧实时调度器。

测试清理仍需持续检查：定向测试通过不代表所有真实 provider 决策质量、所有外部进程故障模式或完整验收矩阵都已验证。
