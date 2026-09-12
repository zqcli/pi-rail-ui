import { appendFileSync } from "node:fs";

const logPath = process.env.RAIL_CONTEXT_WINDOW_FREEZE_REPLACEMENT_LOG;
const provider = process.env.RAIL_CONTEXT_WINDOW_FREEZE_REPLACEMENT_PROVIDER ?? "rail-stage2-local";

function record(value) {
	if (logPath) appendFileSync(logPath, `${JSON.stringify(value)}\n`, "utf8");
}

function register(pi) {
	pi.registerProvider(provider, {
		name: "Rail stage 2 frozen replacement",
		baseUrl: `offline://${provider}`,
		apiKey: `${provider}-key`,
		api: `${provider}-api`,
		streamSimple() {
			record({ kind: "provider" });
			throw new Error("provider must not be called after frozen replacement");
		},
		models: [{
			id: "probe",
			name: "Rail stage 2 frozen replacement probe",
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
		record({ kind: "before_replacement", contextWindow: ctx.model.contextWindow });
		register(pi);
		if (ctx.model) Object.freeze(ctx.model);
	});
}
