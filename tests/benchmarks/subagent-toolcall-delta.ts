import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { SubagentTranscript } from "../../tools/subagents/transcript";

// The same deterministic events exercise the actual ingest path before and after a change.
// Run: node --import tsx tests/benchmarks/subagent-toolcall-delta.ts
const samples = 5;
const chunkSize = 64;
const line = "const text = '分片🙂'; // tool argument content\n";
const results: object[] = [];
for (const size of [64, 128, 256, 512]) {
	const args = { path: "benchmark.txt", content: line.repeat(Math.ceil(size * 1024 / line.length)) };
	const serialized = JSON.stringify(args);
	const events = Array.from({ length: Math.ceil(serialized.length / chunkSize) }, (_, index) => ({
		type: "message_update",
		assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: serialized.slice(index * chunkSize, (index + 1) * chunkSize) },
	}));
	const times: number[] = [];
	for (let sample = -1; sample < samples; sample++) {
		const transcript = new SubagentTranscript("Benchmark preview ingestion");
		transcript.ingest({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 } });
		const start = performance.now();
		for (const event of events) transcript.ingest(event);
		const elapsed = performance.now() - start;
		const preview = transcript.snapshot().entries.at(-1)!;
		assert.ok(preview.text.length <= 4000);
		assert.equal(preview.text, `[… earlier text omitted]\n${serialized.slice(-3972)}`);
		transcript.ingest({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { id: "call", name: "write", arguments: args } } });
		assert.equal(transcript.snapshot().entries.at(-1)!.text, `[… earlier text omitted]\n${JSON.stringify(args, null, 2).slice(-3972)}`);
		if (sample >= 0) times.push(elapsed);
	}
	times.sort((a, b) => a - b);
	results.push({ inputCodeUnits: serialized.length, inputBytes: Buffer.byteLength(serialized), chunks: events.length, medianMs: Number(times[Math.floor(samples / 2)]!.toFixed(3)), samplesMs: times.map((time) => Number(time.toFixed(3))) });
}
console.log(JSON.stringify({ node: process.version, chunkSize, samples, results }, null, 2));
