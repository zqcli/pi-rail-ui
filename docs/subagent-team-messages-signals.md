# Team messages and phase signals

Two additions to the existing v2 Work protocol. Neither creates a Work, changes its requester, accepts a result, grants tool permission, or owns a shared resource.

## Non-blocking conversations

```json
{"action":"message","to":"reviewer","text":"Can you clarify the public name?"}
{"action":"message","to":"writer","replyTo":"event:…","text":"Use Widget."}
```

The `sent` receipt contains `messageId` and `recipient`. It acknowledges admission, not reading, agreement, or an answer. Runtime supplies the sender and originating WorkRef; a reply must go back to the authenticated sender of the referenced message. No answer obligation is created. Use `request` when a deliverable must be tracked and `yield attention` when work must stop for a decision.

Messages arrive in a **subsequent serialized mailbox/events activation**, not in the middle of the recipient's current native run. Ready Work can be scheduled before that mailbox turn. A busy member is never re-entered or interrupted. An idle member wakes for a bounded mailbox events activation, serialized with its Work activations. Non-lead mailbox activations only allow `message`, `status`, and `yield`; base tools and new Work are forbidden. They use ordinary worker permits and Team activation/model/tool budgets, and alternate with ready Work. The lead handles messages alongside its existing Team events.

Limits are 4 KiB per message, 32 unprocessed messages per member and 1,024 retained messages per Team. Admission rejects a full queue or closing/closed recipient without side effects. Normal member/Team close cannot silently discard pending mail. Native failure, transport loss, budget exhaustion, and host stops give mail an explicit unavailable disposition, reported to the lead and timeline. A cancelled Team records its abandoned mail in the terminal timeline. No automatic re-send or answer loop is introduced.

## One-shot phase facts

```json
{"action":"signal","operation":"open","name":"SDK phase released"}
{"action":"signal","operation":"publish","signalId":"signal:…","text":"The SDK phase is finished; unrelated tests continue."}
{"action":"yield","waitingForSignals":["signal:…"],"checkpoint":"Resume this work after that exact phase."}
```

`open` returns a fresh `signalId` and its record. Share the ID in a message or task. Every signal belongs to the **exact creating WorkRef**, including revision. Only that running revision can publish it. Every repeated phase opens a new ID, even when the display name is identical. Never use a display name, an old release, or a member's idle state as the identity of the next phase.

A signal transitions once from `pending` to `published` or `unavailable`. Publishing does not terminate the current Work/activation. It is a sole-tool-call batch, after the phase's tools have finished. Identical publication retries are idempotent; a conflicting second publication is rejected. A pending signal becomes unavailable if its exact producer finishes, fails, is cancelled, or is superseded without publishing. A published fact stays immutable history even if the producer later fails or revises its work.

`yield waitingForSignals` uses the existing staged end-intent, native settlement and cleanup path. The Work releases its activation/permit, waits for all exact handles to reach an outcome, then receives `signalOutcomes`. Publishing before registration, between staging and cleanup, or after blocking does not lose a wake. `unavailable` is an outcome to inspect, **not a successful release**. Each consumer acknowledges only outcomes actually included in its input. Signal observation never counts as observation of a child Work result. Work completion, result acceptance and child obligations remain unchanged.

`scope.waitingForSignals` retains exact unconsumed IDs. If `omittedSignalOutcomes` is nonzero, yield again on the unobserved IDs to receive the remaining outcomes. `status {view:"signal",id}` and paginated signal status are read-only, not consumption. One Work revision may open 32 signals; the Team retains at most 4,096. Published text is at most 1 KiB. Signal data is live coordination state; the existing journal remains bounded display history, not a resumable event store.

Dependency cycle checks distinguish **Work completion** (including owned children) from **phase publication** (the producer must be able to run). A parent can publish a phase needed by its child before that child finishes. Actual Work/signal wait cycles, including concurrent staged yields and waiting for one's own pending signal, are rejected.

## SDK handoff boundary

A signal says that a specific phase was declared complete. It does not prove the SDK is currently free, acquire it, reserve it, transfer ownership, or fence a competing process. A later SDK use requires a new phase handle. When concurrent consumers need exclusion, the actual SDK/file/process lock or an explicit ownership handoff remains authoritative. Messages and phase signals must not be presented as a resource-locking platform.

## Compatibility and validation

Existing `request`, `reply`, WorkRef `waitingFor`, and attention holds keep their semantics. Signal waits cannot be mixed with Work waits or attention in one yield. The new input/receipt/action variants use the existing bundled v2 private transport and strict codecs; update Runtime and child extension together. Active Teams are not migrated across builds. No wire version bump, independent message transport, resource manager, or history replay engine is added.

Tests cover idle and busy mailbox scheduling, identity, queue/close boundaries, fault/transport cleanup, lead handover, phase publication races, per-consumer observation, repeated handles, producer lifecycle, mixed wait cycles, limits, and sole-batch publication without native termination.
