import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const ACTIVATION_TRIGGER = "Process the current Rail Team input.";

function messageText(message) {
	if (typeof message?.content === "string") return message.content;
	if (!Array.isArray(message?.content)) return "";
	return message.content.flatMap((part) => part?.type === "text" && typeof part.text === "string" ? [part.text] : []).join("");
}

function latestActivation(messages) {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		const text = messageText(message);
		let input;
		try { input = JSON.parse(text); } catch {
			const compacted = text.match(/TEAM_V2_ACTIVATION_INPUT:(\{[^\n]+\})/u)?.[1];
			if (!compacted) continue;
			input = JSON.parse(compacted);
		}
		if (input?.version !== 2 || typeof input.deliveryId !== "string" || !input.scope) continue;
		if (message?.role === "user" && messageText(message) === JSON.stringify(input)) {
			const trigger = messages[index - 1];
			if (trigger?.role !== "user" || messageText(trigger) !== ACTIVATION_TRIGGER) {
				throw new Error("Canonical Team activation was not written after the fixed native trigger");
			}
			return { input, index, triggerIndex: index - 1 };
		}
		return { input, index, triggerIndex: undefined };
	}
	throw new Error("No native custom Team v2 activation message in provider context");
}

function teamReplies(messages, activationIndex) {
	const replies = messages.slice(activationIndex + 1).filter((message) => message?.role === "toolResult" && message.toolName === "team").map((message) => {
		const text = messageText(message);
		if (!text) return undefined;
		try { return JSON.parse(text); } catch { return { toolError: text }; }
	}).filter(Boolean);
	for (const message of messages) {
		const text = messageText(message);
		const compacted = text.match(/TEAM_V2_TOOL_REPLIES:(\[[^\n]*\])/u)?.[1];
		if (compacted) {
			try { replies.push(...JSON.parse(compacted)); } catch { /* Leave malformed native summary for the test assertion. */ }
		}
	}
	return replies;
}

function call(id, args) {
	return { type: "toolCall", id, name: "team", arguments: args };
}

const A09_CONTINUATION = "third-party boundary continuation";

function actionFor(scenario, input, replies, turn, messages = [], activationIndex = 0) {
	if (scenario === "a09-live" && input.scope.kind === "work") {
		const lastUser = [...messages].reverse().find((message) => message?.role === "user");
		// The continuation a third-party extension forced after the staged reply tries new side effects.
		if (messageText(lastUser) === A09_CONTINUATION) return [
			call(`a09-request-${turn}`, { action: "request", to: "w2", task: "side effect after the intent", inputRefs: [] }),
			{ type: "toolCall", id: `a09-bash-${turn}`, name: "bash", arguments: { command: "printf a09-side-effect" } },
		];
		return [call("a09-reply", { action: "reply", result: { status: "succeeded", summary: "A09 staged reply." } })];
	}
	if ((scenario === "broker-stop" || scenario === "broker-delete") && input.scope.kind === "work") {
		if (input.scope.task === "stop target") return [{ type: "toolCall", id: "broker-stop-latched", name: "bash", arguments: { command: "sleep 30; printf must-not-finish" } }];
		if (input.scope.task === "unrelated root") {
			const delayFinished = messages.some((message) => message?.role === "toolResult" && message.toolCallId === "broker-unrelated-delay");
			if (!delayFinished) return [{ type: "toolCall", id: "broker-unrelated-delay", name: "bash", arguments: { command: "sleep 1; printf unrelated-root-still-ran" } }];
			return [call("broker-unrelated-reply", { action: "reply", result: { status: "succeeded", summary: "The unrelated worker root completed after a sibling member was stopped." } })];
		}
	}
	if (scenario === "budget-live" && input.scope.kind === "work" && input.scope.task === "W1 root") {
		// The first activation runs one bash step and is then stopped by the root model budget; after a
		// host grant the same WorkRef resumes in the same session and sees that earlier real side effect.
		const priorStep = messages.slice(0, activationIndex).some((message) => message?.role === "toolResult" && message.toolCallId === "budget-bash");
		if (priorStep) return [call("budget-reply", { action: "reply", result: {
			status: "succeeded", summary: "Resumed after the host budget grant without repeating the bash step.",
		} })];
		return [{ type: "toolCall", id: "budget-bash", name: "bash", arguments: { command: "printf budget-step" } }];
	}
	if (scenario === "tool-budget" && input.scope.kind === "work") {
		// Two invalid end intents (still real, counted tool calls), then a legal final reply past the limit.
		if (replies.length === 0) return [call("tool-budget-bad-yield", { action: "yield", waitingFor: [{ workId: "missing-work", revision: 1 }] })];
		if (replies.length === 1) return [call("tool-budget-idle-yield", { action: "yield" })];
		return [call("tool-budget-reply", { action: "reply", result: { status: "succeeded", summary: "Finished with the final attempt." } })];
	}
	if (scenario === "manager-midstop" && input.scope.kind === "management") {
		// The BOOT batch keeps reading status until the Team model budget stops it mid-activation.
		if (input.scope.events.some((event) => event.kind === "BOOT")) return [call(`midstop-status-${turn}`, { action: "status", view: "team" })];
		return [{ type: "text", text: `Emergency checkpoint: ${input.scope.events.map((event) => event.kind).join(",")}` }];
	}
	if (scenario === "manager-budget") {
		if (input.scope.kind === "work") return [call("manager-budget-root-reply", { action: "reply", result: {
			status: "succeeded", summary: "Root result for the emergency Manager.",
		} })];
		const root = input.scope.events.find((event) => event.kind === "ROOT_RESULT_READY");
		if (!root) return [{ type: "text", text: `Manager checkpoint ${input.notice}` }];
		if (replies.length === 0) return [call("manager-budget-request", { action: "request", to: "w1", task: "extra work", inputRefs: [] })];
		if (replies.length === 1) return [call("manager-budget-accept", { action: "control", command: "accept_result", work: root.work, disposition: "accepted" })];
		return [call("manager-budget-close", { action: "control", command: "close_team", resultRefs: [root.resultRef], outcome: "succeeded" })];
	}
	if (["pause-mixed", "revise-live", "cancel-live"].includes(scenario) && input.scope.kind === "management") {
		const userCommand = input.scope.events.find((event) => event.kind === "USER_COMMAND");
		if (userCommand) {
			const completed = replies.some((reply) => reply.receipt?.status === "applied"
				&& (reply.receipt.command === "pause_member" || reply.receipt.command === "resume_member"
					|| reply.receipt.command === "revise_work" || reply.receipt.command === "cancel_work"));
			if (completed) return [{ type: "text", text: `Host command processed: ${userCommand.message}` }];
			if (scenario === "pause-mixed") {
				const command = userCommand.message.includes("resume") ? "resume_member" : "pause_member";
				return [call(`${command}-from-host`, { action: "control", command, memberId: "w1" })];
			}
			let hostIntent;
			try { hostIntent = JSON.parse(userCommand.message); } catch { /* Fall back to a read-only work status lookup. */ }
			if (scenario === "revise-live" && hostIntent?.command === "revise_work") return [call("revise-live-root", {
				action: "control", command: "revise_work", workId: hostIntent.workId,
				expectedRevision: hostIntent.expectedRevision, task: "revised root", inputRefs: [],
			})];
			if (scenario === "cancel-live" && hostIntent?.command === "cancel_work") return [call("cancel-live-root", {
				action: "control", command: "cancel_work", workId: hostIntent.workId,
				expectedRevision: hostIntent.expectedRevision, reason: "Host selected cancellation during the active tool.",
			})];
			const status = replies.find((reply) => reply.data?.view === "work");
			if (!status) return [call("find-live-root", { action: "status", view: "work" })];
			const target = status.data.items.find((item) => item.assignee === "w1" && item.state === "running");
			if (!target) throw new Error(`No running W1 work for host decision: ${JSON.stringify(status.data)}`);
			if (scenario === "revise-live") return [call("revise-live-root", {
				action: "control", command: "revise_work", workId: target.work.workId,
				expectedRevision: target.work.revision, task: "revised root", inputRefs: [],
			})];
			return [call("cancel-live-root", {
				action: "control", command: "cancel_work", workId: target.work.workId,
				expectedRevision: target.work.revision, reason: "Host selected cancellation during the active tool." ,
			})];
		}
		if (input.scope.events.some((event) => event.kind === "ROOT_RESULT_READY")) {
			const root = input.scope.events.find((event) => event.kind === "ROOT_RESULT_READY");
			if (!root?.work || !root.resultRef) throw new Error(`Manager did not receive a root result event: ${JSON.stringify(input.scope.events)}`);
			if (scenario === "cancel-live") {
				const status = replies.find((reply) => reply.data?.view === "work");
				if (!status) return [call("status-roots-after-cancel", { action: "status", view: "work" })];
				const reviewed = new Set(replies.filter((reply) => reply.receipt?.command === "accept_result"
					&& (reply.receipt.status === "applied" || reply.receipt.status === "unchanged"))
					.map((reply) => `${reply.receipt.work.workId}@${reply.receipt.work.revision}`));
				const unreviewed = status.data.items.find((item) => !item.review
					&& !reviewed.has(`${item.work.workId}@${item.work.revision}`));
				if (unreviewed) {
					const disposition = unreviewed.state === "resolved" ? "accepted" : "waived";
					return [call(`review-${unreviewed.work.workId}`, {
						action: "control", command: "accept_result", work: unreviewed.work, disposition,
						...(disposition === "waived" ? { reason: "The selected root was cancelled." } : {}),
					})];
				}
				return [call("close-after-cancel", {
					action: "control", command: "close_team", resultRefs: [root.resultRef], outcome: "failed",
					reason: "One selected root was cancelled; the unrelated root completed.",
				})];
			}
			const accepted = replies.some((reply) => reply.receipt?.status === "applied" && reply.receipt.command === "accept_result");
			return accepted ? [call("close-after-revision", {
				action: "control", command: "close_team", resultRefs: [root.resultRef], outcome: "succeeded",
			})] : [call("accept-after-revision", {
				action: "control", command: "accept_result", work: root.work, disposition: "accepted",
			})];
		}
		return [{ type: "text", text: `Manager checkpoint ${input.notice}` }];
	}
	if (scenario === "pause-mixed" && input.scope.kind === "work" && input.scope.task === "W1 root") {
		if (turn === 1) return [
			{ type: "toolCall", id: "pause-approved-bash", name: "bash", arguments: { command: "printf approved-before-pause" } },
			{ type: "toolCall", id: "pause-blocked-bash", name: "bash", arguments: { command: "printf must-not-run" } },
		];
		return [call("reply-after-resume", { action: "reply", result: {
			status: "succeeded", summary: "Completed after the parked provider gate resumed.",
		} })];
	}
	if (scenario === "revise-live" && input.scope.kind === "work") {
		if (input.scope.task === "W1 root" && turn === 1) return [
			{ type: "toolCall", id: "revise-latched-bash", name: "bash", arguments: { command: "sleep 30; printf old-revision-finished" } },
		];
		if (input.scope.task === "revised root") return [call("reply-revised-root", { action: "reply", result: {
			status: "succeeded", summary: "Revision two completed on the same W1 session.",
		} })];
	}
	if (scenario === "hang-live" && input.scope.kind === "work" && input.scope.task === "W1 root" && turn === 1) return [
		{ type: "toolCall", id: "hang-call", name: "team_v2_hang", arguments: {} },
	];
	if (scenario === "cancel-live" && input.scope.kind === "work") {
		if (input.scope.task === "cancel target" && turn === 1) return [
			{ type: "toolCall", id: "cancel-latched-bash", name: "bash", arguments: { command: "sleep 30; printf cancelled-tool-finished" } },
		];
		if (input.scope.task === "unrelated root") return [call("reply-unrelated-root", { action: "reply", result: {
			status: "succeeded", summary: "Unrelated same-member root continued after cancellation cleanup.",
		} })];
	}
	if (scenario === "close-mixed" && input.scope.kind === "management") {
		if (replies.length === 0) return [
			call("mixed-close-team", { action: "control", command: "close_team", resultRefs: [], outcome: "failed", reason: "synthetic mixed batch" }),
			call("mixed-sibling-status", { action: "status", view: "team" }),
		];
		return [{ type: "text", text: "The mixed close_team batch was rejected; Team remains open." }];
	}
	if (scenario === "close-loop") {
		if (input.scope.kind === "management") {
			const events = input.scope.events;
			const hostPause = events.find((event) => event.kind === "USER_COMMAND" && event.message === "pause w1");
			if (hostPause) return replies.some((reply) => reply.receipt?.command === "pause_member")
				? [{ type: "text", text: "Paused w1 as requested by the host." }]
				: [call("host-pause-w1", { action: "control", command: "pause_member", memberId: "w1" })];
			if (events.some((event) => event.kind === "BOOT")) {
				const accepted = replies.some((reply) => reply.receipt?.status === "accepted");
				return accepted ? [call("boot-yield", { action: "yield" })]
					: [call("boot-request", { action: "request", to: "w1", task: "C1a synthetic root", inputRefs: [] })];
			}
			const root = events.find((event) => event.kind === "ROOT_RESULT_READY");
			if (!root?.work || !root.resultRef) throw new Error(`Manager did not receive a root result event: ${JSON.stringify(events)}`);
			const accepted = replies.some((reply) => reply.receipt?.status === "applied" && reply.receipt.command === "accept_result");
			return accepted ? [call("close-team", {
				action: "control", command: "close_team", resultRefs: [root.resultRef], outcome: "succeeded",
			})] : [call("accept-root", {
				action: "control", command: "accept_result", work: root.work, disposition: "accepted",
			})];
		}
		if (input.scope.task === "C1a synthetic root") return [call("root-reply", {
			action: "reply", result: { status: "succeeded", summary: "Synthetic worker result accepted and closed by Manager." },
		})];
	}
	if (scenario === "compaction" && input.scope.kind === "work" && input.scope.task === "W1 root") {
		if (replies.length === 0) return [call("compaction-status", { action: "status", view: "team" })];
		return [call("compaction-reply", { action: "reply", result: { status: "succeeded", summary: "W1 completed after native compaction." } })];
	}
	if (scenario === "mixed-end" && input.scope.kind === "work") {
		if (replies.length === 0) return [
			call("mixed-reply", { action: "reply", result: { status: "succeeded", summary: "This must not stage from a mixed native batch." } }),
			{ type: "toolCall", id: "probe-sibling", name: "team_v2_probe", arguments: {} },
		];
		return [{ type: "text", text: "Natural final after the rejected non-sole reply." }];
	}
	if (input.scope.kind !== "work") return [{ type: "text", text: `Manager checkpoint ${input.notice}` }];
	const task = input.scope.task;
	if (task === "W1 root" || task === "W2 assigned") {
		if (input.outcomes.length > 0) return [call(`reply-${task.replaceAll(" ", "-")}`, {
			action: "reply", result: { status: "succeeded", summary: `${task} completed after observing its dependency.` },
		})];
		if (replies.length === 0) return [call(`request-${task.replaceAll(" ", "-")}`, {
			action: "request", to: task === "W1 root" ? "w2" : "w1",
			task: task === "W1 root" ? "W2 assigned" : "W1 question", inputRefs: [],
		})];
		const accepted = replies.map((reply) => reply.receipt).find((receipt) => receipt?.status === "accepted");
		if (!accepted) throw new Error(`${task} did not receive an accepted child work reference: ${JSON.stringify(replies)}`);
		return [call(`yield-${task.replaceAll(" ", "-")}`, {
			action: "yield", waitingFor: [accepted.work], checkpoint: `${task} is waiting for its requested work.`,
		})];
	}
	if (task === "W1 question") return [call("reply-W1-question", {
		action: "reply", result: { status: "succeeded", summary: "W1 answered W2's independent question." },
	})];
	return [{ type: "text", text: `Unexpected test task: ${task}` }];
}

export default function install(pi) {
	let turns = 0;
	if (process.env.TEAM_V2_SCENARIO === "compaction") pi.on("session_before_compact", (event, ctx) => {
		pi.appendEntry("team-v2-compaction", { contextWindow: ctx.model?.contextWindow });
		const messages = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
		const input = messages.map((message) => {
			try { const value = JSON.parse(messageText(message)); return value?.version === 2 && value.scope ? value : undefined; } catch { return undefined; }
		}).find(Boolean);
		const replies = messages.filter((message) => message?.role === "toolResult" && message.toolName === "team").map((message) => {
			try { return JSON.parse(messageText(message)); } catch { return undefined; }
		}).filter(Boolean);
		return { compaction: { summary: `Team v2 native activation remains authoritative across compaction.\nTEAM_V2_ACTIVATION_INPUT:${JSON.stringify(input)}\nTEAM_V2_TOOL_REPLIES:${JSON.stringify(replies)}`,
			firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
	});
	pi.registerTool({
		name: "team_v2_probe", label: "Team v2 probe", description: "Local side-effect-free batch probe", parameters: Type.Object({}),
		async execute() {
			pi.appendEntry("team-v2-probe-executed", { ok: true });
			return { content: [{ type: "text", text: "probe complete" }], details: { ok: true } };
		},
	});
	// A third-party extension that queues a follow-up after a staged reply, forcing a native continuation.
	if (process.env.TEAM_V2_SCENARIO === "a09-live") {
		let queued = false;
		pi.on("tool_execution_end", (event) => {
			if (queued || event.toolName !== "team" || event.result?.terminate !== true || event.result?.details?.receipt?.intent !== "reply") return;
			queued = true;
			pi.sendUserMessage(A09_CONTINUATION, { deliverAs: "followUp" });
		});
	}
	if (process.env.TEAM_V2_SCENARIO === "hang-live") pi.registerTool({
		name: "team_v2_hang", label: "Team v2 hang", description: "Local tool that ignores abort and never returns", parameters: Type.Object({}),
		async execute() {
			pi.appendEntry("team-v2-hang-started", { ok: true });
			return await new Promise(() => undefined);
		},
	});
	pi.registerProvider("rail-team-local", {
		name: "Offline Team v2 probe", baseUrl: "offline://team-v2", apiKey: "synthetic-local-only", api: "rail-team-v2-local-api",
		models: [{ id: "probe", name: "probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 128 }],
		streamSimple(model, context, options) {
			const scenario = process.env.TEAM_V2_SCENARIO ?? "n02";
			if (++turns > 12) throw new Error("Unexpected Team v2 provider polling");
			const lastUser = [...context.messages].reverse().find((message) => message?.role === "user");
			let activation;
			let content;
			if (messageText(lastUser) === "verify restored context window") {
				content = [{ type: "text", text: `window=${model.contextWindow}` }];
			} else if (messageText(lastUser) === "ordinary reopen marker") {
				content = [{ type: "text", text: "Ordinary session reopened with its previous Team history." }];
			} else {
				activation = latestActivation(context.messages);
				const replies = teamReplies(context.messages, activation.index);
				content = actionFor(scenario, activation.input, replies, turns, context.messages, activation.index);
			}
			const retry = scenario === "retry" && activation?.input.member.id === "w1" && turns === 1;
			const inputTokens = scenario === "compaction" && activation?.input.member.id === "w1" && turns === 1 ? 60000 : 1;
			if (retry) content = [];
			pi.appendEntry("team-v2-provider", {
				turn: turns,
				activationDeliveryId: activation?.input.deliveryId,
				modelContextWindow: model.contextWindow,
				retry,
				inputTokens,
				triggerText: activation ? messageText(context.messages[activation.triggerIndex]) : undefined,
				teamCalls: getCurrentTools(context.messages).filter((tool) => tool.name === "team").length,
				teamParameters: getCurrentTools(context.messages).find((tool) => tool.name === "team")?.parameters,
				messages: context.messages,
				systemPrompt: getCurrentSystemPrompt(context.messages),
			});
			const toolUse = content.some((part) => part.type === "toolCall");
			const message = {
				role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
				usage: { input: inputTokens, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: inputTokens + 1,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				...(retry ? { errorMessage: "429 rate limit exceeded" } : {}),
				stopReason: options?.signal?.aborted ? "aborted" : retry ? "error" : toolUse ? "toolUse" : "stop", timestamp: Date.now(),
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
			stream.push(retry ? { type: "error", reason: "error", error: message } : { type: "done", reason: message.stopReason, message });
			stream.end(message);
			return stream;
		},
	});
}