import assert from "node:assert/strict";
import { test } from "node:test";
import {
	installRailFast,
	RAIL_FAST_MODE_FLAG,
	railFastFooterLabel,
	supportsNativeGptFastMode,
	supportsNativeFastMode,
} from "../../commands/rail-fast";

function setupFast(getFlag: () => boolean | string | undefined = () => undefined) {
	let command: any;
	let flag: string | undefined;
	const handlers = new Map<string, any>();
	const pi = {
		events: { emit: () => undefined, on: () => () => undefined },
		registerCommand: (_name: string, definition: any) => { command = definition; },
		registerFlag: (name: string) => { flag = name; },
		getFlag,
		on: (event: string, handler: any) => { handlers.set(event, handler); },
	};
	installRailFast(pi as any);
	return { command, handlers, flag: flag! };
}

function context(model: any, statuses?: Array<string | undefined>, notices?: string[]) {
	return {
		hasUI: statuses !== undefined || notices !== undefined,
		model,
		ui: {
			setStatus: (_key: string, value: string | undefined) => statuses?.push(value),
			notify: (message: string) => notices?.push(message),
		},
	};
}

test("uses Pi native fast mode for every supported OpenAI-compatible API", () => {
	assert.equal(supportsNativeFastMode({ api: "openai-completions", id: "chat-model" }), true);
	assert.equal(supportsNativeFastMode({ api: "openai-responses", id: "future-model" }), true);
	assert.equal(supportsNativeFastMode({ api: "azure-openai-responses", id: "azure-model" }), true);
	assert.equal(supportsNativeFastMode({ api: "openai-codex-responses", id: "codex-model" }), false);
	assert.equal(supportsNativeFastMode({ api: "anthropic-messages", id: "claude" }), false);
	assert.equal(supportsNativeFastMode(undefined), false);
});

test("subagent fast eligibility requires GPT naming and the native supported API", () => {
	assert.equal(supportsNativeGptFastMode({ api: "openai-responses", id: "gpt-5.6-sol" }), true);
	assert.equal(supportsNativeGptFastMode({ api: "openai-completions", id: "gpt-4.1" }), true);
	assert.equal(supportsNativeGptFastMode({ api: "openai-responses", id: "deepseek-v4" }), false);
	assert.equal(supportsNativeGptFastMode({ api: "openai-codex-responses", id: "gpt-5.6-sol" }), false);
	assert.equal(supportsNativeGptFastMode({ api: "openai-responses", id: "custom-model", name: "GPT custom" }), true);
	assert.equal(supportsNativeGptFastMode({ id: "gpt-5.6-sol" } as any), false);
});

test("injects service_tier into eligible GPT provider payloads without mutating models", async () => {
	const { command, handlers } = setupFast();
	const gptModel = { api: "openai-responses", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" };
	const ctx = context(gptModel);
	await handlers.get("session_start")({}, ctx);
	assert.equal(handlers.has("before_provider_request"), true);

	const payload = { model: "gpt-5.6-sol", input: [] };
	assert.equal(await handlers.get("before_provider_request")({ payload }, ctx), undefined, "policy off leaves the payload untouched");
	await command.handler("on", ctx);
	const injected = await handlers.get("before_provider_request")({ payload }, ctx);
	assert.deepEqual(injected, { ...payload, service_tier: "priority" });
	assert.notEqual(injected, payload);
	assert.equal("samplingParams" in gptModel, false, "fast mode must not mutate the active model");
	assert.equal(
		await handlers.get("before_provider_request")({ payload: { ...payload, service_tier: "priority" } }, ctx),
		undefined,
		"an already-priority payload is not copied again",
	);
	await command.handler("off", ctx);
	assert.equal(await handlers.get("before_provider_request")({ payload }, ctx), undefined);
	await handlers.get("session_shutdown")({}, ctx);
});

test("/rail-oai-fast toggles request-time service_tier and status", async () => {
	const statuses: Array<string | undefined> = [];
	const notices: string[] = [];
	const { command, handlers, flag } = setupFast();
	assert.equal(flag, RAIL_FAST_MODE_FLAG);
	const ctx = context({ api: "openai-responses", id: "custom-model", name: "Custom GPT" }, statuses, notices);

	await handlers.get("session_start")({}, ctx);
	await command.handler("on", ctx);
	assert.equal(statuses.at(-1), "FAST");
	assert.equal(railFastFooterLabel(), "FAST");
	assert.match(notices.at(-1) ?? "", /enabled/);
	assert.deepEqual(
		await handlers.get("before_provider_request")({ payload: { model: "custom-model", input: [] } }, ctx),
		{ model: "custom-model", input: [], service_tier: "priority" },
	);

	await command.handler("status", ctx);
	assert.equal(statuses.at(-1), "FAST");
	await command.handler("off", ctx);
	assert.equal(statuses.at(-1), undefined);
	assert.equal(await handlers.get("before_provider_request")({ payload: { model: "custom-model", input: [] } }, ctx), undefined);
	await command.handler("bogus", ctx);
	assert.match(notices.at(-1) ?? "", /Usage: /);
	await handlers.get("session_shutdown")({}, ctx);
	assert.equal(railFastFooterLabel(), undefined);
});

test("parent slash eligibility is GPT-only on supported APIs and never injects for non-GPT models", async () => {
	const statuses: Array<string | undefined> = [];
	const notices: string[] = [];
	const { command, handlers } = setupFast();
	const ctx = context({ api: "openai-responses", id: "deepseek-v4", name: "DeepSeek V4" }, statuses, notices);
	const payload = { model: "probe", input: [] };

	await handlers.get("session_start")({}, ctx);
	assert.equal(statuses.at(-1), undefined, "a non-GPT model starts inactive");
	await command.handler("on", ctx);
	assert.match(notices.at(-1) ?? "", /GPT models only/, "a non-GPT on is rejected with the shared warning");
	assert.equal(statuses.at(-1), undefined, "a rejected on leaves no status");
	assert.equal(railFastFooterLabel(), undefined, "a rejected on shows no footer label");
	assert.equal(await handlers.get("before_provider_request")({ payload }, ctx), undefined);

	// A non-GPT model stays rejected across every API Fast supports, including
	// the completions API that never had a GPT gate before.
	ctx.model = { api: "openai-completions", id: "deepseek-chat", name: "DeepSeek Chat" };
	await handlers.get("model_select")({}, ctx);
	assert.equal(await handlers.get("before_provider_request")({ payload }, ctx), undefined);
	assert.equal(statuses.at(-1), undefined);

	ctx.model = { api: "anthropic-messages", id: "claude-opus", name: "Claude Opus" };
	await handlers.get("model_select")({}, ctx);
	assert.equal(await handlers.get("before_provider_request")({ payload: { messages: [] } }, ctx), undefined);
	assert.equal(statuses.at(-1), undefined);

	// Switching to a GPT model lets the same command enable the policy.
	ctx.model = { api: "openai-responses", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" };
	await handlers.get("model_select")({}, ctx);
	await command.handler("on", ctx);
	assert.deepEqual(await handlers.get("before_provider_request")({ payload }, ctx), { ...payload, service_tier: "priority" });
	assert.equal(statuses.at(-1), "FAST");
	assert.equal(railFastFooterLabel(), "FAST");

	// GPT on an unsupported API keeps the original inactive behavior.
	ctx.model = { api: "openai-codex-responses", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" };
	await handlers.get("model_select")({}, ctx);
	assert.equal(await handlers.get("before_provider_request")({ payload }, ctx), undefined, "codex stays outside the rewritten APIs");
	assert.equal(statuses.at(-1), "FAST (inactive)");

	await command.handler("off", ctx);
	assert.equal(statuses.at(-1), undefined);
	assert.equal(await handlers.get("before_provider_request")({ payload }, ctx), undefined);
	await handlers.get("session_shutdown")({}, ctx);
});

test("parent and child share the same GPT-only injection across on/off and GPT ↔ non-GPT switches", async () => {
	const statuses: Array<string | undefined> = [];
	let flagValue: boolean | undefined;
	const { command, handlers } = setupFast(() => flagValue);
	const payload = { model: "probe", input: [] };
	const gptModel = { api: "openai-responses", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" };
	const nonGptModel = { api: "openai-responses", id: "deepseek-v4", name: "DeepSeek V4" };
	const ctx = context(gptModel, statuses);

	// A parent without the child flag is off until toggled, then GPT-gated.
	flagValue = undefined;
	await handlers.get("session_start")({}, ctx);
	assert.equal(await handlers.get("before_provider_request")({ payload }, ctx), undefined, "off never injects");
	await command.handler("on", ctx);
	assert.deepEqual(await handlers.get("before_provider_request")({ payload }, ctx), { ...payload, service_tier: "priority" });

	// GPT → non-GPT: no injection and the footer hides the unavailable policy.
	ctx.model = nonGptModel;
	await handlers.get("model_select")({}, ctx);
	assert.equal(await handlers.get("before_provider_request")({ payload }, ctx), undefined);
	assert.equal(statuses.at(-1), undefined);
	assert.equal(railFastFooterLabel(), undefined);

	// Non-GPT → GPT restores injection without re-arming the command.
	ctx.model = gptModel;
	await handlers.get("model_select")({}, ctx);
	assert.deepEqual(await handlers.get("before_provider_request")({ payload }, ctx), { ...payload, service_tier: "priority" });
	assert.equal(railFastFooterLabel(), "FAST");

	// A child launched with the standalone flag behaves identically to a
	// toggled-on parent, so the two paths cannot diverge.
	flagValue = true;
	await handlers.get("session_shutdown")({}, ctx);
	ctx.model = nonGptModel;
	await handlers.get("session_start")({}, ctx);
	assert.equal(await handlers.get("before_provider_request")({ payload }, ctx), undefined, "a child non-GPT model must not inject");
	assert.equal(statuses.at(-1), undefined);

	ctx.model = gptModel;
	await handlers.get("model_select")({}, ctx);
	assert.deepEqual(await handlers.get("before_provider_request")({ payload }, ctx), { ...payload, service_tier: "priority" });
	assert.equal(statuses.at(-1), "FAST");

	// Slash toggles inside the child cannot widen the GPT scope either.
	await command.handler("off", ctx);
	assert.equal(await handlers.get("before_provider_request")({ payload }, ctx), undefined);
	await command.handler("on", ctx);
	ctx.model = nonGptModel;
	await handlers.get("model_select")({}, ctx);
	assert.equal(await handlers.get("before_provider_request")({ payload }, ctx), undefined);
	assert.equal(statuses.at(-1), undefined);

	await handlers.get("session_shutdown")({}, ctx);
});

test("child startup flag keeps fast GPT-only across a model switch and slash toggles", async () => {
	const statuses: Array<string | undefined> = [];
	let flagValue: boolean | undefined = true;
	const { command, handlers, flag } = setupFast(() => flagValue);
	assert.equal(flag, RAIL_FAST_MODE_FLAG);
	const ctx = context({ api: "openai-responses", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" }, statuses);
	const payload = { model: "probe", input: [] };

	await handlers.get("session_start")({}, ctx);
	assert.deepEqual(await handlers.get("before_provider_request")({ payload }, ctx), { ...payload, service_tier: "priority" });

	// A child may switch models in place, but it must never regain a non-GPT injection.
	ctx.model = { api: "openai-responses", id: "deepseek-v4", name: "DeepSeek V4" };
	await handlers.get("model_select")({}, ctx);
	assert.equal(await handlers.get("before_provider_request")({ payload }, ctx), undefined);
	assert.equal(statuses.at(-1), undefined);

	// Slash toggles inside the child must not lift the GPT-only restriction, and
	// a rejected `on` leaves the policy off rather than arming it for later.
	await command.handler("off", ctx);
	await command.handler("on", ctx);
	assert.equal(await handlers.get("before_provider_request")({ payload }, ctx), undefined);
	assert.equal(statuses.at(-1), undefined);
	assert.equal(railFastFooterLabel(), undefined);

	// Switching back to GPT restores injection only after a GPT-eligible `on`.
	ctx.model = { api: "openai-completions", id: "gpt-4.1", name: "GPT 4.1" };
	await handlers.get("model_select")({}, ctx);
	assert.equal(await handlers.get("before_provider_request")({ payload }, ctx), undefined, "the rejected on left the policy off");
	await command.handler("on", ctx);
	assert.deepEqual(await handlers.get("before_provider_request")({ payload }, ctx), { ...payload, service_tier: "priority" });
	assert.equal(railFastFooterLabel(), "FAST");

	// Without the startup flag the same module instance becomes a normal parent
	// session that is GPT-gated exactly like the child once toggled on.
	flagValue = undefined;
	await handlers.get("session_shutdown")({}, ctx);
	ctx.model = { api: "openai-responses", id: "deepseek-v4", name: "DeepSeek V4" };
	await handlers.get("session_start")({}, ctx);
	assert.equal(await handlers.get("before_provider_request")({ payload }, ctx), undefined, "a parent session is off until toggled on");
	await command.handler("on", ctx);
	assert.equal(
		await handlers.get("before_provider_request")({ payload }, ctx),
		undefined,
		"a non-GPT on is rejected and never arms the policy",
	);
	assert.equal(statuses.at(-1), undefined);
	ctx.model = { api: "openai-responses", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" };
	await handlers.get("model_select")({}, ctx);
	assert.equal(await handlers.get("before_provider_request")({ payload }, ctx), undefined, "still off until a GPT-eligible on");
	await command.handler("on", ctx);
	assert.deepEqual(await handlers.get("before_provider_request")({ payload }, ctx), { ...payload, service_tier: "priority" });

	await handlers.get("session_shutdown")({}, ctx);
});

test("child startup flag enables fast before the first provider request and off disarms it", async () => {
	let flagValue: boolean | undefined;
	const { command, handlers, flag } = setupFast(() => flagValue);
	assert.equal(flag, RAIL_FAST_MODE_FLAG);
	const gptModel = { api: "openai-responses", id: "gpt-5.6-sol" };
	const ctx = context(gptModel);

	flagValue = true;
	await handlers.get("session_start")({}, ctx);
	const payload = { model: "gpt-5.6-sol", input: [] };
	assert.deepEqual(await handlers.get("before_provider_request")({ payload }, ctx), { ...payload, service_tier: "priority" });
	assert.equal("samplingParams" in gptModel, false);
	await command.handler("off", ctx);
	assert.equal(await handlers.get("before_provider_request")({ payload }, ctx), undefined);
	await handlers.get("session_shutdown")({}, ctx);

	ctx.model = { api: "openai-responses", id: "deepseek-v4", name: "DeepSeek V4" };
	await handlers.get("session_start")({}, ctx);
	assert.equal(await handlers.get("before_provider_request")({ payload }, ctx), undefined);
	await handlers.get("session_shutdown")({}, ctx);
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
