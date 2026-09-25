# Team Actor v2：本轮阶段性验证报告

## 结论与阻碍

**完整规格未交付，100 项验收未全部通过。** 本报告记录本轮实际运行，而不是历史测试成绩。阶段 A/B 基础已提交；C/D 未实施。当前旧 Team UI/prepare/launch 入口尚未迁移，而 Broker 已拒绝旧 v1 dispatch，因此本分支暂不适合作为完整 Team 功能使用。

指定 Claude 实施代理终止后，按授权改用 `cus-resp/gpt-6-luna:max`、Fast、默认上下文。阶段 B 提交后，同一 fallback 会话连续两次失败于 `WebSocket closed 1006`；更换为空白 fallback 会话排除会话因素后，仍在实施前失败。没有继续更改模型/全局配置或无限重试。C 没有产生代码改动。

## 版本和提交

- 分支：`feat/subagent-team-coordination`
- 用户基线：`acb612bd5a44bb89c838d35b7d0ae0f1df2413d2`；开始时 HEAD 与其相同。
- Node：`v24.15.0`。
- 本地四个 Pi 包：`pi-ai`、`pi-agent-core`、`pi-coding-agent`、`pi-tui` 均为 `0.87.1`。
- A：`a909fda` — `feat(team): establish actor v2 protocol and pure request runtime`。
- B / 本报告代码验证对象：`9ccc1e8` — `feat(team): add owned native member lifetimes and v2 activation driver`。
- 两个代码提交作者均为 `zqcli <276883664+zqcli@users.noreply.github.com>`，提交命令显式覆盖身份，不使用系统 GitHub 身份或 PAT。
- 开始时只有用户提供的规格文件未跟踪；该文件保持不修改、不暂存。
- 没有运行 `npm ci`；本地已安装的精确依赖满足本轮检查。没有修改上游 Pi、node_modules、凭据或已有用户 session，没有 push/merge/deploy。

## 父审查者实际执行

所有下列完成命令退出码均为 **0**。

| 检查 | 结果 |
| --- | --- |
| A：`node_modules/.bin/tsx --test --test-concurrency=2 tests/subagent/team-runtime.test.ts` | 24 tests，24 pass，0 fail/cancel/skip |
| A：`node_modules/.bin/tsc --noEmit -p tsconfig.json` | 通过 |
| B：下方六文件定向测试 | 153 tests，151 pass，0 fail/cancel，2 skip |
| B：`node_modules/.bin/tsc --noEmit -p tsconfig.json` | 通过 |
| `PI_OFFLINE=1 PI_TELEMETRY=0 npm test` | 980 tests，28 suites，970 pass，0 fail/cancel，10 skip；约 29.46s |
| `PI_SUBAGENT_DEPTH=1 PI_OFFLINE=1 PI_TELEMETRY=0 npm test` | 980 tests，28 suites，970 pass，0 fail/cancel，10 skip；约 29.39s |
| 每次代码提交前 `git diff --cached --check` | 通过 |

B 定向命令：

```bash
PI_OFFLINE=1 PI_TELEMETRY=0 node_modules/.bin/tsx --test --test-concurrency=2 \
  tests/subagent/team-runtime.test.ts \
  tests/subagent/team-rpc-v2.test.ts \
  tests/subagent/team-member-driver.test.ts \
  tests/subagent/team-websocket-integration.test.ts \
  tests/subagent/session-broker.test.ts \
  tests/subagent/rpc-worker.test.ts
```

全量日志暂存在执行机器 `/tmp/pi-rail-team-actor-full-test.log` 与 `/tmp/pi-rail-team-actor-depth-test.log`；它们不是仓库持久交付文件。测试结果已在此摘要，不能依赖这些临时路径永久存在。

### 跳过项及测试限制

10 个 skip 是 `team-integration.test.ts` 中 8 个旧 v1 集成用例，以及 `team-websocket-integration.test.ts` 中 2 个旧 v1 用例。旧 afterRun/总结屏障已退役，但这 **不等于旧测试覆盖的所有不变量都已迁移**。v2 有 retry、threshold compaction、WebSocket 输入/取消及历史重开测试；完整暂停、预算、Manager 总结替换、context_edit 和关闭管线仍缺验收。

真实 Pi 测试使用本地 `dist/bundle/cli.js`、临时 HOME/agent/session 目录、synthetic provider 或 loopback WebSocket。它们不调用真实付费模型。没有在线模型验收、TUI 人工验收、长程运行或恢复能力验收。

隔离和清理还有待修复事项：`team-member-driver.test.ts` 的子进程环境未显式传 `PI_TELEMETRY=0`（父测试命令设置了它，但测试构造显式 env）；其 harness teardown 仍捕获并忽略部分 close/shutdown 错误。因此全量绿灯 **不能作为 U10“全部资源收敛”的证据**。不得以这些 catch 替代后续清理修复。新 v2 网络 fixture 使用合成服务，不把测试进程环境等同于真实生产隔离保证。

## 证据索引

编号引用的是实际测试名，可在相应文件定位。下表分层是证据范围，而不是产品整体通过。

| 编号 | 文件与实际测试名 | 层 |
| --- | --- | --- |
| R1 | `team-runtime.test.ts`: `P: v2 codec rejects v1 live frames, legacy actions, unknown fields and non-JSON values` | 纯 Runtime/codec |
| R2 | 同上：`P: request admission is activation-idempotent and derives identity/root from the binding` | 纯 Runtime |
| R3 | 同上：`P: private activate codec validates binding, delivery, nested fields and typed public replies` | codec |
| R4 | 同上：`W: a yielded parent releases its member for a dependent return trip and observes each outcome once` | 纯 Runtime |
| R5 | 同上：`W: an outcome that arrives before yield is not lost and produces one ready activation` | 纯 Runtime |
| R6 | 同上：`W: cycle detection includes parent completion edges and rejects without reserving a wait` | 纯 Runtime |
| R7 | 同上：`W: revision fences an active old WorkRef until native cleanup, then reuses the same member lifetime` | 纯 Runtime |
| R8 | 同上：`W: cancelled dependency is not deliverable until the old activation cleanup is confirmed` | 纯 Runtime |
| R9 | 同上：`W: reply refuses a logically cancelled child while its native cleanup is pending` | 纯 Runtime |
| R10 | 同上：`W: native failure faults a worker and terminalizes its other assigned work` | 纯 Runtime |
| R11 | 同上：`A: staged reply remains uncommitted through settlement and needs matching native tool-result evidence` | 纯 Runtime |
| R12 | 同上：`A: oversized natural final is protocol-held after cleanup and remains manager-disposable` | 纯 Runtime |
| R13 | 同上：`L: request-before-close blocks close; close-before-request rejects without creating work` | 纯 Runtime |
| R14 | 同上：`L: close_team is a staged Manager decision and reports closed only after all exits are confirmed` | 纯 Runtime |
| R15 | 同上：`L: native failure after staged close converges to failed Team and still permits confirmed exits` | 纯 Runtime |
| R16 | 同上：`A: provider/tool gates require the exact delivered WorkRef and reject the activation after a staged intent` | 纯 Runtime |
| R17 | 同上：`A: pre-settlement transport loss clears the running slot as outcome-unknown and faults only that member` | 纯 Runtime |
| R18 | 同上：`P: exhausted result slots reject request admission without ledger or budget side effects`；`P: revise_work capacity rejection preserves the current writer, revision and reserved slots` | 纯 Runtime |
| R19 | 同上：`W: revising a resolved root preserves its committed result and old review`；`W: revision rejects a closed assignee without changing work, results or member state` | 纯 Runtime |
| R20 | 同上：`L: close_team refuses faulted worker resources that were never released`；`L: close_team cannot absorb a worker already closing but not yet released` | 纯 Runtime |
| R21 | 同上：`P: prepare rejects initial per-member overflow before reserving a Team or changing live state`；`P: explicit deadline starts at launch admission, while prepare time is unbounded` | 纯 Runtime |
| F1 | `team-rpc-v2.test.ts`: `identical child requests are idempotent, stale sequence replies do not execute, and ACK duplicates are diagnosed` | fake transport |
| F2 | 同上：`late private requests from the just-closed activation are ignored and diagnosed` | fake transport |
| F3 | 同上：`pending private requests are never evicted and requests older than the bounded completed cache are not re-executed` | fake transport |
| F4 | 同上：`a stop/exit failure propagates from send and close instead of reporting a released resource` | fake transport |
| F5 | 同上：`native Team run may exceed the five-second ACK bound and still waits for real agent_settled`；`Team command application ACK still fails closed at the independent five-second timeout` | fake transport |
| F6 | 同上：`an explicit abort requests native cancellation but still waits for Pi agent_settled`；`opaque native tool-call IDs stay transcript evidence and end intents match the exact executed call/result` | fake transport |
| E1 | `team-extension-v2.test.ts`: `Team v2 tool schema is a strict action union and bind selects role-specific tools` | fake extension |
| E2 | 同上：`native custom activation is persisted and verified before input_ready/provider_gate; repeats are idempotent` | fake extension；native 顺序另由 N1 验证 |
| E3 | 同上：`wrong native context aborts before private readiness or provider continuation`；`business tool errors retain the structured TeamError JSON including its code` | fake extension |
| N1 | `team-member-driver.test.ts`: `real Pi 0.87.1 Team v2 lifetime supports W1/W2 return-trip work with settled cleanup on one session per member` | 真实 Pi + synthetic provider |
| N2 | 同上：`real Pi automatic retry remains inside the Team native run and settles one activation` | 真实 Pi + synthetic provider |
| N3 | 同上：`real Pi threshold compaction occurs inside a Team activation without losing provider/native ownership` | 真实 Pi + synthetic provider |
| N4 | 同上：`real Pi rejects a non-sole end intent and Runtime commits only the true natural final` | 真实 Pi + synthetic provider |
| N5 | 同上：`normal Team close preserves the native session and descriptor for ordinary history reopen` | 真实 Pi + synthetic provider；手工 driver close 非完整 Manager close_team 流程 |
| N6 | `team-websocket-integration.test.ts`: `Stage B Team v2 actors use the configured Responses WebSocket for native input and tool settlement`；`Stage B Team v2 cancellation aborts a held native WebSocket run without another provider request` | 真实 Pi + loopback synthetic WebSocket |
| B1 | `session-broker.test.ts`: `Team v2 open reserves one alias across startup and competing opens cannot remove the owner's lock` | fake worker/Broker |
| B2 | 同上：`Team v2 startup cancelled by broker shutdown retains the persistent session but never returns a live handle` | fake worker/Broker |
| B3 | 同上：`Team v2 close preserves descriptor and ownership until an exit timeout's reap promise resolves`；`failed Team v2 binding keeps ownership until process exit, then permits an ordinary history reopen` | fake worker/Broker |
| B4 | `rpc-worker.test.ts`: `Team v2 restores the pre-activation context window after native compaction keeps the temporary budget` | fake transport |
| U1 | 全量执行中的 `tool.test.ts`、`session-broker.test.ts`、`rpc-worker.test.ts` 等普通 subagent 回归 | 各文件现有单元/集成层；不作为新增 Team 验收替身 |

## 100 项验收逐项映射

**“范围内已测”仅表示表中列出的层和断言；“部分”表示仍欠该场景的必要分支；“未验证”不能视为通过。** 所有场景仍需最终 live 入口迁移后的整体验收。没有把旧 v1 测试当作新 v2 场景成绩。

### P：协议与身份

| ID | 状态 | 本轮证据 / 缺口 |
| --- | --- | --- |
| P01 | 部分 | R1 拒绝 v1 frame；尚缺完整父 v2/子 v1 原生握手且 provider 零调用的专门验收。 |
| P02 | 部分 | R2/R3/E1 身份推导与字段拒绝；所有伪造组合未穷举。 |
| P03 | 范围内已测 | R2/F1：同内容重复 request 不重建工作。 |
| P04 | 范围内已测 | R2/E2：同 ID 不同内容拒绝，不重复副作用。 |
| P05 | 部分 | R7/F2：旧 revision、closed activation；旧 epoch 全排列未完成。 |
| P06 | 部分 | E2/F1 重复 bind/activate/reply/deactivate/ACK；完整新旧交错待补。 |
| P07 | 部分 | R1/R3/E1：严格字段、嵌套与 null 基础；动作组合矩阵未全覆盖。 |
| P08 | 范围内已测 | R1：拒绝旧动作；旧实时文件仍待 D 删除。 |
| P09 | 部分 | R3/E2 覆盖 binding 伪造拒绝；双 Team 同 alias 的状态独立验收待补。 |
| P10 | 范围内已测 | F3：pending 不淘汰，过期 sequence 不重执行。 |

### W：账本与依赖

| ID | 状态 | 本轮证据 / 缺口 |
| --- | --- | --- |
| W01 | 范围内已测 | R2/R4：root/parent/depth 来自 Runtime。 |
| W02 | 未验证 | 没有新 v2 UI 事件尾部淘汰后的完整回归。 |
| W03 | 范围内已测 | R4/N1：W1→W2→W1 的请求链合法，同成员复用 session。 |
| W04 | 范围内已测 | R6：真实依赖环拒绝且图不变化。 |
| W05 | 范围内已测 | R6：父完成约束边参与环检测。 |
| W06 | 范围内已测 | R5：结果先到再 yield，不丢唤醒。 |
| W07 | 范围内已测 | R4/R5：已观察 outcome 不再生成 ready。 |
| W08 | 部分 | R8/R10：取消/失败基础；三种 outcome 的所有依赖组合未全覆盖。 |
| W09 | 部分 | R4/R9/R11：子工作及清理义务拒绝；完整错误 blocker 组合待补。 |
| W10 | 未验证 | 代码有 terminal parent 拒绝，缺独立测试证明。 |

### D：交付与容量

| ID | 状态 | 本轮证据 / 缺口 |
| --- | --- | --- |
| D01 | 范围内已测 | R2/R3/R11：账本接受与 input_ready 分离。 |
| D02 | 范围内已测 | E2/E3：ACK 不代表 canonical native 输入已就绪。 |
| D03 | 范围内已测 | E2/N1/N6：固定 trigger + 一份原生 custom message。 |
| D04 | 部分 | R11/R13 检查 settling 预约；R2 各到达时刻组合待补。 |
| D05 | 未验证 | 生产 event-driven pump 尚未实现。 |
| D06 | 部分 | R18/R21 接受前容量拒绝；64 项队列满时合法 reply 的专门测试待补。 |
| D07 | 部分 | R1/R3/R12/R18：字节和输入/结果基础边界；最大组合欠缺。 |
| D08 | 未验证 | 多依赖截断预览与精确交付的专门测试待补。 |
| D09 | 范围内已测 | F4/F5/R17：ACK 超时、transport unknown、无自动重放。 |
| D10 | 部分 | R13/R14/N5 保留结果与 session；关闭作者后完整公开 status 查询待补。 |

### A：Activation 与提交

| ID | 状态 | 本轮证据 / 缺口 |
| --- | --- | --- |
| A01 | 范围内已测 | N1：同成员/session 多工作，reply/yield 不关闭成员。 |
| A02 | 范围内已测 | R11/F6/N1：成功 terminate 证据与清理前不提交。 |
| A03 | 范围内已测 | R7/R11/B4：settled/reset/deactivate 边界仍占有成员。 |
| A04 | 范围内已测 | R16/F6：结束意图后 gate 拒绝业务。 |
| A05 | 部分 | R11/R15：缺证据/close 后 native error；worker 的所有 post-intent error 组合待补。 |
| A06 | 范围内已测 | N4/R12：使用本 activation 最后回答，合法才 natural_final。 |
| A07 | 部分 | R11 不把空文本替代显式结果；之前非空/最终空的全原生测试待补。 |
| A08 | 部分 | N1 管理 activation 自然结束不关闭；最终用户入口尚未接入。 |
| A09 | 未验证 | 第三方 continuation 与累计预算保护待 C。 |
| A10 | 部分 | Runtime/Broker 互斥已有检查；重复 schedule effect 测试等待 pump。 |

### C：暂停、修订、取消

| ID | 状态 | 本轮证据 / 缺口 |
| --- | --- | --- |
| C01 | 未验证 | pause/resume 尚未实现。 |
| C02 | 未验证 | 安全点暂停与 confirmed 状态待 C。 |
| C03 | 未验证 | 同批部分工具通过后暂停的原生互锁测试待 C。 |
| C04 | 未验证 | resume 对其他 hold 的边界待 C。 |
| C05 | 部分 | R7/R19：旧版清理 fence、已提交版本保持；完整两个交错待补。 |
| C06 | 部分 | R7 涉及 revision fence；多次过期 expectedRevision 序列待补。 |
| C07 | 部分 | R8/R9：子请求取消基础；同成员无关 root 完整组合待补。 |
| C08 | 范围内已测 | R8/R9/F6：未 cleanup 不交付安全终态，不提前释放。 |
| C09 | 部分 | R17/F4：局部故障；双 Team 故障隔离与全部 protocol 类型待补。 |
| C10 | 部分 | R2/F1 幂等基础；完整控制重复计数待 C。 |

### L：关闭竞争

| ID | 状态 | 本轮证据 / 缺口 |
| --- | --- | --- |
| L01 | 范围内已测 | R13：request 先接受则关闭被阻止。 |
| L02 | 范围内已测 | R13：关闭先提交则请求拒绝且无 work。 |
| L03 | 部分 | R11/R20：settling/cleanup 阻止关闭；parked 暂停待 C。 |
| L04 | 部分 | R4/R9 保留 owned-child 义务；专门 outgoing close 验收待补。 |
| L05 | 部分 | R13/R14/N5：不因历史结果删除作者历史；完整状态查询待补。 |
| L06 | 部分 | R14：自身管理 activation 可以 staged close；完整 self close_member 拒绝待专测。 |
| L07 | 部分 | R13/R14 为同步关闭基础；close_team/peer request 两序组合待补。 |
| L08 | 部分 | R14/R20 覆盖部分前置条件；未验收/partial 等全矩阵待补。 |
| L09 | 范围内已测 | R14/B3/F4：延迟 exit 不 closed，超时保留 ownership。 |
| L10 | 部分 | R15/F2：关闭后 native error/迟到 scope；用户 cancel 同时竞争待 C。 |

### G：Manager、预算与循环

| ID | 状态 | 本轮证据 / 缺口 |
| --- | --- | --- |
| G01 | 部分 | R4/N1 手动 drain 可 idle；真实事件调度长期无轮询验收待 C。 |
| G02 | 部分 | R2/R5 消息结果幂等；incident 语义版本完整测试待 C。 |
| G03 | 未验证 | status/no-op/ACK 不制造管理进展的专门验收待补。 |
| G04 | 部分 | N1 基础 management yield；incident 不重入批次测试待补。 |
| G05 | 未验证 | root 全寿命累计预算未完成。 |
| G06 | 未验证 | revise/yield 后累计计数未完成。 |
| G07 | 未验证 | Team 总执行预算未完成；仅容量/activation 基础限制存在。 |
| G08 | 未验证 | root budget hold 与无关 root 并行待 C。 |
| G09 | 未验证 | 紧急额度/Host grant 尚未实现。 |
| G10 | 未验证 | Manager fault 后运行中 worker 的安全停驻未完成。 |

### N：真实 Pi 0.87.1

| ID | 状态 | 本轮证据 / 缺口 |
| --- | --- | --- |
| N01 | 部分 | N1 有真实 BOOT/worker；无初始请求 writer 的完整流程待 C/D。 |
| N02 | 范围内已测 | N1：真实 Pi 依赖回问、多次工作、同 session。 |
| N03 | 未验证 | 四个 worker yield 等第八个、自动许可调度待 C。 |
| N04 | 范围内已测 | N1/N4/F6：sole batch、原生 toolCall/result/terminate 证据。 |
| N05 | 范围内已测 | N2/N3/B4：原生 retry、threshold compaction、reset 和最终 settlement。 |
| N06 | 部分 | N3/B4 仅 compaction；canonical context_edit/显式删除不复活原文待补。 |
| N07 | 部分 | N1/E1/N6：输入与 schema 基础；最终管理/总结全流程待补。 |
| N08 | 部分 | E1/E2 fake hook 验证 stop；真实开启预热的计费/调用观测待补。 |
| N09 | 部分 | B4/U1 与 Driver policy 校验；新 prepare 固定真实政策的入口待 D。 |
| N10 | 未验证 | Manager→writer→idle reviewer→明确 close_team 闭环未实现。 |

### U：回归与可观察性

| ID | 状态 | 本轮证据 / 缺口 |
| --- | --- | --- |
| U01 | 范围内已测 | 本轮全量与 depth 回归通过普通 subagent 测试；10 项旧 Team skip 单列。 |
| U02 | 部分 | N1/B1：Team-owned 普通 dispatch/control/model/Fast 等拒绝；UI 入口未迁移。 |
| U03 | 部分 | B2/B3/U1：启动 shutdown/lease 基础；TeamRuntime stop/delete 路由待 D。 |
| U04 | 未验证 | 完整 hold/wait public version 与 UI 观察待 D。 |
| U05 | 未验证 | 分页/游标/大产物完整测试待 D。 |
| U06 | 未验证 | v2 Team usage 跨 activation 累计尚未完成。 |
| U07 | 未验证 | runtime generation/journal 永久失活尚未接入。 |
| U08 | 未验证 | 旧 v1 仅历史映射及损坏记录处理尚未迁移。 |
| U09 | 范围内已测 | N5：关闭保留 session，再普通打开不带 Team 扩展。 |
| U10 | 未验证 | 有 B3/F4 局部 exit 证据，但部分 harness 吞 cleanup；全 effects 收敛不可声称通过。 |

### X：组合与性质测试

| ID | 状态 | 本轮证据 / 缺口 |
| --- | --- | --- |
| X01 | 部分 | R13/R14 覆盖若干线性化顺序，不是 I01–I30 全组合。 |
| X02 | 部分 | R7/R11 覆盖 revision/settlement；pause 组合未实现。 |
| X03 | 部分 | R4/R6/R8 具体 DAG 与取消案例，不是任意 DAG 性质测试。 |
| X04 | 未验证 | 最大 roster 与最大组合输入/结果未全测。 |
| X05 | 部分 | R18/R21：结果预留与低容量拒绝；完整高容量结算待补。 |
| X06 | 部分 | F1/F2/F3/E2：重复、旧帧、容量；完整交错序列待补。 |
| X07 | 未验证 | 管理批次封存/交付/settling 并发事件全排列待 C。 |
| X08 | 未验证 | deadline/预算/host cancel 同时触发尚未实现。 |
| X09 | 部分 | N6 provider held cancellation；不是本地 native 工具长期不返回场景。 |
| X10 | 未验证 | 固定 seed、trace 和可复现状态机随机测试尚未新增。 |

## Review 修复与后续验收门槛

A review 实际修复了请求结果槽预检晚于写账本、旧 revision yield、closed/faulted assignee 修订、已提交版本被覆盖、自然结果超大后卡住清理、关闭资源条件及公开泄露 activation ID 等问题。

B review 实际修复了把整个 run 套 ACK 五秒超时、关闭删除 persistent session、exit 未知仍释放 ownership、任意工具 schema/Manager loadout、非规范输入路径、重复帧处理与未 settled 的故障结清等问题。

这些修复有本轮回归证据，但不能据此认定所有强制契约已满足。继续实施应从 C1/C2 开始，随后替换入口/UI/历史并删除旧实时桥接。必须再次完整执行新验收矩阵与普通回归；不得直接沿用本报告的 970 pass 数字作为后续版本成绩。
