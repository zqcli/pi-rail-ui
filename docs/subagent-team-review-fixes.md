# Team 审查问题修复

日期：2026-09-25。运行时基线：Pi 0.87.1。

本文记录对 `feat/subagent-team-coordination` 的代码审查所发现问题的修复。协议边界（运行时绑定身份、消息视为不可信数据、ACK 只表示已应用、安全点协作式暂停）保持不变。[协作契约加固](subagent-team-hardening.md) 中与本文冲突的描述以本文为准。

## 活性

| 问题 | 修复 |
| --- | --- |
| 所有成员互相等待时没人能推进，只能挂到默认 1 小时的截止时间。例如 A 暂停 B1 后 `finish`，或双方互相按发送者过滤等待。 | 有 worker 手动暂停时，A 的 `finish` 和 `wait(workers)` 直接报错并提示 resume/cancel。Hub 在 `pump()` 末尾检测“所有未结束成员都停在无法满足的门控上、且没人持有执行许可”，宽限 2 秒后向 A 当前的 wait 投递一次 `team_stalled` 错误，不受发送者过滤限制。如果此后 A 在没有任何推进的情况下再次进入等待，team 以该原因失败。宿主侧屏障（A 提前结束后的 `waitForWorkers`）遇到卡住时，会给 A 一轮协作续跑，而不是最终总结续跑。 |
| 没有 worker 配合时，coordinator 无法走到屏障。 | 新增 `control cancel`（`message` 可选，作为原因）。它只以 `cancelled` 结束该 worker：Hub 立即写入终态，并中止该成员独立的 abort signal；宿主停止其原生运行，team 本身不取消。 |
| 收件人结束时，已入队的消息被静默丢弃。 | 收件人结束时，发送方和 A 会收到 `undelivered` 事件（`from: "@hub"`，`member` 为结束的成员），列出未读消息的 ID。 |

“推进”只统计能解除阻塞的变化：消息、控制、worker 候选结果、worker 获得许可或被唤醒、成员结束。A 自己重新进入等待不算推进。

## 容错

| 问题 | 修复 |
| --- | --- |
| A 拿到全员屏障后再调用一次工具，就会被标为失败、停掉进程并让整个 team 失败。 | 屏障后的 `send`/`report`/`control`/其他 wait 返回带路由的普通工具错误。重复的 `finish` 或 `wait(workers)` 交给 Hub，按同一批终态结果再回复一次。 |
| worker 生成最终回答期间收到 redirect，结束时会被判为失败。 | worker 结束时如果还有未读到的指令，返回一次续跑 prompt，新指令通过原生 context gate 进入上下文。 |
| 失败的 team 永久占用成员别名。 | dispatch 通道新增 `started()`，表示成员是否通过过 team 门控。失败时尚未通过门控的成员（模型从未行动）会删除实例、roster 链接和 session 文件，别名可以复用。已启动的成员保留 session 以便排查，父结果中提示为它们换用新别名。 |

## 上下文与存储成本

| 问题 | 修复 | 实测（审查时 → 修复后） |
| --- | --- | --- |
| wait/control 回复每次都带完整 team 状态（所有输出、结果、分配、brief 和事件）。 | wait/control 回复只带精简的当前状态：状态、指令版本号、结果状态和 512 字节预览、错误预览。完整结果只在两种情况下给出：成员 wait 给被等待的成员，屏障给全部 worker。 | 8 个 worker 场景：A 的单次 wait 从 21→106 KB 降到 3.3→7.4 KB，pause 回复从 112 KB 降到 4.5 KB；A 累计约 623 KB 降到约 141 KB（约 15.5 万 → 3.5 万 token）。 |
| 原生压缩后，会把已被总结掉的消息补回上下文。 | 只修复原生投影本应保留（`firstKeptEntryId` 之后）但缺失的消息，外加一份精简 roster（brief 与分配）。已被总结的历史交给原生压缩摘要。 | 14 条压缩前的消息从补回 893 KB 降到 0。 |
| 父会话每次状态变化都追加一份完整快照。 | journal 只在里程碑写入：成员加入、入队、成员结束、阶段变化，事件只保留最近 16 条。实时 UI 仍由 `subscribe` 接收每一次变化。 | 一次 1 个 coordinator 加 8 个 worker 的运行，从 70 条 / 4.16 MB 降到 13 条 / 464 KB。 |
| 每次 reload 都重新写入所有历史快照；超过 32 条或任意一条损坏时整体抛错，可能导致 subagent 不可用。 | 只有“未结束 → interrupted”的变化会重新写入。逐条校验，跳过无效条目，只保留能装下的最新历史。创建新 team 时淘汰最旧的已结束 team，只有 32 个活动 team 时才拒绝。`session_tree` 先建好新 hub 再释放旧的；`session_start` 失败时关闭已创建的 broker。 | reload 时重复写入从每次 1 条降到 0 条；1 条损坏条目不再导致 0 条被恢复。 |

候选结果（`finish` 的 message/result）不再单独写 journal，而是随成员终态一起持久化。team 本身不支持重启后恢复执行，所以这不影响恢复能力。

## 其他

- `PiRpcProcessTransport.stop()` 在 SIGKILL 后最多再等 5 秒，超时抛出 `RpcProcessExitTimeoutError`，其 `exited` promise 在进程最终退出时完成。`LeasedSessionWorker` 会一直持有 session 租约直到进程真正退出，避免另一个 worker 打开旧进程可能仍在写入的 session。
- broker 转发规范化后的 `contextWindow`，直接调用时传 `null` 与工具调用行为一致。
- 成员状态、阶段、事件类型、控制命令、回复码、消息 ID 格式，以及人数、输出、错误上限，统一由 `team-protocol.ts` 导出，Hub、子进程回复投影和父工具共用。父工具 brief schema 的长度上限与共享校验器对齐（原先是 2048/4096 字符，校验器允许 8 KiB），总大小交由 `isTeamBrief` 判定，含 JSON 转义开销。

## 未在本轮完成

- **一次调用启动 team**（在 `subagent_team` 中一次传入 coordinator、workers 和 brief，由宿主内部并行派发）。这能消除“两个配对调用”的误用，但属于公共接口变更，还涉及 grouped 面板渲染和结果合并，需要单独设计与验收。现有的配对派发和 30 秒入队截止时间保持不变。
- **用一套 typebox schema 统一工具参数、传输解析和历史恢复**。本轮只统一了枚举和上限常量；三处结构校验仍是各自手写。

## 验证

- 每个问题都有对应的回归测试，覆盖 Hub、runner、工具层、broker、子扩展、传输层和 worker factory。其中，原生 RPC 压缩测试的预期已改为“压缩后不再补回已总结的消息，只补精简 roster”。
- 隔离 HOME/`PI_CODING_AGENT_DIR`、离线、清除代理变量后运行全量测试：`tsc --noEmit` 通过；全部 `tests/**/*.test.ts` 在 `PI_SUBAGENT_DEPTH=0` 与 `PI_SUBAGENT_DEPTH=1` 下均 **923/923 通过**，没有失败、取消或跳过；`git diff --check` 通过。
- 真实子进程测试使用本地合成 provider 和 loopback WSS，不代表外部模型的协作决策质量，也没有进行交互式 TUI 实测。
