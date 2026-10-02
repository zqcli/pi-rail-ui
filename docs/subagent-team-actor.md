# Team Actor v2：协议、状态与宿主控制

本文描述当前实现（Pi 0.87.1）的 Team 行为。Team 里没有 manager/worker 两种成员：每个成员同型，其中一个由 `lead` 指出。约束来源是 `pi-rail-ui-team-actor-development-spec.md`；实测证据与 100 项验收映射见 [验证报告](subagent-team-actor-validation.md)。旧 v1 实时机制（coordinator、inbox/wait/finish、afterSeq、成员终态屏障、全员 idle 两秒失败）已删除；旧 Team 文档均标为 legacy。

## 1. 对象

| 对象 | 含义 |
| --- | --- |
| Member | 稳定 alias、`roleDescription`、私有 epoch 和 Broker 独占的原生 Pi session。所有成员同型：配置项、基础工具和能力完全相同，成员做什么只取决于 `roleDescription` 和收到的工作（alias 里可以有 manager/worker 字样，但配置和行为都不依赖它）。完成工作不退出；idle 期间仍由 Team 持有所有权。 |
| Lead | Team 的一个成员，由 `lead` 指针指出（职守，不是类型）：处理 Team 事件、请求初始工作、验收并关闭 Team。lead 同样可以接收其他成员的 request 并作为普通 work activation 运行。 |
| WorkRequest | 可执行消息本身。`WorkRef = {workId, revision}`，ID 由宿主分配；一项工作可以修订，同时只有一个当前版本。 |
| Activation | 为一个 WorkRef（work activation，任何成员）或一批 Team 事件（events activation，仅 lead）进行的一次原生 send。同一成员从预约、运行、收尾到清理，同一时间只允许一个 activation。 |
| Delivery | 一次 activation 输入的交付记录；activate ACK 只证明安装成功，只有 `input_ready` 才标记 delivered。 |
| ResultRecord | 不可变结果（`resultRef`），关联 WorkRef 和作者；作者关闭后仍可读取。 |

权威状态只在 `TeamRuntime`（同步状态机）中；driver、UI 和 journal 都不直接修改账本。

**ID 格式与文本中引用的 ID。** 成员会抄进文本、工具调用里的 ID（`work`、`result`、`incident`、`event`）是 `<kind>:<code>`，`code` 为 4 个字符，随机取自去掉易混淆字符（0/o/1/l/i）的字母表 `23456789abcdefghjkmnpqrstuvwxyz`，如 `work:k7m2`、`result:9xq4`、`incident:h3tp`、`event:2wfd`；同一 Team 内同类 ID 不重复；每个 code 至少含一个数字，且与同类已有 ID 至少相差两个字符（否则重新生成），因此单个字符抄错或相邻两字符颠倒永远不会变成另一个有效 ID，一定会被识别为未知 ID；文本里不含数字的 `result:pass` 这类词也不会被当成 ID。短是为了少抄错；随机而稀疏（不用递增编号）是为了让抄错几乎总是落到不存在的 ID，而不是悄悄变成另一个有效 ID（12→21 这类错误）。因此 ID 只在所属 Team 内唯一，父层 `status` 取结果时总是 `teamId` 加 `resultRef` 成对使用。teamId 与 activation、delivery、batch、close、grant 等内部 ID 仍是 UUID，不由模型抄写，且部分会跨 Team 查找。测试注入 `createId` 时所有 ID 都用注入值。旧 journal/history 中的 UUID 形式 ID 照常解析（codec 把 ID 当不透明字符串），`shortWorkRef` 显示完整 code（`work k7m2@1`），旧 UUID 仍显示前 8 位。

Runtime 在动作进入状态转换前，检查模型写的、会被转交给另一方的文本里引用的 ID：`reply` 的结果文本（summary、findings、evidence 的 source/locator、limitations、artifacts）、`request.task`、`yield` 的 `attention`，以及 lead 的 `revise_work.task`、`resume_work.instruction`、`cancel_work.reason`、`accept_result.reason`、`close_team.reason`（checkpoint 只留给作者自己，不检查）。文本转小写后，凡匹配 `(work|result|incident|event):` 加 4 个字母表字符的 token，必须是本 Team 中该类现存的 ID，否则整个动作以可纠正的工具错误拒绝，不暂存、不创建、不变更任何状态：引用的 result 不存在为 `UNKNOWN_RESULT`，否则为 `UNKNOWN_WORK`（`status(incident)` 查不到 incident 同样用它）；错误里逐个列出未知 token，且当同类现存 ID 中恰有一个与它只差一次字符替换或一次相邻交换时附 `did you mean <id>?`。模型改正后可在同一 activation 重新发出。旧格式的 UUID token 不符合 4 字符形态，不检查；自然终稿文本也不检查。此前基于 UUID 前缀的检查已由它取代。这源自 live run 中模型把 UUID 分组拼错、让 lead 追查近百秒。

## 2. 父层工具 `subagent_team`

动作：`prepare`、`launch`、`status`、`cancel`。未知字段会被拒绝；声明为可选的字段可以传 `null`，与省略等价。

```json
{"action":"prepare","members":[{"alias":"lead","roleDescription":"分配、验收、处理阻塞并关闭；不写最终报告","model":null,"cwd":null,"fastMode":null,"contextWindow":null,"tools":null},{"alias":"review","roleDescription":"审查实现","tools":["read","bash"]},{"alias":"writer","roleDescription":"根据结果引用撰写报告"}],"lead":"lead","brief":{"goal":"审查当前变更并提交有证据的报告","acceptanceCriteria":["标明未验证项"],"constraints":["不访问生产系统"]},"initialRequests":[{"to":"review","task":"审查本地变更","inputRefs":[]}],"timeoutSeconds":null}
```

- `members`（2–9 个）的每项为 `{alias, roleDescription, model?, cwd?, fastMode?, contextWindow?, tools?}`，`lead` 必须是其中一个成员的 alias。Search 属于宿主策略，不是参数。旧字段 `manager`/`workers`/`coordinator` 会被拒绝，并返回迁移说明：`manager/workers were replaced by members plus lead: <alias>`。
- `tools?: string[] | null` 是该成员基础工具的白名单（基础工具 = 父会话的工具去掉 `subagent`、`subagent_team`、`team`）；省略或 `null` = 全部基础工具，`[]` = 只有 `team`。`team` 总会加上；未知名字（包括 `subagent`、`subagent_team`、`team`）在 prepare 就被拒绝并列出可用工具。所有成员（lead 也一样）默认拿到全部基础工具加 `team`。
- `brief.goal` 必填；可选 `target`、`acceptanceCriteria`、`constraints`、`authorizations`。authorizations 只声明任务范围，不授予操作系统权限。
- `initialRequests` 最多 8 条，可以指向 lead 以外的任何成员（lead 是初始工作的 requester），`inputRefs` 必须为空或省略（新 Team 还没有结果可引用）；runtime 把 requester 设为 lead，`rootId` 设为 `workId`。只有角色描述、没有初始工作的成员合法，在被分配工作前不会产生 provider 调用。
- `timeoutSeconds` 为 `null` 或省略表示没有总截止；取值为 (0, 86400] 内的有限数字，从 launch 开始计时，到期按 `DEADLINE` 走取消流程，不会报告为成功。
- prepare 固定真实的 model、cwd、Fast/Search 和 contextWindow/compaction reserve，不启动 provider 或工具。launch 前再次核对，策略漂移时拒绝并保留 prepared Team。开始创建成员后，bind 或启动准入失败（包括 launched journal 写入失败）会将本次 Team 标为 failed 并清理已认领资源，不自动重试；已有的用户取消、宿主中断或 lead 关闭决定优先保留。启动原错与资源退出失败分别诊断，未知 exit 继续保留 ownership。

```json
{"action":"launch","teamId":"<teamId>"}
```

launch 会等所有成员资源创建并绑定完成后才开放执行；它的 Promise 覆盖整个 Team 生命周期，结束时返回 `TeamResult`。中止等待 launch 不会取消 Team。`status` 可以按 `cursor` 分页列出 result ref，也可以用 `resultRef` 读取一条完整 `ResultRecord`，两者不能同时给。`cancel` 需要 `teamId`，`reason` 可选。

## 3. 成员工具 `team`

这是一个判别联合，只在 Team 绑定期间可用。每个成员（lead 也一样）装载宿主允许的基础工具（受其 `tools` 白名单限制）加 `team`，但不能使用 `subagent` 和 `subagent_team`。旧动作 `send`/`report`/`wait`/`finish`/`afterSeq`/`supersedes` 会返回迁移错误。

```json
{"action":"request","to":"review","task":"核对错误路径","inputRefs":[]}
```

`request` 会同步写入账本，并返回 `receipt {status:"accepted", work, recipient}`，不等待接收者运行。接收者可以是除自己以外的任何成员，包括 lead。在 events activation 中创建 root；在 work activation 中创建从属 child，parent、root 和 depth 由绑定推导，模型无法指定。不允许自请求。

```json
{"action":"reply","result":{"status":"partial","summary":"已核对主路径","evidence":[{"source":"npm test","basis":"verified"}],"limitations":["未做在线验收"]}}
```

`reply` 只针对当前 WorkRef，返回 `receipt.status = "staged"` 和 `terminate:true`。只有在原生 `agent_settled`、工具结果证据和清理都确认后才提交；存在未完成或尚未交付的 child 时分别返回 `UNRESOLVED_CHILDREN` 或 `UNOBSERVED_CHILD_RESULTS`。暂存前还会校验模型写进文本的 ID，见下文“文本中引用的 ID”。

```json
{"action":"yield","waitingFor":[{"workId":"team-1:work:abc","revision":1}],"checkpoint":"收到结果后继续"}
{"action":"yield","attention":"需要 lead 决定范围","checkpoint":"已完成步骤 1"}
{"action":"yield"}
```

- 等待具体依赖或请求 attention 时 checkpoint 必填；`waitingFor` 与 `attention` 互斥。
- 空 `yield` 只允许用在 lead 的 events activation（其他 yield 必须带 `waitingFor` 或 `attention`）。lead 不在运行中等待：派发后直接 `yield`（只带可选 checkpoint），新的结果、失败和 incident 会自动开启下一次 events activation；不要用 `status` 轮询等待。events activation 的输入 notice（`Events activation: you are the Team's lead and there is no current WorkRef. …`）和带 `waitingFor` 的 lead yield 错误（`The lead never waits inside an activation: …`）都会给出这条指引。尚未交付给当前事件批次的 Team 事件会阻止 `close_team`（blocker `team_event` 提示先 yield 接收再关闭）。
- 成功的 yield 会结束本次原生运行，不占住成员。
- 结果早于 yield 到达也不会丢；下一次 activation 交付可容纳的 outcome 批次，超出部分保持未交付，后续 yield 可继续观察。
- 对已交付且没有变化的 outcome 再次 yield，返回 `NO_NEW_DEPENDENCY`。
- 依赖同伴结论：成员做到一半需要另一成员的结论时，有三条路径，work activation 的 notice 会写明。notice 还以 `Current work: <workId@N>. Earlier works in this session are finished; answer only this task, not a previous one.` 开头，点明当前 WorkRef：成员的原生 session 会跨多项工作长期存在（live run 中同一 rpc 成员的第 14 项工作曾照着前一项工作的内容作答并引用其 WorkRef）。输入大小预检使用同一个 notice 构造，大小一致。(1) 用 `status(work)` 找到对方的 WorkRef，直接 `yield {waitingFor, checkpoint}`，结果提交后自动唤醒并在 `outcomes` 中收到；(2) `request` 该成员创建 child，再等待返回的 WorkRef；(3) `yield {attention, checkpoint}` 请求处理（notice：`… or ask whoever requested this work (the lead for a root task) with yield {attention, checkpoint}.`）；子任务的 attention 由其请求者回答（见下文“子任务 issue”），root 的 attention 由 lead 回答。lead 收到 `WORK_HELD` 后用 `resume_work {workId, expectedRevision, incidentId, instruction}` 在 instruction 里给出所需 resultRef 或 WorkRef，events activation 的 notice 同样写明这一点。lead 自己的 work 也可以 attention：事件仍发给 lead，由它在下一次 events activation 里 resume_work。恢复的 activation 带原 checkpoint 和 instruction，全文用 `status(result)` 读取。work notice 明确写出：outcome 的 preview 只是状态和 summary，依赖 findings 与 evidence 前必须先 `status(result)` 读取（曾有成员只凭 preview 就声称读过完整结果）。
- 依赖环（包括 parent 对 child 的完成约束边）返回 `DEPENDENCY_CYCLE`。

```json
{"action":"status","view":"result","id":"team-1:result:def"}
```

`status` 是只读查询：`view` 省略或为 `team` 时只接受 `limit`；`work`/`result`/`incident` 可以带精确 `id`，或带不透明的 `cursor` 翻页（二者只能选一）；`limit` 默认 20、最多 50。它不推进状态，也不代表 child 结果已被 parent 观察。成员查询他人的 work 只得到摘要（状态、任务预览、resultRef），完整依赖与观察记录只对 assignee 和 lead 可见。`inputRefs`、`resultRefs` 只接受 result ID（`result:…`）；误传 work ID 时，`UNKNOWN_RESULT` 会给出该 work 当前的 result ID。

从属 children 的公开列表是预览，不是完成义务的完整集合：activation 的 `ownedChildren` 最多 8 项，`ownedChildrenOmitted` 表示未展示数量；work 详情的 `children` 最多 64 个 WorkRef，`childrenOmitted` 表示其余数量。宿主 grant 可以增加 root 的 child 创建预算，但不会扩大这些展示上限。需要完整枚举时，调用 `status {view:"work", limit:50}`，随后按返回的 `cursor` 翻至 `hasMore:false`，筛选摘要中 `parent.workId` **和** `parent.revision` 都等于目标父 WorkRef 的条目，读取其 `work`。不要只按 workId 匹配，也不要把预览当作完整 children；Runtime 的完整父子义务仍只在 ledger 中。

`control` 的权限按所有权划分，字段是扁平的：

- `revise_work`、`cancel_work`、`resume_work`、`accept_result`：该 work 的**请求者**（owner）或 lead 可用，可以在 owner 的 work activation 里，也可以在 lead 的 events activation 里。成员不能控制自己当前的 WorkRef（`FORBIDDEN_ACTION`）；既不是请求者也不是 lead 的成员同样得到 `FORBIDDEN_ACTION`。
- `pause_member`、`resume_member`、`close_member`、`close_team`：只限 lead（`close_team` 还必须在 events activation 里）。

**子任务 issue。** 有 parent 的 work（子任务）被 held（attention 或协议 hold）时，不再向 lead 发 `WORK_HELD`：Runtime 把 issue 记在 parent 当前版本上，并让 parent 可运行，即使它的 `waitingFor` 尚未满足。parent 的下一次 work activation 输入带 `childIssues: [{work, assignee, incidentId, reason, message}]`（`work` 是被 held 的子 WorkRef，`reason` 为 `attention|protocol`，`message` 至多 512 字节；每次最多 8 项，其余数量在 `childIssuesOmitted`，仍未送达，下次再带），notice 末尾多一句：`A sub-task you requested is held (see childIssues): answer it with resume_work {workId, expectedRevision, incidentId, instruction} or revise_work/cancel_work, then yield waitingFor again, or yield attention to escalate it.` owner 回答后再 `yield {waitingFor}`；答不了就 `yield {attention}`，由它自己的请求者（root 则是 lead）接手，即自然升级。每个 issue 只送达一次（对应 incident 已 resolved 的 issue 不再送达）；parent 正在运行时，issue 在它下次 yield 时送达（立即重新入队，不会阻塞在被 held 的子任务上）。以下情况仍回退为发给 lead 的 `WORK_HELD`：root（无 parent）、parent 版本已终态或自身被 hold、Team 级 incident（`BUDGET_HIT`、`DEPENDENCY_UNAVAILABLE`、`LEAD_UNAVAILABLE`）。lead 在自己 work activation 里创建的子任务 held 时，issue 交给那项 work；root（来自 events activation 或 initialRequests）则交给 events。



```json
{"action":"control","command":"revise_work","workId":"team-1:work:abc","expectedRevision":1,"task":"改为只审查 codec","inputRefs":[]}
{"action":"control","command":"accept_result","work":{"workId":"team-1:work:abc","revision":2},"disposition":"accepted"}
{"action":"control","command":"close_team","resultRefs":["team-1:result:def"],"outcome":"succeeded"}
```

| command | 字段 | 语义 |
| --- | --- | --- |
| `pause_member` / `resume_member` | `memberId`（lead 以外的成员；lead 永不暂停） | 手动暂停不关闭入箱；resume 只清除手动暂停 |
| `revise_work` | `workId, expectedRevision, task, inputRefs?` | 版本化替换；旧版本及其未终态子树均置为 superseded |
| `cancel_work` | `workId, expectedRevision, reason` | 只取消该版本及其从属子树；已终态时稳定 no-op |
| `resume_work` | `workId, expectedRevision, incidentId, instruction` | 只解除 attention/protocol hold |
| `accept_result` | `work, disposition: accepted\|waived, reason?` | 根工作验收或明确豁免 |
| `close_member` | `memberId`（lead 以外的成员） | 条件式关闭 |
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
- WorkVersion：`queued/running/blocked/resolved/failed/cancelled/superseded`。hold（`attention/budget/protocol/lead_unavailable`）是调度暂停原因，只出现在非终态版本上。`resolved` 表示提交了业务结果；`result.status = failed/partial` 不代表成功。
- 结果未知：传输丢失、清理失败、宿主停止运行中成员等情况下，工作记为 `failed`，`error.outcomeUnknown = true`。这类 outcome 不会自动唤醒下游：等待它的工作或其 parent 会得到一个稳定的 `DEPENDENCY_UNAVAILABLE` incident 和 attention hold。进程退出尚未确认时，`resume_work`/`release_hold` 返回 `CLEANUP_FAILED`；明确解除该 incident 后，下游才会以 unknown 标记收到这个 outcome，原来的错误证据保持不变。已知的失败（已收尾的 provider 错误、业务 failed 回复、清理已确认的普通 cancel/revise）照常自动交付。解除 hold 本身不会满足 AND 等待：仍有未完成依赖时保持 blocked。
- 公开快照有独立的 `stateVersion`（可观察状态每次变化都递增，包括 waiting/hold 变化）和 `eventSeq`（事件排序）；只读查询不会让它们递增。两者都不是消费游标。

## 5. 原生输入与提交边界

1. 成员 lifetime 执行一次 `bind`；之后每次运行前 `activate`，安装 scope、deliveryId 和公开的 `ActivationInput`。
2. driver 发送固定的触发 prompt `Process the current Rail Team input.`，不复制任务正文。
3. 在 `before_agent_start` 中返回 `rail-team-activation` custom message，经 Pi 原生 writer 写入分支。
4. 接收上下文核验 canonical branch 中的精确输入后，向父端发送 `input_ready`；provider gate 在此之前不会放行。
5. 结束意图以成功工具结果返回，并带 `terminate:true`。
6. 等待 `agent_settled`、context reset、`deactivate` 和本次 send 清理全部完成后，才提交结果或等待；最后一条真实 assistant 消息是自然结束的唯一依据：内容为空时不会回退到更早的文本。

`ActivationInput`（≤64 KiB）包含：成员职责（`member {id, lead, roleDescription}`）、shared brief、精简 roster（lead 条目带 `lead: true`）、当前 WorkRef/任务/checkpoint/恢复说明（或 Team 事件批次，scope kind `events`）、相关 dependency outcome、从属 child 摘要和预算剩余量。outcome 最多 32 条，至多 8 条带结果摘要预览；带预览条目的完整 JSON（包括引用和错误元数据）合计 ≤4 KiB。其余条目保留 WorkRef、终态及适用的 resultRef/错误诊断，完整结果按 resultRef 查询。总量不足时先收敛可选预览/child 展示，再减少本批 outcomes；`omittedOutcomes` 精确记录未发送数量，必要 task/brief/role 不会为此删除。投影重复应用不重复累加 omitted。

Delivery 只记录**实际 `input.outcomes`** 的 WorkRef；`input_ready` 只把这些引用加入 observedOutcomes，不另从 ledger 重算“前 32 个”。未选 outcomes 保持未观察，可经后续 yield 逐批交付，所有必要 child outcome 均已观察后才允许 parent reply。结果未知的 outcome 仍受 lead/宿主显式放行约束，不因分页或裁剪被自动确认。其他排队工作不会在运行中途注入。mid-activation 原生 compaction 与 `context_edit` 按 Pi canonical projection 处理：被显式删除的输入不会复活，下一次 activation 会重新提供当前工作事实。

私有协议统一为 v2（`/rail-subagent-team-protocol`，描述 `Rail private team protocol v2`）。遇到 v1、命令缺失或冲突时，在任何 provider 请求之前拒绝。ACK 超时（5 秒）只约束私有命令，正常运行没有期限。重复请求在有界缓存（每个成员连接保留 128 条已完成记录，pending 请求不淘汰）内幂等；过期帧会被拒绝，不会重新执行。没有自动重发、重连或重放。

## 6. 调度与 Team 事件

- Runtime 通过唯一的 effect drain 调度：`workPermits`（默认 4）限制并发的 **work** activation，任何成员的都算，lead 的 work activation 也算；lead 的 events activation 有独立的 1 个槽位，不受 workPermits 限制，因此事件不会被饿死。ready 队列为 FIFO，每个 WorkRef 最多一个 ready 项。
- 同一成员同一时间只有一个 activation：lead 空闲时，待处理的 Team 事件先于它排队的 work 被调度；lead 正在运行 work activation 时，事件等它结束。
- yield 完整结束后释放许可，排在后面的成员（例如第 8 个成员）因此有机会运行。
- BOOT 事件列出由 `initialRequests` 建立、无需 lead 派发即会运行的 root（assignee、WorkRef、任务预览），并提示不要重复请求、每个 root 最终都须 accepted 或 waived；`ROOT_RESULT_READY` 注明结果状态和作者。
- Team 事件（只给 lead）：`BOOT, USER_COMMAND, ROOT_RESULT_READY, WORK_HELD, MEMBER_FAULTED, MEMBER_CLOSED, DEPENDENCY_UNAVAILABLE, BUDGET_HIT, TEAM_QUIESCENT`，按语义键去重；incident 事件按性质归类：等待 lead 决定的 held 工作（root，或子任务无法交给 parent 时；attention 以及协议 hold：结果超出槽位、child 结果未观察、没有有效 reply/yield、未确认的结束意图）为 `WORK_HELD`，用 `resume_work`、`revise_work` 或 `cancel_work` 处理，三者都会把该 incident 标为 resolved（没有其他未决 incident 和成员错误时 health 恢复 ok），不会再阻止 `succeeded` 关闭；成员级故障（丢失 activation、清理失败、退出未确认、lead 不可用）为 `MEMBER_FAULTED`，每次故障一个事件；预算与未知依赖分别为 `BUDGET_HIT`、`DEPENDENCY_UNAVAILABLE`；`ROOT_RESULT_READY` 直接带上该 root 结果全文（summary、findings、evidence、limitations、artifacts）和 resultRef，lead 无需再 `status(result)` 即可验收；批次一旦封存，最多 16 项，且必须与 brief/role 等共同满足 64 KiB 输入上限。长错误先做公开投影，仍放不下时缩小事件批次；未选事件不被封存或确认，留待后续批次。新事件进入下一批；已处理的批次即使 lead 什么都没做也不会重新入队。
- status 查询、no-op 控制和 ACK 不产生事件。全员 idle 时 Team 保持 active；只在语义版本变化时发出一次 `TEAM_QUIESCENT`。
- lead 故障时（事件或 work activation 失败、被宿主停止）：错误码 `LEAD_FAILURE`/`LEAD_UNAVAILABLE`，Team 进入 needs_attention，其余成员在安全点暂停，lead 名下的 work 以 hold `lead_unavailable` 停住，账本保留；没有自动接任，也没有自唤醒；宿主可用 `handoverLead` 指定新 lead（见下）。

## 7. 暂停、修订、取消与故障

- `pause_member` 立即置为 `requested`；只在 provider 安全点确认（`confirmed`）。已放行的工具会正常完成，未放行的得到完整的 blocked 工具结果。停驻期间释放许可，resume 时重新获取。已暂存的 reply/yield 照常提交。
- revise/cancel 先向原生运行发送 activation-only abort，等待收尾与清理；超过 `activationStopTimeoutMs`（默认 5000 ms）仍未收敛时终止成员进程，并以真实退出结果结清。清理确认前，下游拿不到 outcome。
- 非 lead 成员的 provider/传输/协议故障只隔离该成员：它名下的工作显式 failed（未开始的记为 `MEMBER_UNAVAILABLE`，正在运行的记为 outcome unknown），无关工作继续。

## 8. 关闭

- `close_member`：目标必须 open、没有 activation（包括停驻中的）、没有名下的未终态工作、没有待其接收的 outgoing 请求、资源状态确定。条件不满足返回 `CLOSE_BLOCKED` 和 blockers，状态不变。满足时进入 closing，新请求得到 `RECIPIENT_CLOSING`。只剩已提交历史结果的作者可以关闭。
- `close_team`：只能在 lead 的 events activation 中调用。要求所有 root 和 child（包括 lead 自己的 work）都有明确 outcome，root 已被 accepted 或 waived，其他成员都没有运行中的 activation 或清理，resultRefs 属于本 Team。它自己会关闭仍 open 的 idle 成员，无需先逐个 `close_member`。
  - `succeeded`：所有 root 都是 accepted 且结果为 succeeded，没有未决 incident，至少一个 resultRef。被拒时 `INVALID_TEAM_OUTCOME` 的 blockers（`root_outcome`）列出每个阻止成功的 root；被取消、失败或 waived 的 root（例如重复派发的工作）只能以 `partial` 关闭。
  - `partial`：需要 reason 和至少一个 resultRef。
  - `failed`：需要 reason。
- close_team 提交后入口立即关闭（原子）。lead 在本次 activation 正常收尾后才停止；所有成员退出确认后 Team 才是 `closed`。清理失败或关闭后出错时 Team 为 `failed`，不会报告为 closed success。
- 成员资源关闭等待 Broker/transport 自身的有界退出结果；Runtime 不再套用 activation-stop 的独立 5 秒超时抢先宣告 close 失败。资源确实未退出时仍保留 ownership，晚到退出确认只结清一次。这不放宽私有命令的 5 秒 ACK 上限。

## 9. 预算与 HostControl

`subagent_team prepare` 可选 `budget: "standard" | "long" | "unlimited"`（省略/null 默认 `long`）。只有用户明确要求开放式或循环任务才选 `unlimited`。

| 预算 | standard | long（默认） | unlimited |
| --- | ---: | ---: | ---: |
| Team / lead activations | 512 / 128 | 4096 / 1024 | unlimited / unlimited |
| Team 模型请求 / 工具调用 | 1024 / 4096 | 8192 / 32768 | unlimited / unlimited |
| root activations / 模型请求 / 工具调用 | 128 / 256 / 1024 | 1024 / 2048 / 8192 | unlimited / unlimited / unlimited |
| Team works / root children / work revisions | 512 / 64 / 32 | 4096 / 512 / 128 | 20000 / 2048 / 512 |
| 结果预留 | 16 MiB | 64 MiB | 256 MiB |

各档均保留：`workPermits` 4（并发 work activation，lead 的也算）、每成员未解决工作 64、深度 8、每 activation 模型请求 64/工具调用 256、紧急 lead activation 3（`emergencyLeadActivations`）。`leadActivations` 计 lead 的全部 activation（events 与 work）。预算计数器曾叫 `managerActivations`/`emergencyManagerActivations`/`workerPermits`，旧 journal 的 grant 读取时会映射到新名字。`unlimited` 的累计执行计数采用有限哨兵值 1,000,000,000；works、修订和结果字节仍有上限，限制内存与 session journal 增长。

运行中可用 `/rail-team <id> grant`（或弹窗 `g`）选择 `Raise to long`、`Raise to unlimited` 或 `Custom grant…`；已达到的预设不显示。确认前展示各项 used、limit → new 及将解除的预算 hold；升级只取各项 max，不降低已有额度，root 默认值与容量上限一起升级，按带 preset 标记的 grant 写 journal。显式 `grant team teamActivations=+64 …` 不变。

长任务的 `launch` 会让父模型持续等待；Esc 只停止等待，Team 仍由宿主管理，可经 `/rail-team` 查看或取消。

- 计数从 launch 开始只增不减。命中上限时，当前步骤安全收尾，工作进入 budget hold，并产生一条 incident；某个 root 耗尽不影响其他 root。
- Team/lead 预算耗尽后，lead 只剩受限的紧急 events activation（status、cancel_work、accept_result、close_member、close_team、yield）；紧急额度用完后只有宿主能处理。

非模型的 `TeamHostControl`（actor 固定为 `@host`）：

- `cancel_team(reason)`：整队取消。
- `grant(scope, increments, reason)`：scope 为 Team 或已知 root；增量为正安全整数；先完整校验、写 journal，再应用。
- `release_hold(work, incidentId, instruction)`：只解除 attention/protocol hold；不会提额，也不能绕过 lead 故障造成的暂停。
- `message_lead(text)`：产生一条去重的 `USER_COMMAND` 事件，发给 lead。

另有 `TeamRuntime.handoverLead(teamId, alias, reason?)`（`/rail-team <id> lead <alias> [reason]`，需确认）：把 lead 职责交给另一个 open 成员，原 lead 成为普通成员。目标必须是 open 且不是当前 lead 的成员；原 lead 正在处理 events activation 时拒绝（除非它已 faulted/closed）。未处理的 Team 事件（含原 lead 未完成批次里的事件）归新 lead；新 lead 收到一条 `USER_COMMAND` 事件 `Host made you the Team lead: <reason>`。原 lead 故障时：`LEAD_UNAVAILABLE` incident 全部 resolved，其余成员的安全暂停解除，而 `lead_unavailable` hold 住的 work 的 assignee 正是已故障的原 lead，无法继续，所以与其他故障成员的工作一样记为 failed（`MEMBER_UNAVAILABLE`），其请求者随之收到失败 outcome。移交写入 journal（`handover` 记录），history 显示当前 lead，旧 journal 不受影响。


### 定期巡检（review）

`prepare` 的 `review: {by, everyMinutes} | null`（默认 null）指定一名非 lead 成员（reviewer）每 `everyMinutes`（1..1440）分钟巡检一次进度；`by` 必须是 lead 以外的成员。巡检只给建议：reviewer 不能 `request` 或 `control`（`FORBIDDEN_ACTION`「A review only advises」），结果以 `REVIEW_READY` 事件（含完整结果与 resultRef）发给 lead，lead 自行决定（request、revise_work、cancel_work 或不处理），无需回复。

- 每个 Team 一个（unref 的）定时器，随关闭/停止清除。每次触发只在以下条件全部满足时启动巡检：Team active、lead 与 reviewer 都 open、没有未结束的 review work、自上次巡检起非 review work 有创建或状态变化。`review now` 忽略「无变化」这一条。`TeamRuntime.runReviewTick(teamId)` 是定时器调用的入口，测试可直接驱动。
- 巡检是 `kind: "review"` 的 work：requester 为 lead、assignee 为 reviewer，由 Runtime 创建，task 是宿主生成的有界快照（用时、目标、各状态 work、自上次起完成的 work、各成员状态与等待/hold、未决 incident、主要预算计数、自上次起的时间线、上一次巡检的结论）加固定指示（summary 必须以 `ON TRACK:`、`AT RISK:` 或 `OFF TRACK:` 开头）。review work 计入预算，但不是交付物：不计入 root 计数、close 阻塞项、Waiting for、processStats 与最终结果；`close_team`（或 Team 停止）时未结束的 review 自动取消，永不阻塞关闭。
- 提交后存为 `TeamReviewRecord`（`listReviews(teamId)`，保留最新 200 条，结论由 summary 前缀解析）；review 失败也记录（`failed`），hold 的问题照常交给 lead。`reviewSchedule(teamId)` 返回 `{by, everyMinutes, nextAt}`。宿主用 `setReview`/`reviewNow`（即 `/rail-team <id> review ...`）调整；journal 记录 `review`、`review_schedule`，history 条目含 `reviews` 与 `review`，已关闭的 Team 也能看到。

`/rail-team [list] | <teamId> status|results [page:N]|result <resultRef>|budget|cancel [reason]|resume|grant [team|root:<rootId>] [counter=+N ...] [reason]|message <text>|lead <alias> [reason]|review [now|every <N> [by <alias>]|off]`：grant、resume、lead 和 review（now/every/off）会先展示影响范围并要求确认；无 UI 的环境不能修改。`/rail-agent` 中对 Team 成员的 Stop/Delete 会经 Runtime 路由（见 README）。

## 10. 容量上限

| 对象 | 上限 |
| --- | --- |
| task | 8 KiB（UTF-8 与 JSON 转义后） |
| roleDescription | 4 KiB |
| shared brief | 32 KiB 完整 JSON |
| checkpoint / attention / 恢复说明 / reason | 各 4 KiB，并计入输入总量 |
| WorkResult | 12 KiB 完整 JSON，每类数组最多 32 项 |
| Team 事件 message | 16 KiB（容纳一份完整 root 结果及其标题） |
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

- `status` 文本和 `/rail-team status` 显示：Team lifecycle/health/outcome、各工作计数与根验收数；每个成员的 lifecycle、activity、pause、当前 WorkRef 与任务预览、queued/blocked/held、lead 待处理 Team 事件数、已提交结果数、model/FAST/SEARCH 和错误；hold、未决 incident、预算与 usage。idle 不会显示为“已完成”。
- `launch` 面板复用 grouped subagent 面板：顶部是 Team lifecycle/health、目标、工作计数、`Waiting for:` 原因行（仅 Team active 时出现）、hold/incident 与预算。标题按结果着色（succeeded 绿、partial/需要处理/取消 黄、failed 红），hold、incident 与等待 lead 决定的 `Waiting for:` 行为黄色、预算耗尽为红色，其余为灰色；折叠时目标与 reason 各保留一行。`Waiting for:` 只给一个最相关的原因，按优先级：有工作因 attention 被 held → `Lead decision on scope's question`（多个为 `Lead decisions on scope's and gate's questions` 或 `… on 3 questions`）；所有 root 都已终态但有未验收 → `Lead review of 2 results`；所有 root 都已验收 → `Lead to close the Team`；否则列出正在运行、在等待以及因非 attention 原因被 held 的成员，如 `source, writer (running) · review (waiting on source) · gate (held: budget exhausted)`（held 原因还有 `protocol`、`lead unavailable`；至多 4 个名字，其余 `+N more`）。这些原因由 Runtime 的宿主专用 `panelFacts` 计算，不进入 Team 协议、模型可见的 schema 或 codec。其下每个成员一个带框子面板（按 roster 顺序；lead 标 `(lead)`，其他成员没有类型标签）：首行为 `状态图标 别名 · model`（lead 为 `状态图标 别名 (lead) · model`），第二行为运行指标（ctx、轮次、以分钟计的活跃时长）及 `ContextWindow · FAST · SEARCH`，第三行为成员状态短句（如 `running work xxxxxxxx@1`、`queued for a work slot`、`closed · 2 results`；等待与 held 会点名原因，只看一跳：`waiting on source (running work 588d1234@1)`、`waiting on 2 sub-tasks: gate (held), review (running)`（至多列 3 个名字，其余 `+N more`；依赖恰好全部终态的瞬时状态回退为 `waiting on other work`）、`held · asks: "…" · lead handling`（lead 当前 events activation 正在处理该 WORK_HELD）或 `· queued for lead`（事件尚未被取走；lead 已看过但未答复时不加后缀；子任务的提问由其请求者回答，显示 `· for w1`）、`held · budget teamActivations exhausted`（每 activation 的上限没有可指的 Team/root 计数器时为 `held · budget exhausted`）、`held · protocol: …`、`held · lead unavailable`），lead 在处理事件批次时状态行为 `handling ROOT_RESULT_READY, WORK_HELD`（事件类型去重、最多 3 个，其余 `+N more`）；空闲且还有未结束的派发时，`dispatched: reviewer (running), writer (waiting), gate (awaiting review) +1 more`（至多 3 个）取代 `no assigned work`。随后是任务行、最近活动，以及该成员最近提交的结果。任务行（折叠时一行；只给有被分配工作的成员，lead 的 Team 目标已在 Team 头部）的标题形如 `task from lead · work 98d1acb8@2 · revised`：工作未结束时为 `task`，已结束时为 `last task`；`from` 是该工作的请求者，子任务（有 parent）写作 `from writer (sub-task)`；后跟工作短引用，修订版（revision > 1）再加 `· revised`，正文是当前修订的任务文本（普通 subagent 面板仍是 `initial task`）。最近活动中，每次 activation 开始会插入一行暗色分隔 `── work 98d1acb8@2 started`（同一 WorkRef 再次运行时为 `resumed`），lead 的 events activation 则是 `── handling ROOT_RESULT_READY, WORK_HELD`；分隔行只在展开时显示，折叠时只显示最近一条分隔之后（即当前工作）的活动，不混入上一项工作的步骤。任务行正下方固定显示 `↳ result → 请求者 · 状态 · resultRef`，折叠和展开都保留，不再放入输出正文；描述任务行所示工作，引用当前 revision 的 resultRef。未提交为 `in progress`，root 已提交待验收为 `awaiting review`，验收后为 `accepted`/`waived`；子任务已提交只显示请求者与 resultRef。成员最近的结果属于该工作的旧修订时，在末尾追加 `@N result superseded`（如 `in progress · @1 result superseded`），无结果的取消/失败为 `cancelled`/`failed`。没有被分配工作的成员（通常是 lead）没有任务行及结果去向行，普通 subagent 展示不变。状态、图标与外框颜色在所有 subagent 面板（单个、parallel、chain、Team）和 /rail-agent 中统一：运行 `▶`（蓝）、完成 `✓`（绿）、失败 `✗`（红）、held `⏸`（黄，需要 lead 决定）、waiting `⧗` 与 idle `○`（灰），压缩中为 `◐`（黄）；汇总行按成员计数（`N members · … · 1 held · 1 waiting · …`）。没有输出的 idle/waiting/held 成员不显示占位文字。Usage 为已结算用量加当前 activation 的实时用量，汇总行给出总用量和 launch 墙钟时间。面板随 Runtime 状态和成员原生事件节流刷新；结束后结果仍保留每个成员子面板（活动记录有界），每个成员子面板的最终内容是它最近提交的完整结果（summary、findings、evidence、limitations、artifacts），lead 在没有提交过结果时显示关闭决定。给模型的最终文本依次为：Team 结论与 launch 至终态墙钟时间（m:ss）；`Deliverables`（root/accepted/waived 数，最多 20 个 root 的引用、指派/请求者、验收或状态、resultRef 与约 160 字节摘要，其余计数省略）；`Process`（works/root/子任务、results、activations、model turns、依赖等待、向 lead 提问、修订、当前版本 cancelled/superseded 的工作数、tool errors 与未决 incident 数）；`Members`（别名与 `(lead)`、model/+FAST、结果数 results、activation 数、活跃时长）；`Final results selected by the lead (in full)`；`Details on demand` 提示用 status 读完整结果或 Team 视图与时间线。最终文本不再携带时间线。首行的 close reason 与 Team 头部的 `Reason:` 行都完整显示（reason 在 close_team 时已受 note 上限约束；折叠面板仍由渲染器截为一行）；`Deliverables` 对被 waive 的 root 附验收理由（至多 300 字节），每份 root 结果的标题在作者自报状态后附 lead 的 review 结论，如 `### writer · work:…@1 · succeeded · waived · result:…`。全文总量上限 48 KiB，按“短结果完整保留、只由最大的几份平分剩余额度”分配；只有超出额度的结果被截断，并注明读取全文的 `status resultRef`。因此 launch 之后无需再调用 status 读取结果。`prepare`、`status`、`cancel` 面板显示与模型收到的相同文本（Team active 时 `status` 文本同样带 `Waiting for:` 行）。
- `status {teamId}`（不带 cursor/resultRef）附 `Timeline (m:ss from launch):`；宿主 Runtime 保留最多 1000 条，固定头 30 条与最新 970 条。共享 `formatTimeline` 将文本限制为 100 行（发生省略时为头 30 条、标记、最新 69 条），标记 `- … N milestones omitted …` 的 N 合并运行时淘汰与渲染省略数；时间从 launch 起算。`processStats` 仅供宿主使用，依赖等待与提问在 end intent 成功提交后计数，错误回复按实际执行计数（缓存重放不重复），其余复用账本、预算、usage 和 delivery，不改变模型协议。
- `TeamResult`（version 2）：`lifecycle`、`outcome`、`reason`、`finalResultRefs`，各 root 的 WorkRef/状态/resultRef/review，各成员的 lifecycle/resourceState（没有角色字段）、usage 和未决 incident。最终内容引用成员撰写的结果，不再调用 lead 重写。
- journal 只同步写入有界事实：launched、result（发布前写入）、revise/cancel 决定、close decision、grant、terminal。写入失败时 fail closed。
- session tree/switch/fork 的导航尝试进入 before hook 时就结束旧 generation：对仍在运行（active/closing）的 Team 尝试写 interrupted 标记（已结束的 Team 保留其 terminal 事实，不再补写），再永久封存旧 writer 并等待资源清理。即使后续扩展取消导航，或分支摘要 abort/error 导致导航未提交，旧 Team 也不会恢复；清理确认后，当前分支可在新的空 generation 中重新 prepare。未知 exit 会阻止本次及后续导航尝试，不能因旧 host 已 inactive 绕过检查。导航实际提交后再按目标分支重建只读历史，旧回调无法写入新分支。reload/shutdown 同样永久撤销旧 writer；标记写入失败会明确诊断，不声称已持久化。
- 历史只读：没有 terminal 记录的 v2 Team 显示为 interrupted；旧 v1 快照（`rail-subagent-team`）映射为 legacy，未完成的同样显示 interrupted；损坏条目逐条跳过。旧代码写下的 journal（launched 的 `roster {manager, workers}`、terminal 成员的 `role`、grant 里的 `managerActivations`/`emergencyManagerActivations`/`workerPermits`）读取时映射为 lead（旧 manager）、成员列表和新计数器名，所以旧 Team 仍可显示；新代码只写新形态（`roster {lead, members}`）。关闭后保留 persistent session/descriptor，之后可以作为普通 subagent 打开，但不带 Team 工具或旧权限。

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
