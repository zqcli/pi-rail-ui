# Pi 0.86.0 / 0.86.1 扩展启动：pi-ai 深层导入修复

## 问题与根因

用户在 Windows 启动 Pi 时报告整个 Rail 入口加载失败：

```text
Cannot find module '@earendil-works/pi-ai/api/constrained-sampling'
Require stack: .../openai/responses-websocket/provider.ts
```

这不是 WebSocket 连接错误，而是 `index.ts` 静态加载链的模块解析失败。Rail 的默认安装函数尚未完成，UI、subagent、compaction、WebSocket 和命令注册都会受影响。

- `d73de73` 首先在 `tools/gpt-compaction/request-context.ts` 引入 `api/openai-responses-shared` 运行时导入。
- `cd3e728` 又在 `openai/responses-websocket/provider.ts` 引入多个 `api/*` / `utils/*` 导入。`constrained-sampling` 只是当前最先失败的一项。
- Pi **0.86.0 和 0.86.1** 的扩展 loader 都没有映射这些深层入口。unbundled loader 的 jiti 根别名会把子路径拼到 `compat.js` 后；bundled loader 的虚拟模块只覆盖指定公共入口，扩展仍无法凭它解析深层路径。
- 仓库的 pi-ai devDependency 可以掩盖部署问题。在仓库内用 `tsx` 导入通过，不能证明安装到 agent extensions 目录后能加载。

## 修复方式

`core/pi-ai-internal.ts` 将所需内部函数的解析锚定到**运行中的 Pi 安装目录**：

1. 使用公共 `getPackageDir()` 获取宿主包目录。
2. 使用 Node `createRequire(...).resolve.paths(...)` 的标准搜索路径定位宿主的 pi-ai dist，不手写 Windows 目录或限制祖先层数。
3. 用 `pathToFileURL()` 和动态 import 加载所需磁盘模块，绕过 jiti 的裸包名前缀重写。

pi-ai 的 package exports 为 import-only，因此这里不使用 `require.resolve()` 直接解析其深层导出。扩展自身的 pi-ai 副本不作为解析起点；已有回归验证扩展目录中的诱饵包不会取代宿主依赖。

能从公共根入口取得的 transcript 函数和类型改用公共入口。Event stream、provider 注册等需要宿主共享实例的对象也继续走公共入口。磁盘模块只用于不依赖宿主注册表或跨实例类身份的转换/辅助函数；bundled runtime 下这些磁盘模块不保证与宿主内嵌模块是同一实例，后续升级 Pi 时必须继续审查这一约束。

没有复制 Pi 的转换实现，没有禁用 WebSocket，也没有用捕获加载异常来掩盖整个扩展缺失。源码中 `typeof import(...)` 的类型查询会被擦除，不是运行时裸深层导入。

## 验证

修复前，隔离部署目录里的完整入口和独立 compaction 路径在两个版本均能复现对应错误。修复后，`tests/core/pi086-native-loader.test.ts` 覆盖：

- 仓库之外、仅带 `ws` 运行时依赖的生产目录；路径含空格和非 ASCII 字符。
- bundled CLI、unbundled CLI、显式指定 runtime 的 SDK loader。
- 完整入口的工具、命令、hook 和 WebSocket provider 注册。
- 真正触发 compaction 工具重建的转换路径，检查生成 schema、description 和 strict 行为；同时保留稳定声明直通的对照。
- 重新引入深层导入确实会失败，以及扩展本地诱饵 pi-ai 不被使用。

默认测试使用仓库固定的 Pi 0.86.0，不联网安装。可对已有的独立 Pi 0.86.1 安装启用第二套矩阵：

```bash
PI_RAIL_0861_RUNTIME=/absolute/path/to/node_modules/@earendil-works/pi-coding-agent \
  npx --no-install tsx --test tests/core/pi086-native-loader.test.ts
```

该参数指向 **package 目录**，测试会断言其版本为 `0.86.1`；CLI 与 SDK 都从这个目录加载，不能只换 CLI 而意外用回仓库 SDK。测试只查询 RPC 状态或做内存转换，不发送模型请求；HOME、agent 目录和 loader 环境隔离。

父审查后的最终门禁启用了上述 0.86.1 矩阵：

| 检查 | 结果 |
| --- | --- |
| `npm_config_offline=true npm run check` | TypeScript 通过；683/683 tests 通过 |
| `PI_SUBAGENT_DEPTH=1 npm_config_offline=true npm test` | 683/683 tests 通过 |
| fail / cancelled / skipped / todo | 两套均为 0 |
| `git diff --check` | 通过 |

0.86.1 在仓库外独立安装，四个 Pi 包实际均为 0.86.1。仓库 package/lockfile 和本地依赖仍固定为 0.86.0，全局 Pi、用户配置及用户会话没有改变。0.86.1 的新增证据是上述启动/转换矩阵，不能把它表述成整个项目的所有测试都在 0.86.1 下运行。

## 适用范围与未验证项

- 已在 macOS 验证有磁盘依赖的 npm Pi 0.86.0 / 0.86.1 安装；路径处理使用跨平台 Node API。
- **尚未在 Windows 系统上实测 fullscreen 启动或交互 UI。** 含空格/非 ASCII 路径的本机测试不等于 Windows 验收。
- **没有磁盘 pi-ai 依赖的单文件 Bun/SEA `pi` 二进制不在本修复支持范围内。** 它只提供虚拟公共模块，原深层导入也无法加载；当前实现会明确报出宿主依赖缺失，不声称已修复这类安装。
