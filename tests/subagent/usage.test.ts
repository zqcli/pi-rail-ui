import assert from "node:assert/strict";
import { test } from "node:test";
import {
	addCompletedAssistantUsage,
	addCompactionUsage,
	emptySubagentUsage,
	providerReportedUsage,
	usageWithActiveTurn,
} from "../../tools/subagents/usage";

test("live provider usage overlays the active turn without double-counting completed turns", () => {
	const completed = emptySubagentUsage();
	addCompletedAssistantUsage(completed, {
		role: "assistant",
		usage: { input: 100, output: 20, cacheRead: 40, cacheWrite: 0, totalTokens: 160, cost: { total: 0.31 } },
	});
	const active = providerReportedUsage({
		input: 50,
		output: 7,
		cacheRead: 10,
		cacheWrite: 2,
		totalTokens: 69,
		cost: { total: 0.08 },
	});

	assert.deepEqual(usageWithActiveTurn(completed, active), {
		input: 150,
		output: 27,
		cacheRead: 50,
		cacheWrite: 2,
		cost: 0.39,
		contextTokens: 69,
		turns: 2,
	});
	assert.deepEqual(completed, {
		input: 100,
		output: 20,
		cacheRead: 40,
		cacheWrite: 0,
		cost: 0.31,
		contextTokens: 160,
		turns: 1,
	});
});

test("maps Responses usage fields without charging cached input twice", () => {
	assert.deepEqual(providerReportedUsage({
		input_tokens: 100,
		output_tokens: 20,
		total_tokens: 125,
		input_tokens_details: { cached_tokens: 30 },
		cost: { total: 0.5 },
	}), {
		input: 70,
		output: 20,
		cacheRead: 30,
		cacheWrite: 0,
		cost: 0.5,
		contextTokens: 125,
		turns: 0,
	});
});

test("compaction usage adds billed tokens without adding an assistant turn", () => {
	const total = emptySubagentUsage();
	addCompletedAssistantUsage(total, {
		role: "assistant",
		usage: { input: 10, output: 2, totalTokens: 12, cost: { total: 0.1 } },
	});
	assert.equal(addCompactionUsage(total, {
		usage: { input_tokens: 100, output_tokens: 5, total_tokens: 125, input_tokens_details: { cached_tokens: 20 }, cost: { total: 0.5 } },
	}), true);
	assert.deepEqual(total, {
		input: 90,
		output: 7,
		cacheRead: 20,
		cacheWrite: 0,
		cost: 0.6,
		contextTokens: 12,
		turns: 1,
	});
});
