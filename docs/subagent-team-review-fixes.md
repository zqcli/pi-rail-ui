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

## 追加：启动失败清理与 Team 派发可用性

- **启动失败路径释放租约（高风险）**：`createRpcWorkerFactory` 在子进程已启动但连接失败时，原先吞掉 `transport.stop()` 的错误并无条件释放租约。若进程在 SIGKILL 后仍未退出，新 worker 可以拿到同一个 session。现在启动失败路径与 `LeasedSessionWorker.stop` 共用 `stopThenRelease`：遇到 `RpcProcessExitTimeoutError` 时，租约保留到进程真正退出；对外仍报告原始启动错误。open 与 new 两种模式都有回归测试，旧代码在这两个测试上均失败。
- **Team 派发需要多次重试**：分析父会话 `2026-09-25T04-35-49…jsonl`，gpt-6-sol 会把每个字段都填上值。`control`、`session` 这类对象没有 null 选项，模型就编造了 `{"message":"start"}` 和 `{"path":"/nonexistent"}` 这样的占位值。于是每次调用都同时带 task 与 control，被判定为“两种模式”；错误只写着 “Provide exactly one mode”，没有指出是哪个字段。该会话三次组队，前后约 50 次调用被拒，直到模型自己试出空字符串才成功。修复如下：
  - `session` 与 `control` 接受 `null`，描述写明“不用时 null，不要填占位值”。
  - 模式错误写明本次调用设置了哪些字段，例如 `single (task) + control (control.message="start")`。Team 字段错误逐项列出违规字段及路径。未知 teamId 会单独提示。缺侧或形状不对时，列出本条消息中实际找到的调用。
  - `subagent_team prepare` 的返回，以及所有 Team 派发错误，都附带填好真实 teamId 与 alias 的两条调用模板；只有一个 worker 时也使用 `tasks` 数组。
  - `subagent`/`subagent_team` 的描述与 guideline 明确：Team 的 worker 属于“优先用独立 sibling 调用”这条通用建议的例外，并且不存在单独的 `parallel` 字段。
  - 用该会话中记录的真实参数写了回归测试：旧参数得到可操作的错误，同一 provider 改用 `null` 后即可成功组队。后续真实运行结果见下文“追加二”。

## 追加二：prepare 带完整计划，launch 只带 teamId

原来的启动方式需要父模型在同一条消息中写出两个配对的 `subagent` 调用，每个都带着完整的扁平 schema。会把每个字段都填上值的模型，会在这里反复出错。现在改为两步：

- `subagent_team prepare` 中，每个成员写成 `{alias, task, model?, fastMode?, cwd?}`。宿主解析模型，校验 Fast 可用性、cwd 以及 alias 是否可用（新增 `SessionBroker.assertAliasesAvailable`），然后列出计划，但不启动任何成员。解析后的 model 和 cwd 会固定写入计划。计划只保存在内存中；team 进入终态或被淘汰时，计划随之失效。
- `subagent_team launch {teamId}` 由宿主让 coordinator 和全部 worker 入队，复用原有的派发、实时面板和清理路径。协调者完成后返回，协调者失败即视为调用失败。其他字段为非空值时会被拒绝，避免"以为改了计划，实际没生效"。
- 带计划的 team 会拒绝配对的 `subagent` 调用。`coordinator`/`workers` 写成 alias 字符串时仍走旧流程，以保持兼容。

**真实运行验证**。每次都新启一个 Pi 会话，只加载本 worktree 的扩展，父模型为 `cus-resp/gpt-6-sol:xhigh`，worker 为 `cus-resp/gpt-6-luna:max` 并开启 Fast，prompt 与此前失败的会话相同。

| 运行 | 父会话 `subagent_team` 调用 | 成员 | 覆盖的协作 | 结果 |
| --- | --- | --- | --- | --- |
| 1 | prepare、launch、status，共 3 次，0 错误 | 1 + 2 | report 并等待、pause 到 `paused`、暂停中 redirect、resume、双向消息、`undelivered`、成员等待、finish 屏障 | COMPLETED，约 11.5 分钟 |
| 2 | prepare、launch，共 2 次，0 错误 | 1 + 3 | report 并等待、pause/resume、`team_stalled` 提示后恢复、`wait(workers)` 屏障 | COMPLETED，约 13 分钟 |

两次运行中，父会话的派发调用都没有被拒绝过；此前失败的会话在派发阶段被拒绝约 50 次。成员内部共出现 3 次 `team` 工具错误，都由模型自行纠正：一次 finish 参数错误；一次 `team_stalled`，是活性检测按设计触发；一次向已结束成员 send。

两次运行的 team 审查还发现了本分支自身的问题，均已修复并补充回归测试：

- launch 会静默忽略非空的计划字段。
- 预检展示的结果与 launch 时重新解析的结果可能不一致。
- 已结束 team 的计划会滞留在内存中。
- 停止超过 SIGKILL 宽限后，清理与 delete 仍会删除活进程可能在写的 session 文件；清理与正在进行的 stop 并发时，也存在同样的时间窗口。

## 未在本轮完成

- **用一套 typebox schema 统一工具参数、传输解析和历史恢复**。本轮只统一了枚举和上限常量；三处结构校验仍是各自手写。

## 验证

- 每个问题都有对应的回归测试，覆盖 Hub、runner、工具层、broker、子扩展、传输层和 worker factory。其中，原生 RPC 压缩测试的预期已改为“压缩后不再补回已总结的消息，只补精简 roster”。
- 隔离 HOME/`PI_CODING_AGENT_DIR`、离线、清除代理变量后运行全量测试：`tsc --noEmit` 通过；全部 `tests/**/*.test.ts` 在 `PI_SUBAGENT_DEPTH=0` 与 `PI_SUBAGENT_DEPTH=1` 下均 **934/934 通过**（含全部追加修复），没有失败、取消或跳过；`git diff --check` 通过。
- 真实子进程测试使用本地合成 provider 和 loopback WSS，不代表外部模型的协作决策质量，也没有进行交互式 TUI 实测。
