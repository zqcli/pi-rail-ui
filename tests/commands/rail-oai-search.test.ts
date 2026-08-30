import assert from "node:assert/strict";
import { test } from "node:test";
import {
	installRailOaiSearch,
	isGptModel,
	transformNativeSearchPayload,
} from "../../commands/rail-oai-search";
import { hostedSearchActivityForMessage } from "../../openai/hosted-search-activity";

test("recognizes GPT models by id or display name without restricting provider", () => {
	assert.equal(isGptModel({ id: "gpt-5.6-sol", name: "Custom model" }), true);
	assert.equal(isGptModel({ id: "custom-latest", name: "GPT 5.6" }), true);
	assert.equal(isGptModel({ id: "gpt-5.6-sol", name: "GPT", provider: "custom" }), true);
	assert.equal(isGptModel({ id: "claude-opus", name: "Claude Opus" }), false);
	assert.equal(isGptModel(undefined), false);
});

test("injects live hosted search, removes competing web search tools, and preserves includes", () => {
	const payload = {
		model: "gpt-5.6-sol",
		input: [],
		tools: [
			{ type: "function", name: "read", description: "Read a file" },
			{
				type: "web_search_2025_08_26",
				filters: { allowed_domains: ["openai.com"] },
				search_context_size: "high",
				external_web_access: false,
				indexed_web_access: true,
			},
			{ type: "function", name: "web_search", description: "Local search" },
			{ type: "web_search_preview_2025_03_11" },
			{ type: "web_search", external_web_access: false },
		],
		tool_choice: { type: "function", name: "web_search" },
		include: [
			"reasoning.encrypted_content",
			"web_search_call.action.sources",
			"web_search_call.action.sources",
		],
	};

	const result = transformNativeSearchPayload(
		{ id: "gpt-5.6-sol", name: "GPT 5.6" },
		"live",
		payload,
	);

	assert.notEqual(result, payload);
	assert.deepEqual(result, {
		...payload,
		tools: [
			{ type: "function", name: "read", description: "Read a file" },
			{
				filters: { allowed_domains: ["openai.com"] },
				search_context_size: "high",
				type: "web_search",
				external_web_access: true,
			},
		],
		tool_choice: "auto",
		include: ["reasoning.encrypted_content", "web_search_call.action.sources"],
	});
	assert.equal(payload.tools.length, 5);
});

test("injects cached hosted search with external access disabled", () => {
	const payload = { model: "gpt-5.6-sol", input: "Search for Pi releases", include: null };
	assert.deepEqual(
		transformNativeSearchPayload({ id: "gpt-5.6-sol", name: "GPT 5.6" }, "cached", payload),
		{
			...payload,
			tools: [{ type: "web_search", external_web_access: false }],
			include: ["web_search_call.action.sources"],
		},
	);
});

test("rewrites allowed tool choices without leaving removed search tools behind", () => {
	const payload = {
		model: "gpt-5.6-sol",
		input: [],
		tool_choice: {
			type: "allowed_tools",
			mode: "required",
			tools: [
				{ type: "function", name: "read" },
				{ type: "web_search_preview_2025_03_11" },
				{ type: "function", name: "web_search" },
			],
		},
	};
	const result = transformNativeSearchPayload(
		{ id: "gpt-5.6-sol", name: "GPT 5.6" },
		"live",
		payload,
	) as Record<string, any>;

	assert.deepEqual(result["tool_choice"], {
		type: "allowed_tools",
		mode: "required",
		tools: [{ type: "function", name: "read" }, { type: "web_search" }],
	});
});

test("leaves disabled, non-GPT, non-Responses, and malformed payloads unchanged", () => {
	const model = { id: "gpt-5.6-sol", name: "GPT 5.6" };
	const responsesPayload = { model: "gpt-5.6-sol", input: [] };
	const completionsPayload = { model: "gpt-5.6-sol", messages: [] };
	const malformedTools = { model: "gpt-5.6-sol", input: [], tools: {} };
	const malformedInclude = { model: "gpt-5.6-sol", input: [], include: "sources" };

	assert.equal(transformNativeSearchPayload(model, "off", responsesPayload), responsesPayload);
	assert.equal(
		transformNativeSearchPayload({ id: "claude-opus", name: "Claude" }, "live", responsesPayload),
		responsesPayload,
	);
	assert.equal(transformNativeSearchPayload(model, "live", completionsPayload), completionsPayload);
	assert.equal(transformNativeSearchPayload(model, "live", malformedTools), malformedTools);
	assert.equal(transformNativeSearchPayload(model, "live", malformedInclude), malformedInclude);
	assert.equal(transformNativeSearchPayload(model, "live", null), null);
});

test("/rail-oai-search keeps the selected mode across model switches", async () => {
	let commandName: string | undefined;
	let command: any;
	const handlers = new Map<string, any>();
	const notices: string[] = [];
	const statuses: Array<string | undefined> = [];
	const providerConfigs = new Map<string, any>();
	let waitForIdleCalls = 0;
	const provider: any = {
		streamSimple: () => ({}),
	};
	const pi = {
		registerCommand: (name: string, definition: any) => {
			commandName = name;
			command = definition;
		},
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerProvider: (providerId: string, config: any) => {
			providerConfigs.set(providerId, { ...(providerConfigs.get(providerId) ?? {}), ...config });
		},
		unregisterProvider: (providerId: string) => providerConfigs.delete(providerId),
		appendEntry: () => {},
	};
	const ctx: any = {
		hasUI: true,
		model: { provider: "custom", api: "openai-responses", id: "gpt-5.6-sol", name: "GPT 5.6" },
		waitForIdle: async () => { waitForIdleCalls += 1; },
		sessionManager: { getBranch: () => [] },
		modelRegistry: {
			getProvider: () => provider,
			getRegisteredProviderConfig: (providerId: string) => providerConfigs.get(providerId),
			getRegisteredNativeProvider: () => undefined,
		},
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
		},
	};

	installRailOaiSearch(pi as any);
	assert.equal(commandName, "rail-oai-search");
	await handlers.get("session_start")({}, ctx);
	assert.equal(statuses.at(-1), undefined);

	await command.handler("live", ctx);
	assert.equal(statuses.at(-1), "SEARCH LIVE");
	assert.match(notices.at(-1) ?? "", /live/);
	await handlers.get("turn_start")({}, ctx);
	const livePayload = await handlers.get("before_provider_request")(
		{ payload: { model: "gpt-5.6-sol", input: [] } },
		ctx,
	);
	assert.deepEqual(livePayload.tools, [{ type: "web_search", external_web_access: true }]);
	await handlers.get("turn_end")({ message: { provider: "custom", model: "gpt-5.6-sol", stopReason: "stop" } }, ctx);

	ctx.model = { provider: "custom", api: "anthropic-messages", id: "claude-opus", name: "Claude" };
	await handlers.get("model_select")({}, ctx);
	assert.equal(statuses.at(-1), "SEARCH LIVE (inactive)");
	assert.equal(
		await handlers.get("before_provider_request")(
			{ payload: { model: "claude-opus", messages: [] } },
			ctx,
		),
		undefined,
	);
	ctx.model = { provider: "custom", api: "openai-completions", id: "gpt-4.1", name: "GPT 4.1" };
	await handlers.get("model_select")({}, ctx);
	assert.equal(statuses.at(-1), "SEARCH LIVE (inactive)");

	ctx.model = { provider: "another", api: "cus-resp", id: "custom-gpt", name: "Custom GPT" };
	await handlers.get("model_select")({}, ctx);
	assert.equal(statuses.at(-1), "SEARCH LIVE");
	await handlers.get("turn_start")({}, ctx);
	const resumedLivePayload = await handlers.get("before_provider_request")(
		{ payload: { model: "custom-gpt", input: [] } },
		ctx,
	);
	assert.deepEqual(resumedLivePayload.tools, [{ type: "web_search", external_web_access: true }]);
	await handlers.get("turn_end")({ message: { provider: "another", model: "custom-gpt", stopReason: "stop" } }, ctx);

	await command.handler("cached", ctx);
	await handlers.get("turn_start")({}, ctx);
	const cachedPayload = await handlers.get("before_provider_request")(
		{ payload: { model: "custom-gpt", input: [] } },
		ctx,
	);
	assert.deepEqual(cachedPayload.tools, [{ type: "web_search", external_web_access: false }]);
	await handlers.get("turn_end")({ message: { provider: "another", model: "custom-gpt", stopReason: "stop" } }, ctx);

	await command.handler("probe", ctx);
	assert.equal(statuses.at(-1), "SEARCH LIVE · PROBE NEXT");
	await handlers.get("turn_start")({}, ctx);
	const probePayload = await handlers.get("before_provider_request")(
		{ payload: { model: "custom-gpt", input: [], tools: [{ type: "function", name: "read" }] } },
		ctx,
	);
	assert.deepEqual(probePayload.tool_choice, {
		type: "allowed_tools",
		mode: "required",
		tools: [{ type: "web_search" }],
	});
	assert.equal(statuses.at(-1), "SEARCH LIVE");
	const afterProbePayload = await handlers.get("before_provider_request")(
		{ payload: { model: "custom-gpt", input: [] } },
		ctx,
	);
	assert.equal(afterProbePayload.tool_choice, undefined);
	await handlers.get("turn_end")({ message: { provider: "another", model: "custom-gpt", stopReason: "stop" } }, ctx);

	await command.handler("off", ctx);
	assert.equal(statuses.at(-1), undefined);
	assert.equal(
		await handlers.get("before_provider_request")(
			{ payload: { model: "custom-gpt", input: [] } },
			ctx,
		),
		undefined,
	);

	await command.handler("status", ctx);
	assert.match(notices.at(-1) ?? "", /Usage: \/rail-oai-search live\|cached\|off\|probe/);
	assert.equal(waitForIdleCalls, 4);
	await handlers.get("session_shutdown")({}, ctx);
});

test("persists observed search state before the assistant entry without requiring a response id", async () => {
	let command: any;
	let lastStreamOptions: any;
	const handlers = new Map<string, any>();
	const providerConfigs = new Map<string, any>();
	const entries: any[] = [];
	const model: any = {
		provider: "custom",
		api: "openai-responses",
		id: "gpt-5.6-luna",
		name: "GPT 5.6 Luna",
	};
	const provider: any = {
		streamSimple: (_model: unknown, _context: unknown, options: unknown) => {
			lastStreamOptions = options;
			return {};
		},
	};
	const pi: any = {
		registerCommand: (_name: string, definition: any) => { command = definition; },
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerProvider: (providerId: string, config: any) => {
			providerConfigs.set(providerId, { ...(providerConfigs.get(providerId) ?? {}), ...config });
		},
		unregisterProvider: (providerId: string) => providerConfigs.delete(providerId),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	};
	const ctx: any = {
		hasUI: false,
		model,
		waitForIdle: async () => {},
		sessionManager: { getBranch: () => entries },
		modelRegistry: {
			getProvider: () => provider,
			getRegisteredProviderConfig: (providerId: string) => providerConfigs.get(providerId),
			getRegisteredNativeProvider: () => undefined,
		},
		ui: { setStatus() {}, notify() {} },
	};

	installRailOaiSearch(pi);
	await handlers.get("session_start")({}, ctx);
	await command.handler("live", ctx);
	await handlers.get("turn_start")({}, ctx);
	const wrapper = providerConfigs.get("custom").streamSimple;
	const body = [
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				id: "ws_no_response_id",
				type: "web_search_call",
				status: "completed",
				action: { type: "search", query: "session persistence" },
			},
		})}\n\n`,
		"data: [DONE]\n\n",
	].join("");
	wrapper(model, {}, {
		fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
	});
	await lastStreamOptions.fetch("https://example.com/v1/responses");
	const assistant = { role: "assistant", provider: "custom", model: "gpt-5.6-luna", timestamp: 4242, content: [], stopReason: "stop" };
	await handlers.get("message_start")({ message: assistant }, ctx);
	await handlers.get("message_end")({ message: assistant }, ctx);

	assert.equal(entries.length, 1);
	assert.equal(entries[0].data.responseId, undefined);
	assert.equal(entries[0].data.assistantTimestamp, 4242);
	assert.equal(entries[0].data.calls[0].query, "session persistence");
	assert.equal(hostedSearchActivityForMessage({
		provider: "custom",
		model: "gpt-5.6-luna",
		timestamp: 4242,
	})?.observed, true);
	await handlers.get("session_tree")({}, ctx);
	assert.equal(hostedSearchActivityForMessage({
		provider: "custom",
		model: "gpt-5.6-luna",
		timestamp: 4242,
	})?.observed, true);
	await handlers.get("turn_end")({}, ctx);
});
