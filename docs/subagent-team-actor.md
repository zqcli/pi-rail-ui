# Team Actor v2：协议与阶段性交接

> **实施未完成，不是可发布的 Team 功能。** 当前代码完成了阶段 A 的纯状态机基础和阶段 B 的原生成员执行基础。阶段 C/D 被实施模型连接故障阻断。旧 `subagent_team` 入口尚未迁移，Broker 已拒绝旧 v1 dispatch，因此不能用旧 prepare/launch 示例运行本分支的 Team。
>
> 验证对象：代码提交 `9ccc1e8`；详细证据与 100 项验收映射见 [验证报告](subagent-team-actor-validation.md)。工作区规格 `pi-rail-ui-team-actor-development-spec.md` 是完整目标，本文不替代它，也不缩减其契约。

## 对象和权威状态

- **Member** 持有稳定 alias、角色、私有 epoch、Broker-owned 原生 Pi session。请求完成不代表成员关闭。
- **WorkRequest** 是可执行消息本身。`WorkLedger` 保存 WorkRecord、版本、父子关系、依赖及不可变 ResultRecord；UI 事件尾部不是义务的来源。
- **Activation** 是一次原生 send，精确绑定 WorkRef 或管理事件批次。同一成员从预约到 settlement、reset、deactivate 完成都只允许一个 activation。
- **Delivery** 精确标识本次公开输入。activate ACK 仅证明安装，不能冒充 `input_ready`。

当前主实现文件：

| 文件 | 当前职责 |
| --- | --- |
| `tools/subagents/team-protocol.ts` | v2 类型、容量与预算默认值、公开/私有协议 |
| `tools/subagents/team-codec.ts` | JSON/字段/字节校验、动作规范化、Team 工具 schema |
| `tools/subagents/team-work-ledger.ts` | WorkRef、结果索引、父子约束与等待图 |
| `tools/subagents/team-runtime.ts` | 同步接受、预约、交付、暂存意图、结算、修订、取消和条件关闭 |
| `tools/subagents/team-member-driver.ts` | 原生 lifetime handle 与 Runtime 预约之间的执行桥 |
| `tools/subagents/team-rpc-v2.ts` | bind/activate/reply/deactivate/unbind、ACK、局部幂等及 native 证据 |
| `tools/subagents/team-extension-v2.ts` | 原生 custom input、Team 工具、sole batch 核验、gate、禁止预热 |
| `tools/subagents/session-broker.ts` | 独占 member handle，阻止普通调用插入 lifetime |

`team-protocol-v1.ts` 与旧 hub/runner/extension/RPC 仍是迁移遗留，**并非已经实现“历史只读兼容”**。最终入口迁移后必须删除旧实时机制，不能同时运行两套调度器。

## v2 公开动作

以下是模型工具动作形状，不是已经可用的父层 launcher：

```json
{"action":"request","to":"review","task":"审查当前变更","inputRefs":[]}
```

在管理 activation 中创建 root；在 work activation 中创建 owned child。请求身份、parent/root/depth 来自绑定，不由模型提供。接受立即返回 WorkRef，不等待收件成员。

```json
{"action":"reply","result":{"status":"succeeded","summary":"审查结果","evidence":[{"source":"local test","basis":"verified"}]}}
```

只对应当前 WorkRef。没有未完成 child 且必要 child outcome 已交付后才可 stage。`staged` 不是已提交。

```json
{"action":"yield","waitingFor":[{"workId":"宿主返回的ID","revision":1}],"checkpoint":"收到依赖结果后继续"}
```

work 必须有具体依赖，或使用 `attention` 与 checkpoint；不允许无生产者的空等待。管理 activation 可空 yield。成功 yield 结束一次原生运行，不结束成员。已经交付的相同 outcome 不能制造新唤醒。

```json
{"action":"status","view":"result","id":"宿主返回的resultRef"}
```

只读查询不确认 child outcome 已经交付，不推进业务状态。

```json
{"action":"control","control":{"command":"close_team","resultRefs":["宿主返回的resultRef"],"outcome":"succeeded"}}
```

Manager-only 控制还包括修订、取消、验收、成员关闭。schema 已声明 pause/resume 等完整契约，但当前 Runtime 明确拒绝尚未实现的控制，不能因 schema 存在就声称可用。

## 原生输入及提交边界

当前路径为：

1. lifetime `bind`，每次运行前 `activate` 安装 scope/delivery/public input。
2. 发固定无业务正文的 native trigger prompt。
3. `before_agent_start` 返回 `rail-team-activation` custom message，通过 Pi writer 进入分支。
4. receiving context 核验公开消息与 canonical branch 的来源，精确发送 `input_ready`；provider/tool gate 受 Runtime scope 约束。
5. reply/yield/close_team 核验最终 assistant 批次的唯一工具调用，成功工具结果返回原生 `terminate:true`。
6. 使用本次最后真实 assistant/工具结果及 `agent_settled`；随后等待 context reset、deactivate 和 send 清理，再提交结果或等待意图。

ACK 超时只约束私有命令，不给正常业务运行附加五秒期限。连接没有自动重连/工具重放。重复请求在有限缓存内幂等，pending 不被已完成项挤掉。

正常资源关闭保留 persistent session 和 descriptor。未知 exit 不能作为 ownership 释放证据。Manager 只装载 Team 工具；worker 保留已有允许的基础工具但禁用递归 subagent；绑定期间停用 cache warming，不修改全局设置。

## 当前只可用于底层开发验证

测试通过 `TeamRuntime.prepare`、`TeamMemberDriver.openMember`、`launch` 和逐次 `runNext` 验证基础协议。**目前 `launch` 不是规格要求的覆盖整个 Team 寿命的 Promise；测试手动 drain 不是事件驱动线上调度。** 不应将这些测试辅助调用包装成已完成的用户 API。

参阅真实 Pi 合成 provider 测试：`tests/subagent/team-member-driver.test.ts`。测试 provider 从实际 native input 和工具历史生成应答；不需要外部真实模型 API。

## 后续必须完成

### C1：生命周期调度和控制

- Runtime 唯一合并 effect drain；完整 launch 生命周期；关闭与 fault 清理自动接线。
- pause/resume、修订与取消的受控停止分类；tool gate 精确绑定 native toolCallId。
- Manager 事件优先级/批次/语义静止去重，Manager fault 的安全停驻。
- Host cancel/message/release_hold，N03 八 worker 许可竞争、N10 writer 闭环。

### C2：预算、结算与宿主边界

- root/Team/activation 模型与工具累计计数、紧急管理额度及 Host grant。
- 原生 usage 每 activation 累加一次，contextTokens 不作为累计消费。
- 显式 deadline 执行、关键 result/close journal fail-closed 与 generation 失活。

### D：入口及最终验收

- 新 manager/roleDescription/initialRequests prepare，固定并验证真实策略；launch 入口替换。
- `/rail-team`、成员 stop/delete 路由、UI、历史只读兼容、session tree/reload。
- 删除旧总结 continuation、finish/afterSeq/parked peer wait/stall 路径，更新旧文档和 README。
- 完成 100 场景及 I01–I30 的对应测试，包括 seed/trace 性质测试、原生 context_edit 和完整取消竞态。

测试清理仍有需要改进的地方：部分 harness teardown 捕获并忽略清理异常，不能据此宣称全部资源都已验证收敛。具体限制见验证报告。
