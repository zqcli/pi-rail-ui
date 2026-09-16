const gateway = process.env.RAIL_FAST_PROBE_GATEWAY;

if (!gateway) throw new Error("RAIL_FAST_PROBE_GATEWAY is required");

export default function install(pi) {
	pi.registerProvider("rail-fast-probe", {
		name: "Rail fast probe",
		baseUrl: gateway,
		apiKey: "local-probe-key",
		api: "openai-responses",
		models: [{
			id: "gpt-fast-probe",
			name: "GPT fast probe",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 64,
		}],
	});
}