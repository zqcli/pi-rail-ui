# Team 自动投递上下文丢失：修复与验收

## 已确认的问题

用户 2026-09-19 13:52 UTC 的测试已成功发送两个 READY，A 依次执行 pause 和 redirect，却没有执行 resume，而是再次 wait(message)。最终 A、B2 等消息，B1 保持 paused；父调用随后中止。

原实现的 receiving checkpoint 会消费 Hub inbox，却只通过 `context` handler 临时追加 user message。Pi 0.85.1 的 context transform 不写回会话历史，因此通知可以在一次请求中出现、下一次请求中消失。原生 probe 已复现此机制；它与本次日志顺序吻合，但日志本身不足以还原当时完整 provider 输入或断言模型内部的唯一原因。

此前 handshake 合成 provider 的跨轮 `observedEvents` Map、`latestSnapshot` 和 step 变量给了它真实模型并不拥有的额外记忆，不能证明上下文足够。这部分测试已纠正。

## 实现边界

- 自动投递改为原生 `rail-team-delivery` custom message，`display:false`、`triggerTurn:false`；当前请求同时补入相同消息，原生 writer 在工具结果之后的 turn_end/finally 写入。
- 不使用 `deliverAs:nextTurn`：该队列等待下一个外部 prompt，不是当前 run 的工具 continuation。
- Pi 0.85.1 的 in-run context 数组可能滞后于 native state，因此每轮按 delivery ID 从 native branch 补入缺失数据，不能只在 compaction 后处理。
- 当前生命周期的专用 delivery 总窗口最多 64 条／1 MiB，包含精简 roster；当前投递优先，保留 native 顺序并去重。已有 visible 数据也必须有当前 origin 之后的 native 来源。普通消息及未绑定 dispatch 不受此恢复流程影响。
- 公共消息仅包含 teamId、memberId、deliveryId 及公开数据。绑定 epoch 只用于私有生命周期校验，不进入模型消息。相同绑定可跨 native send 恢复事实；新 epoch、其他 team 或缺少匹配生命周期证据时，不恢复旧事实。
- control 成功回复带操作后的公开权威 snapshot：pause_requested 不伪装为 paused，redirect 不解除 manual pause，resume 不绕过未满足的依赖。
- 不增加自动 resume、全员等待即取消或模型轮询；不承诺 SIGKILL、父进程重启后恢复旧 Promise。

## 自动验证

- 原生 RPC：当前请求可见、两次无关工具 continuation 仍可见，无额外 provider 轮次、无重复持久化，custom message 不插入 toolCall/result 对中间。
- 正常 abort：已消费消息由原生 finally 在 tool result 后落盘。
- 真实 native compaction、unbind/rebind、extension 重载来源校验、新 epoch 未压缩旧消息、跨 team 隔离、损坏历史及混合 visible/missing 的容量边界。
- 完整三进程 handshake 的策略现在每次仅依据实际 provider 输入和成功工具调用历史决定，不使用外部事件缓存或 handshake step。redirect 与 resume 之间加入两次无关工具调用，并核对实际日志顺序。

## 真实在线测试

使用已配置的 `cus-resp/gpt-5.6-luna:max`，由新 Pi 进程加载当前 worktree，父层仅启用 subagent_team/subagent；成员执行只读验收。

- Team：`58d393fb-9416-4b72-9ea8-76f3b698c844`
- 成员：`memory-live-7f3c9a-A`、`memory-live-7f3c9a-B1`、`memory-live-7f3c9a-B2`
- 最终 status：三个成员均 completed，Team completed。
- 已核对子会话：READY×2 → pause → redirect → A 只读 package.json 前 10 行 → resume → B1_RESUMED → B1 等 B2 → B2_RELEASE → B2 原生完成 → B1 确认终态 → A 总结。
- 三个子会话工具错误均为 0；原生自动投递记录数量分别为 3、1、1。
- 父模型起初有 7 次无效调度（5 次未配对、2 次错误 teamId），被已有预检拒绝，之后纠正并完成。不能将整轮称为“零错误”或保证模型不会再误填参数。
- 在线流程完成后，又加固了审查发现的 visible 旧生命周期隔离及统一容量边界；这些最终加固由原生自动测试验证，未据此声称重跑了第二轮在线验收。

本机证据：`/tmp/rail-team-memory-live.jsonl`、`/tmp/rail-team-memory-live.stderr`。三个子会话位于当前 worktree 对应的 Pi session 目录，文件时间前缀为 `2026-09-19T14-51-16`。未改已有会话、凭据或全局配置；该验收正常创建了三个新的 persistent child sessions。
