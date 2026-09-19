import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installRailFast, railFastFooterLabel } from "../../commands/rail-fast";
import { installRailOaiSearch, railOaiSearchFooterLabel } from "../../commands/rail-oai-search";
import { RAIL_OAI_GPT_ONLY_WARNING } from "../../commands/rail-oai-command";
import { installGptCompaction } from "../../tools/gpt-compaction/extension";
import { gptCompactionSettingsPath, readGptCompactionSettings } from "../../tools/gpt-compaction/settings";

const GPT_MODEL = { provider: "custom", api: "openai-responses", id: "gpt-5.6-sol", name: "GPT 5.6 Sol", baseUrl: "https://gateway.example/v1" };
const NON_GPT_MODEL = { provider: "custom", api: "openai-responses", id: "deepseek-v4", name: "DeepSeek V4", baseUrl: "https://gateway.example/v1" };

function eventBus() {
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	return {
		emit: (event: string, data: unknown) => listeners.get(event)?.forEach((listener) => listener(data)),
		on: (event: string, listener: (data: unknown) => void) => {
			const registered = listeners.get(event) ?? [];
			registered.push(listener);
			listeners.set(event, registered);
			return () => undefined;
		},
	};
}

type Harness = ReturnType<typeof setup>;

/**
 * Installs Fast, Search, and remote compaction on one Pi mock and exposes the
 * commands, lifecycle handlers, and recording UI so the GPT-only guard can be
 * exercised identically for all three features.
 */
function setup(model: unknown) {
	const commands = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const notices: string[] = [];
	const statusWrites = new Map<string, Array<string | undefined>>();
	const selections: Array<{ title: string; options: string[] }> = [];
	const providerConfigs = new Map<string, any>();
	let waitForIdleCalls = 0;
	const provider: any = { streamSimple: () => ({}) };
	const pi = {
		events: eventBus(),
		registerCommand: (name: string, definition: any) => { commands.set(name, definition); },
		registerFlag: () => undefined,
		getFlag: () => undefined,
		on: (event: string, handler: any) => { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		registerProvider: (providerId: string, config: any) => {
			providerConfigs.set(providerId, { ...(providerConfigs.get(providerId) ?? {}), ...config });
		},
		unregisterProvider: (providerId: string) => providerConfigs.delete(providerId),
		appendEntry: () => undefined,
		getActiveTools: () => [],
		getAllTools: () => [],
	};
	const ctx: any = {
		hasUI: true,
		mode: "tui",
		model,
		signal: undefined,
		abort: () => undefined,
		waitForIdle: async () => { waitForIdleCalls += 1; },
		sessionManager: { getBranch: () => [], getSessionId: () => "rail-oai-command-test", buildContextEntries: () => [] },
		modelRegistry: {
			getProvider: () => provider,
			getRegisteredProviderConfig: (providerId: string) => providerConfigs.get(providerId),
			getRegisteredNativeProvider: () => undefined,
		},
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: (key: string, value: string | undefined) => {
				statusWrites.set(key, [...(statusWrites.get(key) ?? []), value]);
			},
			select: async (title: string, options: string[]) => {
				selections.push({ title, options });
				return "on";
			},
		},
	};
	const run = async (event: string, ...args: unknown[]): Promise<any> => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) {
			const current = await handler(...args);
			if (current !== undefined) result = current;
		}
		return result;
	};

	installRailFast(pi as any);
	installRailOaiSearch(pi as any);
	installGptCompaction(pi as any);
	return {
		commands,
		run,
		notices,
		statusWrites,
		selections,
		ctx,
		waitForIdleCalls: () => waitForIdleCalls,
	};
}

function lastStatus(statusWrites: Map<string, Array<string | undefined>>, key: string): string | undefined {
	return statusWrites.get(key)?.at(-1);
}

async function startSession(harness: Harness) {
	await harness.run("session_start", {}, harness.ctx);
}

test("/rail-oai-* commands share one GPT-only rejection and mutate no state", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "rail-oai-command-"));
	const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	});

	const harness = setup(NON_GPT_MODEL);
	const { commands, notices, statusWrites, selections, ctx } = harness;
	await startSession(harness);

	await commands.get("rail-oai-fast").handler("on", ctx);
	assert.equal(notices.at(-1), RAIL_OAI_GPT_ONLY_WARNING, "fast on uses the shared warning");

	await commands.get("rail-oai-search").handler("live", ctx);
	assert.equal(notices.at(-1), RAIL_OAI_GPT_ONLY_WARNING, "search live uses the shared warning");
	await commands.get("rail-oai-search").handler("cached", ctx);
	assert.equal(notices.at(-1), RAIL_OAI_GPT_ONLY_WARNING, "search cached uses the shared warning");

	await commands.get("rail-oai-compaction").handler("on", ctx);
	assert.equal(notices.at(-1), RAIL_OAI_GPT_ONLY_WARNING, "compaction on uses the shared warning");
	await commands.get("rail-oai-compaction").handler("", ctx);
	assert.equal(notices.at(-1), RAIL_OAI_GPT_ONLY_WARNING, "the compaction menu is rejected before it opens");
	assert.deepEqual(selections, [], "no compaction menu was opened");

	assert.equal(harness.waitForIdleCalls(), 0, "a rejected command never waits for idle");
	assert.equal(lastStatus(statusWrites, "rail-oai-fast"), undefined);
	assert.equal(lastStatus(statusWrites, "rail-oai-search"), undefined);
	assert.equal(lastStatus(statusWrites, "rail-gpt-compaction"), "GPT compact: native");
	assert.equal(readGptCompactionSettings(agentDir).mode, "off", "a rejected on writes no global setting");
	assert.equal(
		await readFile(gptCompactionSettingsPath(agentDir), "utf8").catch(() => undefined),
		undefined,
		"nothing is persisted for a rejected on",
	);
	assert.deepEqual(notices, Array(5).fill(RAIL_OAI_GPT_ONLY_WARNING), "each rejection emits only one warning, never an enabled notice");
	ctx.model = { ...GPT_MODEL };
	await harness.run("model_select", {}, ctx);
	await harness.run("turn_start", {}, ctx);
	assert.equal(await harness.run("before_provider_request", { payload: { input: [] } }, ctx), undefined,
		"rejected commands must not arm Fast or Search for a later GPT model");
	assert.equal(railFastFooterLabel(), undefined);
	assert.equal(railOaiSearchFooterLabel(), undefined);
	await harness.run("session_shutdown", {}, ctx);
});

test("a rejected probe leaves no probe or mode residue behind", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "rail-oai-probe-"));
	const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	});

	const harness = setup({ ...GPT_MODEL });
	const { commands, notices, ctx } = harness;
	await startSession(harness);

	// Establish a live mode, then move to a non-GPT model where probe is rejected.
	await commands.get("rail-oai-search").handler("live", ctx);
	ctx.model = { ...NON_GPT_MODEL };
	await commands.get("rail-oai-search").handler("probe", ctx);
	assert.equal(notices.at(-1), RAIL_OAI_GPT_ONLY_WARNING);

	// Back on GPT the live mode resumes, but the rejected probe must not have
	// armed a forced web_search tool_choice for the next request.
	ctx.model = { ...GPT_MODEL };
	await harness.run("model_select", {}, ctx);
	await harness.run("turn_start", {}, ctx);
	const payload = await harness.run(
		"before_provider_request",
		{ payload: { model: "gpt-5.6-sol", input: [] } },
		ctx,
	);
	assert.deepEqual(payload.tools, [{ type: "web_search", external_web_access: true }], "live mode resumed after the rejected probe");
	assert.equal(payload.tool_choice, undefined, "the rejected probe left no armed tool_choice behind");
	await harness.run("turn_end", {}, ctx);
	await harness.run("session_shutdown", {}, ctx);
});

test("off is always available on a non-GPT model and clears the policy", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "rail-oai-off-"));
	const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	});

	const harness = setup({ ...GPT_MODEL });
	const { commands, notices, statusWrites, ctx } = harness;
	await startSession(harness);
	await commands.get("rail-oai-fast").handler("on", ctx);
	await commands.get("rail-oai-search").handler("live", ctx);
	await commands.get("rail-oai-compaction").handler("on", ctx);
	assert.equal(readGptCompactionSettings(agentDir).mode, "on");
	ctx.model = { ...NON_GPT_MODEL };
	await harness.run("model_select", {}, ctx);

	await commands.get("rail-oai-fast").handler("off", ctx);
	assert.match(notices.at(-1) ?? "", /fast mode disabled/);
	await commands.get("rail-oai-search").handler("off", ctx);
	assert.match(notices.at(-1) ?? "", /search disabled/);
	await commands.get("rail-oai-compaction").handler("off", ctx);
	assert.doesNotMatch(notices.at(-1) ?? "", /GPT models only/);
	assert.equal(readGptCompactionSettings(agentDir).mode, "off", "off clears the previously enabled global switch");
	assert.equal(lastStatus(statusWrites, "rail-gpt-compaction"), "GPT compact: native");
	ctx.model = { ...GPT_MODEL };
	await harness.run("model_select", {}, ctx);
	await harness.run("turn_start", {}, ctx);
	assert.equal(await harness.run("before_provider_request", { payload: { input: [] } }, ctx), undefined,
		"off on a non-GPT model prevents Fast and Search from resuming on GPT");
	assert.equal(railFastFooterLabel(), undefined);
	assert.equal(railOaiSearchFooterLabel(), undefined);
	await harness.run("session_shutdown", {}, ctx);
});

test("a missing model is rejected with the shared warning", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "rail-oai-nomodel-"));
	const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	});

	const harness = setup(undefined);
	const { commands, notices, ctx } = harness;
	await startSession(harness);
	for (const [name, args] of [["rail-oai-fast", "on"], ["rail-oai-search", "live"], ["rail-oai-compaction", "on"]] as const) {
		await commands.get(name).handler(args, ctx);
		assert.equal(notices.at(-1), RAIL_OAI_GPT_ONLY_WARNING, `${name} rejects a missing model`);
	}
	await harness.run("session_shutdown", {}, ctx);
});

test("a GPT model keeps the normal enable flow for all three commands", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "rail-oai-gpt-"));
	const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	});

	const harness = setup({ ...GPT_MODEL });
	const { commands, notices, statusWrites, selections, ctx } = harness;
	await startSession(harness);

	await commands.get("rail-oai-fast").handler("on", ctx);
	assert.match(notices.at(-1) ?? "", /fast mode enabled/);
	assert.equal(lastStatus(statusWrites, "rail-oai-fast"), "FAST");
	await harness.run("before_provider_request", { payload: { model: "gpt-5.6-sol", input: [] } }, ctx);

	await commands.get("rail-oai-search").handler("live", ctx);
	assert.match(notices.at(-1) ?? "", /set to live/);
	assert.equal(lastStatus(statusWrites, "rail-oai-search"), "SEARCH LIVE");

	await commands.get("rail-oai-compaction").handler("on", ctx);
	assert.deepEqual(selections, [], "an explicit on does not open the menu");
	assert.equal(readGptCompactionSettings(agentDir).mode, "on", "a GPT on persists the global switch");
	assert.equal(lastStatus(statusWrites, "rail-gpt-compaction"), "GPT compact: remote v2");
	await harness.run("session_shutdown", {}, ctx);
});

test("invalid arguments keep their usage text instead of the GPT-only warning", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "rail-oai-usage-"));
	const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	});

	const harness = setup(NON_GPT_MODEL);
	const { commands, notices, ctx } = harness;
	await startSession(harness);

	await commands.get("rail-oai-fast").handler("bogus", ctx);
	assert.match(notices.at(-1) ?? "", /Usage: \/rail-oai-fast on\|off\|status/);
	await commands.get("rail-oai-search").handler("status", ctx);
	assert.match(notices.at(-1) ?? "", /Usage: \/rail-oai-search live\|cached\|off\|probe/);
	await commands.get("rail-oai-compaction").handler("yes", ctx);
	assert.match(notices.at(-1) ?? "", /Usage: \/rail-oai-compaction \[on\|off\]/);

	// Fast `status` is also GPT-only in this contract.
	await commands.get("rail-oai-fast").handler("status", ctx);
	assert.equal(notices.at(-1), RAIL_OAI_GPT_ONLY_WARNING);
	await harness.run("session_shutdown", {}, ctx);
});

test("the Fast and Search footer labels hide stale policy on a non-GPT model", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "rail-oai-footer-"));
	const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	});

	const harness = setup({ ...GPT_MODEL });
	const { commands, ctx } = harness;
	await startSession(harness);
	await commands.get("rail-oai-fast").handler("on", ctx);
	await commands.get("rail-oai-search").handler("live", ctx);
	assert.equal(railFastFooterLabel(), "FAST");
	assert.equal(railOaiSearchFooterLabel(), "SEARCH LIVE");

	// GPT -> non-GPT: both labels disappear rather than showing an unusable policy.
	ctx.model = { ...NON_GPT_MODEL };
	await harness.run("model_select", {}, ctx);
	assert.equal(railFastFooterLabel(), undefined);
	assert.equal(railOaiSearchFooterLabel(), undefined);

	// Non-GPT -> GPT: the policies resume and the labels return.
	ctx.model = { ...GPT_MODEL };
	await harness.run("model_select", {}, ctx);
	assert.equal(railFastFooterLabel(), "FAST");
	assert.equal(railOaiSearchFooterLabel(), "SEARCH LIVE");
	await harness.run("session_shutdown", {}, ctx);
});

test("search and compaction re-check the model after the idle wait", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "rail-oai-switch-"));
	const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	t.after(async () => {
		if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	});

	const harness = setup({ ...GPT_MODEL });
	const { commands, notices, selections, statusWrites, ctx } = harness;
	await startSession(harness);

	// Search: the model switches to non-GPT while waitForIdle is pending, so the
	// mode must not flip to live.
	ctx.waitForIdle = async () => { ctx.model = { ...NON_GPT_MODEL }; };
	await commands.get("rail-oai-search").handler("live", ctx);
	assert.equal(notices.at(-1), RAIL_OAI_GPT_ONLY_WARNING, "the post-idle re-check rejects the switched model");
	assert.equal(lastStatus(statusWrites, "rail-oai-search"), undefined, "search stays off after the switch");

	// Compaction: `on` selected before idle must not write once the model is non-GPT.
	ctx.model = { ...GPT_MODEL };
	ctx.waitForIdle = async () => { ctx.model = { ...NON_GPT_MODEL }; };
	await commands.get("rail-oai-compaction").handler("on", ctx);
	assert.equal(notices.at(-1), RAIL_OAI_GPT_ONLY_WARNING);
	assert.equal(readGptCompactionSettings(agentDir).mode, "off", "the post-idle re-check skips the settings write");
	assert.deepEqual(selections, []);
	await harness.run("session_shutdown", {}, ctx);
});
