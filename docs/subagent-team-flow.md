# Team Flow 指标口径

## 为什么调整

旧 `start delay` 是 work 创建到首次 reserve 的墙钟，`wait` 是依赖 yield 收尾到 consumer 下次 reserve 的墙钟，`accept` 是 root commit 到 accept/waive 的墙钟。它们会把宿主长暂停算成延迟，且把依赖已完成后的重新排队全部记到某个成员名下。旧归因还通过可变的 `updatedAt` 猜最后完成者，后续验收就可能改变排名。

现有调度、预算、hold、协议和历史恢复方式均不变。本次只修正计时与展示，不以指标控制 Team 行为。

## 当前定义

| 指标 | 起止与口径 |
| --- | --- |
| `ready first` | 每个非 review WorkRef 版本第一次 reserve 前，在 ready 队列中的累计时间。prepare 尚未 launch 的时间、宿主暂停、该成员的明确/安全暂停、work hold 不计。hold 前已等的 ready 时间不会丢失。 |
| `ready resume` | 同一版本后续 activation 的 ready 队列时间，用同一口径。依赖完成、hold 解除、retry 后重新排队都属此类；parked 原 activation 原地恢复不是一次新 activation，不另造样本。 |
| `oldest` | 当前排队项中累计 ready 时间的最大值，不再用最后一次更新的墙钟时间。括号只描述该项**当前**原因，不声称整段都在等这个原因。 |
| `deps` | 一次已提交的 dependency yield，到最后一个依赖 outcome terminal 且 native cleanup 已确认的 Team active elapsed。到这里立即结样，不等 consumer 真正重启。之后的排队属于 `ready resume`。 |
| `last` / `last dependency` | 上述正常完成等待中，最后变为可交付的依赖所属成员。累计时长是 consumer 的依赖等待，不是该成员的执行耗时或个人责任。一个批次同时完成、无法唯一确定最后成员时保留等待样本但不猜归因。 |
| `accept active` | 已提交的当前 root result 到 `accept_result`（accepted 或 waived）的 Team active elapsed。不是 lead 实际审阅耗时，也不表示 lead 全程在处理这个结果。 |
| `host paused` | 单独列出宿主暂停累计墙钟；当前暂停继续累计，Team 结束后冻结。上述延迟和 Team active 分母都排除这一段。 |

这里 **ready 不等于“现在能调用 provider”**：同成员已有任务、work permit 不足、retry backoff、compaction、调度尚未处理都可能让 ready work 等待。它们仍算 ready 时间，没有尝试伪造更细的历史原因分摊。当前原因优先显示 `host paused` / `member paused` / `retry backoff` / `compacting` / `member busy`，之后才是 `slots full` 或 `starting`。

`deps` 只排除宿主暂停，不减去依赖自身排队、成员暂停或 hold 的时间，因为 consumer 在这些时间确实仍缺少依赖。不要把 `last` 误读成“此成员造成了整个等待”。child issue 提前唤醒 consumer、outcome unknown 需要显式处置，或 consumer 被取消/修订时，不生成一个虚假的正常完成等待样本；这类未完成/中断等待不进入百分位。

Flow 的 `workers avg`、lead busy / only lead 和 slots busy 沿用 activation/许可占用口径，不是模型计算利用率。已 parked 的 activation 不再计作 Flow busy，恢复时只加回一次。单个成员/任务详情计时仍是 activation lifetime（排除宿主暂停，但包含该成员 park），不额外改动既有统计与历史结构；因此改标 `elapsed`（activation elapsed），成员占比改标 `occupied`，不再把它叫作 busy。

## 展示与边界

- Progress 保留现有两行摘要和按需警告，不加仪表盘；有宿主暂停时摘要显示累计暂停。Queue 警告同时检查 first/resume 的 p90；阈值仍只影响展示。
- Timeline 的首次启动注明 `ready`，不再把含暂停的墙钟叫作 queued time。巡检提示说明 elapsed 与归因边界；Flow 的警告本身不是风险证据。
- first/resume/deps/accept 各保留最近 1000 个**完成样本**，无样本显示 `—`；这不是所有未完成任务的预测。依赖排名是 Team 累计正常完成等待，不受样本数组轮换影响。最近 worker average 仍读取最近十个墙钟分钟桶中的 active 时间。
- terminal journal 仍只保存一条可选摘要字符串，旧记录原样读取，不倒推或重写历史指标。

## 只读等待诊断

宿主 `status`、成员面板和 Tasks 详情共用 Runtime 派生的 exact-WorkRef 事实，不从成员名或最新 work summary 猜依赖。Tasks 详情保留已完成/替代但尚未交付的版本，标明 `outcome ready; awaiting delivery` 和当前版本号；不会把等待 `@1` 自动解释成等待 `@2`。AND 等待中某一项已完成、或 consumer 已排队但尚未 `input_ready`，都是正常投递过程，不报陈旧等待。

- terminal 不等于可交付：`cleanup pending` 仍阻止依赖交付；`outcome unknown` 在清理确认后仍需明确决定。诊断本身不会解除 hold。
- child issue 的 incident 仍 open 时显示由谁决定，即使该 issue 已经交付、从 parent 的待交付列表移除。正常唤醒 parent 处理问题不叫循环等待。
- 排队依赖会指出成员正在执行的精确 WorkRef、处理 Team events、暂停、重试退避或 compaction；这是当前原因，不是整个等待时长的归因。
- 已有 `DEPENDENCY_CYCLE` 校验继续阻止真实 WorkRef 环（含 staged wait 和 owned-child completion edges），拒绝尝试只在现有有界 Timeline 留一条说明。成员 A→B→A 的不同 WorkRef 链合法，不按成员建图报死锁。

这部分不新增持久状态、协议字段、定时器或调度动作，不自动取消、改派或恢复 work。`tests/subagent/team-wait-diagnostics.test.ts` 覆盖精确旧版本、清理与未知结果、未观察的已完成结果、已交付 child issue、忙碌成员原因和合法/非法循环；既有 Tasks 窄屏与大 Team 性能回归继续适用。

## 实现规模与验证

只增加一份 pending-ready `{since, ms}` Map、每成员两个暂停时钟数值和一个有界 resume 样本数组。复用现有 enqueue/dequeue、pause、wakeWaiters 边界与 Team active clock，没有新增持久事件、协议字段、采样器或历史追踪系统。pending-ready 项在启动或终止时清除，hold 时仅保留累计值；依赖只在现有唤醒路径检查。

`tests/subagent/team-flow.test.ts` 用注入时钟覆盖正常分段、准备时间、长/进行中的暂停、成员暂停、budget hold/grant、暂停期间 commit、验收修改 updatedAt、child issue、outcome unknown、取消后 cleanup、park/resume 以及暂停后终止。另回归 Runtime、预算、随机状态轨迹、ready 排序、Progress 渲染、巡检与最终历史文本。测试是纯 Runtime / 本地 mock，不代表在线模型行为或长时真实负载。
