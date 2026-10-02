import { randomUUID } from "node:crypto";
import type { RpcEvent, RpcTransport } from "./rpc-worker";
import {
	TEAM_ACTIVATION_TRIGGER, TEAM_COMMAND, TEAM_COMMAND_CACHE, TEAM_COMMAND_DESCRIPTION, TEAM_MAX_FRAME_BYTES,
	TEAM_MAX_ID_LENGTH, TEAM_MAX_PENDING_OPERATIONS, TEAM_PRIVATE_ENTRY_TYPE,
	type BindingV2, type ChildRequestFrame, type MemberLoadoutRequest, type ParentCommand, type PrivateReply, type TeamErrorCode,
} from "./team-protocol";
import type { NativeCompletion, RuntimeActivation } from "./team-runtime";
import { canonicalJson, jsonBytes, parseChildFrame, parseParentCommand, sameBinding, sameScope } from "./team-codec";
import { RunResultCollector } from "./run-result";
import type { SubagentUsage } from "./session-broker";

const DELIVERY_TIMEOUT_MS = 5000;

export class TeamActivationFailure extends Error {
	/** Native usage observed by this send before it failed; frozen, so it is folded at most once. */
	readonly usage: SubagentUsage | undefined;
	constructor(message: string, readonly resourceReleased: boolean, options?: ErrorOptions & { usage?: SubagentUsage }) {
		super(message, options);
		this.usage = options?.usage;
		this.name = "TeamActivationFailure";
	}
}

interface ActiveRun {
	activation: RuntimeActivation;
	onRequest(frame: ChildRequestFrame, intentId?: string): Promise<PrivateReply>;
	lastSequence: number;
	stagedIntent?: { intentId: string; nativeToolCallId: string };
	policyStopRequested: boolean;
	/** Native usage of this activation only; frozen by the collector at agent_settled. */
	usage: RunResultCollector;
	started: boolean;
	settled?: NativeCompletion;
	lastTurn?: { message: unknown; toolResults: unknown[] };
	candidateEndIntentTurn?: { message: unknown; toolResults: unknown[] };
	nativeToolCalls: Map<string, { toolName: string; execution?: { isError: boolean; terminate: boolean } }>;
	pendingNativeToolCalls: Set<string>;
	claimedNativeToolCalls: Set<string>;
	requests: Map<string, { fingerprint: string; reply?: PrivateReply }>;
	requestNativeToolCallIds: Map<string, string>;
	pendingRequests: number;
	resolveSettled(): void;
	rejectSettled(error: Error): void;
}

interface AckWaiter {
	fingerprint: string;
	binding: BindingV2;
	activation?: RuntimeActivation["scope"];
	resolve(): void;
	reject(error: Error): void;
}

interface RetiredCommand {
	fingerprint: string;
	binding: BindingV2;
	activation?: RuntimeActivation["scope"];
}

function commandActivation(command: ParentCommand): RuntimeActivation["scope"] | undefined {
	return command.operation === "activate" || command.operation === "reply" || command.operation === "deactivate"
		? command.activation : undefined;
}

function queueFullReply(frame: ChildRequestFrame, memberId: string): PrivateReply {
	if (frame.request.action === "business") {
		const error: { code: TeamErrorCode; message: string } = {
			code: "REQUEST_QUEUE_FULL", message: "Team private request capacity is full; no action was accepted",
		};
		return { kind: "business", reply: { ok: false, from: "@hub", to: memberId, error } };
	}
	if (frame.request.action === "boundary") return { kind: "ack" };
	return { kind: "gate", decision: { allow: false, reason: "budget", message: "Team private request capacity is full" } };
}

function staleRequestReply(frame: ChildRequestFrame, memberId: string): PrivateReply {
	if (frame.request.action === "business") {
		return { kind: "business", reply: { ok: false, from: "@hub", to: memberId, error: {
			code: "PROTOCOL_FAILURE", message: "This private request is outside the retained idempotency window; it was not executed",
		} } };
	}
	if (frame.request.action === "boundary") return { kind: "ack" };
	return { kind: "gate", decision: { allow: false, reason: "stale_scope", message: "This private request is outside the retained idempotency window" } };
}

function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function toolCalls(message: unknown): Array<{ id: string; name: string }> {
	if (!record(message) || !Array.isArray(message["content"])) return [];
	return message["content"].flatMap((part: unknown) => record(part) && part["type"] === "toolCall"
		&& typeof part["id"] === "string" && typeof part["name"] === "string" ? [{ id: part["id"], name: part["name"] }] : []);
}

function assistantText(message: unknown): string | undefined {
	if (!record(message) || message["role"] !== "assistant" || !Array.isArray(message["content"])) return undefined;
	return message["content"].flatMap((part: unknown) => record(part) && part["type"] === "text" && typeof part["text"] === "string" ? [part["text"]] : []).join("");
}

function resultId(result: unknown): string | undefined {
	return record(result) && typeof result["toolCallId"] === "string" ? result["toolCallId"] : undefined;
}

function isStagedEndIntent(frame: ChildRequestFrame, reply: PrivateReply, intentId?: string): string | undefined {
	if (frame.request.action !== "business" || !intentId || reply.kind !== "business" || !reply.reply.ok) return;
	const action = frame.request.args["action"];
	const closingTeam = action === "control" && frame.request.args["command"] === "close_team";
	const receipt = reply.reply.receipt;
	if ((action === "reply" || action === "yield") && receipt?.status === "staged") return intentId;
	if (closingTeam && receipt?.status === "closing" && receipt.command === "close_team") return intentId;
	return;
}

function completionFor(run: ActiveRun): NativeCompletion {
	const message = run.lastTurn?.message;
	const stopReason = record(message) ? message["stopReason"] : undefined;
	const nativeErrorMessage = record(message) && typeof message["errorMessage"] === "string" ? message["errorMessage"] : undefined;
	const contextAbortAfterPolicyStop = run.policyStopRequested && stopReason === "error" && nativeErrorMessage === "This operation was aborted";
	const finalCalls = toolCalls(message);
	const finalResults = run.lastTurn?.toolResults ?? [];
	const finalResultIds = new Set(finalResults.map(resultId).filter((id): id is string => id !== undefined));
	const pendingToolCalls = finalCalls.some((call) => !finalResultIds.has(call.id));
	let status: NativeCompletion["status"];
	if (stopReason === "aborted" || contextAbortAfterPolicyStop) status = "aborted";
	else if (stopReason === "error") status = "error";
	else if (stopReason === "length") status = "length";
	else if (stopReason === "stop" || stopReason === "toolUse") status = "success";
	else status = "error";

	let appliedToolCallId: string | undefined;
	const stagedIntent = run.stagedIntent;
	const nativeToolCallId = stagedIntent?.nativeToolCallId;
	const intentTurn = run.candidateEndIntentTurn;
	const intentCalls = toolCalls(intentTurn?.message);
	const intentResults = intentTurn?.toolResults ?? [];
	const intentTurnSettled = intentCalls.length === 1 && intentResults.length === 1
		&& intentCalls[0]!.id === nativeToolCallId && intentCalls[0]!.name === "team"
		&& resultId(intentResults[0]) === nativeToolCallId && record(intentResults[0])
		&& intentResults[0]["toolName"] === "team" && intentResults[0]["isError"] === false;
	// A runtime stop of a post-intent continuation (budget/policy) does not erase an already executed end intent.
	if ((status === "success" || (status === "aborted" && run.policyStopRequested)) && stagedIntent && nativeToolCallId && intentTurnSettled) {
		const executed = run.nativeToolCalls.get(nativeToolCallId);
		if (executed?.toolName === "team" && executed.execution?.isError === false && executed.execution.terminate) {
			appliedToolCallId = stagedIntent.intentId;
		}
	}
	const text = assistantText(message);
	return {
		status,
		usage: run.usage.result("").usage,
		...(text !== undefined ? { finalAssistantText: text } : {}),
		...(pendingToolCalls ? { pendingToolCalls: true } : {}),
		...(appliedToolCallId ? { appliedToolCallId } : {}),
		// Completion is private evidence. Runtime projects its public views without changing duplicate detection.
		...(status === "error" ? { error: { code: "NATIVE_FAILURE", message: nativeErrorMessage ?? "Pi assistant turn failed" } } : {}),
	};
}

/** One private v2 binding per native Pi session; activation scopes and RPC sequence reset per send. */
export class TeamRpcV2Connection {
	private unsubscribe: (() => void) | undefined;
	private bound = false;
	private bindingPromise?: Promise<void>;
	private closing?: Promise<void>;
	private stopping?: Promise<void>;
	private failure?: Error;
	private stopError?: Error;
	private run: ActiveRun | undefined;
	private lastClosedScope: RuntimeActivation["scope"] | undefined;
	private readonly acknowledgements = new Map<string, AckWaiter>();
	private readonly completedAcknowledgements = new Map<string, string>();
	private readonly retiredCommands = new Map<string, RetiredCommand>();
	private diagnostics = 0;

	constructor(
		private readonly transport: RpcTransport,
		private readonly binding: BindingV2,
		/** Base-tool allowlist (null keeps every base tool) and the static Team brief for the member's system prompt. */
		private readonly loadout: MemberLoadoutRequest,
		private readonly onFailure: (error: Error) => void,
		/** Display-only observer of native events inside an activation; it never affects the protocol. */
		private readonly onActivity?: (event: RpcEvent) => void,
	) {}

	get diagnosticCount(): number { return this.diagnostics; }

	bind(): Promise<void> {
		return this.bindingPromise ??= this.bindOnce();
	}

	private async bindOnce(): Promise<void> {
		try {
			this.unsubscribe = this.transport.onEvent((event) => this.onEvent(event));
			await this.command({ version: 2, commandId: randomUUID(), operation: "bind", binding: this.binding,
				loadout: { ...this.loadout, teamTool: true } });
			this.bound = true;
		} catch (error) {
			this.fail(error);
			try { await this.stopping; } catch (stopError) { throw stopError; }
			throw this.failure;
		}
	}

	async sendActivation(
		activation: RuntimeActivation,
		onRequest: (frame: ChildRequestFrame, intentId?: string) => Promise<PrivateReply>,
		signal?: AbortSignal,
	): Promise<NativeCompletion> {
		await this.bind();
		if (!this.bound || this.run || this.failure) throw this.failure ?? new Error("Team member session is not ready for an activation");
		if (!sameBinding(activation.binding, this.binding) || activation.input.deliveryId !== activation.deliveryId) {
			throw new Error("Team activation does not match its lifetime binding");
		}
		let resolveSettled!: () => void;
		let rejectSettled!: (error: Error) => void;
		const settled = new Promise<void>((resolve, reject) => { resolveSettled = resolve; rejectSettled = reject; });
		// A transport request can fail before control reaches `await settled`; keep its rejection observed.
		void settled.catch(() => undefined);
		const run: ActiveRun = {
			activation, onRequest, lastSequence: 0, started: false, policyStopRequested: false, usage: new RunResultCollector("", () => ""),
			requests: new Map(), requestNativeToolCallIds: new Map(), nativeToolCalls: new Map(),
			pendingNativeToolCalls: new Set(), claimedNativeToolCalls: new Set(), pendingRequests: 0,
			resolveSettled, rejectSettled,
		};
		this.run = run;
		let abortRequest: Promise<void> | undefined;
		const abortNativeRun = (): void => {
			if (run.settled || abortRequest) return;
			abortRequest = (async () => {
				try { await this.transport.request({ type: "clear_queue" }); } catch { /* Abort the active turn even if queued work cannot be cleared. */ }
				try { await this.transport.request({ type: "abort" }); }
				catch (error) { this.fail(error); }
			})();
		};
		signal?.addEventListener("abort", abortNativeRun, { once: true });
		try {
			await this.command({ version: 2, commandId: randomUUID(), operation: "activate", binding: this.binding,
				activation: activation.scope, deliveryId: activation.deliveryId, input: activation.input });
			const prompt = this.transport.request({ type: "prompt", message: TEAM_ACTIVATION_TRIGGER });
			if (signal?.aborted) abortNativeRun();
			await prompt;
			if (!run.started && !run.settled) {
				const state = await this.transport.request({ type: "get_state" }) as { isStreaming?: boolean } | undefined;
				if (!run.started && !run.settled && state?.isStreaming !== true) throw new Error("Team activation prompt did not start a native Pi run");
			}
			// Only command/application ACKs are bounded. Native work may legitimately
			// include provider retries, compaction, and multiple tool turns.
			await settled;
			if (this.failure) throw this.failure;
			return run.settled!;
		} catch (error) {
			const failure = this.failure ?? (error instanceof Error ? error : new Error(String(error)));
			this.fail(failure);
			// Real cost already observed stays attributable; later events cannot change it.
			run.usage.markSettled();
			const usage = run.usage.result("").usage;
			try { await this.stopping; }
			catch (stopError) {
				throw new TeamActivationFailure(failure.message, false,
					{ cause: stopError instanceof Error ? stopError : new Error(String(stopError)), usage });
			}
			throw new TeamActivationFailure(failure.message, true, { cause: failure, usage });
		} finally {
			signal?.removeEventListener("abort", abortNativeRun);
		}
	}

	async deactivate(activation: RuntimeActivation): Promise<void> {
		if (!this.run || !sameScope(this.run.activation.scope, activation.scope)) throw new Error("Team activation scope is not active");
		if (!this.run.settled) throw new Error("Team activation cannot deactivate before agent_settled");
		if (this.run.pendingRequests) throw new Error("Cannot deactivate while private Team requests are pending");
		await this.command({ version: 2, commandId: randomUUID(), operation: "deactivate", binding: this.binding, activation: activation.scope });
		this.lastClosedScope = activation.scope;
		this.run = undefined;
	}

	/** Fail closed and stop the process; a pending send rejects with the real stop/exit outcome. */
	terminate(error: Error): void {
		this.fail(error);
	}

	close(): Promise<void> {
		return this.closing ??= this.closeOnce();
	}

	private async closeOnce(): Promise<void> {
		try {
			if (this.bindingPromise) await this.bindingPromise;
			if (this.failure) throw this.failure;
			if (this.run) throw new Error("Cannot unbind a Team member with an active activation");
			if (this.bound) await this.command({ version: 2, commandId: randomUUID(), operation: "unbind", binding: this.binding });
		} catch (error) {
			this.fail(error);
			throw this.failure;
		} finally {
			this.bound = false;
			this.unsubscribe?.();
			this.unsubscribe = undefined;
			for (const waiter of this.acknowledgements.values()) waiter.reject(new Error("Team v2 connection closed"));
			this.acknowledgements.clear();
			try { await this.stopping; } catch (error) { this.stopError = error instanceof Error ? error : new Error(String(error)); }
			if (this.stopError) throw this.stopError;
		}
	}

	private bounded<T>(operation: Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => finish(new Error("Team v2 application ACK timed out")), DELIVERY_TIMEOUT_MS);
			const finish = (error?: Error, value?: T) => {
				clearTimeout(timer);
				if (error) reject(error); else resolve(value as T);
			};
			operation.then((value) => finish(undefined, value), (error) => finish(error instanceof Error ? error : new Error("Team v2 transport failed")));
		});
	}

	private async command(value: ParentCommand): Promise<void> {
		if (this.failure) throw this.failure;
		const frame = parseParentCommand(value);
		const commands = await this.bounded(this.transport.request({ type: "get_commands" })) as {
			commands?: Array<{ name?: string; source?: string; description?: string }>;
		} | undefined;
		const matches = commands?.commands?.filter((command) => command.name === TEAM_COMMAND || command.name?.startsWith(`${TEAM_COMMAND}:`));
		if (matches?.length !== 1 || matches[0]?.name !== TEAM_COMMAND || matches[0]?.source !== "extension"
			|| matches[0]?.description !== TEAM_COMMAND_DESCRIPTION) throw new Error("Missing, conflicting or incompatible Team v2 command");
		const text = JSON.stringify(frame);
		if (Buffer.byteLength(text) > TEAM_MAX_FRAME_BYTES) throw new Error("Team v2 command exceeds its frame limit");
		const fingerprint = canonicalJson(frame);
		const activation = commandActivation(frame);
		const ack = new Promise<void>((resolve, reject) => this.acknowledgements.set(frame.commandId, {
			fingerprint, binding: frame.binding, ...(activation ? { activation } : {}), resolve, reject,
		}));
		try {
			await this.bounded(Promise.all([ack, this.transport.request({ type: "prompt", message: `/${TEAM_COMMAND} ${text}` })]));
		} catch (error) {
			if (this.acknowledgements.has(frame.commandId)) this.rememberRetiredCommand(frame.commandId, {
				fingerprint, binding: frame.binding, ...(activation ? { activation } : {}),
			});
			throw error;
		} finally {
			this.acknowledgements.delete(frame.commandId);
		}
	}

	private onEvent(event: RpcEvent): void {
		if (event.type === "transport_error") { this.fail(new Error(String(event.error ?? "Team v2 transport lost"))); return; }
		if (event.type === "extension_error" && String(event["extensionPath"]).endsWith("team-extension-v2.ts")) {
			this.fail(new Error(String(event.error ?? "Team v2 extension failed"))); return;
		}
		const run = this.run;
		if (run) {
			if (!run.settled) {
				run.usage.ingest(event);
				try { this.onActivity?.(event); } catch { /* A display observer failure never affects the member. */ }
			}
			if (event.type === "agent_start") run.started = true;
			if (event.type === "tool_execution_start" && typeof event["toolCallId"] === "string" && typeof event["toolName"] === "string") {
				const toolCallId = event["toolCallId"];
				const toolName = event["toolName"];
				if (Buffer.byteLength(toolCallId, "utf8") > TEAM_MAX_ID_LENGTH) {
					this.fail(new Error("Native tool-call ID exceeds its evidence bound"));
					return;
				}
				const previous = run.nativeToolCalls.get(toolCallId);
				if (previous && previous.toolName !== toolName) { this.fail(new Error("Native tool-call id changed tool name")); return; }
				if (!previous) run.nativeToolCalls.set(toolCallId, { toolName });
				run.pendingNativeToolCalls.add(toolCallId);
				if (run.pendingNativeToolCalls.size > TEAM_MAX_PENDING_OPERATIONS) {
					this.fail(new Error("Native pending tool-call capacity exceeded"));
					return;
				}
			}
			if (event.type === "turn_end") {
				const turn = { message: event["message"], toolResults: Array.isArray(event["toolResults"]) ? event["toolResults"] : [] };
				run.lastTurn = turn;
				const intentCall = run.stagedIntent?.nativeToolCallId;
				const intentTurnKept = intentCall !== undefined && toolCalls(run.candidateEndIntentTurn?.message).some((call) => call.id === intentCall);
				if (!intentTurnKept && record(turn.message) && turn.message["role"] === "assistant" && toolCalls(turn.message).length > 0) {
					run.candidateEndIntentTurn = turn;
				}
			}
			if (event.type === "tool_execution_end" && typeof event["toolCallId"] === "string" && typeof event["toolName"] === "string") {
				const toolCallId = event["toolCallId"];
				const evidence = run.nativeToolCalls.get(toolCallId);
				if (evidence && evidence.toolName === event["toolName"]) {
					evidence.execution = { isError: event["isError"] === true,
						terminate: record(event["result"]) && event["result"]["terminate"] === true };
					run.pendingNativeToolCalls.delete(toolCallId);
					run.claimedNativeToolCalls.delete(toolCallId);
					this.pruneNativeToolCalls(run);
				}
			}
			if (event.type === "agent_settled" && !run.settled) {
				run.settled = completionFor(run);
				delete run.candidateEndIntentTurn;
				run.nativeToolCalls.clear();
				run.pendingNativeToolCalls.clear();
				run.claimedNativeToolCalls.clear();
				run.resolveSettled();
			}
		}
		if (event.type !== "entry_appended") return;
		const entry = event["entry"] as { type?: string; customType?: string; data?: unknown } | undefined;
		if (entry?.type !== "custom" || entry.customType !== TEAM_PRIVATE_ENTRY_TYPE) return;
		try {
			// Check the complete wire object, including native evidence removed for core parsing.
			if (jsonBytes(entry.data) > TEAM_MAX_FRAME_BYTES) throw new Error("Team v2 child frame exceeds its frame limit");
			let nativeToolCallId: string | undefined;
			let parseValue = entry.data;
			if (record(entry.data) && record(entry.data["request"]) && entry.data["request"]["action"] === "business") {
				const rawRequest = entry.data["request"];
				if (typeof rawRequest["toolCallId"] !== "string" || rawRequest["toolCallId"].length === 0
					|| Buffer.byteLength(rawRequest["toolCallId"], "utf8") > TEAM_MAX_ID_LENGTH) {
					throw new Error("Team business request lacks native tool-call evidence");
				}
				nativeToolCallId = rawRequest["toolCallId"];
				const request = { ...rawRequest };
				delete request["toolCallId"];
				parseValue = { ...entry.data, request };
			}
			const frame = parseChildFrame(parseValue);
			if (!sameBinding(frame.binding, this.binding)) throw new Error("Team v2 frame binding does not match the native lifetime");
			if (frame.kind === "ack") {
				const waiter = this.acknowledgements.get(frame.commandId);
				const fingerprint = canonicalJson(frame);
				if (waiter) {
					if (!sameBinding(frame.binding, waiter.binding)) throw new Error("Team v2 ACK binding does not match its command");
					if (waiter.activation ? !frame.activation || !sameScope(frame.activation, waiter.activation) : frame.activation !== undefined) {
						throw new Error("Team v2 ACK activation scope does not match its command");
					}
					this.rememberCompletedAck(frame.commandId, fingerprint);
					if (!frame.ok) waiter.reject(new Error(frame.error ?? "Team v2 command was rejected"));
					else waiter.resolve();
					return;
				}
				const completed = this.completedAcknowledgements.get(frame.commandId);
				if (completed !== undefined) {
					if (completed !== fingerprint) throw new Error("Conflicting duplicate Team v2 command ACK");
					this.diagnostics++;
					return;
				}
				const retired = this.retiredCommands.get(frame.commandId);
				if (retired) {
					if (!sameBinding(frame.binding, retired.binding)
						|| (retired.activation ? !frame.activation || !sameScope(frame.activation, retired.activation) : frame.activation !== undefined)) {
						throw new Error("Late Team v2 ACK does not match its retired command");
					}
					this.retiredCommands.delete(frame.commandId);
					this.rememberCompletedAck(frame.commandId, fingerprint);
					this.diagnostics++;
					return;
				}
				if (frame.activation && this.lastClosedScope && sameScope(frame.activation, this.lastClosedScope)) {
					this.diagnostics++;
					return;
				}
				throw new Error("Unknown Team v2 command ACK");
			}
			const run = this.run;
			if (!run || !sameScope(frame.activation, run.activation.scope)) {
				if (this.lastClosedScope && sameScope(frame.activation, this.lastClosedScope)) { this.diagnostics++; return; }
				throw new Error("Team v2 request has a stale activation scope");
			}
			const fingerprint = canonicalJson(frame);
			const cached = run.requests.get(frame.rpcRequestId);
			if (cached) {
				if (cached.fingerprint !== fingerprint) throw new Error("Conflicting duplicate Team v2 request id");
				if (run.requestNativeToolCallIds.get(frame.rpcRequestId) !== nativeToolCallId) throw new Error("Duplicate Team request changed its native tool-call evidence");
				this.diagnostics++;
				if (cached.reply) void this.sendReply(frame, run, cached.reply);
				return;
			}
			if (frame.sequence <= run.lastSequence) {
				this.diagnostics++;
				void this.sendReply(frame, run, staleRequestReply(frame, this.binding.memberId));
				return;
			}
			run.lastSequence = frame.sequence;
			if (frame.request.action === "business") {
				if (!nativeToolCallId || !run.pendingNativeToolCalls.has(nativeToolCallId)
					|| run.claimedNativeToolCalls.has(nativeToolCallId) || run.nativeToolCalls.get(nativeToolCallId)?.toolName !== "team") {
					throw new Error("Team business request does not match a pending native team tool call");
				}
				run.claimedNativeToolCalls.add(nativeToolCallId);
				run.requestNativeToolCallIds.set(frame.rpcRequestId, nativeToolCallId);
			}
			if (run.pendingRequests >= TEAM_MAX_PENDING_OPERATIONS) {
				const reply = queueFullReply(frame, this.binding.memberId);
				run.requests.set(frame.rpcRequestId, { fingerprint, reply });
				this.pruneRequests(run);
				void this.sendReply(frame, run, reply);
				return;
			}
			run.requests.set(frame.rpcRequestId, { fingerprint });
			run.pendingRequests++;
			void this.answer(frame, run);
		} catch (error) { this.fail(error); }
	}

	private async answer(frame: ChildRequestFrame, run: ActiveRun): Promise<void> {
		try {
			const intentId = frame.request.action === "business" ? `team-intent-${frame.rpcRequestId}` : undefined;
			const reply = await run.onRequest(frame, intentId);
			if (frame.request.action === "provider_gate" && reply.kind === "gate" && !reply.decision.allow
				&& (reply.decision.reason === "policy_stop" || reply.decision.reason === "budget")) run.policyStopRequested = true;
			const stagedIntentId = isStagedEndIntent(frame, reply, intentId);
			if (stagedIntentId) {
				const nativeToolCallId = run.requestNativeToolCallIds.get(frame.rpcRequestId);
				if (!nativeToolCallId) throw new Error("Staged Team intent lacks native tool-call evidence");
				if (run.stagedIntent && (run.stagedIntent.intentId !== stagedIntentId || run.stagedIntent.nativeToolCallId !== nativeToolCallId)) {
					throw new Error("Conflicting native tool-call evidence for staged Team intent");
				}
				run.stagedIntent = { intentId: stagedIntentId, nativeToolCallId };
			}
			const cached = run.requests.get(frame.rpcRequestId);
			if (!cached) throw new Error("Team v2 request cache entry disappeared while pending");
			cached.reply = reply;
			run.pendingRequests--;
			this.pruneRequests(run);
			await this.sendReply(frame, run, reply);
		} catch (error) { this.fail(error); }
	}

	private async sendReply(frame: ChildRequestFrame, run: ActiveRun, reply: PrivateReply): Promise<void> {
		if (this.run !== run || !sameScope(this.run.activation.scope, frame.activation)) {
			this.diagnostics++;
			return;
		}
		await this.command({ version: 2, commandId: randomUUID(), operation: "reply", binding: this.binding,
			activation: run.activation.scope, rpcRequestId: frame.rpcRequestId, reply });
	}

	private pruneRequests(run: ActiveRun): void {
		let completed = [...run.requests.values()].filter((entry) => entry.reply !== undefined).length;
		if (completed <= TEAM_COMMAND_CACHE) return;
		for (const [id, entry] of run.requests) {
			if (entry.reply === undefined) continue;
			run.requests.delete(id);
			run.requestNativeToolCallIds.delete(id);
			if (--completed <= TEAM_COMMAND_CACHE) break;
		}
	}

	private pruneNativeToolCalls(run: ActiveRun): void {
		if (run.nativeToolCalls.size <= TEAM_COMMAND_CACHE) return;
		for (const [id] of run.nativeToolCalls) {
			if (id === run.stagedIntent?.nativeToolCallId || run.pendingNativeToolCalls.has(id)) continue;
			run.nativeToolCalls.delete(id);
			if (run.nativeToolCalls.size <= TEAM_COMMAND_CACHE) break;
		}
	}

	private rememberCompletedAck(commandId: string, fingerprint: string): void {
		this.completedAcknowledgements.delete(commandId);
		this.completedAcknowledgements.set(commandId, fingerprint);
		while (this.completedAcknowledgements.size > TEAM_COMMAND_CACHE) {
			this.completedAcknowledgements.delete(this.completedAcknowledgements.keys().next().value!);
		}
	}

	private rememberRetiredCommand(commandId: string, command: RetiredCommand): void {
		this.retiredCommands.delete(commandId);
		this.retiredCommands.set(commandId, command);
		while (this.retiredCommands.size > TEAM_COMMAND_CACHE) this.retiredCommands.delete(this.retiredCommands.keys().next().value!);
	}

	private fail(value: unknown): void {
		if (this.failure) return;
		this.failure = value instanceof Error ? value : new Error(String(value));
		this.onFailure(this.failure);
		for (const waiter of this.acknowledgements.values()) waiter.reject(this.failure);
		this.acknowledgements.clear();
		this.run?.rejectSettled(this.failure);
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.stopping ??= Promise.resolve().then(() => this.transport.stop());
		void this.stopping.catch((error: unknown) => {
			this.stopError = error instanceof Error ? error : new Error(String(error));
		});
	}
}