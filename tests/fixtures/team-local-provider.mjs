import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export default function install(pi) {
	let turns = 0;
	if (process.env.TEAM_PROBE_SCENARIO === "delivery") pi.on("session_before_compact", (event) => ({
		compaction: {
			summary: "Unrelated work only; deliberately omits collaboration facts.",
			firstKeptEntryId: [...event.branchEntries].reverse().find((entry) => entry.type === "message").id,
			tokensBefore: event.preparation.tokensBefore,
		},
	}));
	pi.on("session_start", () => pi.appendEntry("team-probe-start", { pid: process.pid }));
	pi.registerTool({
		name: "team_probe_work", label: "Probe work", description: "Local native batch probe", parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			pi.appendEntry("team-probe-work", { executed: true });
			if (process.env.TEAM_PROBE_SCENARIO === "probe-abort") await new Promise((resolve) => {
				if (signal.aborted) resolve();
				else signal.addEventListener("abort", resolve, { once: true });
			});
			if (process.env.TEAM_PROBE_SCENARIO === "conflict") pi.registerCommand("rail-subagent-team-protocol", { description: "Runtime collision probe", handler: async () => {} });
			return { content: [{ type: "text", text: "local-work-done" }], details: {} };
		},
	});
	if (process.env.TEAM_PROBE_URL) {
		pi.registerProvider("rail-team-local", {
			name: "Loopback team probe", baseUrl: process.env.TEAM_PROBE_URL, apiKey: "synthetic-local-only", api: "openai-completions",
			models: [{ id: "probe", name: "probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 128 }],
		});
		return;
	}
	pi.registerProvider("rail-team-local", {
		name: "Offline team probe", baseUrl: "offline://team", apiKey: "synthetic-local-only", api: "rail-team-local-api",
		models: [{ id: "probe", name: "probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 128 }],
		streamSimple(model, context, options) {
			const scenario = process.env.TEAM_PROBE_SCENARIO;
			// Pi 0.86 carries the prompt and tool declarations in transcript system messages.
			pi.appendEntry("team-probe-provider", {
				aborted: options?.signal?.aborted === true,
				messages: context.messages, systemPrompt: getCurrentSystemPrompt(context.messages), teamParameters: getCurrentTools(context.messages).find((tool) => tool.name === "team")?.parameters,
			});
			if (++turns > (scenario === "delivery" ? 8 : 3)) throw new Error("Unexpected provider polling");
			const wait = ["wait", "mixed", "wait-null", "wait-empty", "queued-wait", "queued-report-wait"].includes(scenario) && turns === 1;
			const work = (["work", "mixed", "conflict", "probe-abort"].includes(scenario) && turns === 1) || (scenario === "delivery" && turns <= 2);
			const send = ["send-null", "send-empty", "send-denied"].includes(scenario) && turns === 1;
			const placeholder = scenario?.endsWith("empty") ? "" : null;
			const waitArgs = scenario === "queued-report-wait"
				? { action: "report", message: "milestone", wait: { kind: "message" } }
				: scenario === "wait" || scenario === "mixed" || scenario === "queued-wait"
					? { action: "wait", wait: { kind: "message" } }
					: { action: "wait", to: placeholder, message: placeholder, command: placeholder, wait: { kind: "message", member: placeholder, afterSeq: null } };
			const content = [
				...(wait ? [{ type: "toolCall", id: "wait-one", name: "team", arguments: waitArgs }] : []),
				...(work ? [{ type: "toolCall", id: "work-one", name: "team_probe_work", arguments: {} }] : []),
				...(send ? [{ type: "toolCall", id: "send-one", name: "team", arguments: { action: "send", to: " a ", message: "  hello  ", command: placeholder, wait: null } }] : []),
				...(!wait && !work && !send ? [{ type: "text", text: "local-provider-done" }] : []),
			];
			const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: options?.signal?.aborted ? "aborted" : wait || work || send ? "toolUse" : "stop", timestamp: Date.now() };
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
			stream.push({ type: "done", reason: message.stopReason, message });
			stream.end(message);
			return stream;
		},
	});
}
