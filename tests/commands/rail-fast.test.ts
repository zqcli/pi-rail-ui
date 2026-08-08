import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyNativeFastMode,
	installRailFast,
	railFastFooterLabel,
	restoreNativeFastMode,
	supportsNativeFastMode,
} from "../../commands/rail-fast";

test("uses Pi native fast mode for every supported OpenAI-compatible API", () => {
	assert.equal(supportsNativeFastMode({ api: "openai-completions", id: "chat-model" }), true);
	assert.equal(supportsNativeFastMode({ api: "openai-responses", id: "future-model" }), true);
	assert.equal(supportsNativeFastMode({ api: "azure-openai-responses", id: "azure-model" }), true);
	assert.equal(supportsNativeFastMode({ api: "openai-codex-responses", id: "codex-model" }), false);
	assert.equal(supportsNativeFastMode({ api: "anthropic-messages", id: "claude" }), false);
	assert.equal(supportsNativeFastMode(undefined), false);
});

test("applies and restores service_tier through model samplingParams", () => {
	restoreNativeFastMode();
	const originalSamplingParams = { temperature: 0.2, service_tier: "flex" };
	const model = { api: "openai-responses", id: "gpt-5.6-sol", samplingParams: originalSamplingParams };

	assert.equal(applyNativeFastMode(model), true);
	assert.notEqual(model.samplingParams, originalSamplingParams);
	assert.deepEqual(model.samplingParams, { temperature: 0.2, service_tier: "priority" });
	assert.deepEqual(originalSamplingParams, { temperature: 0.2, service_tier: "flex" });

	restoreNativeFastMode();
	assert.equal(model.samplingParams, originalSamplingParams);

	const modelWithoutParams: { api: string; id: string; samplingParams?: Record<string, unknown> } = {
		api: "openai-responses",
		id: "gpt-5.6-terra",
	};
	assert.equal(applyNativeFastMode(modelWithoutParams), true);
	assert.deepEqual(modelWithoutParams.samplingParams, { service_tier: "priority" });
	restoreNativeFastMode();
	assert.equal("samplingParams" in modelWithoutParams, false);
});

test("/railfast toggles the native model parameter without a provider hook", async () => {
	restoreNativeFastMode();
	let command: any;
	const handlers = new Map<string, any>();
	const notices: string[] = [];
	const statuses: Array<string | undefined> = [];
	const pi = {
		registerCommand: (_name: string, definition: any) => { command = definition; },
		on: (event: string, handler: any) => { handlers.set(event, handler); },
	};
	const ctx: any = {
		hasUI: true,
		model: { api: "openai-responses", id: "custom-model" },
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
		},
	};

	installRailFast(pi as any);
	assert.equal(handlers.has("before_provider_request"), false);
	await handlers.get("session_start")({}, ctx);
	await command.handler("on", ctx);
	assert.deepEqual(ctx.model.samplingParams, { service_tier: "priority" });
	assert.equal(statuses.at(-1), "FAST");
	assert.equal(railFastFooterLabel(), "FAST");
	assert.match(notices.at(-1) ?? "", /enabled/);
	const activeSamplingParams = ctx.model.samplingParams;
	await command.handler("status", ctx);
	assert.equal(ctx.model.samplingParams, activeSamplingParams);

	const previousModel = ctx.model;
	ctx.model = { api: "anthropic-messages", id: "claude" };
	await handlers.get("model_select")({}, ctx);
	assert.equal("samplingParams" in previousModel, false);
	assert.equal(statuses.at(-1), "FAST (inactive)");
	assert.equal(railFastFooterLabel(), "FAST inactive");

	ctx.model = { api: "openai-responses", id: "second-model" };
	await handlers.get("model_select")({}, ctx);
	assert.deepEqual(ctx.model.samplingParams, { service_tier: "priority" });
	await handlers.get("session_shutdown")({}, ctx);
	assert.equal("samplingParams" in ctx.model, false);
	assert.equal(railFastFooterLabel(), undefined);
});
