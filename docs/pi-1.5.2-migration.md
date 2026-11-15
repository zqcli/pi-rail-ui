# Pi 1.5.2 迁移与验证

## 基线

- Rail：`dev` 的 `6432cd9b3a3398e0fc472c32a1cbb89c4b1ce92c`，原四个 Pi 依赖为 `0.87.1`。
- 上游：[正式版 v1.5.2](https://github.com/earendil-works/pi/releases/tag/v1.5.2)，源码 `b4afdddf44e059c67ccf5097e5317d913521b470`。
- 四个 Pi devDependencies 与 lockfile 精确升级到 `1.5.2`。扩展运行时也应使用这一版本；`/reload` 不会升级宿主进程。
- 仓库该基线没有 `AGENTS.md`、`.agents/skills` 或 GitHub Actions workflow。

## 行为与接口

### UI

Pi 1.5.2 的 user message 直接包含 Markdown，旧版两层查找会丢失 Rail 表面和时间戳。现在按新版结构定位，保留 outputPad、markdown transformer 和 OSC 133 标记。测试覆盖新增的 `messageId` / `timestamp`、复用 streaming Markdown、延迟参数渲染、最终执行元数据，以及 Kitty/iTerm2 图片的折叠恢复。

没有用 `registerToolRenderer` 替换执行卡片的必要钩子：上游 `ToolRenderContext` 只有 `expanded` 快照，没有展开 setter；图片还会由 `ToolExecutionComponent` 在 renderer 槽位外追加。仅替换公开 renderer 不能等价实现整卡点击、展开/折叠、滚动锚点和图片行为。`!bash`、普通消息和 thinking 的 Rail 交互继续保留。

### 复制会话

Pi 1.5.2 从首条 user message 开始落盘。`/rail-duplicate` 改为检查真实 assistant 历史，保留首次回复前的拒绝提示；复制仍创建同一原始 parent 下的 sibling，不切换当前会话、不改源文件。

### Provider、搜索与 WSS

搜索的主要观察入口改为 Pi 公开 `provider_stream_event`，自定义 Responses WebSocket 在原始事件归一化之前顺序等待该回调。搜索状态、来源、持久化条目和子代理计数仍由 Rail 管理。旧测试明确支持的第三方 custom streamSimple 若依赖传入 fetch 而不转发原始事件，保留仅面向这类 override 的 SSE 兼容观察；每个 activity 只采用一种事件来源，避免重复计数。原生 provider 和明确支持原始事件的 Rail WSS 不安装该兼容 wrapper。

Responses 工具声明使用上游 `getResponsesToolSupport` 的 `none` / `additions` / `changes` 语义。Provider overlay 保留模型、认证、hooks、图像及分类模型配置。自定义 WSS 的 endpoint、代理、连接复用、失败边界和 `previous_response_id` 保留。

`disableContinuation` 的缓存预热请求使用独立连接，不读写正常会话的 continuation 缓存；后续真实请求继续使用原来的响应链。

### Keep-alive

复用公开 `isCacheWarmingReplayable`，保留已按 1.5.2 源码审计的 live `CacheWarmer` 调度接口。公开 decision hook 不能设置任意间隔、延长等待窗口或改变失败暂停策略，无法等价替代该接口。原生 refresh 继续管理认证、hooks、usage 以及 `disableContinuation`。

验证涵盖未使用命令时的原生 off/streaming/idle 行为、当前 session ID 的授权、reload 交接、模型/分支/压缩失效、工具等待与闲置刷新。详见 [keep-alive 验证](keep-alive-validation.md)。

### Remote Compaction

保留 checkpoint、canonical history projection、ContextEditEntry 的 omission/replacement、模型/provider 切换后的 native repair 及不泄露 opaque checkpoint 的请求边界。`before_agent_start` 分别估算 user（含图片）和 custom trigger。

Pi 1.5.2 在 `before_agent_start` 之前标记 run active；此时公开 `ctx.compact()` 会 abort 并等待同一 run，造成自等待。Rail 的 pending native repair 在匹配会话且尚未开始模型流时，临时桥接一次 `AgentSession.compact` 调用至上游 `_runAutoCompaction("threshold", false)`，立即恢复原方法。准备、扩展 hook、持久化、context refresh、取消和生命周期事件仍由 Pi 完成；没有重新提交原提示，也没有取消 busy 状态。正在压缩或已进入响应/后续处理的同会话不进入这个桥接，失败时显式 abort，避免并行压缩及原提示继续请求。普通手动压缩和其他会话沿用原方法。新版 summary helper 不再使用 reserve 参数，Rail 显式保留原有输出上限，使历史分块预算与真实请求一致。Responses tool namespace 只在相同 provider/API/model 的历史中保留。

### Subagent / Team

RPC `prompt` 返回的 disposition 用于确认本次请求实际 `started`。`handled`、意外 `queued` 或缺失 disposition 不再通过 `get_state` 猜测接受。结束仍以 `agent_settled` 为边界；Team Actor、WorkRef、结果确认、资源租约和真实进程退出确认保持独立。

显式 Team `tools` 清单同时在 `tool_call` 执行边界校验，覆盖 codemode 嵌套调用和 deferred/tool_search 激活后的直接调用。`tools: null` 保留默认工具能力；`subagent` / `subagent_team` 始终禁止递归。Team 协议工具标为 `model-only`，防止将必须作为最终 assistant batch 的 reply/yield/close 藏入 code 执行。TypeBox schema 的枚举不再混用新版 pi-schema 的类型品牌。

## 验证记录

最终检查命令：

```bash
RAIL_KEEP_ALIVE_WALL_CLOCK=1 PI_OFFLINE=1 PI_TELEMETRY=0 npm run check
```

TypeScript 检查通过；完整测试 **1518/1518**，29 个 suite，0 失败、0 取消、0 跳过，测试耗时 **309.58 秒**。其中真实 wall-clock keep-alive 用例耗时 120.96 秒，覆盖工具长时间等待后及 idle 阶段的刷新。完整回归同时覆盖真实 Pi codemode/tool_search 的受限及默认工具清单、生命周期/租约/进程退出、remote compaction 恢复失败和并发取消，以及本地 HTTP/SSE/TLS WSS 的鉴权、请求头、continuation 和取消语义。

迁移前已正常快进远端 `main`：`8122b707e1cd5e9499eb5976f1a1079be341116b` → `6432cd9b3a3398e0fc472c32a1cbb89c4b1ce92c`，并从 Git 远端重新读取验证。未使用强推。仓库没有可运行的 GitHub Actions workflow；基线提交的 combined statuses 和可查询的 PR workflow runs 均为空，不能将本地检查描述为远端 CI 通过。

验证环境与边界：

- 使用 Linux / Node 24.22.1、实际 npm Pi 1.5.2 bundle/SDK 和本地 synthetic provider。
- 生产安装布局验证不携带 Pi devDependencies，并覆盖 bundled/unbundled/SDK、空格与非 ASCII 路径、错误 deep import 和 extension-local decoy。
- 真实 PTY 交互核验：启动、`/rail-ui` 关闭/开启、`/rail-session`、`/rail-agent`、`/rail-team`、`/reload`，最后正常退出。鼠标、拖拽、宽字符、滚动与图片通过真实 Pi 组件的终端探针验证；不等同于真人在不同终端模拟器中的视觉验收。当前环境没有 `fd`，离线启动显示缺失提示，未下载或替换它。
- 环境没有模型 API key 或 Pi auth.json；没有调用在线真实模型，没有验证生产服务缓存命中/计费，也没有声称所有操作系统和终端均通过。
- 五个分工子 agent 的请求配置均为 `gpt-6-astra`、`max`；工具可确认请求参数和运行状态，未提供独立的实际后端模型/思考配置证明。

测试入口使用 `node --import tsx --test --test-concurrency=2`，避免 tsx CLI 的额外 IPC 管道并限制同时运行的文件数。初次不限制并发时，带大量真实子进程的 Team shard 曾使性能断言因 CPU 争用失败；性能阈值保持原值，限制并发后通过。并发设置没有降低性能阈值或跳过测试。
