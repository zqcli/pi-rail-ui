import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentSession, getPackageDir } from "@earendil-works/pi-coding-agent";
import { installRailFast } from "../../../commands/rail-fast";
import { installRailOaiSearch } from "../../../commands/rail-oai-search";
import { installRailKeepAlive } from "../../../commands/rail-keep-alive";
import { createRailFooter } from "../../../components/footer";
import { stripAnsi } from "../../../core/utils";
import { visibleWidth } from "@earendil-works/pi-tui";

// Test-only import. Production binds the warmer owned by the live Pi session.
const { CacheWarmer } = await import(pathToFileURL(join(getPackageDir(), "dist/core/cache-warmer.js")).href);

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
  assert.doesNotMatch(stripAnsi(footer.render(90).join("")), /KA 1\|/, "unsupported control cannot advertise an enabled interval");
  await commands.get("rail-keep-alive").handler("off", ctx);
  assert.doesNotMatch(stripAnsi(footer.render(90).join("")), /KA 1\|/);
 } finally { footer.dispose(); await emit("session_shutdown"); }
 assert.equal(unsubscribed, 1);
});

test("RailFooterComponent redraws on keep-alive transitions and disposes its subscriber", async (t) => {
 t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
 const originalPrompt = AgentSession.prototype.prompt;
 AgentSession.prototype.prompt = async () => {};
 const handlers = new Map<string, Function[]>();
 const commands = new Map<string, any>();
 const entries: any[] = [];
 let leaf = 0;
 const manager: any = {
  getSessionId: () => "footer-live", getLeafId: () => String(leaf), getCwd: () => "/tmp/rail",
  getEntries: () => entries, getBranch: () => entries,
  appendUsage: (kind: string, provider: string, model: string, usage: any) => {
   const entry = { type: "usage", kind, provider, model, usage };
   entries.push(entry); leaf++; return entry;
  },
 };
 const pi: any = {
  on: (name: string, fn: Function) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
  registerCommand: (name: string, command: any) => commands.set(name, command),
  appendEntry: (_name: string, data: any) => { entries.push({ type: "custom", customType: "rail-keep-alive", data }); leaf++; },
  getThinkingLevel: () => "off",
 };
 const ctx: any = {
  cwd: "/tmp/rail", sessionManager: manager, isIdle: () => true,
  getContextUsage: () => undefined, ui: { notify() {} },
 };
 const model = { id: "mock", provider: "local", api: "openai-responses", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
 let complete!: (message: any) => void;
 const warmer: any = new CacheWarmer({ streamSimple() { return { result: () => new Promise((resolve) => { complete = resolve; }) }; } }, manager, () => "streaming");
 const session = Object.create(AgentSession.prototype) as AgentSession;
 Object.defineProperties(session, { sessionManager: { value: manager }, _cacheWarmer: { value: warmer }, agent: { value: { state: { model } } } });
 let renders = 0;
 let branchDisposals = 0;
 const footerData: any = {
  getGitBranch: () => null, getExtensionStatuses: () => new Map(),
  onBranchChange: () => () => { branchDisposals++; },
 };
 const emit = async (name: string) => { for (const fn of handlers.get(name) ?? []) await fn({}, ctx); };
 installRailKeepAlive(pi);
 const footer = createRailFooter(ctx, pi)({ requestRender() { renders++; } }, undefined, footerData);
 try {
  await emit("session_start");
  await session.prompt("bind only; no provider request");
  await commands.get("rail-keep-alive").handler("1", ctx);
  assert.match(stripAnsi(footer.render(90)[0]!), /KA 1\|-/);
  warmer.start({ model, context: { messages: [] }, options: {} }, () => true);
  warmer.onAgentSettled();
  const scheduledRenders = renders;
  assert.ok(scheduledRenders > 0);
  t.mock.timers.tick(60_000);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.ok(renders > scheduledRenders, "the timer requests a render before the provider finishes");
  assert.match(stripAnsi(footer.render(90)[0]!), /KA 1\|0/);
  complete({ stopReason: "stop", provider: "local", model: "mock", usage: { input: 1, cost: { total: 0 } } });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.match(stripAnsi(footer.render(90)[0]!), /KA 1\|1/);
  warmer.start({ model, context: { messages: [] }, options: { cacheRetention: "none" } }, () => true);
  assert.match(stripAnsi(footer.render(90)[0]!), /KA 1\|PAUSED/);
  await commands.get("rail-keep-alive").handler("off", ctx);
  assert.doesNotMatch(stripAnsi(footer.render(90)[0]!), /KA 1\|/);
  footer.dispose();
  const afterDispose = renders;
  await commands.get("rail-keep-alive").handler("1", ctx);
  assert.equal(renders, afterDispose, "disposed footer never receives another status event");
 } finally {
  footer.dispose();
  await emit("session_shutdown");
  AgentSession.prototype.prompt = originalPrompt;
 }
 assert.equal(branchDisposals, 1);
});
