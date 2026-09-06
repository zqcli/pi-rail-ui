# Pi Rail UI

Pi Rail UI 是一个用于 Pi coding agent 的本地视觉扩展。它为长时间编码会话提供基于左侧 rail 的输入框、消息和工具 surface，同时把 renderer、fullscreen viewport、聊天滚动、选择和 selector 生命周期交给 Pi 原生实现。

它只定制视觉 surface 和工具展示，并保留 Pi 原有编辑器行为、快捷键和原生 TUI 功能。

Pi Rail UI 要求 Pi `0.85.1`，不再支持旧版 Pi。

## 功能概览

- Slate 灰色输入框，带细左侧 rail。
- Rail 风格的输入框和消息 surface。
- Pi 原生 fullscreen mode 提供固定 editor/footer dock 和独立滚动 transcript。
- Pi 原生 fullscreen mode 提供固定 editor/footer dock 和独立滚动 transcript。
- Pi 负责鼠标选择、滚动、滚动条和 selector 生命周期；Rail 不安装任何滚动条 surface、viewport 或通用鼠标路由器。
- Rail presentation 跟随 Pi 原生 `Ctrl+O` 全局状态；tool/bash/thinking 单块单击切换和 editor cursor 定位使用 Pi 原生 component `handleMouse` 路由。
- 用户消息、assistant thinking、assistant 正文、工具输出、命令输出使用统一的左侧 gap 对齐。
- 所有主要视觉配置集中在 `ui-style.json`。

## 安装 / 目录位置

该扩展应放在 Pi agent 的扩展目录中：

```text
~/.pi/agent/extensions/pi-rail-ui/
```

当前入口文件是：

```text
~/.pi/agent/extensions/pi-rail-ui/index.ts
```

安装或修改后，在 Pi 中执行：

```text
/reload
```

Pi 会自动发现并加载该目录扩展。

### Rail Subagents

Rail 会从根扩展自动加载内置的一次性与持久化 `subagent` tool，不应再同时安装第二个独立 `subagent` 扩展。从旧的 standalone 部署升级时，应先删除原 symlink，并把 extensions 目录中的非隐藏备份移出自动发现范围：

```bash
rm -f ~/.pi/agent/extensions/subagent
if [ -e ~/.pi/agent/extensions/subagent.stateless-example ]; then
  mkdir -p ~/.pi/agent/extensions/.backups
  mv ~/.pi/agent/extensions/subagent.stateless-example \
    ~/.pi/agent/extensions/.backups/
fi
```

安装或更新 Rail 后执行 `/reload`。Rail 不读取 `~/.pi/agent/agents`，也不继承其他 subagent 插件预定义的 profile prompt/tools。它把 Pi 已有 model 映射到独立 session，同一个 model 可以关联任意多个 session。

- 使用 `@new/cus-resp/gpt-5.6-sol`（或其他 canonical Pi model reference）创建 persistent model session。
- 使用 `@agent/auth-review` 把后续任务强制派发给该 instance，同时不和 Pi 原生 `@path` 文件补全冲突。
- 在 TUI/RPC 中，使用 `@agent/auth-review steer <message>` 或 `@agent/auth-review followup <message>` 可直接控制已经运行的本地 persistent child；Rail 会消费这条输入并调用本地 control path，不会再把它排队给 parent。`followup` 映射为 `followUp`，消息不能为空。无 UI 的 print/JSON 输入和 extension 注入的消息保持普通 routing。
- 在 CLI、print、JSON 和 RPC prompt 中使用等价的 `new://cus-resp/gpt-5.6-sol` 与 `agent://auth-review`。Pi 会在 extension 收到输入前，把位于 CLI 参数开头的 `@...` 当作文件展开。
- 使用 `/rail-agent` 打开统一 TUI overlay，其中包含 **Current**、**All Persistent**、**Create / Adopt** 三个 tab。面板准确区分 `starting`、`running`、`queued`、`idle`、`not connected` 和 `error`；其他进程持有的 live lease 显示为 **In use elsewhere**，不会猜测它是否正在生成。Model 与 saved session 都在同一面板中通过可搜索 inline picker 选择；创建表单把选中的 model/thinking level 映射到一个独立 session，新 persistent agent 必须提供具体首个任务，adopt saved session 时保留原 cwd。对于当前进程内正在运行的 agent，按 `g` 打开 inline **Steer** 输入，按 `f` 排队 inline **Follow-up**。
- Tool 提供 `model` 和 `task`、不提供 `alias/session` 时，执行无状态一次性 model session，不创建 persistent instance 或 child session；省略 `model` 时使用 Pi 当前模型。
- 使用 `model` 加 `alias` 创建 persistent session；后续使用 `target` 复用该 session。同一个 model 换一个 alias 即可创建另一个独立 session。
- 生命周期按连续性选择：已有 linked helper 使用 `target` 继续；已有 session 的历史或项目 cwd 有价值时用安全 `fork` 接入（常用于跨仓库工作）；只有具体首个任务预计需要后续追问时才创建新的 persistent alias，禁止创建空占位 session；其余使用 stateless 一次性派发。
- Tool 提示会引导父 LLM 主动把代码搜索、聚焦分析、验证、比较和 review 等自包含工作派发为 stateless session；只有确实需要后续连续追问时才创建 persistent alias。需要显示为独立顶层 Tool Call 的并行工作，会在同一 assistant turn 发出多个 sibling `subagent` call，由 Pi 并发执行；`tasks` 数组只用于一个 grouped parent Tool Call 内包含多个 child 面板的场景。Child session 当前不能递归调用 `subagent`，嵌套拆解仍由父 session 负责编排。
- 可通过 `{ "target": "auth-review", "control": { "delivery": "steer", "message": "Focus on tests" } }` 或 `delivery: "followUp"` 控制 live persistent child。`steer` 会在当前 child assistant turn 及其 tool calls 完成后、下一次模型调用前送达；`followUp` 会在当前工作结束后继续执行。Control 不会启动 idle/stopped session，不能指向 stateless 或 foreign-owned worker，也不应和首次 dispatch 作为 sibling 同时发出，因为 startup 存在竞态。
- 如果 child 在普通 final answer 中请求输入或另一位 specialist，可以使用 `needs_input` 或 `specialist_request` 这两个 plain-language label；它们只是提示约定，不是结构化 wire protocol。仍由 parent 负责解决问题或派发 specialist，然后使用 `target+task` 继续原 persistent child。这样递归、lineage、cost、取消和 single-writer ownership 都继续在 parent 可见。
- Subagent Tool Call 面板在运行中实时展示 user task、thinking、assistant 文本、tool call 参数和 tool result，并且只保留最近 18 个 activity 事件。运行期间会在有界 activity 和 `earlier activity hidden` 提示上方持续显示一行 live usage。完成后折叠态显示 final answer 预览；展开后显示保留的最后一条 assistant answer、近期 activity、input/output/cache/context token、turn、cost、耗时和 stop reason。Parallel 与 chain 调用为每个 child 渲染独立面板，同时提供汇总 token、cost、状态和 wall time。
- Persistent child 在 `/resume` 中统一命名为 `subagent · <父 session> · <alias>`。创建它的父 session 名会写入 instance；父 session 未命名时使用 `<项目目录>-<sessionId 前缀>`。既有 managed session 会在下一次持有 lease 的 RPC worker open 时安全补名。Stateless 始终传入 `--no-session`，不创建 JSONL，也不会出现在 `/resume`。
- 通过单 writer lease 和 per-agent queue，避免并发调用同时写入同一个 child JSONL session。

`/rail-agent` 默认使用安全的 **Safe copy**（`fork`），对已经由 Rail 管理的 session 也会创建副本。需要不复制而直接 link/continue 已有 agent 时，使用 **Current** / **All Persistent**。**Exclusive in place** 是带明确警告的表单选项，且只有确认没有其他 Pi 进程打开该 session 时才可使用。面板可继续/link agent、在本地可控时修改 model 或 thinking level、停止 worker 但保留 session、从当前父 session detach 并保留 child JSONL，也可以永久删除 Rail descriptor 与 child JSONL。永久删除刻意不扫描或改写其他父 session；那些 session 中的旧 link 会继续保留，之后调用时直接报 unknown persistent subagent。另一个 TUI 正在使用的 session 不会被 live attach 或删除。旧 `/agents` 与 `/subagents` alias 不再注册。

Instance metadata 和 lease 保存在 `~/.pi/agent/stateful-subagents/`；instance 保存的是 model reference，而不是 agent profile。Session lease 与短期 alias reservation 同时保证 single writer 和跨 Rail 进程的 persistent alias 唯一性。完整 child transcript 仍保留在 child Pi session 中。父 tool content 继续限制为 50KB；Tool Call details 只保留有界 final answer 与近期事件窗口，不复制无界 child 历史。

## 测试

测试用例统一放在 `tests/` 下，使用 Node 内置 `node:test`，并通过 `tsx` 加载 TypeScript。

```bash
npm run typecheck
npm test
npm run check
```

项目把四个 Pi devDependencies 精确固定在 `0.85.1`，`npm run check` 针对这些本地依赖校验代码。需要版本匹配的交互启动时，运行 `node node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`；若改用全局 `pi` CLI，请安装相同 `0.85.1` 并启动新进程。`/reload` 只在当前运行进程内重载扩展，不会升级当前 runtime，因此旧全局安装永远不会切换既有会话。Rail 不会自动升级全局 CLI。

## 命令

Pi Rail UI 注册了以下 slash 命令：

### `/rail-ui`

用于在当前 UI 会话中启用或禁用该扩展。

### `/rail-duplicate`

将当前 session 复制为同级 session（共享相同的 parent）。

新 session 的特点：
- 继承源 session 的所有会话历史、compaction 记录、model 切换、thinking level 切换。
- 和源 session 共享相同的 `parentSession`，因此是同级关系而非父子关系。
- 在 `/resume` 中排在源 session 上方（按创建时间排序）。
- 可通过 `/resume <session-id>` 切换到新 session。

该命令适用于从相同会话状态探索不同方案或实验不同的后续对话。

`/rail-duplicate` 刻意**不与** Pi 原生 `/clone` 等价：`/clone` 会把当前 active branch 提取成新的 child session 并立即切换过去；`/rail-duplicate` 留在当前 session，创建与源共享同一 `parentSession` 的同级 session（新文件不是源的 child）。

### `/rail-session`

使用 Pi 原生 overlay 显示当前 Rail session 摘要。

### `/rail-oai-fast`

切换当前模型的 Pi 0.85.1 原生 OpenAI-compatible priority service tier：

```text
/rail-oai-fast on|off|status
```

该命令临时覆盖 `model.samplingParams.service_tier`；关闭、切换模型或 session shutdown 时会恢复原值。不维护模型白名单，也不重写 provider payload。

生效范围是 Pi 文档明确透传 `samplingParams` 的 `openai-completions`、`openai-responses` 和 `azure-openai-responses`。`openai-codex-responses` 会显示为 inactive，因为 Pi 0.85.1 的 Codex builder 使用独立 `serviceTier` option，并不会转发模型 `samplingParams`。

### `/rail-oai-search`

设置当前 session 中 GPT 模型的原生 hosted web search 模式：

```text
/rail-oai-search live|cached|off|probe
```

`live` 允许访问外部网页，`cached` 将 hosted tool 限制为缓存内容。是否生效只根据 model ID 或显示名称中是否包含 `gpt` 判断，不限制 provider。Rail 仅修改 Responses 形态的 payload，在该请求中替换冲突的本地或 hosted `web_search`，保留已有 `include` 并请求 source metadata。切换到非 GPT 模型后，当前模式会保持为 inactive；切回 GPT 模型时自动恢复。

`probe` 是一次性诊断模式：它会切换到 `live`，强制下一次 eligible Responses 请求调用 hosted `web_search`，随后立即恢复普通 `live`/`auto` 行为。它只用于验证 provider 注入和搜索活动面板，不改变正常搜索语义。

对于可安全包装的 `openai-responses` 和 `azure-openai-responses` SSE provider，Rail 还会旁路观察真实 hosted `web_search_call` 流，并在对应 Assistant turn 内插入一个搜索活动区。只有观察到真实 hosted call 后才显示；搜索中自动展开，成功后自动折叠，并以有界列表展示动作和来源链接；可单击或按 `Ctrl+O` 展开/折叠。完成态 snapshot 作为 session custom entry 保存，不会进入 LLM context。Rail 不覆盖 native extension provider，也不改变 Codex 默认 WebSocket transport；这些路径仍可使用 hosted search，但只显示最终回答。

## 主要功能

### 1. 基于 Rail 的输入框界面

输入框被渲染为带左侧细 rail 的 slate 灰色 surface。换行、光标、autocomplete、粘贴处理和输入框内部滚动由 Pi 原生 `CustomEditor` 管理；Rail 移除原生横向 frame、应用 `editor.height`，再给其余原生输出行包上配置好的 surface：

- Pi 原生 editor 上下边框会被 Rail surface 完全替换。
- `editor.height.min`、`max` 和 `maxRatio` 控制可见输入区域高度。
- 左侧使用可配置的 rail 字符。
- 粘贴标记会被高亮显示。
- 继承 Pi 原生 `CustomEditor`，保留标准编辑行为。

保留的 Pi 标准行为包括：

- 提交输入。
- Slash autocomplete。
- IME 光标标记。
- 快捷键。
- 粘贴处理。
- 光标移动。

### 2. Pi 原生 Fullscreen Dock

固定 editor/footer dock 和独立滚动 transcript 由 Pi 原生管理。需要该布局时，请设置 `tuiMode: "fullscreen"`；Rail 不再 patch renderer 或 alternate screen。

可选的 Rail footer 保持轻量样式：

- 无背景块。
- 无 rail。
- 紧凑显示 session/context/model 等信息。
- Context 百分比保留两位小数。
- Pi 的 animated working indicator 位于自己的原生行上；Rail footer 不再重复 ready/working 状态标签。

### 3. 原生聊天历史

Transcript layout、wheel/page scrolling、prompt navigation、文本选择和滚动条由 Pi 的 regular/fullscreen renderer 管理。Rail 不安装竞争性的 viewport、滚动条或通用鼠标路由器。

### 4. 原生选择和剪贴板

Fullscreen transcript 的选择与复制使用 Pi 原生 TUI 行为，包括选词、选段、边缘自动滚动和瞬时的 `Copied!` flash。Rail 不再全局启用或禁用 terminal mouse tracking，也不重定向复制反馈。在 focused Rail editor 内，`RailEditor.handleMouse` 把可见原生 editor 行映射到 Pi cursor position，其余交互交给 Pi 原生 editor 处理。

### 5. Assistant Thinking 和正文对齐

Assistant thinking 块使用和输入框相同的 rail 几何结构，但背景透明，并使用 Pi 主题中的 `thinkingText` 相关颜色。

Assistant 普通回复会和 thinking 的正文列对齐，但不会显示 rail，以减少视觉噪音。

### 6. 用户消息卡片

用户消息被改造成类似输入框的卡片样式：

- Slate 背景。
- Editor 蓝色 rail。
- 可配置文本 gap。
- Prompt 下方显示时间戳。
- 时间戳颜色来自当前 Pi 主题的 `thinkingText` token。

对于重复用户 prompt，扩展会维护时间戳分配逻辑，避免相同文本的消息时间错乱。

### 7. 原生 Slash Autocomplete

Slash autocomplete 保持在 Pi 原生 editor lifecycle 和 list 实现中。Rail 只应用配置好的 selected-text 颜色，并为 skill command 和需要参数的 Rail command 保留一个窄 confirm seam；列表布局、行数、focus、取消和渲染均由 Pi 管理。

### 8. 原生 Settings 和 Model Selector

`/settings`、`/model`、`/models` 使用 Pi 原生 component 和 lifecycle，从而保留后台 model refresh 取消、selector dispose、focus ownership，以及 TUI mode、fullscreen scrollbar、output padding、Mermaid 等新版设置。

### 9. 工具执行块布局

Tool、`!bash` 和 assistant thinking 块继续使用 Rail surface、紧凑 preview 和主题颜色。Pi 原生 `Ctrl+O` 控制全局展开状态；fullscreen 下普通单击 tool/bash/thinking 块会通过 Pi 原生 component `handleMouse` 路由只切换该块（流式期间和完成后都可用）。拖动选择、链接、滚轮、滚动锚定和滚动条都由 Pi 原生管理。Rail 在 section toggle 时调用原生 `ScrollView.scrollTo()` 保持点击块位置；滚动状态由 Pi 保存。

### 10. 命令输出和 `/reload` 输出对齐

Pi Rail UI 会统一 slash command 输出的左侧 gap，使命令输出和其他 rail 风格块对齐。

已覆盖的输出包括：

- `/session`
- `/hotkeys`
- `/changelog`
- `/name`
- `/new`
- `/debug`
- `/reload` 资源列表
- `/reload` 状态信息
- `showStatus(...)`
- `showWarning(...)`
- `showError(...)`

对于 status/warning/error 这类 Pi 原生 `Text` 输出，扩展会归一化内部 padding，确保最终左侧视觉 gap 精确等于配置值。

## 配置

视觉配置集中在：

```text
ui-style.json
```

重要配置区块如下。

### `appLayout`

控制终端左边缘与 fullscreen transcript/dock（消息、header、加载资源、状态行、widgets、输入框和 footer）之间保留的空白列数。Rail 通过包裹 Pi 的布局容器实现该 gutter，不重新接管 viewport：

```json
{
  "leftGutterWidth": 1
}
```

### `surfaceLayout`

控制 app gutter 内部的共享 rail 几何结构：

```json
{
  "leftBorder": "▎",
  "leftBorderWidth": 1,
  "borderContentGapWidth": 0
}
```

### `editor`

控制 Rail 输入框的颜色、surface 几何、粘贴标记样式和可见输入高度。`height.min` 是静止高度，`height.max` 与 `height.maxRatio` 限制长输入增长。`editor.mouseTracking` 仍可读取旧 style 文件，但鼠标和输入处理保持 Pi 原生。

### `conversationScroll`

聊天历史和 scrollbar 完全委托给 Pi。旧版 `conversationScroll` 样式段与 Rail 滚动条已在 0.85.1 单版本/native-first 更新中退役；仍携带该块的旧 style 文件可正常加载，多余字段会被忽略。

需要固定 editor/footer dock 和 transcript 滚动时，请使用 Pi 的 `tuiMode: "fullscreen"` 设置。Pi 使用主题 `scrollbarTrack` / `scrollbarThumb` token 在 transcript 上绘制自己的滚动条；track 单击和 thumb 拖动实时滚动，离开末尾时会出现可点击的 `Jump to latest message` 标签恢复 follow-end。

### `bashExecution`

控制专用于 `!bash` 系统命令结果的 surface，并和 `railSections.sections.bashExecution` 配合使用：

```json
{
  "background": { "rgb": [38, 43, 52] },
  "rail": "theme:bashMode",
  "leftBorder": "▎",
  "borderContentGapWidth": 0,
  "verticalSpacingRows": 1
}
```

其中 rail 颜色使用 Pi 当前主题的 `bashMode` token，和 Pi 原生 bash 上下分割线颜色一致，但扩展会移除原生上下分割线。`verticalSpacingRows` 会在 bash 块前插入纯空白行，避免连续多条系统命令结果的左侧 rail 视觉上连成一条。

### `railSections`

统一控制 Rail section 的行为和 layout metadata。具体 UI 渲染留在各自的 renderer 文件中；文本选择、复制、鼠标路由和滚动锚定由 Pi 原生 transcript 管理，Rail section metadata 只用于 surface、间距和折叠展示。

支持的 section key 包括：

- `assistantMessage`
- `assistantThinking`
- `assistantReply`
- `userMessage`
- `toolExecution`
- `bashExecution`
- `commandOutput`
- `resourceStatus`
- `selectorOutput`
- `custom`

每个 section 都可以使用同一套配置结构：

```json
{
  "selectable": true,
  "collapsible": false,
  "clickToToggle": false,
  "autoCollapseAfterRows": false,
  "layout": {
    "leftBorder": "▎",
    "leftBorderWidth": 1,
    "borderContentGapWidth": 0,
    "verticalSpacingRows": 0,
    "spacing": {
      "beforeRows": 0,
      "afterRows": 0,
      "collapseAdjacent": true,
      "scope": "section"
    }
  },
  "style": {
    "background": "transparent",
    "rail": "transparent"
  },
  "selection": {
    "mode": "contentOnly",
    "stripAnsi": true,
    "trimRight": true,
    "includeRail": false,
    "includeGap": false
  }
}
```

`assistantThinking`、`toolExecution` 和 `bashExecution` 启用 Rail 的折叠展示；三者默认 `autoCollapseAfterRows: 20`，短块展开，长块自动折叠。全局展开状态由 Pi 原生 `Ctrl+O` 管理；`clickToToggle: true` 为这三种 section 启用单击切换（含 thinking，流式期间和完成后均可用），通过 Pi 原生 component `handleMouse` 路由，不替换 Pi 的鼠标路由或选择逻辑。selection 字段继续作为兼容 metadata。`spacing.beforeRows` / `spacing.afterRows` 会在 section 内容之外插入纯空白行。`scope: "group"` 表示连续同类 section 只在第一项前加前置空行；`commandOutput` 和 `resourceStatus` 使用该模式，因此 `/session` 和 `/reload` 会和前一段历史隔开，但不会在每个资源/状态子块之间插空行。

`selectorOutput` 仅为旧 style schema 兼容保留。内置 `/settings`、`/model`、`/models` 和 editor autocomplete 均保持 Pi 原生 component，从而保留 selector dispose、focus 和 refresh 生命周期。

### `thinking`、`userMessage`、`slashCommand`、`footer`

这些区块控制其它 UI surface 的专用细节。对于原生 editor autocomplete，`slashCommand.selectedText` 只定制选中文字颜色；列表行数以 Pi 的 `autocompleteMaxVisible` 设置为准，布局保持 Pi 原生。其它旧 slash-overlay 和 `selectorOutput` 字段仅为配置兼容保留。

`footer.bottomGapRows` 仅为旧配置兼容保留，不会作用于 Pi 原生 fullscreen dock。

## 项目结构

```text
pi-rail-ui/
├── index.ts                         # 扩展入口、命令、功能 install/uninstall 编排
├── ui-style.json                    # 集中的视觉配置
├── config/
│   ├── index.ts                     # 配置解析和解析后的样式/布局导出
│   ├── colors.ts                    # 主题/颜色解析辅助
│   └── types.ts                     # 配置和布局类型
├── core/
│   ├── clipboard.ts                 # 剪贴板辅助
│   ├── patching.ts                  # 原型 patch 和原生 Pi 导出解析
│   └── utils.ts                     # ANSI、宽度和终端格式化工具
├── rail/
│   ├── index.ts                     # Rail 基础能力导出
│   ├── rail-surface.ts              # 共享 rail/surface 渲染器
│   ├── rail-section.ts              # Rail metadata、折叠状态和 wrapper 辅助
│   ├── render-cache.ts              # 基于宽度/signature 的渲染缓存
│   ├── gutter.ts                    # Fullscreen 左侧 gutter 容器包裹
└── components/
    ├── editor/
    │   ├── index.ts                 # Editor 功能导出
    │   └── rail-editor.ts           # 原生 CustomEditor surface wrapper 和 autocomplete 样式
    ├── footer/
    │   ├── index.ts                 # Footer 功能导出
    │   └── footer.ts                # Footer 统计、布局、缓存和渲染
    ├── messages/
    │   ├── index.ts                 # Message 功能导出
    │   ├── assistant-message.ts     # Assistant thinking/reply rail wrapper
    │   ├── user-message.ts          # User message rail card wrapper
    │   ├── command-output.ts        # Slash command output rail 包装
    │   └── resource-status.ts       # /reload resources 和 status/message rail 包装
    └── executions/
        ├── index.ts                 # Execution 功能导出
        ├── bash-execution.ts        # Bash execution rail surface 和 preview 规范化
        ├── tool-execution.ts        # Tool execution rail surface wrapper
        ├── execution-presentation-policy.ts  # Execution preview/collapse 策略
        ├── execution-rail.ts        # 共享 execution rail 渲染
        └── execution-collapse.ts    # 共享 execution auto-collapse 辅助
```

## 设计原则

1. **保留 Pi 原生行为**
   输入框仍然基于 Pi 的 `CustomEditor`，标准快捷键和输入行为保持不变。

2. **视觉配置集中化**
   颜色和布局参数尽量放在 `ui-style.json`，避免散落在 TypeScript 代码中。

3. **复用同一套 Rail layout/style 系统**
   输入框、thinking、用户消息和命令/工具输出复用同一个 rail 几何模型。Pi 原生 selector 和 fullscreen viewport 不再由 Rail 重复实现。

4. **原生 Pi 行为优先**
   Rail 不再 patch Pi 的 renderer 生命周期、alternate screen、transcript viewport、鼠标选择引擎、同步输出和 selector ownership。鼠标交互走 Pi 公开的 component `handleMouse` seam；`dispatchMouseEvent`/`retargetMouseEvent` 是 `pi-tui` 内部实现，不在其 package root 导出，Rail 从不直接 import。在没有公开 seam 的地方，Rail 仍选择性依赖 Pi 内部结构：bundled constructor identity 解析（`core/patching`）和消息/execution 的视觉 render decorator。Hosted search 另行使用 Pi 的公开 payload 与 provider-registration seam，对 Responses SSE 做有界旁路观察。

5. **优化热路径性能**
   Rail 缓存 component 和 surface 渲染，但不再持有 Pi 原生 transcript scroll state。

## 性能说明

该扩展针对长会话做了多处性能处理：

- 长消息与工具输出使用 component/surface render cache。
- Execution preview 缓存和按需宽度格式化。
- 已完成的 simple tool/bash preview 会跨滚动帧复用，不再重复扫描大型参数或输出。
- Fullscreen 左 gutter 在 transcript 内容未变化时复用已加前缀的行。
- Pi 管理 transcript layout、viewport、滚动、选择和原生滚动条；Rail 不保存任何自身滚动状态。

## 限制和注意事项

- 部分视觉 component patch 以及窄范围 fullscreen copy/click seam 仍依赖 Pi 内部结构，component 或 mouse handler shape 变化时可能需要同步更新。
- Fullscreen mode、transcript 滚动、终端鼠标选择、滚动条和 selector 生命周期由 Pi 原生管理。Rail 只拥有 Rail surface 及其 collapse presentation，不再 patch scrollbar 或 viewport 输入路径。
- 终端模拟器自身的滚动条（iTerm2 的 "Save lines to scrollback in alternate screen"）不在转义序列可控范围内；若它与 Pi 原生 scrollbar 同时出现，请在 iTerm2 profile 设置中关闭该选项。
- 使用固定 dock 和原生 transcript viewport 时，请把 Pi 的 `tuiMode` 设置为 `fullscreen`。
- 标准终端协议通常不支持应用可靠改变系统鼠标指针形状。
- Pi 的 Markdown 渲染是终端 Markdown，不是 GitHub/Web Markdown：
  - HTML/CSS 不会被解释。
  - 窄终端下表格可能退化。
  - 代码块和标题渲染可能与网页 Markdown 不同。

## 常见问题

### 扩展没有加载

执行 `/reload` 并检查扩展发现输出。应该包含：

```text
~/.pi/agent/extensions/pi-rail-ui/index.ts
```

### 原生 transcript 行为

使用 Pi 的 `tuiMode: "fullscreen"` 和原生快捷键进行 transcript 滚动、滚动条与选择。Rail 不安装竞争性的聊天 viewport 或滚动条；Pi 在 fullscreen transcript 上渲染自己的滚动条与 Jump-to-latest 指示。

### 输入框增长太早或太晚

调整：

```json
"editor": {
  "height": {
    "min": 4,
    "max": 12,
    "maxRatio": 0.32
  }
}
```
