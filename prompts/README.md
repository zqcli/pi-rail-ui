# Model-facing prompts / 面向模型的提示词

Every instruction text the models see (tool descriptions, prompt snippets/guidelines, system-prompt sections, Team
notices and event messages, compaction instructions) lives here; code reads it with `prompt(file, key, vars?)` and
`promptList(file, key)` from `core/prompts.ts`. Parameter (schema field) descriptions, errors and UI text stay in code.
所有发给模型的指令文本都在这里；字段级描述、错误信息、界面文字仍在代码里。

Files: `apply-patch.md`, `subagent.md`, `team.md`, `gpt-compaction.md`.

`subagent.md#manual_continue` is the editable `/rail-agent` Continue prefill for error/stopped persistent
members. Idle members start blank. This manual new dispatch is distinct from `retry_continuation` (automatic
provider recovery); it takes no error/task placeholders and does not repeat the original task.
`subagent.md#manual_continue` 是 error/stopped persistent 成员的可编辑 Continue 预填文本；idle 默认为空。
它是新的手动 dispatch，与自动 provider 恢复的 `retry_continuation` 分开，不插入旧错误或重放原任务。

## Format / 格式

- `## <key>` starts an entry (`[a-z0-9_.-]+`, unique per file); its body runs to the next `## ` heading or EOF.
  Leading and trailing blank lines are trimmed, everything inside is kept exactly (a one-line text is one line).
- List entries (`promptList`): every non-blank line is `- item`, one item per line.
- Placeholders `{{name}}` (letters, digits, `_`) are filled by `prompt()`; a missing or unknown variable is an error.
- `<!-- ... -->` comments (may span lines) are removed; text before the first `## ` is ignored. Put comments between
  entries, not inside a text body (the blank line they leave stays in the text).

## Override / 覆盖

Copy an entry into `<agent-dir>/rail-prompts/<file>.md` (agent dir = Pi's `getAgentDir()`, honours
`PI_CODING_AGENT_DIR`) and edit it. An override replaces only the keys it defines. A key the default file does not
define, or a different set of placeholders, is an error that names the file and key; there is no silent fallback.
Files are read once per process: restart Pi or `/reload` after editing. Subagents and Team members load the same files.
