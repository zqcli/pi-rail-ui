import { appendFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const logPath = process.env.RAIL_GPT_COMPACTION_TOOL_LOG;
let providerCalls = 0;
let agentTurns = 0;

function log(value) {
	if (logPath) appendFileSync(logPath, `${JSON.stringify(value)}\n`, "utf8");
}

function streamLoop(model, context, options) {
	const summarizing = getCurrentSystemPrompt(context.messages).includes("context summarization assistant");
	const hasLoopTool = getCurrentTools(context.messages).some((tool) => tool.name === "gpt_compaction_loop_tool");
	assert.ok(summarizing || hasLoopTool, "agent transcript must declare the loop tool");
	const stream = createAssistantMessageEventStream();
	(async () => {
		providerCalls += 1;
		const assistantTurns = context.messages.filter((message) => message.role === "assistant").length;
		// Compaction can remove assistant history; summary calls must not advance the agent loop.
		const agentTurn = summarizing ? null : ++agentTurns;
		log({ kind: "provider", call: providerCalls, assistantTurns, summarizing, agentTurn, hasLoopTool, messages: context.messages });
		const shouldFinish = summarizing || agentTurn > 3;
		const message = {
			role: "assistant",
			content: shouldFinish
				? [{ type: "text", text: summarizing ? "native repair summary" : "tool loop complete" }]
				: [{ type: "toolCall", id: `loop-call-${providerCalls}`, name: "gpt_compaction_loop_tool", arguments: { call: providerCalls } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 18_000, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 18_004, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: shouldFinish ? "stop" : "toolUse",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
		stream.push({ type: "done", reason: message.stopReason, message });
		stream.end(message);
	})();
	return stream;
}

export default function install(pi) {
	pi.on("agent_start", () => { agentTurns = 0; });
	pi.registerProvider("cus-resp", {
		name: "Rail GPT compaction tool loop",
		baseUrl: process.env.RAIL_GPT_COMPACTION_GATEWAY ?? "https://gateway.example/v1",
		apiKey: "probe-key",
		api: "openai-responses",
		streamSimple: streamLoop,
		models: [{
			id: "gpt-5.6-sol",
			name: "GPT 5.6 Sol",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: Number(process.env.RAIL_GPT_COMPACTION_CONTEXT_WINDOW ?? 20_000),
			maxTokens: 64,
		}],
	});
	pi.registerTool({
		name: "gpt_compaction_loop_tool",
		label: "GPT compaction loop tool",
		description: "Returns a deterministic tool result.",
		parameters: Type.Object({ call: Type.Number() }),
		async execute(_toolCallId, input) {
			log({ kind: "tool", call: input.call });
			return { content: [{ type: "text", text: `tool result ${input.call} ${"x".repeat(3000)}` }], details: {} };
		},
	});
}
