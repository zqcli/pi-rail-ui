# Team messages and phase signals

Two additions to the existing v2 Work protocol. Neither creates a Work, changes its requester, accepts a result, grants tool permission, or owns a shared resource.

## Non-blocking conversations

```json
{"action":"message","to":"reviewer","text":"Can you clarify the public name?"}
{"action":"message","to":"writer","replyTo":"event:…","text":"Use Widget."}
```

The `sent` receipt contains `messageId` and `recipient`. It acknowledges admission, not reading, agreement, or an answer. Runtime supplies the sender and originating WorkRef; a reply must go back to the authenticated sender of the referenced message. No answer obligation is created. Continue working after an ordinary notification. Only when an answer is needed, explicitly wait for that message as below. Use `request` when a deliverable must be tracked and `yield attention` when work must stop for an owner's decision.

Messages arrive in a **subsequent serialized mailbox/events activation**, not in the middle of the recipient's current native run. Ready Work can be scheduled before that mailbox turn. A busy member is never re-entered or interrupted. An idle member wakes for a bounded mailbox events activation, serialized with its Work activations. Non-lead mailbox activations only allow `message`, `status`, and `yield`; base tools and new Work are forbidden. They use ordinary worker permits and Team activation/model/tool budgets, and alternate with ready Work. The lead handles messages alongside its existing Team events.

Limits are 4 KiB per message, 32 unprocessed messages per member and 1,024 retained messages per Team. Admission rejects a full queue or closing/closed recipient without side effects. Normal member/Team close cannot silently discard pending mail. Native failure, transport loss, budget exhaustion, and host stops give mail an explicit unavailable disposition, reported to the lead and timeline. A cancelled Team records its abandoned mail in the terminal timeline. No automatic re-send or answer loop is introduced.

### Explicitly waiting for an answer

```json
{"action":"signal","operation":"open_reply","messageId":"event:…"}
{"action":"yield","waitingForSignals":["signal:…"],"checkpoint":"Need the answer to that exact question before continuing."}
```

Use the `messageId` from the original `sent` receipt, then the `signalId` from `open_reply`. Opening a handle does not block; the explicit yield suspends the **same Work revision**, without finishing it or creating another Work. The recipient answers with ordinary `message {to,replyTo,text}`. It can answer from its ongoing Work or a mailbox turn, including while its Work is blocked on the sender's result. There is no false dependency on recipient Work completion.

Only the original sending WorkRef can open and wait for this handle. Same-message opens are idempotent, even after its outcome or when the signal quota is full. A new question uses a new message ID. Messages sent from events activations cannot be waited on there: an events activation yields normally and receives later messages in another mailbox turn. Answer handles are readable through `status(signal)` only by the sending member and the lead; ordinary phase signals retain their Team-wide visibility.

The first authenticated, successfully admitted `message(replyTo)` publishes the answer handle, with its full message text and `reply {messageId,recipient,replyId}`. Here `work` and `author` identify the original sender, and `reply.recipient` identifies the answerer. Manual `signal publish` cannot satisfy answer handles. A rejected/full-queue send does not publish. Answer-before-open, answer-before-yield, and answer-between-yield-and-cleanup all preserve the same answer and wake correctly.

The original message retains one immutable answer or unavailable disposition even before a handle is opened. If no answer has been admitted, definitive delivery failure, recipient unavailability/close, sending revision termination/replacement, or Team termination makes it unavailable. An answer already admitted survives a later fault. After unavailable, a late reply remains an ordinary delivered message but never rewrites the handle. Merely reading the question, ending a normal mailbox turn, or sending an unrelated notice does **not** make an answer unavailable: a later correlated answer is still valid. There is no enforced answer obligation or timeout; a silent recipient can leave the Work waiting until explicit intervention through the existing Team quiescence, cancel/revise, or close controls.

Answer handles reuse signal limits, staged yield, input projection, and per-Work signal observation. Only actually delivered `signalOutcomes` are acknowledged; omitted answers can be obtained by yielding again on the remaining IDs. **Signal observation does not consume the ordinary reply MESSAGE.** It can still arrive in a separate mailbox turn; use `replyId` to recognize it rather than answering twice. Existing transient activation retries may redeliver the same question ID after a partial turn; a subsequent answer does not replace the first outcome. Publication confirms receipt of the answer text, not its accuracy or permission to act on it.

## One-shot phase facts

```json
{"action":"signal","operation":"open","name":"SDK phase released"}
{"action":"signal","operation":"publish","signalId":"signal:…","text":"The SDK phase is finished; unrelated tests continue."}
{"action":"yield","waitingForSignals":["signal:…"],"checkpoint":"Resume this work after that exact phase."}
```

`open` returns a fresh `signalId` and its record. Share the ID in a message or task. Every signal belongs to the **exact creating WorkRef**, including revision. Only that running revision can publish it. Every repeated phase opens a new ID, even when the display name is identical. Never use a display name, an old release, or a member's idle state as the identity of the next phase.

A signal transitions once from `pending` to `published` or `unavailable`. Publishing does not terminate the current Work/activation. It is a sole-tool-call batch, after the phase's tools have finished. Identical publication retries are idempotent; a conflicting second publication is rejected. A pending signal becomes unavailable if its exact producer finishes, fails, is cancelled, or is superseded without publishing. A published fact stays immutable history even if the producer later fails or revises its work.

`yield waitingForSignals` uses the existing staged end-intent, native settlement and cleanup path. The Work releases its activation/permit, waits for all exact handles to reach an outcome, then receives `signalOutcomes`. Publishing before registration, between staging and cleanup, or after blocking does not lose a wake. `unavailable` is an outcome to inspect, **not a successful release**. Each consumer acknowledges only outcomes actually included in its input. Signal observation never counts as observation of a child Work result. Work completion, result acceptance and child obligations remain unchanged.

`scope.waitingForSignals` retains exact unconsumed IDs. If `omittedSignalOutcomes` is nonzero, yield again on the unobserved IDs to receive the remaining outcomes. `status {view:"signal",id}` and paginated signal status are read-only, not consumption. One Work revision may open 32 signals (phase and answer handles combined); the Team retains at most 4,096. Published phase text is at most 1 KiB; answer handles retain the full reply message up to 4 KiB. Signal data is live coordination state; the existing journal remains bounded display history, not a resumable event store.

Dependency cycle checks distinguish **Work completion** (including owned children) from **phase publication** (the producer must be able to run). A parent can publish a phase needed by its child before that child finishes. Actual Work/signal wait cycles, including concurrent staged yields and waiting for one's own pending phase signal, are rejected.

Host status and the Team panel use the same read-only dependency facts for Work and signal waits. Phase details identify the exact handle, name and producer revision. Pending phases show the producer's current state and queue/decision blocker; distinct handles are never merged by producer or display name. Published and unavailable outcomes remain visible until delivered, but are no longer reported as blockers, even while the producer's native cleanup or unknown Work outcome needs attention. Signal waits do not invent an additional producer/child-completion prerequisite. Cycle rejection adds bounded Timeline evidence, not a committed edge, new incident or automatic recovery action.

## SDK handoff boundary

A signal says that a specific phase was declared complete. It does not prove the SDK is currently free, acquire it, reserve it, transfer ownership, or fence a competing process. A later SDK use requires a new phase handle. When concurrent consumers need exclusion, the actual SDK/file/process lock or an explicit ownership handoff remains authoritative. Messages and phase signals must not be presented as a resource-locking platform.

## Compatibility and validation

Existing `request`, `reply`, WorkRef `waitingFor`, and attention holds keep their semantics. Signal waits cannot be mixed with Work waits or attention in one yield. The new input/receipt/action variants use the existing bundled v2 private transport and strict codecs; update Runtime and child extension together. Active Teams are not migrated across builds. No wire version bump, independent message transport, resource manager, or history replay engine is added.

Tests cover idle and busy mailbox scheduling, identity, queue/close boundaries, fault/transport cleanup, lead handover, phase publication races, per-consumer observation, repeated handles, producer lifecycle, mixed wait cycles, limits, and sole-batch publication without native termination. Correlated-answer tests additionally cover explicit same-Work waiting, early and late answer registration, delayed replies after normal mailbox completion, first terminal disposition, exact revision permissions, full-message projection/ACK, failed admission, and a real Pi 1.5.2 subprocess/RPC conversation through successful close.
