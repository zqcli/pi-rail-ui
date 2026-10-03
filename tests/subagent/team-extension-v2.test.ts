import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import install, { renderTeamBrief } from "../../tools/subagents/team-extension-v2";
import { TEAM_ACTIVATION_MESSAGE_TYPE, TEAM_ACTIVATION_TRIGGER, TEAM_COMMAND, TEAM_COMMAND_DESCRIPTION, TEAM_PRIVATE_ENTRY_TYPE } from "../../tools/subagents/team-protocol";
import type { ParentCommand, PrivateReply } from "../../tools/subagents/team-protocol";
import { jsonBytes, parseChildFrame, TEAM_TOOL_DESCRIPTION, TEAM_TOOL_SCHEMA } from "../../tools/subagents/team-codec";
import { TeamRuntime } from "../../tools/subagents/team-runtime";
import { TeamRpcV2Connection } from "../../tools/subagents/team-rpc-v2";
import type { RpcEvent, RpcTransport } from "../../tools/subagents/rpc-worker";
import { loadoutFor } from "../fixtures/team-loadout";

function nativeActivation(who: "lead" | "member") {
	const runtime = new TeamRuntime();
	const prepared = runtime.prepare({
		members: [{ alias: "lead", roleDescription: "Manage the Team." }, { alias: "w1", roleDescription: "Do assigned work." }], lead: "lead",
		brief: { goal: "Verify the private activation bridge." }, timeoutSeconds: null,
		initialRequests: who === "member" ? [{ to: "w1", task: "Return a valid result." }] : [],
	});
	runtime.launch(prepared.teamId);
	const lead = runtime.takeNextActivation(prepared.teamId)!;
	return { runtime, activation: who === "lead" ? lead : runtime.takeNextActivation(prepared.teamId)! };
}

function harness(who: "lead" | "member" = "lead") {
	const { runtime, activation } = nativeActivation(who);
	const binding = activation.binding;
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const entries: any[] = [];
	const entryListeners = new Set<(entry: { type: "custom"; customType: string; data: unknown }) => void>();
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
		getAllTools: () => [...["read", "bash", "grep", "find", "ls", "subagent", "subagent_team"].map((name) => ({ name })), ...tools.values()],
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => { activeTools = [...names]; activeToolUpdates.push([...names]); },
		appendEntry: (customType: string, data: unknown) => {
			const entry = { type: "custom" as const, customType, data };
			entries.push(entry);
			for (const listener of entryListeners) listener(entry);
		},
	};
	install(pi as unknown as ExtensionAPI);
	const command = async (frame: ParentCommand) => commands.get(TEAM_COMMAND).handler(JSON.stringify(frame), ctx);
	const lastPrivate = () => [...entries].reverse().find((entry) => entry.customType === TEAM_PRIVATE_ENTRY_TYPE)?.data;
	const privateFrames = () => entries.filter((entry) => entry.customType === TEAM_PRIVATE_ENTRY_TYPE).map((entry) => entry.data);
	return { runtime, activation, binding, handlers, commands, tools, entries, branch, ctx, command, lastPrivate, privateFrames, entryListeners,
		activeTools: () => activeTools, activeToolUpdates, aborts: () => aborts };
}

function bindCommand(h: ReturnType<typeof harness>, commandId = "bind-1", binding = h.binding, tools: string[] | null = null): ParentCommand {
	return { version: 2, commandId, operation: "bind", binding, loadout: { ...loadoutFor(binding.memberId, tools), teamTool: true } };
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

test("Team v2 tool schema is a strict action union and bind gives every member base tools plus team, restricted by its tools allowlist", async () => {
	const variants = (TEAM_TOOL_SCHEMA as any).anyOf;
	assert.ok(Array.isArray(variants) && variants.length >= 20);
	assert.ok(variants.every((variant: any) => variant.type === "object" && variant.additionalProperties === false));
	assert.match(TEAM_TOOL_DESCRIPTION, /revise_work, cancel_work, resume_work and accept_result are for the work's requester or the lead.*pause_member, resume_member, close_member and close_team are lead only/u);

	const member = harness("member");
	assert.equal(member.handlers.get("cache_warming_decision")!(), undefined);
	await member.command(bindCommand(member));
	assert.deepEqual(member.activeTools(), ["read", "bash", "team"]);
	assert.deepEqual(member.handlers.get("cache_warming_decision")!(), { action: "stop" });

	const lead = harness("lead");
	await lead.command(bindCommand(lead));
	assert.deepEqual(lead.activeTools(), ["read", "bash", "team"], "the lead gets the same base tools plus team, never subagent tools");
	assert.match(lead.tools.get("team").description, /reply, yield, and close_team must be the only tool call/u);

	const restricted = harness("member");
	await restricted.command(bindCommand(restricted, "bind-1", restricted.binding, ["read", "write"]));
	assert.deepEqual(restricted.activeTools(), ["read", "team"], "a tools allowlist restricts the base tools; names the session lacks are simply absent");
	const readOnly = harness("member");
	await readOnly.command(bindCommand(readOnly, "bind-1", readOnly.binding, ["read", "grep", "find", "ls", "subagent", "missing"]));
	assert.deepEqual(readOnly.activeTools(), ["read", "grep", "find", "ls", "team"], "an allowlist activates available tools that are not active by default, minus reserved names");
	const teamOnly = harness("lead");
	await teamOnly.command(bindCommand(teamOnly, "bind-1", teamOnly.binding, []));
	assert.deepEqual(teamOnly.activeTools(), ["team"], "an empty allowlist leaves only the team tool");
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
	assert.equal(h.activeTools().join(","), "read,bash,team");

	await h.command(activateCommand(h));
	const activateAck = h.lastPrivate();
	await h.command(activateCommand(h));
	assert.deepEqual(h.lastPrivate(), activateAck);
	await h.command(activateCommand(h, "activate-retry"));
	assert.equal(h.lastPrivate().ok, true, "same activation under a new command id is idempotent");

	const sections: Record<string, string> = {};
	const before = await h.handlers.get("before_agent_start")!({ prompt: TEAM_ACTIVATION_TRIGGER, systemPrompt: "native system", systemPromptOptions: { sections } }, h.ctx);
	assert.equal(before.systemPrompt, undefined, "the brief is a system prompt section, never a forced systemPrompt");
	assert.match(sections["team_brief"]!, /^Team member: lead\./u);
	assert.match(sections["team_brief"]!, /### Goal\nTest goal\./u);
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
	const before = await h.handlers.get("before_agent_start")!({ prompt: TEAM_ACTIVATION_TRIGGER, systemPrompt: "native", systemPromptOptions: { sections: {} } }, h.ctx);
	const messages = appendNativeActivation(h, before);
	h.branch[h.branch.length - 1].content = "forged input";
	await h.handlers.get("context")!({ messages }, h.ctx);
	assert.equal(h.aborts(), 1);
	assert.equal(h.privateFrames().filter((frame) => frame.kind === "request").length, 0);
});

test("tool_call sends a stable fingerprint of the input and tool_result reports isError, both parsed by the frame codec", async () => {
	const h = harness();
	await h.command(bindCommand(h));
	await h.command(activateCommand(h));
	const gate = async (toolCallId: string, input: unknown, after: number) => {
		const pending = h.handlers.get("tool_call")!({ toolName: "read", toolCallId, input }, h.ctx);
		const frame = await waitForRequest(h, "tool_gate", after);
		await replyToRequest(h, frame, { kind: "gate", decision: { allow: true } }, `reply-${toolCallId}`);
		assert.equal(await pending, undefined);
		return parseChildFrame(frame);
	};
	const first: any = await gate("call-1", { path: "a.ts", range: { to: 2, from: 1 } }, 0);
	const second: any = await gate("call-2", { range: { from: 1, to: 2 }, path: "a.ts" }, 1);
	const other: any = await gate("call-3", { path: "b.ts" }, 2);
	assert.match(first.request.inputHash, /^[0-9a-f]{16}$/u);
	assert.equal(second.request.inputHash, first.request.inputHash, "key order does not change the fingerprint");
	assert.notEqual(other.request.inputHash, first.request.inputHash);

	for (const [toolCallId, isError] of [["call-1", true], ["call-2", false]] as const) {
		const pending = h.handlers.get("tool_result")!({ toolName: "read", toolCallId, isError }, h.ctx);
		const frame = (await waitForRequest(h, "tool_result", toolCallId === "call-1" ? 3 : 4));
		assert.equal(frame.request.isError, isError);
		assert.deepEqual(parseChildFrame(frame), frame);
		await replyToRequest(h, frame, { kind: "ack" }, `ack-${toolCallId}`);
		await pending;
	}
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

test("execute rejects malformed and oversized business arguments locally, and the same activation accepts a corrected call", async () => {
	const text = "x".repeat(8192);
	const list = Array.from({ length: 32 }, () => text);
	const oversizedReply = { action: "reply", result: { status: "failed", summary: text, findings: list, limitations: list, artifacts: list,
		evidence: list.map((source) => ({ source, locator: source, basis: "observed" })) } };
	assert.ok(jsonBytes(oversizedReply) > 1024 * 1024);
	const h = harness();
	await h.command(bindCommand(h));
	await h.command(activateCommand(h));
	const before = h.privateFrames().length;
	const tool = h.tools.get("team");
	for (const args of [oversizedReply,
		{ action: "reply", result: { status: "succeeded", summary: "x".repeat(8000), findings: ["y".repeat(8000)] } },
		{ action: "request", to: "w1", task: "中".repeat(3000) },
		{ action: "request", to: "w1", task: "\n".repeat(5000) },
		{ action: "request", to: "w1", task: "\ud800" },
		{ action: "status", sender: "forged" },
		{ action: "status", limit: Number.NaN }, [], null,
	]) {
		await assert.rejects(tool.execute("bad-call", args, h.ctx.signal, () => undefined, h.ctx), (error: Error) => {
			const structured = JSON.parse(error.message);
			assert.equal(structured.code, "INVALID_ARGUMENT");
			assert.ok(structured.message);
			return true;
		});
		assert.equal(h.privateFrames().length, before, "rejection does not append any frame or reach Runtime");
		assert.equal(h.aborts(), 0, "model-correctable arguments must not abort the connection");
	}
	const execution = tool.execute("corrected-call", { action: "status" }, h.ctx.signal, () => undefined, h.ctx);
	const request = await waitForRequest(h, "business");
	assert.equal(request.sequence, 1, "rejected business input must not consume a private sequence");
	await replyToRequest(h, request, { kind: "business", reply: { ok: true, from: "@hub", to: h.binding.memberId } }, "corrected-reply");
	const result = await execution;
	assert.equal(result.details.ok, true);
	assert.equal(result.terminate, undefined);
	assert.equal(h.aborts(), 0);
});

test("child validation keeps flat control wire arguments for independent parent normalization", async () => {
	const h = harness();
	await h.command(bindCommand(h));
	await h.command(activateCommand(h));
	const args = { action: "control", command: "pause_member", memberId: "w1" };
	const execution = h.tools.get("team").execute("pause-call", args, h.ctx.signal, () => undefined, h.ctx);
	const request = await waitForRequest(h, "business");
	assert.deepEqual(request.request.args, args);
	await replyToRequest(h, request, { kind: "business", reply: { ok: false, from: "@hub", to: h.binding.memberId,
		error: { code: "FORBIDDEN_ACTION", message: "Parent authorization still applies." } } }, "pause-reply");
	await assert.rejects(execution, (error: Error) => JSON.parse(error.message).code === "FORBIDDEN_ACTION");
	assert.equal(h.aborts(), 0);
});

test("host API exceptions produce bounded valid negative command ACKs", async () => {
	const h = harness();
	h.tools.set("team", { get name() { throw new Error("proxy failure: " + "中\n".repeat(6000)); } });
	await h.command(bindCommand(h));
	const ack = h.lastPrivate();
	assert.equal(ack.ok, false);
	assert.match(ack.error, /\[truncated\]$/u);
	assert.deepEqual(parseChildFrame(ack), ack);
	assert.equal(h.aborts(), 0);
});

test("oversized local reply can be corrected in the same connected scope and committed through Runtime", async () => {
	const h = harness("member");
	const listeners = new Set<(event: RpcEvent) => void>();
	const emit = (event: RpcEvent) => { for (const listener of listeners) listener(event); };
	h.entryListeners.add((entry) => emit({ type: "entry_appended", entry }));
	const started = Promise.withResolvers<void>();
	const promptDone = Promise.withResolvers<unknown>();
	let stops = 0;
	const failures: Error[] = [];
	const transport: RpcTransport = {
		onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
		async request(request) {
			if (request["type"] === "get_commands") return { commands: [{ name: TEAM_COMMAND, source: "extension", description: TEAM_COMMAND_DESCRIPTION }] };
			if (request["type"] === "clear_queue") return {};
			if (request["type"] === "prompt" && typeof request["message"] === "string" && request["message"].startsWith(`/${TEAM_COMMAND} `)) {
				await h.commands.get(TEAM_COMMAND).handler(request["message"].slice(TEAM_COMMAND.length + 2), h.ctx);
				return {};
			}
			if (request["type"] === "prompt" && request["message"] === TEAM_ACTIVATION_TRIGGER) {
				emit({ type: "agent_start" });
				started.resolve();
				return promptDone.promise;
			}
			throw new Error(`Unexpected synthetic RPC request: ${String(request["type"])}`);
		},
		async stop() { stops++; promptDone.reject(new Error("synthetic transport stopped")); },
	};
	const connection = new TeamRpcV2Connection(transport, h.binding, loadoutFor(h.binding.memberId), (error: Error) => failures.push(error));
	const running = connection.sendActivation(h.activation, async (frame, intentId) => {
		assert.equal(frame.request.action, "business");
		if (frame.request.action !== "business") throw new Error("Expected business request");
		return { kind: "business", reply: h.runtime.handleAction(frame.binding, frame.activation, frame.sequence,
			frame.rpcRequestId, frame.request.args, intentId!) };
	});
	await started.promise;
	assert.equal(h.runtime.inputReady(h.binding, h.activation.scope.activationId, h.activation.deliveryId).ok, true);
	const before = h.runtime.getTeam(h.binding.teamId);
	const text = "x".repeat(8192);
	const list = Array.from({ length: 32 }, () => text);
	const oversized = { action: "reply", result: { status: "failed", summary: text, findings: list, limitations: list, artifacts: list,
		evidence: list.map((source) => ({ source, locator: source, basis: "observed" })) } };
	const tool = h.tools.get("team");
	emit({ type: "tool_execution_start", toolCallId: "bad", toolName: "team" });
	await assert.rejects(tool.execute("bad", oversized, h.ctx.signal, () => undefined, h.ctx),
		(error: Error) => JSON.parse(error.message).code === "INVALID_ARGUMENT");
	emit({ type: "tool_execution_end", toolCallId: "bad", toolName: "team", isError: true, result: {} });
	assert.deepEqual(h.runtime.getTeam(h.binding.teamId), before);
	assert.equal(h.privateFrames().filter((frame) => frame.kind === "request").length, 0);
	const assistant = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "corrected", name: "team" }] };
	h.branch.push({ type: "message", message: assistant });
	emit({ type: "tool_execution_start", toolCallId: "corrected", toolName: "team" });
	const result = await tool.execute("corrected", { action: "reply", result: { status: "succeeded", summary: "Corrected reply." } }, h.ctx.signal, () => undefined, h.ctx);
	assert.equal(result.terminate, true);
	emit({ type: "tool_execution_end", toolCallId: "corrected", toolName: "team", isError: false, result });
	emit({ type: "turn_end", message: assistant, toolResults: [{ toolCallId: "corrected", toolName: "team", isError: false }] });
	emit({ type: "agent_settled" });
	promptDone.resolve({});
	const completion = await running;
	assert.ok(completion.appliedToolCallId);
	assert.equal(h.runtime.nativeSettled(h.binding, h.activation.scope.activationId, completion).ok, true);
	await connection.deactivate(h.activation);
	assert.equal(h.runtime.cleanupFinished(h.binding, h.activation.scope.activationId, { ok: true }).ok, true);
	assert.equal(h.runtime.getWork(h.binding.teamId, h.activation.scope.work!)?.current.state, "resolved");
	assert.deepEqual(failures, []);
	assert.equal(stops, 0);
	assert.equal(h.aborts(), 0);
	await connection.close();
});

test("team_brief renders only the member's own authorization and fills absent parts with none", () => {
	const brief = { goal: "Ship it.", acceptanceCriteria: ["Tests pass"], constraints: ["No new deps", "Keep API"],
		authorizations: [{ member: "dev", allowed: ["edit src"], forbidden: ["git push"] }, { member: "qa", allowed: ["run tests"] }] };
	const roster = [{ id: "lead", rolePreview: "Coordinates." }, { id: "dev", rolePreview: "Implements." }, { id: "qa", rolePreview: "Tests." }];
	const dev = renderTeamBrief("dev", { tools: null, teamTool: true, brief, roster });
	assert.match(dev, /### Acceptance criteria\n- Tests pass\n\n### Constraints\n- No new deps\n- Keep API\n\n### Your authorization\nAllowed:\n- edit src\nForbidden:\n- git push\n\n### Team roster\n- lead: Coordinates\.\n- dev: Implements\.\n- qa: Tests\./u);
	assert.doesNotMatch(dev, /run tests/u);
	assert.match(dev, /### Target\nnone\n/u);
	const lead = renderTeamBrief("lead", { tools: null, teamTool: true, brief: { goal: "G" }, roster });
	assert.match(lead, /### Acceptance criteria\nnone\n\n### Constraints\nnone\n\n### Your authorization\nnone\n/u);
	assert.match(renderTeamBrief("qa", { tools: null, teamTool: true, brief, roster }), /Allowed:\n- run tests\nForbidden:\nnone/u);
});
