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

function actionFor(scenario, input, replies) {
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
				content = actionFor(scenario, activation.input, replies);
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