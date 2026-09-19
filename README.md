# Pi Rail UI

Pi Rail UI is a local visual extension for the Pi coding agent. It adds a rail-based editor and message surface for long coding sessions while leaving Pi's native renderer, fullscreen viewport, scrolling, selection, and selector lifecycle in charge.

It customizes visual surfaces and tool presentation while preserving Pi's normal editor behavior, keybindings, and native TUI features.

Pi Rail UI requires Pi `0.85.1`. Earlier Pi releases are not supported.

## Highlights

- Slate-gray editor with a thin left rail.
- Rail-styled editor and message surfaces.
- Pi-native fullscreen mode provides the fixed editor/footer dock and the independently scrolling transcript.
- Pi owns mouse selection, scrolling, the scrollbar, and selector lifecycle; Rail installs no scrollbar surface, viewport, or general mouse router.
- Rail collapse presentation follows Pi's native `Ctrl+O` expansion state; single-click tool/bash/thinking toggles and editor cursor placement use Pi's native component `handleMouse` routing.
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

### Rail Subagents

Rail loads its bundled one-off and persistent `subagent` tool automatically from the root extension. Do not install a second standalone `subagent` extension alongside Rail. When upgrading from the previous standalone setup, remove the old symlink and move any non-hidden backup out of the auto-discovered extensions directory before reloading:

```bash
rm -f ~/.pi/agent/extensions/subagent
if [ -e ~/.pi/agent/extensions/subagent.stateless-example ]; then
  mkdir -p ~/.pi/agent/extensions/.backups
  mv ~/.pi/agent/extensions/subagent.stateless-example \
    ~/.pi/agent/extensions/.backups/
fi
```

Reload Pi after installing or updating Rail. Rail does not read `~/.pi/agent/agents` or inherit another subagent plugin's profile prompts/tools. It maps Pi's existing models to independent sessions, and one model can back any number of sessions.

- `@new/cus-resp/gpt-5.6-sol` (or another canonical Pi model reference) to create a persistent model session.
- `@agent/auth-review` to route a follow-up to that exact instance without conflicting with Pi's normal `@path` completion.
- In TUI/RPC input, `@agent/auth-review steer <message>` or `@agent/auth-review followup <message>` directly controls an already-running local persistent child. Rail consumes the input and calls the local control path instead of queueing it to the parent; `followup` maps to `followUp`, and the message must be non-empty. Print/JSON input without UI and extension-injected messages continue through ordinary routing.
- `new://cus-resp/gpt-5.6-sol` and `agent://auth-review` as equivalent transport-safe forms for CLI, print, JSON, and RPC prompts. Pi expands a leading `@...` CLI argument as a file before extensions receive it.
- `/rail-agent` opens one unified TUI overlay with **Current**, **All Persistent**, and **Create / Adopt** tabs. It shows truthful local phases (`starting`, `running`, `queued`, `idle`, `not connected`, `error`) and marks a live foreign lease as **In use elsewhere** rather than guessing whether that process is generating. During native Pi compaction, a local child remains in the `running` phase for control admission but is visibly marked **COMPACTING**. Model and saved-session fields open searchable inline pickers inside the same panel; the create form maps one selected model/thinking level and Fast policy to one independent session, requires a concrete first task for a new persistent agent, and preserves a saved session's cwd when adopting it. `Shift+F` toggles Fast for the create form or an idle/stopped/error persistent agent; active, queued, compacting, foreign-owned, and ownership-unknown agents reject the change. For a locally running agent, `g` opens an inline **Steer** message and `f` queues an inline **Follow-up**.
- `model` plus `task`, without `alias` or `session`, runs a stateless one-off model session and creates no persistent instance or child session. Omitting `model` uses Pi's current model.
- `contextWindow` is an optional per-dispatch local Pi budget. In single mode it is a top-level field; in `tasks` and `chain` it belongs on each item, with no array-level default or inheritance. It must be a positive safe integer; omit it to use the currently selected child model's value immediately before any Rail override. A catalog/registry refresh alone does not force Rail to synchronize that selected object. Values at or below the child's effective `reserveTokens` are rejected while compaction is enabled, and values above model metadata are local budgeting metadata only: they do not raise provider server capacity or change `maxTokens`.
- `fastMode: true` enables Pi's native priority service tier for one stateless GPT dispatch or records that policy when creating/adopting a persistent GPT agent. It is off by default and is not inherited from the parent Pi session. On a non-GPT model the same legal `fastMode: true` is silently ignored instead of failing the dispatch: stateless calls run with Fast off, and new/adopted persistent agents are created with the policy off rather than persisting `true` (so a later switch to GPT cannot enable it implicitly). Only the legal parameter positions tolerate the ignore; a `fastMode` on `target`, grouped, or control calls is still rejected, and a GPT model on an API that Rail cannot rewrite still fails the API eligibility check. Existing persistent targets use their saved policy; change it only through `/rail-agent`, where **FAST inactive** still means the saved policy is retained for a later eligible model. Display never clears that saved policy: a non-GPT target keeps its descriptor value but shows `FAST off`. The Tool Call header and grouped child panels show the effective state for the resolved model and API: `FAST on` only when a saved or explicit policy meets a GPT model on `openai-completions`, `openai-responses`, or `azure-openai-responses`; non-GPT and unknown/unsupported APIs display `FAST off`.
- Stateless dispatches load the standalone Fast helper only for a GPT child model with an active policy, and load the standalone native-search helper pinned to `live` (`-e <rail-oai-search-standalone> --rail-oai-search-mode live`) only for GPT child models. Persistent RPC workers keep those helpers attached to the long-lived child session (search always, Fast when the saved policy is on) and the extensions gate each request internally, so an in-place model switch to a non-GPT or unsupported API stays inactive without a relaunch. Neither path inherits the parent session's `/rail-oai-search` selection. Non-GPT stateless children do not load the Fast/Search helpers; persistent workers retain their helpers but skip injection for non-GPT models. Both display `FAST off · SEARCH off` in dispatch headers and grouped child panels. The parent dispatch header ends with `ContextWindow ... · FAST ... · SEARCH ...`, each grouped child panel repeats its own effective values, and single result panels plus control calls do not repeat them. Search is an internal live policy selected by Rail for eligible GPT children; there is no `search`/`searchMode` parameter, and it never enters the Tool parameters schema or result details.
- Only an explicit stateless `contextWindow` budget loads the child-local context-window helper with `-e`; omitting that budget keeps the existing `--mode json -p --no-session` invocation. Persistent workers prepare and verify the budget through a private handled command, keep it through retries, compaction, and queued follow-ups, then let the helper restore its owned model object at `agent_settled` and confirm cleanup. Omitted persistent dispatches do not send private prepare/reset prompts. A missing helper, model/window mismatch, transport ambiguity, or unconfirmed reset fails closed and retires the persistent worker instead of reusing uncertain state.
- `model` plus `alias` creates a persistent session; `target` continues that exact session. Reusing the same model with another alias creates another independent session.
- Lifecycle choice is continuity-driven: continue a linked helper with `target`; adopt an existing saved session with safe `fork` when its history or project cwd matters (commonly cross-project work); create a new persistent alias only for a concrete initial task that is expected to receive follow-ups; otherwise use stateless one-off delegation.
- Tool guidance tells the parent LLM to proactively use stateless sessions for self-contained code search, focused analysis, verification, comparison, and review, creating a persistent alias only when later follow-ups need the same child context. Independent work that should appear as separate top-level Tool Calls is emitted as multiple sibling `subagent` calls in the same assistant turn so Pi executes them concurrently; the `tasks` array is reserved for one grouped parent Tool Call with multiple child panels. Child sessions cannot recursively call `subagent`; nested orchestration remains in the parent session.
- A live persistent child can be controlled with `{ "target": "auth-review", "control": { "delivery": "steer", "message": "Focus on tests" } }` or `delivery: "followUp"`. `steer` is delivered after the current child assistant turn and its tool calls, before the next model call; `followUp` runs after the current work finishes. Controls never start idle/stopped sessions, cannot address stateless or foreign-owned workers, and should not be emitted as a sibling of the initial dispatch because startup can race.
- If a child asks for input or another specialist in its ordinary final answer, it may use the plain-language labels `needs_input` or `specialist_request`; these are guidance, not a structured wire protocol. The parent remains the sole dispatcher: resolve the question or dispatch the specialist, then continue the original persistent child with `target+task`. This keeps recursion, lineage, cost, cancellation, and single-writer ownership visible in the parent.
- The Subagent Tool Call panel streams the current dispatch's user task, thinking, assistant text, tool-call arguments, and tool results while retaining at most the latest 18 activity events. It consumes Pi 0.85.1's `compaction_start`/`compaction_end` and summarization-retry events, showing an explicit **Compacting** subphase while the child run remains active; compaction summaries are not copied into the parent transcript. While a run is active, a one-line live usage summary stays above the bounded activity and any `earlier activity hidden` marker. A completed run switches to a compact final-answer preview; expanding it shows the retained final assistant answer, recent activity, input/output/cache/context tokens, turns, cost, elapsed time, and stop reason. Parallel and chain calls render one independent child panel per run plus aggregate token, cost, status, and wall-time totals. Only hosted `web_search_call` items that Rail observes on the intercepted Responses SSE stream are counted: when a child executed such calls, its usage line ends with the observed count (`1 search` or `N searches`), and parallel/chain aggregate usage lines sum every child count, while grouped child headers stay usage-free. Searches executed through an untouched native extension provider or Codex's default WebSocket transport are not observed and add no count.
- Persistent child sessions are named `subagent · <parent session> · <alias>` in `/resume`. The creator parent name is stored with the instance; unnamed parents use `<project>-<sessionId prefix>`. Existing managed sessions are renamed safely the next time their leased RPC worker opens. Stateless runs pass `--no-session`, create no JSONL, and never appear in `/resume`.
- Single-writer leases and a per-agent queue so concurrent calls cannot write the same child JSONL session.

The `/rail-agent` safe path defaults to **Safe copy** (`fork`), including sessions already managed by Rail. Use **Current** / **All Persistent** to link and continue an existing agent without copying it. **Exclusive in place** remains an explicit form choice with a warning and must only be used when no other Pi process has that session open. The panel can continue/link an agent, change its model or thinking level while locally controllable, stop its worker while retaining the session, detach it from the current parent while keeping the child JSONL, or permanently delete the Rail descriptor and child JSONL. Permanent deletion deliberately does not scan or rewrite other parent sessions; stale links in those sessions remain and later calls fail as unknown persistent subagents. Sessions active in another TUI are never live-attached or deleted. The former `/agents` and `/subagents` aliases are intentionally not registered.

Instance metadata and leases live under `~/.pi/agent/stateful-subagents/`; each instance stores a model reference rather than an agent profile. Session leases and short-lived alias reservations enforce one writer and globally unique persistent aliases across Rail processes. The full child transcript remains in the child Pi session. Parent tool content remains capped at 50KB; Tool Call details keep a bounded retained final answer plus the recent-event window rather than duplicating unbounded child history.

#### Coordinated teams (opt-in)

Ordinary subagent modes are unchanged. A team has a fixed roster of **one coordinator A and 1–8 workers B**, all with **new, unique persistent aliases** and concrete tasks. Team dispatch does not support stateless sessions, existing `target`, session adoption, `chain`, or parent `control` mode; children still cannot spawn subagents.

First call `subagent_team` to prepare:

```json
{"action":"prepare","coordinator":"A","workers":["B1","B2"]}
```

Then replace `<teamId>` with the returned id and emit the following as **two sibling `subagent` tool calls in the same assistant turn**, not sequential calls and not one combined `tasks` array. A is single; all prepared Bs belong in the grouped call. `teamId` is top-level in both. These examples omit `model` to use the current Pi model; choose fresh aliases for each team.

```json
{"teamId":"<teamId>","alias":"A","task":"Coordinate B1/B2's read-only review. Await all worker outcomes with team finish, then summarize findings and failures."}
```

```json
{"teamId":"<teamId>","tasks":[{"alias":"B1","task":"Review implementation correctness without edits. Report findings to A."},{"alias":"B2","task":"Review test coverage without edits. Report findings to A."}]}
```

Children use the `team` tool; sender and team are supplied by the runtime, not arguments:

| Action | Example arguments / meaning |
| --- | --- |
| `send` | `{"action":"send","to":"B2","message":"Please check the error path."}` — message a teammate. |
| `report` | `{"action":"report","message":"Blocked; need scope clarification.","wait":{"kind":"message"}}` — report to A and atomically wait for a reply; omit `wait` to report without waiting. |
| `wait` | `{"action":"wait","wait":{"kind":"member","member":"B2"}}` — await a member's terminal outcome. Use `{"kind":"message"}` for inbox messages or, for A only, `{"kind":"workers"}` for all worker outcomes. |
| `control` | A only: `{"action":"control","to":"B1","command":"pause"}`; `resume` clears the pause. `redirect` also requires `message` and replaces a pending wait with the new direction, but does not clear an explicit pause or undo work. |
| `finish` | `{"action":"finish"}` — completion intent, not a terminal result. A waits for all workers; a worker must still produce its final answer. |

**`wait`, `report` with `wait`, and `finish` must each be the sole tool call in their assistant batch**, never alongside another tool. Use event-driven waits, not polling. Self-waits, unknown members and dependency cycles are rejected.

- Scheduling allows **four active worker permits plus independent A admission**. Waiting/paused workers release permits but retain their sessions; neither cooperative waiting nor pausing ends the enclosing parent Tool Call. A running member first shows `PAUSE REQUESTED`, then `PAUSED` at a safe point; in-flight model/tool/compaction work may finish. This is not an immediate process freeze or rollback. Redirected directions enter the model at its next native context gate; resuming does not rewrite already prepared provider payloads or tool arguments.
- A's final summary is generated only after every worker has a native terminal outcome, including failures—not merely a `report` or `finish` claim. If A settles early, its parent call stays pending and a final-summary continuation receives the complete worker result snapshot. Worker failure normally allows others to finish; coordinator failure or cancellation stops the team and may prevent a successful summary.
- The team deadline defaults to **one hour from prepare** (`timeoutSeconds`, positive, at most `86400`). All members must join within **30 seconds of the first join**; serial dispatch can therefore fail startup admission. Inspect with `subagent_team` arguments `{"action":"status","teamId":"<teamId>"}` (omit id to list), or cancel with `{"action":"cancel","teamId":"<teamId>","reason":"Stop this review"}`. Aborting either parent dispatch cancels the team. Reload marks unfinished history `interrupted`; it does not restore pending Promises or automatically resume work.
- Status appears in existing Tool Call output/panels, not a new standalone GUI overlay. Inbox/history and summary snapshots are bounded: a parent session retains at most 32 teams, messages are limited to 8 KiB, capacity overflow is rejected, and old event history may be dropped. Summary snapshots retain at most 16 KiB of each worker's output with an explicit truncation marker. Put large artifacts in files and send paths plus concise findings rather than relying on messages or summaries as full transcripts.
- Local real-Pi RPC tests with a synthetic provider exercise coordination and settlement; they do **not** establish real external-model decision quality.

## Testing

The test suite is centralized under `tests/` and uses Node's built-in `node:test`
runner with TypeScript loaded through `tsx`.

```bash
npm run typecheck
npm test
npm run check
```

The project pins the four Pi devDependencies to exactly `0.85.1`, and `npm run check` verifies the code against those local dependencies. For a version-matched interactive run, start `node node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`; if you use the global `pi` CLI instead, install the same `0.85.1` and start a new process. `/reload` reloads the extension inside the currently running process and does not upgrade that runtime, so an older global install never switches an existing session. Rail does not auto-upgrade the global CLI.

## Commands

Pi Rail UI registers the following slash commands:

### `/rail-ui`

Toggles the extension on or off for the current UI session.

### `/rail-oai-compaction`

Controls the global GPT Remote Compaction v2 switch:

```text
/rail-oai-compaction
/rail-oai-compaction on
/rail-oai-compaction off
```

With no argument, the command shows the current state and, in TUI mode, a menu titled with that state. The `on`/`off` choices are also available through slash-command completion. The setting is stored under `getAgentDir()/rail-gpt-compaction/settings.json`, defaults to `off`, and is shared by TUI, RPC, JSON, and Rail child processes. The previous `/rail-gpt-compaction` name is not kept as an alias; only the persisted settings path keeps the old `rail-gpt-compaction` directory name. Remote compaction is enabled only for GPT-named `openai-responses` and `openai-codex-responses` models; Azure OpenAI Responses is deliberately not in the v2 support scope until its endpoint, query, and authentication behavior are covered by a matching implementation. Unsupported models keep Pi's native compaction. When this global switch is `on`, a production stateless GPT dispatch loads the standalone compaction helper and uses a temporary session only for that invocation; the directory is removed on success, setup failure, or child-process failure. With the switch `off`, or for non-GPT models, stateless dispatch remains Pi's normal `--no-session` path. Persistent RPC workers always load the helper, whose hooks remain inactive while the switch is off.

Running the command (`on` or the no-arg menu) on a non-GPT or missing model is rejected before the menu opens: it prints the shared GPT-only warning and writes no global setting. `off` is available regardless of the active model and retains the existing native-repair safety checks. GPT models on an API outside the v2 scope still follow the original behavior — the command succeeds, the setting is saved, and the status reads `GPT compact: native (inactive — …)`. A non-GPT model instead shows plain `GPT compact: native`.

### `/rail-duplicate`

Duplicates the current session as a sibling session (sharing the same parent).

The new session:
- Inherits all conversation history, compaction records, model changes, and thinking level changes from the source session.
- Shares the same `parentSession` as the source, making it a sibling rather than a child.
- Appears above the source session in `/resume` (sorted by creation time).
- Can be switched to using `/resume <session-id>`.

This is useful for exploring alternative approaches or experimenting with different continuations from the same conversation state.

`/rail-duplicate` is intentionally **not** equivalent to Pi's native `/clone`: `/clone` extracts the current active branch into a new child session and switches to it immediately, while `/rail-duplicate` stays in the current session and creates a sibling that shares the same `parentSession` (the new file is not a child of the source).

### `/rail-session`

Shows the current Rail session summary in a Pi-native overlay.

### `/rail-oai-fast`

Toggles Pi 0.85.1's native OpenAI-compatible priority service tier for the current model:

```text
/rail-oai-fast on|off|status
```

The command sets a session-local policy that Rail applies to each outgoing provider payload through Pi's `before_provider_request` hook: an eligible payload is returned as a copy with `service_tier: "priority"` added. Rail never mutates `model.samplingParams`, so the model's original sampling parameters are preserved exactly and the policy survives model switches, provider re-registration, and retries. Session shutdown clears the policy without any model-restore step. Eligibility is GPT-only for the parent session and for Rail children alike: the model must be a GPT model on `openai-completions`, `openai-responses`, or `azure-openai-responses`, and a non-GPT model stays inactive no matter which supported API it uses. `openai-codex-responses` stays inactive because Rail does not rewrite Codex requests. There is no parent-only API scope: switching to a non-GPT model or an unsupported API stops injection, and switching back to a GPT model on a supported API resumes injection without re-running the command.

The `on` and `status` commands are GPT-only and are rejected with the shared warning `Cannot enable Rail OpenAI features for the current model: GPT models only.` when the active model is non-GPT or missing; the rejection leaves the existing policy unchanged. If it was off, switching to GPT later does not enable it. `off` is always allowed so a stale policy can be cleared on any model. A GPT model on an unsupported API keeps the original inactive behavior (status and footer show `FAST (inactive)` / `FAST inactive`), while a non-GPT model hides the footer label entirely instead of advertising a policy it can never use.

Rail Subagents use the same native mechanism through `fastMode: true`. Subagent Fast applies before the child model's first provider request, and is a dispatch/persistent-agent policy rather than an implicit inheritance of the parent's current command state. A legal `fastMode: true` on a non-GPT model is silently ignored instead of becoming a validation error: stateless and new/adopted dispatches are normalized to off before they reach the runner or broker, so the value is never persisted and cannot implicitly enable Fast later. GPT models keep the native API eligibility check and normal `FAST on`/`FAST off` display. The standalone `--rail-oai-fast-enabled` flag, the parent's `/rail-oai-fast` toggle, and an in-place child model switch all run through the same GPT eligibility check, so status, footer, and the request hook always agree.

The `/rail-oai-fast` and `/rail-oai-search` commands and remote compaction all share one GPT rule: a model is GPT when its id or display name contains an independent, case-insensitive `gpt` token, such as `gpt-5.6-sol` or `GPT 5.6`; substrings such as `gptx` do not match, and the provider id is never considered. Each feature still applies its own supported-API scope on top of that shared decision. They also share one command-time guard (`commands/rail-oai-command.ts`) plus the `openai/model-eligibility.ts` `isGptModel` check, so Fast, Search, and compaction produce the same GPT-only rejection instead of three drifting variants.

### `/rail-oai-search`

Sets the session-local native hosted web-search mode for GPT models:

```text
/rail-oai-search live|cached|off|probe
```

`live` allows external web access, while `cached` restricts the hosted tool to cached content. Enabling (`live`, `cached`, or `probe`) is rejected with the shared warning `Cannot enable Rail OpenAI features for the current model: GPT models only.` when the active model is non-GPT or missing; eligibility is checked before and after the idle wait; a rejection leaves the mode, probe flag, and capture lease unchanged. `off` is always allowed. On a non-GPT model the footer hides the stale mode instead of showing an inactive policy. Eligibility is decided by a non-empty API and a GPT name, and the API check is a blocklist rather than an allowlist: a missing or blank API id stays inactive, the built-in non-Responses APIs (`openai-completions`, `anthropic-messages`, `mistral-conversations`, and similar) stay inactive, but any other API id — including custom ones such as `cus-resp` and Codex's `openai-codex-responses` — remains eligible. A GPT model on one of those non-eligible APIs keeps the original inactive behavior. The GPT match is an independent `gpt` token in the model ID or display name, not an arbitrary substring. Because Rail only rewrites Responses-shaped payloads, an eligible custom API still has to receive a Responses-shaped request; Codex is eligible for injection but its default WebSocket transport is not observed, so it contributes no search count. Rail replaces competing local or hosted `web_search` tools for that request and preserves existing `include` entries while requesting source metadata. Switching to a non-GPT or inactive model keeps the selected mode inactive so it resumes automatically after switching back.

`probe` is a one-shot diagnostic mode: it switches to `live`, requires the next eligible Responses request to call hosted `web_search`, then immediately returns to normal `live`/`auto` behavior. It is intended to verify provider injection and the activity panel without changing regular search semantics.

The mode is session-local. Rail child processes never inherit the parent's slash state: GPT stateless dispatches and persistent RPC workers launch the standalone search extension with `--rail-oai-search-mode live`, so an eligible child always begins in `live` even while the parent is `cached`, `off`, or probing. Stateless children with a non-GPT model do not load the helper at all, and persistent workers gate it per request after an in-place model switch. Child dispatch headers and grouped child panels show the effective policy as `SEARCH on` or `SEARCH off` after `ContextWindow`/`FAST`; a non-GPT child shows `FAST off · SEARCH off`, and single result panels and control calls omit it. The GPT/API eligibility above still governs whether the hosted tool is actually injected. Search is an internal live policy selected by Rail rather than a Tool parameter: there is no `search`/`searchMode` field, and it adds nothing to the Tool parameters schema or result details.

For safely wrappable `openai-responses` and `azure-openai-responses` SSE providers, Rail also observes the real hosted `web_search_call` stream and places one activity section inside the corresponding Assistant turn. The section stays invisible until a hosted call is observed, expands while searching, collapses after success, and lists bounded actions and source links; click it or use `Ctrl+O` to expand/collapse it. Finalized snapshots (completed, failed, or cancelled) are stored as session custom entries and never enter the LLM context. Each finalized snapshot is also forwarded as a Pi `entry_appended` event, so the parent subagent usage line counts exactly the `web_search_call` items the child executed; the display-only SEARCH policy and answer citations never contribute to that count. Native extension providers and Codex's default WebSocket transport are intentionally not overridden, so those paths still receive hosted search but show only the final answer.

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
- Pi's animated working indicator stays on its own native row; the Rail footer no longer duplicates a ready/working status label.

### 3. Native Conversation History

Pi's regular/fullscreen renderer owns transcript layout, wheel and page scrolling, prompt navigation, text selection, and the scrollbar. Rail installs no competing viewport, scrollbar, or general mouse router.

### 4. Native Selection and Clipboard

Fullscreen transcript selection and copy use Pi's native TUI behavior, including its word/paragraph selection, autoscroll support, and the transient `Copied!` flash. Rail neither enables nor disables terminal mouse tracking globally and does not redirect copy feedback. Inside the focused Rail editor, `RailEditor.handleMouse` remaps the visible native editor row to Pi's cursor position and delegates the rest to Pi's native editor handling.

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

Slash autocomplete stays inside Pi's native editor lifecycle and list implementation. Rail applies the configured selected-text color and keeps one narrow confirm seam for skill commands and Rail commands that require arguments, while Pi owns list layout, row limits, focus, cancellation, and rendering.

### 8. Native Settings and Model Selectors

`/settings`, `/model`, and `/models` use Pi's native components and lifecycle. This preserves background model refresh cancellation, selector disposal, focus ownership, and newly added settings such as TUI mode, fullscreen scrollbar, output padding, and Mermaid rendering.

### 9. Tool Execution Layout

Tool, `!bash`, and assistant thinking blocks keep their Rail surfaces, compact previews, and theme-derived colors. Pi's native `Ctrl+O` behavior controls global expansion. In fullscreen mode, a plain single click on a tool, bash, or thinking block toggles only that block (during streaming and after completion) through Pi's native component `handleMouse` routing; drag selection, links, wheel scrolling, scroll anchoring, and the scrollbar are owned by Pi. When Rail toggles a section, it calls the native `ScrollView.scrollTo()` to keep the clicked block in place; Pi persists the scroll state.

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

Conversation scrolling and the scrollbar are delegated entirely to Pi. The legacy `conversationScroll` style section and the Rail scrollbar were retired in the 0.85.1 native-only update; old style files that still carry the block are read without error, and the keys are ignored.

Use Pi's `tuiMode: "fullscreen"` setting for the native fixed editor/footer dock and transcript scrolling. Pi renders its own scrollbar over the transcript using its theme `scrollbarTrack` / `scrollbarThumb` tokens; track clicking and thumb dragging scroll in real time, and a clickable `Jump to latest message` label restores follow-end while scrolled away from the end.

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

Controls shared behavior and layout metadata for Rail sections. UI rendering stays in the individual renderer files. Pi's native transcript owns text selection, copy, mouse routing, and scroll anchoring; Rail section metadata is used for surfaces, spacing, and collapse presentation.

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

`assistantThinking`, `toolExecution`, and `bashExecution` enable Rail collapse presentation; each defaults to `autoCollapseAfterRows: 20`, so short blocks open by default while long blocks fold automatically. Pi's native `Ctrl+O` action controls the global expanded state, and `clickToToggle: true` enables single-click toggling for all three kinds (thinking included, during streaming and after) through Pi's native component `handleMouse` routing without replacing its mouse router or selection logic. The selection fields remain compatibility metadata. `spacing.beforeRows` / `spacing.afterRows` insert plain blank rows outside the section content. `scope: "group"` applies leading spacing only to the first item in a consecutive run of the same section kind; this is used by `commandOutput` and `resourceStatus` so `/session` and `/reload` outputs are separated from previous history without adding gaps between every resource/status child.

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
│   └── gutter.ts                    # Fullscreen left-gutter container wrapping
└── components/
    ├── editor/
    │   ├── index.ts                 # Editor feature exports
    │   └── rail-editor.ts           # Native CustomEditor surface wrapper and autocomplete styling
    ├── footer/
    │   ├── index.ts                 # Footer feature exports
    │   └── footer.ts                # Footer stats, layout, cache, and render logic
    ├── messages/
    │   ├── index.ts                 # Message feature exports
    │   ├── assistant-message.ts     # Assistant thinking/reply rail wrappers
    │   ├── user-message.ts          # User message rail card wrappers
    │   ├── command-output.ts        # Slash command output rail wrapping
    │   └── resource-status.ts       # /reload resources and status/message rail wrapping
    └── executions/
        ├── index.ts                 # Execution feature exports
        ├── bash-execution.ts        # Bash execution rail surface and preview normalization
        ├── tool-execution.ts        # Tool execution rail surface wrapper
        ├── execution-presentation-policy.ts  # Execution preview/collapse policy
        ├── execution-rail.ts        # Shared execution rail rendering
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
   Rail avoids patching Pi's renderer lifecycle, alternate screen, transcript viewport, mouse selection engine, synchronized output, copy feedback, or selector ownership. Mouse interactions go through Pi's public component `handleMouse` seam; the helpers `dispatchMouseEvent`/`retargetMouseEvent` are internal to `pi-tui` and are not exported from its package root, so Rail never imports them directly. Rail still depends on selected Pi internals where no public seam exists: bundled constructor identity resolution (`core/patching`) and visual render decorators for messages and executions. Hosted search separately uses Pi's public payload and provider-registration seams for bounded Responses SSE observation.

5. **Optimize hot paths**
   Rail caches component and surface rendering without taking ownership of Pi's native transcript scroll state.

## Performance Notes

The extension includes several optimizations for long sessions:

- Component and surface render caches for long messages and tool output.
- Cached execution previews and width-aware formatting where needed.
- Completed simple tool/bash previews are reused across scroll frames instead of rescanning large arguments or output.
- The fullscreen left gutter reuses its prefixed rows while the transcript content is unchanged between frames.
- Pi owns transcript layout, viewport, scrolling, selection, and the native scrollbar; Rail keeps no scroll state of its own.

## Limitations and Caveats

- Visual message/execution render decorators and bundled-constructor resolution depend on selected Pi internals and may need updates when component shapes change; copy feedback is Pi's native flash, with no Rail copy seam remaining.
- Pi owns fullscreen mode, transcript scrolling, terminal mouse selection, the scrollbar, and selector lifecycle. Rail owns only the Rail surfaces and their collapse presentation; it no longer patches the scrollbar or viewport input path.
- The terminal emulator's own scrollbar (iTerm2 "Save lines to scrollback in alternate screen") is outside the escape-code surface; disable that profile setting if it appears alongside Pi's fullscreen scrollbar.
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

Use Pi's `tuiMode: "fullscreen"` setting and native keybindings for transcript scrolling, the scrollbar, and selection. Rail does not install a competing chat viewport or scrollbar; Pi renders its own scrollbar and Jump-to-latest indicator over the fullscreen transcript.

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
