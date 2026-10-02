<!-- Model-facing text of the subagent tool and the persistent-session roster section. Format: prompts/README.md. -->

## description

Delegate work to other Pi model sessions (helpers). Each call uses exactly ONE mode, chosen by the field you fill:

SINGLE: fill `task` for one helper.
- One-off helper (default; nothing is saved): {"task":"..."}. Add "model":"provider/id" to pick a model; omit it to use your current model.
- New persistent helper you will message again: {"model":"provider/id","alias":"reviewer","task":"..."}
- Follow-up to an existing persistent helper: {"target":"reviewer","task":"..."} (no model, no alias).
- Continue a saved Pi session file: {"session":{"mode":"fork","path":"/path/session.jsonl"},"task":"..."}. fork works on a copy; use exclusive only if the user asks to take over the original. Set cwd to that session's project directory when it differs from the current one.
PARALLEL: fill `tasks` for up to 8 independent helpers shown together in one panel: {"tasks":[{"task":"A"},{"model":"provider/id","task":"B"}]}. Each item takes the SINGLE fields. Do not also set top-level task.
SEPARATE CALLS: if the user wants each helper as its own call or panel, emit several SINGLE subagent tool calls in the same response, e.g. subagent({"task":"security review"}) and subagent({"task":"performance review"}) side by side. They run concurrently; do not wait for the first before emitting the second.
CHAIN: fill `chain` for up to 8 steps run in order, when a step needs the previous step's answer. {previous} in a task is replaced by the previous step's final answer: {"chain":[{"task":"Write a plan"},{"task":"Critique this plan: {previous}"}]}
CONTROL: message a persistent helper that is running right now: {"target":"reviewer","control":{"delivery":"steer","message":"..."}}. steer redirects it before its next model call; followUp queues the message until its current run finishes. No task. Never send a control in the same response that starts the helper.

Rules:
- Leave every unused field out. If you must fill it, use "" for text fields (model, target, alias, task, cwd), null for session/control/contextWindow/fastMode, and [] for tasks/chain. Never placeholders such as "/" or "null".
- Write self-contained tasks: a one-off helper does not see this conversation. A target or forked session keeps its own history.
- contextWindow: omit it for the native default. Set a positive integer only when the user asks for a specific budget, on the single call or on each tasks/chain item.
- fastMode: true only when the user asks for fast mode, on a one-off or new persistent helper (each item in tasks/chain). Ignored on non-GPT models; not allowed with target or control.
- Teams (members coordinated through a shared work ledger, one of them the lead) use the subagent_team tool, never subagent. Helpers cannot call subagent themselves.

## prompt_snippet

Delegate self-contained work to one-off or persistent helper model sessions (single, parallel, chain, or control)

## prompt_guidelines

- Use subagent for bounded, self-contained work worth delegating: code search, focused analysis, review, verification, comparison. Use a one-off helper by default; create a persistent helper (model+alias) only when you expect follow-ups, then continue it with target.
- Start independent helpers at the same time: emit all their subagent calls in one response (one call with tasks for a grouped panel, or several single calls for separate panels). Do not wait for one helper before starting an independent one.
- When the user asks to continue or resume work from a saved Pi session file (.jsonl), call subagent with session {mode:"fork", path} and the task, rather than asking a helper to read the file.
- @agent/<alias> or agent://<alias> in the user message means subagent with target=<alias>. @new/<provider>/<id> or new://<provider>/<id> means a new persistent helper with model=<provider>/<id> and a short alias.
- Keep orchestration in this session. If a helper's answer asks for input or another specialist (for example needs_input or specialist_request), resolve it here, then continue the same helper with target+task.
- A deleted persistent helper (removed in /rail-agent) cannot be continued; a target call to it fails with an unknown persistent subagent error.

## roster_intro

Use the subagent tool with `target` to continue a linked session, or `model` plus `alias` to create one.

## roster_routing_header

Explicit routing from the current user message:

## roster_target

- The user named @agent/{{target}}; you must call subagent with target="{{target}}" and must not substitute another session.

## roster_model

- The user named @new/{{model}}; create a persistent model session with model="{{model}}" and a concise unique alias.

## roster_follow_up

For follow-up work on the same files or topic, prefer the same target instead of creating a new session.
