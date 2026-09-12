import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const logPath = process.env.RAIL_GPT_COMPACTION_PROBE_LOG;
let providerCalls = 0;

function record(value) {
	if (logPath) appendFileSync(logPath, `${JSON.stringify(value)}\n`, "utf8");
}

function toPayloadMessage(message) {
	if (message.role === "compactionSummary") {
		return { role: "user", content: [{ type: "input_text", text: message.summary }] };
	}
	if (message.role === "user") return { role: "user", content: message.content };
	if (message.role === "assistant") return { role: "assistant", content: message.content };
	if (message.role === "toolResult") return { type: "function_call_output", call_id: message.toolCallId, output: message.content };
	return { role: message.role, content: message.content };
}

function streamProbe(model, context, options) {
	const stream = createAssistantMessageEventStream();
	(async () => {
		try {
			const delayMs = Number(process.env.RAIL_GPT_COMPACTION_PROBE_DELAY_MS ?? 0);
			if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
			providerCalls += 1;
			let payload = {
				model: model.id,
				input: context.messages.map(toPayloadMessage),
				store: true,
				stream: false,
			};
			if (options?.onPayload) payload = await options.onPayload(payload);
			record({ kind: "provider", context: context.messages, payload });
			const overflow = process.env.RAIL_GPT_COMPACTION_OVERFLOW_ONCE === "1" && providerCalls === 1;
			const message = {
				role: "assistant",
				content: overflow ? [] : [{ type: "text", text: "gpt-compaction-probe" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: options?.signal?.aborted ? "aborted" : overflow ? "error" : "stop",
				...(overflow ? { errorMessage: "input exceeds the context window of this model" } : {}),
				timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
			stream.push({ type: "done", reason: message.stopReason, message });
			stream.end(message);
		} catch (error) {
			record({ kind: "provider-error", error: error instanceof Error ? error.message : String(error) });
			stream.end();
		}
	})();
	return stream;
}

export default function install(pi) {
	pi.registerProvider("cus-resp", {
		name: "Rail GPT compaction probe",
		baseUrl: process.env.RAIL_GPT_COMPACTION_GATEWAY ?? "https://gateway.example/v1",
		apiKey: "probe-key",
		api: "openai-responses",
		streamSimple: streamProbe,
		models: [{
			id: "gpt-5.6-sol",
			name: "GPT 5.6 Sol",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: Number(process.env.RAIL_GPT_COMPACTION_CONTEXT_WINDOW ?? 128000),
			maxTokens: 64,
		}],
	});
}