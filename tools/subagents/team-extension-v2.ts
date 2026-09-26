import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	TEAM_ACTIVATION_MESSAGE_TYPE, TEAM_ACTIVATION_TRIGGER, TEAM_COMMAND, TEAM_COMMAND_CACHE, TEAM_COMMAND_DESCRIPTION,
	TEAM_MAX_PENDING_OPERATIONS, TEAM_PRIVATE_ENTRY_TYPE,
	type ActivationInput, type ActivationScope, type BindingV2, type ChildRequestFrame, type ParentCommand,
	type PrivateAction, type PrivateReply, type TeamReply,
} from "./team-protocol";
import { TEAM_TOOL_DESCRIPTION, TEAM_TOOL_SCHEMA } from "./team-codec";
import { canonicalJson, isRecord, parseParentCommand, sameBinding, sameScope } from "./team-codec";

interface ActiveActivation {
	scope: ActivationScope;
	deliveryId: string;
	input: ActivationInput;
	sequence: number;
	inputReady: boolean;
	customMessageCreated: boolean;
}

interface PendingRequest {
	resolve(reply: PrivateReply): void;
	reject(error: Error): void;
}

interface CommandRecord {
	fingerprint: string;
	result: Promise<ReturnType<typeof commandAck>>;
	ack?: ReturnType<typeof commandAck>;
}

function commandAck(command: ParentCommand, ok: boolean, error?: string) {
	const activation = command.operation === "activate" || command.operation === "deactivate" || command.operation === "reply"
		? command.activation : undefined;
	return { version: 2 as const, kind: "ack" as const, commandId: command.commandId, binding: command.binding,
		...(activation ? { activation } : {}), ok, ...(!ok ? { error: error ?? "Team v2 command rejected" } : {}) };
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part: unknown) => isRecord(part) && part["type"] === "text" && typeof part["text"] === "string" ? [part["text"]] : []).join("");
}

function activationDetails(binding: BindingV2, active: ActiveActivation): Record<string, unknown> {
	return { teamId: binding.teamId, memberId: binding.memberId, deliveryId: active.deliveryId,
		...(active.scope.kind === "work" ? { work: active.scope.work } : {}) };
}

function exactPersistedActivation(ctx: ExtensionContext, eventMessages: readonly unknown[], binding: BindingV2, active: ActiveActivation): boolean {
	const expectedContent = canonicalJson(active.input);
	const expectedDetails = canonicalJson(activationDetails(binding, active));
	const visible = eventMessages.some((raw) => isRecord(raw) && raw["role"] === "custom"
		&& raw["customType"] === TEAM_ACTIVATION_MESSAGE_TYPE && contentText(raw["content"]) === expectedContent
		&& canonicalJson(raw["details"]) === expectedDetails);
	if (!visible) return false;
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 1; index--) {
		const entry = branch[index]!;
		if (entry.type !== "custom_message" || entry.customType !== TEAM_ACTIVATION_MESSAGE_TYPE
			|| contentText(entry.content) !== expectedContent || canonicalJson(entry.details) !== expectedDetails) continue;
		const trigger = branch[index - 1]!;
		return trigger.type === "message" && trigger.message.role === "user"
			&& contentText(trigger.message.content) === TEAM_ACTIVATION_TRIGGER;
	}
	return false;
}

function finalAssistantIsSoleToolCall(ctx: ExtensionContext, toolCallId: string): boolean {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const calls = entry.message.content.filter((part) => part.type === "toolCall");
		return calls.length === 1 && calls[0]!.id === toolCallId;
	}
	return false;
}

function isEndIntent(args: Record<string, unknown>): boolean {
	if (args["action"] === "reply" || args["action"] === "yield") return true;
	return args["action"] === "control" && args["command"] === "close_team";
}

function stagedReply(reply: TeamReply): boolean {
	return reply.ok && (reply.receipt?.status === "staged"
		|| (reply.receipt?.status === "closing" && reply.receipt.command === "close_team"));
}

export default function install(pi: ExtensionAPI): void {
	let binding: BindingV2 | undefined;
	let active: ActiveActivation | undefined;
	let previousTools: string[] = [];
	let registered = false;
	const pending = new Map<string, PendingRequest>();
	const commands = new Map<string, CommandRecord>();
	const replies = new Map<string, { fingerprint: string; activation: ActivationScope }>();
	let pendingCommands = 0;
	let closedActivation: ActivationScope | undefined;
	let unboundBinding: BindingV2 | undefined;
	let latePrivateFrames = 0;

	const pruneCommands = (): void => {
		let completed = [...commands.values()].filter((entry) => entry.ack !== undefined).length;
		if (completed <= TEAM_COMMAND_CACHE) return;
		for (const [id, entry] of commands) {
			if (!entry.ack) continue;
			commands.delete(id);
			if (--completed <= TEAM_COMMAND_CACHE) break;
		}
	};
	const pruneReplies = (): void => {
		while (replies.size > TEAM_COMMAND_CACHE) replies.delete(replies.keys().next().value!);
	};
	const appendAck = (command: ParentCommand, ok: boolean, error?: string) => {
		const ack = commandAck(command, ok, error);
		pi.appendEntry(TEAM_PRIVATE_ENTRY_TYPE, ack);
		return ack;
	};

	const fail = (ctx: ExtensionContext, error: unknown): Error => {
		const failure = error instanceof Error ? error : new Error(String(error));
		for (const waiter of pending.values()) waiter.reject(failure);
		pending.clear();
		ctx.abort();
		return failure;
	};

	const request = (action: PrivateAction, ctx: ExtensionContext, signal?: AbortSignal, nativeToolCallId?: string): Promise<PrivateReply> => {
		if (!binding || !active) return Promise.reject(new Error("Team member is not activated"));
		if (pending.size >= TEAM_MAX_PENDING_OPERATIONS) return Promise.reject(new Error("Team private request capacity is full"));
		const sequence = ++active.sequence;
		const rpcRequestId = randomUUID();
		const frame: ChildRequestFrame = { version: 2, kind: "request", binding, activation: active.scope, sequence, rpcRequestId, request: action };
		return new Promise<PrivateReply>((resolve, reject) => {
			const cleanup = () => { pending.delete(rpcRequestId); signal?.removeEventListener("abort", abort); };
			const abort = () => { cleanup(); reject(new Error("Team v2 private request aborted")); };
			pending.set(rpcRequestId, { resolve: (reply) => { cleanup(); resolve(reply); }, reject: (error) => { cleanup(); reject(error); } });
			signal?.addEventListener("abort", abort, { once: true });
			try {
				const wireFrame = nativeToolCallId
					? { ...frame, request: { ...frame.request, toolCallId: nativeToolCallId } }
					: frame;
				pi.appendEntry(TEAM_PRIVATE_ENTRY_TYPE, wireFrame);
			}
			catch (error) { cleanup(); reject(fail(ctx, error)); }
		});
	};

	const acknowledgeToolResult = async (toolCallId: string, toolName: string, ctx: ExtensionContext): Promise<void> => {
		const reply = await request({ action: "tool_result", toolCallId, toolName }, ctx);
		if (reply.kind !== "ack") throw new Error("Team runtime returned an invalid tool-result acknowledgment");
	};

	const registerTeamTool = (): void => {
		if (registered) return;
		if (pi.getAllTools().some((tool) => tool.name === "team")) throw new Error("Conflicting team tool in Team v2 member session");
		pi.registerTool({
			name: "team",
			label: "Team",
			description: `${TEAM_TOOL_DESCRIPTION} reply, yield, and close_team must be the only tool call in their finalized assistant batch.`,
			parameters: TEAM_TOOL_SCHEMA,
			executionMode: "sequential",
			async execute(toolCallId, params, signal, _update, ctx) {
				if (!binding || !active) throw new Error("Team tool is unavailable outside an active Team activation");
				if (isEndIntent(params) && !finalAssistantIsSoleToolCall(ctx, toolCallId)) {
					throw new Error("Team reply/yield/close_team must be the only tool call in the finalized assistant batch");
				}
				const reply = await request({ action: "business", args: params }, ctx, signal ?? ctx.signal, toolCallId);
				if (reply.kind !== "business") throw new Error("Team runtime returned a non-business reply for a team action");
				if (!reply.reply.ok) throw new Error(JSON.stringify(reply.reply.error));
				return {
					content: [{ type: "text", text: JSON.stringify(reply.reply) }],
					details: reply.reply,
					...(stagedReply(reply.reply) ? { terminate: true } : {}),
				};
			},
		});
		registered = true;
	};

	pi.registerCommand(TEAM_COMMAND, {
		description: TEAM_COMMAND_DESCRIPTION,
		handler: async (args, ctx) => {
			if (typeof args !== "string") throw new Error("Team v2 command frame must be JSON text");
			const command = parseParentCommand(JSON.parse(args));
			const fingerprint = canonicalJson(command);
			const cached = commands.get(command.commandId);
			if (cached) {
				if (cached.fingerprint !== fingerprint) {
					appendAck(command, false, "Conflicting duplicate commandId");
					return;
				}
				pi.appendEntry(TEAM_PRIVATE_ENTRY_TYPE, cached.ack ?? await cached.result);
				return;
			}
			if (pendingCommands >= TEAM_MAX_PENDING_OPERATIONS) {
				const ack = commandAck(command, false, "Team private command capacity is full");
				commands.set(command.commandId, { fingerprint, result: Promise.resolve(ack), ack });
				pruneCommands();
				pi.appendEntry(TEAM_PRIVATE_ENTRY_TYPE, ack);
				return;
			}
			let resolveResult!: (ack: ReturnType<typeof commandAck>) => void;
			const result = new Promise<ReturnType<typeof commandAck>>((resolve) => { resolveResult = resolve; });
			const record: CommandRecord = { fingerprint, result };
			commands.set(command.commandId, record);
			pendingCommands++;
			let errorMessage: string | undefined;
			try {
				switch (command.operation) {
					case "bind": {
						if (binding) {
							if (sameBinding(binding, command.binding)) break;
							throw new Error("Team v2 lifetime is already bound to another member");
						}
						if (unboundBinding || active || pending.size || !ctx.isIdle()) throw new Error("Team v2 bind requires an unbound idle session");
						previousTools = pi.getActiveTools();
						registerTeamTool();
						binding = command.binding;
						const memberTools = previousTools.filter((name) => !["subagent", "subagent_team", "team"].includes(name));
						pi.setActiveTools(command.loadout.role === "manager" ? ["team"] : [...memberTools, "team"]);
						break;
					}
					case "activate": {
						if (!binding || !sameBinding(binding, command.binding)) throw new Error("Team v2 activation binding is stale");
						if (active) {
							if (sameScope(active.scope, command.activation) && active.deliveryId === command.deliveryId
								&& canonicalJson(active.input) === canonicalJson(command.input)) break;
							throw new Error("Team v2 activation overlaps another active scope");
						}
						if (closedActivation && sameScope(closedActivation, command.activation)) throw new Error("Team v2 activation is already closed");
						if (pending.size || !ctx.isIdle()) throw new Error("Team v2 activation requires an idle session");
						active = { scope: command.activation, deliveryId: command.deliveryId, input: command.input, sequence: 0,
							inputReady: false, customMessageCreated: false };
						break;
					}
					case "reply": {
						if (!binding || !sameBinding(binding, command.binding)) throw new Error("Team v2 reply binding is stale");
						const replyFingerprint = canonicalJson({ activation: command.activation, rpcRequestId: command.rpcRequestId, reply: command.reply });
						const previous = replies.get(command.rpcRequestId);
						if (previous) {
							if (previous.fingerprint !== replyFingerprint || !sameScope(previous.activation, command.activation)) throw new Error("Conflicting duplicate private reply");
							break;
						}
						if (!active || !sameScope(active.scope, command.activation)) {
							if (closedActivation && sameScope(closedActivation, command.activation)) { latePrivateFrames++; break; }
							throw new Error("Team v2 reply has a stale activation scope");
						}
						const waiter = pending.get(command.rpcRequestId);
						if (!waiter) { latePrivateFrames++; break; }
						replies.set(command.rpcRequestId, { fingerprint: replyFingerprint, activation: command.activation });
						pruneReplies();
						waiter.resolve(command.reply);
						break;
					}
					case "deactivate":
						if (!binding || !sameBinding(binding, command.binding)) throw new Error("Team v2 deactivate binding is stale");
						if (!active && closedActivation && sameScope(closedActivation, command.activation)) break;
						if (!active || !sameScope(active.scope, command.activation) || pending.size || !ctx.isIdle()) throw new Error("Team v2 deactivate requires the settled active scope and an idle session");
						closedActivation = active.scope;
						active = undefined;
						break;
					case "unbind":
						if (!binding) {
							if (unboundBinding && sameBinding(unboundBinding, command.binding)) break;
							throw new Error("Team v2 unbind has no matching lifetime");
						}
						if (!sameBinding(binding, command.binding) || active || pending.size || !ctx.isIdle()) throw new Error("Team v2 unbind requires an idle, inactive lifetime");
						pi.setActiveTools(previousTools.filter((name) => name !== "team"));
						unboundBinding = binding;
						binding = undefined;
						break;
				}
			} catch (error) {
				errorMessage = error instanceof Error ? error.message : "Team v2 command rejected";
			}
			pendingCommands--;
			record.ack = commandAck(command, errorMessage === undefined, errorMessage);
			resolveResult(record.ack);
			pruneCommands();
			pi.appendEntry(TEAM_PRIVATE_ENTRY_TYPE, record.ack);
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!binding) return;
		if (!active) {
			ctx.abort();
			return;
		}
		if (event.prompt !== TEAM_ACTIVATION_TRIGGER) {
			fail(ctx, new Error("Team activation used an unexpected native trigger prompt"));
			return;
		}
		const message = active.customMessageCreated ? undefined : {
			customType: TEAM_ACTIVATION_MESSAGE_TYPE,
			content: canonicalJson(active.input),
			display: false,
			details: activationDetails(binding, active),
		};
		active.customMessageCreated = true;
		return { ...(message ? { message } : {}),
			systemPrompt: `${event.systemPrompt}\n\nTeam member: ${binding.memberId} (${binding.role}). The rail-team-activation custom message is authoritative for this activation. Use the team tool for Team operations. A successful reply, yield, or close_team ends this native activation; each end intent must be the sole tool call in the finalized assistant batch. Do not claim a result unless the runtime accepts the team reply.` };
	});

	pi.on("context", async (event, ctx) => {
		if (!binding) return;
		if (!active) {
			ctx.abort();
			return;
		}
		try {
			if (!active.inputReady) {
				if (!exactPersistedActivation(ctx, event.messages, binding, active)) throw new Error("Team v2 activation custom message is not the exact persisted native input");
				const inputReply = await request({ action: "input_ready", deliveryId: active.deliveryId }, ctx, ctx.signal);
				if (inputReply.kind !== "ack") throw new Error("Team runtime did not acknowledge the exact activation input");
				active.inputReady = true;
			}
			const reply = await request({ action: "provider_gate" }, ctx, ctx.signal);
			if (reply.kind !== "gate") throw new Error("Team runtime returned an invalid provider gate");
			if (!reply.decision.allow) {
				ctx.abort();
				return;
			}
		} catch (error) {
			fail(ctx, error);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!binding) return;
		if (!active) return { block: true, reason: "Team tool use requires an active Team activation" };
		if (event.toolName === "subagent" || event.toolName === "subagent_team") return { block: true, reason: "Team members cannot spawn subagents" };
		try {
			const reply = await request({ action: "tool_gate", toolCallId: event.toolCallId, toolName: event.toolName,
				endIntent: event.toolName === "team" && isRecord(event.input) && isEndIntent(event.input) }, ctx, ctx.signal);
			if (reply.kind !== "gate") return { block: true, reason: "Team runtime returned an invalid tool gate" };
			if (!reply.decision.allow) {
				try { await acknowledgeToolResult(event.toolCallId, event.toolName, ctx); }
				catch (error) {
					fail(ctx, error);
					return { block: true, reason: error instanceof Error ? error.message : "Team tool-result acknowledgment failed" };
				}
				return { block: true, reason: reply.decision.message };
			}
		} catch (error) {
			return { block: true, reason: error instanceof Error ? error.message : "Team tool gate failed" };
		}
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!binding || !active) return;
		try {
			await acknowledgeToolResult(event.toolCallId, event.toolName, ctx);
		} catch (error) {
			fail(ctx, error);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (binding || active) fail(ctx, new Error("Team v2 native session shut down while bound"));
		if (latePrivateFrames) pi.appendEntry(`${TEAM_PRIVATE_ENTRY_TYPE}-diagnostic`, {
			version: 2, kind: "late_frames_ignored", count: latePrivateFrames,
		});
		active = undefined;
		binding = undefined;
	});

	pi.on("cache_warming_decision", () => binding ? { action: "stop" } : undefined);
}