# Team 六阶段长程在线测试与独立审计（2026-10-01）

## 1. 结论

**本轮在线流程与最终报告通过限定验收：Team 实际以 `closed/succeeded` 收尾，全部 16 个当前根 accepted，9 个成员资源释放。不能由此推断所有中间结果都准确。**

针对上一轮的问题：

- 新短 ID 及转交文本校验实际生效：Worker 两次坏 result ID、Manager 六次坏 work ID 均在变更前拒绝，可继续同一 activation。76 份提交结果中，按当前短 ID token 格式扫描的 1289 次引用没有未知 ID。
- Relay 本轮真实读取了 BOOT 和两轮桥接结果全文，未重现上一轮“仅收到 preview 却声称 RPC 全文已读”的核心问题。
- Writer 终稿的 23 项 `full_read_ids` 与其当前 WorkRef 的成功工具调用完全吻合；最终验收者的 29 项同样吻合。终稿未提前声称 P6 或 Team 已关闭。
- 真实错任务没有被 `succeeded` 状态掩盖：RPC 一度把旧 DATA_PROOF 当作 FINAL_RPC 回复，下游 Source 检出、attention 请求处理，Manager 对同 work 原位修订一次后完成深链，旧错误结果保留。

**全量父层审计仍发现问题：** 错任务历史结果还虚报了 3 项全文读取；另有一处 `work:work:r2fu` 重复前缀；两份结果漏列实际已读项。最终报告有准确的范围限制，但并不构成全量中间结果 provenance 的通过证明。没有发现本轮已核对路径中的确定性 Runtime 状态损坏、非预期 provider error/abort 或资源清理失败。

本次完成测试、两项并行独立审计，再由父会话亲自重新解析与核验。只新增本报告，不修代码，不覆盖历史结果，不重跑在线场景制造全绿。

## 2. 基线、模型与规模

| 项 | 实际值 |
| --- | --- |
| 被测 HEAD | `b6c856a2998d6efcb28ca19f7ace6d942518b6d9` |
| 相比上一轮的更新 | `c20ec31`：引用校验、最终 review verdict、preview 指引；`b6c856a`：4 字符 Team-local ID 及所有转交文本引用校验 |
| Node / Pi | `v24.15.0` / `0.87.1` |
| Team ID | `468da433-f516-4533-8ced-bedbe1033469` |
| Manager | `lc1001-lead`，`cus-resp/gpt-6.1-sol:xhigh`，Fast off |
| Workers | source / relay / verifier / scheduler / rpc / reviewer / writer / gate；全部 `cus-resp/gpt-6-luna:max`，Fast on |
| ContextWindow | 原生默认 `372000`，reserve `16384`；没有人为缩小窗口 |
| launch / terminal（UTC） | `2026-10-01T01:42:26.711Z` / `02:54:24.995Z` |
| 墙钟运行时间 | `4318284 ms`，**71 分 58 秒**；无 Team 总 deadline |
| 工作项 | **69 个：16 roots、53 child**；9 次成功修订，共 78 个版本 |
| 不可变结果 | **76 份**：75 succeeded、1 合成业务 failed；当前 67 resolved、2 cancelled |
| Activation | **147 次：Manager 29、Workers 118** |
| 模型调用 / 工具 | **502 轮 / 889 次工具**，其中 team 867、read/bash 22 |
| 等待 | 35 次成功依赖 yield；34 次恢复共交付 54 个准确 dependency outcome；另 1 次等待所在中间节点被授权取消，不应再次运行 |
| attention / Manager yield | 7 次 / 28 次 |
| 全文读取 | 482 次成功 `status(result)`，涉及全部 76 份结果；按实际作者/WorkRef/提交时点审计声明 |
| 深度与并发 | 最大 child 深度 5；input_ready 至最后私有 ACK 的 Worker 区间峰值为 4，同成员重叠 0 |
| 关闭 | 当前 16 roots 均 accepted/succeeded；7 incidents 均 resolved；9 members 均 closed/released |

结果数与当前 resolved 数不矛盾：67 个当前 resolved + 9 个旧版本结果 = 76；两个 cancelled 节点没有提交结果。历史 failed child 的 rev1 保留，而同 child 当前 rev2 成功。

对比上一轮：

| 指标 | 上一轮 | 本轮 |
| --- | ---: | ---: |
| 阶段数 | 3 | 6 |
| work ID | 23 | 69 |
| roots / children | 8 / 15 | 16 / 53 |
| activations | 47 | 147 |
| 模型轮次 | 130 | 502 |
| 工具调用 | 165 | 889 |
| 时间 | 12:15 | 71:58 |
| Team 最终 outcome | partial | succeeded |

这是更复杂、实际运行近 72 分钟的一次协作测试，不是重复负载基准或多次可靠率统计。

## 3. 六阶段场景与完成证据

### P1：短 ID、四槽让出、双往返与错误边界

四个 initial roots 同时进入原生会话，分别向 roster 第 8 个 Worker gate 请求 BOOT_LEAF 并 yield。叶子 summary 只报完成，witness 放在 findings 中，迫使父节点读全文。

```text
source → gate BOOT → 错 request.task / 错 reply.locator → 纠正后提交
relay → rpc → relay CALLBACK → 原根恢复
      → reviewer → relay CALLBACK → 原根再次恢复
scheduler → reviewer → gate ATTEST → 逐层恢复
verifier → self / worker control / unknown recipient / 重复依赖探针
```

- 4 initial roots 未被 Manager 重派。首个 relay yield 在 `01:42:38.486Z`，gate 输入在 `38.502Z`，说明等待释放许可后后排成员能接力。
- 每个成员始终同一个 session；Relay 的两次 CALLBACK 与根恢复都在其持久会话内。
- Source 最初误把坏 token 写成 `result/r7p2`，不符合冒号 ID 格式，**实际成功创建额外 RPC child `work:w93g`**。它如实 attention，Manager 确认 child 已成功结清后恢复；没有取消或回滚。
- 随后真实 `result:r7p2` 分别出现在 request.task 和 reply.evidence.locator，均返回 UNKNOWN_RESULT，并建议 `result:r7pv`；坏 reply 没有提交，继续同 activation 纠正。
- Relay 根 `work:7pgv@1/result:qf87` 真正全文读取 `result:wek2`、`result:zv4j`、`result:2amf`。其直接读取清单恰好这三项；callback 由各桥接节点读，终稿没有夸称 Relay 根也直接重读了全部 callback。
- scheduler 的提前 reply 被 UNRESOLVED_CHILDREN 拒绝；verifier 四种授权错误之后正常完成。

**边界：** gate 是在首个许可释放后启动，不是“四人全部 yield 之后才开始”的严格屏障；峰值区间证明达到 4，但不证明所有微观调度时刻或所有启动排列。

### P2：18-child 扇出、共享队列、分页与跨根等待

唯一 Source root `work:w979@1` 创建 18 个 child，gate/rpc/reviewer 各 6 个，共享其持久队列，不新建 producer root。

- 一次成功 yield 同时等待全部 18 个 receipt WorkRef；恢复 activation `37631301` 实际携带 18 个 resolved outcome。
- ownedChildren 只显示 8 个、omitted=10；Source 不把这个预览当完整义务。
- Source 以 limit=5 连续读取 7 页，cursor `page:5` 至 `page:30`，最终 hasMore=false。按精确 `parent.workId=work:w979` 与 revision=1，得到恰好 18 项，无重复。
- 随后逐个全文读取结果并核对 index/author/work/witness；Peer verifier 也读取 producer 与全部 18 叶子，独立比对。
- `work:832e@1` 先 attention，请 Manager 提供已有 producer WorkRef，随后直接跨根 yield，收到 Source 的结果，而非重新 request 一个 producer。
- Source 恢复后又对已投递的 16 项多余 yield 一次，被 NO_NEW_DEPENDENCY 拒绝。它是模型步骤冗余，不是第二次成功等待或结果丢失。

证据：Source 页回执位于其 session 行 331–405；聚合 `result:j5n8` 与跨根 verifier `result:d2nc`，父 journal 行 181–182。父层直接核对 receipts/outcomes/page parent，而不是只采用这些报告的文字。

### P3：六种控制文本拒绝、两轮 attention、子树取消与失败原位重试

三个并行根：gate SCOPE_TWO、verifier CANCEL_PARENT、rpc RETRY_PARENT。

**控制文本拒绝：** 在 gate 第一次 attention hold 时，Manager 对同一坏 `work:u4m2` 分别在 request.task、revise.task、cancel.reason、accept.reason、resume.instruction、close.reason 尝试一次。全部实际 UNKNOWN_WORK，gate 仍是同 work rev1，合法 resume 后完成第二轮 attention；没有额外 root、修订、取消、waive 或关闭决定。

**子树取消：**

```text
verifier root work:uq8w
  ├─ gate work:p92g → rpc work:u4u6（attention）
  └─ gate work:2qk3（SURVIVOR）
```

gate 最初把祖父 verifier work 当作中间 parent 写进请求。RPC 依据自己的 authoritative scope.parent 指出了真实 gate `work:p92g`；Manager 读取账本父子关系后只取消这个中间 child 子树。`p92g/u4u6` 均 cancelled，SURVIVOR `result:gf4r` 成功；verifier 根收到 cancelled+resolved 的 AND outcome 并完成。说明合法但语义错配的 ID 不会被存在性校验发现，实际账本核查防止了误伤。

**失败重试：** reviewer child `work:w46j@1/result:9edh` 按计划提交 status=failed 的合成结果；RPC 原生恢复、读 failed 全文后 attention 请准重试。Manager 将同 child 修订为 rev2，再恢复 RPC 父；`result:34aw` succeeded，旧 failed 结果保留。没有把业务失败当 provider/transport 故障。

取消的是已 yield 的节点，修订的是已经提交的 child；本轮不等于验证正在执行外部副作用的强制中断。

### P4：三版上游、两个下游连续返工与中间独立审查

| 角色 / 稳定 work | rev1：101 | rev2：202 | rev3：303 |
| --- | --- | --- | --- |
| source `work:8qmm` | `result:pa3b` | `result:thf7` | `result:9q2y` |
| relay A `work:6we2` | `result:5mv8` | `result:4z82` | `result:9w8h` |
| scheduler B `work:9hjx` | `result:y7as` | `result:rn2g` | `result:6xy5` |

全部数值是明示的合成 dataset，不是源码测量。每轮上游给 gate ATTEST，两下游向共享 reviewer/rpc 请求 proof；A rev2 还经过 rpc→同 relay CALLBACK。旧结果全文读及 WorkRef 不变的版本 lineage 均核对。

rev2 后 reviewer 根 `work:583d/result:kmk5` 委托 verifier 独立审查六个版本。其范围只覆盖 101→202，终稿没有外推为独立审查了 303。源码许可数真实值仍是 4。

Manager 对 source/A/B **只 accept current rev3**，从未 accept 这些根的 rev1/rev2。父层核对实际控制回执与 terminal roots，而非只信文本。

### P5：草稿返工、五层深链、真实错任务恢复及并行双审

writer 在 P1–P4 零 activation，pause/resume 各一次。P5 唯一 writer work `work:6552`：rev1 真读 13 个输入出暂定草稿；reviewer REPORT_REVIEW 委托 verifier REF_CHECK 与 relay FULLCLAIM_CHECK，提出具体四项修正；Manager 再修订同 Writer 为 rev2。

```text
writer work:6552@2
  → source work:yu6p@1
    → rpc work:ax75@2
      → verifier work:d52u@1
        → relay work:gcm5@1
          → gate work:6x5q@1
```

第一次 RPC rev1 `result:pt2s` 虽 status=succeeded，却返回了旧 DATA_PROOF 的 epoch=3/value=303 与旧 work locator，没有创建 FINAL_VERIFY。Source 全文读结果后拒绝将其算作完成，attention `incident:uje5`；Manager 对同 `ax75` 作唯一精准 rev2 纠正，没有重建 Writer/source 根。rev2 才完成上面链路。

gate 单次等待祖先 source，实际返回 DEPENDENCY_CYCLE；路径是 `6x5q→yu6p→ax75@2→d52u→gcm5→6x5q`。它随后正常 reply；各层逐一恢复、读 child 全文后回复，精确 witness=`final-gate-6x5q`。

Writer 接到 Source 后，又并行给 reviewer FINAL_TEXT_REVIEW 与 scheduler FINAL_MATRIX_REVIEW 审待交付摘要，AND 等两份全文反馈后形成终稿 `result:dsx4`。Verifier 最终根 `work:jxf6/result:7ee5` 读 29 项及真实 parent 链，Manager 才接受 Writer/current checker。没有额外 Writer rev3。

### P6：提前释放服务成员、读历史、closed 拒绝及整队关闭

Manager 先 close rpc/gate，yield；下一 management 输入 `bd2b9d59` 包含两条 MEMBER_CLOSED，明确 confirmed resource release。随后读 rpc 旧 `result:zv4j` 与 gate 旧 `result:r7pv`，全文与原 journal 深比较一致；唯一 CLOSED_PROBE 请求 rpc 得到 RECIPIENT_CLOSED，没有新 work。

成功 close_team 只一次（另一次是前面的故意坏 reason、已被拒绝）。close_decision/terminal closeId 相同；所有成员 closed/released，已无 queued/running/blocked/held，7 incidents resolved。终稿和最终验收记录提交时 P6 确实未开始/未完成，因此它们写 pending 是准确时序，不与之后成功 terminal 冲突。

## 4. 新改动的直接验证与局限

### 4.1 短 ID 的实际行为

本 Team 的 work/result/incident/event codes 均为 4 个允许字符、含数字；各类实际 ID 没有一字符替换或相邻换位后变成另一有效 ID。prepare 本身已经返回 short WorkRef，说明 live host 用到了新实现，不是只读了新源码却仍跑旧 Runtime。

Source 错引用的 toolResult：`bb1ab572`（行 103，request）、`af052e7f`（行 113，reply locator），两者都返回 UNKNOWN_RESULT 与 did-you-mean。Manager 六次拒绝的 toolResult 分别为 `0244ceda/c982c44f/af1dfc3b/923bbb7a/76041045/99d45853`（行 674–724），全部 UNKNOWN_WORK。

**格式边界：** `result/r7p2` 不符合约定 token，不被引用守卫识别；它是本次错误探针操作偏差，而不是已验证的冒号格式校验失效。不能把该成功 request 记为拒绝。当前守卫也不做自由文本语义身份验证：引用的 ID 即使存在，仍可能被用在错误的角色、locator 或任务里。

### 4.2 preview/full 的改进

Relay 本轮成功工具全文回执 `be20b261/e5715411/9956aaed`（原 session 行 47/99/151），分别包含 BOOT、round1 RPC、round2 reviewer 完整 findings/evidence。清单与调用一致；双回程确实复测了上次漏检路径。

终稿的 23 个声明与当前 Writer rev2 下提交前的真实全文查询集合完全一致；最终 checker 的 29 个也相同。全文读取声明必须按 **作者 + WorkRef/revision + 提交前时间** 匹配，不能把另一个 work/上一任务读过的内容冒充本任务已读。

## 5. 父层全量审计发现的残余问题

### 5.1 高优先级：错任务历史结果还虚报了读取证据

`result:pt2s`，父 journal `c19766dd`（行 223），RPC `work:ax75@1`：

- authoritative activation `18e7ce0a`（RPC 行 445）的当前 task 明确是 FINAL_RPC，15 inputRefs 为当前阶段/草稿/审查结果。
- 它确实在这个 WorkRef 读了这些 15 个输入，却在 reply `1fd61f3c`（行 567）填入旧 DATA_PROOF 的内容、`scope.work/task` locator=`work:5cpg@1`、旧读取清单。
- 声明中 `result:pa3b/result:thf7/result:rn2g` **没有在本 WorkRef rev1 中成功全文读取**；实际读取的另 13 项也没有列入该 artifact。

其内容与此前 `result:vbg8/work:5cpg` 的 DATA_PROOF 大部分相同，但不是逐字完全相同。证据支持“旧任务内容带入当前 reply”，不能凭此断言 provider/native 协议重放。所有提交结果与原 Worker reply 深比较一致，宿主没有改写。

恢复后的 `result:g7pu/work:ax75@2` 清单与真实读取一致，deep chain 正常完成；错误 rev1 不再作为当前链证据。这不抹去历史结果自身的 provenance 缺陷。最终审稿指出错任务，但未对该历史清单做原生轨迹核验。

### 5.2 中优先级：双前缀 WorkRef 可通过存在性检查

`result:43gn`，父 journal `85087fbc`（行 204），RPC `work:8ec7@1` 的一条 finding 写 `work:work:r2fu@1`。真实 callback 是 `work:r2fu@1`；该结果其他字段、实际 parent/author 映射正确，后续审稿也保留为格式瑕疵。

新守卫匹配的是短 token，能从上述文字中识别已存在的尾部 `work:r2fu`，没有拒绝整个双前缀表达。这不是未知 ID 或账本损坏，但说明“没有未知 token”不代表每个自由文本 WorkRef 表达合法；结构化身份字段没有错。

### 5.3 低优先级：两份全文清单不完整

- `result:rn2g/work:9hjx@2`：artifact 列 4 项，实际同 WorkRef 读 5 项，漏 `result:jj86`。
- `result:v7aw/work:ae2y@1`：artifact 列 14 项，实际读 17 项，漏 `result:gf4r/result:9edh/result:34aw`，它们在 findings 中被使用。

这两项是漏列，不是虚报未读。总计 45 份显式清单中 **42 份完全一致、3 份不一致**；3 份包含上面的 `pt2s`（同时有虚报与漏列）。不应把“1 虚报 + 3 有漏列”误加成 4 份不同结果。

### 5.4 父层额外核对：Manager 对 review 可见性的纠正过度保守

Manager 的 REPORT_REVIEW accept reason `0de31a6e`（lead 行 1664）否定了子审稿“status(work) 能看到 accepted disposition”的归因。但实际 verifier 的 work 查询：他人 work 摘要有 `review:"accepted"`（如 `work:u4mb` 返回 `d38d1fd8`，行 655）；自己的 work 全视图有 `current.review.disposition:"accepted"`（如 `uq8w` 返回 `28e23305`，行 662）。P1–P4 这些 acceptance 状态的观察本身有依据。

正确区别是：**查询能观察验收状态，不等于直接读取原始 accept_result 控制回执**。终稿保留后者的限制没有损害结果，但不能把前者一并否定。这是 Manager 的解释偏差，不是接口行为缺陷。

### 5.5 其余执行偏差

- Source 斜杠探针意外创建 child，已结清而非撤销；第一次恢复后再次等已观察结果被拒。FANOUT 恢复后又多余 yield 一次，也被拒。都在同队列继续收敛。
- gate 给 CANCEL_GRAND 的请求误写 parent，RPC 与 Manager 依据真实 scope/ledger 纠正后没有误伤 root/sibling。
- gate 报告的源码 `workerPermits` 定位为约 193 行，当前文件实际字段为 204 行。值为 4 正确，但位置不准确，终稿明确保留定位限制。
- 草稿的 survivor witness 加错前缀，被审稿要求修正；终稿为准确 `SURVIVOR-2qk3`。

## 6. 验证方法、错误统计与效率

两名一次性审计 helper 分别检查交付准确性/原生控制行为；随后父会话独立解析全部 9 个 session 与本 Team 的父 journal，并核对 helper 的发现和不足。没有恢复或重开 Team 成员，没有调用 status 轮询已结束 Team。

父层脚本与人工实际检查：

1. 每成员只有一个 session；实例、thinking 记录、全部 assistant 模型符合指定策略，无 model drift。
2. 147 次 activation 均为持久化 custom input→input_ready→provider gate；固定 trigger 和 readiness 每次各一份。
3. 每次成功结束意图是 assistant 批次唯一工具；之后没有同 activation 新业务。原生 tool_gate/tool_result 成对。
4. 全部 76 个 explicit reply 与 journal WorkResult 深比较一致；482 次全文读的 author/work/content 与不可变结果一致。提交不早于该 activation 最后私有 ACK。RPC `agent_settled` 不单独持久化到此 JSONL，因此 ACK 时序不能冒充抓取了完整原生事件流。
5. 成功依赖等待除一项被授权取消外，均恢复同 WorkRef并交付全部精确 AND outcome。没有同成员运行区间重叠；Worker 可观察区间峰值 4。
6. FANOUT 的 18 receipts/18 outcomes/7 pages/精确18 parent核对；source/A/B 三版与只接受current3；当前roots全部成功验收；关闭关联与成员释放一致。
7. 按短 token 扫描 1289 次正文引用，无未知；另检查双前缀、角色/任务/版本语义，以及 full_read_ids 与对应 WorkRef 的真实调用。

### 实际工具错误

| code | 次数 | 含义 |
| --- | ---: | --- |
| UNKNOWN_RESULT | 2 | Source 冒号格式坏引用 request/reply |
| UNKNOWN_WORK | 6 | Manager 六项转交文本探针 |
| NO_NEW_DEPENDENCY | 3 | 1 个计划 probe、2 个额外冗余等待 |
| SELF_REQUEST / FORBIDDEN_ACTION / UNKNOWN_MEMBER | 各 1 | 权限/接收者边界 |
| UNRESOLVED_CHILDREN | 1 | scheduler 提前 reply |
| DEPENDENCY_CYCLE | 1 | 深链末端等待祖先 |
| RECIPIENT_CLOSED | 1 | P6 对已closed rpc 请求 |
| **合计** | **17** | 全为结构化 Team 工具错误，全部恢复/收尾 |

合成 failed `result:9edh` 和错误 payload 但 succeeded 的 `result:pt2s` 都不是 toolResult.isError，不能混进此表。没有 schema/JSON 解析错误、read/bash 错误或 provider error/abort。没有原生 compaction 记录。

### 效率与观测限制

Manager 29 个事件 activation，28 次 checkpoint-only yield，无 waitingFor/attention 管理等待。它做了 **112 次 status 查证**（result 79、work 30、team 2、incident 1）；没有同 activation 重复查询来等待未完成结果，但不能表述为“无需或没有 status”。其原生 activation 总占用约 **41:38，占墙钟58%**，其中一次草稿审阅 activation 持续约 6:39。存在反复审读聚合/叶子证据和较长模型决策时间，值得优化；这是观察，不是归因于 Runtime 调度性能的基准结论。

Usage：input `3645784`、output `204176`、cacheRead `42251264`，配置返回 cost=0 不等于真实服务免费。Fast policy 已pin并记录于描述，未抓实际网络优先服务，也没有 Fast off 对照，不能宣称提速。

终态预算：147/512 activations、29/128 Manager activations、502/1024 model requests、889/4096 tools、69/512 works，未触预算 hold，无 grants/emergency。最大activation输入24250字节、最大WorkResult5070字节，没有测试64KiB/12KiB字节极限或超过32outcomes的分批。

launch 时间线上限100条，提示省略303条早期 milestone；原始session/journal仍完整可审计，这不是工作丢失。但长程审计不能只靠有界面板时间线。

## 7. 离线回归、未覆盖范围与建议

在线前在当前 HEAD 做了全新的临时 HOME/agent、`env -i`、PI_OFFLINE=1、PI_TELEMETRY=0、npm offline、loopback NO_PROXY 的隔离 `npm run check`。实际 exit=0，typecheck通过，**999/999 tests passed**，fail/cancelled/skipped/todo均0，测试阶段77611.329612ms。之后只有审计与文档，无源码改变，不重复全量测试。

未覆盖：断网、进程崩溃、原生 cleanup 未确认/未知 outcome 放行、运行中外部工具强制取消/修订、host grant与预算耗尽、原生compaction、TUI人工目视、跨父进程恢复、一般无死锁/无竞态证明、多次重复负载或自由任务规划可靠率。

建议（仅分析，不实施）：

- 继续区分引用存在性、当前任务身份、真正全文读取及业务完成，不能以单一 succeeded/accepted字段代理全部语义验收。
- 对 full_read_ids 做按作者/WorkRef的实际成功调用校验；本轮最终清单准确，但同成员旧任务读取不能证成本 work 的清单。
- 可对重复kind前缀等明显形态错误给可纠正诊断；不要把任意自然语言 source 都硬改为result ID，仍应支持文件、命令和观察说明。
- 减少所有层重复读取全套历史结果；保留职责相关的精确结果与必要独立核验，避免Manager/深链把同一聚合一再全文扫描。减少读取仍不得虚报已读。

**最终判断：六阶段长程协作、纠正与关闭通过；新短ID及preview引导改动有效。最终报告可接受，但全量历史结果的引用形态和读取provenance仍有明确瑕疵，不能宣称所有问题已消失。**

## 8. 本地证据索引

原会话目录：`~/.pi/agent/sessions/--Users-zzq-Develops-pi-rail-ui-team-dev--/`。

| 用途 | 文件 |
| --- | --- |
| 父 journal | `2026-09-30T23-26-36-420Z_01a0f4a4-3184-75d9-987b-e0daf446fa70.jsonl` |
| lead | `2026-10-01T01-42-26-276Z_01a0f520-8ce3-74af-ae85-f036c372c35b.jsonl` |
| source | `2026-10-01T01-42-26-267Z_01a0f520-8cda-77ce-b258-58b575f2e62d.jsonl` |
| relay | `2026-10-01T01-42-26-293Z_01a0f520-8cf3-75b1-ba85-5a17dba3b6f8.jsonl` |
| rpc | `2026-10-01T01-42-26-262Z_01a0f520-8cd5-7250-8498-781e022a44a4.jsonl` |
| scheduler | `2026-10-01T01-42-26-281Z_01a0f520-8ce8-76e3-ac45-9c21ec5a0322.jsonl` |
| verifier | `2026-10-01T01-42-26-318Z_01a0f520-8d0d-73ac-bf41-a6dd2efab812.jsonl` |
| reviewer | `2026-10-01T01-42-26-280Z_01a0f520-8ce5-72e1-ac59-ef42cb617889.jsonl` |
| writer | `2026-10-01T01-42-26-319Z_01a0f520-8d0e-725d-bf36-fa5d76f445e9.jsonl` |
| gate | `2026-10-01T01-42-26-269Z_01a0f520-8cdc-7029-b293-bf19dc1cf0e8.jsonl` |

父 journal 的 launched=`d494ec0f`（行147）、terminal=`b5d37bd3`（行235）；原生工具各行号按本轮封存记录给出。父审计脚本 `/tmp/rail-long1001-audit.mjs`，输出 `/tmp/rail-long1001-audit.json`；离线日志 `/var/folders/zw/gcpf3t91243dhn6z3bb278s00000gn/T/rail-long1001-check.V9BsQ8/check.log`。临时脚本/输出和session不进Git；这些是本机证据位置，不假设别的机器也存在。
