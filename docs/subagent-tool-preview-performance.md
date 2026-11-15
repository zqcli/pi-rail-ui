# Streamed tool-call preview performance

Baseline `5f696f6`; candidate change `perf(subagent): bound streamed tool-call previews`. Linux x64, Node 24.22.1, Pi 1.5.2. Same fixture, 64 UTF-16-unit chunks; before and after were run sequentially, one warmup and five samples per size. Times are medians for `toolcall_delta` ingestion, in milliseconds; output equivalence was asserted.

| Input UTF-16 units | Before | After |
| ---: | ---: | ---: |
| 67,012 | 69.375 | 13.728 |
| 133,987 | 467.315 | 27.750 |
| 267,890 | 1676.161 | 57.412 |
| 535,743 | 7038.386 | 110.320 |

The largest fixture is a stress case. These numbers exclude rendering, network, actual tool execution and final events; background load was not fully isolated. They do not represent end-to-end speedup. The complete execution arguments remain unchanged; the bounded data is only a display preview.

Benchmark: `PI_OFFLINE=1 PI_TELEMETRY=0 node --import tsx tests/benchmarks/subagent-toolcall-delta.ts`. Run the same script on both checkouts with their pinned dependencies and compare the same workloads.
