# Footer history-cache measurement

Measured on 2026-11-15 against baseline `5f696f6` (Pi `1.5.2`, unchanged lockfile). The candidate is the footer-cache implementation committed with this report. Reference: Pi 1.5.2's native `FooterComponent.getSessionStats()` caches session usage and context before calling `getEntries()`.

## Change and correctness

The old footer cached usage totals **after copying all entries**, and rebuilt native context on every frame. The new per-component cache checks manager identity, session ID, leaf ID, O(1) entry count, model identity and the numeric context window before reading history. Pi's append-only contract covers appends, compaction, context edits and branch summaries. Branch navigation and off-branch usage are both invalidations. Ordinary TUI invalidation does not evict the cache. The compact footer also no longer searches history for a session name that only the modal displays.

Pi 1.5.2 implements `SessionManager.getEntryCount()` but omits it from `ReadonlySessionManager`'s type. A narrow optional capability check uses the runtime method; adapters without it continue to recompute. `pi-virtual` usage totals are cached, but context remains live because `ExtensionContext` does not expose the routed physical model or independent changes to its limits. No Pi internals are patched, and context calculation stays native.

Five new regression tests use real `SessionManager` storage and native `AgentSession.getContextUsage()` on physical-model paths: warm hits after invalidation/resize, append/tree/off-branch usage/compaction/context-edit changes, manager/session/model/window changes, cached unknown context, adapters without cheap counts, and live non-history labels. A changing virtual-model context is injected to verify the cache bypass. The existing modal, narrow footer, KA/CONT and usage tests remain applicable. The modal still collects live details each second.

## Matched experiment

- Node `v24.22.1`, Pi packages `1.5.2`, Intel Xeon Platinum 8573C, same process, lockfile and dependency installation for both implementations.
- One identical fixture per pair, using native in-memory storage and context projection. Each turn has a user message, assistant tool call, tool result and final answer; every 25 turns adds standalone cache-warming usage. A fourth fixture adds a real compaction entry retaining about 100 entries.
- Width 160; 30 untimed warmup iterations per side/phase; 9 paired groups in alternating before/after order. GC runs outside each timed group.
- Warm hits: 250 renders per group, including `invalidate()`. Leaf-change misses: 24 renders alternating two nearby leaves. Cold renders: 24 fresh components per group, including construction and disposal.
- Each paired group's final rendered output is asserted identical. Counters are collected separately from timings.

Median milliseconds per render (all samples and environment metadata: [raw JSON](benchmarks/footer-2026-11-15.json)):

| Entries | State | Warm hit before → after | Leaf-change miss before → after | Cold before → after |
| ---: | --- | ---: | ---: | ---: |
| 101 | Uncompacted | 0.1771 → 0.1447 | 0.1699 → 0.1900 | 0.1978 → 0.1685 |
| 1,010 | Uncompacted | 0.5985 → 0.0972 | 0.5539 → 0.6158 | 0.6870 → 0.6336 |
| 10,100 | Uncompacted | 5.5589 → 0.0871 | 4.5823 → 4.7369 | 5.3364 → 5.4007 |
| 10,101 | Post-compaction, context unknown | 3.5320 → 0.0944 | 4.2079 → 4.6130 | 4.2275 → 4.1075 |

At 10,100 entries, warm footer rendering is 63.8× faster in this fixture; post-compaction it is 37.4× faster. For 100 warm renders, `getEntries` calls drop from 200 to 0, and branch/projection/context/name calls each drop from 100 to 0. This is an O(1) history-cache hit, not just a faster full-history copy.

Leaf-change misses are 3–12% slower in this run: the new native-style combined cache recomputes usage totals as well as context, whereas the old usage cache reused totals when only the active leaf changed. Cold rendering does the same full-history work as before and is roughly unchanged, including a 1.2% increase on the long uncompacted fixture. The change targets repeated frames with unchanged history, not misses. No incremental totals cache was added to optimize the less common path.

## Reproduce

From a checkout containing this benchmark and with the locked dependencies installed:

```sh
mkdir -p .tmp/footer-baseline
git archive 5f696f6 | tar -x -C .tmp/footer-baseline
ln -s ../../node_modules .tmp/footer-baseline/node_modules
node --expose-gc --import tsx tests/benchmarks/footer.bench.ts .tmp/footer-baseline . > .tmp/footer-benchmark.json
npm run typecheck
node --import tsx --test tests/components/footer/*.test.ts
```

Targeted footer tests and typecheck passed. A full-suite run was stopped to avoid resource contention with the coordinated integration run; it is not represented as a pass here.

## Limits

These are deterministic synthetic conversations, not captured production sessions. Timing covers the footer, not full TUI rendering, terminal I/O, streaming generation, provider latency, memory/GC pressure over hours or an end-to-end user-visible speedup. Native storage and context projection are real, but no model calls or filesystem session persistence occur. CPU scheduling and JIT/GC introduce noise, especially for short/cold renders; the raw nine-sample distributions should be retained rather than treating the medians as universal constants. Virtual-model context, legacy adapters without a cheap count and the details modal intentionally do not gain this context-cache speedup. Unsupported mutation of existing Pi session entries is outside Pi's append-only contract and is not detected by this cache.
