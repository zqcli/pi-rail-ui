# Pi 0.87.0 扩展启动与 native loader 验证

## 问题与根因

Rail 的生产扩展不能依赖扩展目录或仓库目录中的 `@earendil-works/pi-ai` 来解析深层模块。Pi 的 bundled/unbundled loader 会为宿主包提供虚拟公共入口，但 `@earendil-works/pi-ai/api/*` 和 `@earendil-works/pi-ai/utils/*` 深层导入仍可能在隔离安装中失败。

仓库中的 devDependency 会掩盖这个问题：在仓库内使用 `tsx` 导入通过，并不等于把 extension source 安装到 `~/.pi/agent/extensions` 后仍能加载。

## 修复方式

`core/pi-ai-internal.ts` 将需要的内部转换函数解析到**当前运行的 Pi 安装**：

1. 通过 Pi coding-agent 的公共 `getPackageDir()` 找到宿主 package；
2. 使用 Node `createRequire(...).resolve.paths(...)` 的标准搜索路径定位宿主 `pi-ai` dist；
3. 使用 `pathToFileURL()` 动态加载磁盘模块，避免在扩展静态加载链中留下无法由 native loader 解析的裸深层导入。

公共入口仍用于 transcript、event stream、provider registration 等必须共享宿主实例的对象。扩展目录中的 pi-ai 副本不是解析起点；loader harness 会放置一个每个入口都抛错的 decoy 来验证这一点。

Pi 0.87 的 GPT compaction full-transcript hook 使用 `context_with_system`。loader smoke 会检查该 hook 注册，同时确认旧的 `context` hook 没有注册；这确保 prompt/tool state 与 `ContextEditEntry` canonical projection 一起进入 replay/repair 边界。

## 验证范围

`tests/core/pi087-native-loader.test.ts` 在 OS 临时目录创建 production-only extension layout，覆盖：

- bundled CLI、unbundled CLI 和显式 runtime SDK loader；
- 路径包含空格及非 ASCII 字符；
- Rail 工具、命令、provider、`session_before_compact`、`before_provider_request` 和 `context_with_system` 注册；
- compaction request tool declaration 重建、stale replacement、strict/non-strict converter 分支；
- 重新引入 `@earendil-works/pi-ai/api/constrained-sampling` 时确实失败；
- extension-local decoy `@earendil-works/pi-ai` 不会替代宿主依赖。

默认矩阵只使用仓库固定的 Pi `0.87.0`，不下载额外 runtime，也不启动模型生成。子进程只发送离线 `get_state` RPC；HOME、agent directory 和 loader environment 都隔离。

```bash
npx --no-install tsx --test tests/core/pi087-native-loader.test.ts
```

bundle 与真实生命周期 smoke 还由以下测试覆盖：

- `tests/core/bundle-loader.test.ts`
- `tests/core/bundle-native-ui.test.ts`
- `tests/gpt-compaction/pi-integration.test.ts`
- `tests/subagent/pi-compaction-integration.test.ts`

## 边界

- 本测试验证 macOS 当前环境中的 npm Pi 0.87.0 loader/bundle 行为，不等同于 Windows fullscreen 或人工 iTerm2 验收。
- 不支持没有磁盘 `pi-ai` 依赖的单文件 Bun/SEA 二进制安装；这类安装会明确报告宿主依赖缺失，而不是静默吞掉扩展错误。
- `/reload` 只会在当前进程内重载扩展，不会把旧 Pi runtime 升级到 0.87.0。
