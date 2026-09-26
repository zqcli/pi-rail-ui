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
		let compacted = false;
		try { input = JSON.parse(text); } catch {
			// A native compaction summary (written by this fixture's deterministic summarizer from the
			// actual messages Pi selected for summarization) is ordinary provider input text.
			const summarized = text.match(/TEAM_V2_ACTIVATION_INPUT:(\{[^\n]+\})/u)?.[1];
			if (!summarized) continue;
			input = JSON.parse(summarized);
			compacted = true;
		}
		if (compacted) return { input, index, triggerIndex: undefined, compacted };
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
	const summarized = messageText(messages[activationIndex]).match(/TEAM_V2_TOOL_REPLIES:(\[[^\n]*\])/u)?.[1];
	const replies = summarized ? JSON.parse(summarized) : [];
	return [...replies, ...messages.slice(activationIndex + 1).filter((message) => message?.role === "toolResult" && message.toolName === "team").map((message) => {
		const text = messageText(message);
		if (!text) return undefined;
		try { return JSON.parse(text); } catch { return { toolError: text }; }
	}).filter(Boolean)];
}

/** Deterministic stand-in for an LLM summarizer: it keeps only what Pi handed it for summarization. */
function compactionSummary(preparation) {
	const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
	let index = -1;
	let input;
	for (let candidate = messages.length - 1; candidate >= 0 && !input; candidate--) {
		try {
			const value = JSON.parse(messageText(messages[candidate]));
			if (value?.version === 2 && value.scope) { input = value; index = candidate; }
		} catch { /* Not an activation input. */ }
	}
	const replies = messages.slice(index + 1).filter((message) => message?.role === "toolResult" && message.toolName === "team").map((message) => {
		try { return JSON.parse(messageText(message)); } catch { return undefined; }
	}).filter(Boolean);
	return input
		? `Team v2 native compaction checkpoint.\nTEAM_V2_ACTIVATION_INPUT:${JSON.stringify(input)}\nTEAM_V2_TOOL_REPLIES:${JSON.stringify(replies)}`
		: "Team v2 native compaction checkpoint without an activation input.";
}

function call(id, args) {
	return { type: "toolCall", id, name: "team", arguments: args };
}

const A09_CONTINUATION = "third-party boundary continuation";

function actionFor(scenario, input, replies, turn, messages = [], activationIndex = 0) {
	if (scenario === "n08-cache-warming") {
		if (input.scope.kind === "management") return [call(`n08-manager-yield-${turn}`, { action: "yield" })];
		// Keep the native run active past the 1s warming delay so Pi reaches its refresh decision while bound.
		if (!messages.some((message) => message?.role === "toolResult" && message.toolCallId === "n08-bound-wait")) {
			return [{ type: "toolCall", id: "n08-bound-wait", name: "bash", arguments: { command: "sleep 2.5; printf bound-wait-done" } }];
		}
		return [call("n08-reply", { action: "reply", result: { status: "succeeded", summary: "N08 work complete." } })];
	}
	if (scenario === "n01-role-only") {
		// The Manager never assigns the role-only writer; any writer activation is a failure of N01.
		if (input.scope.kind === "management") return [call(`n01-manager-yield-${turn}`, { action: "yield" })];
		if (input.member.id !== "w1") throw new Error(`N01 role-only member ${input.member.id} received a provider request`);
		return [call("n01-initial-reply", { action: "reply", result: {
			status: "succeeded", summary: "The initial review completed while the role-only writer stayed idle.",
		} })];
	}
	if (scenario === "n03-eight" && input.scope.kind === "work") {
		if (input.scope.task === "N03 root 8 barrier") return [call("n03-eighth-reply", { action: "reply", result: {
			status: "succeeded", summary: "The eighth worker received a Runtime permit and executed its assigned work.",
		} })];
		if (input.outcomes.length > 0) return [call(`n03-resumed-reply-${input.member.id}`, { action: "reply", result: {
			status: "succeeded", summary: `${input.member.id} resumed after observing ${input.outcomes[0].state} ${input.outcomes[0].resultRef}.`,
		} })];
		const status = replies.find((reply) => reply.data?.view === "work");
		if (!status) return [call(`n03-status-${input.member.id}`, { action: "status", view: "work", limit: 20 })];
		const eighth = status.data.items.find((item) => item.taskPreview === "N03 root 8 barrier");
		if (!eighth) throw new Error(`N03 worker could not read the eighth WorkRef: ${JSON.stringify(status.data)}`);
		return [call(`n03-yield-${input.member.id}`, { action: "yield", waitingFor: [eighth.work], checkpoint: "Waiting for the eighth worker's explicit result." })];
	}
	if (scenario === "n03-eight" && input.scope.kind === "management") return [call(`n03-manager-yield-${turn}`, { action: "yield" })];
	if (scenario === "n06-context-edit" && input.scope.kind === "work") {
		if (input.scope.task === "N06 peer verification") return [call("n06-peer-reply", { action: "reply", result: {
			status: "succeeded", summary: "Canonical peer result: the requested verification passed.",
		} })];
		if (input.scope.task !== "N06 root") throw new Error(`Unexpected N06 work: ${input.scope.task}`);
		if (input.outcomes.length === 0) {
			if (replies.length === 0) return [call("n06-request-peer", { action: "request", to: "w2", task: "N06 peer verification", inputRefs: [] })];
			const accepted = replies.map((reply) => reply.receipt).find((receipt) => receipt?.status === "accepted");
			if (!accepted) throw new Error(`N06 peer request was not accepted: ${JSON.stringify(replies)}`);
			return [call("n06-yield-peer", { action: "yield", waitingFor: [accepted.work], checkpoint: "Waiting for the peer verification result." })];
		}
		const outcome = input.outcomes[0];
		if (!outcome?.resultRef) throw new Error(`N06 resumed input omitted its delivered result reference: ${JSON.stringify(input.outcomes)}`);
		const result = replies.find((reply) => reply.data?.id === outcome.resultRef);
		if (!result) return [call("n06-read-canonical-result", { action: "status", view: "result", id: outcome.resultRef })];
		return [call("n06-root-reply", { action: "reply", result: {
			status: "succeeded", summary: `N06 verified the canonical dependency result: ${result.data.result.summary}`,
		} })];
	}
	if (scenario === "n10-writer") {
		if (input.scope.kind === "management") {
			const root = input.scope.events.find((event) => event.kind === "ROOT_RESULT_READY");
			if (!root?.work || !root.resultRef) return [{ type: "text", text: "Manager is waiting for a root result." }];
			const result = replies.find((reply) => reply.data?.id === root.resultRef);
			if (!result) return [call(`n10-read-${root.resultRef}`, { action: "status", view: "result", id: root.resultRef })];
			const accepted = replies.some((reply) => reply.receipt?.command === "accept_result"
				&& reply.receipt.work?.workId === root.work.workId && reply.receipt.status === "applied");
			if (result.data.author === "w1") {
				if (!accepted) return [
					call("n10-accept-review", { action: "control", command: "accept_result", work: root.work, disposition: "accepted" }),
					call("n10-request-writer", { action: "request", to: "w2", task: `Compose the report using ${root.resultRef}`, inputRefs: [root.resultRef] }),
				];
				return [call("n10-manager-yield", { action: "yield" })];
			}
			if (result.data.author === "w2") return accepted ? [call("n10-close-from-writer", {
				action: "control", command: "close_team", resultRefs: [root.resultRef], outcome: "succeeded",
			})] : [call("n10-accept-writer", { action: "control", command: "accept_result", work: root.work, disposition: "accepted" })];
			throw new Error(`N10 Manager received an unexpected root author: ${result.data.author}`);
		}
		if (input.scope.task === "N10 initial reviewer") return [call("n10-review-reply", { action: "reply", result: {
			status: "succeeded", summary: "Reviewer evidence: the implementation behavior was verified.",
		} })];
		if (input.scope.task === "N10 idle reviewer follow-up") return [call("n10-reviewer-followup", { action: "reply", result: {
			status: "succeeded", summary: "Idle reviewer follow-up: the original evidence is confirmed.",
		} })];
		if (input.scope.kind === "work" && input.scope.task.startsWith("Compose the report using ")) {
			const resultRef = input.scope.inputRefs[0];
			if (!resultRef) throw new Error("N10 writer did not receive the review resultRef as an explicit input");
			if (input.outcomes.length > 0) return [call("n10-writer-reply", { action: "reply", result: {
				status: "succeeded", summary: `Writer report incorporates the review and idle-reviewer confirmation ${input.outcomes[0]?.resultRef}.`,
			} })];
			const result = replies.find((reply) => reply.data?.id === resultRef);
			if (!result) return [call("n10-writer-read-review", { action: "status", view: "result", id: resultRef })];
			const accepted = replies.map((reply) => reply.receipt).find((receipt) => receipt?.status === "accepted");
			if (!accepted) return [call("n10-writer-ask-reviewer", { action: "request", to: "w1", task: "N10 idle reviewer follow-up", inputRefs: [resultRef] })];
			return [call("n10-writer-yield", { action: "yield", waitingFor: [accepted.work], checkpoint: "Waiting for the idle reviewer follow-up." })];
		}
	}
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
	const cacheWarming = process.env.TEAM_V2_SCENARIO === "n08-cache-warming";
	// Record Pi's own warm-or-stop decision without overriding it (a handler returning nothing never wins).
	if (cacheWarming) pi.on("cache_warming_decision", (event) => {
		pi.appendEntry("team-v2-warm-decision", { action: event.action, missCost: event.missCost, warmCost: event.warmCost });
	});
	let n06ContextEditWritten = false;
	if (process.env.TEAM_V2_SCENARIO === "n06-context-edit") pi.on("agent_before_settle", (_event, ctx) => {
		if (n06ContextEditWritten) return;
		const activation = [...ctx.sessionManager.getBranch()].reverse().find((entry) => {
			if (entry.type !== "custom_message" || entry.customType !== "rail-team-activation") return false;
			try {
				const input = JSON.parse(typeof entry.content === "string" ? entry.content : messageText({ content: entry.content }));
				return input.scope?.kind === "work" && input.scope.task === "N06 root";
			} catch { return false; }
		});
		if (!activation) return;
		n06ContextEditWritten = true;
		return { entries: [{ type: "context_edit", targetId: activation.id, replacement: null }] };
	});
	if (["compaction", "n06-context-edit"].includes(process.env.TEAM_V2_SCENARIO)) pi.on("session_before_compact", (event, ctx) => {
		const summarizedDeliveryIds = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages].flatMap((message) => {
			try { const value = JSON.parse(messageText(message)); return value?.version === 2 && value.scope ? [value.deliveryId] : []; } catch { return []; }
		});
		pi.appendEntry("team-v2-compaction", { contextWindow: ctx.model?.contextWindow, summarizedDeliveryIds });
		return { compaction: { summary: compactionSummary(event.preparation),
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
		models: [{ id: "probe", name: "probe", reasoning: false, input: ["text"],
			cost: cacheWarming ? { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			...(cacheWarming ? { promptCache: { short: 11 } } : {}), contextWindow: 128000, maxTokens: 128 }],
		streamSimple(model, context, options) {
			const scenario = process.env.TEAM_V2_SCENARIO ?? "n02";
			if (++turns > 12) throw new Error("Unexpected Team v2 provider polling");
			const lastUser = [...context.messages].reverse().find((message) => message?.role === "user");
			let activation;
			let content;
			let replies = [];
			if (messageText(lastUser) === "verify restored context window") {
				content = [{ type: "text", text: `window=${model.contextWindow}` }];
			} else if (messageText(lastUser) === "ordinary reopen marker") {
				const waited = context.messages.some((message) => message?.role === "toolResult" && message.toolCallId === "n08-ordinary-wait");
				content = cacheWarming && !waited
					? [{ type: "toolCall", id: "n08-ordinary-wait", name: "bash", arguments: { command: "sleep 2.5; printf ordinary-wait-done" } }]
					: [{ type: "text", text: "Ordinary session reopened with its previous Team history." }];
			} else {
				activation = latestActivation(context.messages);
				replies = teamReplies(context.messages, activation.index);
				content = actionFor(scenario, activation.input, replies, turns, context.messages, activation.index);
			}
			const retry = scenario === "retry" && activation?.input.member.id === "w1" && turns === 1;
			const inputTokens = cacheWarming ? 50000 : (scenario === "compaction" && activation?.input.member.id === "w1" && turns === 1)
				|| (scenario === "n06-context-edit" && activation?.input.member.id === "w1" && activation.input.scope.kind === "work"
					&& activation.input.scope.task === "N06 root" && activation.input.outcomes.length > 0 && replies.length === 0) ? 60000 : 1;
			if (retry) content = [];
			pi.appendEntry("team-v2-provider", {
				turn: turns,
				maxTokens: options?.maxTokens,
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