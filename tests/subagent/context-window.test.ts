import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import installRailContextExtension from "../../tools/subagents/context-extension";
import { CONTEXT_COMMAND, CONTEXT_PROTOCOL_FLAG, CONTEXT_PROTOCOL_VERSION, CONTEXT_WINDOW_FLAG, normalizeContextWindow, parseContextWindowFlag, validateContextWindowReserve } from "../../tools/subagents/context-window";

test("contextWindow accepts only positive safe integers and preserves omission", () => {
	assert.equal(normalizeContextWindow(undefined), undefined);
	for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "64000", null, true]) {
		assert.throws(() => normalizeContextWindow(value), /contextWindow/);
	}
	assert.equal(normalizeContextWindow(1), 1);
	assert.equal(normalizeContextWindow(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

test("contextWindow reserve validation uses the effective compaction setting", () => {
	assert.throws(() => validateContextWindowReserve(16_384, 16_384, true), /reserveTokens/);
	assert.equal(validateContextWindowReserve(16_385, 16_384, true), 16_385);
	assert.equal(validateContextWindowReserve(1, 16_384, false), 1);
	assert.equal(parseContextWindowFlag("64000"), 64_000);
	assert.throws(() => parseContextWindowFlag("064000"), /decimal/);
});

test("child context extension restores the selected object's original value", async () => {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const flags = new Map<string, string>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const pi: any = {
		registerFlag: (_name: string) => undefined,
		getFlag: (name: string) => flags.get(name),
		on: (event: string, handler: (value: any, ctx: any) => unknown) => handlers.set(event, handler),
		registerCommand: (name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => commands.set(name, options.handler),
	};
	installRailContextExtension(pi);
	const reserve = SettingsManager.create(process.cwd()).getCompactionReserveTokens();
	const budget = reserve + 1;
	const canonical = { provider: "test", id: "model", contextWindow: reserve + 100_000 };
	const current = { ...canonical };
	const ctx = {
		cwd: process.cwd(),
		model: current,
		modelRegistry: { find: () => canonical },
	};
	flags.set(CONTEXT_PROTOCOL_FLAG, CONTEXT_PROTOCOL_VERSION);
	flags.set(CONTEXT_WINDOW_FLAG, String(budget));
	await handlers.get("session_start")?.({}, ctx);
	assert.equal(current.contextWindow, budget);
	await commands.get(CONTEXT_COMMAND)!("reset", ctx);
	assert.equal(current.contextWindow, canonical.contextWindow);

	const sessionLocal = { provider: "test", id: "model", contextWindow: 150_000 };
	ctx.model = sessionLocal;
	await commands.get(CONTEXT_COMMAND)!("prepare " + budget, ctx);
	await handlers.get("agent_settled")?.({}, ctx);
	assert.equal(sessionLocal.contextWindow, 150_000);
	await commands.get(CONTEXT_COMMAND)!("reset", ctx);
	assert.equal(sessionLocal.contextWindow, 150_000);

	await commands.get(CONTEXT_COMMAND)!("prepare " + budget, ctx);
	ctx.model = { ...sessionLocal, contextWindow: 150_000 };
	await handlers.get("turn_start")?.({}, ctx);
	assert.equal(sessionLocal.contextWindow, 150_000);
	assert.equal(ctx.model.contextWindow, budget);
	await handlers.get("agent_settled")?.({}, ctx);
	assert.equal(ctx.model.contextWindow, 150_000);
	await commands.get(CONTEXT_COMMAND)!("reset", ctx);
	assert.equal(ctx.model.contextWindow, 150_000);
	await handlers.get("model_select")?.({ model: ctx.model, previousModel: undefined, source: "set" }, ctx);
	assert.equal(ctx.model.contextWindow, 150_000);

	await commands.get(CONTEXT_COMMAND)!("prepare " + budget, ctx);
	ctx.model.contextWindow = 65_000;
	await assert.rejects(() => commands.get(CONTEXT_COMMAND)!("reset", ctx), /changed before cleanup/);
	assert.equal(ctx.model.contextWindow, 65_000);

	const frozenHandlers = new Map<string, (event: any, ctx: any) => unknown>();
	const frozenFlags = new Map<string, string>();
	const frozenPi: any = {
		registerFlag: (_name: string) => undefined,
		getFlag: (name: string) => frozenFlags.get(name),
		on: (event: string, handler: (value: any, ctx: any) => unknown) => frozenHandlers.set(event, handler),
		registerCommand: () => undefined,
	};
	installRailContextExtension(frozenPi);
	frozenFlags.set(CONTEXT_PROTOCOL_FLAG, CONTEXT_PROTOCOL_VERSION);
	frozenFlags.set(CONTEXT_WINDOW_FLAG, String(budget));
	const errors: string[] = [];
	const originalError = console.error;
	console.error = (message: string) => errors.push(message);
	try {
		await frozenHandlers.get("session_start")?.({}, { cwd: process.cwd(), model: Object.freeze({ provider: "test", id: "model", contextWindow: 150_000 }) });
	} finally {
		console.error = originalError;
	}
	assert.match(errors[0] ?? "", /rail-context-protocol-error/);
	assert.deepEqual(frozenHandlers.get("input")?.({}, { cwd: process.cwd(), model: Object.freeze({ provider: "test", id: "model", contextWindow: 150_000 }) }), { action: "handled" });
});