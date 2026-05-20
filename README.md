# Pi Rail UI

Pi Rail UI is a local UI extension for the Pi coding agent. It replaces the default interactive terminal experience with a rail-based, bottom-docked layout designed for long coding sessions: a calm slate editor, aligned message surfaces, fixed footer, scrollable conversation history, mouse-aware selection, and consistent command/tool output spacing.

It customizes most of the interactive TUI surface while preserving Pi's normal editor behavior and keybindings.

## Highlights

- Slate-gray editor with a thin left rail.
- Fixed editor and footer at the bottom of the terminal.
- Conversation history scrolls independently above the editor.
- App-level mouse wheel scrolling, scrollbar dragging, and chat text selection.
- Per-tool mouse click expand/collapse.
- Slash command, settings, and model selectors rendered as bottom overlays above the editor.
- User messages, assistant thinking, assistant replies, tool output, and command output use a consistent left-gap layout.
- Centralized visual configuration in `ui-style.json`.

## Installation / Location

This extension is intended to live in the Pi agent extension directory:

```text
~/.pi/agent/extensions/pi-rail-ui/
```

The active entry point is:

```text
~/.pi/agent/extensions/pi-rail-ui/index.ts
```

After editing or installing it, reload Pi with:

```text
/reload
```

Pi should discover this directory extension automatically.

## Toggle Command

Pi Rail UI registers a slash command:

```text
/rail-ui
```

It toggles the extension on or off for the current UI session.

## Main Features

### 1. Rail-Based Editor Surface

The input editor is rendered as a slate-gray surface with a left rail:

- Minimum height: 4 rows.
- Responsive growth up to a configurable maximum.
- Internal editor scrolling when content exceeds the max height.
- No top, right, or bottom border.
- Thin left rail using the configured rail glyph.
- Paste markers are highlighted for better visibility.
- Standard Pi editor behavior is preserved through inheritance from Pi's `CustomEditor`.

The editor still supports normal Pi input behavior:

- Submit behavior.
- Slash autocomplete.
- IME cursor marker behavior.
- Keybindings.
- Paste handling.
- Cursor movement.

### 2. Fixed Bottom Editor and Footer

The editor and footer stay fixed at the bottom of the terminal. Only the conversation history scrolls.

This makes long sessions easier to navigate because the input area does not move when browsing previous output.

The footer is customized to be visually lightweight:

- No background block.
- No rail.
- Compact session/context/model information.
- Context percentage shown with two decimals.
- Configurable blank rows below the footer via `footer.bottomGapRows`.

### 3. Scrollable Conversation History

Pi Rail UI implements app-level conversation scrolling so the editor/footer can remain fixed.

Supported interactions:

- Mouse wheel scrolling.
- Right-side scrollbar rendering.
- Scrollbar dragging.
- Smooth scrollbar drag animation.
- Chat text selection by mouse drag.
- Automatic copy of selected chat text to clipboard.
- Right-click copy of selected chat text.

Scrollbar styling is configurable. The current default uses:

- Track background: transparent.
- Thumb background: coordinated blue.
- Width: one rail-width unit.

### 4. Mouse Selection and Clipboard

The extension provides app-level mouse selection for both:

- Editor text.
- Conversation history text.

Clipboard copy supports platform tools where available:

- `pbcopy`
- `clip.exe`
- `wl-copy`
- `xclip`
- `xsel`
- OSC52 fallback

Because terminal mouse tracking is enabled for scrolling/selection, native terminal selection may require `Shift + drag` depending on the terminal emulator.

### 5. Assistant Thinking and Reply Alignment

Assistant thinking blocks are rendered with the same rail geometry as the editor but with a transparent background and theme-derived thinking rail color.

Assistant normal replies are aligned to the same content column as thinking blocks, but without a rail. This keeps assistant responses visually aligned while avoiding visual noise.

### 6. User Message Cards

User messages are restyled as editor-like cards:

- Slate background.
- Editor-blue rail.
- Configurable text gap.
- Timestamp line below the prompt.
- Timestamp color from the active Pi theme's `thinkingText` token.

Duplicate user prompts are handled with timestamp assignment logic so repeated prompts still get the correct timestamp order.

### 7. Slash Command Overlay

Slash autocomplete is rendered as an overlay above the editor instead of replacing the editor area.

Supported behavior:

- First-level slash command menu.
- Nested slash command menu.
- Bottom-anchored positioning above the editor.
- Shared rail/surface styling.
- Selected item text uses the configured rail color.

### 8. Settings and Model Selector Overlays

The following menus are restyled to use the same second-level surface style as slash nested menus:

- `/settings`
- `/model`
- `/models`

They render as bottom overlays above the editor instead of replacing the editor. Search input focus and selector key handling are preserved.

### 9. Tool Execution Layout

Tool execution blocks receive the same left window gap as thinking/editor surfaces. `!bash` execution results use a dedicated system-command surface: the same outer left gap, a thin thinking-like left rail, no top/bottom divider lines, a darker slate background, and a blank separator row before each bash block. The bash rail color is resolved from the active theme's `bashMode` token, so it follows theme changes while remaining visually distinct from normal tool output. Collapsed bash previews keep the first echoed rows under the command line instead of jumping straight to the tail preview.

Collapsed tool/bash/thinking sections use a shared hint shape such as `... (3 earlier lines, ctrl+o to expand)`. Long tool or bash results may still show Pi's built-in hint text inside the section, but Pi Rail UI suppresses extra section-outside duplicate hints and adds precise mouse interaction and selection behavior:

- Click a single tool block to expand it.
- Click it again to collapse it.
- Other tool blocks are not affected.
- Dragging from a tool or bash block starts chat selection/copy instead of toggling it.
- If a terminal reports only press/release coordinates for a drag, release at a different position is also treated as selection, not as a click toggle.
- After expanding a still-updating tool block, the conversation viewport stays anchored at the reading position instead of being pushed by new output.

`Ctrl+O` works as Pi's global expansion toggle for every Rail Section that supports folding, including nested `assistantThinking` blocks as well as tool/bash execution blocks.

### 10. Command and Reload Output Alignment

Pi Rail UI normalizes slash-command output spacing so command output aligns with the rest of the rail layout.

Covered output includes:

- `/session`
- `/hotkeys`
- `/changelog`
- `/name`
- `/new`
- `/debug`
- `/reload` resource lists
- `/reload` status messages
- `showStatus(...)`
- `showWarning(...)`
- `showError(...)`

Status-like messages have their internal padding normalized so the final visual left gap is exactly the configured rail gap.

## Configuration

Visual tuning lives in:

```text
ui-style.json
```

Important sections:

### `surfaceLayout`

Controls the shared rail geometry:

```json
{
  "leftWindowGapWidth": 2,
  "leftBorder": "▎",
  "leftBorderWidth": 1,
  "borderContentGapWidth": 0
}
```

### `editor`

Controls editor height, background, rail color, selection color, paste marker style, and editor mouse tracking.

### `conversationScroll`

Controls app-level conversation scrolling:

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

`mode: "app"` enables Pi Rail UI's app-level conversation viewport, fixed editor/footer, app-level wheel scrolling, scrollbar drag, chat selection/copy, and section click toggles. `mode: "native"` skips the app-level conversation viewport so the terminal can use its own scrollback; editor/footer are not fixed in that mode and mouse-section interactions are not provided by this extension. `scrollbar.visible` only controls the built-in scrollbar drawing, while `scrollbar.dragEnabled` controls dragging. `performance.historyTailRenderWindow` controls how many trailing history components are re-rendered during normal non-scroll renders. Older unchanged history is reused from cache, while the tail remains fresh for streaming assistant/tool/bash updates. Scroll and scrollbar-drag renders reuse the whole cached history when possible.

### `bashExecution`

Controls the dedicated `!bash` system-command surface and complements `railSections.sections.bashExecution`:

```json
{
  "background": { "rgb": [38, 43, 52] },
  "rail": "theme:bashMode",
  "leftBorder": "▎",
  "borderContentGapWidth": 0,
  "verticalSpacingRows": 1
}
```

The rail color uses the active Pi theme's `bashMode` token, matching Pi's native bash divider color while removing the native top/bottom dividers. `verticalSpacingRows` inserts plain blank rows before bash blocks so consecutive system-command results do not visually merge into one continuous rail.

### `railSections`

Controls shared behavior and layout metadata for history sections. UI rendering stays in the individual renderer/patch files, but selection, copy, click-to-toggle, scroll anchoring, and content offsets are managed through this shared section config.

Supported section keys include:

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

Each section can use the same shape:

```json
{
  "selectable": true,
  "collapsible": false,
  "clickToToggle": false,
  "autoCollapseAfterRows": false,
  "layout": {
    "leftWindowGapWidth": 2,
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

`assistantThinking`, `toolExecution`, and `bashExecution` enable `collapsible` + `clickToToggle`; each defaults to `autoCollapseAfterRows: 20`, so short blocks open by default while long blocks fold automatically until the user manually toggles them. Normal message/status/output sections keep selectable/copy behavior without expanding or collapsing. `spacing.beforeRows` / `spacing.afterRows` insert plain blank rows outside the clickable/selectable section range. `scope: "group"` applies the leading spacing only to the first item in a consecutive run of the same section kind; this is used by `commandOutput` and `resourceStatus` so `/session` and `/reload` outputs are separated from previous history without adding gaps between every resource/status child.

`selectorOutput` is special: it contributes shared rail layout/style to popup menus through Rail Overlay, but it does not make those overlays part of conversation history and does not add history selection/copy/collapse behavior.

### Rail Overlay

Rail Overlay is the popup-menu counterpart to Rail Section. It reuses the same rail geometry and `railSections.sections.selectorOutput` style for slash autocomplete, `/settings`, `/model`, and `/models`, while keeping overlay lifecycle, focus, input forwarding, bottom anchoring, and max-row clipping separate from history behavior.

### `thinking`, `userMessage`, `slashCommand`, `footer`

These sections control specialized details of the other major UI surfaces. For popup menus, `slashCommand` provides menu-specific behavior such as selected text color, list column widths, max rows, and bottom spacing; `selectorOutput` provides the shared rail/background surface style.

`footer.bottomGapRows` reserves blank terminal rows after the footer in app-level conversation viewport mode. The default config sets it to `0` for the previous flush-bottom layout; set it to `1` or higher if you want the footer to sit above the terminal bottom.

## Project Structure

```text
pi-rail-ui/
├── index.ts                         # Extension entry point, command, and feature install/uninstall glue
├── ui-style.json                    # Centralized visual configuration
├── config/
│   ├── index.ts                     # Config parsing and resolved style/layout exports
│   ├── colors.ts                    # Theme/color resolution helpers
│   └── types.ts                     # Config and layout types
├── core/
│   ├── clipboard.ts                 # Clipboard helpers
│   ├── patching.ts                  # Prototype patch helpers and native Pi export resolution
│   └── utils.ts                     # ANSI, mouse, wrapping, width, and selection utilities
├── rail/
│   ├── index.ts                     # Rail primitive exports
│   ├── rail-gap.ts                  # Left-gap wrappers
│   ├── rail-surface.ts              # Shared rail/surface renderers and section-derived surface styles
│   ├── rail-section.ts              # History metadata, ranges, selection offsets, toggles, and wrapper
│   ├── rail-overlay.ts              # Popup shell reusing rail layout/style without history behavior
│   └── render-cache.ts              # Width/signature render cache helper
└── components/
    ├── editor/
    │   ├── index.ts                 # Editor feature exports
    │   ├── rail-editor.ts           # Rail editor, internal scrolling, mouse selection, paste marker rendering
    │   ├── slash-autocomplete.ts    # Slash autocomplete overlay body
    │   └── selector-overlay.ts      # Settings/model selector overlay patches
    ├── footer/
    │   ├── index.ts                 # Footer feature exports
    │   └── footer.ts                # Footer stats, layout, cache, and render logic
    ├── messages/
    │   ├── index.ts                 # Message feature exports
    │   ├── assistant-message.ts     # Assistant thinking/reply rail patches
    │   ├── user-message.ts          # User message rail card patches
    │   ├── command-output.ts        # Slash command output rail wrapping
    │   └── resource-status.ts       # /reload resources and status/message rail wrapping
    ├── executions/
    │   ├── index.ts                 # Execution feature exports
    │   ├── bash-execution.ts        # Bash execution rail surface and preview normalization
    │   ├── tool-execution.ts        # Tool execution rail install/uninstall patches
    │   └── execution-collapse.ts    # Shared execution auto-collapse helpers
    └── chat-view/
        ├── index.ts                 # Chat-view feature exports
        ├── state.ts                 # Shared viewport/cache/interaction state and store
        ├── history-renderer.ts      # Chat history flattening, spacing, ranges, and prefix/tail cache
        ├── viewport.ts              # Sticky chat viewport, scrollbar drawing, and TUI patch install
        └── interactions.ts          # Wheel/mouse routing, scrollbar drag, chat selection/copy, section clicks
```

## Design Principles

1. **Keep Pi behavior intact**
   The editor remains based on Pi's `CustomEditor`; standard keybindings and input behavior are preserved.

2. **Centralize visual tuning**
   Colors and layout constants should live in `ui-style.json`, not scattered through TypeScript.

3. **Reuse one rail layout/style system**
   Editor, thinking, user messages, slash menus, settings/model overlays, and command output share the same rail geometry. History blocks use Rail Section behavior; popup menus use Rail Overlay so they can reuse gap/rail/background without inheriting history selection/copy/collapse semantics.

4. **Patch carefully where no public API exists**
   Pi currently does not expose public hooks for every surface customized here, so this extension uses controlled prototype patches with fallback behavior.

5. **Optimize hot paths**
   Conversation scrolling, scrollbar dragging, editor rendering, and mouse selection use caches to avoid re-rendering large histories or large prompts unnecessarily.

## Performance Notes

The extension includes several optimizations for long sessions:

- Conversation history prefix/tail render cache.
- Full history reuse for normal editor typing, overlay input, wheel scrolling, and scrollbar dragging when history refs are unchanged.
- Configurable tail refresh window via `conversationScroll.performance.historyTailRenderWindow` for streaming assistant/tool/bash updates.
- Rail-section lookup through sorted ranges and binary search instead of a per-history-line section map.
- Editor visual-map cache.
- Smooth scrollbar drag animation without re-rendering all history components.
- Binary search for locating clicked rail sections.
- ESC-prefixed input parsing to avoid mouse-regex checks on normal typing.
- Width-aware truncation and wrapping where needed.

## Limitations and Caveats

- This extension relies on Pi internal/prototype patches because Pi does not currently provide public APIs for all customized TUI surfaces.
- Internal Pi changes may require updating this extension.
- Terminal-native mouse selection may require `Shift + drag` while mouse tracking is enabled.
- Standard terminal protocols do not reliably allow changing the OS cursor shape on hover.
- Pi's Markdown renderer is terminal-oriented, not GitHub/web Markdown:
  - HTML/CSS is not interpreted.
  - Tables may degrade at narrow widths.
  - Code fences and headings may render differently from web Markdown.

## Troubleshooting

### Extension does not load

Run `/reload` and check the extension discovery output. It should include:

```text
~/.pi/agent/extensions/pi-rail-ui/index.ts
```

### Native terminal selection behaves differently

Use `Shift + drag` for terminal-native selection, or use Pi Rail UI's app-level chat selection.

### Scrollbar drag feels too fast or too slow

Tune:

```json
"dragAnimationMs": 90
```

Set it to `0` for immediate jumps.

### Mouse wheel speed feels wrong

Tune:

```json
"wheelStepRows": 3
```

### Editor grows too much or too little

Tune:

```json
"editor": {
  "height": {
    "min": 4,
    "max": 12,
    "maxRatio": 0.32
  }
}
```
