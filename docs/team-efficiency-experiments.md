# Team efficiency experiments

Baseline: remote `dev` 3050caf17614d0acabb29f0e6790e9b3e06d59dd (tree 11c4c5e46d523668f43ff624939d3df09e4a9750). These are offline experiments, not online model benchmarks. No claim of user-facing speedup or output quality follows from simulated durations.

## Runtime event ordering

Existing scheduler, ready-order and ownership tests passed 29/29. Fifteen synthetic probes exercised the actual TeamRuntime using a fake clock and in-memory candidate ordering; production scheduling was not changed.

Current order puts faults/budget first, host commands second, and both blocking questions and ordinary results in the same tier. With 48 ordinary results ahead, elevating WORK_HELD/DEPENDENCY_UNAVAILABLE moved the blocker from batch 4 to batch 1; 30 seconds per batch was an assumption, not a measured latency. A running lead activation remains non-preemptible. With 16 new blockers every batch, strict priority left an older normal result undelivered for 20 batches: starvation is possible. A simple reserved ordinary slot improved the simulated fairness but must be enforced after the 64 KiB payload cap and considered alongside lead work-turn selection. Do not deploy strict priority without a bounded fairness design and representative measurements.

## Work organization and task size

A fixed seven-person, 24-task deterministic service-queue simulation compared a mixed lead against a coordinating lead with distinct integration and verification workers. The coordinating layout helped when integration was relatively expensive; it was slower in a compute-heavy, integration-light scenario because it removed producer capacity. Smaller work items increased simulated dispatch/model handoffs. These scenarios assume service durations and omit model quality, tokens, failure and rework; they do not establish an optimal team size or task granularity. Prefer clearly delegated responsibilities, avoid unnecessary handoffs, and measure representative real tasks before changing scheduling or forcing fixed roles.

## Follow-up measurement

Compare representative tasks with matched model, reasoning and provider conditions. Record active and paused wall time separately, lead event delay, ready-to-start delay, provider/tool/compaction/retry time, model turns and tokens, accepted output and rework. Investigate repeated private RPC and synchronous journal writes under high-frequency tools, plus historical descriptor scans at team startup, only after measuring their contribution. No real-provider A/B was available for this review.
