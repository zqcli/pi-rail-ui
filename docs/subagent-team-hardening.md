# Team 协作契约加固

日期：2026-09-24。运行时基线：Pi 0.87.1。

本文描述当前分支的实现，不把历史在线会话或旧版测试结果当成本次验证。原架构及限制见 [Team 初始契约](subagent-team-plan.md)，原生运行时整合见 [Pi 0.87.1 Team 报告](subagent-team-pi-0.87.1.md)。

## 改动目标

针对实际协作中出现的自发自收、manager 不知道 worker 的任务/授权、消息入队被误解为立即停止、空结果完成以及重复总结，补齐公开消息契约和上下文边界。

不改变普通 stateless/persistent/parallel/chain/control 生命周期，不增加递归 subagent、远程消息服务、自动生产授权或跨进程重启恢复。共享 brief 是协作上下文，不是权限沙箱。

## 组队、共享任务与身份

`subagent_team.prepare` 可附带：

```json
{
  "action": "prepare",
  "coordinator": "lead",
  "workers": ["review", "test"],
  "brief": {
    "goal": "验证实现及回归行为",
    "target": "当前仓库",
    "acceptanceCriteria": ["给出文件位置和验证结果"],
    "constraints": ["不访问生产系统"],
    "authorizations": [
      {"member": "lead", "allowed": ["协调和汇总"], "forbidden": ["修改代码"]},
      {"member": "review", "allowed": ["读取实现"]},
      {"member": "test", "allowed": ["执行离线测试"]}
    ]
  }
}
```

- prepare 生成 teamId；传入非空 teamId 会被拒绝，不再静默忽略。之后仍需用返回的 id 在同一 assistant message 中派发 coordinator single + 全员 grouped 两个 sibling calls。
- 每个成员仍必须有独立、完整的 task。两侧 join 原子保存其成员 assignments，所有成员完成 admission 后才释放初次 context gate。
- 首次公开上下文包含共享 brief 和全员 task、cwd、已解析 model、有效 Fast/Search。压缩恢复的精简 roster 也保留这些信息，但不重复复制历史输出及结果。
- brief 的 constraints 适用于全队；authorizations 按成员标明范围。coordinator 自己不得执行测试，不代表另一个已获得测试任务的 worker 也不得执行。
- hosting parent、coordinator 和 worker 是不同角色。父模型等待外层调用期间不能因 Team 消息而即时回答问题；需要父层决定时应保留已完成结果并返回 blocked/partial，而不是给自己发消息后等待。
- self-send 和 coordinator 向自己 report 被明确拒绝。发送者不能通过工具参数伪造。
- Fast 默认仍为 off；必须在每个新成员参数中显式设置 `fastMode:true`。Search 仍由已有 GPT/provider 策略决定，assignment 中的 searchMode 是只读的有效状态，不是新的输入参数。

## 公开事件和回执

新事件采用公开事件版本 2，私有 binding/ACK 传输仍使用既有协议版本 1。父子应加载同一版本的 Rail；旧持久化事件可以读取，但不凭空补造发送者或时间。

```json
{
  "version": 2,
  "messageId": "team-id:23",
  "timestamp": 1790212228081,
  "seq": 23,
  "kind": "report",
  "from": "review",
  "to": "lead",
  "message": "发现一处错误处理问题"
}
```

`messageId` 由 teamId 和队内递增 seq 构成；timestamp 来自运行时。成员消息、报告和控制事件的 from 来自真实绑定，to 来自通过校验的路由。状态、结果及取消事件的作者为 `@hub`；`member` 表示被描述的成员，不能把系统状态通知误当作 worker 自己发言。coordinator 的终态结果路由到 `@parent`，不提供额外的实时父模型通道。

发送回执：

```json
{
  "ok": true,
  "from": "@hub",
  "to": "review",
  "requestId": "request-id",
  "receipt": {
    "status": "queued",
    "messageId": "team-id:23",
    "recipient": "lead",
    "seq": 23
  }
}
```

- queued 仅表示消息已进入收件箱，不代表模型已读、理解或执行。
- control 的 applied 表示 Hub 已应用控制状态；pause_requested 不冒充 paused。
- requestId 对应当前请求。错误回复也保留运行时路由；epoch/binding 不进入公开结果。
- send/report 可使用 replyTo 指向当前仍可核查的队内消息，supersedes 只能指向同一发送者的旧消息。引用已淘汰或不存在的消息会报错，而不是猜测。
- 证据可放入结构化结果的 evidence，携带 source、可选 locator 和 basis（observed/verified/inferred/unverified）。不要只传另一个会话无法核对的临时检索编号。

`wait` 的成员终态与消息发送者过滤分开：

```json
{"action":"wait","wait":{"kind":"member","member":"test"}}
```

```json
{"action":"wait","wait":{"kind":"message","from":"review"}}
```

后者匹配 review 的 send/report，保留其他发送者的消息；afterSeq 仅确认该过滤流中的消息。无 from 时仍消费整个收件箱。wait、report-with-wait、finish 仍须独占 tool batch，避免释放许可时其他工具仍在执行。

## 控制、方向版本与执行边界

普通 send 不会撤销正在生成的工具调用。改变 worker 方向应使用 control；需要先暂停时，观察权威 snapshot 中的 pause_requested/paused 状态，再 redirect，并在应继续时显式 resume。

- redirect 增加成员 instructionRevision，清除旧方向的 deliverable candidate。
- 最新尚未进入 context 的方向保存在有界独立槽中，不会被普通消息拥堵、afterSeq、发送者过滤或历史事件淘汰丢弃。连续未消费的 redirect 合并为最新方向，历史 journal 仍记录控制事实。
- receive checkpoint 为该方向预留空间；只有方向实际出现在返回的 context 数据中，才更新 observedRevision 并返回对应 revision。
- 子扩展记录 context revision，普通 tool preflight 携带它。旧 revision 得到 stale_instruction，生成的工具被非致命阻止，下一轮通过原生 loop 重新读取方向并规划。不得在 resume 后直接执行旧参数。
- 未观察最新方向的成员不能发布成功终态。取消和 native failure 仍可正常结束。
- observedRevision 只是运行时的上下文交付证据，不是模型理解或任务完成的证明；没有自动声称 acknowledged。
- 已经过许可门、已经开始的工具/外部操作不可回滚。pause 不是 OS 挂起，也不是事务边界；provider 请求和正在运行的工具可以结束。

## 完成结果与最终总结

worker 的 `finish` 可保存候选结果：

```json
{
  "action": "finish",
  "result": {
    "status": "partial",
    "summary": "已完成离线分析，未执行在线验收",
    "findings": ["错误路径缺少覆盖"],
    "evidence": [{"source": "src/service.ts", "locator": "handleFailure", "basis": "observed"}],
    "limitations": ["未访问业务环境"],
    "artifacts": ["reports/review.md"]
  }
}
```

也可用 `finish(message)` 作为 succeeded/summary 简写，但不能同时传 message 和 result。两种形式都受同一结果总字节限制，超限在修改状态前拒绝。后续修改候选结果，即使成员状态未变化，也必须先写入 journal 才返回成功。

- 候选结果不代表 worker 已 native settled；运行完成仍由真实 native settlement/error 决定。
- 空 native answer 且没有候选结果，worker 标记 failed；有合法候选结果时允许空 native text，不伪造一段 native 输出。
- run completion 与任务的 succeeded/partial/blocked/failed 分开。父结果提供 teamResult、teamAssignment，汇总文案不把 partial/failed 的任务结果混称业务成功。
- coordinator 使用不带 message/result 的 finish 或 wait(workers) 取得完整终态屏障，然后写总结。
- 显式屏障之后发生过 receiving context checkpoint，且生成非空最终回答时直接完成，不再请求第二次总结。提前自然结束、尚未取得屏障的 coordinator 仍保留一次最终总结 continuation。
- broker operation/lease 覆盖整个 continuation，保持原有单写者、取消、usage 聚合和原生 settled 语义。

## 容量与可观察性

消息正文最多 8 KiB UTF-8；数组最多 32 项。总量另有限制，按序列化 JSON 字节数计算，包含转义开销：brief 32 KiB，assignment 16 KiB（task 正文仍不超过 8 KiB），task result 12 KiB。必需数据超限直接拒绝，不能先接受再在最终 RPC 传输时失败。

wait 回复只携带当前 snapshot 和本次消费的 events，不重复复制整个事件历史。初次 context snapshot 保留 brief/assignments/角色及 revision，不重复携带旧 outputs/results。完整有界历史仍在 Hub journal；事件恢复继续遵循 Pi canonical context edits。

状态显示成员任务、有效策略、结果状态、最近的 from -> to 消息。单队 status 用明确的 Preview 字段，完整 assignment/result 留在 native subagent result details 和 journal；列出全部团队只返回概要，避免最多 32 个团队的完整结构体涌入父上下文。

## 验证范围

新增回归覆盖：

- 自发自收拒绝、身份不可伪造、queued/applied 回执及旧历史恢复。
- 全员 admission 前原子保存 assignments，原生首轮 context 实际看到共享授权和有效策略。
- report 发送者过滤、未匹配消息保留、关联/纠错消息校验。
- inbox 饱和、afterSeq、历史淘汰和多次 redirect 下的保留方向交付；真实 Pi 阻止已生成的旧工具，零次执行该工具，并在新 context 中正常继续。
- finish 简写/结构化结果、总大小、候选替换持久化、方向切换清除旧结果、空 native answer 的明确处理。
- coordinator 显式屏障后只总结一次，提前结束仍补充总结；WSS 请求里实际包含所有 worker 终态结果。
- 8-worker 大数据组合的公开回复、私有帧和专用持久化消息大小；32-team 状态列表的输出界限。
- 原有 pause/resume、取消、native retry、compaction、绑定隔离、单写者及普通 subagent 行为。

Windows 原生测试启动会先等待 `get_state`，与生产 worker 的 connect 顺序一致。实测冷启动约 6.2 秒，而随后 bind/unbind ACK 为毫秒级；因此测试不再把 spawn 当 ready，再误用五秒应用 ACK 预算覆盖整个启动。生产应用 ACK 上限没有放宽。

验收只使用临时目录、离线 synthetic provider 与 loopback HTTP/WSS，不触发真实 MES 操作，不把本次工程测试等同于外部模型决策质量或交互 TUI 实测。

### 本次实际验证结果

- `npm run typecheck` 通过。
- 隔离 agent 目录、清除继承的外部代理并设置 loopback NO_PROXY，`PI_SUBAGENT_DEPTH=1 node --import tsx --test --test-concurrency=2 tests/subagent/team-*.test.ts tests/subagent/tool.test.ts tests/subagent/session-broker.test.ts tests/subagent/rpc-worker.test.ts`：**346/346 通过**，无失败、取消、跳过或 todo。日志：本机临时目录的 `pi-team-depth-final.log`。
- production-only 安装布局的原生 loader 正向/敏感性/依赖隔离三个测试通过。最初因新文案遗漏既有完成语义断言而失败，已恢复明确的 `finish is intent, not a terminal result` 描述并实测通过。
- 全仓以两个测试文件并发运行完成了 **902** 项：当轮 **888 通过、13 失败、1 取消**。其中一个失败是上述已修复的文案；另外 **12 个失败在未修改的 `97e986b` 独立 archive 快照中全部复现**：9 个 apply-patch 测试假设 POSIX 路径，2 个 stateless compaction 测试超出 Windows 命令行长度，1 个代理优先级测试受 Windows 环境变量大小写行为影响。它们不是本次 Team 变更引入，未在本任务中修改。
- 被取消的 context-window 集成用例达到其原有 30 秒整体时限；单独运行当前代码通过（约 19.3 秒），未延长它的时限。默认 `npm run check` 的文件并发曾导致 Fast/Search 集成用例超时并阻塞清理；结束的只是本任务启动的测试进程树。完整全仓门禁不能据此声明为绿色。
- Team RPC 测试区分冷启动预算与五秒应用 ACK；涉及多个新进程的工具占位符/close-abort 测试整体预算覆盖全部启动和清理，不改变生产 ACK、pause 或终态断言。
- 未修改全局 Pi 配置、生产部署、旧业务会话或 Git 远端；临时基线快照和验证日志不是运行依赖。
