# Pi Rail UI

Pi Rail UI is a local visual extension for the Pi coding agent. It adds a rail-based editor and message surface for long coding sessions while leaving Pi's native renderer, fullscreen viewport, scrolling, selection, and selector lifecycle in charge.

It customizes visual surfaces and tool presentation while preserving Pi's normal editor behavior, keybindings, and native TUI features.

Pi Rail UI requires Pi `0.84.4`. Earlier Pi releases, including `0.84.2`, are not supported.

## Highlights

- Slate-gray editor with a thin left rail.
- Rail-styled editor and message surfaces.
- Pi-native fullscreen mode provides the fixed editor/footer dock and independently scrolling transcript.
- Pi-native mouse selection, scrolling, and selector lifecycle; Rail keeps the legacy blue scrollbar over the native transcript.
- Rail collapse presentation follows Pi's native `Ctrl+O` expansion state and supports single-click tool/bash toggles in fullscreen mode.
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

### Optional Rail Subagent Extension

This repository also contains a standalone subagent extension for both one-off and persistent delegation. Point Pi's separate `subagent` entry at the bundled implementation instead of loading both it and the official stateless example:

```bash
mv ~/.pi/agent/extensions/subagent \
  ~/.pi/agent/extensions/subagent.stateless-example
ln -s ~/.pi/agent/extensions/pi-rail-ui/subagent \
  ~/.pi/agent/extensions/subagent
```

The directory-level link is required because the entry point imports sibling modules. Reload Pi after changing the link. Rail does not read `~/.pi/agent/agents` or inherit another subagent plugin's profile prompts/tools. It maps Pi's existing models to independent sessions, and one model can back any number of sessions.

- `@new/cus-resp/gpt-5.6-sol` (or another canonical Pi model reference) to create a persistent model session.
- `@agent/auth-review` to route a follow-up to that exact instance without conflicting with Pi's normal `@path` completion.
- `new://cus-resp/gpt-5.6-sol` and `agent://auth-review` as equivalent transport-safe forms for CLI, print, JSON, and RPC prompts. Pi expands a leading `@...` CLI argument as a file before extensions receive it.
- `/rail-agent` opens one unified TUI overlay with **Current**, **All Persistent**, and **Create / Adopt** tabs. It shows truthful local phases (`starting`, `running`, `queued`, `idle`, `not connected`, `error`) and marks a live foreign lease as **In use elsewhere** rather than guessing whether that process is generating. Model and saved-session fields open searchable inline pickers inside the same panel; the create form maps one selected model/thinking level to one independent session, requires a concrete first task for a new persistent agent, and preserves a saved session's cwd when adopting it. For a locally running agent, `g` opens an inline **Steer** message and `f` queues an inline **Follow-up**.
- `model` plus `task`, without `alias` or `session`, runs a stateless one-off model session and creates no persistent instance or child session. Omitting `model` uses Pi's current model.
- `model` plus `alias` creates a persistent session; `target` continues that exact session. Reusing the same model with another alias creates another independent session.
- Lifecycle choice is continuity-driven: continue a linked helper with `target`; adopt an existing saved session with safe `fork` when its history or project cwd matters (commonly cross-project work); create a new persistent alias only for a concrete initial task that is expected to receive follow-ups; otherwise use stateless one-off delegation.
- Tool guidance tells the parent LLM to proactively use stateless sessions for self-contained code search, focused analysis, verification, comparison, and review, creating a persistent alias only when later follow-ups need the same child context. Independent work that should appear as separate top-level Tool Calls is emitted as multiple sibling `subagent` calls in the same assistant turn so Pi executes them concurrently; the `tasks` array is reserved for one grouped parent Tool Call with multiple child panels. Child sessions cannot recursively call `subagent`; nested orchestration remains in the parent session.
- A live persistent child can be controlled with `{ "target": "auth-review", "control": { "delivery": "steer", "message": "Focus on tests" } }` or `delivery: "followUp"`. `steer` is delivered after the current child assistant turn and its tool calls, before the next model call; `followUp` runs after the current work finishes. Controls never start idle/stopped sessions, cannot address stateless or foreign-owned workers, and should not be emitted as a sibling of the initial dispatch because startup can race. The practical interactive path while the parent LLM is waiting is `/rail-agent`.
- If a child asks for input or another specialist in its ordinary final answer, it may use the plain-language labels `needs_input` or `specialist_request`; these are guidance, not a structured wire protocol. The parent remains the sole dispatcher: resolve the question or dispatch the specialist, then continue the original persistent child with `target+task`. This keeps recursion, lineage, cost, cancellation, and single-writer ownership visible in the parent.
- The Subagent Tool Call panel streams the current dispatch's user task, thinking, assistant text, tool-call arguments, and tool results while retaining at most the latest 18 activity events. While a run is active, a one-line live usage summary stays above the bounded activity and any `earlier activity hidden` marker. A completed run switches to a compact final-answer preview; expanding it shows the retained final assistant answer, recent activity, input/output/cache/context tokens, turns, cost, elapsed time, and stop reason. Parallel and chain calls render one independent child panel per run plus aggregate token, cost, status, and wall-time totals.
- Persistent child sessions are named `subagent · <parent session> · <alias>` in `/resume`. The creator parent name is stored with the instance; unnamed parents use `<project>-<sessionId prefix>`. Existing managed sessions are renamed safely the next time their leased RPC worker opens. Stateless runs pass `--no-session`, create no JSONL, and never appear in `/resume`.
- Single-writer leases and a per-agent queue so concurrent calls cannot write the same child JSONL session.

The `/rail-agent` safe path defaults to **Safe copy** (`fork`). **Exclusive in place** remains an explicit form choice with a warning and must only be used when no other Pi process has that session open. The panel can continue/link an agent, change its model or thinking level while locally controllable, stop its worker while retaining the session, detach it from the current parent while keeping the child JSONL, or permanently delete the Rail descriptor and child JSONL. Permanent deletion deliberately does not scan or rewrite other parent sessions; stale links in those sessions remain and later calls fail as unknown persistent subagents. Sessions active in another TUI are never live-attached or deleted. The former `/agents` and `/subagents` aliases are intentionally not registered.

Instance metadata and leases live under `~/.pi/agent/stateful-subagents/`; each instance stores a model reference rather than an agent profile. Session leases and short-lived alias reservations enforce one writer and globally unique persistent aliases across Rail processes. The full child transcript remains in the child Pi session. Parent tool content remains capped at 50KB; Tool Call details keep a bounded retained final answer plus the recent-event window rather than duplicating unbounded child history.

## Testing

The test suite is centralized under `tests/` and uses Node's built-in `node:test`
runner with TypeScript loaded through `tsx`.

```bash
npm run typecheck
npm test
npm run check
```

## Commands

Pi Rail UI registers the following slash commands:

### `/rail-ui`

Toggles the extension on or off for the current UI session.

### `/rail-duplicate`

Duplicates the current session as a sibling session (sharing the same parent).

The new session:
- Inherits all conversation history, compaction records, model changes, and thinking level changes from the source session.
- Shares the same `parentSession` as the source, making it a sibling rather than a child.
- Appears above the source session in `/resume` (sorted by creation time).
- Can be switched to using `/resume <session-id>`.

This is useful for exploring alternative approaches or experimenting with different continuations from the same conversation state.

### `/rail-session`

Shows the current Rail session summary in a Pi-native overlay.

### `/rail-oai-fast`

Toggles Pi 0.84's native OpenAI-compatible priority service tier for the current model:

```text
/rail-oai-fast on|off|status
```

The command temporarily overlays `model.samplingParams.service_tier` and restores the model's original value when disabled, when switching models, and when the session shuts down. It does not maintain a model allowlist or rewrite provider payloads.

It is active for Pi's documented `samplingParams` request paths: `openai-completions`, `openai-responses`, and `azure-openai-responses`. `openai-codex-responses` remains inactive because Pi 0.84.1's Codex builder uses a separate `serviceTier` option and does not forward model `samplingParams`.

### `/rail-oai-search`

Sets the session-local native hosted web-search mode for GPT models:

```text
/rail-oai-search live|cached|off
```

`live` allows external web access, while `cached` restricts the hosted tool to cached content. Eligibility is based on `gpt` appearing in the model ID or display name, regardless of provider. Rail only modifies Responses-shaped payloads, replaces competing local or hosted `web_search` tools for that request, and preserves existing `include` entries while requesting source metadata. Switching to a non-GPT model keeps the selected mode inactive so it resumes automatically after switching back.

For safely wrappable `openai-responses` and `azure-openai-responses` SSE providers, Rail also observes the real hosted `web_search_call` stream and places one activity section inside the corresponding Assistant turn. The section stays invisible until a hosted call is observed, expands while searching, collapses after success, and lists bounded actions and source links; click it or use `Ctrl+O` to expand/collapse it. Completed snapshots are stored as session custom entries and never enter the LLM context. Native extension providers and Codex's default WebSocket transport are intentionally not overridden, so those paths still receive hosted search but show only the final answer.

## Main Features

### 1. Rail-Based Editor Surface

The input editor is rendered as a slate-gray surface with a left rail. Pi's native `CustomEditor` owns wrapping, cursor placement, autocomplete, paste handling, and internal editor scrolling; Rail removes the native horizontal frame, applies `editor.height`, and wraps the remaining native rows with the configured surface:

- Pi's native top/bottom editor borders are replaced by the Rail surface.
- `editor.height.min`, `max`, and `maxRatio` control the visible input window.
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

### 2. Pi-Native Fullscreen Dock

Pi owns the fixed editor/footer dock and independently scrolling transcript. Enable `tuiMode: "fullscreen"` in Pi to use that layout; Rail does not patch the renderer or alternate screen.

The optional Rail footer remains visually lightweight:

- No background block.
- No rail.
- Compact session/context/model information.
- Context percentage shown with two decimals.

### 3. Native Conversation History

Pi's regular/fullscreen renderer owns transcript layout, wheel and page scrolling, prompt navigation, and text selection. Rail installs no competing viewport or general mouse router; fullscreen scrollbar dragging and click-to-position inside visible editor text use narrow Rail input seams. Scrollbar motion only writes the thumb preview directly to the terminal.

### 4. Native Selection and Clipboard

Fullscreen transcript selection and copy use Pi's native TUI behavior, including its word/paragraph selection and autoscroll support. Rail does not enable or disable terminal mouse tracking globally; inside the focused Rail editor, a plain click only remaps the visible native editor row to Pi's cursor position. Rail also redirects Pi's transient `Copied!` confirmation from the top-right flash stack into the Rail footer.

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

### 7. Native Slash Autocomplete

Slash autocomplete stays inside Pi's native editor lifecycle and list implementation. Rail applies the configured selected-text color and keeps its skill-command completion seam, while Pi owns list layout, row limits, focus, cancellation, and rendering.

### 8. Native Settings and Model Selectors

`/settings`, `/model`, and `/models` use Pi's native components and lifecycle. This preserves background model refresh cancellation, selector disposal, focus ownership, and newly added settings such as TUI mode, fullscreen scrollbar, output padding, and Mermaid rendering.

### 9. Tool Execution Layout

Tool, `!bash`, and assistant thinking blocks keep their Rail surfaces, compact previews, and theme-derived colors. Pi's native `Ctrl+O` behavior controls global expansion. In fullscreen mode, a plain single click on a tool, bash, or thinking block toggles only that block (during streaming and after completion); drag selection, links, wheel scrolling, and scroll anchoring remain owned by Pi, while scrollbar-thumb dragging uses Rail's narrow preview/commit seam.

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

Status-like messages have their internal padding normalized so the final visual left edge aligns with the shared app gutter and rail geometry.

## Configuration

Visual tuning lives in:

```text
ui-style.json
```

Important sections:

### `appLayout`

Controls the blank columns kept between the terminal's left edge and the fullscreen transcript and dock (messages, header, loaded resources, status line, widgets, editor, and footer). Rail wraps Pi's layout containers with this gutter instead of re-owning the viewport:

```json
{
  "leftGutterWidth": 1
}
```

### `surfaceLayout`

Controls the shared rail geometry inside the app gutter:

```json
{
  "leftBorder": "▎",
  "leftBorderWidth": 1,
  "borderContentGapWidth": 0
}
```

### `editor`

Controls Rail editor colors, surface geometry, paste-marker styling, and the visible input height. `height.min` is the resting height, while `height.max` and `height.maxRatio` cap growth for long input. `editor.mouseTracking` remains readable for old style files, but mouse/input handling stays native.

### `conversationScroll`

Conversation scrolling is delegated to Pi. The legacy section remains configurable for compatibility, but the extension does not install an app-level viewport or alternate-screen patch:

```json
{
  "mode": "native",
  "enabled": false,
  "alternateScreen": false
}
```

Use Pi's `tuiMode: "fullscreen"` setting for the native fixed editor/footer dock and transcript scrolling. In fullscreen, Rail hides Pi's scrollbar paint path and draws the legacy Rail scrollbar itself: a one-column blue thumb (`editor.rail` / `conversationScroll.scrollbar.thumbBackground`) over a transparent track, shown only while the transcript overflows. During a thumb drag, Rail previews only that thumb; the transcript is committed and rendered once on release.

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

Controls shared behavior and layout metadata for Rail sections. UI rendering stays in the individual renderer/patch files. Pi's native transcript owns text selection, copy, mouse routing, and scroll anchoring; Rail section metadata is used for surfaces, spacing, and collapse presentation.

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

`assistantThinking`, `toolExecution`, and `bashExecution` enable Rail collapse presentation; each defaults to `autoCollapseAfterRows: 20`, so short blocks open by default while long blocks fold automatically. Pi's native `Ctrl+O` action controls the global expanded state, and `clickToToggle: true` enables a narrow fullscreen single-click hook for all three kinds (thinking included, during streaming and after) without replacing Pi's mouse router or selection logic. The selection fields remain compatibility metadata. `spacing.beforeRows` / `spacing.afterRows` insert plain blank rows outside the section content. `scope: "group"` applies leading spacing only to the first item in a consecutive run of the same section kind; this is used by `commandOutput` and `resourceStatus` so `/session` and `/reload` outputs are separated from previous history without adding gaps between every resource/status child.

`selectorOutput` remains in the style schema for compatibility only. Pi's built-in `/settings`, `/model`, `/models`, and editor autocomplete components are used unchanged so selector disposal, focus, and refresh behavior remain native.

### `thinking`, `userMessage`, `slashCommand`, `footer`

These sections control specialized details of the other major UI surfaces. For native editor autocomplete, `slashCommand.selectedText` customizes the selected text color; Pi's `autocompleteMaxVisible` setting and native list layout remain authoritative. Other legacy slash-overlay and `selectorOutput` fields are retained for configuration compatibility.

`footer.bottomGapRows` is retained for configuration compatibility but is not applied to Pi's native fullscreen dock.

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
│   └── utils.ts                     # ANSI, width, and terminal formatting utilities
├── rail/
│   ├── index.ts                     # Rail primitive exports
│   ├── rail-surface.ts              # Shared rail/surface renderers and section-derived surface styles
│   ├── rail-section.ts              # Rail metadata, collapse state, and wrapper helpers
│   ├── render-cache.ts              # Width/signature render cache helper
│   ├── gutter.ts                    # Fullscreen left-gutter container wrapping
│   └── rail-scrollbar.ts            # Legacy Rail scrollbar over the native transcript
└── components/
    ├── editor/
    │   ├── index.ts                 # Editor feature exports
    │   └── rail-editor.ts           # Native CustomEditor surface wrapper and autocomplete styling
    ├── footer/
    │   ├── index.ts                 # Footer feature exports
    │   ├── footer.ts                # Footer stats, layout, cache, and render logic
    │   └── copy-feedback.ts         # Routes fullscreen copy confirmation into the footer
    ├── messages/
    │   ├── index.ts                 # Message feature exports
    │   ├── assistant-message.ts     # Assistant thinking/reply rail patches
    │   ├── user-message.ts          # User message rail card patches
    │   ├── command-output.ts        # Slash command output rail wrapping
    │   └── resource-status.ts       # /reload resources and status/message rail wrapping
    └── executions/
        ├── index.ts                 # Execution feature exports
        ├── bash-execution.ts        # Bash execution rail surface and preview normalization
        ├── tool-execution.ts        # Tool execution rail install/uninstall patches
        ├── execution-click.ts       # Fullscreen single-click execution toggle seam
        └── execution-collapse.ts    # Shared execution auto-collapse helpers
```

## Design Principles

1. **Keep Pi behavior intact**
   The editor remains based on Pi's `CustomEditor`; standard keybindings and input behavior are preserved.

2. **Centralize visual tuning**
   Colors and layout constants should live in `ui-style.json`, not scattered through TypeScript.

3. **Reuse one rail layout/style system**
   Editor, thinking, user messages, and command/tool output share the same rail geometry. Pi's native selectors and fullscreen viewport are not reimplemented by Rail.

4. **Prefer native Pi behavior**
   Rail avoids patching Pi's renderer lifecycle, alternate screen, transcript viewport, mouse selection engine, synchronized output, and selector ownership. Native integration patches are limited to visual components, copy-feedback placement, and one fullscreen click hook that dispatches editor cursor placement or per-block execution toggles only inside their own layout regions.

5. **Optimize hot paths**
   Rail caches component and surface rendering without taking ownership of Pi's native transcript scroll state.

## Performance Notes

The extension includes several optimizations for long sessions:

- Component and surface render caches for long messages and tool output.
- Cached execution previews and width-aware formatting where needed.
- Completed simple tool/bash previews are reused across scroll frames instead of rescanning large arguments or output.
- The fullscreen left gutter reuses its prefixed rows while the transcript content is unchanged between frames.
- The scrollbar thumb paints plain rows with a direct slice and only falls back to full overlay compositing for ANSI-styled rows; the native drag geometry stays untouched.
- While the fullscreen scrollbar is being dragged, Pi's transcript render is suspended; Rail updates only the thumb preview with a narrow terminal write, then commits the scroll position and performs one render on release. A 1000ms inactivity timeout and focus-out seam guard against a lost mouse-up.
- Pi owns transcript layout, viewport, normal scrolling, and native selection performance; Rail's drag state machine only runs on the scrollbar column.
- The Rail scrollbar geometry mirrors Pi's native thumb formula without enabling Pi's native scrollbar paint/timer path.

## Limitations and Caveats

- Visual component patches and the narrow fullscreen copy/click seams depend on selected Pi internals and may need updates when component or mouse-handler shapes change.
- Pi owns fullscreen mode, transcript scrolling, terminal mouse selection, and selector lifecycle. Rail owns only the fullscreen scrollbar column during a drag and plain-click cursor placement inside the focused editor rect; it restores Pi's scrollbar mode/style on uninstall.
- The terminal emulator's own scrollbar (iTerm2 "Save lines to scrollback in alternate screen") is outside the escape-code surface; disable that profile setting if it appears alongside Rail's scrollbar.
- Set Pi's `tuiMode` to `fullscreen` to use its fixed dock and native transcript viewport.
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

### Native transcript behavior

Use Pi's `tuiMode: "fullscreen"` setting and native keybindings for transcript scrolling and selection. Rail does not install a competing chat viewport; its fullscreen scrollbar is a narrow extension-side overlay with a release-time transcript commit.

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
