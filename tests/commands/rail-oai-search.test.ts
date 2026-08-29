import assert from "node:assert/strict";
import { test } from "node:test";
import {
	installRailOaiSearch,
	isGptModel,
	transformNativeSearchPayload,
} from "../../commands/rail-oai-search";

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
	const pi = {
		registerCommand: (name: string, definition: any) => {
			commandName = name;
			command = definition;
		},
		on: (event: string, handler: any) => handlers.set(event, handler),
	};
	const ctx: any = {
		hasUI: true,
		model: { provider: "custom", api: "openai-responses", id: "gpt-5.6-sol", name: "GPT 5.6" },
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
	const livePayload = await handlers.get("before_provider_request")(
		{ payload: { model: "gpt-5.6-sol", input: [] } },
		ctx,
	);
	assert.deepEqual(livePayload.tools, [{ type: "web_search", external_web_access: true }]);

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
	const resumedLivePayload = await handlers.get("before_provider_request")(
		{ payload: { model: "custom-gpt", input: [] } },
		ctx,
	);
	assert.deepEqual(resumedLivePayload.tools, [{ type: "web_search", external_web_access: true }]);

	await command.handler("cached", ctx);
	const cachedPayload = await handlers.get("before_provider_request")(
		{ payload: { model: "custom-gpt", input: [] } },
		ctx,
	);
	assert.deepEqual(cachedPayload.tools, [{ type: "web_search", external_web_access: false }]);

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
	assert.match(notices.at(-1) ?? "", /Usage: \/rail-oai-search live\|cached\|off/);
	await handlers.get("session_shutdown")({}, ctx);
});
