import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { FileAgentInstanceStore } from "../../tools/subagents/instance-store";
import { PiRpcProcessTransport } from "../../tools/subagents/rpc-transport";
import { RpcSessionWorker, buildRpcWorkerArgs } from "../../tools/subagents/rpc-worker";
import { SessionBroker, type AgentRoster, type SessionWorkerFactory } from "../../tools/subagents/session-broker";
import { runTeamCommand } from "../../tools/subagents/team-command";
import { restoreTeamHistory } from "../../tools/subagents/team-history";
import { TeamSessionHost } from "../../tools/subagents/team-host";
import { TEAM_JOURNAL_ENTRY_TYPE, type TeamJournalRecord } from "../../tools/subagents/team-journal";

const MODEL = { provider: "rail-team-local", modelId: "probe" };
const CLI = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const PROVIDER = fileURLToPath(new URL("../fixtures/team-v2-local-provider.mjs", import.meta.url));

class MemoryRoster implements AgentRoster {
	private readonly values = new Map<string, string>();
	resolve(target: string) { return this.values.get(target); }
	link(alias: string, agentId: string) { this.values.set(alias, agentId); }
	unlink(alias: string) { this.values.delete(alias); }
	list() { return [...this.values].map(([alias, agentId]) => ({ alias, agentId })); }
}

function history(records: TeamJournalRecord[]) {
	return restoreTeamHistory(records.map((data) => ({ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data })));
}

test("real Pi closed two-member Team deletion removes saved sessions, descriptors and links but keeps an unrelated alias", { timeout: 90000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "rail-team-delete-"));
	const oldAgentDir = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = root;
	t.after(() => {
		if (oldAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = oldAgentDir;
	});
	await mkdir(join(root, "rail-team"));
	await writeFile(join(root, "rail-team", "settings.json"), JSON.stringify({ version: 1, compactThreshold: null }));
	await writeFile(join(root, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
	const stateDir = join(root, "stateful-subagents");
	const store = new FileAgentInstanceStore(stateDir);
	const roster = new MemoryRoster();
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
				PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", TEAM_V2_SCENARIO: "close-loop",
			},
		});
		await transport.start();
		return RpcSessionWorker.connect(spec, transport);
	};
	const broker = new SessionBroker({ store, roster, workerFactory, defaultCwd: root });
	const records: TeamJournalRecord[] = [];
	const host = new TeamSessionHost(broker, (record) => records.push(record), []);
	t.after(async () => {
		try { await host.close(); }
		finally {
			try { await broker.shutdown(); }
			finally { await rm(root, { recursive: true, force: true }); }
		}
	});
	const { teamId } = host.runtime.prepare({
		members: [
			{ alias: "lead", roleDescription: "Accept the worker result and close the Team.", model: "rail-team-local/probe", cwd: root, fastMode: false },
			{ alias: "w1", roleDescription: "Return the assigned result.", model: "rail-team-local/probe", cwd: root, fastMode: false },
		],
		lead: "lead", brief: { goal: "Delete a real closed Team without deleting unrelated saved agents." },
		initialRequests: [], timeoutSeconds: null,
	});
	const members = [];
	for (const memberId of ["lead", "w1"]) {
		members.push((await host.driver.openMember({ teamId, memberId, model: MODEL, cwd: root })).instance);
	}
	const result = await host.driver.launch(teamId);
	assert.equal(result.lifecycle, "closed");
	assert.equal(result.outcome, "succeeded");
	assert.ok(result.members.every((member) => member.resourceState === "released"));
	assert.equal(history(records).teams.length, 1);
	for (const member of members) {
		assert.ok((await stat(member.sessionFile)).size > 0);
		assert.ok((await readFile(member.sessionFile, "utf8")).includes(teamId));
		assert.ok(await store.get(member.agentId));
		assert.equal(roster.resolve(member.alias), member.agentId);
	}

	const unrelated = await broker.dispatch({ alias: "unrelated", model: MODEL, task: "ordinary reopen marker", cwd: root });
	await broker.stop("unrelated");
	const unrelatedRecord = await store.get(unrelated.instance.agentId);
	const unrelatedSession = await readFile(unrelated.instance.sessionFile, "utf8");
	assert.equal(unrelatedSession.includes(teamId), false);
	const confirmations: Array<{ title: string; message: string }> = [];
	const notifications: Array<{ text: string; type: string }> = [];
	await runTeamCommand(host, `delete ${teamId.slice(0, 8)}`, {
		hasUI: true, mode: "rpc",
		ui: {
			confirm: async (title: string, message: string) => { confirmations.push({ title, message }); return true; },
			notify: (text: string, type: string) => notifications.push({ text, type }),
		},
	} as any);
	assert.equal(confirmations.length, 1);
	assert.ok(confirmations[0]!.message.includes(teamId));
	for (const member of members) {
		assert.ok(confirmations[0]!.message.includes(member.alias));
		await assert.rejects(readFile(member.sessionFile), { code: "ENOENT" });
		await assert.rejects(readFile(join(stateDir, "instances", `${member.agentId}.json`)), { code: "ENOENT" });
		assert.equal(await store.get(member.agentId), undefined);
		assert.equal(roster.resolve(member.alias), undefined);
	}
	assert.match(confirmations[0]!.message, /Kept: the main conversation/u);
	assert.equal(records.at(-1)?.kind, "deleted");
	assert.equal(history(records).teams.length, 0);
	assert.equal(host.runtime.listTeams().length, 0);
	assert.equal(host.history.teams.length, 0);
	assert.deepEqual(await store.list(), [unrelatedRecord]);
	assert.deepEqual(await store.get(unrelated.instance.agentId), unrelatedRecord);
	assert.equal(await readFile(unrelated.instance.sessionFile, "utf8"), unrelatedSession);
	assert.deepEqual(roster.list(), [{ alias: "unrelated", agentId: unrelated.instance.agentId }]);
	assert.equal(notifications.some((notice) => notice.type === "error"), false);
});
