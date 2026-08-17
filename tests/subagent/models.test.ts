import assert from "node:assert/strict";
import { test } from "node:test";
import { availableRailModels, resolveRailModel } from "../../subagent/models";

const sol = { provider: "cus-resp", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" };
const colonModel = { provider: "openrouter", id: "vendor/model:exacto", name: "Exacto" };

function context(models = [sol, colonModel]) {
	return {
		model: sol,
		thinkingLevel: "high" as const,
		scopedModels: [{ model: sol, thinkingLevel: "xhigh" as const }],
		modelRegistry: {
			getAvailable: () => models,
			find: (provider: string, id: string) => models.find((item) => item.provider === provider && item.id === id),
		},
	};
}

test("availableRailModels prefers Pi scoped models and preserves thinking levels", () => {
	assert.deepEqual(availableRailModels({ ...context(), model: undefined } as any), [{
		provider: "cus-resp",
		modelId: "gpt-5.6-sol",
		name: "GPT 5.6 Sol",
		thinkingLevel: "xhigh",
	}]);
});

test("availableRailModels also includes the current model when it is outside the configured scope", () => {
	const outside = { provider: "cus-resp", id: "gpt-5.6-luna", name: "GPT 5.6 Luna" };
	assert.deepEqual(availableRailModels({
		...context(),
		model: outside,
		thinkingLevel: "xhigh",
	} as any).map((item) => `${item.provider}/${item.modelId}`), [
		"cus-resp/gpt-5.6-luna",
		"cus-resp/gpt-5.6-sol",
	]);
});

test("resolveRailModel accepts canonical references with an explicit thinking level", () => {
	assert.deepEqual(resolveRailModel("cus-resp/gpt-5.6-sol:max", {
		...context(),
		scopedModels: [],
	} as any), {
		provider: "cus-resp",
		modelId: "gpt-5.6-sol",
		name: "GPT 5.6 Sol",
		thinkingLevel: "max",
	});
});

test("resolveRailModel treats a complete colon-bearing model id as exact before parsing thinking", () => {
	assert.deepEqual(resolveRailModel("openrouter/vendor/model:exacto", {
		...context(),
		scopedModels: [],
	} as any), {
		provider: "openrouter",
		modelId: "vendor/model:exacto",
		name: "Exacto",
	});
});

test("resolveRailModel defaults to the current Pi model", () => {
	assert.deepEqual(resolveRailModel(undefined, context() as any), {
		provider: "cus-resp",
		modelId: "gpt-5.6-sol",
		name: "GPT 5.6 Sol",
		thinkingLevel: "high",
	});
});
