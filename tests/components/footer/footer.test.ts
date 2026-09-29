import assert from "node:assert/strict";
import { test } from "node:test";
import { installRailFast } from "../../../commands/rail-fast";
import { installRailOaiSearch } from "../../../commands/rail-oai-search";
import { installRailKeepAlive } from "../../../commands/rail-keep-alive";
import { createRailFooter } from "../../../components/footer";
import { stripAnsi } from "../../../core/utils";
import { visibleWidth } from "@earendil-works/pi-tui";

test("renders the active native search mode in the Rail footer", async () => {
	const commands = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const extensionStatuses = new Map<string, string>();
	let renders = 0;
	const tui = { requestRender: () => { renders += 1; } };
	const pi: any = {
		events: { emit: () => undefined, on: () => () => undefined },
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
		assert.match(rendered, /xhigh.*FAST.*SEARCH LIVE/);
		assert.match(rendered, /ctx 0\.00%/);
		// Native status line covers ready/working; Rail routes nothing for copies.
		assert.doesNotMatch(rendered, /selection copied/);
		assert.doesNotMatch(rendered, /● ready|● working/);
		assert.match(stripAnsi(component.render(40).join("\n")), /SEARCH LIVE/);
	} finally {
		component.dispose();
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
	}
});

test("keep-alive footer respects narrow widths, off hides label, and footer disposes subscription", async () => {
 const handlers = new Map<string, Function[]>();
 const commands = new Map<string, any>();
 const entries: any[] = [];
 const pi: any = {
  on: (name: string, fn: Function) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
  registerCommand: (name: string, command: any) => commands.set(name, command),
  appendEntry: (_name: string, data: any) => entries.push({ type: "custom", data }),
  getThinkingLevel: () => "off",
 };
 let unsubscribed = 0;
 const ctx: any = {
  cwd: "/tmp/rail", isIdle: () => true, getContextUsage: () => undefined,
  sessionManager: { getEntries: () => entries, getBranch: () => entries, getSessionId: () => "footer-ka", getCwd: () => "/tmp/rail" },
  ui: { notify: () => {} },
 };
 const footerData: any = {
  getGitBranch: () => null, getExtensionStatuses: () => new Map(),
  onBranchChange: () => () => { unsubscribed++; },
 };
 const emit = async (name: string) => { for (const fn of handlers.get(name) ?? []) await fn({}, ctx); };
 installRailKeepAlive(pi);
 const footer = createRailFooter(ctx, pi)({ requestRender() {} }, undefined, footerData);
 try {
  await emit("session_start");
  await commands.get("rail-keep-alive").handler("1", ctx);
  for (const width of [20, 40, 90]) assert.ok(visibleWidth(footer.render(width)[0]!) <= width);
  assert.match(stripAnsi(footer.render(90).join("")), /KA 1m PAUSED/);
  await commands.get("rail-keep-alive").handler("off", ctx);
  assert.doesNotMatch(stripAnsi(footer.render(90).join("")), /KA 1m/);
 } finally { footer.dispose(); await emit("session_shutdown"); }
 assert.equal(unsubscribed, 1);
});
