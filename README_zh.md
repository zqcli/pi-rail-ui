# Pi Rail UI

Pi Rail UI 是一个用于 Pi coding agent 的本地 TUI 界面扩展。它把默认交互式终端界面改造成基于左侧 rail 的底部固定布局，适合长时间编码会话：沉稳的 slate 灰色输入框、统一对齐的消息块、固定 footer、可滚动聊天历史、鼠标选择、工具块单独展开，以及一致的命令/工具输出间距。

它覆盖 Pi 交互式 TUI 的主要界面，同时保留 Pi 原有编辑器行为和快捷键。

## 功能概览

- Slate 灰色输入框，带细左侧 rail。
- 输入框和 footer 固定在终端底部。
- 聊天历史在输入框上方独立滚动。
- 支持鼠标滚轮、右侧滚动条拖动、聊天文本选择。
- 支持点击单个工具执行块展开/收起。
- Slash command、`/settings`、`/model`、`/models` 以底部 overlay 形式显示。
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

Viewport composition 的 micro-benchmark 不放进单元测试套件，可单独运行：

```bash
npm run bench:viewport
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

## 主要功能

### 1. 基于 Rail 的输入框界面

输入框被渲染为带左侧细 rail 的 slate 灰色 surface：

- 默认最小高度 4 行。
- 根据内容自适应增长。
- 达到最大高度后使用输入框内部滚动。
- 无顶部、右侧、底部边框。
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

### 2. 底部固定输入框和 Footer

输入框和 footer 固定在终端底部，只有聊天历史区域滚动。

这样在浏览长会话历史时，输入区域不会跟着移动，更适合长时间工作。

Footer 被设计为轻量样式：

- 无背景块。
- 无 rail。
- 紧凑显示 session/context/model 等信息。
- Context 百分比保留两位小数。
- 可通过 `footer.bottomGapRows` 配置 footer 下方的空白行数。

### 3. 可滚动聊天历史

Pi Rail UI 实现了应用层聊天历史滚动，从而让输入框和 footer 固定在底部。

支持的交互：

- 鼠标滚轮滚动。
- 右侧滚动条显示。
- 鼠标拖动滚动条。
- 滚动条拖动平滑动画。
- 鼠标拖动选择聊天文本。
- 自动复制选中的聊天文本到剪贴板。
- 右键复制选中的聊天文本。

滚动条样式可配置。当前默认：

- 轨道背景透明。
- 滑块使用协调的蓝色。
- 宽度为一个 rail 宽度单位。

### 4. 鼠标选择和剪贴板

扩展提供应用层鼠标选择能力，覆盖：

- 输入框文本。
- 聊天历史文本。

剪贴板复制会优先使用系统工具：

- `pbcopy`
- `clip.exe`
- `wl-copy`
- `xclip`
- `xsel`
- OSC52 fallback

由于启用了终端 mouse tracking，某些终端中的原生文本选择可能需要使用 `Shift + drag`。

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

### 7. Slash Command Overlay

Slash autocomplete 不再占用或替换输入框区域，而是显示为输入框上方的 overlay。

支持：

- 一级 slash command 菜单。
- 二级/嵌套 slash command 菜单。
- 固定在输入框上方。
- 共享 rail/surface 样式。
- 选中项文字使用配置中的 rail/selected 颜色。

### 8. Settings 和 Model Selector Overlay

以下菜单被统一为和 slash 二级菜单一致的 surface 样式：

- `/settings`
- `/model`
- `/models`

这些菜单会显示在输入框上方，不再替换输入框区域。搜索输入焦点和选择器按键行为保持可用。

### 9. 工具执行块布局

工具执行块会获得和 thinking/editor 一致的左侧 window gap。`!bash` 执行结果使用专门的系统命令 surface：相同的外侧左 gap、类似 thinking 的细左 rail、去掉原生上下分割线、更深的 slate 背景，并且每个 bash 块前会插入一行空白分隔。Bash rail 颜色来自当前主题的 `bashMode` token，因此切换主题后会跟随 Pi 原生 bash 分割线颜色变化，同时仍能和普通工具输出区分开。bash 收起预览会保留命令下方的前几行回显，不会直接跳到尾部预览。

折叠后的 tool/bash/thinking section 使用统一提示格式，例如 `... (3 earlier lines, ctrl+o to expand)`。对于较长工具或 bash 结果，Pi 原生提示仍会显示在 section 内部；Pi Rail UI 会避免在 section 外额外追加重复的无背景提示，并在此基础上增加更精确的鼠标交互和选中复制行为：

- 点击某个工具块，只展开该工具块。
- 再次点击该工具块，只收起该工具块。
- 不影响其他工具块。
- 从工具块或 bash 块上拖动会进入聊天选中/复制，而不会触发展开/收起。
- 如果终端只上报 press/release 坐标而没有 drag 事件，只要释放位置和按下位置不同，也会按选中处理，不会误触发展开/收起。
- 展开仍在持续更新的工具块后，聊天视口会锚定在当前阅读位置，不会被新输出继续往上顶。

`Ctrl+O` 会作为 Pi 的全局展开/收起开关应用到所有支持折叠的 Rail Section，包括嵌套的 `assistantThinking` 以及 tool/bash execution 块。

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

控制主 viewport 每一行最外层的统一左侧 gutter：

```json
{
  "leftGutterWidth": 2
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

控制输入框高度、背景色、rail 颜色、选择颜色、粘贴标记样式、editor mouse tracking 等。

### `conversationScroll`

控制聊天历史滚动：

```json
{
  "mode": "app",
  "enabled": true,
  "wheelStepRows": 3,
  "performance": {
    "historyTailRenderWindow": 4
  },
  "scrollbar": {
    "visible": true,
    "dragEnabled": true,
    "trackBackground": "editor.background",
    "thumbBackground": { "rgb": [96, 165, 250] },
    "widthMultiplier": 1,
    "dragAnimationMs": 90
  }
}
```

`mode: "app"` 启用 Pi Rail UI 的 app-level conversation viewport、固定 editor/footer、app-level 滚轮、滚动条拖动、聊天选择/复制和 section 点击切换。`mode: "native"` 会跳过 app-level conversation viewport，让终端使用自己的 scrollback；该模式下 editor/footer 不固定，鼠标 section 交互不由本扩展提供。`scrollbar.visible` 只控制内置滚动条是否绘制，`scrollbar.dragEnabled` 控制是否允许拖动。`performance.historyTailRenderWindow` 控制普通非滚动渲染时重渲染末尾多少个历史组件。更早的未变历史会直接复用缓存，末尾区域仍会刷新，以保证流式 assistant/tool/bash 输出实时更新。滚轮和滚动条拖动时会尽量复用整段历史缓存。

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

统一控制历史区 section 的行为和 layout metadata。具体 UI 渲染仍然留在各自的 renderer/patch 文件中，但选中、复制、点击展开、滚动锚定、content offset 等行为统一由 Rail Section 管理。

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

`assistantThinking`、`toolExecution` 和 `bashExecution` 会启用 `collapsible` + `clickToToggle`；三者默认 `autoCollapseAfterRows: 20`，短块默认展开，长块自动折叠，用户手动点击后会保留手动状态。普通消息、状态、命令输出类 section 只复用选中/复制等行为，不会展开或收起。`spacing.beforeRows` / `spacing.afterRows` 会在可点击/可选中 section 范围之外插入纯空白行。`scope: "group"` 表示连续同类 section 只在第一项前加前置空行；`commandOutput` 和 `resourceStatus` 使用该模式，因此 `/session` 和 `/reload` 会和前一段历史隔开，但不会在每个资源/状态子块之间都插空行。

`selectorOutput` 比较特殊：它通过 Rail Overlay 为弹出菜单提供共享 rail layout/style，但不会把这些 overlay 放进 conversation history，也不会给它们增加 history selection/copy/collapse 行为。

### Rail Overlay

Rail Overlay 是 Rail Section 在弹出菜单方向的对应抽象。slash autocomplete、`/settings`、`/model`、`/models` 会复用同一套 rail 几何和 `railSections.sections.selectorOutput` 样式；overlay 生命周期、focus、input 转发、底部锚定和最大行数裁剪仍然和 history 行为分离。

### `thinking`、`userMessage`、`slashCommand`、`footer`

这些区块控制其它 UI surface 的专用细节。对于弹出菜单，`slashCommand` 提供 selected text、列表列宽、最大行数、底部间距等菜单行为配置；`selectorOutput` 提供共享 rail/background surface 样式。

`footer.bottomGapRows` 会在 app-level conversation viewport 模式下为 footer 后方预留终端空白行。默认配置为 `0`，保持之前贴底的布局；如果希望 footer 位于终端底部上方，可设为 `1` 或更大。

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
│   └── utils.ts                     # ANSI、鼠标、换行、宽度、选择工具
├── rail/
│   ├── index.ts                     # Rail 基础能力导出
│   ├── rail-surface.ts              # 共享 rail/surface 渲染器
│   ├── rail-section.ts              # 历史区 metadata、ranges、选择、折叠和包装
│   ├── rail-overlay.ts              # 弹出层 shell，复用 rail 布局但不混入历史行为
│   └── render-cache.ts              # 基于宽度/signature 的渲染缓存
└── components/
    ├── editor/
    │   ├── index.ts                 # Editor 功能导出
    │   ├── rail-editor.ts           # Rail editor、内部滚动、鼠标选择、paste marker
    │   ├── slash-autocomplete.ts    # Slash autocomplete overlay body
    │   └── selector-overlay.ts      # Settings/model selector overlay patch
    ├── footer/
    │   ├── index.ts                 # Footer 功能导出
    │   └── footer.ts                # Footer 统计、布局、缓存和渲染
    ├── messages/
    │   ├── index.ts                 # Message 功能导出
    │   ├── assistant-message.ts     # Assistant thinking/reply rail patch
    │   ├── user-message.ts          # User message rail card patch
    │   ├── command-output.ts        # Slash command output rail 包装
    │   └── resource-status.ts       # /reload resources 和 status/message rail 包装
    ├── executions/
    │   ├── index.ts                 # Execution 功能导出
    │   ├── bash-execution.ts        # Bash execution rail surface 和 preview 规范化
    │   ├── tool-execution.ts        # Tool execution rail install/uninstall patch
    │   └── execution-collapse.ts    # 共享 execution auto-collapse 辅助
    └── chat-view/
        ├── index.ts                 # Chat-view 功能导出
        ├── state.ts                 # 共享 viewport/cache/interaction state 和 store
        ├── history-renderer.ts      # 历史扁平化、spacing、ranges、prefix/tail cache
        ├── viewport.ts              # 固定 chat viewport、scrollbar 绘制、TUI patch install
        └── interactions.ts          # wheel/mouse 路由、scrollbar drag、选择/copy、section clicks
```

## 设计原则

1. **保留 Pi 原生行为**
   输入框仍然基于 Pi 的 `CustomEditor`，标准快捷键和输入行为保持不变。

2. **视觉配置集中化**
   颜色和布局参数尽量放在 `ui-style.json`，避免散落在 TypeScript 代码中。

3. **复用同一套 Rail layout/style 系统**
   输入框、thinking、用户消息、slash 菜单、settings/model overlay、命令输出都复用同一个 rail 几何模型。History block 使用 Rail Section 行为；弹出菜单使用 Rail Overlay，因此能复用 gap/rail/background，但不会继承 history selection/copy/collapse 语义。

4. **在没有公开 API 的地方谨慎 patch**
   Pi 当前没有为所有 TUI surface 提供公开扩展 API，因此本项目使用可控的 prototype patch，并保留 fallback 行为。

5. **优化热路径性能**
   聊天滚动、滚动条拖动、输入框渲染、鼠标选择等路径使用缓存，避免大历史或大 prompt 下无谓重渲染。

## 性能说明

该扩展针对长会话做了多处性能处理：

- 聊天历史 prefix/tail render cache。
- 普通输入、overlay 输入、滚轮、滚动条拖动在历史 refs 未变化时复用整段历史缓存。
- 通过 `conversationScroll.performance.historyTailRenderWindow` 配置尾部刷新窗口，兼顾流式 assistant/tool/bash 更新和性能。
- Rail Section 通过排序 range + 二分查找定位，不再维护每一行的 section map。
- 输入框 visual-map cache。
- 滚动条平滑动画不重新渲染全部历史 component。
- 点击 rail section 时使用二分查找定位目标块。
- 普通输入不再反复进行 mouse/cursor regex 解析。
- 需要时才进行宽度截断和换行处理。

## 限制和注意事项

- 该扩展依赖 Pi 内部结构和 prototype patch，因为 Pi 目前没有提供所有相关 TUI surface 的公开 API。
- 如果 Pi 内部实现变化，扩展可能需要同步更新。
- 启用 mouse tracking 后，终端原生文本选择可能需要 `Shift + drag`。
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

### 终端原生选择行为不一样

可以使用 `Shift + drag` 进行终端原生选择，或者使用 Pi Rail UI 提供的应用层聊天选择。

### 滚动条拖动太快或太慢

调整：

```json
"dragAnimationMs": 90
```

设为 `0` 可以恢复立即跳转。

### 鼠标滚轮速度不合适

调整：

```json
"wheelStepRows": 3
```

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
