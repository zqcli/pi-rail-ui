import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { AgentSession, SessionManager, type ExtensionAPI, type ExtensionContext, type ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";

export const footerUsage: Usage = {
	input: 600, output: 80, cacheRead: 320, cacheWrite: 0, totalTokens: 1000,
	cost: { input: 0.006, output: 0.004, cacheRead: 0.001, cacheWrite: 0, total: 0.011 },
};

export function footerAssistant(turn: number): AssistantMessage {
	return {
		role: "assistant", content: [{ type: "text", text: `Answer ${turn}: verified the implementation.` }],
		api: "openai-responses", provider: "footer-fixture", model: "fixture",
		usage: { ...footerUsage, totalTokens: 1000 + turn * 32 }, stopReason: "stop", timestamp: turn,
	};
}

/** Real append-only storage and Pi context estimation, without providers, files or a terminal. */
export function createFooterFixture(turns: number, compacted = false) {
	const state = {
		manager: SessionManager.inMemory("/tmp/footer-fixture"),
		model: {
			id: "fixture", name: "Fixture", api: "openai-responses", provider: "footer-fixture",
			baseUrl: "http://localhost", reasoning: false, input: ["text"], contextWindow: 1_000_000, maxTokens: 8192,
			cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 0 },
		} as ExtensionContext["model"],
		messages: [],
		idle: true,
		pending: false,
		thinking: "off",
		branch: "dev",
	};
	const manager = state.manager;
	for (let turn = 0; turn < turns; turn++) {
		manager.appendMessage({ role: "user", content: `Review change ${turn}. ${"file context ".repeat(16)}`, timestamp: turn });
		manager.appendMessage({
			...footerAssistant(turn), stopReason: "toolUse",
			content: [{ type: "toolCall", id: `tool-${turn}`, name: "read", arguments: { path: `src/file-${turn}.ts` } }],
		});
		manager.appendMessage({ role: "toolResult", toolCallId: `tool-${turn}`, toolName: "read",
			content: [{ type: "text", text: "export const value = 42;\n".repeat(32) }], isError: false, timestamp: turn });
		manager.appendMessage(footerAssistant(turn));
		if (turn % 25 === 24) manager.appendUsage("cache_warm", "footer-fixture", "fixture", footerUsage);
	}
	if (compacted) {
		const entries = manager.getEntries();
		manager.appendCompaction("Earlier work is complete.", entries[Math.max(0, entries.length - 100)]!.id, 100_000, undefined, false, footerUsage);
	}
	const session = Object.defineProperties(Object.create(AgentSession.prototype), {
		sessionManager: { get: () => state.manager },
		agent: { value: { state } },
	}) as AgentSession;
	const ctx = {
		cwd: "/tmp/footer-fixture", get sessionManager() { return state.manager; }, get model() { return state.model; },
		modelRegistry: { isUsingOAuth: () => false },
		getContextUsage: () => session.getContextUsage(),
		isIdle: () => state.idle, hasPendingMessages: () => state.pending,
	} as unknown as ExtensionContext;
	const pi = { getThinkingLevel: () => state.thinking, getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;
	const footerData: ReadonlyFooterDataProvider = {
		getGitBranch: () => state.branch, getExtensionStatuses: () => new Map(), onBranchChange: () => () => {},
		getAvailableProviderCount: () => 1,
	};
	return { state, ctx, pi, footerData };
}
