import assert from "node:assert/strict";
import { test } from "node:test";
import { RunResultCollector, assistantText, strictAssistantText } from "../../tools/subagents/run-result";

test("reports live usage during a turn and completed usage after message_end", () => {
	const collector = new RunResultCollector("live usage", assistantText);
	collector.ingest({ type: "message_start", message: { role: "assistant", content: [] } });
	collector.ingest({ type: "message_update", usage: { input: 7, output: 1, cacheRead: 2, cacheWrite: 0, totalTokens: 10, cost: { total: 0.01 } } });

	assert.deepEqual(collector.result("(running...)").usage, {
		input: 7,
		output: 1,
		cacheRead: 2,
		cacheWrite: 0,
		cost: 0.01,
		contextTokens: 10,
		turns: 1,
	});

	collector.ingest({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 4, output: 2 }, stopReason: "stop" } });

	const completed = collector.result("(no output)");
	assert.equal(completed.output, "done");
	assert.equal(completed.stopReason, "stop");
	assert.deepEqual(completed.usage, {
		input: 4,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 1,
	});
});

test("keeps the output fallback and folds terminal state for a textless assistant message_end", () => {
	const collector = new RunResultCollector("no text", assistantText);
	collector.ingest({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "thinking", thinking: "thinking only" }], stopReason: "error", errorMessage: "provider refused" },
	});

	const result = collector.result("(no output)");
	assert.equal(result.output, "(no output)");
	assert.equal(result.stopReason, "error");
	assert.equal(result.errorMessage, "provider refused");
});

test("keeps an active turn live and untouched after a non-assistant message_end", () => {
	const collector = new RunResultCollector("tool result only", assistantText);
	collector.ingest({ type: "message_start", message: { role: "assistant", content: [] } });
	collector.ingest({ type: "message_update", usage: { input: 7, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { total: 0.01 } } });
	collector.ingest({
		type: "message_end",
		message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "source" }], isError: false },
	});

	const result = collector.result("(no output)");
	assert.equal(result.output, "(no output)");
	assert.equal(result.stopReason, undefined);
	assert.equal("errorMessage" in result, false);
	assert.deepEqual(result.usage, {
		input: 7,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0.01,
		contextTokens: 8,
		turns: 1,
	});
});

test("noteError and message_end folding share one error message slot", () => {
	const collector = new RunResultCollector("shared slot", strictAssistantText);
	collector.noteError("spawn failed");
	collector.ingest({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "late" }], stopReason: "stop", errorMessage: "folded later" },
	});
	assert.equal(collector.errorMessage, "folded later");
	assert.equal(collector.result("(no output)").errorMessage, "folded later");
});

test("ingest returns a boolean update-change signal", () => {
	const collector = new RunResultCollector("cadence", assistantText);
	assert.equal(collector.ingest({ type: "message_start", message: { role: "assistant", content: [] } }), false);
	assert.equal(collector.ingest({ type: "message_update", usage: { input: 1 } }), true);
	assert.equal(collector.ingest({ type: "tool_execution_start", toolCallId: "c1", toolName: "read" }), true);
	assert.equal(collector.ingest({ type: "message_end", message: { role: "assistant", content: [] } }), false);
});