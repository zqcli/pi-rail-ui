import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-local" } })).toString("base64url")}.signature`;
const provider = openaiCodexProvider();

export default function install(pi) {
	pi.registerProvider("cus-codex", {
		name: "Rail local Codex WebSocket",
		baseUrl: process.env.RAIL_GPT_COMPACTION_GATEWAY ?? "https://gateway.example/v1",
		apiKey: token,
		api: "openai-codex-responses",
		streamSimple(model, context, options) {
			return provider.streamSimple(model, context, {
				...options,
				apiKey: token,
				transport: "auto",
				websocketConnectTimeoutMs: 2_000,
				timeoutMs: 2_000,
			});
		},
		models: [{
			id: "gpt-local-codex",
			name: "GPT Local Codex",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 64,
		}],
	});
}
