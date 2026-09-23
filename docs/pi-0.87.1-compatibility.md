# Pi 0.87.1 兼容性复核

## 结论与范围

基于 `compat/pi-0.87.0` 的已验证适配，将 `@earendil-works/pi-agent-core`、`pi-ai`、`pi-coding-agent`、`pi-tui` 及其 lockfile 精确升级到 `0.87.1`。原有 [`pi-0.87.0-migration.md`](pi-0.87.0-migration.md) 保留为历史迁移记录；`dev` 与原适配分支不在本次改动范围内。

对照 [Pi v0.87.1 官方发布说明](https://github.com/earendil-works/pi/releases/tag/v0.87.1) 和本地安装的运行时：本版新增 GPT-6 Sol/Luna、Claude Opus 5.5 及 xAI Grok 4.7，修复 OpenAI-compatible image-only user input、非法 `--mode` 和 split-turn 摘要提示词等。`pi-coding-agent` 的 compaction 运行时代码与 0.87.0 的差异仅在 split-turn 摘要提示词；CLI 参数解析现在拒绝非法 `--mode`。Rail 使用的 canonical session projection、`context_with_system` 和 provider replay 相关接口没有变化，未发现需要更改业务实现的运行时不兼容。

此前固定在 `0.87.0` 的 bundled UI、native loader 和 child compaction 测试会在新包上提前失败；已同步版本断言、启动文档与 fixture 说明，同时保留 `pi087-*` 夹具命名。GPT-6 Sol/Luna 已加入共享 GPT 资格矩阵，检查 Fast、Search 与 remote compaction 的门控；Grok 4.7 明确按非 GPT 模型保持 native 策略。Rail 的 Fast 和 remote compaction 能力仍取决于实际 API，不因模型名而扩张到不支持的 API。

## 验证

- 离线 `npm ci --ignore-scripts --no-audit --no-fund --offline` 完成；四个已安装 Pi 包均为 `0.87.1`。
- 基线 `npm run check`：687 passed、5 failed；失败均为固定 `0.87.0` 的断言，修订后在实施 worktree 的 `npm run check`：**692 passed、0 failed / skipped**，TypeScript 检查通过。
- 全量测试包含真实 Pi 0.87.1 bundle/CLI/native loader、mock provider 的 GPT compaction replay/repair、subagent RPC 和 UI smoke；不调用付费 provider。

线上 provider 对 opaque checkpoint 的接受情况、真实额度／缓存计费、Windows fullscreen 和长期交互式 iTerm2 会话未验收。使用全局 `pi` 时须另行确保它也是 `0.87.1`；在旧进程中执行 `/reload` 不能替换运行时。
