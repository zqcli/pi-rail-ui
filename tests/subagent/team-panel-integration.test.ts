import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { FileAgentInstanceStore } from "../../tools/subagents/instance-store";
import { PiRpcProcessTransport } from "../../tools/subagents/rpc-transport";
import { RpcSessionWorker, buildRpcWorkerArgs } from "../../tools/subagents/rpc-worker";
import { SessionBroker, type AgentRoster, type SessionWorkerFactory } from "../../tools/subagents/session-broker";
import { TeamSessionHost } from "../../tools/subagents/team-host";
import type { TeamActivationRun } from "../../tools/subagents/team-member-driver";
import { TeamOverlayComponent } from "../../tools/subagents/team-overlay";

const MODEL = { provider: "rail-team-local", modelId: "probe" };
const CLI = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const PROVIDER = fileURLToPath(new URL("../fixtures/team-v2-local-provider.mjs", import.meta.url));
const TEAM_TITLE = "Local title integration";
const WORK_TITLE = "Verify local title flow";
const CHILD_TITLE = "Run the local dependency";
const CALLBACK_TITLE = "Answer the local question";

class MemoryRoster implements AgentRoster {
	private readonly values = new Map<string, string>();
	resolve(target: string) { return this.values.get(target); }
	link(alias: string, agentId: string) { this.values.set(alias, agentId); }
	unlink(alias: string) { this.values.delete(alias); }
	list() { return [...this.values].map(([alias, agentId]) => ({ alias, agentId })); }
}

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const keys = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b", right: "\x1b[C" };
const bindings: Record<string, string> = { "tui.select.up": keys.up, "tui.select.down": keys.down, "tui.select.confirm": keys.enter, "tui.select.cancel": keys.escape };

test("real Pi local-provider Team preserves titles in views and panel and accounts every work token", { timeout: 60000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "rail-team-panel-"));
	const oldAgentDir = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = root;
	t.after(() => {
		if (oldAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = oldAgentDir;
	});
	await mkdir(join(root, "rail-team"));
	await writeFile(join(root, "rail-team", "settings.json"), JSON.stringify({ version: 1, compactThreshold: null }));
	await writeFile(join(root, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
	const workerFactory: SessionWorkerFactory = async (spec) => {
		const args = buildRpcWorkerArgs(spec);
		const modelIndex = args.indexOf("--model");
		assert.ok(modelIndex >= 0);
		args.splice(modelIndex, 0, "-e", PROVIDER);
		const transport = new PiRpcProcessTransport({
			command: process.execPath,
			args: [CLI, "--offline", "--no-extensions", "--session-dir", join(root, "sessions"), ...args],
			cwd: spec.cwd,
			env: {
				PATH: process.env["PATH"] ?? "", HOME: root, PI_CODING_AGENT_DIR: root,
				PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", TEAM_V2_SCENARIO: "panel-v3",
			},
		});
		await transport.start();
		return RpcSessionWorker.connect(spec, transport);
	};
	const broker = new SessionBroker({ store: new FileAgentInstanceStore(join(root, "stateful-subagents")), roster: new MemoryRoster(), workerFactory, defaultCwd: root });
	const host = new TeamSessionHost(broker, () => undefined, []);
	t.after(async () => {
		try { await host.close(); }
		finally {
			try { await broker.shutdown(); }
			finally { await rm(root, { recursive: true, force: true }); }
		}
	});
	const prepared = host.runtime.prepare({
		title: TEAM_TITLE,
		members: [
			{ alias: "lead", roleDescription: "Request the titled worker task.", model: "rail-team-local/probe", cwd: root, fastMode: false },
			{ alias: "w1", roleDescription: "Answer the local question.", model: "rail-team-local/probe", cwd: root, fastMode: false },
			{ alias: "w2", roleDescription: "Ask W1 for clarification, then deliver the dependency.", model: "rail-team-local/probe", cwd: root, fastMode: false },
		],
		lead: "lead", brief: { goal: "Verify Team titles and per-work token accounting with a real Pi worker." },
		initialRequests: [], timeoutSeconds: null, review: null,
	});
	const { teamId } = prepared;
	for (const memberId of ["lead", "w1", "w2"]) await host.driver.openMember({ teamId, memberId, model: MODEL, cwd: root });
	host.runtime.launch(teamId);
	// Keep management provider-free so every Team token belongs to an actual WorkRef.
	const boot = host.runtime.takeNextActivation(teamId)!;
	assert.equal(boot.input.scope.kind, "events");
	assert.equal(host.runtime.inputReady(boot.binding, boot.scope.activationId, boot.deliveryId).ok, true);
	const requested = host.runtime.handleAction(boot.binding, boot.scope, 1, "titled-request", {
		action: "request", to: "w1", title: WORK_TITLE, task: "W1 root", inputRefs: [],
	}, "titled-request");
	assert.equal(requested.ok, true, JSON.stringify(requested));
	const yielded = host.runtime.handleAction(boot.binding, boot.scope, 2, "boot-yield", { action: "yield" }, "boot-yield");
	assert.equal(yielded.ok, true, JSON.stringify(yielded));
	assert.equal(host.runtime.nativeSettled(boot.binding, boot.scope.activationId, { status: "success", appliedToolCallId: "boot-yield" }).ok, true);
	assert.equal(host.runtime.cleanupFinished(boot.binding, boot.scope.activationId, { ok: true }).ok, true);

	const runs: TeamActivationRun[] = [];
	for (let index = 0; index < 5; index++) {
		const run = await host.driver.runNext(teamId);
		assert.ok(run);
		assert.equal(run.activation.scope.kind, "work", "management events remain provider-free");
		assert.equal(run.completion.status, "success");
		assert.ok(run.completion.appliedToolCallId);
		assert.ok(run.completion.usage && run.completion.usage.input > 0 && run.completion.usage.output > 0, "real native provider events supplied nonzero usage");
		runs.push(run);
	}
	assert.equal(new Set(runs.map((run) => run.activation.scope.work!.workId)).size, 3, "three works span five native activations through yield/resume");

	assert.equal(prepared.title, TEAM_TITLE);
	assert.equal(host.runtime.getTeam(teamId).title, TEAM_TITLE);
	const works = host.runtime.listWorks(teamId);
	assert.equal(works.length, 3);
	assert.deepEqual(works.map((work) => work.title), [WORK_TITLE, CHILD_TITLE, CALLBACK_TITLE]);
	assert.ok(works.every((work) => work.state === "resolved"));
	const total = host.runtime.getTeam(teamId).usage;
	for (const counter of ["input", "output", "cacheRead", "cacheWrite", "turns", "cost"] as const) {
		const workTotal = works.reduce((sum, work) => sum + host.runtime.workStats(teamId, work.work).usage[counter], 0);
		assert.equal(workTotal, total[counter], `${counter}: per-work accounting equals the Team total`);
		const nativeTotal: number = runs.reduce((sum, run) => sum + run.completion.usage![counter], 0);
		assert.equal(workTotal, nativeTotal, `${counter}: each native activation is counted exactly once`);
	}
	for (const work of works) assert.ok(host.runtime.workStats(teamId, work.work).activeMs > 0);

	const component = new TeamOverlayComponent({ requestRender() {}, terminal: { rows: 40 } } as any,
		theme, { matches: (data: string, action: string) => bindings[action] === data } as any,
		() => undefined, host);
	t.after(() => component.dispose());
	const render = () => {
		const lines = component.render(73);
		for (const line of lines) assert.equal(visibleWidth(line), 73);
		return stripTerminalSequences(lines.join("\n"));
	};
	assert.match(render(), new RegExp(TEAM_TITLE, "u"));
	component.handleInput(keys.escape);
	assert.match(render(), new RegExp(TEAM_TITLE, "u"));
	component.handleInput(keys.enter);
	render();
	component.handleInput(keys.right);
	render();
	component.handleInput(keys.right);
	const tasks = render();
	assert.match(tasks, /\[Tasks\]/u);
	assert.match(tasks, new RegExp(WORK_TITLE, "u"));
	assert.match(tasks, new RegExp(CHILD_TITLE, "u"));
	component.handleInput(keys.down);
	component.handleInput(keys.down);
	render();
	component.handleInput(keys.enter);
	assert.match(render(), new RegExp(CALLBACK_TITLE, "u"));
});
