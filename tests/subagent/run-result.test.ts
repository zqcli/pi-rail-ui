import assert from "node:assert/strict";
import { test } from "node:test";
import { RunResultCollector, assistantText, strictAssistantText } from "../../tools/subagents/run-result";

const usage = { input: 12, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 17, cost: { total: 0.04 } };

const statelessFixtureStream: Array<Record<string, unknown>> = [
	{ type: "message_start", message: { role: "assistant", content: [] } },
	{ type: "message_update", usage, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Inspect fixture" } },
	{
		type: "message_update",
		usage,
		assistantMessageEvent: {
			type: "toolcall_end",
			contentIndex: 1,
			toolCall: { type: "toolCall", id: "fixture-call", name: "read", arguments: { path: "fixture.ts" } },
		},
	},
	{
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Inspect fixture" },
				{ type: "toolCall", id: "fixture-call", name: "read", arguments: { path: "fixture.ts" } },
			],
			stopReason: "toolUse",
		},
	},
	{ type: "tool_execution_start", toolCallId: "fixture-call", toolName: "read", args: { path: "fixture.ts" } },
	{
		type: "tool_execution_update",
		toolCallId: "fixture-call",
		toolName: "read",
		partialResult: { content: [{ type: "text", text: "partial fixture" }] },
	},
	{
		type: "tool_execution_end",
		toolCallId: "fixture-call",
		toolName: "read",
		result: { content: [{ type: "text", text: "fixture source" }] },
		isError: false,
	},
	{
		type: "message_end",
		message: { role: "toolResult", toolCallId: "fixture-call", toolName: "read", content: [{ type: "text", text: "fixture source" }], isError: false },
	},
	{ type: "message_start", message: { role: "assistant", content: [] } },
	{ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "stateless done" } },
	{
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "stateless done" }], usage, stopReason: "stop" },
	},
];

test("replays the stateless fixture event stream to the same settled result", () => {
	const collector = new RunResultCollector("inspect auth", strictAssistantText);
	for (const event of statelessFixtureStream) collector.ingest(event);

	const result = collector.result("(no output)");
	assert.equal(result.output, "stateless done");
	assert.deepEqual(result.transcript?.entries.map((entry) => entry.kind), ["user", "thinking", "tool", "toolResult", "assistant"]);
	assert.deepEqual(result.usage, {
		input: 12,
		output: 3,
		cacheRead: 2,
		cacheWrite: 0,
		cost: 0.04,
		contextTokens: 17,
		turns: 1,
	});
});

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

test("strict extraction ignores the malformed message tail but keeps its transcript", () => {
	const collector = new RunResultCollector("malformed", strictAssistantText);
	assert.throws(() => collector.ingest({
		type: "message_end",
		message: { role: "assistant", content: [null, { type: "text", text: "kept in transcript" }], usage: { input: 999 }, stopReason: "stop" },
	}));

	const result = collector.result("(no output)");
	assert.equal(result.output, "(no output)");
	assert.equal(result.stopReason, undefined);
	assert.equal("errorMessage" in result, false);
	assert.equal(result.usage.turns, 0);
	assert.deepEqual(result.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });
	assert.equal(result.transcript?.entries.at(-1)?.text, "kept in transcript");
});

test("tolerant extraction promotes text and usage despite malformed content parts", () => {
	const collector = new RunResultCollector("tolerant", assistantText);
	collector.ingest({
		type: "message_end",
		message: { role: "assistant", content: [null, { type: "text", text: "done" }], usage: { input: 10, output: 1 }, stopReason: "stop" },
	});

	const result = collector.result("(no output)");
	assert.equal(result.output, "done");
	assert.equal(result.stopReason, "stop");
	assert.deepEqual(result.usage, { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 });
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

test("markAborted applies the shared aborted terminal state", () => {
	const collector = new RunResultCollector("abort", assistantText);
	collector.markAborted();

	const result = collector.result("(running...)");
	assert.equal(result.stopReason, "aborted");
	assert.equal(result.errorMessage, "Subagent request was aborted");
});

test("ingest returns a single change signal the adapters OR together", () => {
	const collector = new RunResultCollector("cadence", assistantText);
	assert.equal(collector.ingest({ type: "message_start", message: { role: "assistant", content: [] } }), false);
	assert.equal(collector.ingest({ type: "message_update", usage: { input: 1 } }), true);
	assert.equal(collector.ingest({ type: "tool_execution_start", toolCallId: "c1", toolName: "read" }), true);
	assert.equal(collector.ingest({ type: "message_end", message: { role: "assistant", content: [] } }), false);
});