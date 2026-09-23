export default function install(pi) {
	pi.registerProvider("rail-team-ws", {
		name: "Local Team WebSocket probe",
		baseUrl: "https://team-websocket.invalid/v1",
		apiKey: "team-websocket-test-key",
		api: "openai-responses",
		models: [{
			id: "probe",
			name: "Team WebSocket probe",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 1024,
		}],
	});
}
