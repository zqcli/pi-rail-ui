import assert from "node:assert/strict";
import { test } from "node:test";
import { isGptModel } from "../../openai/model-eligibility";
import { supportsNativeGptFastMode } from "../../commands/rail-fast";
import { supportsNativeGptSearch } from "../../commands/rail-oai-search";
import { modelSupportsRemoteCompaction } from "../../tools/gpt-compaction/model-eligibility";

/**
 * The shared rule matches an independent `gpt` token anywhere in the model id
 * or display name, case-insensitively, and never looks at the provider id.
 * These boundaries are the contract Fast, Search, and remote compaction all
 * consume, so a regression here has to fail in one place.
 */
test("shared GPT matching accepts delimited tokens anywhere in the id", () => {
	for (const id of ["gpt", "GPT", "gpt-5.6-sol", "GPT-4.1", "custom-gpt", "gpt_5", "gpt:1", "openai/gpt", "my.gpt.x", "-gpt-", "gpt-"]) {
		assert.equal(isGptModel({ id }), true, `id ${JSON.stringify(id)} must match`);
	}
});

test("shared GPT matching does not treat the token as an arbitrary substring", () => {
	for (const id of ["gptx", "xgpt", "agptb", "gpt5", "5gpt", "deepseek-gptv4", "chatgptish"]) {
		assert.equal(isGptModel({ id }), false, `id ${JSON.stringify(id)} must not match`);
	}
});

test("shared GPT matching is case-insensitive on both id and name", () => {
	assert.equal(isGptModel({ id: "GpT-5.6" }), true);
	assert.equal(isGptModel({ id: "gPt_5" }), true);
	assert.equal(isGptModel({ name: "gPt 5.6" }), true);
	assert.equal(isGptModel({ name: "GPT 5.6 Sol" }), true);
	assert.equal(isGptModel({ name: "Custom GPT" }), true);
});

test("shared GPT matching treats id and name independently and rejects empty input", () => {
	assert.equal(isGptModel({ id: "gpt-5.6-sol", name: "Custom model" }), true, "GPT id wins over a non-GPT name");
	assert.equal(isGptModel({ id: "custom-latest", name: "GPT 5.6" }), true, "GPT name wins over a non-GPT id");
	assert.equal(isGptModel({ id: "claude-opus", name: "Claude Opus" }), false);
	assert.equal(isGptModel({ id: "deepseek-v4" }), false);
	assert.equal(isGptModel({ name: " " }), false);
	assert.equal(isGptModel({ id: "", name: "" }), false);
	assert.equal(isGptModel({}), false);
	assert.equal(isGptModel(undefined), false);
});

test("shared GPT matching ignores the provider id and API", () => {
	const custom = { id: "gpt-5.6-sol", name: "GPT 5.6", provider: "custom", api: "openai-responses" };
	const customNamed = { id: "custom-latest", name: "GPT 5.6", provider: "another-provider", api: "cus-resp" };
	const namedNonGpt = { id: "claude-opus", name: "Claude Opus", provider: "openai", api: "anthropic-messages" };
	assert.equal(isGptModel(custom), true);
	assert.equal(isGptModel(customNamed), true);
	assert.equal(isGptModel(namedNonGpt), false);
});

/** Models that all three features must agree on when they share `openai-responses`. */
const RESPONSES_GPT_MODELS = [
	{ provider: "openai", api: "openai-responses", id: "gpt-5.6-sol", name: "GPT 5.6 Sol", baseUrl: "https://gateway.example/v1" },
	{ provider: "custom", api: "openai-responses", id: "custom-latest", name: "GPT 5.6", baseUrl: "https://gateway.example/v1" },
	{ provider: "another", api: "openai-responses", id: "GPT-4.1", baseUrl: "https://gateway.example/v1" },
];
const RESPONSES_NON_GPT_MODELS = [
	{ provider: "openai", api: "openai-responses", id: "deepseek-v4", name: "DeepSeek V4", baseUrl: "https://gateway.example/v1" },
	{ provider: "custom", api: "openai-responses", id: "claude-opus", name: "Claude Opus", baseUrl: "https://gateway.example/v1" },
	{ provider: "another", api: "openai-responses", id: "custom-latest", name: "Custom latest", baseUrl: "https://gateway.example/v1" },
];

test("Fast, Search, and remote compaction agree on the shared GPT decision for a supported Responses API", () => {
	for (const model of RESPONSES_GPT_MODELS) {
		assert.equal(isGptModel(model), true, `${model.id}: shared rule`);
		assert.equal(supportsNativeGptFastMode(model), true, `${model.id}: Fast`);
		assert.equal(supportsNativeGptSearch(model), true, `${model.id}: Search`);
		assert.equal(modelSupportsRemoteCompaction(model as any).supported, true, `${model.id}: compaction`);
	}
	for (const model of RESPONSES_NON_GPT_MODELS) {
		assert.equal(isGptModel(model), false, `${model.id}: shared rule`);
		assert.equal(supportsNativeGptFastMode(model), false, `${model.id}: Fast`);
		assert.equal(supportsNativeGptSearch(model), false, `${model.id}: Search`);
		assert.equal(modelSupportsRemoteCompaction(model as any).supported, false, `${model.id}: compaction`);
	}
});

test("each feature keeps its own supported-API scope while sharing the GPT token rule", () => {
	const completionsGpt = { provider: "custom", api: "openai-completions", id: "gpt-4.1", name: "GPT 4.1", baseUrl: "https://gateway.example/v1" };
	const azureGpt = { provider: "azure", api: "azure-openai-responses", id: "gpt-4.1", name: "GPT-4.1", baseUrl: "https://azure.example/v1" };
	const codexGpt = { provider: "custom", api: "openai-codex-responses", id: "gpt-local-codex", name: "GPT local codex", baseUrl: "https://codex.example/v1" };
	const customResponsesGpt = { provider: "custom", api: "cus-resp", id: "custom-gpt", name: "Custom GPT", baseUrl: "https://gateway.example/v1" };

	// Fast rewrites only the three native OpenAI-compatible APIs.
	assert.equal(supportsNativeGptFastMode(completionsGpt), true);
	assert.equal(supportsNativeGptFastMode(azureGpt), true);
	assert.equal(supportsNativeGptFastMode(codexGpt), false);
	assert.equal(supportsNativeGptFastMode(customResponsesGpt), false);

	// Search allows any non-blocklisted Responses-shaped API, including custom ones.
	assert.equal(supportsNativeGptSearch(completionsGpt), false);
	assert.equal(supportsNativeGptSearch(azureGpt), true);
	assert.equal(supportsNativeGptSearch(codexGpt), true);
	assert.equal(supportsNativeGptSearch(customResponsesGpt), true);

	// Remote compaction v2 covers the two Responses APIs Pi implements.
	assert.equal(modelSupportsRemoteCompaction(completionsGpt as any).supported, false);
	assert.equal(modelSupportsRemoteCompaction(azureGpt as any).supported, false);
	assert.equal(modelSupportsRemoteCompaction(codexGpt as any).supported, true);
	assert.equal(modelSupportsRemoteCompaction(customResponsesGpt as any).supported, false);

	// A non-GPT id stays rejected everywhere regardless of the API.
	for (const model of [completionsGpt, azureGpt, codexGpt, customResponsesGpt]) {
		const nonGpt = { ...model, id: "deepseek-v4", name: "DeepSeek V4" };
		assert.equal(isGptModel(nonGpt), false, `${model.api}: shared rule`);
		assert.equal(supportsNativeGptFastMode(nonGpt), false, `${model.api}: Fast`);
		assert.equal(supportsNativeGptSearch(nonGpt), false, `${model.api}: Search`);
		assert.equal(modelSupportsRemoteCompaction(nonGpt as any).supported, false, `${model.api}: compaction`);
	}
});
