import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const logPath = process.env.RAIL_CONTEXT_WINDOW_STAGE2_LOG;

function record(value) {
	if (logPath) appendFileSync(logPath, `${JSON.stringify(value)}\n`, "utf8");
}

function streamLocalResponse(model, _context, options) {
	record({ kind: "provider", contextWindow: model.contextWindow });
	const message = {
		role: "assistant",
		content: [{ type: "text", text: `stage2:${model.contextWindow}` }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: options?.signal?.aborted ? "aborted" : "stop",
		timestamp: Date.now(),
	};
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
	stream.push({ type: "done", reason: message.stopReason, message });
	stream.end(message);
	return stream;
}

export default function install(pi) {
	pi.registerProvider("rail-stage2-local", {
		name: "Rail stage 2 local provider",
		baseUrl: "offline://rail-stage2-local",
		apiKey: "rail-stage2-local-key",
		api: "rail-stage2-local-api",
		streamSimple: streamLocalResponse,
		models: [{
			id: "probe",
			name: "Rail stage 2 probe",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 64,
		}],
	});
}