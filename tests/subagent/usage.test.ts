import assert from "node:assert/strict";
import { test } from "node:test";
import {
	addCompletedAssistantUsage,
	addCompletedToolResultUsage,
	addCompactionUsage,
	addUsage,
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

test("tool-result usage adds billed tokens without changing assistant turns or context", () => {
	const total = emptySubagentUsage();
	addCompletedAssistantUsage(total, {
		role: "assistant",
		usage: { input: 10, output: 2, totalTokens: 12, cost: { total: 0.25 } },
	});
	assert.equal(addCompletedToolResultUsage(total, {
		role: "toolResult",
		usage: { input: 100, output: 5, cacheRead: 20, cacheWrite: 4, totalTokens: 129, cost: { total: 0.5 } },
	}), true);
	assert.deepEqual(total, {
		input: 110, output: 7, cacheRead: 20, cacheWrite: 4, cost: 0.75, contextTokens: 12, turns: 1,
	});
	const before = { ...total };
	for (const message of [null, [], { role: "toolResult" }, { role: "toolResult", usage: null },
		{ role: "toolResult", usage: [] }, { role: "assistant", usage: { input: 100 } },
		{ role: "user", usage: { input: 100 } }]) {
		assert.equal(addCompletedToolResultUsage(total, message), false);
		assert.deepEqual(total, before);
	}
});

test("search counts stay optional, merge on demand, and survive compaction", () => {
	assert.equal("searches" in emptySubagentUsage(), false);

	const completed = emptySubagentUsage();
	addCompletedAssistantUsage(completed, {
		role: "assistant",
		usage: { input: 10, output: 2, totalTokens: 12, cost: { total: 0.1 } },
	});
	addUsage(completed, { ...emptySubagentUsage(), searches: 2 }, false);
	addUsage(completed, emptySubagentUsage(), false);
	assert.equal(completed.searches, 2);

	assert.equal(addCompactionUsage(completed, {
		usage: { input_tokens: 100, output_tokens: 5, total_tokens: 125, cost: { total: 0.5 } },
	}), true);
	assert.equal(completed.searches, 2);

	const overlay = usageWithActiveTurn(completed, { ...emptySubagentUsage(), searches: 1 });
	assert.equal(overlay.searches, 3);
	assert.equal(completed.searches, 2);
});

test("usage overlays keep zero search counts out of the result object", () => {
	const completed = emptySubagentUsage();
	assert.equal("searches" in usageWithActiveTurn(completed, undefined), false);
	assert.equal("searches" in usageWithActiveTurn(completed, emptySubagentUsage()), false);
	const reported = providerReportedUsage({ input: 1, output: 1 });
	assert.ok(reported);
	assert.equal("searches" in reported, false);

	const withSearches = usageWithActiveTurn({ ...completed, searches: 2 }, undefined);
	assert.equal(withSearches.searches, 2);
	assert.deepEqual(usageWithActiveTurn({ ...completed, searches: 2 }, emptySubagentUsage()).searches, 2);
});
