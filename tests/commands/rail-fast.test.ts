import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyNativeFastMode,
	installRailFast,
	RAIL_FAST_MODE_FLAG,
	railFastFooterLabel,
	restoreNativeFastMode,
	supportsNativeGptFastMode,
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

test("/rail-oai-fast toggles the native model parameter without a provider hook", async () => {
	restoreNativeFastMode();
	let commandName: string | undefined;
	let command: any;
	const handlers = new Map<string, any>();
	const notices: string[] = [];
	const statuses: Array<string | undefined> = [];
	const pi = {
		events: { emit: () => undefined, on: () => () => undefined },
		registerCommand: (name: string, definition: any) => {
			commandName = name;
			command = definition;
		},
		registerFlag: () => undefined,
		getFlag: () => undefined,
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
	assert.equal(commandName, "rail-oai-fast");
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

test("child startup flag enables fast before the first provider request", async () => {
	restoreNativeFastMode();
	let startupFlag: string | undefined;
	let getFlag: (() => boolean | string | undefined) | undefined;
	const handlers = new Map<string, any>();
	const pi = {
		events: { emit: () => undefined, on: () => () => undefined },
		registerCommand: () => undefined,
		registerFlag: (name: string) => { startupFlag = name; },
		getFlag: () => getFlag?.(),
		on: (event: string, handler: any) => { handlers.set(event, handler); },
	};
	const model: any = { api: "openai-responses", id: "gpt-5.6-sol" };
	const ctx: any = {
		hasUI: false,
		model,
		ui: { setStatus: () => undefined },
	};

	installRailFast(pi as any);
	assert.equal(startupFlag, RAIL_FAST_MODE_FLAG);
	getFlag = () => true;
	await handlers.get("session_start")({}, ctx);
	assert.deepEqual(model.samplingParams, { service_tier: "priority" });
	await handlers.get("session_shutdown")({}, ctx);

	ctx.model = { api: "openai-responses", id: "deepseek-v4", name: "DeepSeek V4" };
	await handlers.get("session_start")({}, ctx);
	assert.equal("samplingParams" in ctx.model, false);
	await handlers.get("session_shutdown")({}, ctx);
});

test("subagent fast eligibility requires GPT naming and the native supported API", () => {
	assert.equal(supportsNativeGptFastMode({ api: "openai-responses", id: "gpt-5.6-sol" }), true);
	assert.equal(supportsNativeGptFastMode({ api: "openai-responses", id: "deepseek-v4" }), false);
	assert.equal(supportsNativeGptFastMode({ api: "openai-codex-responses", id: "gpt-5.6-sol" }), false);
	assert.equal(supportsNativeGptFastMode({ api: "openai-responses", id: "custom-model", name: "GPT custom" }), true);
});

test("root and standalone installers share one Fast registration through Pi's event bus", () => {
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	let commands = 0;
	let flags = 0;
	const pi = {
		events: {
			emit: (event: string, data: unknown) => listeners.get(event)?.forEach((listener) => listener(data)),
			on: (event: string, listener: (data: unknown) => void) => {
				const registered = listeners.get(event) ?? [];
				registered.push(listener);
				listeners.set(event, registered);
				return () => undefined;
			},
		},
		registerCommand: () => { commands += 1; },
		registerFlag: () => { flags += 1; },
		getFlag: () => undefined,
		on: () => undefined,
	};

	installRailFast(pi as any);
	installRailFast(pi as any);

	assert.equal(commands, 1);
	assert.equal(flags, 1);
});
