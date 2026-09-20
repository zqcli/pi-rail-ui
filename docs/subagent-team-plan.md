# Subagent Team v1 — development plan and acceptance contract

> Historical initial implementation contract and Pi 0.85.1 acceptance record. The current Pi 0.86.0 integration and its 832-test gates are documented in [the Team migration report](subagent-team-pi-0.86.0.md); the original results below are not presented as current-version validation.

## Workspace and execution rules

- Base: `b93d171` on `feat/subagent-panel-layout`.
- Implementation worktree: `/Users/zzq/Develops/pi-rail-ui-team-dev`; branch `feat/subagent-team-coordination`.
- Do not edit the original worktree, Pi packages, global settings/models/credentials or existing sessions.
- Implementation helpers: `cus-resp/gpt-6-astra:medium`, grouped parallel dispatches with exclusive file ownership. The parent owns integration, protocol decisions, review, verification and commits.
- No helper may commit, stash, reset, checkout, change other helpers' files or wait indefinitely for another helper. Report interface gaps immediately; temporary compile failures while interfaces land are not permission to modify another owner's files.
- Keep native Pi agent loop, RPC, event bus, session writer, compaction and settled contracts. No recursive subagent tool in children. No new dependency, socket service, OS process suspension or simulated pause via abort.
- New team behavior is opt-in. Ordinary single/stateless/persistent/parallel/chain/control, Fast/Search policy, contextWindow and existing result caps stay unchanged.

## Product scope

A parent prepares one fixed team (one coordinator plus 1–8 workers), then launches two sibling calls: a single coordinator and a grouped parallel worker call. Both remain pending while their participants wait. Coordinator receives milestone/blocked/result events, can send directions, pause/resume workers and wait without polling. Workers can exchange messages, atomically report-and-wait, or wait for another member's terminal result. Coordinator's final response must be produced after the complete worker result snapshot is available.

Team v1 uses **new persistent RPC sessions only**. No target/adopt/chain/control team attachment, dynamic members, remote machines or seamless process-restart recovery. Team metadata does not enter model references or persistent agent descriptors. Existing plain RPC workers may load an inert team helper, but it exposes no active team capability until explicitly bound to a dispatch.

## Public surface

- Parent tool `subagent_team`: `prepare`, `status`, `cancel`. Prepare takes `coordinator` alias and `workers` aliases; returns a generated team id. Optional positive `timeoutSeconds` (default one hour, max one day) bounds the team; admission of both dispatches has a separate 30-second deadline starting at the first successful join. Null/omitted optional arguments retain defaults.
- Existing `subagent` gains optional nullable `teamId` only at the top level. Single call alias must be the prepared coordinator; parallel call aliases must exactly match the prepared workers. Team mode requires concrete tasks and new persistent sessions, and both calls must execute as parallel siblings. Reject incompatible modes before side effects. Ordinary schemas and lifecycle behavior remain compatible.
- Child-only tool `team`: actions `send`, `report`, `wait`, `control`, `finish`. The runtime binds sender/team/epoch/role; LLM cannot choose a sender. Control is coordinator-only and limited to `pause`, `resume`, `redirect` within this team. `report` may include a wait condition to atomically report and wait. Waiting conditions: next inbox message, named member terminal, all workers terminal. No periodic model polling.
- A private versioned child extension command carries bind/reply/unbind frames over native RPC prompt. It returns immediately after applying the frame, never waits for agent idle. A custom entry ACK verifies application; RPC prompt success alone is insufficient.

## Architecture and interface ownership

1. `team-protocol.ts`: pure wire types, constants, bounded parsing, extension path. Owned initially by parent, then frozen during parallel work.
2. `team-hub.ts`: parent-owned team state, membership, durable event callback, bounded mailboxes, request de-duplication, waits, cycle checks, cooperative permits, cancellation, result barrier. No Pi imports or workers.
3. `team-extension.ts`: child helper and tool. Uses `pi.appendEntry` for outbound protocol, private command for inbound replies; abort-aware promises. Native context/tool lifecycle gates are verified before claiming pause semantics. Never directly writes a session file.
4. `team-rpc.ts`: application-ACK command adapter, private protocol subscription and per-send binding. Keep it separate from ordinary user `steer`/`follow_up` queues and delivery poison semantics.
5. `team-runner.ts` + existing broker/tool/index seams: own logical team run across native settled boundaries. Hold the broker's per-agent operation while a coordinator waits/continues, preserving single writer and preventing unrelated work insertion. Aggregate usage across actual native continuations; restore temporary context budget only at each native settled boundary.
6. Team tool/status renderer and ordinary transcript integration: bounded live team state. Native activity (compacting/retrying) is distinct from cooperation state. Never place transport binding secrets in model prompts or public results.

## Protocol requirements

- Every request has version, request id, and a runtime-minted binding (team id, member id, epoch, role). Parent derives sender from its worker binding, not untrusted entry fields. Strict limits on message bytes, recipients and mailbox length; reject overflow rather than silently lose required control/results.
- Events have monotonic team sequence numbers. Register waits and check current state/mailbox atomically; events arriving before wait must not be lost. Requests retry idempotently within a bounded run cache. ACK means applied/delivered, not that an LLM understood the instruction.
- Parent journals meaningful team events through its own Pi custom entries. Child custom entries are written only by the child's extension. On parent restart/reload, old nonterminal teams are shown as interrupted; old bindings are rejected. No promise of resuming an old JS Promise or replaying arbitrary filesystem side effects exactly once.
- The private inbox command must be uniquely discoverable; missing helper/version, ambiguous commands, bad binding or unknown delivery fails closed and retires/cancels affected work.
- All team subscriptions, timers and waiters are abort-aware and cleaned on terminal state, disposal and parent shutdown. No unhandled promise rejection.

## Scheduling and pause semantics

- Existing non-team MAX_CONCURRENCY=4 remains unchanged. Team mode starts bounded member processes independently (max 8 workers + coordinator) and limits **active work**, not whole dispatch lifetime. Coordinator has independent admission; paused/waiting workers release an execution permit while retaining their session lease.
- A safe-point checkpoint before a native model turn grants a permit only when joined, not manually paused and dependencies allow execution. At a wait-only team tool or settled turn, release the permit. No release while unrelated tools in the same child batch are still active: wait/report-and-wait must be sole tool calls in their batch or be rejected.
- Pause request is `pause_requested` until a verified safe point. In-flight provider calls/tools/compaction may finish; do not claim immediate freeze or rollback. Once `paused`, no new work is admitted. Resume messages use the independent control path and can wake a paused waiter.
- Dependency readiness does not override an explicit pause. Redirect replaces the target's current pending wait and queues a new direction; it does not undo filesystem effects. Directions enter the model at its next native context gate. Already prepared provider payloads or tool arguments are not rewritten on resume; pause is not a transactional rollback/replan facility.
- Detect self-wait, unknown members and explicit dependency cycles; dependency failure wakes waiters with a failure result rather than hanging.

## Completion and failure

- Worker terminal results come from actual native settlement/errors, not self-reported prose. `finish` is intent; a report is not terminal. Every prepared worker gets an outcome including startup failure/cancellation.
- A coordinator `finish`/all-workers wait receives a sealed result snapshot only after all workers are terminal. It then generates its summary. If it naturally settles early, keep its outer dispatch pending, event-wait for workers, then run one final-summary continuation with that snapshot; never busy-reprompt it. Final answer must be generated after delivery of the result barrier, not merely held back until then.
- Worker failures default to best-effort completion of remaining workers; coordinator sees failures and summarizes partial outcomes. Coordinator failure or user/team cancellation stops new work and aborts/cleans remaining participants. Exceptional cancellation cannot promise a successful coordinator summary.
- Finalized members cannot be resumed; late messages from old epochs cannot resurrect work.

## Frozen TypeScript seams for parallel implementation

`team-protocol.ts` is parent-owned. Helpers import its wire types without changing it; report needed changes.

Core exports `TeamHub` with constructor options `{ onSnapshot?: (snapshot: TeamSnapshot) => void; startupTimeoutMs?: number; now?: () => number }` and methods:

```ts
prepare(input: { coordinator: string; workers: string[]; timeoutSeconds?: number }): TeamSnapshot;
join(teamId: string, memberIds: string[]): TeamBinding[]; // atomic fixed-roster claim; no waiting
request(binding: TeamBinding, request: TeamRequest, signal?: AbortSignal): Promise<TeamReply>;
complete(binding: TeamBinding, outcome: TeamOutcome): void;
waitForWorkers(binding: TeamBinding, signal?: AbortSignal): Promise<TeamSnapshot>;
get(teamId: string): TeamSnapshot;
list(): TeamSnapshot[];
signal(teamId: string): AbortSignal;
subscribe(listener: (snapshot: TeamSnapshot) => void): () => void;
cancel(teamId: string, reason?: string): void;
restore(snapshots: readonly TeamSnapshot[]): void; // nonterminal becomes interrupted, no live bindings
// request checkpoint waits for full roster admission and a permit; waits/finish release permit.
// coordinator finish/waitForWorkers obtains finalizing state only after all workers terminal.
dispose(): void;
```

Child adapter exports `TeamRpcConnection` from `team-rpc.ts`:

```ts
constructor(transport: RpcTransport, channel: TeamWorkerChannel, signal?: AbortSignal);
bind(): Promise<void>; // subscribe before command, validate helper/version, app-level ACK
close(): Promise<void>; // unbind, dispose listener, settle outstanding work; idempotent
```

Host adds optional `team?: TeamWorkerChannel` to WorkerSendOptions and optional `team?: TeamDispatchChannel` to DispatchRequest. `RpcSessionWorker.send` binds before native prompt and closes at settlement/failure. The broker keeps the entire optional afterRun/continuation loop inside its existing enqueue operation; normal requests remain a single send. `afterRun` may await workers and return one final-summary prompt without returning the outer dispatch. No other target run can enter the gap. Team command delivery uses the connection's transport directly, not worker.send/control.

The host may use a small `TeamRunManager`/factory in team-runner.ts to wire Hub channels and afterRun callbacks. TeamRpcConnection.close must preserve the original send error if cleanup also fails; unknown bind/delivery must fail closed, not start an ordinary prompt with a private command as user text.

## Development slices / parallel ownership

### Slice 0 — specification and native probes (parent)
- Create worktree/install locked dependencies offline; freeze protocol and this contract.
- Verify real Pi RPC can receive private command while a child tool waits; custom entries reach parent before settlement; command-side application ACK and abort-aware native gate behave as specified.
- Any unsupported native gate is a blocker to advertised hard pause; adjust implementation to verified safe point without patching Pi.

### Slice 1 — parallel implementations
- Helper Core: `team-hub.ts`, `tests/subagent/team-hub.test.ts` only.
- Helper Child: `team-extension.ts`, `team-rpc.ts`, `tests/subagent/team-extension.test.ts`, `tests/subagent/team-rpc.test.ts`, dedicated fixtures only.
- Helper Host: `team-runner.ts`, `team-tool.ts`, existing `tool.ts`, `session-broker.ts`, `rpc-worker.ts`, `worker-factory.ts`, `index.ts`, dedicated host tests and related existing tests only.
- Parent: shared protocol, independent integration probes/tests, documentation, final UI review. Helpers report interface mismatches; parent resolves rather than overlapping edits.

### Slice 2 — integration and review
- Wire team admission, worker permits, cancellation and finalization; keep original session/lease behavior.
- Verify missing peer admission fails with explanatory error instead of deadlock under serial execution.
- Add concise bilingual usage examples and accurately document pause/cancellation/restart limitations.
- Independent read-only review of completion, permissions, abort and protocol failure paths.

## Acceptance standards

1. Prepare yields fixed unique roster; duplicate/unknown/unauthorized joins fail before spawning side effects.
2. Two sibling calls produce A and B1–B8; normal Subagent calls retain previous behavior.
3. B1 sends message to A/B2 while their outer calls are pending; report-and-wait cannot lose an immediately returned instruction.
4. With four worker permits, B1 waits for B8 and B8 can execute. No wait consumes a model request or polls state.
5. Pause during in-flight work reports requested until safe; confirmed pause prevents new requests/tools; resume is processed while paused. Same-batch wait/tools cannot deadlock.
6. Dependency failure/self-cycle/missing peer/deadline all resolve clearly without leaving pending calls or leases.
7. A cannot return a successful final result before every B is terminal; final summary uses the complete worker snapshot and native usage is aggregated correctly.
8. Worker errors, coordinator errors, user abort, transport loss, parent shutdown/reload clean all waiters/listeners/timers. Old epoch messages are rejected.
9. Child has no recursive subagent tool and cannot forge coordinator control. Fast/Search/contextWindow behavior remains unchanged.
10. UI clearly shows WAITING(reason), PAUSE REQUESTED, PAUSED, FINALIZING, terminal failures and bounded messages; no fake completed/idle states or protocol data leaks.
11. Journals use native writers and have bounded individual entries. Interrupted team history is readable but never automatically resumed.
12. Unit + fake worker + real local Pi RPC/provider fixtures prove behavior. External live-model smoke only if appropriate, with synthetic nonsecret tasks; clearly distinguish local verified results from any missing live-provider evidence.

Required final gates in the new worktree:

```sh
npm_config_offline=true npm run check
PI_SUBAGENT_DEPTH=1 npm_config_offline=true npm test
git diff HEAD --check
```

Commit verified logical slices locally only. Deliver worktree/branch, commits, actual tests and remaining limitations. No push.

## Implemented validation and boundaries

- Core coverage includes fixed admission, four execution permits, B1 waiting for initially queued B8, role checks, replay/old-epoch rejection, bounded inbox/results, atomic report-and-wait, explicit dependency cycles, deadlines, journal failure and interrupted history. The per-parent history capacity is 32 teams; overflow is an explicit error, not silent eviction of active work.
- Native child probes use the installed Pi 0.85.1 RPC process. They cover an immediate private command while a tool is parked, application ACKs, live command conflicts, nullable arguments, same-batch rejection, native context/tool/provider gates, abort and late callbacks. A loopback HTTP provider confirms that a parked provider gate does not send a request. Checkpoints at tool/provider gates do not consume inbox messages; only the context gate does, preventing a pre-generated wait from losing its wakeup.
- Registered parent-tool integration starts real child processes with a deterministic offline provider: 1A+8B message/dependency flow and finalization, coordinator pause-confirm/redirect/resume, cancellation and lease cleanup, no provider polling while parked, native automatic retry, and native threshold compaction under a temporary 64K window followed by reuse at 128K. The compaction fixture supplies a synthetic summary through the native extension hook; it does not validate an external summarization service or every overflow/retry interleaving.
- Independent review found and regression-tested invalid unjoined calls cancelling an active team, fractional deadline wire mismatch, and startup-paused members missing from the panel. Forced RPC shutdown now waits for the child exit acknowledgement before releasing ownership.
- Final gates in this worktree: `npm_config_offline=true npm run check` passed typecheck and **686/686 tests**; `PI_SUBAGENT_DEPTH=1 npm_config_offline=true npm test` passed **686/686 tests**; `git diff HEAD --check` passed. Local logs: `/tmp/rail-team-final-check.log` and `/tmp/rail-team-final-depth.log`.
- This is automated handler/RPC/renderer coverage, not an interactive terminal or external live-model smoke. Model coordination quality, external gateways, and adversarial OS/tool side effects are not implied by these tests. No Pi package, global configuration, credential, original worktree or installed extension was modified as part of the feature implementation.
