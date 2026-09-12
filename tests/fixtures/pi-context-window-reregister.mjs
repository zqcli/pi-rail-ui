import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const logPath = process.env.RAIL_CONTEXT_WINDOW_REREGISTER_LOG;
const freezeReplacement = process.env.RAIL_CONTEXT_WINDOW_REREGISTER_FREEZE === "1";

function record(value) {
	if (logPath) appendFileSync(logPath, `${JSON.stringify(value)}\n`, "utf8");
}

function response(model) {
	return {
		role: "assistant",
		content: [{ type: "text", text: `reregister:${model.contextWindow}` }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function streamSimple(model) {
	record({ kind: "provider", contextWindow: model.contextWindow });
	const stream = createAssistantMessageEventStream();
	const message = response(model);
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
		stream.push({ type: "done", message });
		stream.end(message);
	});
	return stream;
}

function register(pi) {
	pi.registerProvider("rail-stage2-reregister", {
		name: "Rail stage 2 re-register provider",
		baseUrl: "offline://rail-stage2-reregister",
		apiKey: "rail-stage2-reregister-key",
		api: "rail-stage2-reregister-api",
		streamSimple,
		models: [{
			id: "probe",
			name: "Rail stage 2 re-register probe",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 64,
		}],
	});
}

export default function install(pi) {
	register(pi);
	pi.on("before_agent_start", (_event, ctx) => {
		if (ctx.model?.contextWindow !== 64_000) return;
		record({ kind: "before_reregister", contextWindow: ctx.model.contextWindow });
		register(pi);
		if (freezeReplacement && ctx.model) Object.freeze(ctx.model);
	});
}
