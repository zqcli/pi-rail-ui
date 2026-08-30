import assert from "node:assert/strict";
import { test } from "node:test";
import {
	addCompletedAssistantUsage,
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