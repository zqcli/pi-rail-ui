# Team Actor v2：协议、状态与宿主控制

本文描述当前实现（Pi 0.87.1）的 Team 行为。约束来源是 `pi-rail-ui-team-actor-development-spec.md`；实测证据与 100 项验收映射见 [验证报告](subagent-team-actor-validation.md)。旧 v1 实时机制（coordinator、inbox/wait/finish、afterSeq、成员终态屏障、全员 idle 两秒失败）已删除；旧 Team 文档均标为 legacy。

## 1. 对象

| 对象 | 含义 |
| --- | --- |
| Member | 稳定 alias、角色（`manager`/`worker`）、私有 epoch 和 Broker 独占的原生 Pi session。完成工作不退出；idle 期间仍由 Team 持有所有权。 |
| WorkRequest | 可执行消息本身。`WorkRef = {workId, revision}`，ID 由宿主分配；一项工作可以修订，同时只有一个当前版本。 |
| Activation | 为一个 WorkRef 或一批 Manager 事件进行的一次原生 send。同一成员从预约、运行、收尾到清理，同一时间只允许一个 activation。 |
| Delivery | 一次 activation 输入的交付记录；activate ACK 只证明安装成功，只有 `input_ready` 才标记 delivered。 |
| ResultRecord | 不可变结果（`resultRef`），关联 WorkRef 和作者；作者关闭后仍可读取。 |

权威状态只在 `TeamRuntime`（同步状态机）中；driver、UI 和 journal 都不直接修改账本。

## 2. 父层工具 `subagent_team`

动作：`prepare`、`launch`、`status`、`cancel`。未知字段会被拒绝；声明为可选的字段可以传 `null`，与省略等价。

```json
{"action":"prepare","manager":{"alias":"lead","roleDescription":"分配、验收、处理阻塞并关闭；不写最终报告","model":null,"cwd":null,"fastMode":null,"contextWindow":null},"workers":[{"alias":"review","roleDescription":"审查实现"},{"alias":"writer","roleDescription":"根据结果引用撰写报告"}],"brief":{"goal":"审查当前变更并提交有证据的报告","acceptanceCriteria":["标明未验证项"],"constraints":["不访问生产系统"]},"initialRequests":[{"to":"review","task":"审查本地变更","inputRefs":[]}],"timeoutSeconds":null}
```

- `manager` 和每个 worker 的字段为 `{alias, roleDescription, model?, cwd?, fastMode?, contextWindow?}`。Search 属于宿主策略，不是参数。旧字段 `coordinator` 会被拒绝，并返回迁移说明。
- `brief.goal` 必填；可选 `target`、`acceptanceCriteria`、`constraints`、`authorizations`。authorizations 只声明任务范围，不授予操作系统权限。
- `initialRequests` 最多 8 条，只能指向 worker，`inputRefs` 必须为空或省略（新 Team 还没有结果可引用）；runtime 把 requester 设为 Manager，`rootId` 设为 `workId`。只有角色描述、没有初始工作的 worker 合法，在被分配工作前不会产生 provider 调用。
- `timeoutSeconds` 为 `null` 或省略表示没有总截止；取值为 (0, 86400] 内的有限数字，从 launch 开始计时，到期按 `DEADLINE` 走取消流程，不会报告为成功。
- prepare 固定真实的 model、cwd、Fast/Search 和 contextWindow/compaction reserve，不启动 provider 或工具。launch 前再次核对，策略漂移时拒绝并保留 prepared Team。开始创建成员后，bind 或启动准入失败（包括 launched journal 写入失败）会将本次 Team 标为 failed 并清理已认领资源，不自动重试；已有的用户取消、宿主中断或 Manager 关闭决定优先保留。启动原错与资源退出失败分别诊断，未知 exit 继续保留 ownership。

```json
{"action":"launch","teamId":"<teamId>"}
```

launch 会等所有成员资源创建并绑定完成后才开放执行；它的 Promise 覆盖整个 Team 生命周期，结束时返回 `TeamResult`。中止等待 launch 不会取消 Team。`status` 可以按 `cursor` 分页列出 result ref，也可以用 `resultRef` 读取一条完整 `ResultRecord`，两者不能同时给。`cancel` 需要 `teamId`，`reason` 可选。

## 3. 成员工具 `team`

这是一个判别联合，只在 Team 绑定期间可用。Manager 只装载 `team`；worker 保留宿主允许的基础工具，但不能使用 `subagent` 和 `subagent_team`。旧动作 `send`/`report`/`wait`/`finish`/`afterSeq`/`supersedes` 会返回迁移错误。

```json
{"action":"request","to":"review","task":"核对错误路径","inputRefs":[]}
```

`request` 会同步写入账本，并返回 `receipt {status:"accepted", work, recipient}`，不等待接收者运行。在管理 activation 中创建 root；在工作 activation 中创建从属 child，parent、root 和 depth 由绑定推导，模型无法指定。不允许自请求。

```json
{"action":"reply","result":{"status":"partial","summary":"已核对主路径","evidence":[{"source":"npm test","basis":"verified"}],"limitations":["未做在线验收"]}}
```

`reply` 只针对当前 WorkRef，返回 `receipt.status = "staged"` 和 `terminate:true`。只有在原生 `agent_settled`、工具结果证据和清理都确认后才提交；存在未完成或尚未交付的 child 时分别返回 `UNRESOLVED_CHILDREN` 或 `UNOBSERVED_CHILD_RESULTS`。

```json
{"action":"yield","waitingFor":[{"workId":"team-1:work:abc","revision":1}],"checkpoint":"收到结果后继续"}
{"action":"yield","attention":"需要 Manager 决定范围","checkpoint":"已完成步骤 1"}
{"action":"yield"}
```

- 等待具体依赖或请求 attention 时 checkpoint 必填；`waitingFor` 与 `attention` 互斥。
- 空 `yield` 只允许用在 Manager 的管理 activation。Manager 不在运行中等待：派发后直接 `yield`（只带可选 checkpoint），新的结果、失败和 incident 会自动开启下一次管理 activation；不要用 `status` 轮询等待。管理 activation 的输入 notice 和带 `waitingFor` 的 Manager yield 错误都会给出这条指引。尚未交付给当前管理批次的 Manager 事件会阻止 `close_team`（blocker 提示先 yield 接收再关闭）。
- 成功的 yield 会结束本次原生运行，不占住成员。
- 结果早于 yield 到达也不会丢；下一次 activation 交付可容纳的 outcome 批次，超出部分保持未交付，后续 yield 可继续观察。
- 对已交付且没有变化的 outcome 再次 yield，返回 `NO_NEW_DEPENDENCY`。
- 依赖同伴结论：worker 做到一半需要另一成员的结论时，有三条路径，work activation 的 notice 会写明。(1) 用 `status(work)` 找到对方的 WorkRef，直接 `yield {waitingFor, checkpoint}`，结果提交后自动唤醒并在 `outcomes` 中收到；(2) `request` 该成员创建 child，再等待返回的 WorkRef；(3) `yield {attention, checkpoint}` 请 Manager 处理。Manager 收到 `WORK_HELD` 后用 `resume_work {workId, expectedRevision, incidentId, instruction}` 在 instruction 里给出所需 resultRef 或 WorkRef，管理 activation 的 notice 同样写明这一点。恢复的 activation 带原 checkpoint 和 instruction，全文用 `status(result)` 读取。
- 依赖环（包括 parent 对 child 的完成约束边）返回 `DEPENDENCY_CYCLE`。

```json
{"action":"status","view":"result","id":"team-1:result:def"}
```

`status` 是只读查询：`view` 省略或为 `team` 时只接受 `limit`；`work`/`result`/`incident` 可以带精确 `id`，或带不透明的 `cursor` 翻页（二者只能选一）；`limit` 默认 20、最多 50。它不推进状态，也不代表 child 结果已被 parent 观察。worker 查询他人的 work 只得到摘要（状态、任务预览、resultRef），完整依赖与观察记录只对 assignee 和 Manager 可见。`inputRefs`、`resultRefs` 只接受 result ID（`result:…`）；误传 work ID 时，`UNKNOWN_RESULT` 会给出该 work 当前的 result ID。

从属 children 的公开列表是预览，不是完成义务的完整集合：activation 的 `ownedChildren` 最多 8 项，`ownedChildrenOmitted` 表示未展示数量；work 详情的 `children` 最多 64 个 WorkRef，`childrenOmitted` 表示其余数量。宿主 grant 可以增加 root 的 child 创建预算，但不会扩大这些展示上限。需要完整枚举时，调用 `status {view:"work", limit:50}`，随后按返回的 `cursor` 翻至 `hasMore:false`，筛选摘要中 `parent.workId` **和** `parent.revision` 都等于目标父 WorkRef 的条目，读取其 `work`。不要只按 workId 匹配，也不要把预览当作完整 children；Runtime 的完整父子义务仍只在 ledger 中。

`control` 只限 Manager，字段是扁平的：

```json
{"action":"control","command":"revise_work","workId":"team-1:work:abc","expectedRevision":1,"task":"改为只审查 codec","inputRefs":[]}
{"action":"control","command":"accept_result","work":{"workId":"team-1:work:abc","revision":2},"disposition":"accepted"}
{"action":"control","command":"close_team","resultRefs":["team-1:result:def"],"outcome":"succeeded"}
```

| command | 字段 | 语义 |
| --- | --- | --- |
| `pause_member` / `resume_member` | `memberId`（worker） | 手动暂停不关闭入箱；resume 只清除手动暂停 |
| `revise_work` | `workId, expectedRevision, task, inputRefs?` | 版本化替换；旧版本置为 superseded，其未终态子树取消 |
| `cancel_work` | `workId, expectedRevision, reason` | 只取消该版本及其从属子树；已终态时稳定 no-op |
| `resume_work` | `workId, expectedRevision, incidentId, instruction` | 只解除 attention/protocol hold |
| `accept_result` | `work, disposition: accepted\|waived, reason?` | 根工作验收或明确豁免 |
| `close_member` | `memberId`（worker） | 条件式关闭 |
| `close_team` | `resultRefs, outcome: succeeded\|partial\|failed, reason?` | 原子关闭整个 Team |

`reply`、`yield`、`close_team` 必须是最终 assistant 批次中唯一的工具调用（依据原生最终批次核验）。暂存结束意图之后，同一 activation 的新业务返回 `ACTIVATION_ENDING` 或 `INTENT_CONFLICT`。

### 错误

成功回复为 `{ok:true, from:"@hub", to, receipt?, data?}`，失败为 `{ok:false, from:"@hub", to, error:{code, message, blockers?}}`。业务错误作为原生工具错误（`isError`）返回，不关闭连接；伪造身份、绑定不符或冲突重复帧属于 protocol failure，只影响所属成员。错误码固定为：

`INVALID_ARGUMENT, UNSUPPORTED_PROTOCOL, UNKNOWN_MEMBER, FORBIDDEN_ACTION, SELF_REQUEST, RECIPIENT_CLOSING, RECIPIENT_CLOSED, MEMBER_UNAVAILABLE, TEAM_OWNED, STALE_REVISION, UNKNOWN_WORK, UNKNOWN_RESULT, WRONG_WORK_OWNER, REQUEST_QUEUE_FULL, TEAM_CAPACITY, INPUT_BUDGET_EXCEEDED, BUDGET_BLOCKED, DEPENDENCY_CYCLE, NO_NEW_DEPENDENCY, UNRESOLVED_CHILDREN, UNOBSERVED_CHILD_RESULTS, INTENT_CONFLICT, ACTIVATION_ENDING, WORK_NOT_RUNNING, CLOSE_BLOCKED, INVALID_TEAM_OUTCOME, CLEANUP_FAILED, DELIVERY_UNKNOWN, PROTOCOL_FAILURE`。

子端 `team.execute` 不仅依赖按字符计数的工具 schema：在分配业务请求 sequence、写入私有 frame 之前，独立 codec 校验**原始公开参数**的形状、Unicode、UTF-8/JSON 转义大小、完整 JSON 总量及 WorkResult 上限。非法参数以结构化 `INVALID_ARGUMENT` 工具错误返回，不产生业务 mutation、不发送业务 frame，也不因此断开连接；模型可在同一 scope 纠正后重试。父 Runtime 仍独立 normalize/revalidate 并检查权限、版本、状态和预算。原生工具尝试的既有 gate/预算计步不因此取消。

host/provider 的诊断是输出，不是模型参数：公开 work/previous/outcome、member/incident、终态原因和错误回执统一做有界投影。错误 `message` 按 JSON 转义后的 UTF-8 内容限 4 KiB，过长带 `[truncated]`，非法 Unicode 在公开文本中修复，保留合法 `code` 和适用的 `outcomeUnknown`。原始 ledger、native/cleanup/transport 证据不因公开投影而截断；内部幂等比较仍能区分原始错误的不同尾部。合法的业务 `result.status="failed"` 即使 summary 为 8 KiB，也只缩短其错误诊断投影，**完整 WorkResult 仍通过 resultRef 原样读取**，不会被转成协议故障。

## 4. 状态

- Team：`prepared → active → closing → closed`，或 `failed`/`cancelled`/`interrupted`；health 为 `ok`/`needs_attention`；业务 outcome（`succeeded`/`partial`/`failed`）与生命周期分开记录。
- Member：lifecycle 为 `starting/open/closing/closed/faulted`，activity 为 `idle/running/settling`，pause 为 `none/requested/confirmed`，resourceState 为 `starting/owned/stopping/released/cleanup_failed`。faulted 成员的资源可能仍是 `cleanup_failed`，不等于已释放。
- WorkVersion：`queued/running/blocked/resolved/failed/cancelled/superseded`。hold（`attention/budget/protocol/manager_unavailable`）是调度暂停原因，只出现在非终态版本上。`resolved` 表示提交了业务结果；`result.status = failed/partial` 不代表成功。
- 结果未知：传输丢失、清理失败、宿主停止运行中成员等情况下，工作记为 `failed`，`error.outcomeUnknown = true`。这类 outcome 不会自动唤醒下游：等待它的工作或其 parent 会得到一个稳定的 `DEPENDENCY_UNAVAILABLE` incident 和 attention hold。进程退出尚未确认时，`resume_work`/`release_hold` 返回 `CLEANUP_FAILED`；明确解除该 incident 后，下游才会以 unknown 标记收到这个 outcome，原来的错误证据保持不变。已知的失败（已收尾的 provider 错误、业务 failed 回复、清理已确认的普通 cancel/revise）照常自动交付。解除 hold 本身不会满足 AND 等待：仍有未完成依赖时保持 blocked。
- 公开快照有独立的 `stateVersion`（可观察状态每次变化都递增，包括 waiting/hold 变化）和 `eventSeq`（事件排序）；只读查询不会让它们递增。两者都不是消费游标。

## 5. 原生输入与提交边界

1. 成员 lifetime 执行一次 `bind`；之后每次运行前 `activate`，安装 scope、deliveryId 和公开的 `ActivationInput`。
2. driver 发送固定的触发 prompt `Process the current Rail Team input.`，不复制任务正文。
3. 在 `before_agent_start` 中返回 `rail-team-activation` custom message，经 Pi 原生 writer 写入分支。
4. 接收上下文核验 canonical branch 中的精确输入后，向父端发送 `input_ready`；provider gate 在此之前不会放行。
5. 结束意图以成功工具结果返回，并带 `terminate:true`。
6. 等待 `agent_settled`、context reset、`deactivate` 和本次 send 清理全部完成后，才提交结果或等待；最后一条真实 assistant 消息是自然结束的唯一依据：内容为空时不会回退到更早的文本。

`ActivationInput`（≤64 KiB）包含：成员职责、shared brief、精简 roster、当前 WorkRef/任务/checkpoint/恢复说明（或管理事件批次）、相关 dependency outcome、从属 child 摘要和预算剩余量。outcome 最多 32 条，至多 8 条带结果摘要预览；带预览条目的完整 JSON（包括引用和错误元数据）合计 ≤4 KiB。其余条目保留 WorkRef、终态及适用的 resultRef/错误诊断，完整结果按 resultRef 查询。总量不足时先收敛可选预览/child 展示，再减少本批 outcomes；`omittedOutcomes` 精确记录未发送数量，必要 task/brief/role 不会为此删除。投影重复应用不重复累加 omitted。

Delivery 只记录**实际 `input.outcomes`** 的 WorkRef；`input_ready` 只把这些引用加入 observedOutcomes，不另从 ledger 重算“前 32 个”。未选 outcomes 保持未观察，可经后续 yield 逐批交付，所有必要 child outcome 均已观察后才允许 parent reply。结果未知的 outcome 仍受 Manager/宿主显式放行约束，不因分页或裁剪被自动确认。其他排队工作不会在运行中途注入。mid-activation 原生 compaction 与 `context_edit` 按 Pi canonical projection 处理：被显式删除的输入不会复活，下一次 activation 会重新提供当前工作事实。

私有协议统一为 v2（`/rail-subagent-team-protocol`，描述 `Rail private team protocol v2`）。遇到 v1、命令缺失或冲突时，在任何 provider 请求之前拒绝。ACK 超时（5 秒）只约束私有命令，正常运行没有期限。重复请求在有界缓存（每个成员连接保留 128 条已完成记录，pending 请求不淘汰）内幂等；过期帧会被拒绝，不会重新执行。没有自动重发、重连或重放。

## 6. 调度与 Manager 事件

- Runtime 通过唯一的 effect drain 调度：worker 最多 4 个执行许可，Manager 有独立的 1 个；ready 队列为 FIFO，每个 WorkRef 最多一个 ready 项。
- yield 完整结束后释放许可，排在后面的成员（例如第 8 个 worker）因此有机会运行。
- BOOT 事件列出由 `initialRequests` 建立、无需 Manager 派发即会运行的 root（assignee、WorkRef、任务预览），并提示不要重复请求、每个 root 最终都须 accepted 或 waived；`ROOT_RESULT_READY` 注明结果状态和作者。
- Manager 事件：`BOOT, USER_COMMAND, ROOT_RESULT_READY, DECISION_REQUEST, WORK_HELD, MEMBER_FAULTED, MEMBER_CLOSED, DEPENDENCY_UNAVAILABLE, BUDGET_HIT, TEAM_QUIESCENT`，按语义键去重；incident 事件按性质归类：等待 Manager 决定的 held 工作（attention 以及协议 hold：结果超出槽位、child 结果未观察、没有有效 reply/yield、未确认的结束意图）为 `WORK_HELD`，用 `resume_work`、`revise_work` 或 `cancel_work` 处理，三者都会把该 incident 标为 resolved（没有其他未决 incident 和成员错误时 health 恢复 ok），不会再阻止 `succeeded` 关闭；成员级故障（丢失 activation、清理失败、退出未确认、Manager 不可用）为 `MEMBER_FAULTED`，每次故障一个事件；预算与未知依赖分别为 `BUDGET_HIT`、`DEPENDENCY_UNAVAILABLE`；`ROOT_RESULT_READY` 直接带上该 root 结果全文（summary、findings、evidence、limitations、artifacts）和 resultRef，Manager 无需再 `status(result)` 即可验收；批次一旦封存，最多 16 项，且必须与 brief/role 等共同满足 64 KiB 输入上限。长错误先做公开投影，仍放不下时缩小事件批次；未选事件不被封存或确认，留待后续批次。新事件进入下一批；已处理的批次即使 Manager 什么都没做也不会重新入队。
- status 查询、no-op 控制和 ACK 不产生事件。全员 idle 时 Team 保持 active；只在语义版本变化时发出一次 `TEAM_QUIESCENT`。
- Manager 故障时：Team 进入 needs_attention，worker 在安全点暂停，账本保留；没有自动接任，也没有自唤醒。

## 7. 暂停、修订、取消与故障

- `pause_member` 立即置为 `requested`；只在 provider 安全点确认（`confirmed`）。已放行的工具会正常完成，未放行的得到完整的 blocked 工具结果。停驻期间释放许可，resume 时重新获取。已暂存的 reply/yield 照常提交。
- revise/cancel 先向原生运行发送 activation-only abort，等待收尾与清理；超过 `activationStopTimeoutMs`（默认 5000 ms）仍未收敛时终止成员进程，并以真实退出结果结清。清理确认前，下游拿不到 outcome。
- worker 的 provider/传输/协议故障只隔离该成员：它名下的工作显式 failed（未开始的记为 `MEMBER_UNAVAILABLE`，正在运行的记为 outcome unknown），无关工作继续。

## 8. 关闭

- `close_member`：目标必须 open、没有 activation（包括停驻中的）、没有名下的未终态工作、没有待其接收的 outgoing 请求、资源状态确定。条件不满足返回 `CLOSE_BLOCKED` 和 blockers，状态不变。满足时进入 closing，新请求得到 `RECIPIENT_CLOSING`。只剩已提交历史结果的作者可以关闭。
- `close_team`：只能在管理 activation 中调用。要求所有 root 和 child 都有明确 outcome，root 已被 accepted 或 waived，worker 都没有运行中的 activation 或清理，resultRefs 属于本 Team。它自己会关闭仍 open 的 idle worker，无需先逐个 `close_member`。
  - `succeeded`：所有 root 都是 accepted 且结果为 succeeded，没有未决 incident，至少一个 resultRef。被拒时 `INVALID_TEAM_OUTCOME` 的 blockers（`root_outcome`）列出每个阻止成功的 root；被取消、失败或 waived 的 root（例如重复派发的工作）只能以 `partial` 关闭。
  - `partial`：需要 reason 和至少一个 resultRef。
  - `failed`：需要 reason。
- close_team 提交后入口立即关闭（原子）。Manager 在本次 activation 正常收尾后才停止；所有成员退出确认后 Team 才是 `closed`。清理失败或关闭后出错时 Team 为 `failed`，不会报告为 closed success。
- 成员资源关闭等待 Broker/transport 自身的有界退出结果；Runtime 不再套用 activation-stop 的独立 5 秒超时抢先宣告 close 失败。资源确实未退出时仍保留 ownership，晚到退出确认只结清一次。这不放宽私有命令的 5 秒 ACK 上限。

## 9. 预算与 HostControl

默认值：worker 许可 4、每成员未解决工作 64、Team 工作 512、每 root child 64、深度 8、每工作修订 32、每 root activation 128、Team activation 512、Manager activation 128、每 activation 模型请求 64/工具调用 256、每 root 模型请求 256/工具调用 1024、Team 模型请求 1024/工具调用 4096、紧急 Manager activation 3、结果预留 16 MiB。

- 计数从 launch 开始只增不减。命中上限时，当前步骤安全收尾，工作进入 budget hold，并产生一条 incident；某个 root 耗尽不影响其他 root。
- Team/Manager 预算耗尽后，Manager 只剩受限的紧急 activation（status、cancel_work、accept_result、close_member、close_team、yield）；紧急额度用完后只有宿主能处理。

非模型的 `TeamHostControl`（actor 固定为 `@host`）：

- `cancel_team(reason)`：整队取消。
- `grant(scope, increments, reason)`：scope 为 Team 或已知 root；增量为正安全整数；先完整校验、写 journal，再应用。
- `release_hold(work, incidentId, instruction)`：只解除 attention/protocol hold；不会提额，也不能绕过 Manager 故障造成的暂停。
- `message_manager(text)`：产生一条去重的 `USER_COMMAND` 事件。

`/rail-team [list] | <teamId> status|results [page:N]|result <resultRef>|budget|cancel [reason]|resume|grant [team|root:<rootId>] [counter=+N ...] [reason]|message <text>`：grant 和 resume 会先展示影响范围并要求确认；无 UI 的环境不能修改。`/rail-agent` 中对 Team 成员的 Stop/Delete 会经 Runtime 路由（见 README）。

## 10. 容量上限

| 对象 | 上限 |
| --- | --- |
| task | 8 KiB（UTF-8 与 JSON 转义后） |
| roleDescription | 4 KiB |
| shared brief | 32 KiB 完整 JSON |
| checkpoint / attention / 恢复说明 / reason | 各 4 KiB，并计入输入总量 |
| WorkResult | 12 KiB 完整 JSON，每类数组最多 32 项 |
| Manager 事件 message | 16 KiB（容纳一份完整 root 结果及其标题） |
| 原始成员工具参数 | 64 KiB 完整 JSON；各 action/字段另有更小上限 |
| ActivationInput | 64 KiB 完整 JSON |
| 私有帧 | 1 MiB 完整 JSON，含 native tool-call evidence |
| activation `ownedChildren` / work 详情 `children` | 最多 8 / 64 项，另给 omitted 计数；完整 refs 通过 work 分页的 parent 关系枚举 |
| 公开错误 message | 4 KiB JSON 转义后 UTF-8 内容，截断带提示 |
| inputRefs / waitingFor | 各 32 项 |
| status 分页 | 默认 20，最多 50 |
| Team 视图 | incident 32、root 预算 32、grant 16 条（其余计数为 omitted） |
| live/prepared Team | 32 个 |

请求/修订的必需输入在接受前做组合大小校验；可选 outcomes 和 children 展示独立有界，不能因 host grant 扩大 ledger 就把完整 children 塞进 activation。相关最大输入、65 children 和多批确认回归见验证报告；这些检查并不构成对所有组合无缺陷的证明。当前实现没有 UI 事件环：状态展示直接读取有界的 public snapshot，义务只存在于账本中，因此早期请求不会因为事件过多而丢失。

## 11. 状态展示、TeamResult 与历史

- `status` 文本和 `/rail-team status` 显示：Team lifecycle/health/outcome、各工作计数与根验收数；每个成员的 lifecycle、activity、pause、当前 WorkRef 与任务预览、queued/blocked/held、Manager 待处理事件数、已提交结果数、model/FAST/SEARCH 和错误；hold、未决 incident、预算与 usage。idle 不会显示为“已完成”。
- `launch` 面板复用 grouped subagent 面板：顶部是 Team lifecycle/health、目标、工作计数、`Waiting for:` 原因行（仅 Team active 时出现）、hold/incident 与预算。标题按结果着色（succeeded 绿、partial/需要处理/取消 黄、failed 红），hold、incident 与等待 Manager 决定的 `Waiting for:` 行为黄色、预算耗尽为红色，其余为灰色；折叠时目标与 reason 各保留一行。`Waiting for:` 只给一个最相关的原因，按优先级：有工作因 attention 被 held → `Manager decision on scope's question`（多个为 `Manager decisions on scope's and gate's questions` 或 `… on 3 questions`）；所有 root 都已终态但有未验收 → `Manager review of 2 results`；所有 root 都已验收 → `Manager to close the Team`；否则列出正在运行和在等待的成员，如 `source, writer (running) · review (waiting on source)`（至多 4 个名字，其余 `+N more`）。这些原因由 Runtime 的宿主专用 `panelFacts` 计算，不进入 Team 协议、模型可见的 schema 或 codec。其下每个成员一个带框子面板（Manager 在前，按 roster 顺序）：首行为 `状态图标 别名 · manager|worker · model`，第二行为运行指标（ctx、轮次、以分钟计的活跃时长）及 `ContextWindow · FAST · SEARCH`，第三行为成员状态短句（如 `running work xxxxxxxx@1`、`queued for a worker slot`、`closed · 2 results`；等待与 held 会点名原因，只看一跳：`waiting on source (running work 588d1234@1)`、`waiting on 2 sub-tasks: gate (held), review (running)`（至多列 3 个名字，其余 `+N more`；依赖恰好全部终态的瞬时状态回退为 `waiting on other work`）、`held · asks: "…" · Manager handling`（Manager 当前 activation 正在处理该 WORK_HELD）或 `· queued for Manager`（事件尚未被取走；Manager 已看过但未答复时不加后缀）、`held · budget teamActivations exhausted`（每 activation 的上限没有可指的 Team/root 计数器时为 `held · budget exhausted`）、`held · protocol: …`、`held · Manager unavailable`），随后是当前或最近任务（折叠时一行；Manager 不重复 Team 目标）、最近活动，以及该成员最近提交的结果。状态、图标与外框颜色在所有 subagent 面板（单个、parallel、chain、Team）和 /rail-agent 中统一：运行 `▶`（蓝）、完成 `✓`（绿）、失败 `✗`（红）、held `⏸`（黄，需要 Manager 决定）、waiting `⧗` 与 idle `○`（灰），压缩中为 `◐`（黄）；汇总行按成员计数（`N members · … · 1 held · 1 waiting · …`）。没有输出的 idle/waiting/held 成员不显示占位文字。Usage 为已结算用量加当前 activation 的实时用量，汇总行给出总用量和 launch 墙钟时间。面板随 Runtime 状态和成员原生事件节流刷新；结束后结果仍保留每个成员子面板（活动记录有界），每个 worker 子面板的最终内容是它最近提交的完整结果（summary、findings、evidence、limitations、artifacts），Manager 子面板是关闭决定。给模型的最终文本和 grouped subagent 一样直接包含结果：Team 结论、roots/works、每个成员的状态、轮次、活跃时长与结果数、从 Runtime launch 起算的时间线（初始与后续派发、每次 activation 的开始与结束（yield 依赖的结束条目写明所等成员，如 `(waiting on source)`）、结果提交、验收/取消/修订、恢复 held 工作（resume_work 或宿主 release_hold）、close_team、成员退出和 Team 终态；按墙钟记录，仅供显示，已提交的 reply 只记一条结果、不再重复记“结束”；最多保留 100 条并注明省略数），以及 Manager 选定的每份 worker 结果全文。全文总量上限 48 KiB，按“短结果完整保留、只由最大的几份平分剩余额度”分配；只有超出额度的结果被截断，并注明读取全文的 `status resultRef`。因此 launch 之后无需再调用 status 读取结果。`prepare`、`status`、`cancel` 面板显示与模型收到的相同文本（Team active 时 `status` 文本同样带 `Waiting for:` 行）。
- `TeamResult`（version 2）：`lifecycle`、`outcome`、`reason`、`finalResultRefs`，各 root 的 WorkRef/状态/resultRef/review，各成员的 lifecycle/resourceState、usage 和未决 incident。最终内容引用 worker 撰写的结果，不再调用 Manager 重写。
- journal 只同步写入有界事实：launched、result（发布前写入）、revise/cancel 决定、close decision、grant、terminal。写入失败时 fail closed。
- session tree/switch/fork 的导航尝试进入 before hook 时就结束旧 generation：对仍在运行（active/closing）的 Team 尝试写 interrupted 标记（已结束的 Team 保留其 terminal 事实，不再补写），再永久封存旧 writer 并等待资源清理。即使后续扩展取消导航，或分支摘要 abort/error 导致导航未提交，旧 Team 也不会恢复；清理确认后，当前分支可在新的空 generation 中重新 prepare。未知 exit 会阻止本次及后续导航尝试，不能因旧 host 已 inactive 绕过检查。导航实际提交后再按目标分支重建只读历史，旧回调无法写入新分支。reload/shutdown 同样永久撤销旧 writer；标记写入失败会明确诊断，不声称已持久化。
- 历史只读：没有 terminal 记录的 v2 Team 显示为 interrupted；旧 v1 快照（`rail-subagent-team`）映射为 legacy，未完成的同样显示 interrupted；损坏条目逐条跳过。关闭后保留 persistent session/descriptor，之后可以作为普通 subagent 打开，但不带 Team 工具或旧权限。

## 12. 不支持的能力与限制

- 不做跨父进程恢复、自动重连/重发/重放、动态增删成员、跨 Team 通信、递归 subagent 或后台服务。父进程重启后未完成的 Team 只显示为 interrupted。
- revise/cancel 不能撤销已经开始的外部副作用；结果未知需要人工处置。
- Team 绑定期间 cache warming 被停止（不修改全局设置）。本地观察到：rail 子进程中原生运行结束后的 idle 阶段并不总会进入预热决策；N08 证明的是运行中的预热决策会被 Team 绑定阻止。
- 验证全部基于本地纯 Runtime、fake transport/host 和真实 Pi 0.87.1 + 本地合成 provider。没有做：真实在线模型的决策质量、TUI 人工验收、长时间（长程）运行或真实负载。N08 只证明运行中阶段的预热决策被阻止；idle 阶段预热在 rail 子进程中未能触发，原因未查明。详见验证报告。

## 13. 文件

| 文件 | 职责 |
| --- | --- |
| `team-protocol.ts` | v2 类型、上限、默认预算、错误码 |
| `team-codec.ts` | 严格 JSON/字段/字节校验、动作规范化、工具 schema |
| `team-work-ledger.ts` | WorkRef、结果索引、父子与等待图 |
| `team-runtime.ts` | 唯一权威状态机：接受、调度、交付、提交、控制、关闭、预算、incident |
| `team-budget.ts` / `team-journal.ts` | 累计计数 / 有界 journal generation |
| `team-member-driver.ts` / `team-rpc-v2.ts` / `team-extension-v2.ts` | 原生 lifetime driver、私有 RPC、子扩展 |
| `team-tool.ts` / `team-command.ts` / `team-host.ts` / `team-history.ts` | 父层工具、`/rail-team`、branch 宿主、只读历史 |
