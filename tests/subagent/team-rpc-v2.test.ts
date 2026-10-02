import assert from "node:assert/strict";
import { test } from "node:test";
import type { RpcEvent, RpcTransport } from "../../tools/subagents/rpc-worker";
import { RpcProcessExitTimeoutError } from "../../tools/subagents/rpc-transport";
import { TEAM_ACTIVATION_TRIGGER, TEAM_COMMAND, TEAM_COMMAND_DESCRIPTION, TEAM_PRIVATE_ENTRY_TYPE } from "../../tools/subagents/team-protocol";
import type { BindingV2, ChildRequestFrame, ParentCommand, PrivateReply } from "../../tools/subagents/team-protocol";
import { TeamRuntime, type RuntimeActivation } from "../../tools/subagents/team-runtime";
import { TeamActivationFailure, TeamRpcV2Connection } from "../../tools/subagents/team-rpc-v2";
import { jsonBytes, jsonTextBytes, parseParentCommand, parseTeamReply, projectActivationInput } from "../../tools/subagents/team-codec";
import { loadoutFor } from "../fixtures/team-loadout";

const runtime = new TeamRuntime();
const prepared = runtime.prepare({
	members: [{ alias: "lead", roleDescription: "Manage the Team." }, { alias: "w1", roleDescription: "Do the assigned work." }], lead: "lead",
	brief: { goal: "Complete the test work." }, timeoutSeconds: null,
});
runtime.launch(prepared.teamId);
const activationValue = runtime.takeNextActivation(prepared.teamId)!;
const binding: BindingV2 = activationValue.binding;

function activation(): RuntimeActivation { return activationValue; }

class FakeTransport implements RpcTransport {
	private readonly listeners = new Set<(event: RpcEvent) => void>();
	readonly commands: ParentCommand[] = [];
	readonly triggerStarted = Promise.withResolvers<void>();
	stopCalls = 0;
	ackCommands = true;
	triggerDelayMs = 0;
	triggerFailure: Error | undefined;
	stopFailure: Error | undefined;
	emitTrailingEmptyTurn = false;
	nativeErrorMessage: string | undefined;
	ignoreAbort = false;
	private triggerTimer: NodeJS.Timeout | undefined;
	private triggerDone: (() => void) | undefined;
	private triggerLost: ((error: Error) => void) | undefined;
	private nativeByRequest = new Map<string, string>();
	private stagedNativeToolCallId: string | undefined;

	onEvent(listener: (event: RpcEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: RpcEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	emitChild(frame: ChildRequestFrame): string | undefined {
		if (frame.request.action !== "business") {
			this.emit({ type: "entry_appended", entry: { type: "custom", customType: TEAM_PRIVATE_ENTRY_TYPE, data: frame } });
			return undefined;
		}
		const nativeToolCallId = `native|${frame.rpcRequestId}`;
		this.nativeByRequest.set(frame.rpcRequestId, nativeToolCallId);
		this.emit({ type: "tool_execution_start", toolCallId: nativeToolCallId, toolName: "team" });
		const wireFrame = { ...frame, request: { ...frame.request, toolCallId: nativeToolCallId } };
		this.emit({ type: "entry_appended", entry: { type: "custom", customType: TEAM_PRIVATE_ENTRY_TYPE, data: wireFrame } });
		return nativeToolCallId;
	}

	async request(request: Record<string, unknown>): Promise<unknown> {
		if (request["type"] === "get_commands") return { commands: [{ name: TEAM_COMMAND, source: "extension", description: TEAM_COMMAND_DESCRIPTION }] };
		if (request["type"] === "get_state") return { isStreaming: true };
		if (request["type"] === "clear_queue") return {};
		if (request["type"] === "abort") { if (!this.ignoreAbort) this.finishTrigger("aborted"); return {}; }
		if (request["type"] !== "prompt") throw new Error(`Unexpected fake RPC request: ${String(request["type"])}`);
		const message = String(request["message"] ?? "");
		if (message.startsWith(`/${TEAM_COMMAND} `)) {
			const frame = parseParentCommand(JSON.parse(message.slice(TEAM_COMMAND.length + 2))) as ParentCommand;
			this.commands.push(frame);
			if (this.ackCommands) {
				const ack = { version: 2, kind: "ack", commandId: frame.commandId, binding: frame.binding,
					...("activation" in frame ? { activation: frame.activation } : {}), ok: true };
				this.emit({ type: "entry_appended", entry: { type: "custom", customType: TEAM_PRIVATE_ENTRY_TYPE, data: ack } });
			}
			if (frame.operation === "reply") {
				const nativeToolCallId = this.nativeByRequest.get(frame.rpcRequestId);
				if (nativeToolCallId) {
					const receipt = frame.reply.kind === "business" && frame.reply.reply.ok ? frame.reply.reply.receipt : undefined;
					const staged = receipt?.status === "staged" || (receipt?.status === "closing" && receipt.command === "close_team");
					if (staged) this.stagedNativeToolCallId = nativeToolCallId;
					this.emit({ type: "tool_execution_end", toolCallId: nativeToolCallId, toolName: "team", isError: false,
						result: { terminate: staged } });
				}
			}
			return {};
		}
		if (message !== TEAM_ACTIVATION_TRIGGER) throw new Error(`Unexpected activation trigger: ${message}`);
		if (this.triggerFailure) throw this.triggerFailure;
		this.emit({ type: "agent_start" });
		this.triggerStarted.resolve();
		return await new Promise((resolve, reject) => {
			this.triggerDone = () => { resolve({}); };
			this.triggerLost = reject;
			this.triggerTimer = setTimeout(() => this.finishTrigger("stop"), this.triggerDelayMs);
		});
	}

	private finishTrigger(stopReason: "stop" | "aborted"): void {
		if (!this.triggerDone) return;
		clearTimeout(this.triggerTimer);
		this.triggerTimer = undefined;
		const done = this.triggerDone;
		this.triggerDone = undefined;
		const staged = stopReason === "stop" && this.stagedNativeToolCallId !== undefined;
		this.emit({ type: "turn_end", message: { role: "assistant", stopReason: this.nativeErrorMessage !== undefined ? "error" : staged ? "toolUse" : stopReason,
			...(this.nativeErrorMessage !== undefined ? { errorMessage: this.nativeErrorMessage } : {}),
			content: staged ? [{ type: "toolCall", id: this.stagedNativeToolCallId, name: "team" }]
				: stopReason === "stop" ? [{ type: "text", text: "native done" }] : [] },
		toolResults: staged ? [{ toolCallId: this.stagedNativeToolCallId, toolName: "team", isError: false }] : [] });
		if (staged && this.emitTrailingEmptyTurn) {
			this.emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] });
		}
		this.emit({ type: "agent_settled" });
		done();
	}

	async stop(): Promise<void> {
		this.stopCalls++;
		// A stopped process rejects its still-pending prompt request, as the real RPC transport does.
		if (this.triggerDone) {
			clearTimeout(this.triggerTimer);
			this.triggerDone = undefined;
			this.triggerLost?.(new Error("fake process stopped"));
		}
		if (this.stopFailure) throw this.stopFailure;
	}
}

function makeRequest(sequence: number, rpcRequestId = `request-${sequence}`): ChildRequestFrame {
	return {
		version: 2, kind: "request", binding, activation: activation().scope, sequence, rpcRequestId,
		request: { action: "business", args: { action: "status" } },
	};
}

function makeGateRequest(sequence: number, rpcRequestId = `gate-${sequence}`): ChildRequestFrame {
	return { version: 2, kind: "request", binding, activation: activation().scope, sequence, rpcRequestId,
		request: { action: "provider_gate" } };
}

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const check = () => {
			if (predicate()) { resolve(); return; }
			if (Date.now() - started > timeoutMs) { reject(new Error("Timed out waiting for fake Team RPC event")); return; }
			setTimeout(check, 1);
		};
		check();
	});
}

function replyCount(transport: FakeTransport): number {
	return transport.commands.filter((command) => command.operation === "reply").length;
}

async function startConnection(transport: FakeTransport, onRequest: (frame: ChildRequestFrame, intentId?: string) => Promise<PrivateReply>, onFailure: (error: Error) => void = () => undefined,
	signal?: AbortSignal) {
	const connection = new TeamRpcV2Connection(transport, binding, loadoutFor(binding.memberId), onFailure);
	const run = connection.sendActivation(activation(), onRequest, signal);
	await transport.triggerStarted.promise;
	return { connection, run };
}

test("native Team run may exceed the five-second ACK bound and still waits for real agent_settled", { timeout: 15000 }, async () => {
	const transport = new FakeTransport();
	transport.triggerDelayMs = 5150;
	const { connection, run } = await startConnection(transport, async () => ({ kind: "ack" }));
	const completion = await run;
	assert.equal(completion.status, "success");
	assert.equal(completion.finalAssistantText, "native done");
	assert.equal(transport.stopCalls, 0);
	await connection.deactivate(activation());
	await connection.close();
	assert.equal(transport.stopCalls, 0);
});

test("native 6 KiB proxy failures retain private evidence and project bounded public diagnostics without protocol faults", async () => {
	const transport = new FakeTransport();
	transport.nativeErrorMessage = "proxy upstream failure: " + "x".repeat(6000);
	const failures: Error[] = [];
	const { connection, run } = await startConnection(transport, async () => ({ kind: "ack" }), (error) => failures.push(error));
	const completion = await run;
	assert.equal(completion.status, "error");
	assert.equal(completion.error?.code, "NATIVE_FAILURE");
	assert.equal(completion.error!.message, transport.nativeErrorMessage, "private completion must retain the full evidence for Runtime comparisons");
	const dependentInput = structuredClone(activation().input);
	dependentInput.outcomes = [{ work: { workId: "failed-child", revision: 1 }, state: "failed", error: completion.error! }];
	const projected = projectActivationInput(dependentInput);
	assert.ok(jsonTextBytes(projected.outcomes[0]!.error!.message) <= 4096);
	assert.match(projected.outcomes[0]!.error!.message, /\[truncated\]$/u);
	assert.doesNotThrow(() => parseParentCommand({ version: 2, commandId: "dependent-input", operation: "activate", binding,
		activation: activation().scope, deliveryId: activation().deliveryId, input: projected }));
	assert.deepEqual(failures, []);
	assert.equal(transport.stopCalls, 0);
	await connection.deactivate(activation());
	await connection.close();
});

test("private frame size includes the native tool-call evidence stripped before core codec parsing", async () => {
	const transport = new FakeTransport();
	transport.triggerDelayMs = 60000;
	let handled = 0;
	const { run } = await startConnection(transport, async () => { handled++; return { kind: "ack" }; });
	const frame = makeRequest(1, "wire-limit");
	const args = { action: "request", to: "w1", task: "" };
	frame.request = { action: "business", args };
	args.task = "x".repeat(1024 * 1024 - jsonBytes(frame));
	assert.equal(jsonBytes(frame), 1024 * 1024, "the core frame fits exactly before native evidence is attached");
	transport.emitChild(frame);
	await assert.rejects(run, /child frame exceeds its frame limit/u);
	assert.equal(handled, 0);
	assert.equal(transport.stopCalls, 1, "an oversized forged private frame remains a protocol boundary failure");
});

test("parent Runtime revalidates business input independently, with no business state change or connection fault", async () => {
	const local = new TeamRuntime();
	const prepared = local.prepare({ members: [{ alias: "lead", roleDescription: "Manage." }, { alias: "w1", roleDescription: "Work." }], lead: "lead", brief: { goal: "Validate locally." } });
	local.launch(prepared.teamId);
	const current = local.takeNextActivation(prepared.teamId)!;
	local.inputReady(current.binding, current.scope.activationId, current.deliveryId);
	const before = local.getTeam(prepared.teamId);
	const transport = new FakeTransport();
	transport.triggerDelayMs = 60000;
	const failures: Error[] = [];
	const controller = new AbortController();
	const { connection, run } = await startConnection(transport, async (frame) => {
		assert.equal(frame.request.action, "business");
		if (frame.request.action !== "business") throw new Error("Expected business request");
		return { kind: "business", reply: local.handleAction(current.binding, current.scope,
			frame.sequence, frame.rpcRequestId, frame.request.args, `intent-${frame.sequence}`) };
	}, (error) => failures.push(error), controller.signal);
	const malformed = makeRequest(1, "invalid-business");
	malformed.request = { action: "business", args: { action: "request", to: "w1", task: "中".repeat(3000) } };
	transport.emitChild(malformed);
	await waitFor(() => replyCount(transport) === 1);
	const reply = transport.commands.find((command) => command.operation === "reply");
	assert.ok(reply?.operation === "reply" && reply.reply.kind === "business");
	if (reply.operation !== "reply" || reply.reply.kind !== "business") return;
	assert.equal(reply.reply.reply.ok, false);
	if (!reply.reply.reply.ok) assert.equal(reply.reply.reply.error.code, "INVALID_ARGUMENT");
	assert.deepEqual(local.getTeam(prepared.teamId), before, "rejected arguments do not change the business state");
	transport.emitChild(makeRequest(2, "corrected-status"));
	await waitFor(() => replyCount(transport) === 2);
	const corrected = transport.commands.filter((command) => command.operation === "reply")[1]!;
	assert.ok(corrected.operation === "reply" && corrected.reply.kind === "business" && corrected.reply.reply.ok);
	if (corrected.operation === "reply" && corrected.reply.kind === "business") {
		const businessReply = corrected.reply.reply;
		assert.doesNotThrow(() => parseTeamReply(businessReply));
	}
	assert.deepEqual(failures, []);
	assert.equal(transport.stopCalls, 0);
	controller.abort();
	await run;
	await connection.deactivate(activation());
	await connection.close();
});

test("Team command application ACK still fails closed at the independent five-second timeout", { timeout: 10000 }, async () => {
	const transport = new FakeTransport();
	transport.ackCommands = false;
	const connection = new TeamRpcV2Connection(transport, binding, loadoutFor(binding.memberId), () => undefined);
	await assert.rejects(connection.bind(), /application ACK timed out/u);
	assert.equal(transport.stopCalls, 1);
});

test("an explicit abort requests native cancellation but still waits for Pi agent_settled", async () => {
	const transport = new FakeTransport();
	transport.triggerDelayMs = 10000;
	const controller = new AbortController();
	const { connection, run } = await startConnection(transport, async () => ({ kind: "ack" }), () => undefined, controller.signal);
	controller.abort();
	const completion = await run;
	assert.equal(completion.status, "aborted");
	assert.equal(transport.stopCalls, 0, "an explicit native abort does not stop or fake-reap the persistent child");
	await connection.deactivate(activation());
	await connection.close();
});

test("terminate stops a native run that ignores abort and reports confirmed exit through the pending send", async () => {
	const transport = new FakeTransport();
	transport.triggerDelayMs = 60000;
	transport.ignoreAbort = true;
	const controller = new AbortController();
	const failures: Error[] = [];
	const { connection, run } = await startConnection(transport, async () => ({ kind: "ack" }), (error) => failures.push(error), controller.signal);
	controller.abort();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(transport.stopCalls, 0, "a scoped abort alone never stops the persistent process");
	connection.terminate(new Error("scoped stop exceeded its bound"));
	await assert.rejects(run, (error: unknown) => error instanceof TeamActivationFailure && error.resourceReleased
		&& /scoped stop exceeded its bound/u.test(error.message));
	assert.equal(transport.stopCalls, 1);
	assert.equal(failures.length, 1);
	await assert.rejects(connection.close(), /scoped stop exceeded its bound/u, "a terminated lifetime is not reported as a clean unbind");
});

test("terminate with an unconfirmed exit keeps the send's resource as not released", async () => {
	const transport = new FakeTransport();
	transport.triggerDelayMs = 60000;
	transport.stopFailure = new RpcProcessExitTimeoutError("exit not confirmed", Promise.resolve());
	const { connection, run } = await startConnection(transport, async () => ({ kind: "ack" }));
	connection.terminate(new Error("scoped stop exceeded its bound"));
	await assert.rejects(run, (error: unknown) => error instanceof TeamActivationFailure && !error.resourceReleased);
});

const assistantUsage = (input: number) => ({ role: "assistant", stopReason: "toolUse", content: [],
	usage: { input, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: input + 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } } });

test("usage observed before a transport loss is frozen into the activation failure", async () => {
	const transport = new FakeTransport();
	transport.triggerDelayMs = 60000;
	const { run } = await startConnection(transport, async () => ({ kind: "ack" }));
	transport.emit({ type: "message_end", message: assistantUsage(42) });
	transport.emit({ type: "transport_error", error: "socket closed" });
	transport.emit({ type: "message_end", message: assistantUsage(1000) });
	await assert.rejects(run, (error: unknown) => error instanceof TeamActivationFailure && error.resourceReleased
		&& error.usage?.input === 42 && error.usage.output === 2 && error.usage.turns === 1,
	"a late event after the loss is not billed");
});

test("an aborted activation reports the usage it already consumed, and events after agent_settled are not added", async () => {
	const transport = new FakeTransport();
	transport.triggerDelayMs = 60000;
	const controller = new AbortController();
	const { connection, run } = await startConnection(transport, async () => ({ kind: "ack" }), () => undefined, controller.signal);
	transport.emit({ type: "message_end", message: assistantUsage(17) });
	controller.abort();
	const completion = await run;
	transport.emit({ type: "message_end", message: assistantUsage(500) });
	assert.equal(completion.status, "aborted");
	assert.equal(completion.usage?.input, 17);
	await connection.deactivate(activation());
	await connection.close();
});

test("identical child requests are idempotent, stale sequence replies do not execute, and ACK duplicates are diagnosed", async () => {
	const transport = new FakeTransport();
	transport.triggerDelayMs = 1000;
	let requests = 0;
	const { connection, run } = await startConnection(transport, async () => {
		requests++;
		return { kind: "ack" };
	});
	const first = makeRequest(1, "same-request");
	transport.emitChild(first);
	await waitFor(() => replyCount(transport) === 1);
	transport.emitChild(first);
	await waitFor(() => replyCount(transport) === 2);
	assert.equal(requests, 1);
	assert.ok(connection.diagnosticCount > 0);
	transport.emitChild(makeRequest(1, "older-sequence"));
	await waitFor(() => replyCount(transport) === 3);
	assert.equal(requests, 1);
	const duplicateAck = transport.commands.find((command) => command.operation === "reply")!;
	const ack = { version: 2, kind: "ack", commandId: duplicateAck.commandId, binding,
		activation: duplicateAck.operation === "reply" ? duplicateAck.activation : undefined, ok: true };
	transport.emit({ type: "entry_appended", entry: { type: "custom", customType: TEAM_PRIVATE_ENTRY_TYPE, data: ack } });
	assert.ok(connection.diagnosticCount > 1);
	await run;
	await connection.deactivate(activation());
	await connection.close();
});

test("late private requests from the just-closed activation are ignored and diagnosed", async () => {
	const transport = new FakeTransport();
	transport.triggerDelayMs = 10;
	let requests = 0;
	const { connection, run } = await startConnection(transport, async () => { requests++; return { kind: "ack" }; });
	await run;
	await connection.deactivate(activation());
	const before = connection.diagnosticCount;
	transport.emitChild(makeGateRequest(1, "late-after-close"));
	assert.equal(requests, 0, "closed activation must not execute an old private request");
	assert.equal(connection.diagnosticCount, before + 1);
	await connection.close();
});

test("opaque native tool-call IDs stay transcript evidence and end intents match the exact executed call/result", async () => {
	const transport = new FakeTransport();
	transport.triggerDelayMs = 500;
	const rpcRequestId = "opaque-tool-request";
	const frame: ChildRequestFrame = {
		version: 2, kind: "request", binding, activation: activation().scope, sequence: 1, rpcRequestId,
		request: { action: "business", args: { action: "reply", result: { status: "succeeded", summary: "done" } } },
	};
	let nativeToolCallId = "";
	let intentId: string | undefined;
	const { connection, run } = await startConnection(transport, async (parsed: ChildRequestFrame, intent?: string) => {
		assert.equal(Object.hasOwn(parsed.request, "toolCallId"), false, "native provider IDs are not in the parsed request/fingerprint");
		intentId = intent;
		return { kind: "business", reply: { ok: true, from: "@hub", to: binding.memberId,
			receipt: { status: "staged", intent: "reply" } } };
	});
	nativeToolCallId = transport.emitChild(frame)!;
	await waitFor(() => replyCount(transport) === 1);
	const completion = await run;
	assert.ok(nativeToolCallId.includes("|"), "fixture exercises a native ID outside the private RPC identifier grammar");
	assert.equal(intentId, `team-intent-${rpcRequestId}`);
	assert.notEqual(intentId, nativeToolCallId);
	assert.equal(completion.appliedToolCallId, intentId, "runtime intent evidence uses a safe logical ID only after exact native transcript verification");
	await connection.deactivate(activation());
	await connection.close();
});

test("a later empty assistant turn preserves exact staged end-intent evidence and supplies the final text", async () => {
	const transport = new FakeTransport();
	transport.triggerDelayMs = 500;
	transport.emitTrailingEmptyTurn = true;
	const rpcRequestId = "reply-before-empty-turn";
	const frame: ChildRequestFrame = {
		version: 2, kind: "request", binding, activation: activation().scope, sequence: 1, rpcRequestId,
		request: { action: "business", args: { action: "reply", result: { status: "succeeded", summary: "done" } } },
	};
	let intentId: string | undefined;
	const { connection, run } = await startConnection(transport, async (_parsed, intent) => {
		intentId = intent;
		return { kind: "business", reply: { ok: true, from: "@hub", to: binding.memberId,
			receipt: { status: "staged", intent: "reply" } } };
	});
	transport.emitChild(frame);
	await waitFor(() => replyCount(transport) === 1);
	const completion = await run;
	assert.equal(completion.status, "success");
	assert.equal(completion.finalAssistantText, "", "final assistant text comes from the actual last turn, not the intent candidate");
	assert.equal(completion.appliedToolCallId, intentId, "the later empty turn does not erase the exact successful terminate evidence");
	await connection.deactivate(activation());
	await connection.close();
});

test("flattened close_team control is recognized as a terminating native intent", async () => {
	const transport = new FakeTransport();
	transport.triggerDelayMs = 500;
	const rpcRequestId = "close-team-request";
	const frame: ChildRequestFrame = {
		version: 2, kind: "request", binding, activation: activation().scope, sequence: 1, rpcRequestId,
		request: { action: "business", args: { action: "control", command: "close_team", resultRefs: [], outcome: "failed", reason: "synthetic close" } },
	};
	let intentId: string | undefined;
	const { connection, run } = await startConnection(transport, async (parsed: ChildRequestFrame, intent?: string) => {
		assert.equal(parsed.request.action, "business");
		if (parsed.request.action !== "business") throw new Error("Expected a business request");
		assert.equal(parsed.request.args["action"], "control");
		assert.equal(parsed.request.args["command"], "close_team");
		intentId = intent;
		return { kind: "business", reply: { ok: true, from: "@hub", to: binding.memberId,
			receipt: { status: "closing", command: "close_team", closeId: "close-test" } } };
	});
	transport.emitChild(frame);
	await waitFor(() => replyCount(transport) === 1);
	const completion = await run;
	assert.equal(intentId, `team-intent-${rpcRequestId}`);
	assert.equal(completion.appliedToolCallId, intentId, "close_team requires the same exact native terminate evidence as reply/yield");
	await connection.deactivate(activation());
	await connection.close();
});

test("pending private requests are never evicted and requests older than the bounded completed cache are not re-executed", async () => {
	const transport = new FakeTransport();
	transport.triggerDelayMs = 5000;
	const deferred: Array<ReturnType<typeof Promise.withResolvers<PrivateReply>>> = [];
	let requests = 0;
	let deferPending = true;
	let connectionFailure: Error | undefined;
	const { connection, run } = await startConnection(transport, () => {
		requests++;
		if (!deferPending) return Promise.resolve({ kind: "ack" });
		const item = Promise.withResolvers<PrivateReply>();
		deferred.push(item);
		return item.promise;
	}, (error) => { connectionFailure = error; });
	for (let sequence = 1; sequence <= 33; sequence++) transport.emitChild(makeGateRequest(sequence));
	await waitFor(() => replyCount(transport) >= 1, 8000).catch((error) => {
		throw new Error(`${String(error)}; pending=${requests}; failure=${connectionFailure?.message ?? "none"}`);
	});
	assert.equal(requests, 32, "the 33rd operation receives capacity refusal without entering the pending callback set");
	deferPending = false;
	for (const item of deferred) item.resolve({ kind: "ack" });
	await waitFor(() => replyCount(transport) === 33, 8000).catch((error) => {
		throw new Error(`${String(error)}; replies=${replyCount(transport)}; pending=${requests}; failure=${connectionFailure?.message ?? "none"}`);
	});
	for (let sequence = 34; sequence <= 161; sequence++) {
		transport.emitChild(makeGateRequest(sequence));
		await waitFor(() => replyCount(transport) >= sequence);
	}
	assert.equal(requests, 160);
	transport.emitChild(makeGateRequest(1));
	await waitFor(() => replyCount(transport) === 162);
	assert.equal(requests, 160, "cache misses are explicitly refused and never re-run business code");
	await run;
	await connection.deactivate(activation());
	await connection.close();
});

test("a stop/exit failure propagates from send and close instead of reporting a released resource", async () => {
	const transport = new FakeTransport();
	const exit = Promise.withResolvers<void>();
	transport.triggerFailure = new Error("native prompt rejected");
	transport.stopFailure = new RpcProcessExitTimeoutError("native process exit unknown", exit.promise);
	const connection = new TeamRpcV2Connection(transport, binding, loadoutFor(binding.memberId), () => undefined);
	let caught: unknown;
	try { await connection.sendActivation(activation(), async () => ({ kind: "ack" })); }
	catch (error) { caught = error; }
	assert.ok(caught instanceof TeamActivationFailure);
	assert.equal(caught.resourceReleased, false);
	assert.ok(caught.cause instanceof RpcProcessExitTimeoutError);
	await assert.rejects(connection.close(), /exit unknown/u);
	assert.equal(transport.stopCalls, 1, "stop is single-flight even when its exit confirmation rejects");
});
