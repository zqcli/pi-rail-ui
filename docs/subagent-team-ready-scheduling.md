# Team ready 队列调度：依赖感知的许可分配（2026-10-12）

## 1. 背景与样本

样本会话：`~/.pi/agent/sessions/--Users-zzq-Develops-naiveproxy--/2026-10-10T13-20-41-452Z_01a125f9-…jsonl` 中的 Team `v4xnrdvq`（VPS 采集，1 lead + 8 成员，`long` 预算，`workPermits` 4）。墙钟 612 分钟，其中 14:29–20:53（UTC）约 385 分钟是宿主手动暂停（上游限流），以下统计全部排除该段，只看 11:45–14:29 与 20:53–21:57 两段，共约 228 分钟。数据取自主会话 journal 和 9 个成员原生会话的协议帧（activation 起止、request/revise/resume 回执、yield）。

## 2. 观察到的现象

- 并发 work activation 每 30 秒采样 442 次：等于或超过 4 的占 73%（4 个许可基本一直占满），0–1 个的占 15%。
- 66 次 work 启动（request/revise/resume 之后的首个 activation）累计排队 1208 分钟，**其中 681 分钟（56%）被指派的成员本身是空闲的**——它不是在等自己的上一个任务，而是在等全局 work 许可。
- 被卡住最久的恰恰是解除别人等待的短任务：
  - `work:ksn8@1`（pipeline 请求 lead 发布契约，6 个 provider 子任务都等它）：排队 45.6 分钟，lead 空闲 37.4 分钟；
  - `work:vg4a@1` / `work:mn54@1`（core 等 lead 的决定）：排队 33.6 / 26.6 分钟，lead 空闲 24.2 / 18.3 分钟，实际执行只有 15–30 秒；
  - `work:kh5u@1`（pipeline 的共享修复）：排队 30.6 分钟，pipeline 整段空闲（12:35 起它的 root 在等 6 个子任务）。
- lead 自己的 work 还会被连续的 events 批次推迟：例如 13:26–13:36 lead 连续处理 5 批事件，`vg4a` 的依赖 13:26 已满足，直到 13:37 才继续。

## 3. 原因

“等待中的任务挡住后面任务”在单个成员内部并不成立：`yield {waitingFor}` 会结束 activation、释放成员和许可，该 work 变为 blocked 并移出 ready 列表，成员后面的 work 可以立即运行（样本中 `vty_global` 13:36:06 `96yx@1` yield 后 1 秒就开始了 `6jnm@1`）。面板上成员显示 `waiting on …` 而不显示仍在排队的 work，容易让人误以为整条队列在等。

真正的瓶颈在全局层面：

1. **许可按 FIFO 分配。** ready 是一个全 Team 共享的 FIFO；许可空出时给最早入队、成员空闲的 work，与它是否能解除别人的等待无关。新派发的长任务和“别人都在等的”短任务同等排队。
2. **lead 的 work 也占 work 许可。** lead 是单个串行 actor，events activation 本来就不占许可，而 lead 的 work（多为协调决策）却要和 8 个成员的长任务抢 4 个许可。
3. **lead 空闲时总是先处理事件。** 结果事件持续到来时，lead 的 work 一直被推后。
4. 依赖满足后重新入队的 work 排在队尾，排在新任务后面，在制品（WIP）越积越多。

## 4. 机制设计（已实现）

调度入口仍是 `TeamRuntime.reserveNextActivation` 的单一 effect drain，不引入新的并发模型或协议字段。

**A. lead 不占 work 许可。** lead 的 events 与 work activation 共用 workPermits 之外的 1 个串行槽位（`needsWorkPermit`）。并发上限仍是 `workPermits + 1`，与原来 events 槽位一致；暂停后恢复（`resumeParkedActivations`）同样不为 lead 申请许可。宿主 handover 时，前任 lead 正在跑的 work 不补许可，跑完为止（最多多出 1 个），若被暂停停驻则恢复时按普通成员申请许可。

**B. ready 按类别竞争许可（`readyOrder`），类别内保持入队先后：**

| 类别 | 条件 | 目的 |
| --- | --- | --- |
| 0 | 被某个未被 hold 的 blocked work 的 `waitingFor` 点名 | 先完成能解除他人等待的 work |
| 1 | 有 checkpoint 或已观察 outcome 的继续执行；revision > 1；新 work 排队满 10 分钟（`READY_AGING_MS`） | 先收尾在制品；老化防饿死 |
| 2 | 其余新 work | 先来先服务 |

blocked 与 held 的 work 本就不在 ready 中，所以排序只影响“谁先拿到空出来的成员和许可”，不改变依赖、预算、hold、暂停等任何准入规则。

**C. lead 的 work 与事件交替。** lead 空闲时，若上一次是 events activation、存在可运行（未被预算 hold）的 lead work、且待处理事件中没有 `MEMBER_FAULTED`/`BUDGET_HIT`/`USER_COMMAND`，先运行该 work，再处理事件；故障、预算和宿主消息仍然优先。

**C′. 顺序。** 每次调度先执行 `holdUnknownDependencies` 并清理失效 ready 项，再判断 lead 的 work 回合，因此不会出现“跳过事件但 lead work 随即被 hold、本轮什么都没启动”。

**D. 面板。** 成员有 waiting/held 的 work 同时还有排队 work 时，状态行追加 `N queued`，例如 `waiting on 1 sub-task: w2 (running work …) · 1 queued`。

**附带修复。** `applyHoldRelease`（`resume_work`/宿主 release）在依赖未满足时把 work 留在 blocked，但没有考虑未送达的 child issue，与 `wakeWaiters` 的规则不一致，会违反不变式 I13。新的调度顺序让随机轨迹测试（X10 seed 74）走到了这条路径，现在与 `wakeWaiters` 一致：有未送达 child issue 时 work 进入 queued。

## 5. 以 v4xnrdvq 推算的效果（未实测）

- A 直接消除 lead work 的许可等待：`ksn8@1`、`vg4a@1`、`mn54@1`、`64ut@2` 在 lead 空闲时即可开始（合计约 80 分钟空等）。
- B 让 `kh5u@1`、`s4hp@1` 这类被 root 等待的修复任务优先拿到下一个许可，而不是排在新派发的 provider 任务之后。
- 不能消除的部分：4 个许可对 8 个成员本身就是上限，成员仍会排队；这一部分只能靠宿主提高 `workPermits` 或减少成员数，属于资源与上游限流的权衡，本次没有修改默认值。

## 6. 验证

- 新增 `tests/subagent/team-runtime-ready-order.test.ts`：等待中的 work 不挡同成员后续 work；空出的许可先给被等待的 work，面板显示排队数；新 work 老化 10 分钟后不再被后来的继续执行超过；lead work 与 advisory 事件交替，宿主消息和成员故障优先。
- 调整的既有用例（原先固化了 FIFO 或“lead work 占许可”的断言）：`team-runtime.test.ts` 的 lead 请求与 workPermits 两例、C07/C08/C10 的恢复顺序；`team-budget.test.ts` G05/G08 的取出顺序；`team-runtime-properties.test.ts` D08 改为子任务在父任务 yield 前全部完成，保持原有断言含义。
- 独立审查（Claude Sonnet 5.5）后补充：held 的 waiter 不再赋予类别 0；`flowStats` 不再把 lead 的排队 work 归因为 `slots full`；轻量提前返回（ready 少于 2 项时不扫描 ledger）。
- `npm run check` 全部通过（1380 项）。

## 7. 后续：减轻 lead 负载

同一会话中 lead 处理事件 53 轮、约 83 分钟，其中 21 轮只含建议性事件（16 轮只有 `COMPACTION`），约 22.5 分钟；lead 还亲自做了大量核验（169 次 `read`、90 次 `bash`）。据此做了三项调整：

- **压缩完成报告不单独唤醒 lead。** lead 请求的压缩成功后，`COMPACTION` 事件标为被动（`passive`）：不单独开启 events activation、不计入待处理事件数，随下一批事件送达；压缩失败仍立即唤醒。`REVIEW_READY`（AT RISK/OFF TRACK 巡检）与 `TEAM_QUIESCENT` 需要 lead 决定，仍照常唤醒。
- **核验交给 verifier。** `subagent_team` 指引建议需要独立核验时配置 verifier 成员，并在 lead 的 roleDescription 中写明依据 verifier 的证据验收；Team brief 规则要求 lead 不重复核验 verifier 已检查的内容，只亲自查看决定结论的部分。
- **用子协调者分层。** 指引建议较大的 Team 给成员配置领域协调者角色，用已有的子任务机制拆分、回答子任务提问并汇总回复，只有 root、故障和 Team 级决定才回到 lead；brief 规则同步告诉协调者这样做。

后两项只改模型可见的提示词（`prompts/team.md`），不改变 Runtime 行为。
