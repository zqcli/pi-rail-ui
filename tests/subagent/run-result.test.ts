import assert from "node:assert/strict";
import { test } from "node:test";
import { HOSTED_SEARCH_ENTRY_TYPE } from "../../openai/hosted-search-activity";
import { RunResultCollector, assistantText, strictAssistantText, type SubagentRunEvent } from "../../tools/subagents/run-result";

function hostedSearchEvent(id: string, callIds: string[]): SubagentRunEvent {
	return {
		type: "entry_appended",
		entry: {
			id,
			type: "custom",
			customType: HOSTED_SEARCH_ENTRY_TYPE,
			data: {
				version: 1,
				responseId: `resp_${id}`,
				provider: "cus-resp",
				model: "gpt-5.6-luna",
				phase: "completed",
				startedAt: 1000,
				endedAt: 2000,
				calls: callIds.map((callId) => ({ id: callId, status: "completed", type: "search", query: callId })),
				sources: [{ title: "Example", url: "https://example.com/source" }],
			},
		},
	};
}

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

test("does not classify branch-summary retries as compaction", () => {
	const collector = new RunResultCollector("branch summary", assistantText);
	assert.equal(collector.ingest({
		type: "summarization_retry_scheduled",
		attempt: 1,
		maxAttempts: 2,
		delayMs: 10,
		errorMessage: "temporary branch summary failure",
	}), false);
	assert.equal(collector.ingest({ type: "summarization_retry_attempt_start", source: "branchSummary" }), false);
	assert.equal(collector.ingest({ type: "summarization_retry_finished" }), false);
	assert.equal(collector.result("(running...)").isCompacting, undefined);
});

test("tracks native compaction progress without leaking the summary or settling the child run", () => {
	const collector = new RunResultCollector("compaction", assistantText);
	assert.equal(collector.ingest({ type: "compaction_start", reason: "threshold" }), true);
	assert.equal(collector.result("(running...)").isCompacting, true);

	assert.equal(collector.ingest({
		type: "summarization_retry_scheduled",
		attempt: 1,
		maxAttempts: 3,
		delayMs: 10,
		errorMessage: "temporary provider failure",
	}), true);
	assert.equal(collector.result("(running...)").isCompacting, true);
	assert.equal(collector.ingest({ type: "summarization_retry_attempt_start", source: "compaction", reason: "threshold" }), true);
	assert.equal(collector.ingest({ type: "summarization_retry_finished" }), true);

	assert.equal(collector.ingest({
		type: "compaction_end",
		reason: "threshold",
		result: { summary: "PRIVATE MODEL SUMMARY" },
		aborted: false,
		willRetry: true,
	}), true);
	const resumed = collector.result("(running...)");
	assert.equal(resumed.isCompacting, undefined);
	assert.equal(resumed.stopReason, undefined);
	assert.doesNotMatch(JSON.stringify(resumed), /PRIVATE MODEL SUMMARY/);

	for (const end of [
		{ aborted: true, willRetry: false },
		{ aborted: false, willRetry: false, errorMessage: "summary provider failed" },
	]) {
		const failed = new RunResultCollector("compaction", assistantText);
		failed.ingest({ type: "compaction_start", reason: "threshold" });
		failed.ingest({ type: "compaction_end", reason: "threshold", result: undefined, ...end });
		const result = failed.result("(no output)");
		assert.equal(result.isCompacting, undefined);
		assert.equal(result.errorMessage, end.aborted ? undefined : end.errorMessage);
		assert.doesNotMatch(JSON.stringify(result), /PRIVATE MODEL SUMMARY/);
	}
});

test("folds one compaction usage result without turning it into an assistant turn", () => {
	const collector = new RunResultCollector("compaction usage", assistantText);
	collector.ingest({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "before" }], usage: { input: 10, output: 2, totalTokens: 12, cost: { total: 0.1 } }, stopReason: "stop" },
	});
	collector.ingest({ type: "compaction_start", reason: "threshold" });
	const compactionEnd = {
		type: "compaction_end",
		reason: "threshold",
		result: { summary: "private", usage: { input_tokens: 100, output_tokens: 5, total_tokens: 125, input_tokens_details: { cached_tokens: 20 }, cost: { total: 0.5 } } },
		aborted: false,
		willRetry: false,
	} as const;
	collector.ingest(compactionEnd);
	collector.ingest(compactionEnd);

	assert.deepEqual(collector.result("fallback").usage, {
		input: 90,
		output: 7,
		cacheRead: 20,
		cacheWrite: 0,
		cost: 0.6,
		contextTokens: 12,
		turns: 1,
	});
});

test("counts distinct hosted search entries once per entry id", () => {
	const collector = new RunResultCollector("hosted search entries", assistantText);

	assert.equal(collector.ingest(hostedSearchEvent("entry-1", ["ws_1", "ws_2"])), true);
	assert.equal(collector.result("fallback").usage.searches, 2);

	assert.equal(collector.ingest(hostedSearchEvent("entry-1", ["ws_1", "ws_2"])), false);
	assert.equal(collector.ingest(hostedSearchEvent("entry-1", ["ws_1", "ws_2", "ws_3"])), false);
	assert.equal(collector.result("fallback").usage.searches, 2);

	assert.equal(collector.ingest(hostedSearchEvent("entry-2", ["ws_4"])), true);
	assert.equal(collector.result("fallback").usage.searches, 3);
});

test("counts the full persisted call count even when the calls list is bounded", () => {
	const collector = new RunResultCollector("bounded search entries", assistantText);
	const event: SubagentRunEvent = {
		type: "entry_appended",
		entry: {
			id: "entry-bounded",
			type: "custom",
			customType: HOSTED_SEARCH_ENTRY_TYPE,
			data: {
				version: 1,
				responseId: "resp_bounded",
				provider: "cus-resp",
				model: "gpt-5.6-luna",
				phase: "completed",
				startedAt: 1000,
				endedAt: 2000,
				calls: Array.from({ length: 24 }, (_, index) => ({ id: `ws_${index}`, status: "completed", type: "search" })),
				callCount: 40,
				sources: [],
			},
		},
	};

	assert.equal(collector.ingest(event), true);
	assert.equal(collector.result("fallback").usage.searches, 40);
	assert.equal(collector.ingest(event), false);
	assert.equal(collector.result("fallback").usage.searches, 40);
});

test("ignores valid hosted search entries without a usable entry id", () => {
	const collector = new RunResultCollector("unidentified search entries", assistantText);
	const identified = hostedSearchEvent("entry-identified", ["ws_1", "ws_2"])["entry"] as Record<string, unknown>;
	const missingId = { ...identified };
	delete missingId["id"];

	for (const entry of [missingId, { ...identified, id: undefined }, { ...identified, id: "" }]) {
		assert.equal(collector.ingest({ type: "entry_appended", entry }), false);
	}
	assert.equal("searches" in collector.result("fallback").usage, false);

	assert.equal(collector.ingest(hostedSearchEvent("entry-identified", ["ws_1", "ws_2"])), true);
	assert.equal(collector.result("fallback").usage.searches, 2);
});

test("ignores unrelated, malformed, and empty hosted search entries without adding a searches field", () => {
	const collector = new RunResultCollector("malformed search entries", assistantText);
	const validEntry = hostedSearchEvent("entry-ok", ["ws_1"])["entry"] as Record<string, unknown>;
	const validData = validEntry["data"] as Record<string, unknown>;
	const cases: SubagentRunEvent[] = [
		{ type: "entry_appended" },
		{ type: "entry_appended", entry: undefined },
		{ type: "session_info_changed", entry: validEntry },
		{ type: "entry_appended", entry: { ...validEntry, type: "custom_message" } },
		{ type: "entry_appended", entry: { ...validEntry, customType: "other" } },
		{ type: "entry_appended", entry: { ...validEntry, data: { ...validData, version: 2 } } },
		{ type: "entry_appended", entry: { ...validEntry, data: { ...validData, phase: "unknown" } } },
		{ type: "entry_appended", entry: { ...validEntry, data: { ...validData, provider: "" } } },
		{ type: "entry_appended", entry: { ...validEntry, data: { ...validData, startedAt: "soon" } } },
		{ type: "entry_appended", entry: { ...validEntry, data: { ...validData, calls: undefined } } },
		{ type: "entry_appended", entry: { ...validEntry, id: "entry-empty", data: { ...validData, calls: [] } } },
	];

	for (const event of cases) assert.equal(collector.ingest(event), false);
	assert.equal("searches" in collector.result("fallback").usage, false);
});

test("keeps hosted search counts across active, completed, and compaction usage", () => {
	const collector = new RunResultCollector("search usage", assistantText);
	collector.ingest({ type: "message_start", message: { role: "assistant", content: [] } });
	collector.ingest({ type: "message_update", usage: { input: 7, output: 1, cacheRead: 2, cacheWrite: 0, totalTokens: 10, cost: { total: 0.01 } } });
	collector.ingest(hostedSearchEvent("active-entry", ["ws_a", "ws_b"]));

	assert.deepEqual(collector.result("(running...)").usage, {
		input: 7,
		output: 1,
		cacheRead: 2,
		cacheWrite: 0,
		cost: 0.01,
		contextTokens: 10,
		turns: 1,
		searches: 2,
	});

	collector.ingest({
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 4, output: 2 }, stopReason: "stop" },
	});
	assert.deepEqual(collector.result("(no output)").usage, {
		input: 4,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 1,
		searches: 2,
	});

	collector.ingest(hostedSearchEvent("completed-entry", ["ws_c"]));
	assert.equal(collector.result("(no output)").usage.searches, 3);

	collector.ingest({ type: "compaction_start", reason: "threshold" });
	collector.ingest({
		type: "compaction_end",
		reason: "threshold",
		result: { summary: "private", usage: { input_tokens: 100, output_tokens: 5, total_tokens: 125, input_tokens_details: { cached_tokens: 20 }, cost: { total: 0.5 } } },
		aborted: false,
		willRetry: false,
	});
	assert.deepEqual(collector.result("(no output)").usage, {
		input: 84,
		output: 7,
		cacheRead: 20,
		cacheWrite: 0,
		cost: 0.5,
		contextTokens: 0,
		turns: 1,
		searches: 3,
	});
});
