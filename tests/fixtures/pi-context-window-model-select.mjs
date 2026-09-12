import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const logPath = process.env.RAIL_CONTEXT_WINDOW_MODEL_SELECT_LOG;
function record(value) {
	if (logPath) appendFileSync(logPath, `${JSON.stringify(value)}\n`, "utf8");
}

function streamSimple(model) {
	record({ kind: "provider", id: model.id, contextWindow: model.contextWindow });
	const message = {
		role: "assistant",
		content: [{ type: "text", text: `model-select:${model.id}:${model.contextWindow}` }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
		stream.push({ type: "done", message });
		stream.end(message);
	});
	return stream;
}

export default function install(pi) {
	pi.registerProvider("rail-context-model-select", {
		name: "Rail context model-select probe",
		baseUrl: "offline://rail-context-model-select",
		apiKey: "rail-context-model-select-key",
		api: "rail-context-model-select-api",
		streamSimple,
		models: [
			{ id: "probe", name: "Probe", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 64 },
			{ id: "other", name: "Other", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272_000, maxTokens: 64 },
		],
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (ctx.model?.id !== "probe" || ctx.model.contextWindow !== 64_000) return;
		const other = ctx.modelRegistry.find("rail-context-model-select", "other");
		if (!other) throw new Error("other model missing");
		record({ kind: "before_set_model", current: ctx.model.contextWindow, other: other.contextWindow });
		await pi.setModel(other);
		record({ kind: "after_set_model", current: ctx.model?.id, contextWindow: ctx.model?.contextWindow });
	});
}
