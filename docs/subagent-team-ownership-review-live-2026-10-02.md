# Team Ownership / Lead / 定期 Review 长程测试（2026-10-02）

## 1. 最终结论

**本轮在线业务、owner 控制、childIssues、lead 普通 work 与定时 review 正常收敛，Team 以 `closed/succeeded` 关闭，27 个当前业务根全部 accepted，9 个成员资源释放。仍不能称最终报告或全部工具尝试零缺陷。**

- 全部 12 个 OWNER12 child 由其 requester/source 自行恢复，没有向 lead 发这些 child 的 WORK_HELD。非 lead 的 owner revise/cancel、失败 child 原位重试，以及 verifier→scheduler→gate 的逐级恢复均有实际成功回执。
- lead 既处理 events，也执行两个不同的普通 work；六深链中 lead 请求独立 source CALLBACK，真实回程完成，没有把成员回问当作 WorkRef 环。
- 真实定时巡检 **21 次**，3 分钟快照间隔相符，12 on_track、9 at_risk；首次两个 review request/control 探针被拒，后续不再控制业务。review 计入资源/模型使用，但不是业务交付物。
- 新 `members/lead`、tools 白名单和 long 预算实际使用；原生声明与调用均满足设定。lead/纯协议成员仅 team，source/scheduler/reviewer 仅 read+team，不等于 OS 沙箱。
- **最终报告读取清单仍漏一项：** writer `result:waz4` 实际本 rev 读取21个不同结果，清单只列20，漏旧审稿 `result:6h5e`；没有虚报未读，但完整性验收未全通过。另一个普通叶子 summary 漏 `LABEL=`，CURRENT/author正确。
- **父层新增发现：** 全部原生工具错误实际25次：Runtime Team action 7、前置schema拒绝3、read错误15。最终 Process `tool errors=7`只表示Runtime统计，不是全部原生错误。不能沿用独立审计的范围性计数，把另外18次写成没有发生。
- 隔离全量 typecheck + **1116/1116 tests passed**；宿主handover、childIssues容量、review取消/定时器与Progress历史另有隔离补充验证，没有冒称在线handover或TUI目视。

任务仅测试、审计和文档交付，不修改功能代码，不修写不可变历史结果，不反复运行在线场景制造全绿。

## 2. 本次变更与基线

被测 HEAD：`2ef985442679803dac72517565bc0a0417333443`。相对上一轮 `f953b5a`，工作区更新较大；本轮重点覆盖 Team 相关改变，不把其他 footer/keep-alive/rail-agent 的变化冒充逐项在线验收。

| 关键变更 | 实现内容 |
| --- | --- |
| `bcd0e84` | manager/worker类型改为同型members+lead指针；每成员tools allowlist；events、预算及incident改lead命名 |
| `3485ff8` | requester或lead控制work；childIssues优先唤醒owner；宿主handoverLead |
| `74e8fe5` | review schedule、真实定时快照、advisory权限、REVIEW_READY、journal/history记录 |
| `7e23311` | `/rail-team` Progress页：计划、live snapshot、review列表/详情/历史 |
| `2ef9854` | 最后巡检行去掉重复verdict前缀；协调lead可用tools=[] |

运行前隔离 `npm run check`：新的临时HOME/agent、env -i、PI_OFFLINE=1、PI_TELEMETRY=0、npm offline、loopback NO_PROXY，没有继承模型凭据。实际exit=0，typecheck通过，tests/pass **1116/1116**、fail/cancelled/skipped/todo均0，测试阶段79157.893527ms。之后未改源码，不重复全量检查。

前置一次性review helper曾遇到WebSocket closed 1006，未取得成功审查结果；父直接读源码/测试推进。它不属于本次Team原生运行故障。后置两项独立审计正常完成，父随后重新解析全部原记录，核对并补充其范围之外的发现。

## 3. 配置与计数口径

| 项 | 实际值 |
| --- | --- |
| Team | `ed1ec179-66ae-4160-8689-c905e601ded3` |
| lead | `ow1002-lead`，`cus-resp/gpt-6.1-sol:xhigh`，Fast off，tools=[] |
| 其他8成员 | `cus-resp/gpt-6-luna:max`，Fast on |
| 白名单 | source/scheduler/reviewer：read；其余包括lead：[]；所有成员加team |
| 周期review | by=ow1002-reviewer，everyMinutes=3 |
| 预算/上下文 | 默认long，原生372000窗口，未缩窗，无Team deadline |
| 时间UTC | `2026-10-02T04:56:03.572Z` → `06:01:32.623Z` |
| Runtime墙钟 | 3929051ms，约65:29；launch含启动显示 **65:30** |
| 普通业务work | **109：27 roots、82子任务** |
| Review work | 21；全部账本 **130 works** |
| 普通业务结果 | **117**（含不可变旧版本与一份合成failed） |
| Review结果 | 21；父journal全部result **138** |
| Activation | **245：events45、work200**；work含review21 |
| lead activation | **50：events45、work5**（两个普通work多次恢复） |
| 模型/工具 | **525轮 / 773次工具**，含本地schema拒绝尝试；Runtime预算计工具770 |
| 成功依赖/attention | **40 / 22**；questions不代表只向lead提问 |
| 修订/当前取消 | 10次修订；1个当前业务child cancelled |
| 最终 | 27当前业务root accepted/succeeded；9 members closed/released；未解决incident0 |

130+10=140个工作版本；138份结果与一个cancelled child及一个旧superseded未提交版本自洽。业务109项的统计排除review，Status Works total/预算teamWorks130包含review。成员results之和138包含review，因此不能误报“成员结果数应该加起来117”。

相对前轮90 work/156activation/47:10，本轮为109普通work+21review/245activation/65:30。没有人为sleep延长，也不是多次可靠率或性能对照。Usage input3813978、output238445、cacheRead61741056；cost=0不代表服务免费。Fast仅核策略/模型，不宣称网络优先服务或提速。

## 4. 实际在线阶段

业务阶段按brief的P1–P7执行；定期review贯穿全程，宿主控制属于结束后的隔离补充，不冒称另一个在线阶段。

### P1：owner问题、子任务修订取消和权限边界

**OWNER12 root `work:3zkc@1`：** rpc/gate/relay各4个ASK_OWNER child首次attention，source以requester身份逐一resume，批准值101..112。原session确有12个成功applied，全文读12份结果后回复 `result:m8ax`。

真实childIssues出现8项上限：source输入 `fb2591b4` 一次交付8项、omitted=1。它没有等待下一次自动交付，而是status(team)查到遗漏index12/incident:rz3k并合法resume；该issue被解决后不再需要交付。这个实际处理不等于“系统丢了第9项”；§7的独立容量harness另确认未提前解决时会8+1送达。

lead没有收到这12个child的WORK_HELD；全程只收到PEER40根和ESCALATION根两个WORK_HELD。其他正常child hold通过owner路径处理。

**OWN_MUTATE root `work:ug6x`：** relay owner将rpc child `yy9c@1` revise至@2，旧版superseded；取消gate child `t77z@1`，状态cancelled；同rpc SURVIVOR `3zmr`成功，无lead代控和sibling误伤。这里明确区分revise和cancel，不再重犯上一轮父计划对superseded的错误预期。

**权限root `z9ja`：** 控制自己当前work、非lead pause、控制第三方root，各一次FORBIDDEN_ACTION，之后可正常reply。

**源码root `2j74`：** scheduler与reviewer核源码/文档边界；其 read 路径试错和本地格式错误如§6披露，不把静态证据当在线权限/TUI验收。

### P2：40-child与跨根等待

唯一FANOUT40 `work:f8ap`，四队列各10；普通child排除review kind，精确parent分页恰40，全部对应结果全文核验。waitingFor不超过32，恢复累计观察全部40；原native分页均limit=9，末页hasMore=false。

有一项派发顺序偏离简化计划：33–35在第一次等待前预派，其后只续派36–40；没有重复、缺项或新producer。报告准确写了这个顺序，不凭想象声称“前32结束后才首次创建后8”。

PEER40根 `2s8b` attention取已有producer WorkRef，再直接跨根等待，全文核聚合并抽查01/20/40，不重派source，也不把抽查说成独立全读40。

### P3：lead普通work、owner失败重试和三级升级

- **LEAD_RETURN：** relay `23rw` 请求lead普通work `n6qr`。lead work向gate请求POLICY_CHILD `h3hh`，它held后issue交给lead的该work；lead作为owner批准value2，yield/fullread后普通reply `result:e3yh`。events与work同成员串行，未把work当events。
- **RETRY_PARENT：** rpc `q4jd` 的reviewer child `fn6c@1/result:gv7g`为计划业务failed；rpc owner自己revise child→2，输入旧failed结果，恢复为 `result:95b4` succeeded。旧失败保留，普通父根成功。
- **ESCALATION：** verifier `am8a` → scheduler `a9hz` → gate `5k8e`。gate childIssues唤醒scheduler，scheduler保存精确issue并向requester升级；verifier再根attention向lead。lead只resume verifier根批准7，verifier owner恢复scheduler，scheduler owner恢复gate。恢复完成后每层读直接child结果，三层hold解决。

这里测试的是正常owner权限和合成决策，不涉及凭据/生产系统或未知outcome。

### P4–P5：三版数据与12个独立CASE

| 稳定work | rev1 | rev2 | rev3 |
| --- | --- | --- | --- |
| source `52q7` | 5 / `result:g9g8` | 9 / `result:t2fj` | 13 / `result:6je8` |
| relay A `6nvv` | 5 / `result:z94a` | 9 / `result:q7eq` | 13 / `result:xc6q` |
| scheduler B `zcv7` | 5 / `result:x8h4` | 9 / `result:hpq4` | 13 / `result:t8p9` |

source每版rpc proof先attention，再由source owner批准；A2还有rpc→relay独立CALLBACK。lead只accept三root当前rev3，旧结果和child留存。数值全为合成fixture。

CASE01..12各不同root/当前身份，四共享成员各3，全文读DATA3=13后分别计算14..25，全数结果正确并accepted；不复用最近CASE payload。

### P6：草稿修正、六深链与审稿child自修订

唯一writer `jaf4`：rev1草稿读14个输入；DRAFT_REVIEW业务根 `kp2v` 委托verifier REF_CHECK与source PROVENANCE_CHECK。它指出真实归属错误：relay直接读lead结果，而gate结果由lead直接读；旧草稿把后者也归给relay。计划内writer@2已纠正，旧稿保留。

```text
writer jaf4@2
  → source 2hen@1
    → rpc wup3@1
      → verifier 3duq@1
        → gate 2ga2@1
          → lead qv3d@1
            → source CALLBACK mhp3@1
```

gate先单次等待祖先source，收到DEPENDENCY_CYCLE，再请求lead普通work。lead请求独立source callback、等待/fullread后返回value13；各层逐级恢复。成员相同不等于WorkRef相同，callback没有依赖环。

writer并行请求FINAL_MATRIX与FINAL_TEXT。初版TEXT `result:6h5e`由于没有候选终稿，诚实给NEEDS_FINAL_CORRECTION；writer作为owner修订该审稿child同work `8fyt@2`，补候选正文，得到 `result:jbh6` PASS。它不是新建审稿root，也不是修改旧审稿结果。终稿 `result:waz4`及独立checker `result:tk44`最后被lead接受。

### P7与关闭

全部普通root accepted后，第一次close_team被CLOSE_BLOCKED拒绝，唯一blocker为未交付到当前batch的 `team_event event:8fta`。该事件对应已完成的最后一次REVIEW_READY `result:s9xk`，**不是review work仍在执行或必须accept**。

lead空yield收到下一events batch，处理建议但不重复accept writer/checker；第二次close succeeded。全部资源释放、无未决incident；没有handover实际在线操作。审计阶段重新读journal仍只有21次review，没有关闭后的新review记录。

## 5. 定时review、allowlist与输出计数

### 5.1 真正的周期review

21次快照elapsed从180005ms到3780217ms；相邻间隔180005–180033ms，符合3分钟周期。实际结果为12 ON TRACK、9 AT RISK，无OFF TRACK；每条verdict与prefix一致，review内容有明确snapshot与非直接读取限制。

首次review的request和pause_member两次探针回执为`A review only advises`；无业务变更，之后20次review不再request/control。普通DRAFT_REVIEW属于业务work，可以正常request自己的child，不能把其行为算成巡检越权。

每份review有独立journal `review`与关联`result`、并给lead一条REVIEW_READY，没有ROOT_RESULT_READY或accept_result。全部selected final refs都是普通结果。review不计业务works/roots/results，但activation、模型/工具、member结果、总ledger和预算包含它。

**前缀不是强制约束：**当前Runtime解析ON TRACK/AT RISK/OFF TRACK，没有证实它拒绝无前缀summary；已有回归明确存无verdict记录。本次21条遵守提示，不能说验证了强制schema。

### 5.2 工具装载

父核每个原session的system toolsAdded/toolsRemoved与实际toolCall：lead和relay/verifier/rpc/writer/gate只有team；source/scheduler/reviewer最多read+team。没有bash/write/edit/subagent。模型策略、thinking与Fast均符合prepare，9成员各单一session，无model drift。

allowlist限制是有效工具集合，不是文件系统沙箱。Scheduler仍可通过read试错，因此不能把“只有read”说成不能读任意路径；本轮没有凭据/外网/仓库写入调用。

### 5.3 新Process对得上的口径

| 最终Process项 | 原始记录复算 |
| --- | ---: |
| works / roots / sub-tasks | 109 / 27 / 82（review21排除） |
| results | 117（review结果21排除） |
| activations / model turns | 245 / 525（包含review） |
| dependency waits / questions | 40 / 22；questions包括子任务owner提问，不等于向lead提问22次 |
| revisions | 10；其中owner控制的child修订与lead控制root都计入 |
| cancelled/superseded | 1个当前普通child cancelled；旧superseded版本不是当前work |
| tool errors | 7个Runtime Team action错误，**不是全部原生工具错误** |

成员results之和138、Status全部work130与预算work130都正确；不应因此报告Process少了review。Last review行实际为`63:00 on track: The supplied snapshot...`，没有再次显示ON TRACK前缀。status保留头30+标记+尾69=100行，省略587，头部启动/初始任务和终态保留；本轮约686 milestone，没有在线触及1000保留上限。

## 6. 亲自复核发现的残余问题

### 6.1 最终稿读取清单漏项（确定）

父journal `result:waz4`（`63c293d4`，行661），writer当前 `work:jaf4@2`：清单20项，但本revision提交前实际成功读取21个不同结果。漏的 `result:6h5e`在writer session行322请求、行336成功返回；最终行375提交。

这份旧TEXT的业务verdict不是PASS，但读取操作本身成功，不能因此从full_read_ids集合删除。checker tk44说可见工具材料无法确认writer读过旧TEXT，这个限定本身合理；父现在用原生记录确认确实读过。**最终清单完整性未满足**，不能因accepted/PASS忽略。

53份普通结果非空读取清单共268项全部有效，没有虚报未读；实际这些集合合计269项，52/53份精确一致，唯一遗漏在waz4。此前py36的“relay直读gate”错误在waz4已经修正，不把旧稿问题重复算作终稿残留。

### 6.2 一处header格式遗漏（确定）

普通DOC_CHECK `result:pc7p/work:pkq8@1`（父journal行501）开头为`DOC_CHECK CURRENT=... AUTHOR=...`，漏规定`LABEL=`。CURRENT和作者匹配，无错投；普通117结果身份匹配全部通过，LABEL格式116/117通过。review21条按verdict前缀另算，不能用普通header误报巡检。

### 6.3 原生错误实际25次，审计不能只数7次

父逐个核对全部toolResult.isError：

| 层 | 次数 | 原因 |
| --- | ---: | --- |
| Runtime Team action | 7 | 当前work自控/非lead pause/非owner cancel各1，review request/control各1，cycle1，close pending event1 |
| 本地Team schema | 3 | Scheduler把evidence/artifacts写在reply顶层而非result内；在进入Runtime业务前拒绝，随后重发正确格式 |
| read | 15 | Scheduler错文件路径13次ENOENT、目录read2次EISDIR；后来读到正确源码，无状态损坏 |
| **原生总计** | **25** | 18次前置/基础工具错误不在Process的7中 |

本地拒绝具体见scheduler原session行449（`b1f7321f`）、515（`e859616a`）、595（`a7e879b9`）；read失败见行23–175。错误全部恢复，不等于新ownership/review机制失效；但`tool errors 7 (all recovered)`若被解释为全工具错误，会漏掉事实。建议显示为`Team action errors`或提供分层计数。

两项独立审计主要范围为结果/ownership/review，未完整统计这些原生前置和read失败。父原始复核发现后没有照抄“只有7个工具错误”的结论。

### 6.4 时序与计划差异

OWNER12确实有8项issue+1省略，owner通过status查遗漏而非等下一批；FANOUT40在首批等待前已预派33–35。它们不造成漏项/重复，也已在结果披露。lead阅读和决策活跃约39:30，占墙钟约60%，snapshot中的“Lead to close”在尚有计划阶段未派时只能描述当前账本，不代表整个目标已完成；巡检几次AT RISK准确提示了这个区分。

## 7. 隔离宿主/Progress补充验证

父在独立审计后亲自运行`/tmp/rail-owner1002-host-probe.mts`，使用真实Runtime/journal/history/overlay、内存fake lifetimes/resources；无在线provider或真实host会话变更：

1. **9 child issue容量：** parent保持running，9children均attention；首次输入8+omitted1，resume8后再yield，第二次输入仅剩1。全部issue精确送达一次并解决，不靠status提前消除末项。
2. **健康lead移交：** pending ROOT_RESULT_READY/USER_COMMAND转给新lead，events activation中再次handover拒绝；结束后移回，两条handover写journal，历史lead正确。
3. **故障lead移交：**模拟hostStopMember使queued lead work hold=lead_unavailable，其他工作停驻；handover后incident解决，stranded work failed/MEMBER_UNAVAILABLE，父收到失败outcome。没有假称在线provider崩溃。
4. **巡检控制及结束：** setReview改1分钟、reviewNow强制一次、无业务变化tick跳过；review权限probe拒绝。close成功时另一个active review自动cancelled，native模拟aborted清理后全成员closed；nextAt=null、取消review没有record，已提交review恢复history。
5. **真实journal的Progress历史渲染：**本轮173条事实恢复为closed history，21review及3分钟schedule正确；页列63:00/on track，Enter详情显示review/work/snapshot/budget；c/r/g/m历史操作全部不执行。还恢复了较早旧manager/workers形态journal，映射lead正常。

这些补充验证已完成，纠正了终稿提交当时“独立容量harness未执行”的时间状态；终稿在它提交时未声称已执行是诚实的。没有操作真正live handover、review菜单或做人工iTerm2目视。Progress仍属于自动化/内存渲染验收。

## 8. 证据与完成边界

父层审计脚本实际检查245次固定trigger/custom input/input_ready/provider顺序、每次成功end独占批次及tool_result确认；138个原reply与journal深比较一致；280次全文查询返回payload与不可变结果一致。Work可观察区间峰值4（lead普通work也计），同成员events/work无重叠。没有provider error/abort或原生compaction；非预期read/schema错误如上披露。

正文work/result/incident/event短token1043次，无未知；owner未收到的incident从真实status结构补全权威集合，没有把未送达当未知或直接相信模型文字。关闭关联一致、所有资源released，无关闭后新review、无本轮遗留Team子进程。单次无故障运行不构成一般无死锁/无竞态/无越权证明。

本轮未在线覆盖：host移交/故障、budget耗尽/grant/unlimited、关闭时实际在途review取消（本次21review均已完成）、网络断连和未知outcome处置、运行中外部工具强制中断、compaction、1000事件溢出、TUI目视、跨父进程恢复、Fast网络优先或性能对照。

本机产物：

- `/tmp/rail-owner1002-audit.mjs`、`.json`：9个原session、过程口径、errors、读取集合、tool声明、childIssues/owner/review映射。
- `/tmp/rail-owner1002-host-probe.mts`、`.json`：隔离宿主移交/9issue/关闭review/Progress历史验证。
- 全量日志：`/var/folders/zw/gcpf3t91243dhn6z3bb278s00000gn/T/rail-owner1002-check.uqKyyU/check.log`。
- 父journal：`~/.pi/agent/sessions/--Users-zzq-Develops-pi-rail-ui-team-dev--/2026-09-30T23-26-36-420Z_01a0f4a4-3184-75d9-987b-e0daf446fa70.jsonl`；本Team launched行496、terminal行668；9成员路径在audit JSON的members中。只作为封存日志审计，没有恢复/续跑成员会话。

临时审计脚本最初有局部变量遮蔽process、错误文本非JSON及错误计数层次的实现问题；都在取得实际输出后修正，保留schema/read原始失败，不通过削弱产品断言制造通过。计数最后严格按Runtime业务入口/原生前置错误的实际边界验证。

**交付评价：新ownership、同型lead、allowlist与定期review在本轮路径成立；业务成功收尾，宿主补充验证通过。最终稿仍漏一条实际读取、叶子有一处header格式遗漏，原生错误总数必须分层披露，不能把succeeded或1116绿测试解释成所有模型交付都完美。**
