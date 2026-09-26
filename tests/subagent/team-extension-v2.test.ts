import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import install from "../../tools/subagents/team-extension-v2";
import { TEAM_ACTIVATION_MESSAGE_TYPE, TEAM_ACTIVATION_TRIGGER, TEAM_COMMAND, TEAM_PRIVATE_ENTRY_TYPE } from "../../tools/subagents/team-protocol";
import type { BindingV2, ParentCommand, PrivateReply } from "../../tools/subagents/team-protocol";
import { TEAM_TOOL_DESCRIPTION, TEAM_TOOL_SCHEMA } from "../../tools/subagents/team-codec";
import { TeamRuntime } from "../../tools/subagents/team-runtime";

function nativeManagerActivation() {
	const runtime = new TeamRuntime();
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage the Team." },
		workers: [{ alias: "w1", roleDescription: "Do assigned work." }],
		brief: { goal: "Verify the private activation bridge." }, timeoutSeconds: null,
	});
	runtime.launch(prepared.teamId);
	return runtime.takeNextActivation(prepared.teamId)!;
}

function harness(role: BindingV2["role"] = "manager") {
	const activation = nativeManagerActivation();
	const binding: BindingV2 = role === "manager" ? activation.binding
		: { version: 2, teamId: activation.binding.teamId, memberId: "w1", role: "worker", epoch: "worker-epoch" };
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const entries: any[] = [];
	const branch: any[] = [];
	const activeToolUpdates: string[][] = [];
	let activeTools = ["read", "bash", "subagent", "subagent_team"];
	let aborts = 0;
	const controller = new AbortController();
	const ctx = {
		signal: controller.signal,
		abort: () => { aborts++; controller.abort(); },
		isIdle: () => true,
		sessionManager: { getBranch: () => branch },
	};
	const pi = {
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerCommand: (name: string, definition: any) => commands.set(name, definition),
		registerTool: (definition: any) => tools.set(definition.name, definition),
		getAllTools: () => [...tools.values()],
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; activeToolUpdates.push([...names]); },
		appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
	};
	install(pi as unknown as ExtensionAPI);
	const command = async (frame: ParentCommand) => commands.get(TEAM_COMMAND).handler(JSON.stringify(frame), ctx);
	const lastPrivate = () => [...entries].reverse().find((entry) => entry.customType === TEAM_PRIVATE_ENTRY_TYPE)?.data;
	const privateFrames = () => entries.filter((entry) => entry.customType === TEAM_PRIVATE_ENTRY_TYPE).map((entry) => entry.data);
	return { activation, binding, handlers, commands, tools, entries, branch, ctx, command, lastPrivate, privateFrames,
		activeTools: () => activeTools, activeToolUpdates, aborts: () => aborts };
}

function bindCommand(h: ReturnType<typeof harness>, commandId = "bind-1", binding = h.binding): ParentCommand {
	return { version: 2, commandId, operation: "bind", binding, loadout: { role: binding.role, teamTool: true } };
}

function activateCommand(h: ReturnType<typeof harness>, commandId = "activate-1"): ParentCommand {
	return { version: 2, commandId, operation: "activate", binding: h.binding, activation: h.activation.scope,
		deliveryId: h.activation.deliveryId, input: h.activation.input };
}

function appendNativeActivation(h: ReturnType<typeof harness>, beforeResult: any) {
	assert.ok(beforeResult?.message);
	h.branch.push({ type: "message", message: { role: "user", content: [{ type: "text", text: TEAM_ACTIVATION_TRIGGER }] } });
	h.branch.push({ type: "custom_message", customType: beforeResult.message.customType,
		content: beforeResult.message.content, details: beforeResult.message.details });
	return [{ role: "custom", customType: beforeResult.message.customType,
		content: beforeResult.message.content, details: beforeResult.message.details }];
}

async function replyToRequest(h: ReturnType<typeof harness>, frame: any, reply: PrivateReply, commandId: string): Promise<void> {
	await h.command({ version: 2, commandId, operation: "reply", binding: h.binding, activation: h.activation.scope,
		rpcRequestId: frame.rpcRequestId, reply });
}

async function waitForRequest(h: ReturnType<typeof harness>, action: string, after = 0): Promise<any> {
	for (let tries = 0; tries < 100; tries++) {
		const frames = h.privateFrames().filter((frame) => frame.kind === "request");
		const found = frames.slice(after).find((frame) => frame.request.action === action);
		if (found) return found;
		await new Promise((resolve) => setImmediate(resolve));
	}
	throw new Error(`No private request for ${action}`);
}

test("Team v2 tool schema is a strict action union and bind selects role-specific tools", async () => {
	const variants = (TEAM_TOOL_SCHEMA as any).anyOf;
	assert.ok(Array.isArray(variants) && variants.length >= 20);
	assert.ok(variants.every((variant: any) => variant.type === "object" && variant.additionalProperties === false));
	assert.match(TEAM_TOOL_DESCRIPTION, /pause_member, resume_member, revise_work, cancel_work, resume_work, accept_result, close_member, and close_team/u);

	const worker = harness("worker");
	assert.equal(worker.handlers.get("cache_warming_decision")!(), undefined);
	await worker.command(bindCommand(worker));
	assert.deepEqual(worker.activeTools(), ["read", "bash", "team"]);
	assert.deepEqual(worker.handlers.get("cache_warming_decision")!(), { action: "stop" });

	const manager = harness("manager");
	await manager.command(bindCommand(manager));
	assert.deepEqual(manager.activeTools(), ["team"], "Manager gets no filesystem, shell, or subagent tools");
	assert.match(manager.tools.get("team").description, /reply, yield, and close_team must be the only tool call/u);
});

test("flat close_team control is rejected before RPC when its native assistant batch has another tool", async () => {
	const h = harness();
	await h.command(bindCommand(h));
	await h.command(activateCommand(h));
	h.branch.push({ type: "message", message: { role: "assistant", content: [
		{ type: "toolCall", id: "mixed-close", name: "team" },
		{ type: "toolCall", id: "sibling-status", name: "team" },
	] } });
	const execution = h.tools.get("team").execute("mixed-close", {
		action: "control", command: "close_team", resultRefs: [], outcome: "failed", reason: "synthetic mixed batch",
	}, h.ctx.signal, () => undefined, h.ctx);
	const observed = execution.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
	await new Promise<void>((resolve) => setImmediate(resolve));
	const business = h.privateFrames().find((frame) => frame.kind === "request" && frame.request.action === "business");
	if (business?.kind === "request" && business.request.action === "business") {
		await replyToRequest(h, business, { kind: "business", reply: { ok: true, from: "@hub", to: h.binding.memberId,
			receipt: { status: "closing", command: "close_team", closeId: "test-close" } } }, "mixed-close-response");
	}
	const result = await observed;
	assert.equal(result.ok, false, "an end intent in a mixed batch must return an error rather than reach Runtime");
	if (result.ok) return;
	assert.match(result.error instanceof Error ? result.error.message : String(result.error), /only tool call in the finalized assistant batch/u);
	assert.equal(h.privateFrames().filter((frame) => frame.kind === "request" && frame.request.action === "business").length, 0);
});

test("native custom activation is persisted and verified before input_ready/provider_gate; repeats are idempotent", async () => {
	const h = harness();
	await h.command(bindCommand(h));
	const firstBindAck = h.lastPrivate();
	const bindCount = h.activeToolUpdates.length;
	await h.command(bindCommand(h));
	assert.deepEqual(h.lastPrivate(), firstBindAck);
	assert.equal(h.activeToolUpdates.length, bindCount, "duplicate bind ACK does not repeat side effects");
	const conflictingBind = bindCommand(h, "bind-1", { ...h.binding, teamId: "other-team" });
	await h.command(conflictingBind);
	assert.equal(h.lastPrivate().ok, false, "same command id with different canonical content is rejected");
	assert.equal(h.activeTools().join(","), "team");

	await h.command(activateCommand(h));
	const activateAck = h.lastPrivate();
	await h.command(activateCommand(h));
	assert.deepEqual(h.lastPrivate(), activateAck);
	await h.command(activateCommand(h, "activate-retry"));
	assert.equal(h.lastPrivate().ok, true, "same activation under a new command id is idempotent");

	const before = await h.handlers.get("before_agent_start")!({ prompt: TEAM_ACTIVATION_TRIGGER, systemPrompt: "native system" }, h.ctx);
	assert.equal(before.message.customType, TEAM_ACTIVATION_MESSAGE_TYPE);
	assert.equal(before.message.display, false);
	assert.deepEqual(JSON.parse(before.message.content), h.activation.input);
	const messages = appendNativeActivation(h, before);
	const running = h.handlers.get("context")!({ messages }, h.ctx);
	const inputReady = await waitForRequest(h, "input_ready");
	assert.equal(inputReady.request.deliveryId, h.activation.deliveryId);
	const inputAck: PrivateReply = { kind: "ack" };
	await replyToRequest(h, inputReady, inputAck, "reply-input");
	await replyToRequest(h, inputReady, inputAck, "reply-input-duplicate");
	const providerGate = await waitForRequest(h, "provider_gate", 1);
	assert.equal(providerGate.sequence, inputReady.sequence + 1);
	await replyToRequest(h, providerGate, { kind: "gate", decision: { allow: true } }, "reply-provider");
	assert.equal(await running, undefined);
	assert.deepEqual(h.privateFrames().filter((frame) => frame.kind === "request").map((frame) => frame.request.action), ["input_ready", "provider_gate"]);
	assert.equal(h.aborts(), 0);

	const secondContext = h.handlers.get("context")!({ messages }, h.ctx);
	const nextGate = await waitForRequest(h, "provider_gate", 2);
	await replyToRequest(h, nextGate, { kind: "gate", decision: { allow: true } }, "reply-provider-2");
	assert.equal(await secondContext, undefined);
	assert.equal(h.privateFrames().filter((frame) => frame.kind === "request" && frame.request.action === "input_ready").length, 1);
	const deactivate: ParentCommand = { version: 2, commandId: "deactivate-1", operation: "deactivate", binding: h.binding, activation: h.activation.scope };
	await h.command(deactivate);
	await h.command({ ...deactivate, commandId: "deactivate-retry" });
	assert.equal(h.lastPrivate().ok, true, "repeated close of the same activation is idempotent");
	await h.command(activateCommand(h, "stale-reopen"));
	assert.equal(h.lastPrivate().ok, false, "a closed activation tombstone prevents stale reactivation");
	assert.deepEqual(h.handlers.get("cache_warming_decision")!(), { action: "stop" }, "lifetime binding stays non-warmable after deactivation");
});

test("wrong native context aborts before private readiness or provider continuation", async () => {
	const h = harness();
	await h.command(bindCommand(h));
	await h.command(activateCommand(h));
	const before = await h.handlers.get("before_agent_start")!({ prompt: TEAM_ACTIVATION_TRIGGER, systemPrompt: "native" }, h.ctx);
	const messages = appendNativeActivation(h, before);
	h.branch[h.branch.length - 1].content = "forged input";
	await h.handlers.get("context")!({ messages }, h.ctx);
	assert.equal(h.aborts(), 1);
	assert.equal(h.privateFrames().filter((frame) => frame.kind === "request").length, 0);
});

test("business tool errors retain the structured TeamError JSON including its code", async () => {
	const h = harness();
	await h.command(bindCommand(h));
	await h.command(activateCommand(h));
	const tool = h.tools.get("team");
	const execution = tool.execute("status-call", { action: "status" }, h.ctx.signal, () => undefined, h.ctx);
	const request = await waitForRequest(h, "business");
	await replyToRequest(h, request, { kind: "business", reply: {
		ok: false, from: "@hub", to: h.binding.memberId,
		error: { code: "TEAM_CAPACITY", message: "No more active Teams." },
	} }, "reply-business-error");
	await assert.rejects(execution, (error: Error) => {
		assert.equal(error.message, JSON.stringify({ code: "TEAM_CAPACITY", message: "No more active Teams." }));
		return true;
	});
});
