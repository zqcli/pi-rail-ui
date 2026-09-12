import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const logPath = process.env.RAIL_GPT_COMPACTION_SWITCH_LOG;
function record(value) {
	if (logPath) appendFileSync(logPath, `${JSON.stringify(value)}\n`, "utf8");
}
function toPayloadMessage(message) {
	if (message.role === "compactionSummary") return { role: "user", content: [{ type: "input_text", text: message.summary }] };
	if (message.role === "user") return { role: "user", content: message.content };
	if (message.role === "assistant") return { role: "assistant", content: message.content };
	return { role: message.role, content: message.content };
}
function stream(model, context, options) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(async () => {
		let payload = { model: model.id, input: context.messages.map(toPayloadMessage), store: true, stream: false };
		if (options?.onPayload) payload = await options.onPayload(payload, model);
		record({ model: model.id, context: context.messages, payload });
		const message = {
			role: "assistant",
			content: [{ type: "text", text: `answer from ${model.id}` }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
	});
	return stream;
}

export default function install(pi) {
	pi.registerProvider("cus-resp", {
		name: "Rail model switch probe",
		baseUrl: "https://gateway.example/v1",
		apiKey: "probe-key",
		api: "openai-responses",
		streamSimple: stream,
		models: ["gpt-5.6-sol", "gpt-alt"].map((id) => ({
			id,
			name: id === "gpt-alt" ? "GPT Alternate" : "GPT 5.6 Sol",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 64,
		})),
	});
}
