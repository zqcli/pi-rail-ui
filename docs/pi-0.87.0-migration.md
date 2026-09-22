# Pi 0.87.0 适配与验证报告

## 结果

- 日期：2026-09-22。
- 四个 Pi 包精确固定为 `0.87.0`，并同步更新 `package-lock.json`：
  `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、
  `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`。
- 当前扩展运行时、bundle smoke、native loader、compaction repair harness 和文档均以 Pi `0.87.0` 为基线。
- 本次适配不保留旧版双运行时兼容层；在旧 Pi 进程中执行 `/reload` 不会升级已经运行的 runtime。

## 0.87 API 迁移

- 需要观察完整 prompt 和 transcript 的 GPT compaction replay hook 从 `context` 迁移到 Pi 0.87 的 `context_with_system`。
- `context` 不再注册该 hook；loader 回归测试同时断言 `context_with_system` 存在、`context` 不存在。
- `context_with_system` 接收 Pi 已经恢复 prompt/tool state 的完整消息列表，Rail 只在需要关闭 remote replay、切换 identity 或修复损坏 checkpoint 时替换完整 transcript。
- 远程 compaction 的声明快照优先从 canonical projection 取得；对没有 system snapshot 的旧/手工 session，保留声明 delta 的安全回退。

## ContextEditEntry、replay 与 repair

Pi 0.87 的 `SessionManager` 增加了 append-only `ContextEditEntry` 和 provenance-preserving `buildSessionProjection()`。Rail 的 replay/repair 不再把 raw branch 直接 flatten 成消息：

- recovery 会先移除 provider-bound 的 Rail checkpoint，再对重新链接的内存 branch 使用官方 canonical projection；这样 `replacement: null` 的 omission 和 replacement content 都会生效。
- remote compaction 的 retained/live interval 通过 canonical projected range 序列化，ContextEditEntry 不能被遗漏，也不能把已废弃的 assistant response 重新发给 provider。
- native repair 的 cut point 在 canonical projection materialized view 上计算；state-only usage entries 保留为 boundary anchor，而被 projection omission 的可见 message 不会成为新的 retained history。
- 0.87 原生 compaction 的 system snapshot、旧 native boundary 和 detached prefix cut 继续按 Pi 的投影规则处理；opaque Rail checkpoint 不会进入 native summary。
- 运行时没有改写 append-only session source。临时 relink/materialized view 只用于 replay、cut point 和 summary request，外部 leaf、usage ledger 与 branched-session extraction 保持原有语义。

新增 `tests/gpt-compaction/context-edit.test.ts` 覆盖：

- omission 不会复活 pre-checkpoint 或 live-tail response；
- replacement 会同时出现在 native recovery、context replay 和 remote compaction input；
- GPT extension 注册 `context_with_system` 而不是 `context`。

## Native loader、bundle 与 harness

- native loader 回归文件更新为 `tests/core/pi087-native-loader.test.ts`，覆盖 Pi 0.87 bundled CLI、unbundled CLI、显式 SDK loader、生产目录依赖闭包、路径空格/非 ASCII、pi-ai deep-import sensitivity 和 extension-local decoy。
- loader fixtures 统一为 `pi087-*` 命名，并断言 `context_with_system` hook 注册。
- bundle loader、native UI、constructor targeting、真实 compaction lifecycle 和 GPT integration smoke 的版本断言统一更新为 `0.87.0`。
- repair harness 更新 fake `AgentSession` 的 0.87 `_refreshFinalizedContext()` seam，避免把 0.87 runtime 的 canonical projection refresh 误判为 repair failure。

## 验证命令

```bash
npm install --ignore-scripts
npm run typecheck
npx --no-install tsx --test \
  tests/gpt-compaction/context-edit.test.ts \
  tests/gpt-compaction/core.test.ts \
  tests/gpt-compaction/transcript-request.test.ts \
  tests/gpt-compaction/pi087-repair.test.ts \
  tests/gpt-compaction/payload-safety.test.ts
npx --no-install tsx --test tests/core/pi087-native-loader.test.ts
npm test
```

实际验证结果：`npm run check` 通过，TypeScript 通过，完整测试为 **687 tests / 28 suites，687 passed，0 failed / cancelled / skipped / todo**，总测试耗时约 20.2 秒；此前的 0.87 定向 compaction/context-edit 分片、native loader/bundle 分片和 subagent integration 分片也全部通过。`git diff --check` 同样通过。测试使用仓库内 mock provider 和 Pi bundle，不调用付费模型。

## 验证边界

- 没有在线验证真实 GPT provider 的 opaque ciphertext 接受情况、远端缓存计费或服务端 compaction 额度。
- native loader 使用真实 npm Pi bundle/loader 做离线启动和内存转换 smoke，但不替代 Windows fullscreen 和人工 iTerm2 长会话验收。
- 不支持在旧 Pi 进程中仅通过 `/reload` 完成 runtime 升级；版本匹配的启动方式是：

```bash
node node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
```
