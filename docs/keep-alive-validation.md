# Keep-alive during long-running tools

Validated on 2026-10-01 with Pi **0.87.1**, starting from local `dev` commit `ec47313` in the `feat/rail-keep-alive` worktree. No upstream Pi files, global settings, or credentials were changed.

## Contract

- Each successful **parent model response** starts the configured N-minute countdown, including responses containing tool calls.
- While tools run, the parent may still be `working`. That is not model generation: the completed request's prefix can be refreshed while waiting for subagents, Team launch, bash, or other tools.
- Tool progress, partial sibling completion, tool-result messages and queued steering/follow-ups do not refresh the parent's provider cache and therefore do not reset the deadline.
- A completed warm starts a new N-minute interval. `agent_settled` changes the displayed phase to idle without restarting an existing timer or overlapping an in-flight warm.
- `turn_start` invalidates the old snapshot before asynchronous request preparation. `CacheWarmer.start()` also replaces it at the actual provider-request boundary. No timer is armed during model generation.
- Parent abort, `off`, failed/aborted parent responses, model/tree changes, compaction and shutdown stop old timers/in-flight warms. Late decisions/results cannot revive the old run.
- The request-time session-entry path is retained: settlement must not bless an intervening context rewrite by replacing that path.
- The current idle `/reload` handoff remains unchanged. A reload that interrupts an active run requires a fresh parent request.
- Child cache warming is not enabled or authorized implicitly. This feature warms the **parent** request only.

The implementation uses the native warmer's replay, usage accounting and run-identity validation. It adds a post-response waiting phase rather than tool-name-specific exceptions. The parent run's abort signal is observed only while that waiting phase is active and is detached on settlement/replacement/cleanup.

## Automated checks (no paid requests)

### Native warmer + fake session + mock timers

`tests/commands/rail-keep-alive.test.ts` exercises:

1. A model response taking over an hour does not itself trigger a warm.
2. Response completion starts the timer while `isIdle()` is false; a 50-minute interval repeats four times, covering 200 minutes of waiting.
3. Parallel tool starts/results, progress and queued input do not reset the interval or create duplicate timers.
4. Settlement preserves both an existing deadline and an in-flight warm.
5. The next parent request aborts an in-flight warm; a late aborted result neither pauses the replacement nor records usage.
6. Cancelling a waiting parent aborts the warm immediately and does not re-arm at settlement.
7. Compaction/model/tree/off/shutdown stop waiting-phase refreshes.
8. Failed or aborted parent responses and rewritten prefixes cannot become replayable at settlement.
9. A decision delayed across a new request, `turn_start`, or compaction cannot send the old refresh.

### Real bundled Pi + local synthetic provider

`tests/core/bundle-keep-alive.test.ts` adds a real parent agent turn with two parallel, externally released tools:

- The first completed model response produces `KA 1|1` while the parent is busy.
- Queuing a steering message and completing only one sibling preserve the deadline.
- The native refresh succeeds with the real parent still busy, records one `cache_warm`, and replays exactly the original parent payload without partial results or queued input.
- Releasing the second tool allows exactly one parent continuation and returns to idle countdown.

This bundle test explicitly dispatches the scheduled native refresh to avoid a one-minute delay in the regular suite. It does **not** claim to test wall-clock timer expiry; mock-timer unit tests and the live runs below cover that separately.

### Before/after verification

All **8 new test cases** (7 unit cases and 1 bundle case) fail against the previous production implementation, and pass with the changes. The complete focused suite passes **33/33**. The full `npm run check` passes **992/992**; `PI_SUBAGENT_DEPTH=1 npm test` also passes **992/992**.

## Live provider tests

Parent model: **`cus-resp/gpt-6-luna:max`**, **Fast enabled**. Subagent and Team members also explicitly selected `cus-resp/gpt-6-luna:max` with `fastMode: true`. Actual outgoing parent and warm payloads were checked for `reasoning.effort = max` and `service_tier = priority`.

Tests used real Pi RPC processes with the full Rail extension and `/rail-keep-alive 1`. Timers were **not accelerated** and refresh was **not forced**. A read-only observer recorded phase/label, actual request options and native `cache_warm` usage entries; it did not alter scheduling. Each case ran in its own temporary session/configuration directory.

| Scenario | Real workload / control | Parent warms | Result |
|---|---|---:|---|
| Single subagent | Child runs `sleep 140` then returns | 2 | Both while parent working; cacheRead 4608 on each |
| Grouped parallel subagents | Children run `sleep 80` and `sleep 140` | 2 | Shorter child completion does not prevent the second warm; cacheRead 4608 on each |
| Generic tool | Parent bash runs `sleep 80` | 1 | Works without a subagent-specific exception; cacheRead 4608 |
| Queued steering | Parent bash runs `sleep 90`; steer queued during the wait | 1 | Deadline unchanged immediately after steering; parent processes it after the tool; cacheRead 3584 |
| Abort | Parent bash runs `sleep 90`; abort after first completed warm | 1 | No additional warm after another 65 seconds; label `KA 1|-` |
| Off | Parent bash runs `sleep 90`; disable before first deadline | 0 | No warm during remaining tool wait or 65 seconds after settlement; label hidden |
| Team launch | Manager + worker; worker runs `sleep 85` | 1 | Parent warms during launch wait; Team returns and parent settles; cacheRead 5632 |

All **7 live scenarios passed**, recording **8 parent warms** in total. These were paid provider calls authorized for verification, separate from the offline test suite. Cache-read counts are observations of these runs, not a guarantee of provider TTL, future cache hits, or pricing. Runs lasting hours were simulated with mock timers; no claim is made that the live runs lasted an hour.

`cus-resp/gpt-6-luna:max` with Fast also performed read-only code/test verification. Its first pass identified the async request-preparation gap; adding `turn_start` invalidation and its regression check addressed it. Its final pass found no blocker and independently ran the focused **33/33** tests.

## Limits

- Cancelling an already-dispatched request aborts it locally; whether upstream billing stops depends on the provider honoring cancellation.
- Paid replay remains subject to existing cache-retention and unsafe Anthropic-thinking restrictions, extension vetoes, and late-timer/provider-error pauses.
- Enabling or changing the interval without a fresh replayable request still waits for the next real parent request; historical JSONL is not reconstructed into a provider request.
