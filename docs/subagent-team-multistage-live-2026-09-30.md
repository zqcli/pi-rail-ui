# Team 多阶段在线测试与父层独立审计（2026-09-30）

## 1. 最终结论

**测试执行完成，Team 正常关闭并释放全部成员，但交付验收是 `partial`，不是全部通过。**

- **运行机制：** 本轮实际经过的请求、依赖等待、同成员返程、attention 恢复、子任务取消隔离、工作修订、权限/环路拒绝与资源关闭正常完成；原始记录没有显示非预期工具错误、provider error/abort、未解决 incident 或未释放成员。此结论仅适用于本轮路径，不是一般无死锁、无竞态或无缺陷证明。
- **模型交付：** Writer 报告包含 **3 个不存在的 result ID，共出现 7 次**；verifier/source 各有一处把合法 RPC WorkRef 误称 writer 节点。Manager 识别这些问题，waive Writer 根工作，以 `partial` 关闭，未把 Worker 自报 `succeeded` 当作业务验收成功。
- **父层审计新增发现：** Relay 声称读过 RPC 完整结果，但实际仅收到 outcome 摘要，未执行任何 `status(result)`。返程机制和 nonce 正确，完整核读这一证据声明不成立。Manager 接受了该根工作，说明人工语义验收仍有漏检。
- **独立回归：** 隔离离线 `npm run check` 的类型检查及 **995/995 测试通过**。这不消除在线报告缺陷，也不能替代在线记录审计。

本次只新增本报告，不修改业务代码，不修写已提交的不可变 Worker 结果，不重跑在线场景把失败包装成通过。

## 2. 环境与规模

| 项目 | 实际值 |
| --- | --- |
| 被测代码 HEAD | `71e00085ff473ce1d85228215279dc9ccd581f2a` |
| Node / Pi | `v24.15.0` / `0.87.1` |
| Team ID | `83867447-417f-4e08-9178-17f111cc1911` |
| Manager | `mt0930-lead`，`cus-resp/gpt-6.1-sol:xhigh`，Fast off |
| Workers | 8 个 `mt0930-*`，全部 `cus-resp/gpt-6-luna:max`，Fast on |
| ContextWindow | 全员原生默认 `372000`；没有人为缩小窗口 |
| 开始 / 结束（UTC） | `2026-09-30T23:32:28.559Z` / `23:44:43.170Z` |
| launch 至 terminal | `734611 ms`，约 **12 分 15 秒**；无 Team 总期限 |
| 工作项 | **23 个 work ID：8 个根、15 个 child**；1 次合法修订，共 24 个工作版本 |
| 结果 | 23 份不可变结果，全部 explicit reply；当前工作 22 resolved、1 cancelled |
| 原生 activations | **47 次：Manager 9、Worker 38**，共 130 个模型轮次 |
| 等待与交付 | 13 次成功依赖 yield，恢复输入交付 15 个准确依赖 outcome；2 次 attention yield；8 次 Manager yield |
| 工具 | 165 次：129 次 team、26 次 read、10 次只读 bash；6 次预期错误，非预期错误 0 |
| 最终验收 | 7 个当前根 accepted、Writer 根 waived；9 个成员均 closed/released；未解决 incidents 0 |

23 份结果与当前 22 个 resolved 工作不矛盾：reviewer 的 rev1/rev2 各保留一份结果，cancelled child 没有结果。已完成的旧版本修订后仍保留原提交，不能把它误记为新增取消工作。

Usage：input `427267`、output `44992`、cacheRead `4043776`、cacheWrite `0`。配置返回的 cost 为 `0`，**不代表真实服务免费**。Fast 已核对 prepare 策略、实例描述与模型/thinking 记录；本轮没有抓取实际网络请求/服务端响应，不证明上游执行了 priority 服务，也不证明速度提升。

## 3. 场景及实际完成矩阵

所有 Worker 只读，不访问凭据、不写仓库、不执行 Git 写入、不访问外部业务服务。Manager 只装载 `team`。8 个 Worker 依 roster 顺序为 source、relay、verifier、scheduler、rpc、reviewer、writer、gate；gate 是第 8 个 Worker，writer 初始仅有角色且被暂停。

### 阶段一：四槽接力、扇出汇合与同会话返程

四个 initial roots 同时启动，各向 gate 创建一个 BOOTSTRAP child 并 yield。之后分别执行：

```text
source root ─┬─ scheduler child
             └─ rpc child             → AND join → source root 回复
relay root → rpc child → relay CALLBACK → rpc 恢复 → relay root 恢复
scheduler root → reviewer child → gate child → 逐层恢复
verifier root → SELF_REQUEST / FORBIDDEN_ACTION / UNKNOWN_MEMBER → 正常回复
```

| 检查 | 父层核对结果 |
| --- | --- |
| initial roots 不重复派发 | 4 个初始根没有被 Manager 重新 request；每根只创建一个 BOOTSTRAP child |
| 四槽并发与释放 | 以 input_ready 到该 activation 最后私有 ACK 为可观察区间，Worker 峰值并发为 4，同成员重叠为 0 |
| 第 8 Worker 得到许可 | source 的首个 yield 清理 ACK 在 `23:32:36.877Z`；gate 输入在 `36.888Z`，随后处理全部四个 BOOTSTRAP |
| AND join | source 的两项依赖都出现在同一次恢复 activation 的 outcomes 中，不以只读查询冒充交付 |
| 同成员返程 | relay 的根等待、CALLBACK 子任务、原根恢复共用同一个 session ID；RPC 正确读取 callback 全文和 nonce |
| 嵌套链 | scheduler→reviewer→gate 明确结清，全部 child outcome 被恢复 activation 观察 |
| Relay 完整核读 | **不通过：** relay 仅收到 RPC 的 summary preview，却将 “full result” 标为 observed；见 §5.3 |

**覆盖边界：** 这不是严格的“四个根都先 yield，然后才允许 gate 启动”的同步屏障。gate 在 source 首先释放许可后启动，其他三根之后才 yield（最后一次约 `23:32:40.981Z`）。四根后来确有同时等待的窗口，但没有通过确定性屏障强制所有启动次序；不把普通让槽接力夸大为严格屏障测试。

### 阶段二：hold、取消隔离、修订与关闭后历史读取

Manager 在阶段一四根验收后派发三个根：

| 检查 | 实际结果 |
| --- | --- |
| attention root | gate 首次 yield attention，Manager 用精确 incident/WorkRef `resume_work`；同 rev1 恢复 checkpoint，nonce=`scope-v2`，源码实际许可数为 4 |
| 子任务取消 | verifier 同时等待 gate 的 CANCEL_ME 和 SURVIVOR；Manager 只取消 CANCEL_ME，恢复输入同时包含 cancelled/CANCELLED 和 resolved/succeeded |
| 同成员隔离 | 两个 child 均属于 gate；SURVIVOR、verifier 父根及 gate 独立 attention 根正常完成，未被兄弟取消波及 |
| 合法修订 | reviewer 同 work 的 rev1 先提交 synthetic fixture=5，rev2 经 `inputRefs` 读取 rev1 并核实真实源码=4 |
| stale 拒绝 | 合法修订后仅一次旧 expectedRevision=1 探针，返回 STALE_REVISION；没有 rev3，也没有运行 STALE_PROBE |
| 作者提前关闭 | reviewer 无未完成义务后 close_member；Manager 在收到 MEMBER_CLOSED 后再次成功读取 rev1，内容与原 journal 深比较完全一致 |
| closed 接收者拒绝 | 唯一 CLOSED_PROBE 返回 RECIPIENT_CLOSED，没有创建工作；Manager 后续继续正常派发 |
| writer role-only/暂停 | 第一、二阶段没有 writer activation；Manager pause/resume 各一次，writer 首次激活在 resume 后 |

这里取消的是已 yield attention、原生 activation 已结清的 child；修订的是已经提交结果的 rev1。**未在线测试**强制中断正在执行的外部工具、无法退出的子进程或未知 outcome 的人工放行。

### 阶段三：三层交叉复核、环路拒绝与最终验收

```text
writer root → source child → rpc child → verifier child
                                      verifier yield 等待祖先 source
                                      → DEPENDENCY_CYCLE 拒绝
                                      → verifier 正常回复
             ← 逐层恢复并读取结果 ←
```

此分支的深度是根 0、source 1、rpc 2、verifier 3。verifier 的一次错误 yield 没有形成等待边，之后正常 reply；rpc/source/writer 依次收到真实子 outcome 并读取结果。Writer 完整读取了 8 个原始 inputRefs 和最终 source/rpc/verifier 三份结果（11 次成功 status(result)）。

Writer 提交后 Manager 发现引用错误，读取 source/verifier 原结果及精确 RPC work 状态复核，waive Writer 根，close_team partial 一次成功。关闭决定与 terminal 的 closeId 一致，全部成员释放。

Manager 共 9 个事件批次，派发/处理完后 8 次 yield，最后一次 close_team。5 次 status 分别用于阶段二状态核对、关闭作者后的历史读取，以及最终报告的三项核查；**没有 status 轮询等待**。

## 4. 六项实际错误证据

以下是原生 toolResult 中的实际 JSON 错误，不是 Worker 的预期描述。每项各发生一次，拒绝后同成员继续完成工作。

| code | 成员 | toolResult entry / 原会话行号 |
| --- | --- | --- |
| SELF_REQUEST | verifier | `692ae3e8` / 47 |
| FORBIDDEN_ACTION | verifier | `c2d78b94` / 57 |
| UNKNOWN_MEMBER | verifier | `95c3303d` / 67 |
| STALE_REVISION | lead | `7a5c26bd` / 195 |
| RECIPIENT_CLOSED | lead | `7ed39923` / 301 |
| DEPENDENCY_CYCLE | verifier | `a6265899` / 155 |

环路错误的准确路径是 verifier work→source work→rpc work→verifier work。它是 **WorkRef 依赖环**，不是按成员别名拒绝合法 return-trip。

## 5. 缺陷、归因与独立审计差异

### 5.1 Writer 引用损坏：确定的交付缺陷

扫描所有 23 份 WorkResult 正文的 **85 次 result 引用**，其中 7 次不能匹配本 Team 的权威结果集合，全部来自 Writer：

| 错误 ID | 出现次数 | 正确 ID |
| --- | --- | --- |
| `result:20a7f0da-f236-42e4-a8a6-9568-482e80394e542` | 2 | `result:20a7f0da-f236-42e4-8a30-9ff9498bb6a4` |
| `result:db26efa9-e7fa-44e8-bb5a-ffd2bed74350` | 3 | `result:db26efa9-e7fa-44e8-b2a5-ffd2bed74350` |
| `result:037e4dff-5d9c-4eca-b09c-99c82469b34e` | 2 | `result:037e4dff-5d9c-4eca-b09c-fa5fdca032de` |

Writer 原会话的三个成功工具返回分别为 `73c596bb`（行 84，relay）、`ae2122be`（行 57，FINAL_RPC）、`7b88ac92`（行 67，CROSS_GUARD），均含正确 ID；它最终的 assistant reply `bde6a92a`（行 129）却已经写错。父 journal `71ac8aa4`（行 67）保存了该结果。

父层逐一深比较 **全部 23 个 Worker reply.result 与 journal 的提交内容，完全一致**：宿主没有替换、损坏或“修正”结果。错误源于模型自由文本生成，正确的结构化 inputRefs/status ID 本身没有损坏。Runtime 对这种普通文本引用没有语义有效性校验；本轮不把这项产品边界冒充为传输故障，也不把存在正确结构化字段当作整份报告正确的证明。

Manager waive/partial 合理：brief 仅明确允许修订 reviewer 根，且要求唯一 Writer 根。未为得到绿色成绩越权返工或覆盖不可变结果。

### 5.2 合法 WorkRef 的角色误称

所有 WorkResult 正文共 **89 次 work 引用**，没有未知 work ID；但 verifier 的结果 `248a5961`（父 journal 行 64）把 RPC work 写成 “writer parent”，source 结果 `97618bfe`（行 66）把它写成 “writer root”。

`work:1900e91b-ae9a-4511-9085-0ba57dd15b61` 实际 assignee 是 `mt0930-rpc`，requester 是 `mt0930-source`，rootId 才属于 writer。Manager 在精确 work 查询中也核实了此点。这属于角色语义误述，不能只用 ID 存在性检测发现。

### 5.3 父层新增：Relay 把摘要当全文

Relay 根结果 `result:20a7f0da-f236-42e4-8a30-9ff9498bb6a4`，父 journal `9293e074`（行 54），在 summary 写“全文确认”，evidence 写：

```text
source = RETURNTRIP_RPC activation outcome and full result
basis = observed
```

但 relay 原会话只有 **6 次 team 调用：2 request、2 yield、2 reply；status(result)=0**。恢复输入 `cdded8eb`（行 77）仅包含 RPC outcome 的 `preview.status/summary` 和 resultRef，没有其完整 findings/evidence。Relay 自己执行过 CALLBACK，nonce 和往返链真实成立；**不能因此声称读取过另一成员的完整 RPC ResultRecord**。

影响：不否定 return-trip 或依赖交付机制，但违反角色职责中的完整结果核对要求，并把证据强度说高了。Manager 基于 root 全文验收时没有查原始调用轨迹，接受该根，因此“Manager 已接受”不等同于父层独立审计通过。这是 subagent 引用审计范围外、父层亲自核对后增加的发现。

### 5.4 纠正 subagent 的一处证据表述

独立审计 subagent 正确发现 Writer 的 3 个错引和 2 处角色误称，但它写“Writer 的 8 个 inputRefs 包含上述三个权威 ID”不准确。8 个初始引用只包含 relay；FINAL_RPC/CROSS_GUARD 是后来创建并完成的工作，其结果通过 source outcome 及后续 status(result) 获得。父层按 Writer 的输入和工具返回重新核对后采用了上面的准确归因，而不是直接复制 subagent 的证据描述。

## 6. 父层审计方法与验证结果

在 subagent 审计结束后，父会话独立解析：父 journal 的全部 launched/result/decision/close_decision/terminal，以及 9 个成员的原始 JSONL。没有调用 subagent 去继续或恢复这些已结束 session。

结构化脚本实际断言：

1. 9 个成员各只有一个 session；实例、thinking change 和所有 assistant 消息的模型均符合指定策略。
2. 47 次 activation 每次只有一个持久化工作输入、一个 input_ready 和一个固定 user trigger；provider gate 在 input_ready 之后。
3. 每次成功 reply/yield/close_team 都是该 assistant 批次唯一工具调用；之后没有同 activation 的新业务调用。全部原生 tool_gate 有相应 tool_result 确认证据。
4. 全部 23 个显式 reply 与提交结果精确相同，提交时间不早于该 activation 最后私有 ACK。原日志不单独持久化 RPC `agent_settled` 事件，不能把 ACK 时序称为独立抓取了它；原生 settled 要求同时结合 driver 源码及集成回归判断。
5. 13 次成功依赖等待均在恢复输入中含全部精确依赖，共 15 个 outcome；取消仅一 child；无同成员 activation 区间重叠。
6. reviewer 关闭后 rev1 原文不变；Writer 只在 resume 后启动；closeId 匹配；全部资源 released；没有未解决 incident。
7. WorkResult 的 result/work 文本引用与权威集合比较；再人工核对语义角色、全文读取声称和实际 toolResult。

最大 activation 输入 `22453` 字节，最大 WorkResult `9469` 字节；本轮没有触及 64 KiB 输入、32 outcome 分批或 12 KiB 结果极限。所有非 team 工具均是 read 或以 rg/wc 开头的只读命令；工作区没有新增业务修改。

全量检查使用新的临时 HOME/agent、`env -i`、`PI_OFFLINE=1`、`PI_TELEMETRY=0`、npm offline 和 loopback NO_PROXY，不带在线模型凭据：

```bash
npm run check   # 在上述隔离环境中执行 typecheck + npm test
```

实际 exit=0；tests/pass **995/995**，fail/cancelled/skipped/todo 均为 0；测试阶段 `84143.880112 ms`。未修改任何代码后，不重复跑同一全量检查。

## 7. 限制与后续建议

- launch 文本的时间线上限 100 条，本轮提示省略了 36 条早期 milestone。父层靠原生会话恢复了早期时序；这不是工作或结果丢失，但长流程不能只依赖 launch 的有界时间线审计。
- 没有 TUI 人工目视验收、长期压力/性能测试、断网/进程崩溃注入、host grant/cancel/pause 交互、预算耗尽、原生 compaction、运行中强制修订取消或未知 outcome 的恢复验收。
- 角色和流程被明确指定，不能由这一次成绩推断自由任务分解质量或多次重复运行的可靠率。
- 如后续改进交付校验，优先考虑将真正的证据引用做成结构化字段，并在验收时校验它们与作者/WorkRef 的关系；普通自然语言 source 还可描述文件、命令等，不能一概要求它都是 result ID。这里只建议，不实施接口变化。
- 对“已读全文/已执行验证”的声明，验收应核对工具轨迹，而不只看最终文字；本轮 Manager 检出错 ID，却漏掉 Relay 的全文声称，是两种不同问题。

**最终判断：本轮在线协作机制在已测试路径上正常收敛；引用准确性、部分证据声称和 Manager 语义验收未全部达标。保留 `partial` 是准确结论，不应改称全面成功。**

## 8. 本地证据索引

原会话位于 `~/.pi/agent/sessions/--Users-zzq-Develops-pi-rail-ui-team-dev--/`：

| 用途 | session 文件 |
| --- | --- |
| 父 journal/原始 prepare | `2026-09-30T23-26-36-420Z_01a0f4a4-3184-75d9-987b-e0daf446fa70.jsonl` |
| Manager | `2026-09-30T23-32-28-134Z_01a0f4a9-8f63-76aa-bf87-c66bb02d560d.jsonl` |
| Writer | `2026-09-30T23-32-28-115Z_01a0f4a9-8f52-700f-aca6-c2c8a6dc5bd6.jsonl` |
| Relay | `2026-09-30T23-32-28-129Z_01a0f4a9-8f60-77ec-979d-436cf12cd05c.jsonl` |
| Verifier | `2026-09-30T23-32-28-127Z_01a0f4a9-8f5c-718b-bdd0-83d8b7563852.jsonl` |

父层结构化审计脚本 `/tmp/rail-live0930-audit.mjs`；输出 `/tmp/rail-live0930-audit.json`。本地可重新运行：

```bash
node /tmp/rail-live0930-audit.mjs /path/to/parent-session.jsonl /tmp/rail-live0930-audit.json
```

全量日志：`/var/folders/zw/gcpf3t91243dhn6z3bb278s00000gn/T/rail-live0930-check.3JijSv/check.log`。临时脚本、日志和原始 session 不进入 Git；以上本地路径是本轮证据定位，不是假设在其他机器上也存在的可移植测试夹具。
