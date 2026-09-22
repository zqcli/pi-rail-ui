import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";
import installRailContextExtension from "../../tools/subagents/context-extension";
import { CONTEXT_COMMAND, CONTEXT_PROTOCOL_FLAG, CONTEXT_PROTOCOL_VERSION, CONTEXT_WINDOW_FLAG, contextExtensionPath, createChildContextSettings, resolveChildContextCwd } from "../../tools/subagents/context-window";
import { RpcSessionWorker, type RpcEvent, type RpcTransport } from "../../tools/subagents/rpc-worker";
import { SessionBroker, type AgentInstance, type WorkerStartSpec } from "../../tools/subagents/session-broker";
import { createStatelessAgentRunner } from "../../tools/subagents/stateless-runner";
import { installStatefulSubagentTool } from "../../tools/subagents/tool";
import { emptySubagentUsage } from "../../tools/subagents/usage";

const small = { provider: "budget-test", modelId: "child/small" };
const large = { provider: "budget-test", modelId: "child/large" };
const parent = { provider: "budget-test", modelId: "parent" };
const native = (model: typeof small) => ({ provider: model.provider, id: model.modelId, name: model.modelId, contextWindow: 128_000, api: "openai-completions", reasoning: false });
const run = () => ({ output: "done", usage: emptySubagentUsage() });

async function setup(t: TestContext, trusted = true) {
	const root = await mkdtemp(join(tmpdir(), "rail-budget-086-"));
	const agentDir = join(root, "agent");
	const childCwd = join(root, "child");
	const parentCwd = join(root, "parent");
	const old = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	t.after(async () => {
		if (old === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = old;
		await rm(root, { recursive: true, force: true });
	});
	await mkdir(agentDir, { recursive: true });
	await mkdir(join(childCwd, ".pi"), { recursive: true });
	await mkdir(join(parentCwd, ".pi"), { recursive: true });
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { reserveTokens: 16_384 } }));
	await writeFile(join(childCwd, ".pi/settings.json"), JSON.stringify({ compaction: { modelOverrides: {
		"budget-test/child/small": { reserveTokens: 8192 },
		"budget-test/child/large": { reserveTokens: 32_768 },
		"budget-test/parent": { reserveTokens: 60_000 },
	} } }));
	await writeFile(join(parentCwd, ".pi/settings.json"), JSON.stringify({ compaction: { modelOverrides: {
		"budget-test/child/small": { reserveTokens: 50_000 },
		"budget-test/child/large": { reserveTokens: 1000 },
		"budget-test/parent": { reserveTokens: 1000 },
	} } }));
	if (trusted) new ProjectTrustStore(agentDir).set(root, true);
	const sessionFile = join(root, "saved.jsonl");
	await writeFile(sessionFile, [
		{ type: "session", version: 3, id: "saved", timestamp: new Date().toISOString(), cwd: childCwd },
		// Saved history deliberately names a different model from the requested small child.
		{ type: "model_change", id: "saved-model", parentId: null, timestamp: new Date().toISOString(), provider: large.provider, modelId: large.modelId },
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	return { root, agentDir, childCwd, parentCwd, sessionFile };
}

class BudgetTransport implements RpcTransport {
	readonly commands: Record<string, unknown>[] = [];
	readonly listeners = new Set<(event: RpcEvent) => void>();
	model = native(small);
	stopped = false;
	setModelGate: Promise<void> | undefined;
	setModelStarted: (() => void) | undefined;
	constructor(readonly sessionFile: string) {}
	async request(command: Record<string, unknown>): Promise<unknown> {
		this.commands.push(command);
		switch (command["type"]) {
			case "get_state": return { sessionId: "saved", sessionFile: this.sessionFile, model: { ...this.model }, isStreaming: false, isCompacting: false };
			case "get_commands": return { commands: [{ name: CONTEXT_COMMAND, source: "extension", description: `protocol v${CONTEXT_PROTOCOL_VERSION}` }] };
			case "set_model":
				this.setModelStarted?.();
				await this.setModelGate;
				this.model = native({ provider: String(command["provider"]), modelId: String(command["modelId"]) });
				return this.model;
			case "prompt": {
				const message = String(command["message"]);
				if (message.startsWith(`/${CONTEXT_COMMAND} prepare `)) this.model.contextWindow = Number(message.split(" ")[2]);
				else if (message === `/${CONTEXT_COMMAND} reset`) this.model.contextWindow = 128_000;
				else {
					this.emit({ type: "agent_start" });
					this.model.contextWindow = 128_000;
					this.emit({ type: "agent_settled" });
				}
				return undefined;
			}
		}
		return undefined;
	}
	emit(event: RpcEvent) { for (const listener of this.listeners) listener(event); }
	onEvent(listener: (event: RpcEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
	async stop() { this.stopped = true; }
}

test("0.87 real CLI helper and parent honor noninteractive saved/default project trust", { timeout: 60_000 }, async (t) => {
	const { root, agentDir, childCwd } = await setup(t, false);
	const cli = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
	const probe = join(root, "trust-probe.mjs");
	// Observe the real context after the helper, then handle input without any
	// provider request or credentials. No trust handler overrides the CLI path.
	await writeFile(probe, `export default function(pi) {
		pi.on("session_start", (_event, ctx) => console.error("TRUST_PROBE:" + JSON.stringify({ trusted: ctx.isProjectTrusted(), window: ctx.model.contextWindow })));
		pi.on("input", () => ({ action: "handled" }));
	}`);
	const trust = new ProjectTrustStore(agentDir);
	for (const scenario of [
		{ name: "default ask", defaultTrust: undefined, ancestor: null, saved: null, accepted: false },
		{ name: "explicit ask", defaultTrust: "ask", ancestor: null, saved: null, accepted: false },
		{ name: "always", defaultTrust: "always", ancestor: null, saved: null, accepted: true },
		{ name: "never", defaultTrust: "never", ancestor: null, saved: null, accepted: false },
		{ name: "saved allow overrides never", defaultTrust: "never", ancestor: null, saved: true, accepted: true },
		{ name: "saved deny overrides always", defaultTrust: "always", ancestor: null, saved: false, accepted: false },
		{ name: "inherited allow", defaultTrust: "ask", ancestor: true, saved: null, accepted: true },
		{ name: "nearest deny", defaultTrust: "always", ancestor: true, saved: false, accepted: false },
		{ name: "nearest allow", defaultTrust: "never", ancestor: false, saved: true, accepted: true },
	]) {
		await t.test(scenario.name, async () => {
			await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: scenario.defaultTrust, compaction: { reserveTokens: 16_384 } }));
			await writeFile(join(childCwd, ".pi/settings.json"), JSON.stringify({ defaultProjectTrust: "always", compaction: { modelOverrides: { "anthropic/claude-sonnet-4-5": { reserveTokens: 8192 } } } }));
			trust.set(root, scenario.ancestor);
			trust.set(childCwd, scenario.saved);
			const before = await readFile(join(agentDir, "trust.json"), "utf8");
			const settings = createChildContextSettings(childCwd).getCompactionSettings({ provider: "anthropic", id: "claude-sonnet-4-5" });
			assert.equal(settings.reserveTokens, scenario.accepted ? 8192 : 16_384);
			const child = spawn(process.execPath, [cli, "--offline", "--mode", "json", "-p", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
				"--model", "anthropic/claude-sonnet-4-5", "-e", contextExtensionPath(), "--rail-context-protocol", "1", "--rail-context-window", "12000", "-e", probe, "handled locally"], {
				cwd: childCwd,
				env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
				stdio: ["ignore", "pipe", "pipe"],
			});
			const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
			let stderr = "";
			child.stdout.resume();
			child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
			try {
				const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
				assert.equal(code, 0, stderr);
			} finally { clearTimeout(timer); }
			const observed = JSON.parse(stderr.match(/TRUST_PROBE:(\{[^\n]+\})/)?.[1] ?? "null");
			assert.equal(observed?.trusted, scenario.accepted, stderr);
			if (scenario.accepted) {
				assert.equal(observed.window, 12_000);
				assert.doesNotMatch(stderr, /rail-context-protocol-error/);
			} else {
				assert.notEqual(observed.window, 12_000);
				assert.match(stderr, /reserveTokens \(16384\)/);
			}
			assert.equal(await readFile(join(agentDir, "trust.json"), "utf8"), before);
		});
	}
});

function spec(cwd: string, sessionFile: string, mode: WorkerStartSpec["mode"] = "new"): WorkerStartSpec {
	return { agentId: "agt_budget", alias: "budget", cwd, model: small, mode, sessionPath: sessionFile };
}

function brokerHarness(cwd: string, sessionFile: string) {
	const instances = new Map<string, AgentInstance>();
	const aliases = new Map<string, string>();
	const starts: WorkerStartSpec[] = [];
	const transports: BudgetTransport[] = [];
	const broker = new SessionBroker({
		defaultCwd: cwd,
		store: {
			get: async (id) => { const value = instances.get(id); return value && structuredClone(value); },
			put: async (value) => { instances.set(value.agentId, structuredClone(value)); },
			delete: async (id) => { instances.delete(id); },
			list: async () => [...instances.values()].map((value) => structuredClone(value)),
		},
		roster: {
			resolve: (alias) => aliases.get(alias),
			link: (alias, id) => { aliases.set(alias, id); },
			unlink: (alias) => { aliases.delete(alias); },
			list: () => [...aliases].map(([alias, agentId]) => ({ alias, agentId })),
		},
		workerFactory: async (start) => {
			starts.push(start);
			const transport = new BudgetTransport(sessionFile);
			transport.model = native(start.model);
			transports.push(transport);
			return RpcSessionWorker.connect(start, transport);
		},
	});
	return { broker, instances, starts, transports };
}

function toolHarness(broker: SessionBroker, cwd: string, runStateless = async (_request: any) => ({ ...run(), exitCode: 0 })) {
	let tool: any;
	const models = [parent, small, large].map(native);
	const ctx: any = {
		cwd, model: models[0], thinkingLevel: "off", scopedModels: [], hasUI: true,
		modelRegistry: { getAvailable: () => models, find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id) },
		ui: { confirm: async () => true },
	};
	installStatefulSubagentTool({ registerTool: (value: any) => { tool = value; }, on: () => {} } as any, { broker, runStateless });
	return { ctx, execute: (args: any) => tool.execute("budget-call", args, undefined, undefined, ctx) };
}

test("0.87 stateless budgets use selected child model and cwd, not ordinary reserve", async (t) => {
	const { childCwd } = await setup(t);
	const invocations: string[][] = [];
	const runner = createStatelessAgentRunner({ resolveInvocation: (args) => {
		invocations.push(args);
		return { command: process.execPath, args: ["-e", "process.exit(0)"] };
	} });
	assert.equal(SettingsManager.create(childCwd).getCompactionSettings().reserveTokens, 16_384);
	await runner({ model: small, cwd: childCwd, task: "accepted", contextWindow: 12_000 });
	assert.equal(invocations[0]?.[invocations[0].indexOf("--rail-context-window") + 1], "12000");
	await assert.rejects(runner({ model: large, cwd: childCwd, task: "rejected", contextWindow: 24_576 }), /reserveTokens \(32768\)/);
	assert.equal(invocations.length, 1);
	await runner({ model: large, cwd: childCwd, task: "omitted" });
	assert.equal(invocations[1]?.some((arg) => arg.includes("rail-context")), false);
});

test("0.87 untrusted child reserves gate every parent path including restored cwd", async (t) => {
	const { agentDir, childCwd, parentCwd, sessionFile } = await setup(t, false);
	// Trust of the caller must not approve another cwd, including --session cwd.
	new ProjectTrustStore(agentDir).set(parentCwd, true);
	let invocations = 0;
	const runner = createStatelessAgentRunner({ resolveInvocation: () => {
		invocations++;
		return { command: process.execPath, args: ["-e", "process.exit(0)"] };
	} });
	await assert.rejects(runner({ model: small, cwd: childCwd, task: "blocked", contextWindow: 12_000 }), /reserveTokens \(16384\)/);
	assert.equal(invocations, 0);
	const { broker, starts } = brokerHarness(parentCwd, sessionFile);
	t.after(() => broker.shutdown());
	const { execute } = toolHarness(broker, parentCwd, async () => { throw new Error("must not dispatch"); });
	await assert.rejects(execute({ model: "budget-test/child/small", cwd: childCwd, task: "blocked", contextWindow: 12_000 }), /reserveTokens \(16384\)/);
	await assert.rejects(broker.dispatch({ model: small, cwd: childCwd, task: "blocked", contextWindow: 12_000 }), /reserveTokens \(16384\)/);
	await assert.rejects(broker.dispatch({ model: small, cwd: parentCwd, session: { mode: "exclusive", path: sessionFile }, task: "blocked", contextWindow: 12_000 }), /reserveTokens \(16384\)/);
	assert.equal(starts.length, 0);
	const transport = new BudgetTransport(sessionFile);
	const worker = await RpcSessionWorker.connect(spec(parentCwd, sessionFile, "exclusive"), transport);
	await assert.rejects(worker.send("blocked", { contextWindow: 12_000 }), /reserveTokens \(16384\)/);
	assert.equal(transport.commands.some((command) => command["type"] === "prompt"), false);
	await worker.stop();
	await broker.attach({ model: small, cwd: childCwd, alias: "untrusted" });
	await assert.rejects(broker.validateContextWindowForTarget("untrusted", 12_000), /reserveTokens \(16384\)/);
	await assert.rejects(broker.dispatch({ target: "untrusted", task: "blocked", contextWindow: 12_000 }), /reserveTokens \(16384\)/);
});

test("0.87 tool preflight uses explicit child selection for parallel and chain before any dispatch", async (t) => {
	const { childCwd, parentCwd, sessionFile } = await setup(t);
	const { broker, starts } = brokerHarness(parentCwd, sessionFile);
	t.after(() => broker.shutdown());
	const requests: any[] = [];
	const { execute } = toolHarness(broker, parentCwd, async (request) => { requests.push(request); return { ...run(), exitCode: 0 }; });
	await execute({ model: "budget-test/child/small", cwd: childCwd, task: "accepted", contextWindow: 12_000 });
	assert.equal(requests[0].model.modelId, small.modelId);
	assert.equal(requests[0].cwd, childCwd);
	for (const mode of ["tasks", "chain"]) {
		await assert.rejects(execute({ [mode]: [
			{ model: "budget-test/child/small", cwd: childCwd, task: "must not start", contextWindow: 12_000 },
			{ model: "budget-test/child/large", cwd: childCwd, alias: "large", task: "reject", contextWindow: 24_576 },
		] }), /reserveTokens \(32768\)/);
	}
	assert.equal(requests.length, 1);
	assert.equal(starts.length, 0);
	await assert.rejects(execute({ model: "missing/model", cwd: childCwd, task: "unresolved", contextWindow: 12_000 }), /Unknown Pi model/);
	await assert.rejects(execute({ cwd: childCwd, task: "default parent", contextWindow: 12_000 }), /reserveTokens \(60000\)/);
});

test("0.87 budgeted default model is pinned across async session confirmation", async (t) => {
	const { childCwd, sessionFile } = await setup(t);
	const { broker, starts } = brokerHarness(childCwd, sessionFile);
	t.after(() => broker.shutdown());
	const { execute, ctx } = toolHarness(broker, childCwd);
	ctx.model = native(small);
	ctx.ui.confirm = async () => { ctx.model = native(large); return true; };
	await execute({ task: "fork", session: { mode: "fork", path: sessionFile }, contextWindow: 12_000 });
	assert.equal(starts[0]?.model.modelId, small.modelId);
});

for (const mode of ["new", "fork", "exclusive"] as const) {
	test(`0.87 persistent ${mode} budgets use child model and effective cwd`, async (t) => {
		const { childCwd, parentCwd, sessionFile } = await setup(t);
		const { broker, starts, transports } = brokerHarness(parentCwd, sessionFile);
		t.after(() => broker.shutdown());
		const cwd = mode === "exclusive" ? parentCwd : childCwd;
		const session = mode === "new" ? undefined : { mode, path: sessionFile };
		const { execute } = toolHarness(broker, parentCwd);
		await execute({ model: "budget-test/child/small", cwd, alias: "small", task: "accepted", session, confirmSessionAttach: false, contextWindow: 12_000 });
		assert.equal(starts.length, 1);
		await assert.rejects(broker.dispatch({ model: large, cwd, ...(session ? { session } : {}), task: "reject", contextWindow: 24_576 }), /reserveTokens \(32768\)/);
		assert.equal(starts.length, 1);
		await broker.validateContextWindowForTarget("small", 12_000);
		await broker.dispatch({ target: "small", cwd: parentCwd, task: "target", contextWindow: 12_000 });
		await broker.changeModel("small", large);
		await assert.rejects(broker.validateContextWindowForTarget("small", 24_576), /reserveTokens \(32768\)/);
		const count = transports[0]!.commands.length;
		await assert.rejects(broker.dispatch({ target: "small", task: "reject", contextWindow: 24_576 }), /reserveTokens \(32768\)/);
		assert.equal(transports[0]!.commands.length, count);
		await broker.dispatch({ target: "small", task: "omitted" });
		assert.equal(transports[0]!.commands.slice(count).some((command) => String(command["message"]).startsWith(`/${CONTEXT_COMMAND}`)), false);
	});
}

test("0.87 stopped target preflight uses saved model and cwd, never caller cwd", async (t) => {
	const { childCwd, parentCwd, sessionFile } = await setup(t);
	const { broker, starts } = brokerHarness(parentCwd, sessionFile);
	t.after(() => broker.shutdown());
	await broker.attach({ model: small, alias: "saved", cwd: childCwd });
	await broker.stop("saved");
	await broker.changeModel("saved", large);
	await assert.rejects(broker.dispatch({ target: "saved", task: "reject before opening", contextWindow: 24_576 }), /reserveTokens \(32768\)/);
	assert.equal(starts.length, 1);
	await broker.changeModel("saved", small);
	await broker.validateContextWindowForTarget("saved", 12_000);
	await broker.dispatch({ target: "saved", cwd: parentCwd, task: "open", contextWindow: 12_000 });
	assert.equal(starts[1]?.mode, "open");
	assert.equal(starts[1]?.model.modelId, small.modelId);
});

test("0.87 queued target model change is awaited by budget preflight", async (t) => {
	const { childCwd, sessionFile } = await setup(t);
	const { broker, transports } = brokerHarness(childCwd, sessionFile);
	t.after(() => broker.shutdown());
	await broker.attach({ model: large, alias: "changing" });
	const gate = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	transports[0]!.setModelGate = gate.promise;
	transports[0]!.setModelStarted = started.resolve;
	const change = broker.changeModel("changing", small);
	await started.promise;
	const preflight = broker.validateContextWindowForTarget("changing", 12_000);
	gate.resolve();
	await change;
	await preflight;
	await broker.dispatch({ target: "changing", task: "new model", contextWindow: 12_000 });
});

test("0.87 RPC validates actual model before budget; mismatches remain fail-closed", async (t) => {
	const { childCwd, parentCwd, sessionFile } = await setup(t);
	const transport = new BudgetTransport(sessionFile);
	const worker = await RpcSessionWorker.connect(spec(parentCwd, sessionFile, "exclusive"), transport);
	await worker.send("small", { contextWindow: 12_000 });
	await worker.setModel(large);
	let count = transport.commands.length;
	await assert.rejects(worker.send("large", { contextWindow: 24_576 }), /reserveTokens \(32768\)/);
	assert.equal(transport.commands.slice(count).some((command) => command["type"] === "prompt"), false);
	assert.equal(worker.isReusable(), true);
	transport.model = native(small);
	count = transport.commands.length;
	await assert.rejects(worker.send("unexpected model", { contextWindow: 24_576 }), /model changed/);
	assert.equal(worker.isReusable(), false);
	assert.equal(transport.commands.slice(count).some((command) => command["type"] === "prompt"), false);
	for (const mode of ["open", "fork", "exclusive"] as const) {
		const wrong = new BudgetTransport(sessionFile);
		wrong.model = native(large);
		await assert.rejects(RpcSessionWorker.connect(spec(childCwd, sessionFile, mode), wrong), /expected budget-test\/child\/small/);
		assert.equal(wrong.stopped, true);
	}
});

test("0.87 RPC prevents dispatch while model selection is unconfirmed", async (t) => {
	const { childCwd, sessionFile } = await setup(t);
	const transport = new BudgetTransport(sessionFile);
	const worker = await RpcSessionWorker.connect(spec(childCwd, sessionFile), transport);
	const gate = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	transport.setModelGate = gate.promise;
	transport.setModelStarted = started.resolve;
	const change = worker.setModel(large);
	await started.promise;
	await assert.rejects(worker.send("blocked", { contextWindow: 12_000 }), /model change is in progress/);
	await assert.rejects(worker.setModel(small), /idle worker/);
	gate.resolve();
	await change;
	await assert.rejects(worker.send("large", { contextWindow: 24_576 }), /reserveTokens \(32768\)/);
});

function extensionHarness(cwd: string, startupBudget?: string) {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	let command!: (args: string, ctx: any) => Promise<void>;
	let aborts = 0;
	const flags = new Map([[CONTEXT_PROTOCOL_FLAG, CONTEXT_PROTOCOL_VERSION]]);
	if (startupBudget !== undefined) flags.set(CONTEXT_WINDOW_FLAG, startupBudget);
	installRailContextExtension({
		registerFlag: () => {}, getFlag: (name: string) => flags.get(name),
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerCommand: (_name: string, options: any) => { command = options.handler; },
	} as any);
	const ctx = { cwd, model: native(small), isProjectTrusted: () => true, abort: () => { aborts++; } };
	return { ctx, handlers, command: (args: string) => command(args, ctx), aborts: () => aborts };
}

test("0.87 child helper uses current model for startup and prepare, restores and omits overrides", async (t) => {
	const { childCwd } = await setup(t);
	const helper = extensionHarness(childCwd, "12000");
	helper.handlers.get("session_start")!({}, helper.ctx);
	assert.equal(helper.ctx.model.contextWindow, 12_000);
	helper.handlers.get("agent_settled")!({}, helper.ctx);
	assert.equal(helper.ctx.model.contextWindow, 128_000);
	await helper.command("reset");
	helper.ctx.model = native(large);
	await assert.rejects(helper.command("prepare 24576"), /reserveTokens \(32768\)/);
	assert.equal(helper.ctx.model.contextWindow, 128_000);
	await helper.command("prepare omit");
	assert.equal(helper.ctx.model.contextWindow, 128_000);
	helper.ctx.model = native(small);
	await helper.command("prepare 12000");
	helper.ctx.model = native(large);
	t.mock.method(console, "error", () => {});
	assert.throws(() => helper.handlers.get("turn_start")!({}, helper.ctx), /model changed/);
	assert.equal(helper.aborts(), 1);
	assert.deepEqual(helper.handlers.get("input")!({}, helper.ctx), { action: "handled" });
});

test("0.87 child helper rejects invalid startup budget before provider dispatch", async (t) => {
	const { childCwd } = await setup(t);
	const helper = extensionHarness(childCwd, "24576");
	helper.ctx.model = native(large);
	const errors = t.mock.method(console, "error", () => {});
	helper.handlers.get("session_start")!({}, helper.ctx);
	assert.match(String(errors.mock.calls[0]?.arguments[0]), /reserveTokens \(32768\)/);
	assert.equal(helper.ctx.model.contextWindow, 128_000);
	assert.deepEqual(helper.handlers.get("input")!({}, helper.ctx), { action: "handled" });
	helper.handlers.get("before_agent_start")!({}, helper.ctx);
	assert.equal(helper.aborts(), 1);
});

test("0.87 helper uses actual session trust rather than saved trust for startup and prepare", async (t) => {
	const { childCwd } = await setup(t);
	const helper = extensionHarness(childCwd);
	helper.ctx.isProjectTrusted = () => false;
	helper.handlers.get("session_start")!({}, helper.ctx);
	await assert.rejects(helper.command("prepare 12000"), /reserveTokens \(16384\)/);
	helper.ctx.isProjectTrusted = () => true;
	await helper.command("prepare 12000");
	assert.equal(helper.ctx.model.contextWindow, 12_000);
	const startup = extensionHarness(childCwd, "12000");
	startup.ctx.isProjectTrusted = () => false;
	const errors = t.mock.method(console, "error", () => {});
	startup.handlers.get("session_start")!({}, startup.ctx);
	assert.match(String(errors.mock.calls[0]?.arguments[0]), /reserveTokens \(16384\)/);
	assert.equal(startup.ctx.model.contextWindow, 128_000);
});

test("0.87 session cwd resolution distinguishes fork from open without modifying history", async (t) => {
	const { childCwd, parentCwd, sessionFile } = await setup(t);
	const original = await readFile(sessionFile, "utf8");
	assert.equal(await resolveChildContextCwd(parentCwd, { mode: "fork", path: sessionFile }), parentCwd);
	assert.equal(await resolveChildContextCwd(parentCwd, { mode: "exclusive", path: sessionFile }), childCwd);
	assert.equal(await resolveChildContextCwd(parentCwd, { mode: "open", path: sessionFile }), childCwd);
	assert.equal(await readFile(sessionFile, "utf8"), original);
});

test("0.87 null and omitted budgets never resolve reserves or issue override commands", async (t) => {
	const { childCwd, sessionFile } = await setup(t);
	const { broker, transports } = brokerHarness(childCwd, sessionFile);
	t.after(() => broker.shutdown());
	await broker.attach({ model: large, alias: "native" });
	const directTransport = new BudgetTransport(sessionFile);
	const worker = await RpcSessionWorker.connect(spec(childCwd, sessionFile), directTransport);
	const invocations: string[][] = [];
	const runner = createStatelessAgentRunner({ resolveInvocation: (args) => {
		invocations.push(args);
		return { command: process.execPath, args: ["-e", "process.exit(0)"] };
	} });
	t.mock.method(SettingsManager, "create", () => { throw new Error("omission must not read reserve settings"); });
	for (const value of [undefined, null]) {
		await runner({ model: large, cwd: childCwd, task: "native", contextWindow: value as any });
		await worker.send("native", { contextWindow: value as any });
		await broker.dispatch({ target: "native", task: "native", contextWindow: value as any });
	}
	assert.equal(invocations.some((args) => args.some((arg) => arg.includes("rail-context"))), false);
	for (const transport of [directTransport, ...transports]) {
		assert.equal(transport.commands.some((command) => String(command["message"]).startsWith(`/${CONTEXT_COMMAND}`)), false);
	}
	const helper = extensionHarness(childCwd);
	helper.handlers.get("session_start")!({}, helper.ctx);
	await helper.command("prepare omit");
	assert.equal(helper.ctx.model.contextWindow, 128_000);
});
