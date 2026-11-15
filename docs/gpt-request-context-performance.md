# GPT request-context capture performance

Baseline: `5f696f6f599e05474dfe4261345bbb034aacf26b` (dev). The change is limited to declaration capture in `requestTranscript`, shared by `rememberLiveRequestContext` and remote compaction request construction.

## Change and correctness boundary

The old path deep-cloned every session entry before running Pi's canonical projection, then discarded every non-system message. It copied conversation text, tool output, images and checkpoint details even though declaration capture needs only system/tool state.

The new path shallow-copies and re-links entry wrappers, calls the same Pi 1.5.2 `buildSessionProjection`, and borrows only its system messages. It also uses `findLast` instead of allocating and reversing a whole branch array. Recovery/replay paths that return detached history keep their existing deep copies. There is no new cache, invalidation protocol, hand-written declaration folding, or fallback.

Borrowed messages are read synchronously. `rememberRequestContext` still snapshots tool provenance and provider extras, and `resolveCompactionRequestExtras` still returns detached wire state. This depends on the pinned projector and declaration converters being read-only, as verified against Pi 1.5.2 and covered by mutation-isolation tests. A future dependency upgrade must retain that contract. The latest compaction snapshot, retained-entry suppression, context edits, empty authoritative state and the existing snapshotless legacy path are unchanged. Remote compaction still uses the event's branch, not a later live branch; identity/session cache separation is unchanged.

## Reproduce

Install the repository's locked dependencies first. Use an unchanged baseline checkout with the same dependency installation:

```sh
git worktree add --detach /tmp/rail-context-before 5f696f6f599e05474dfe4261345bbb034aacf26b
ln -s "$PWD/node_modules" /tmp/rail-context-before/node_modules
node --import tsx tests/benchmarks/gpt-request-context.bench.ts /tmp/rail-context-before
```

The benchmark imports both actual implementations, not a rewritten approximation. Both run against the same real in-memory `SessionManager` and provider payload. Fixtures have 1,000/5,000/10,000 user messages, each containing exactly 2,048 ASCII content bytes, plus one system declaration. Native-compaction fixtures append Pi's actual native checkpoint retaining the last 100 messages; the raw branch remains intact. Each case warms both implementations 10 times, then collects 40 samples each in alternating paired order. Instrumented clone counts are measured separately from timing. The script verifies equal cached extras, canonical current tools and byte-for-byte unchanged session entries.

## Observed results

Measured on 2026-11-15 with Node v24.22.1 and the pinned Pi 1.5.2 dependencies. Times below are milliseconds per capture call; the candidate is this change applied to the baseline. These are samples from shared hardware, not latency guarantees.

| Messages | Native checkpoint | Before median | After median | Median ratio | Before p95 | After p95 |
| ---: | :---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | no | 6.972 | 0.555 | 12.57x | 60.776 | 2.658 |
| 1,000 | yes | 3.285 | 0.285 | 11.55x | 4.396 | 0.433 |
| 5,000 | no | 19.571 | 2.187 | 8.95x | 34.052 | 6.465 |
| 5,000 | yes | 18.551 | 2.006 | 9.25x | 23.403 | 3.077 |
| 10,000 | no | 51.607 | 6.749 | 7.65x | 71.266 | 12.264 |
| 10,000 | yes | 42.674 | 4.707 | 9.07x | 52.444 | 8.653 |

Before the change, every raw entry was passed to `structuredClone`: 1,001/5,001/10,001 entries without a checkpoint, one more with it. Afterwards no session entry is passed to `structuredClone`. Both retain four other top-level clone calls for this fixture's tools, reasoning, identity and declaration provenance. JSON schema normalization and other allocations are not included in that count.

## Stage validation

- `npm run typecheck`: passed.
- GPT-compaction tests plus `rail-oai-command.test.ts`: 150/150 passed, including native/remote replay, context edits, snapshots, forced system prompts, dynamic/strict/hosted tools and provider changes.
- Final changed transcript-request tests: 20/20 passed. New checks cover no conversation-entry cloning, source preservation, borrowed-schema conversion, detached branches and independent payload/provenance snapshots.
- Independent review found no blocking issue; it also compared 200 seeded mixed histories against canonical projection and baseline capture with source entries deeply frozen.
- The stage's aggregate `npm run check` was stopped for the integrated check, not recorded as a full pass. Two existing budget-test assertions use `arg.includes("rail-context")`, which also matches the stage checkout's directory name. Both fail on the unchanged baseline in an equally named directory; the same candidate code in a neutral directory passes that entire file (26/26). No unrelated test or runtime workaround is included here.

## Scope and limitations

- This is an offline microbenchmark of one synchronous capture call, including `getBranch` and projection, not provider latency, complete agent turns, or end-to-end compaction.
- Branch traversal and projection remain O(entries); tool declaration/extras snapshots still cost work proportional to the declarations. This does not introduce incremental history caching.
- The fixture is long plain-text history with two tools. Tests cover richer tool declarations, context edits and checkpoint semantics, but the timing fixture does not represent every image/tool-heavy workload.
- Shared-machine scheduling, JIT and garbage collection affect timings. Fewer top-level `structuredClone` calls do not quantify peak memory, total allocation or GC savings. No live provider A/B was performed.
