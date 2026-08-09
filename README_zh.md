# Pi Rail UI

Pi Rail UI 是一个用于 Pi coding agent 的本地视觉扩展。它为长时间编码会话提供基于左侧 rail 的输入框、消息和工具 surface，同时把 renderer、fullscreen viewport、聊天滚动、选择和 selector 生命周期交给 Pi 原生实现。

它只定制视觉 surface 和工具展示，并保留 Pi 原有编辑器行为、快捷键和原生 TUI 功能。

## 功能概览

- Slate 灰色输入框，带细左侧 rail。
- Rail 风格的输入框和消息 surface。
- Pi 原生 fullscreen mode 提供固定 editor/footer dock 和独立滚动 transcript。
- Pi 原生负责鼠标选择、滚动和 selector 生命周期；Rail 在原生 transcript 上保留旧版蓝色滚动条。
- Rail presentation 跟随 Pi 原生 `Ctrl+O` 全局状态，并支持 fullscreen 下单击 tool/bash 块单独展开或收起。
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

## 测试

测试用例统一放在 `tests/` 下，使用 Node 内置 `node:test`，并通过 `tsx` 加载 TypeScript。

```bash
npm run typecheck
npm test
npm run check
```

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

### `/rail-session`

使用 Pi 原生 overlay 显示当前 Rail session 摘要。

### `/railfast`

切换当前模型的 Pi 0.84 原生 OpenAI-compatible priority service tier：

```text
/railfast on|off|status
```

该命令临时覆盖 `model.samplingParams.service_tier`；关闭、切换模型或 session shutdown 时会恢复原值。不维护模型白名单，也不重写 provider payload。

生效范围是 Pi 文档明确透传 `samplingParams` 的 `openai-completions`、`openai-responses` 和 `azure-openai-responses`。`openai-codex-responses` 会显示为 inactive，因为 Pi 0.84.1 的 Codex builder 使用独立 `serviceTier` option，并不会转发模型 `samplingParams`。

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

### 3. 原生聊天历史

Transcript layout、wheel/page scrolling、prompt navigation 和文本选择由 Pi 的 regular/fullscreen renderer 管理。Rail 不再安装竞争性的 viewport 或通用 mouse router；fullscreen 滚动条拖动只通过一个窄的 Rail 输入 seam，并直接向终端写 thumb preview。

### 4. 原生选择和剪贴板

Fullscreen transcript 的选择与复制使用 Pi 原生 TUI 行为，包括选词、选段和边缘自动滚动。Rail 不再全局启用或禁用 terminal mouse tracking；它只把 Pi 位于右上角 flash stack 的临时 `Copied!` 提示转移到 Rail footer。

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

Slash autocomplete 保持在 Pi 原生 editor lifecycle 和 list 实现中。Rail 只应用配置好的 selected-text 颜色，并保留 skill command completion seam；列表布局、行数、focus、取消和渲染均由 Pi 管理。

### 8. 原生 Settings 和 Model Selector

`/settings`、`/model`、`/models` 使用 Pi 原生 component 和 lifecycle，从而保留后台 model refresh 取消、selector dispose、focus ownership，以及 TUI mode、fullscreen scrollbar、output padding、Mermaid 等新版设置。

### 9. 工具执行块布局

Tool、`!bash` 和 assistant thinking 块继续使用 Rail surface、紧凑 preview 和主题颜色。Pi 原生 `Ctrl+O` 控制全局展开状态；fullscreen 下普通单击 tool/bash/thinking 块会只切换该块（流式期间和完成后都可用）。拖动选择、链接、滚轮和滚动锚定仍由 Pi 原生管理，滚动条 thumb 拖动使用 Rail 的窄 preview/commit seam。

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

聊天历史滚动交给 Pi 原生实现。该配置段仅为旧配置兼容保留，扩展不会再安装 app-level viewport 或 alternate-screen patch：

```json
{
  "mode": "native",
  "enabled": false,
  "alternateScreen": false
}
```

需要固定 editor/footer dock 和 transcript 滚动时，请使用 Pi 的 `tuiMode: "fullscreen"` 设置。fullscreen 下 Rail 隐藏 Pi 的 scrollbar 绘制路径，自己绘制旧版 Rail 滚动条：单列蓝色 thumb（`editor.rail` / `conversationScroll.scrollbar.thumbBackground`），透明 track，仅在 transcript 溢出时显示。拖动期间只预览 thumb，松手后才提交 scroll position 并渲染 transcript。

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

统一控制 Rail section 的行为和 layout metadata。具体 UI 渲染仍然留在各自的 renderer/patch 文件中；文本选择、复制、鼠标路由和滚动锚定由 Pi 原生 transcript 管理，Rail section metadata 只用于 surface、间距和折叠展示。

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

`assistantThinking`、`toolExecution` 和 `bashExecution` 启用 Rail 的折叠展示；三者默认 `autoCollapseAfterRows: 20`，短块展开，长块自动折叠。全局展开状态由 Pi 原生 `Ctrl+O` 管理；`clickToToggle: true` 为这三种 section 启用窄的 fullscreen 单击 release hook（含 thinking，流式期间和完成后均可用），但不会替换 Pi 的鼠标路由或选择逻辑。selection 字段继续作为兼容 metadata。`spacing.beforeRows` / `spacing.afterRows` 会在 section 内容之外插入纯空白行。`scope: "group"` 表示连续同类 section 只在第一项前加前置空行；`commandOutput` 和 `resourceStatus` 使用该模式，因此 `/session` 和 `/reload` 会和前一段历史隔开，但不会在每个资源/状态子块之间插空行。

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
│   └── rail-scrollbar.ts            # 在原生 transcript 上绘制旧版 Rail 滚动条
└── components/
    ├── editor/
    │   ├── index.ts                 # Editor 功能导出
    │   └── rail-editor.ts           # 原生 CustomEditor surface wrapper 和 autocomplete 样式
    ├── footer/
    │   ├── index.ts                 # Footer 功能导出
    │   ├── footer.ts                # Footer 统计、布局、缓存和渲染
    │   └── copy-feedback.ts         # 将 fullscreen 复制提示转移到 footer
    ├── messages/
    │   ├── index.ts                 # Message 功能导出
    │   ├── assistant-message.ts     # Assistant thinking/reply rail patch
    │   ├── user-message.ts          # User message rail card patch
    │   ├── command-output.ts        # Slash command output rail 包装
    │   └── resource-status.ts       # /reload resources 和 status/message rail 包装
    └── executions/
        ├── index.ts                 # Execution 功能导出
        ├── bash-execution.ts        # Bash execution rail surface 和 preview 规范化
        ├── tool-execution.ts        # Tool execution rail install/uninstall patch
        ├── execution-click.ts       # Fullscreen execution 单击切换 seam
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
   Rail 不再 patch Pi 的 renderer 生命周期、alternate screen、transcript viewport、鼠标选择引擎、同步输出和 selector ownership。原生 integration patch 仅限视觉 component、复制提示位置，以及实现单块 execution 点击所需的普通单击 release seam。

5. **优化热路径性能**
   Rail 缓存 component 和 surface 渲染，但不再持有 Pi 原生 transcript scroll state。

## 性能说明

该扩展针对长会话做了多处性能处理：

- 长消息与工具输出使用 component/surface render cache。
- Execution preview 缓存和按需宽度格式化。
- 已完成的 simple tool/bash preview 会跨滚动帧复用，不再重复扫描大型参数或输出。
- Fullscreen 左 gutter 在 transcript 内容未变化时复用已加前缀的行。
- 滚动条 thumb 对纯文本行直接用 slice 绘制，仅 ANSI 样式行走完整 overlay 合成；原生拖动几何不做任何改动。
- 拖动 fullscreen 滚动条期间挂起 Pi transcript render；Rail 只用窄的终端写入更新 thumb preview，松手后提交 scroll position 并执行一次渲染。1000ms 无事件超时和 focus-out seam 防止 mouse-up 丢失时画面永久冻结。
- Pi 管理 transcript layout、viewport、普通滚动和原生选择性能；Rail 的 drag state machine 只接管最右侧 scrollbar 列。
- Rail scrollbar 几何复用 Pi 原生 thumb 公式，但不启用 Pi 原生 scrollbar 的绘制和 timer 路径。

## 限制和注意事项

- 部分视觉 component patch 以及窄范围 fullscreen copy/click seam 仍依赖 Pi 内部结构，component 或 mouse handler shape 变化时可能需要同步更新。
- Fullscreen mode、transcript 滚动、终端鼠标选择和 selector 生命周期由 Pi 原生管理；Rail 只在 fullscreen scrollbar 列处理拖动，并在卸载时恢复 Pi 原生 scrollbar mode/style。
- 终端模拟器自身的滚动条（iTerm2 的 "Save lines to scrollback in alternate screen"）不在转义序列可控范围内；若它与 Rail 滚动条同时出现，请在 iTerm2 profile 设置中关闭该选项。
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

使用 Pi 的 `tuiMode: "fullscreen"` 和原生快捷键进行 transcript 滚动与选择。Rail 不安装竞争性的聊天 viewport；fullscreen scrollbar 是扩展侧窄 overlay，松手时才提交 transcript 滚动。

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
