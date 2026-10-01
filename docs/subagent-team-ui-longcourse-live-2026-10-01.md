# Team 新 UI / Process / Timeline 七阶段长程测试（2026-10-01）

## 1. 结论

**在线流程正常收敛，新 Process、Deliverables、status 时间线与原始记录一致；但界面仍有两处可复现的交互/归属问题，不能称为全部功能无缺陷。**

- Team 实际 `closed/partial`，23 个当前 root 中 22 accepted、1 waived；`partial` 是事先设置的 EXCLUDED_FIXTURE，不是 provider 或 Runtime 故障。全部 9 个成员资源释放，没有未解决 incident。
- 90 个 work、94 份结果、156 次 activation、396 模型轮次、28 次依赖等待、5 次提问、8 次修订、0 次字面取消、8 次工具错误，全部与新 Process 输出相符。
- 36-child 依赖实际分成 32+4 两次 outcome 交付；8 页 limit=7 的查询按精确 parent 得到完整 36 项。没有因预览裁剪丢失义务。
- 94 份提交结果的 CURRENT/author 与真实 scope 匹配；37 份含非空读取清单的结果共声明 177 项全文读取，均有相同作者、WorkRef/revision、提交前的成功调用。未重现上一轮的错任务 payload 和跨 work 读取清单虚报。
- 独立审计后，父层亲自解析全部记录并运行隔离内存渲染探针，确认两处 UI 问题：**新任务与旧结果正文归属不清**、**Prepared 弹窗显示当前不可用的 r/g/m 操作**。见 §5。
- **父测试计划错误更正：** P3 要求 revise 后旧子项为 literal `cancelled`，但源码契约是 `superseded`，实际行为正确。这个错误由我设计场景时引入，不应报告为运行回归，也不应让后续报告继续把它列为系统未达标项。

本轮只测试、审计和新增报告，不修改业务代码，不篡改已提交结果。自动化验证不冒充真实终端目视验收。

## 2. 代码变化与验证基线

被测 HEAD：`eedc101e601d60c8ab67a7a8c76f10ba3133141a`。相对上一轮 `d10d00f` 的主要更新：

| 变更 | 机制 | 本轮验证层 |
| --- | --- | --- |
| `ec2ab6f` | current-work notice 标明精确 WorkRef；Manager event kinds 去重；Runtime timeline 1000 条，保留头30+新970 | 在线输入逐项匹配；status 头尾及去重；1000上限靠现有自动化 |
| `ee043ca` / `afdfbe7` | `/rail-team` popup：Overview、Members、Tasks、Timeline，折叠、详情、快捷操作和历史只读 | 源码、既有渲染测试、父内存探针；未人工打开真实弹窗 |
| `b07f801` | 结果去向固定在任务下；最终文本分 Deliverables/Process/Members/完整结果，timeline 改走 status | 实际 launch/status 文本与终态成员面板数据；中途状态用内存探针 |
| `eedc101` | 修订中结果行显示 in progress；结果数写作 results | 在线计数和隔离渲染的 revision 断言 |

测试前执行隔离离线 `npm run check`：新的 HOME/agent、`env -i`、PI_OFFLINE=1、PI_TELEMETRY=0、npm offline、loopback NO_PROXY，不继承 provider 凭据。实际 exit=0，typecheck 通过，**1026/1026 tests passed**，fail/cancelled/skipped/todo 均0，测试阶段 `76192.4 ms`。随后未改源码，不无理由重复全量检查。

## 3. 在线配置、规模与场景

| 项 | 实际值 |
| --- | --- |
| Team | `b7cd6861-5d09-425c-9353-c43b87a9e609` |
| Manager | `ui1001-lead`，`cus-resp/gpt-6.1-sol:xhigh`，**Fast off** |
| Workers | 8 个 `ui1001-*`，全部 `cus-resp/gpt-6-luna:max`，**Fast on** |
| ContextWindow | 原生默认372000；未额外缩窗；无Team deadline |
| 时间（UTC） | `08:36:04.593Z` → `09:23:13.904Z`；Runtime约47:09.312，launch面板含启动耗时显示 **47:10** |
| 工作/版本 | 90 work ID：23 roots、67 child；8次修订，共98个版本 |
| 结果 | 94个显式reply结果；当前87 resolved、3 superseded；其中EXCLUDED结果为partial |
| Activation / 模型轮次 | 156（Manager29、Worker127）/ 396 |
| 工具 | 517（team504、read/bash13）；8个错误全部有实际回执 |
| 依赖/提问 | 28次成功dependency yield、5次attention yield |
| 全文读取 | 191次成功status(result)，清单内177项逐一核对 |
| 关闭 | 22根accepted、1根waived；所有成员closed/released、无未解决incident |

94份结果不等于90项work：98个版本中，REBUILD旧父版本和旧3children共4个版本被superseded且没有结果，剩余94个版本提交结果；不可变旧版本结果保留。

相比前轮69work/147activation/71:58，本轮为90work/156activation/47:10。任务更多而用时较短，但输入设计、审核深度不同，不能据此推断模型或Runtime性能提升。Manager原生activation累计约26:32；usage input=2010191、output=111367、cacheRead=27067264，配置cost=0不代表服务免费。Fast只验证策略和模型记录，没有网络priority或对照提速证明。

### P1：当前任务提示、同会话返程与新增代码审阅

四个 initial roots 分别为 source `8use`、relay `u675`、verifier `3wyp`、scheduler `rs27`。先向第8 Worker gate请求BOOT叶子并让出许可；随后完成源码审阅、rpc→relay CALLBACK返程和三种授权错误探针。

127个worker activation的 notice 均以精确 `Current work: <scope.work@revision>.` 开头，成员/任务没有错投。模型提交的CURRENT和author全量匹配；FINAL_RPC确实新建并等待FINAL_VERIFY，没有重用早先DATA/CASE结果。

发生一次模型偏差：scheduler把BOOT_SCHED请求了两次（`work:ds6a`、`work:bfv4`），两份结果均完成、观察并保留。四个initial roots没有被Manager重派，这两种情况不能混为一谈。

### P2：36-child、32+4 outcome和分页

唯一source根 `work:up8q` 创建36children，gate/rpc/reviewer/relay各9个。实际：

- 初始activation无outcome；第一次恢复 `d364de9f`（source行450）有32个outcome、omittedOutcomes=4；第二次 `d09e7e15`（行466）有4个、omitted=0。
- 成功yield的waitingFor长度分别32和4，没有超过协议上限或重复等待已观察集合。
- 两次恢复ownedChildren预览均只有8项、omitted=28，模型没有把它当完整清单。
- 查询8页，**每页请求limit=7**，cursor依次page:7/14/21/28/35/42/49，最后1项、hasMore=false。全队当时50项，精确parent WorkRef匹配36项。
- source全文读取全部36结果后提交 `result:9j2f`；peer verifier根 `work:6k3w` 先attention取producer WorkRef，再跨根等待，只全文核聚合并抽查01/18/36，终稿准确限定抽查范围。

聚合文字没有明确写limit=7，最终checker因此保留“不由报告独立证实”的限制。父层从source行474–548的实际参数确认了该值，不能把报告缺少这个参数等同于分页没按计划执行。

### P3：修订旧子树、in-progress窗口与同成员独立任务

source `work:s44t@1` 创建gate/rpc/relay三个LEGACY_HOLD（`k356/e6cg/g6hw`），全部held后Manager：

1. 对gate提前close一次，收到CLOSE_BLOCKED。
2. revise父root同ID到rev2，旧父和三个child按实际契约变为superseded，原hold incidents解决。
3. 用旧expectedRevision=1再试一次，收到STALE_REVISION。
4. rev2先attention形成修订中窗口，再由Manager精准resume，新建三个LEAF并完成。

独立rpc root `work:6gpk/result:zxd4` 正常成功，无误伤。没有调用cancel_work，因此 Process cancelled=0；status的cancelled/superseded=3只数当前三个superseded child，而旧父superseded版本不是当前版本。

**方案纠错：** `team-runtime.ts:2114-2119` 明确以 `cancelDescendants(...,"superseded")` 修订子树，`2791-2808` 原样应用该状态。方法名有cancel不代表状态必须cancelled。brief和随后的Worker报告/Manager reason把literal cancelled未满足写作偏差，是本测试错误预期的传播，不是新实现问题。本报告以源码和真实语义为准纠正，不更改原日志。

### P4：三版数据与共享成员多种任务

| 稳定work | rev1：11 | rev2：22 | rev3：33 |
| --- | --- | --- | --- |
| source `k982` | `result:jf72` | `result:q8pr` | `result:mv8z` |
| consumer A / relay `fnp6` | `result:pwj8` | `result:3br4` | `result:6umb` |
| consumer B / scheduler `5zmb` | `result:72qw` | `result:32ae` | `result:t6m2` |

每个版本都有ATTEST/PROOF子任务，A rev2还经过rpc→同relay CALLBACK。全部数据明示synthetic，只验收三个current rev3，旧结果和旧child保留。同成员在LEAF、BRIDGE、PROOF、消费者之间长期切换，没有发现回复header的当前work错配。

### P5：八个独立CASE根，推动Deliverables超过20

CASE01..08分配给rpc/gate/reviewer/relay再重复一轮。均全文读合成DATA_V3=33，分别计算34、32、66、3、99、40、30、44；所有当前label/WorkRef/nonce与各任务对应，没有用同成员前一个CASE结果冒充下一个。

### P6：草稿返工、五层深链和双审

writer到P6前零activation，pause/resume各一次。唯一writer根 `work:na9n`：rev1读13个阶段输入，reviewer独立DRAFT_REVIEW读草稿与这些输入，Manager再修订同writer为rev2。

```text
writer na9n@2
  → source 97dm@1
    → rpc 2m6b@1
      → verifier 4d5h@1
        → relay 3r8x@1
          → gate 6rx5@1
```

上图表示连续parent→child，深度最大5。各层只传DATA_V3与DRAFT_REVIEW两个关键refs，而非反复传全队历史。gate唯一一次等待祖先source被DEPENDENCY_CYCLE拒绝，随后正常reply，逐层恢复/fullread返回。

writer再并行请求reviewer FINAL_TEXT_CHECK和scheduler FINAL_MATRIX_CHECK，AND等待两份全文反馈后提交 `result:rct9`；verifier最终验收为 `result:f6rh`。本轮没有出现需要额外修订的RPC错任务。

残余文字问题：终稿说“未直接读取的五个后代结果”，实际已读FINAL_SOURCE，其下尚未直读的是4个。最终验收准确指出该处，但没有改写已提交终稿。草稿还漏写自身nonce=draft-v1；终稿正确给当前final-v2，旧遗漏明确保留。它们是结果表达问题，不是协议/调度失败。

### P7：计划partial/waive与关闭

EXCLUDED_FIXTURE `work:94ey/result:h53m` 按计划reply partial，模拟可选证明缺失，没有真实外部调用。Manager按EXPECTED_FIXTURE_ONLY waived；其余22根accepted。

Manager关闭无义务rpc，收到MEMBER_CLOSED后成功读取其较早CASE01 `result:w9x2`；唯一closed request返回RECIPIENT_CLOSED。然后故意尝试close succeeded，被INVALID_TEAM_OUTCOME拒绝，blocker指向计划waived根；最后close partial正常完成。

此处partial是测试fixture的必要结果。不能与最早23-work那轮因真实报告错误而partial混淆，也不能因为这个标签就说长程执行失败。

## 4. 新输出与时间线的实测核对

父会话launch工具结果 `d76bd675`、status工具结果 `39eeb832`：

- Deliverables头为23 roots /22 accepted /1 waived；恰列20行，附`+3 more roots`，省略项仍在账本与selected全文中存在。
- Process全部计数与原native sessions重算一致，包括results=94而非works=90，以及cancelled=0与superseded子项的区别。
- 各成员结果数合计94、activation数合计156，与 Process一致。
- 计划夹具结果全文标题为`partial · waived · result:h53m`，Writer为`succeeded · accepted · result:rct9`，不会用Worker状态覆盖Manager verdict。
- launch不再带Timeline。status有恰100行时间线：头30条、1条marker、尾69条；marker为344 omitted。头部保留launch及4初始任务，尾部到Team closed。
- 344渲染省略+99真实行=443个时间线事实；结合1000上限行为，本轮没有触及Runtime淘汰。头30+tail970的上限淘汰由自动化回归覆盖，不能宣称在线跑到了1000事件。

终态serialized面板的8条worker结果去向都正确。例如source→writer/result:25wz；rpc→source/result:et6f；writer→lead/accepted/result:rct9；gate→lead/waived/result:h53m。Manager无任务/去向行。

父journal不保存每次live onUpdate，中途修订显示不能直接由terminal数据证明；用下面的独立内存探针核验。

## 5. 确定的界面问题与自动化验证边界

### 5.1 中等：不同新任务下仍显示旧任务正文，无来源标记

代码 `tools/subagents/team-tool.ts:215-240` 分别选择当前task与成员latest result。已有测试只断言新任务不借用旧resultRef，未检查旧正文归属。

父层隔离探针使用真实TeamRuntime和真实tool面板构造、fake broker/lifetime，依次完成A@1、修订A@2、再给同成员派不同work B。得到：

```text
同work修订：
  task = TASK_A_REV2
  destination = ↳ result → lead · in progress · @1 result superseded
  output = BODY_OF_TASK_A_REV1

不同work接续：
  task = TASK_B_DIFFERENT
  destination = ↳ result → lead · in progress
  output = BODY_OF_TASK_A_REV2
```

前者符合修订提示，后者缺少A的WorkRef/来源标记。`Latest output`虽然不是“B已提交”声明，但任务、去向和正文并列时，用户无法从通用正文确定它属于哪一项。实际结果没有错投、去向行也没有借错ref；这是信息归属歧义。建议给旧结果正文附实际WorkRef/来源，而不是改变其真实归属或静默当作当前结果。

### 5.2 低：Prepared popup显示不可用操作

`team-overlay.ts` 将prepared/active/closing都视为writable，footer均显示c/r/g/m；但`team-command.ts:132-144`仅允许active执行message/resume/grant。

父层实际实例化Prepared overlay，render后按r/g/m，组件均返回对应action，执行命令分别收到：

```text
prepared; held work cannot be resumed
prepared; budget cannot be granted
prepared; a Manager message requires an active Team
```

命令层正确拒绝，无越权写入或状态破坏；问题是popup向用户展示当前不可用入口。Prepared路径已内存复现，Closing路径仅源码同一判定分析，没有伪称在线按键实测。建议按生命周期禁用/隐藏这些操作。

### 5.3 已通过的自动化UI检查

- 修订中的destination确为`in progress · @1 result superseded`，没有误写awaiting review。
- 用本轮真实36child关系构造Tasks行：折叠2行（root+group），展开38行（root+group+36），统计四成员各9，全部子项仍在父下。
- 既有popup测试覆盖四页、键盘、折叠、窄终端、dispose、history read-only；全量1026通过。独立helper另跑相关96项，后审helper跑8项聚焦检查均通过。

这都是源码/自动化/内存渲染层，不是iTerm2人工目视，也不代表真实live popup的中途屏幕已被录制。

## 6. 父层独立审计与限制

父层在两项独立审计返回后重新解析9个native sessions：

- 全部156次activation的固定trigger、持久化custom input、input_ready与provider gate顺序匹配；同成员无可观察区间重叠，Worker峰值4。
- 每次成功reply/yield/close独占assistant工具批次；没有同activation结束后的业务请求；tool_gate有tool_result确认。
- 94个reply与父journal WorkResult深比较完全一致；191次全文查询返回的author/work/content与不可变记录一致。
- 632次正文短ID token引用没有未知；CURRENT/author 94/94匹配。读取清单在同WorkRef/revision内逐项核验，没有跨工作复用；177项全部成立。
- 28次成功依赖yield中REBUILD rev1因被superseded不会恢复，这是预期，不是lost wakeup；其余按精确ref交付。36项分批与分页直接核实际输入/回执。
- 8个错误各一次：SELF_REQUEST、FORBIDDEN_ACTION、UNKNOWN_RESULT、CLOSE_BLOCKED、STALE_REVISION、DEPENDENCY_CYCLE、RECIPIENT_CLOSED、INVALID_TEAM_OUTCOME。没有额外provider error/abort/compaction或工具schema错误。
- close decision/terminal关联匹配；全部资源released；运行后未见本轮残留Team子进程。

计数过程与业务语义必须分开：自动计数全对，不代表报告每句都正确；例如终稿后代数仍写错。反过来，父方案literal cancelled写错也不能把Runtime正确superseded行为说成失败。

未覆盖：真实TUI目视与host交互快捷键、原生compaction、budget耗尽/grant、断网/进程崩溃、未知outcome处置、外部工具执行中强制中断、1000事件Runtime上限在线溢出、一般死锁/竞态证明、多次重复负载。默认上下文较大，本轮没有压缩。current-work提示在本场景下表现正确，但这一次成功不能证明以后不会串任务。

## 7. 交付与证据

本次只新增本报告，保留原有未跟踪文件`pi-rail-ui-team-actor-development-spec.md`，未改功能代码。预备UI探针首次作为/tmp下`.ts`被tsx按CJS处理，遇到ESM包exports加载错误；改为`.mts`后隔离运行成功。这是临时harness加载方式修正，不是产品失败，也未更改任何依赖。

本机审计产物（不提交Git）：

- `/tmp/rail-ui1001-audit.mjs`，输出`/tmp/rail-ui1001-audit.json`：原生记录、计数、full-read、分页、notice、timeline、terminal面板核验。
- `/tmp/rail-ui1001-render-probe.mts`，输出同名`.json`：隔离内存Prepared快捷键、revision/新work结果归属和36child折叠复现。
- 离线全量日志：`/var/folders/zw/gcpf3t91243dhn6z3bb278s00000gn/T/rail-ui1001-check.0sSCPf/check.log`。
- 父journal：`~/.pi/agent/sessions/--Users-zzq-Develops-pi-rail-ui-team-dev--/2026-09-30T23-26-36-420Z_01a0f4a4-3184-75d9-987b-e0daf446fa70.jsonl`；成员路径在audit JSON的members中，按`ui1001-*`实例定位，未恢复或重开这些会话。

**最终评价：新过程汇总、结果去向、按需时间线和current-work提示在本轮覆盖内有效；计划partial正常关闭。保留两项已复现的UI改进项、一处终稿数量措辞问题及重复叶子/草稿nonce遗漏；同时明确撤回父测试方案对P3 cancelled的错误预期。**
