import assert from "node:assert/strict";
import { test } from "node:test";
import {
	installRailFast,
	railFastFooterLabel,
	supportsRailFastModel,
	withPriorityServiceTier,
} from "../../commands/rail-fast";

test("recognizes only supported OpenAI fast models", () => {
	assert.equal(supportsRailFastModel({ api: "openai-responses", id: "gpt-5.6-sol" }), true);
	assert.equal(supportsRailFastModel({ api: "openai-codex-responses", id: "gpt-5.5" }), true);
	assert.equal(supportsRailFastModel({ api: "openai-completions", id: "gpt-5.6-sol" }), false);
	assert.equal(supportsRailFastModel({ api: "openai-responses", id: "gpt-5.4-mini" }), false);
});

test("adds the priority service tier without mutating the payload", () => {
	const payload = { model: "gpt-5.6-sol", stream: true };
	const result = withPriorityServiceTier(payload);

	assert.deepEqual(result, { ...payload, service_tier: "priority" });
	assert.equal("service_tier" in payload, false);
	assert.equal(withPriorityServiceTier(null), undefined);
});

test("/railfast controls provider payload injection", async () => {
	let command: any;
	const handlers = new Map<string, any>();
	const notices: string[] = [];
	const statuses: Array<string | undefined> = [];
	const pi = {
		registerCommand: (_name: string, definition: any) => { command = definition; },
		on: (event: string, handler: any) => { handlers.set(event, handler); },
	};
	const ctx = {
		hasUI: true,
		model: { api: "openai-responses", id: "gpt-5.6-sol" },
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
		},
	};

	installRailFast(pi as any);
	await handlers.get("session_start")({}, ctx);
	await command.handler("on", ctx);
	const result = handlers.get("before_provider_request")({ payload: { stream: true } }, ctx);

	assert.deepEqual(result, { stream: true, service_tier: "priority" });
	assert.equal(statuses.at(-1), "FAST");
	assert.equal(railFastFooterLabel(), "FAST");
	assert.match(notices.at(-1) ?? "", /enabled/);

	ctx.model = { api: "openai-responses", id: "gpt-5.4-mini" };
	await handlers.get("model_select")({}, ctx);
	assert.equal(handlers.get("before_provider_request")({ payload: {} }, ctx), undefined);
	assert.equal(statuses.at(-1), "FAST (inactive)");
	assert.equal(railFastFooterLabel(), "FAST inactive");

	await handlers.get("session_start")({}, ctx);
	assert.equal(railFastFooterLabel(), undefined);

	await command.handler("off", ctx);
	assert.equal(handlers.get("before_provider_request")({ payload: {} }, ctx), undefined);
});
