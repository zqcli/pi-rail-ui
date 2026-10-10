import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { prompt } from "../../core/prompts";
import { RailAgentManager } from "../../tools/subagents/agent-manager";
import { FileAgentInstanceStore } from "../../tools/subagents/instance-store";
import { RailAgentOverlayComponent } from "../../tools/subagents/rail-agent-overlay";
import { SessionBroker, type WorkerStartSpec } from "../../tools/subagents/session-broker";
import { SessionAgentRoster } from "../../tools/subagents/session-links";
import { createRpcWorkerFactory } from "../../tools/subagents/worker-factory";

const bundleCli = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/pi-subagent-retry.mjs", import.meta.url));
const model = { provider: "rail-retry-local", modelId: "offline-retry", thinkingLevel: "off" as const };
const isolatedArgs = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--offline", "--no-builtin-tools", "-e", fixture];
const records = (text: string): any[] => text.trim().split("\n").map((line) => JSON.parse(line));

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!condition()) {
		assert.ok(Date.now() < deadline, "local continuation did not reach the expected async boundary");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("real Pi panel Continue reopens a failed/stopped descriptor, preserves history and survives popup close without a parent turn", { timeout: 20_000 }, async () => {
	const root = join(process.cwd(), ".tmp");
	await mkdir(root, { recursive: true });
	const dir = await mkdtemp(join(root, "pi-continue-"));
	const agentDir = join(dir, "agent");
	await mkdir(agentDir);
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, quietStartup: true }));
	await writeFile(join(dir, "manual-continue-test"), "");
	const previous = { HOME: process.env["HOME"], PI_CODING_AGENT_DIR: process.env["PI_CODING_AGENT_DIR"] };
	process.env["HOME"] = join(dir, "home");
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	const starts: WorkerStartSpec[] = [];
	const stateDir = join(dir, "state");
	const store = new FileAgentInstanceStore(stateDir);
	const parentEntries: unknown[] = [];
	const roster = new SessionAgentRoster((type, data) => parentEntries.push({ type, data }));
	const factory = createRpcWorkerFactory({ stateDir, resolveInvocation: (args) => ({ command: process.execPath, args: [bundleCli, ...isolatedArgs, ...args] }) });
	const newBroker = () => new SessionBroker({ store, roster, defaultCwd: dir, workerFactory: async (spec) => { starts.push(spec); return factory(spec); } });
	let broker = newBroker();
	let component: RailAgentOverlayComponent | undefined;
	try {
		let manager = new RailAgentManager(broker, store, roster, stateDir);
		await assert.rejects(manager.create({ model, alias: "manual-review", cwd: dir, task: "ORIGINAL RETRY TASK", fastMode: false }), /401 manual continuation required/);
		const saved = (await store.list())[0]!;
		assert.equal((await manager.snapshot()).agents[0]?.phase, "error");
		await broker.shutdown();
		const historyBefore = await readFile(saved.sessionFile, "utf8");
		broker = newBroker();
		manager = new RailAgentManager(broker, store, roster, stateDir);
		const stopped = await manager.snapshot();
		assert.equal(stopped.agents[0]?.phase, "stopped");
		const notifications: Array<{ message: string; type: string | undefined }> = [];
		let closed = false;
		let mentions = 0;
		let parentTurns = 0;
		const ctx = {
			cwd: dir,
			sessionManager: { getSessionId: () => "isolated-parent" },
			modelRegistry: { find: () => undefined, streamSimple: () => { parentTurns++; throw new Error("no parent turn allowed"); } },
			ui: { notify: (message: string, type?: string) => { notifications.push({ message, type }); } },
		};
		component = new RailAgentOverlayComponent(
			{ terminal: { rows: 15 }, requestRender: () => undefined } as any,
			{ fg: (_color: string, text: string) => text, bold: (text: string) => text } as any,
			{ matches: (data: string, id: string) => id === "tui.select.confirm" ? data === "\r" : id === "tui.select.cancel" && data === "\u001b" } as any,
			() => { closed = true; }, ctx as any,
			{ manager, models: [model], currentCwd: dir, insertMention: () => { mentions++; } }, stopped,
		);
		component.focused = true;
		component.handleInput("\r");
		assert.equal(component["control"]?.input.getValue(), prompt("subagent", "manual_continue"));
		const screen = component.render(73);
		assert.ok(screen.every((line) => visibleWidth(line) <= 73));
		assert.ok(screen.find((line) => line.includes("Message:"))?.includes(CURSOR_MARKER));
		const composer = component["control"]!;
		composer.input.setValue("/reject-continue-test");
		component.handleInput("\r");
		await waitFor(() => !component!["busy"]);
		assert.equal(component["control"], composer, "real Pi prompt rejection retains the composer");
		assert.equal(composer.input.getValue(), "/reject-continue-test");
		assert.match(component.render(100).join("\n"), /handled without starting an agent run/);
		assert.deepEqual(notifications, [], "a handled prompt with no agent run is not a completion failure");
		composer.input.setValue(prompt("subagent", "manual_continue"));
		component.handleInput("\r");
		component.handleInput("\r");
		await waitFor(() => component!["control"] === undefined && !component!["busy"]);
		assert.equal(closed, false);
		assert.equal(broker.runtimeStatus(saved.agentId).phase, "running", "panel returns only after this dispatch is accepted");
		assert.deepEqual(notifications, [], "held provider has not completed yet");
		component.handleInput("\u001b");
		assert.equal(closed, true);
		component.dispose();
		await writeFile(join(dir, "release-continuation"), "");
		await waitFor(() => notifications.length > 0);
		assert.deepEqual(notifications, [{ message: "Agent manual-review finished its continuation: continued with recorded tool result", type: "info" }]);
		const continued = (await store.list())[0]!;
		assert.equal((await store.list()).length, 1);
		assert.equal(continued.agentId, saved.agentId);
		assert.equal(continued.sessionId, saved.sessionId);
		assert.equal(continued.sessionFile, saved.sessionFile);
		assert.deepEqual(continued.model, saved.model);
		assert.equal(continued.fastMode, saved.fastMode);
		assert.equal(continued.lastTask, prompt("subagent", "manual_continue"));
		assert.equal((await manager.snapshot()).agents[0]?.phase, "idle");
		assert.equal(starts.length, 3);
		for (const start of starts.slice(1)) {
			assert.equal(start.mode, "open");
			assert.equal(start.sessionPath, saved.sessionFile);
		}
		const historyAfter = await readFile(saved.sessionFile, "utf8");
		assert.ok(historyAfter.startsWith(historyBefore), "original recorded history remains unchanged");
		const events = records(await readFile(join(dir, "retry-events.jsonl"), "utf8"));
		assert.deepEqual(events.filter((event) => event.type === "prompt").map((event) => event.prompt), ["ORIGINAL RETRY TASK", prompt("subagent", "manual_continue")]);
		assert.equal(events.filter((event) => event.type === "session_start").every((event) => event.sessionId === saved.sessionId), true);
		const requests = records(await readFile(join(dir, "provider-requests.jsonl"), "utf8"));
		assert.equal(requests.length, 3);
		assert.equal(requests[2].hasResult, true);
		assert.equal(requests[2].messages.filter((message: any) => message.role === "toolResult" && message.toolName === "retry_append").length, 1);
		assert.equal(await readFile(join(dir, "append-marker.txt"), "utf8"), "completed\n");
		assert.equal(mentions, 0);
		assert.equal(parentTurns, 0);
		assert.equal(parentEntries.length, 1, "only the initial roster link, no parent task or editor mention");
	} finally {
		component?.dispose();
		await writeFile(join(dir, "release-continuation"), "");
		await broker.shutdown();
		for (const key of ["HOME", "PI_CODING_AGENT_DIR"] as const) {
			if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
		}
		await rm(dir, { recursive: true, force: true });
	}
});
