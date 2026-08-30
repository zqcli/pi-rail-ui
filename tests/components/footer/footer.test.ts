import assert from "node:assert/strict";
import { test } from "node:test";
import { installRailFast } from "../../../commands/rail-fast";
import { installRailOaiSearch } from "../../../commands/rail-oai-search";
import { createRailFooter } from "../../../components/footer";
import { stripAnsi } from "../../../core/utils";

test("renders the active native search mode in the Rail footer", async () => {
	const commands = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const extensionStatuses = new Map<string, string>();
	let renders = 0;
	const tui = { requestRender: () => { renders += 1; } };
	const pi: any = {
		registerCommand: (name: string, definition: any) => commands.set(name, definition),
		on: (event: string, handler: any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		getThinkingLevel: () => "xhigh",
	};
	const ctx: any = {
		cwd: "/tmp/pi-rail-ui-dev",
		hasUI: true,
		model: { provider: "custom", api: "openai-responses", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
		modelRegistry: {
			getRegisteredProviderConfig: () => undefined,
			getRegisteredNativeProvider: () => undefined,
			getProvider: () => undefined,
			isUsingOAuth: () => false,
		},
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [],
			getCwd: () => "/tmp/pi-rail-ui",
			getSessionFile: () => undefined,
			getSessionId: () => "footer-test",
		},
		getContextUsage: () => ({ tokens: 0, contextWindow: 100_000, percent: 0 }),
		isIdle: () => true,
		hasPendingMessages: () => false,
		waitForIdle: async () => {},
		ui: {
			notify: () => {},
			setStatus: (key: string, text: string | undefined) => {
				if (text === undefined) extensionStatuses.delete(key);
				else extensionStatuses.set(key, text);
				tui.requestRender();
			},
		},
	};
	const footerData: any = {
		getGitBranch: () => "feat/gpt-native-search-panel",
		getExtensionStatuses: () => extensionStatuses,
		onBranchChange: () => () => {},
	};

	installRailFast(pi);
	installRailOaiSearch(pi);
	const component = createRailFooter(ctx, pi)(tui, undefined, footerData);
	try {
		for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
		await commands.get("rail-oai-fast").handler("on", ctx);
		await commands.get("rail-oai-search").handler("live", ctx);
		assert.ok(renders > 0);
		const rendered = stripAnsi(component.render(90).join("\n"));
		assert.match(rendered, /SEARCH LIVE/);
		assert.match(rendered, /FAST/);
	} finally {
		component.dispose();
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
	}
});
