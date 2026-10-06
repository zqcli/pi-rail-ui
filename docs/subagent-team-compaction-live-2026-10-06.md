# Team 压缩更新长程实测与独立审计（2026-10-06）

## 1. 结论

**`eb9bd38` 的新压缩完成/失败反馈在本轮实测成立：5 次成功压缩、1 次预期小会话失败；压缩后继续同 WorkRef、保留 checkpoint/childIssues/brief 和依赖，未发现所核路径上的 Runtime 压缩状态损坏。**

但 **Team 的 `succeeded` 不等于全场景与最终报告全部通过**：父层确认 writer/checker 最终清单混入旧 revision 读取，巡检误报不存在的漏项导致额外修订；A/B 的 rev1 还被提前验收，违反只接受 current3 的测试计划。这些如实保留，不把 checker 的 PASS 当成独立证明。

按用户“检查完就结束”，本轮完成原始记录复核与报告后结束，不再启动新 Team、追加故障/删除实验或擅自修代码。

## 2. 新版本与配置

被测 HEAD：`eb9bd386fee082fca5a50b69dbc74eb3cbc44e4a`，相对 `10e4c50`：

- roster 新增非负整数 `contextTokens`，lead 可先判断约40k以下不值得普通压缩；这是建议，不是 Runtime 硬门槛。
- lead-triggered 压缩成功和失败都发 `COMPACTION`，分别给 before→after 或失败原因；receipt started/scheduled 仅受理，不代表完成。
- COMPACTION 属 advisory，提示“无需回复”，未处理通知不会阻止 close。
- 其他更新还有 panel 折叠/筛选/历史展示与未运行成员删除；本轮重点验证压缩，不冒称这些UI或真实删除均已实测。

| 项目 | 实际值 |
| --- | --- |
| Team ID / 标题 | `5c54m52a` / `Oct 6 compaction continuation and event audit` |
| 全部9成员 | **`cus-resp/gpt-6-luna:max`**，无其他成员模型 |
| Fast | lead off、其余8成员on，沿用既定策略 |
| 工具 | lead/纯协议成员只team；source/scheduler/reviewer为read/grep/find/ls+team |
| 预算/窗口 | default long、原生372000、无额外缩窗、无总deadline；未改全局compact threshold |
| UTC开始/结束 | `2026-10-06T01:07:27.855Z` → `02:05:15.826Z` |
| Runtime/面板时长 | 3467971ms（57:47.971）；launch含启动显示 **57:49** |
| 普通业务 | **113 works：29 roots、84子任务；121结果** |
| 定时review | 14 works/results：13 on_track、1 at_risk；账本127works、135results |
| Activation / 模型轮次 | **222 / 539**，events36、work186 |
| 工具/等待 | 897个原生tool call、880个Runtime business请求、34依赖yield、15attention |
| 修订/取消 | 10次修订；2个当前普通child cancelled |
| 最终 | `closed/succeeded`，29current roots accepted，全部9资源released，无未决incident |

运行前隔离 `npm run check`：新临时HOME/agent、env -i、PI_OFFLINE=1、PI_TELEMETRY=0、npm offline、loopback NO_PROXY。实际typecheck通过，**1287/1287 tests passed**，exit0，fail/cancelled/skipped/todo均0，测试阶段93479.023114ms。之后未改源码，未重复全量检查。

## 3. 压缩请求与真实完成逐项匹配

6次lead compact_member中：4 started、2 scheduled，全部找到后续 COMPACTION。成功5项有真实native `type=compaction` entry；小writer负向夹具没有entry。

| 目标 / native entry行 | 压缩前原生tokensBefore | 事件ID / rounded报告 | 事件batch roster的压后估算 |
| --- | ---: | --- | ---: |
| source P1边界 / 1085 `f5f8e79e` | 60142 | `event:av87`，60k→30k | 29504 |
| source handoff / 1486 `11a255d4` | 84197 | `event:wj49`，84k→30k | 29722 |
| reviewer / 701 `39af0605` | 137681 | `event:598c`，138k→31k | 31381 |
| lead自身 / 925 `7e45e428` | 85594 | `event:fm72`，86k→30k | 30237 |
| writer草稿后 / 241 `4dc81e32` | 59694 | `event:ac32`，60k→25k | 24778 |
| role-only writer小会话夹具 | contextTokens=0 | `event:cbg7`，failed/session too small | 不生成压后值 |

Source handoff和lead自身的receipt是scheduled，真正完成须等对应entry/event；其余started也不是完成证明。负向probe是计划测试例外，没有把小writer失败算作普通业务root失败，也没有反复无收益压缩。

**计量边界：** `rpc-worker.ts:454-457` 在compact后取get_messages并estimateTokens求和作为tokensAfter。表中右列是估算，不是provider精确post-context；事件60k等是rounded显示。native entry的summary usage是摘要调用费用，不是省下的token。五条entry各有自己的usage并被折叠；所有terminal memberStats的input/output/cache/turns相加恰等于Team usage，不能把contextTokens相加或把activeMs并发相加当Team墙钟。

## 4. 压缩后的真实续作

### 4.1 Source阶段边界

WARM48 root `work:ch27@1`创建48个leaf，四队列各12；实际先派32并等待，后派16并等待，outcomes依次32与16，全部结果full-read。业务计划的“48全部派完再等”没有严格执行，但无重复或缺项，参数与结果保留。

Source行1080回复WARM48；1085写compaction；1086–1088进入新DATA `work:xqd3@1`。这证明压缩后承接新任务、不重做旧leaf；**不是同WorkRef恢复的证据**。

### 4.2 Source同WorkRef handoff

- source行1422开始 `work:rw3n@1`；full-read四输入后，1470只创建一次RPC child `work:4pps@1`。
- 行1480 yield，保存输入refs、child receipt和value76/nonce；1486压缩。
- 行1489仍是**同 `rw3n@1`**，Runtime输入带原checkpoint及childIssues：`4pps@1/incident:5uww`，不是新child。
- owner恢复原child，1515收到其resolved outcome；之后才1533创建gate确认 `work:r74n@1`，1551收到gate结果，最后完成原root。

父核原生request receipts：RPC4pps一次、gate r74n一次，无重派。事件本身不含WorkRef；关联依赖上面原生scope和时序，不单凭done文本推断。

### 4.3 Lead、reviewer与writer

五个成功compaction checkpoint均有非空 `systemMessage.sections.team_brief`；后续activation继续指向该section，未在activation重新塞完整brief。lead自身压缩后 events batch 收到 fm72/598c；同会话继续派发报告、验收和关闭。

Writer草稿后压缩、同root rev2执行真实直属source→rpc→verifier→gate→lead→source独立callback，深度6；两个终审是writer rev2直属child。gate祖先cycle被拒后回程value19成立。最终writer改到rev3时保留原链parent=writer@2的说明，CURRENT为@3，未伪称重建了链。

## 5. 其他运行证据与恢复

- DATA/source同root三版7/11/19；A/B当前3消费19。16个CASE真实不同root值20..35。
- OWNER9由owner恢复；OWNER_CANCEL中间scheduler及gate孙项cancelled，直接gate sibling及独立rpc根保留。
- RPC两次原生 `WebSocket closed 1006`：行222的WARM48 `work:9dv9@1`、行361的bridge `work:qx6r@1`。两者在同WorkRef/revision的新activation自动续作，结果各提交一次；桥接只新建一个callback，不重复业务root。不能由1006推断HTTP/provider根因。
- 14个review仅1个at_risk触发REVIEW_READY；13个ON TRACK只存记录。6个COMPACTION分别送到lead，没有被当交付物accept或最终result。
- 终态Usage input2432996、output270457、cacheRead26172928、turns539；cost0是配置返回值，不代表服务免费。Fast只核策略和模型，无priority网络/性能对照证明。

## 6. 最终审计仍不通过的内容

### 6.1 当前revision读取清单混入旧revision

本Team系统brief规定：full_read_ids只列**本WorkRef、本revision、提交前成功status(result)**。父按原生call/result匹配得到：

| 结果 / reader | 当前rev实际不同ID | 声明ID | 问题 |
| --- | ---: | ---: | --- |
| `result:6bbx` / writer9jm7@1 | 26 | 26 | 一致 |
| `result:2946` / writer9jm7@2 | 24 | 38 | 多14个CASE02–15旧rev1读取 |
| `result:n7b5` / writer9jm7@3 | 25 | 39 | 同样多14个旧rev1读取 |
| `result:xu9z` / checker d456@3 | 23 | 24 | 多`result:8uxp`，只在旧checker revision读取 |

这些ID都存在，也确实曾读过，**不是never-read或未知引用**。但不能把压缩摘要/旧manifest或重读聚合报告，等同于本revision直接重读底层14个结果。

Lead的rev2/3 task主动要求“合并历史revision成功read”，与静态team_brief本rev限制冲突；成员提示规则本应在冲突时attention，而不是自行放宽。因此归因为lead验收契约偏离及模型provenance判断，不据此断言压缩把ledger改坏。

父全量扫描121份普通结果的CURRENT/作者均与scope匹配；68份显式读取清单中3份不一致（上面的writer@2/@3及checker@3），无schema或基础read失败。135个提交payload与模型reply比较时，忽略codec合法省略的空可选数组后内容一致，没有宿主篡改。

另有普通结果 `result:erh7`写`incident:incident:d4ww`重复前缀；ID存在性检查识别合法尾部，不代表整个表达合法。这是非终稿格式瑕疵，不能包装成未知incident或状态破坏。

### 6.2 巡检误报漏项导致额外修订

`result:uy9x`（父journal行1193）断言 writer@2 `result:2946`漏`result:8pgv`。**原manifest实际上已经含8pgv**；checker@2 `result:2xah`（行1197）也准确指出这一事实。

Lead仍将这个假前提传入writer@3和checker@3修订任务，甚至否定checker@2的正确观察。旧ID没有缺失，追加修订没有修掉真实的跨revision清单问题，最后PASS依然接受了错误范围。故不能把“唯一纠正成功”当成provenance通过证明。

### 6.3 消费者中间版本提前accepted

父核真实accept_result回执：

- Consumer B `work:nqg8@1`：lead请求行229，回执233，accepted。
- Consumer A `work:3prz@1`：请求255，回执259，accepted。

之后DATA/A/B当前3也都accepted，终态root正确。但A/B@1的提前验收违反“只accept current3”的测试约束；不能用后来的current3抵销这项流程偏差。DATA自身只查到current3接受，没有把A/B错误扩大到DATA。

这些是lead/model决策失误，不是Runtime伪造回执。Runtime当时允许验收那个current1，之后仍允许修订；业务测试的预先约定更严格。

## 7. 核查范围与结束

独立两项审计后，父亲自重新解析9个成员原session、全部135个结果、**本轮385次成功全文查询**、6个压缩receipt/事件、5个native checkpoint、2个重试、handoff及接受控制。Process的113业务works/121业务results与账本127works/135results区别是14reviews；全部计数在已检查项自洽。29currentroots accepted、close关联正确、无未决incident、所有资源released，检查时无本轮Team遗留子进程。

在线压缩机制覆盖通过，但**整个长程契约与交付内容不是全部通过**。没有TUI目视、hostpause/delete、阈值自动overflow/length、删除归属安全、一般无死锁/无竞态或可靠率证明；按用户要求不再补新harness/长轮。

关联背景仅保留：此前`10e4c50`短轮onl2f456因模型误读Loop证据提前partial；长轮kowx2u32实际partial且存在拓扑/验收/报告缺陷。它们不是本轮eb9bd38的成功结果，不因版本更新而重写或淡化。

本机证据：

- `/tmp/rail-compact1006-audit.mjs`、`.json`：父层原始记录复核。比较rawreply时仅规范化codec会移除的空可选数组，未删去实质差异。
- 全量日志：`/var/folders/zw/gcpf3t91243dhn6z3bb278s00000gn/T/rail-compact1006-check.9whcvf/check.log`。
- 父session：`~/.pi/agent/sessions/--Users-zzq-Develops-pi-rail-ui-team-dev--/2026-09-30T23-26-36-420Z_01a0f4a4-3184-75d9-987b-e0daf446fa70.jsonl`；成员原文件由`cp1006-*`实例定位（JSON输出members）。作为日志读取，不恢复/续跑。

只新增本报告；未修改功能代码、全局设置或删除任何用户会话，原未跟踪`pi-rail-ui-team-actor-development-spec.md`保留。
