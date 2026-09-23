# Pi 0.86.0 适配与验证报告

## 结果

- 日期：2026-09-20。
- 起点：`dev`，提交 `b93d171`。
- 开发分支：`compat/pi-0.86.0`。
- 四个 Pi 依赖精确固定为 `0.86.0`，同步更新 lockfile 和中英文 README。
- 最终 `npm run check`：类型检查通过，**659 tests / 28 suites，659 passed，0 failed / cancelled / skipped / todo**。
- 未更新全局 Pi（仍为 `0.85.1`），未推送、发布或修改用户的 Pi 配置。

开发及独立审查使用 `cus-resp/gpt-6-astra:medium`，默认上下文。互不重叠的实现与审查通过 grouped subagent 并发完成。服务端额度／负载中断后的局部改动经核对后续做，没有把中断任务视为完成。

## 实现范围

### Provider 与 transcript

- Hosted search wrapper 改用 Pi 0.86 的 `TranscriptContext`，保留 context、callbacks、认证和其他 request options。
- 远程压缩按当前分支的 system/tool checkpoint 与增量重建工具状态，处理新增、删除及同名重定义，不再盲用上一请求中的本地工具集合。
- 未变更工具保留已有 provider wire schema；新建／重定义工具通过 Pi 官方 Responses converter 转换，保留 Codex strict 默认值与显式 constrained sampling 的差异。
- 保留 hosted tools、Fast 和缓存等已有请求字段；hosted search 已替换的本地同名 `web_search` 不会在压缩时重新引入。
- 压缩 instructions 使用 `ctx.getSystemPrompt()` 的完整有效提示，保留 `before_agent_start` 的 `systemPrompt`／`forceSystemPrompt` 覆盖，不重复拼接 transcript patches。
- tool call 与 tool result 之间的 system 更新不再被当成会话边界，不会将真实工具输出替换为合成结果。

### 压缩历史恢复

- Native compaction 的 system 快照覆盖其物理边界之前的 retained system entries；完整及前缀重建均避免重复应用内容、sections 和工具变化。
- 有安全尾部边界时，native repair 在原分支上追加 compaction，保留 usage ancestry。真实 `createBranchedSession()` 回归确认 repair 后 clone 仍保留使用量，且原会话不重复计费。
- 对原生 preparation 无法直接接纳的小尾部，暂时借用 checkpoint 前的原始分支进入压缩 hook，在摘要和写入前恢复原叶子。失败／取消不会复制历史，也不会覆盖外部新选择的叶子。
- checkpoint-only 关闭沿用安全的 sibling-native repair，保留既有“刚完成压缩即关闭”与取消行为。
- 重复 remote checkpoint 的 retained 区间也检查旧 marker；成功关闭后的 native context 不得包含任何 remote checkpoint placeholder。
- 不能找到安全既有边界、或工具结果无法安全配对时，继续 fail closed，保持历史与设置，而非伪造 anchor 或放行 opaque marker。
- Repair/resume 按当前模型及实际 project trust 解析压缩预算。

### Subagent budget、trust 与生命周期

- tool preflight、stateless runner、broker、RPC worker 和 child helper 按实际 child model 解析 `compaction.modelOverrides`，不用父模型代替显式 child。
- 预算随实际 child cwd 解析：fork 使用目标 cwd，open/exclusive 尊重已保存 session cwd。
- 父端按照保存的 trust 决定和全局非交互默认策略做预检；child helper 使用 `ctx.isProjectTrusted()` 再验证。不会隐式批准项目配置。
- 显式预算的模型在异步预检／确认前固定；persistent 队列内再次校验，RPC 在确认模型身份后准备 budget。
- `null`／省略预算不安装 override，也不读取 reserve 来制造额外限制。
- 修复 active run 后排队 model change 时 shutdown 等不到 worker.stop 的问题；退出先停止活动 worker，再等待 maintenance 收敛。

### 使用量

- Footer 与 `/rail-session` 累计独立 `UsageEntry`，包括 cache warming 和未知 kind。
- Child collector 按 entry ID 去重独立 usage；工具结果中的嵌套模型 usage 在 completion 时累计，按 tool-call ID 防止重复事件计费。
- 这些账目不增加 assistant turns，不覆盖主对话 context token 估计，不与 message／compaction accounting 重复。
- settled 后的晚到事件和 idle cache warming 不再改变已经完成的 dispatch 账目。

### 测试迁移

- 活跃版本断言及 bundle smoke 更新至 `0.86.0`，历史说明保留原版本号。
- Mock providers 使用 `getCurrentSystemPrompt()`／`getCurrentTools()`，不再读取旧 `context.systemPrompt`，不依赖旧 message 数量。
- 工具循环按 agent run 计数，避免 compaction 截短历史后无限循环；强化三次工具执行、四次 agent provider 请求、摘要调用及正常结束断言。
- 新增专项文件：
  - `tests/gpt-compaction/pi086-repair.test.ts`
  - `tests/gpt-compaction/transcript-request.test.ts`
  - `tests/subagent/model-aware-budget.test.ts`

## 验证证据

### 安装与完整检查

使用 Node `v24.15.0`、npm `11.12.1`：

```bash
npm ci --ignore-scripts --no-audit --no-fund

agent_dir=$(mktemp -d)
PI_CODING_AGENT_DIR="$agent_dir" PI_OFFLINE=1 PI_TELEMETRY=0 npm run check

git diff --check
```

使用临时 agent 目录是为了排除个人的压缩开关、trust 和 provider 配置对测试的影响，不修改用户设置。

| 检查 | 实际结果 |
| --- | --- |
| 全新 lockfile 安装 | 成功；四个 Pi 包均为 0.86.0 |
| TypeScript | 通过 |
| 最终完整测试 | 659/659 通过，28 suites |
| failed / cancelled / skipped / todo | 全部为 0 |
| 最终测试耗时 | 约 19.8 秒（不含安装与类型检查） |
| 差异空白检查 | 通过 |

最终全量检查的本机原始日志：`/tmp/pi-086-verified.Z2bEus/check.log`。该路径为临时产物，不是仓库依赖。

### 关键集成覆盖

- 仓库内真实 Pi 0.86 bundle 的 native UI、constructor identity、legacy RPC 和 compaction 生命周期。
- Stateless、persistent、grouped／chain 展示、模型切换、context helper prepare/reset 及 shutdown。
- 真实离线 CLI 的九种默认／已保存／继承 trust 场景，验证 global reserve 16384、project override 8192、budget 12000 的接受／拒绝与实际 child 一致。
- 真实 `AgentSession.compact()` 与 `SessionManager.createBranchedSession()` 的 usage 保留、snapshot、重复 checkpoint、失败、重试和取消。
- 真实 search payload 转换与 Pi forced-prompt projection，配合本地 capture stub 验证最终 compaction 请求。
- 本地 HTTP/SSE mock 下的 remote compaction、overflow、threshold、live-worker 与多轮工具流程。

没有通过删除失败用例、放宽生产行为断言或禁用检查来获得通过；原有取消集成场景保持有效。

## 验证边界与使用说明

- 自动测试不调用真实付费模型服务；OpenAI/Codex 远端实际接受情况和真实缓存预热计费没有在线验收。
- Native UI 有真实 bundle 自动化 smoke，但未进行人工 iTerm2 长会话、拖选和剪贴板验收。
- 父端预检不执行 child 扩展的 `project_trust` hook，也不继承父进程的临时批准。自定义 child trust hook 与保存／默认策略不同的环境仍有前置保守校验的限制；child helper 始终按实际 session trust 校验。
- 无 live request cache 时可以从 transcript 恢复本地工具，但不能凭空恢复只存在于 provider payload 的 hosted tools／额外字段。旧会话没有任何 system 声明时保留原回退行为。
- 不支持在旧 0.85.1 进程内仅 `/reload` 来完成 runtime 升级。版本匹配的本地启动方式：

```bash
node node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
```

- 支持范围是本次固定的 Pi `0.86.0`；不据此承诺未知后续版本兼容，也没有为旧 Pi 增加双版本兼容层。
