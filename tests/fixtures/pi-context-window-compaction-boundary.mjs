import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const logPath = process.env.RAIL_CONTEXT_WINDOW_COMPACTION_LOG;
const mode = process.env.RAIL_CONTEXT_WINDOW_COMPACTION_MODE ?? "oracle";
let providerVersion = 1;
let providerCalls = 0;
let switched = false;

function log(value) {
	if (logPath) appendFileSync(logPath, `${JSON.stringify(value)}\n`, "utf8");
}

function currentInfo(ctx) {
	return {
		provider: ctx.model?.provider,
		id: ctx.model?.id,
		contextWindow: ctx.model?.contextWindow,
		name: ctx.model?.name,
	};
}

function register(pi, provider, contextWindow, version) {
	pi.registerProvider(provider, {
		name: `${mode}-${version}`,
		baseUrl: `offline://${provider}`,
		apiKey: `${provider}-key`,
		api: "rail-context-window-compaction-api",
		streamSimple(model, context) {
			const call = ++providerCalls;
			const roles = context.messages.map((message) => message.role);
			log({ kind: "provider", mode, call, version, contextWindow: model.contextWindow, provider: model.provider, model: model.id, roles, messageCount: context.messages.length });
			const stream = createAssistantMessageEventStream();
			// Summary requests also end in a user message, but do not declare agent tools.
			const isFirstAgentCall = roles.at(-1) === "user"
				&& getCurrentTools(context.messages).some((tool) => tool.name === "compaction_probe_tool");
			const message = isFirstAgentCall ? {
				role: "assistant",
				content: [{ type: "toolCall", id: "compaction-probe-call", name: "compaction_probe_tool", arguments: {} }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { input: 59_999, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 60_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "toolUse",
				timestamp: Date.now(),
			} : {
				role: "assistant",
				content: [{ type: "text", text: `assistant-call-${call}` }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { input: 100, output: 2, cacheRead: 0, cacheWrite: 0, total: 102, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
			stream.push({ type: "done", reason: message.stopReason, message });
			stream.end(message);
			return stream;
		},
		models: [{ id: "probe", name: `${mode}-${version}`, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens: 64 }],
	});
}

export default function install(pi) {
	const provider = mode === "oracle" ? "rail-context-window-compaction-oracle" : "rail-context-window-compaction-rail";
	const initialWindow = mode === "oracle" ? 64_000 : 128_000;
	register(pi, provider, initialWindow, providerVersion);
	pi.registerTool({
		name: "compaction_probe_tool",
		label: "Compaction probe tool",
		description: "Returns a deterministic tool result for the context-window compaction probe.",
		parameters: Type.Object({}),
		async execute() {
			log({ kind: "tool_execute", mode, currentProviderVersion: providerVersion });
			return { content: [{ type: "text", text: "tool-result" }], details: {} };
		},
	});
	pi.on("turn_start", (_event, ctx) => log({ kind: "turn_start", mode, current: currentInfo(ctx), usage: ctx.getContextUsage?.() }));
	pi.on("turn_end", (_event, ctx) => log({ kind: "turn_end", mode, current: currentInfo(ctx), usage: ctx.getContextUsage?.() }));
	pi.on("tool_result", (_event, ctx) => log({ kind: "tool_result_observed", mode, current: currentInfo(ctx), usage: ctx.getContextUsage?.() }));
	pi.on("session_before_compact", (event, ctx) => log({ kind: "session_before_compact", mode, reason: event.reason, tokensBefore: event.preparation.tokensBefore, current: currentInfo(ctx) }));
	pi.on("session_compact", (event, ctx) => log({ kind: "session_compact", mode, current: currentInfo(ctx), tokensBefore: event.compactionEntry.tokensBefore }));
	if (mode === "rail") {
		pi.on("tool_result", (_event, ctx) => {
			if (switched) return;
			switched = true;
			providerVersion = 2;
			log({ kind: "before_reregister_tool_result", mode, current: currentInfo(ctx) });
			register(pi, provider, 128_000, providerVersion);
			log({ kind: "after_reregister_tool_result", mode, current: currentInfo(ctx) });
		});
	}
}
