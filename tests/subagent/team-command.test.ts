import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installTeamCommand, runTeamCommand } from "../../tools/subagents/team-command";
import { SessionBroker, type AgentInstance, type AgentInstanceStore, type AgentRoster } from "../../tools/subagents/session-broker";
import { TeamSessionHost } from "../../tools/subagents/team-host";
import { formatBytes } from "../../tools/subagents/team-tool";
import { TEAM_JOURNAL_ENTRY_TYPE } from "../../tools/subagents/team-journal";
import type { TeamJournalRecord } from "../../tools/subagents/team-journal";
import type { TeamOverlayComponent } from "../../tools/subagents/team-overlay";

function setup(initialRequests: Array<{ to: string; task: string }> = [], budget?: "standard" | "long" | "unlimited") {
	const saved: AgentInstance[] = [];
	const broker = { assertAliasesAvailable: async () => undefined, listSaved: async () => saved } as unknown as SessionBroker;
	const host = new TeamSessionHost(broker, () => undefined, []);
	const prepared = host.runtime.prepare({
		members: [{ alias: "lead", roleDescription: "Manage the Team." }, { alias: "worker", roleDescription: "Complete assigned work." }], lead: "lead",
		brief: { goal: "Run host-control tests." }, initialRequests, timeoutSeconds: null, ...(budget ? { budget } : {}),
	});
	return { host, teamId: prepared.teamId, saved };
}

function commandContext(options: { hasUI?: boolean; mode?: "tui" | "rpc"; confirmation?: boolean; overlayKey?: string; message?: string } = {}) {
	const notifications: Array<{ text: string; type: string }> = [];
	const confirmations: Array<{ title: string; message: string }> = [];
	const overlays: Array<{ output: string; options: any; disposed: boolean }> = [];
	const ctx = {
		hasUI: options.hasUI ?? true,
		mode: options.mode ?? "tui",
		ui: {
			notify: (text: string, type: string) => notifications.push({ text, type }),
			confirm: async (title: string, message: string) => { confirmations.push({ title, message }); return options.confirmation ?? true; },
			select: async (_title: string, choices: string[]) => choices[0],
			input: async () => options.message,
			custom: async (factory: any, overlayOptions: any) => {
				let result: unknown;
				let component: TeamOverlayComponent;
				const record = { output: "", options: overlayOptions, disposed: false };
				component = factory({ requestRender: () => undefined, terminal: { rows: 40 } },
					{ fg: (_color: string, text: string) => text, bold: (text: string) => text }, { matches: () => false },
					(value: unknown) => { result = value; component.dispose(); record.disposed = true; });
				record.output = component.render(100).join("\n");
				overlays.push(record);
				component.handleInput(options.overlayKey ?? "\x1b");
				return result;
			},
		},
	};
	return { ctx: ctx as any, notifications, confirmations, overlays };
}

async function deletionFixture(t: TestContext, options: { reused?: boolean; fail?: boolean } = {}) {
	const dir = await mkdtemp(join(tmpdir(), "rail-team-delete-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const teamId = "history-delete-team";
	const saved: AgentInstance[] = [];
	for (const alias of ["lead", "worker"]) {
		const sessionFile = join(dir, `${alias}.jsonl`);
		await writeFile(sessionFile, JSON.stringify({ teamId: options.reused && alias === "worker" ? "unrelated-team" : teamId }));
		saved.push({ version: 2, agentId: `agent-${alias}`, alias, model: { provider: "local", modelId: "test" }, sessionId: alias,
			sessionFile, cwd: dir, createdAt: new Date(1).toISOString(), updatedAt: new Date(30).toISOString(), lastTask: "test" });
	}
	let fail = options.fail;
	const removed: string[] = [];
	const records: TeamJournalRecord[] = [];
	const broker = {
		listSaved: async () => saved,
		delete: async (agentId: string) => {
			if (fail && agentId === "agent-worker") throw new Error("test deletion failure");
			const index = saved.findIndex((instance) => instance.agentId === agentId);
			if (index < 0) return undefined;
			const instance = saved[index]!;
			await rm(instance.sessionFile);
			saved.splice(index, 1);
			removed.push(agentId);
			return instance;
		},
	} as unknown as SessionBroker;
	const branch = [
		{ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data: { version: 2, kind: "launched", teamId, at: 1,
			roster: { lead: "lead", members: ["lead", "worker"] }, goal: "Delete only this Team's saved sessions" } },
		{ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data: { version: 2, kind: "interrupted", teamId, at: 20, reason: "Session ended" } },
	];
	const host = new TeamSessionHost(broker, (record) => records.push(record), branch);
	return { host, teamId, saved, removed, records, retry: () => { fail = false; } };
}

test("delete rejects prepared, active and ended Teams with unreleased members before confirmation", async () => {
	const { host, teamId } = setup();
	const ui = commandContext();
	await assert.rejects(runTeamCommand(host, `delete ${teamId}`, ui.ctx), /cancel it first/u);
	host.runtime.launch(teamId);
	await assert.rejects(runTeamCommand(host, `delete ${teamId}`, ui.ctx), /cancel it first/u);
	host.runtime.cancelTeam(teamId, "Not released yet");
	await assert.rejects(runTeamCommand(host, `delete ${teamId}`, ui.ctx), /cancel it first/u);
	assert.equal(ui.confirmations.length, 0);
});

test("delete confirms goals, verified aliases, sizes, later-use warning and keeping the main conversation", async (t) => {
	const fixture = await deletionFixture(t);
	const sessions = await fixture.host.memberSessions(fixture.teamId, ["lead", "worker"]);
	const total = [...sessions.values()].reduce((bytes, session) => bytes + session.size, 0);
	assert.equal(sessions.get("worker")!.instance!.model.provider, "local");
	const declined = commandContext({ confirmation: false });
	await runTeamCommand(fixture.host, "delete history-delete", declined.ctx);
	assert.match(declined.confirmations[0]!.message, /history-delete-team · Delete only/u);
	assert.match(declined.confirmations[0]!.message, /lead · [\d.]+ (B|KB)/u);
	assert.match(declined.confirmations[0]!.message, /worker · [\d.]+ (B|KB)/u);
	assert.ok(declined.confirmations[0]!.message.includes(`Total size: ${formatBytes(total)}`));
	assert.match(declined.confirmations[0]!.message, /WARNING: used after the Team ended/u);
	assert.match(declined.confirmations[0]!.message, /Kept: the main conversation/u);
	assert.deepEqual(fixture.removed, []);
	await assert.rejects(runTeamCommand(fixture.host, `delete ${fixture.teamId}`, commandContext({ hasUI: false }).ctx), /interactive confirmation/u);
	const ui = commandContext();
	await runTeamCommand(fixture.host, `delete ${fixture.teamId}`, ui.ctx);
	assert.deepEqual(fixture.removed, ["agent-lead", "agent-worker"]);
	assert.equal(fixture.records.length, 1);
	assert.equal(fixture.records[0]!.kind, "deleted");
	assert.equal(fixture.host.history.teams.length, 0);
	assert.match(ui.notifications[0]!.text, /Member sessions removed: 2/u);
	assert.ok(ui.notifications[0]!.text.includes(`freed ${formatBytes(total)}`));
	assert.equal((await fixture.host.memberSessions(fixture.teamId, ["worker"])).get("worker")!.reason, "already deleted");
});

test("delete skips a reused alias whose saved session belongs to another Team", async (t) => {
	const fixture = await deletionFixture(t, { reused: true });
	const unrelated = fixture.saved[1]!;
	const text = await readFile(unrelated.sessionFile, "utf8");
	const ui = commandContext();
	await runTeamCommand(fixture.host, `delete ${fixture.teamId}`, ui.ctx);
	assert.deepEqual(fixture.removed, ["agent-lead"]);
	assert.deepEqual(fixture.saved, [unrelated]);
	assert.equal(await readFile(unrelated.sessionFile, "utf8"), text);
	assert.match(ui.notifications[0]!.text, /Skipped worker: not this Team's session/u);
	assert.equal(fixture.host.history.teams.length, 0);
});

test("partial deletion writes no marker; retry skips the gone member and finishes", async (t) => {
	const fixture = await deletionFixture(t, { fail: true });
	const ui = commandContext();
	await runTeamCommand(fixture.host, `delete ${fixture.teamId}`, ui.ctx);
	assert.deepEqual(fixture.removed, ["agent-lead"]);
	assert.deepEqual(fixture.records, []);
	assert.equal(fixture.host.history.teams.length, 1);
	assert.equal(ui.notifications[0]!.type, "error");
	assert.match(ui.notifications[0]!.text, /test deletion failure; retry/u);
	fixture.retry();
	await runTeamCommand(fixture.host, `delete ${fixture.teamId}`, ui.ctx);
	assert.deepEqual(fixture.removed, ["agent-lead", "agent-worker"]);
	assert.equal(fixture.records.length, 1);
	assert.equal(fixture.host.history.teams.length, 0);
	assert.match(ui.notifications.at(-1)!.text, /Skipped lead: already deleted/u);
});

test("retry real broker deletion after rm succeeds but store.delete fails removes the descriptor and roster", async (t) => {
	const fixture = await deletionFixture(t);
	const instances = new Map(fixture.saved.map((instance) => [instance.agentId, instance]));
	const links = new Map(fixture.saved.map((instance) => [instance.alias, instance.agentId]));
	links.set("worker-link", "agent-worker");
	let fail = true;
	const store: AgentInstanceStore = {
		get: async (id) => instances.get(id),
		put: async (instance) => { instances.set(instance.agentId, instance); },
		list: async () => [...instances.values()],
		delete: async (id) => { if (fail && id === "agent-worker") throw new Error("store.delete failed after rm"); instances.delete(id); },
	};
	const roster: AgentRoster = {
		resolve: (alias) => links.get(alias),
		link: (alias, id) => { links.set(alias, id); },
		unlink: (alias) => { links.delete(alias); },
		list: () => [...links].map(([alias, agentId]) => ({ alias, agentId })),
	};
	const broker = new SessionBroker({ store, roster, workerFactory: async () => { throw new Error("Deletion must not start a worker"); } });
	const history = fixture.host.history.teams[0]!;
	const records: TeamJournalRecord[] = [];
	const host = new TeamSessionHost(broker, (record) => records.push(record), [
		{ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data: { version: 2, kind: "launched", teamId: history.teamId,
			at: history.startedAt, roster: { lead: history.lead, members: history.members }, goal: history.goal } },
		{ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data: { version: 2, kind: "interrupted", teamId: history.teamId,
			at: history.at, reason: history.reason } },
	]);
	const workerFile = instances.get("agent-worker")!.sessionFile;
	const ui = commandContext();
	await runTeamCommand(host, `delete ${history.teamId}`, ui.ctx);
	await assert.rejects(readFile(workerFile), { code: "ENOENT" });
	assert.ok(instances.has("agent-worker"));
	assert.equal(links.get("worker-link"), "agent-worker");
	assert.equal(records.length, 0);
	assert.equal(host.history.teams.length, 1);
	fail = false;
	await runTeamCommand(host, `delete ${history.teamId}`, ui.ctx);
	assert.equal(instances.size, 0);
	assert.equal(links.size, 0);
	assert.equal(records.length, 1);
	assert.equal(records[0]!.kind, "deleted");
	assert.equal(host.history.teams.length, 0);
});

test("a missing session file is skipped when its alias was created outside the Team's run window", async (t) => {
	const fixture = await deletionFixture(t);
	await rm(fixture.saved[1]!.sessionFile);
	// The Team ran from 1 to 20 ms; a later reuse of the alias is not its member.
	fixture.saved[1]!.createdAt = new Date(120_000).toISOString();
	const sessions = await fixture.host.memberSessions(fixture.teamId, ["worker"]);
	assert.equal(sessions.get("worker")!.instance, undefined);
	assert.equal(sessions.get("worker")!.reason, "already deleted");
	const ui = commandContext();
	await runTeamCommand(fixture.host, `delete ${fixture.teamId}`, ui.ctx);
	assert.deepEqual(fixture.removed, ["agent-lead"]);
	assert.deepEqual(fixture.saved.map((instance) => instance.agentId), ["agent-worker"]);
	assert.match(ui.notifications[0]!.text, /Skipped worker: already deleted/u);
});

test("delete removes a never-run member's instance record and link although it has no session file", async (t) => {
	const fixture = await deletionFixture(t);
	await rm(fixture.saved[1]!.sessionFile);
	const instances = new Map(fixture.saved.map((instance) => [instance.agentId, instance]));
	const links = new Map(fixture.saved.map((instance) => [instance.alias, instance.agentId]));
	const store: AgentInstanceStore = {
		get: async (id) => instances.get(id), put: async (instance) => { instances.set(instance.agentId, instance); },
		list: async () => [...instances.values()], delete: async (id) => { instances.delete(id); },
	};
	const roster: AgentRoster = {
		resolve: (alias) => links.get(alias), link: (alias, id) => { links.set(alias, id); }, unlink: (alias) => { links.delete(alias); },
		list: () => [...links].map(([alias, agentId]) => ({ alias, agentId })),
	};
	const broker = new SessionBroker({ store, roster, workerFactory: async () => { throw new Error("Deletion must not start a worker"); } });
	const history = fixture.host.history.teams[0]!;
	const records: TeamJournalRecord[] = [];
	const host = new TeamSessionHost(broker, (record) => records.push(record), [
		{ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data: { version: 2, kind: "launched", teamId: history.teamId,
			at: history.startedAt, roster: { lead: history.lead, members: history.members }, goal: history.goal } },
		{ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data: { version: 2, kind: "interrupted", teamId: history.teamId, at: history.at, reason: history.reason } },
	]);
	const sessions = await host.memberSessions(history.teamId, ["worker"]);
	assert.equal(sessions.get("worker")!.instance!.agentId, "agent-worker");
	assert.equal(sessions.get("worker")!.size, 0);
	const ui = commandContext();
	await runTeamCommand(host, `delete ${history.teamId}`, ui.ctx);
	assert.match(ui.confirmations[0]!.message, /worker · 0 B/u);
	assert.equal(instances.size, 0);
	assert.equal(links.size, 0);
	assert.match(ui.notifications[0]!.text, /Member sessions removed: 2/u);
	assert.equal(records.length, 1);
	assert.equal(host.history.teams.length, 0);
});

test("a never-run member of a live Team is deletable only when its instance was created during the Team's run", async () => {
	const { host, teamId, saved } = setup();
	host.runtime.launch(teamId);
	const dir = join(tmpdir(), "rail-team-never-run-missing");
	const instance = (alias: string, createdAt: number): AgentInstance => ({ version: 2, agentId: `agent-${alias}`, alias, model: { provider: "local", modelId: "test" },
		sessionId: alias, sessionFile: join(dir, `${alias}.jsonl`), cwd: dir, createdAt: new Date(createdAt).toISOString(), updatedAt: new Date(createdAt).toISOString(), lastTask: "test" });
	saved.push(instance("lead", Date.now() - 1000), instance("worker", Date.now() - 2 * 3600_000));
	const sessions = await host.memberSessions(teamId, ["lead", "worker"]);
	assert.equal(sessions.get("lead")!.instance!.agentId, "agent-lead");
	assert.equal(sessions.get("worker")!.reason, "already deleted");
});

test("popup d closes the overlay before the shared delete confirmation and honors rejection", async (t) => {
	const fixture = await deletionFixture(t);
	const ui = commandContext({ overlayKey: "d", confirmation: false });
	const confirm = ui.ctx.ui.confirm;
	ui.ctx.ui.confirm = async (title: string, message: string) => {
		assert.equal(ui.overlays[0]!.disposed, true);
		return confirm(title, message);
	};
	await runTeamCommand(fixture.host, "", ui.ctx);
	assert.equal(ui.confirmations.length, 1);
	assert.match(ui.confirmations[0]!.message, /Kept: the main conversation/u);
	assert.deepEqual(fixture.removed, []);
	assert.equal(fixture.host.history.teams.length, 1);
});

test("delete IDs validate the complete selection before any deletion", async (t) => {
	const fixture = await deletionFixture(t);
	fixture.host.history.teams.push({ ...fixture.host.history.teams[0]!, teamId: "history-delete-other" });
	const ui = commandContext();
	await assert.rejects(runTeamCommand(fixture.host, "delete history-delete", ui.ctx), /Ambiguous teamId/u);
	await assert.rejects(runTeamCommand(fixture.host, `delete ${fixture.teamId} unknown`, ui.ctx), /Unknown teamId/u);
	assert.equal(ui.confirmations.length, 0);
	assert.deepEqual(fixture.removed, []);
	await runTeamCommand(fixture.host, "delete history-delete-team history-delete-other", ui.ctx);
	assert.equal(ui.confirmations.length, 1);
	assert.equal(fixture.host.history.teams.length, 0);
	assert.equal(fixture.records.length, 2);
});

test("delete ended selects history and released ended runtime Teams, preserves prepared/active and completes IDs", async (t) => {
	const fixture = await deletionFixture(t);
	const prepare = (lead: string, worker: string) => fixture.host.runtime.prepare({ members: [{ alias: lead, roleDescription: "Lead" },
		{ alias: worker, roleDescription: "Worker" }], lead, brief: { goal: "Local Team" }, initialRequests: [], timeoutSeconds: null }).teamId;
	const ended = prepare("ended-lead", "ended-worker");
	fixture.host.runtime.cancelTeam(ended, "Never launched");
	const prepared = prepare("prepared-lead", "prepared-worker");
	const active = prepare("active-lead", "active-worker");
	fixture.host.runtime.launch(active);
	let command: any;
	installTeamCommand({ registerCommand: (_name: string, value: any) => { command = value; } } as any, () => fixture.host);
	assert.ok(command.getArgumentCompletions("del").some((item: any) => item.label === "delete"));
	assert.ok(command.getArgumentCompletions("delete ").some((item: any) => item.label === fixture.teamId));
	assert.ok(command.getArgumentCompletions(`delete ${fixture.teamId} `).some((item: any) => item.label === ended));
	const ui = commandContext();
	await runTeamCommand(fixture.host, "delete ended", ui.ctx);
	assert.deepEqual(fixture.host.runtime.listTeams().map((team) => team.teamId), [prepared, active]);
	assert.equal(fixture.host.history.teams.length, 0);
	assert.equal(fixture.records.filter((record) => record.kind === "deleted").length, 2);
	assert.equal(ui.confirmations.length, 1);
	assert.doesNotMatch(ui.confirmations[0]!.message, new RegExp(prepared, "u"));
	assert.doesNotMatch(ui.confirmations[0]!.message, new RegExp(active, "u"));
});

test("compact completes open aliases, confirms instructions and reports the immediate receipt", async () => {
	const { host, teamId } = setup();
	host.runtime.launch(teamId);
	let command: any;
	installTeamCommand({ registerCommand: (_name: string, value: any) => { command = value; } } as any, () => host);
	assert.deepEqual(command.getArgumentCompletions(`${teamId} compact `).map((item: any) => item.label), ["lead", "worker"]);
	const calls: unknown[][] = [];
	host.runtime.compactMember = (...args) => { calls.push(args); return { actor: "@host", status: "applied", teamId, memberId: args[1], compaction: "scheduled" }; };
	const declined = commandContext({ confirmation: false });
	await runTeamCommand(host, `${teamId} compact worker keep decisions`, declined.ctx);
	assert.deepEqual(calls, []);
	const ui = commandContext();
	await runTeamCommand(host, `${teamId} compact worker keep decisions`, ui.ctx);
	assert.deepEqual(calls, [[teamId, "worker", "keep decisions"]]);
	assert.match(ui.confirmations[0]!.message, /keep decisions/u);
	assert.match(ui.notifications.at(-1)!.text, /worker compaction scheduled/u);
	await runTeamCommand(host, `${teamId} compact lead`, ui.ctx);
	assert.deepEqual(calls[1], [teamId, "lead", undefined]);
	await assert.rejects(runTeamCommand(host, `${teamId} compact`, ui.ctx), /requires a member alias/u);
	await assert.rejects(runTeamCommand(host, `${teamId} compact worker ${"保".repeat(683)}`, ui.ctx), /2 KiB/u);
	assert.equal(calls.length, 2);
});

test("popup z outside Members chooses an open member then confirms compaction", async () => {
	const { host, teamId } = setup();
	host.runtime.launch(teamId);
	const calls: unknown[][] = [];
	host.runtime.compactMember = (...args) => { calls.push(args); return { actor: "@host", status: "applied", teamId, memberId: args[1], compaction: "started" }; };
	const ui = commandContext({ overlayKey: "z" });
	ui.ctx.ui.select = async (title: string, aliases: string[]) => {
		assert.match(title, /Compact which member/u);
		assert.deepEqual(aliases, ["lead", "worker"]);
		return "worker";
	};
	await runTeamCommand(host, "", ui.ctx);
	assert.deepEqual(calls, [[teamId, "worker", undefined]]);
	assert.match(ui.confirmations[0]!.title, /Compact worker/u);
	assert.match(ui.notifications.at(-1)!.text, /compaction started/u);
});

test("rail-team registers ID/subcommand completion and prints every root budget", async () => {
	const { host, teamId } = setup([{ to: "worker", task: "root one" }, { to: "worker", task: "root two" }]);
	let command: any;
	installTeamCommand({ registerCommand: (name: string, value: any) => { assert.equal(name, "rail-team"); command = value; } } as any, () => host);
	assert.ok(command.getArgumentCompletions(`${teamId} sta`).some((item: any) => item.label === "status"));
	assert.ok(command.getArgumentCompletions("li").some((item: any) => item.value === "list"));

	const { ctx, notifications } = commandContext();
	await runTeamCommand(host, `${teamId} budget`, ctx);
	const output = notifications.at(-1)?.text ?? "";
	const budget = host.runtime.inspectBudget(teamId);
	assert.match(output, /Team .* budget/u);
	assert.match(output, /teamModelRequests: 0\//u);
	assert.match(output, /Roots \(2\)/u);
	for (const root of budget.roots) assert.ok(output.includes(root.rootId), `missing root ${root.rootId}`);
	assert.match(output, /activations 0\//u);
});

test("budget prints unlimited instead of the raw sentinel limit", async () => {
	const { host, teamId } = setup([{ to: "worker", task: "root one" }], "unlimited");
	const { ctx, notifications } = commandContext();
	await runTeamCommand(host, `${teamId} budget`, ctx);
	const output = notifications.at(-1)?.text ?? "";
	assert.match(output, /teamModelRequests: 0\/unlimited/u);
	assert.match(output, /activations 0\/unlimited/u);
	assert.doesNotMatch(output, /\/\d{6,}/u);
});

test("budget grants show exact impacts and require confirmation; headless UI cannot mutate", async () => {
	const { host, teamId } = setup();
	host.runtime.launch(teamId);
	const before = host.runtime.inspectBudget(teamId);
	const noUi = commandContext({ hasUI: false });
	await assert.rejects(runTeamCommand(host, `${teamId} grant team teamToolCalls=+3 because the user approved it`, noUi.ctx), /needs interactive confirmation/u);
	assert.deepEqual(host.runtime.inspectBudget(teamId), before);

	const { ctx, confirmations, notifications } = commandContext();
	await runTeamCommand(host, `${teamId} grant team teamToolCalls=+3 because the user approved it`, ctx);
	assert.equal(confirmations.length, 1);
	assert.match(confirmations[0]!.message, /teamToolCalls: used 0 · limit \d+ → \d+/u);
	assert.match(confirmations[0]!.message, /Reason: because the user approved it/u);
	assert.match(confirmations[0]!.message, /Usage never resets/u);
	const after = host.runtime.inspectBudget(teamId);
	assert.equal(after.limits.teamToolCalls, before.limits.teamToolCalls + 3);
	assert.equal(after.grants.length, 1);
	assert.match(notifications.at(-1)?.text ?? "", /Budget granted/u);
});

test("host messages are confirmed and become explicitly attributed Manager events", async () => {
	const { host, teamId } = setup();
	host.runtime.launch(teamId);
	const { ctx, confirmations, notifications } = commandContext();
	await runTeamCommand(host, `${teamId} message Recheck the evidence before closing.`, ctx);
	assert.equal(confirmations.length, 1);
	assert.match(confirmations[0]!.message, /grants no budget or tool permission/u);
	const activation = host.runtime.takeNextActivation(teamId);
	assert.equal(activation?.scope.kind, "events");
	const events = activation?.input.scope.kind === "events" ? activation.input.scope.events : [];
	const event = events.find((item) => item.kind === "USER_COMMAND");
	assert.equal(event?.actor, "@host");
	assert.equal(event?.message, "Recheck the evidence before closing.");
	assert.match(notifications.at(-1)?.text ?? "", /Lead message applied/u);
});

test("/rail-team lead hands the Team to another member after confirmation and completes member aliases", async () => {
	const { host, teamId } = setup();
	host.runtime.launch(teamId);
	let command: any;
	installTeamCommand({ registerCommand: (_name: string, value: any) => { command = value; } } as any, () => host);
	assert.ok(command.getArgumentCompletions(`${teamId} le`).some((item: any) => item.label === "lead"));
	assert.deepEqual(command.getArgumentCompletions(`${teamId} lead `).map((item: any) => item.label), ["worker"], "only members other than the lead");

	const declined = commandContext({ confirmation: false });
	await runTeamCommand(host, `${teamId} lead worker`, declined.ctx);
	assert.equal(host.runtime.getTeam(teamId).lead, "lead");

	const { ctx, notifications, confirmations } = commandContext();
	await runTeamCommand(host, `${teamId} lead worker Rotating the lead`, ctx);
	assert.match(confirmations[0]!.title, /Make worker the lead/u);
	assert.equal(host.runtime.getTeam(teamId).lead, "worker");
	assert.match(notifications.at(-1)?.text ?? "", /worker is now the lead/u);
	const events = host.runtime.takeNextActivation(teamId)!;
	assert.equal(events.binding.memberId, "worker");
	assert.ok(events.input.scope.kind === "events" && events.input.scope.events.some((event) => event.message === "Host made you the Team lead: Rotating the lead"));
	await assert.rejects(runTeamCommand(host, `${teamId} lead`, ctx), /requires a member alias/u);
	await assert.rejects(runTeamCommand(host, `${teamId} lead lead`, ctx), /Team events/u, "refused while worker handles events");
});

test("cancel of a prepared Team is explicitly confirmed and closes resources without a provider", async () => {
	const { host, teamId } = setup([{ to: "worker", task: "never started" }]);
	const noUi = commandContext({ hasUI: false });
	await assert.rejects(runTeamCommand(host, `${teamId} cancel`, noUi.ctx), /needs interactive confirmation/u);
	assert.equal(host.runtime.getTeam(teamId).lifecycle, "prepared");

	const { ctx, confirmations, notifications } = commandContext();
	await runTeamCommand(host, `${teamId} cancel host test cancellation`, ctx);
	assert.equal(confirmations.length, 1);
	assert.equal(host.runtime.getTeam(teamId).lifecycle, "cancelled");
	assert.ok(host.runtime.getTeam(teamId).members.every((member) => member.resourceState === "released"));
	assert.match(notifications.at(-1)?.text ?? "", /all member exits are confirmed/u);
});

test("no arguments opens the Team popup in the TUI; RPC, headless and explicit list keep text output", async () => {
	const { host, teamId } = setup();
	const interactive = commandContext();
	await runTeamCommand(host, "", interactive.ctx);
	assert.equal(interactive.overlays.length, 1);
	assert.equal(interactive.overlays[0]!.options.overlay, true);
	assert.equal(interactive.overlays[0]!.options.overlayOptions.width, "92%");
	assert.match(interactive.overlays[0]!.output, /\[Overview\]/u);
	assert.equal(interactive.notifications.length, 0);
	for (const [args, options] of [["", { hasUI: false, mode: "rpc" }], ["", { mode: "rpc" }], ["list", {}]] as const) {
		const context = commandContext(options);
		await runTeamCommand(host, args, context.ctx);
		assert.equal(context.overlays.length, 0);
		assert.ok(context.notifications[0]!.text.includes(teamId));
	}
});

test("popup cancel closes before the existing confirmation and respects rejection", async () => {
	for (const confirmation of [false, true]) {
		const { host, teamId } = setup();
		const context = commandContext({ overlayKey: "c", confirmation });
		const confirm = context.ctx.ui.confirm;
		context.ctx.ui.confirm = async (title: string, message: string) => {
			assert.equal(context.overlays[0]!.disposed, true);
			return confirm(title, message);
		};
		await runTeamCommand(host, "", context.ctx);
		assert.equal(context.confirmations.length, 1);
		assert.equal(context.confirmations[0]!.title, `Cancel Team ${teamId}?`);
		assert.equal(host.runtime.getTeam(teamId).lifecycle, confirmation ? "cancelled" : "prepared");
	}
});

test("popup message gathers text then uses existing confirmation, or cancels without mutation", async () => {
	const { host, teamId } = setup();
	host.runtime.launch(teamId);
	const cancelled = commandContext({ overlayKey: "m" });
	await runTeamCommand(host, "", cancelled.ctx);
	assert.equal(cancelled.confirmations.length, 0);
	const context = commandContext({ overlayKey: "m", message: "Review this work" });
	await runTeamCommand(host, "", context.ctx);
	assert.equal(context.confirmations.length, 1);
	assert.match(context.confirmations[0]!.message, /Review this work/u);
	assert.match(context.notifications[0]!.text, /Lead message applied/u);
});

test("popup resume and grant enter the existing selection paths", async () => {
	const { host, teamId } = setup();
	host.runtime.launch(teamId);
	const resume = commandContext({ overlayKey: "r" });
	await runTeamCommand(host, "", resume.ctx);
	assert.match(resume.notifications[0]!.text, /has no held work/u);
	const grant = commandContext({ overlayKey: "g" });
	let title = "";
	grant.ctx.ui.select = async (value: string) => { title = value; return undefined; };
	await runTeamCommand(host, "", grant.ctx);
	assert.equal(title, "Raise Team budget");
	assert.equal(grant.confirmations.length, 0);
});

test("interactive grants offer only higher presets, confirm their preview, and retain the custom flow", async () => {
	const { host, teamId } = setup([], "standard");
	host.runtime.launch(teamId);
	for (const preset of ["long", "unlimited"] as const) {
		const { ctx, confirmations } = commandContext();
		ctx.ui.select = async (title: string, choices: string[]) => {
			assert.equal(title, "Raise Team budget");
			assert.deepEqual(choices, preset === "long" ? ["Raise to long", "Raise to unlimited", "Custom grant…"] : ["Raise to unlimited", "Custom grant…"]);
			return `Raise to ${preset}`;
		};
		await runTeamCommand(host, `${teamId} grant`, ctx);
		assert.match(confirmations[0]!.message, /teamWorks: used 0 · limit \d+ → \d+/u);
		assert.match(confirmations[0]!.message, /Releases no held work/u);
		assert.equal(host.runtime.inspectBudget(teamId).limits.teamActivations, preset === "long" ? 4096 : 1_000_000_000);
	}
	const custom = commandContext({ message: "approved" });
	let selected = 0;
	custom.ctx.ui.select = async (_title: string, choices: string[]) => {
		assert.deepEqual(choices, selected++ === 0 ? ["Custom grant…"] : ["team"]);
		return choices[0];
	};
	custom.ctx.ui.input = async (title: string) => title.startsWith("Increments") ? "teamActivations=+64" : "approved";
	await runTeamCommand(host, `${teamId} grant`, custom.ctx);
	assert.equal(selected, 2);
	assert.equal(host.runtime.inspectBudget(teamId).limits.teamActivations, 1_000_000_064);
	assert.match(custom.confirmations[0]!.message, /limit unlimited → unlimited/u);
});

test("declining a preset confirmation leaves all limits and grants unchanged", async () => {
	const { host, teamId } = setup([], "standard");
	host.runtime.launch(teamId);
	const before = host.runtime.inspectBudget(teamId);
	const { ctx, confirmations } = commandContext({ confirmation: false });
	await runTeamCommand(host, `${teamId} grant`, ctx);
	assert.equal(confirmations.length, 1);
	assert.match(confirmations[0]!.message, /Reason: Raise to long/u);
	assert.deepEqual(host.runtime.inspectBudget(teamId), before);
});

test("review command: now, every (with or without by), off and the bare status, each confirmed; bad forms and the lead are refused", async () => {
	const { host, teamId } = setup([{ to: "worker", task: "root" }]);
	host.runtime.launch(teamId);
	let command: any;
	installTeamCommand({ registerCommand: (_name: string, value: any) => { command = value; } } as any, () => host);
	const labels = (prefix: string) => command.getArgumentCompletions(prefix)?.map((item: any) => item.value);
	assert.ok(labels(`${teamId} rev`).includes(`${teamId} review`));
	assert.deepEqual(labels(`${teamId} review `), [`${teamId} review now`, `${teamId} review every`, `${teamId} review off`]);
	assert.deepEqual(labels(`${teamId} review every 30 `), [`${teamId} review every 30 by`]);
	assert.deepEqual(labels(`${teamId} review every 30 by `), [`${teamId} review every 30 by worker`], "the lead is not offered");

	const bare = commandContext();
	await runTeamCommand(host, `${teamId} review`, bare.ctx);
	assert.equal(bare.notifications.at(-1)!.text, "Review: off");

	const every = commandContext();
	await runTeamCommand(host, `${teamId} review every 30 by worker`, every.ctx);
	assert.match(every.confirmations[0]!.message, /worker reviews the Team's progress and advises the lead; it cannot request or control work/u);
	assert.deepEqual(host.runtime.reviewSchedule(teamId), { by: "worker", everyMinutes: 30, nextAt: host.runtime.reviewSchedule(teamId)!.nextAt });
	assert.match(every.notifications.at(-1)!.text, /Review set: every 30 min/u);
	await runTeamCommand(host, `${teamId} review every 15`, commandContext().ctx);
	assert.deepEqual(host.runtime.reviewSchedule(teamId), { by: "worker", everyMinutes: 15, nextAt: host.runtime.reviewSchedule(teamId)!.nextAt }, "without by the reviewer stays");
	await runTeamCommand(host, `${teamId} review`, bare.ctx);
	assert.equal(bare.notifications.at(-1)!.text, "Review: worker every 15 min");

	const declined = commandContext({ confirmation: false });
	await runTeamCommand(host, `${teamId} review now`, declined.ctx);
	assert.equal(host.runtime.listWorks(teamId).some((work) => work.kind === "review"), false);
	const now = commandContext();
	await runTeamCommand(host, `${teamId} review now`, now.ctx);
	assert.ok(host.runtime.listWorks(teamId).some((work) => work.kind === "review" && work.assignee === "worker"));
	assert.match(now.notifications.at(-1)!.text, /Review work:\S+@1 started/u);
	await assert.rejects(runTeamCommand(host, `${teamId} review now`, commandContext().ctx), /a review is still open/u);

	for (const bad of ["review every", "review every 0", "review every 5m", "review every 5 worker", "review every 5 by", "review soon", "review now now"]) {
		await assert.rejects(runTeamCommand(host, `${teamId} ${bad}`, commandContext().ctx), /Usage: \/rail-team .* review \[now\|every <N> \[by <alias>\]\|off\]/u, bad);
	}
	await assert.rejects(runTeamCommand(host, `${teamId} review every 5 by lead`, commandContext().ctx), /other than the lead/u);
	await assert.rejects(runTeamCommand(host, `${teamId} review off`, commandContext({ hasUI: false }).ctx), /needs interactive confirmation/u);
	assert.ok(host.runtime.reviewSchedule(teamId));
	const off = commandContext();
	await runTeamCommand(host, `${teamId} review off`, off.ctx);
	assert.equal(host.runtime.reviewSchedule(teamId), undefined);
	assert.match(off.notifications.at(-1)!.text, /Review stopped/u);
	await assert.rejects(runTeamCommand(host, `${teamId} review now`, commandContext().ctx), /no reviewer is set/u);

	host.runtime.cancelTeam(teamId, "done");
	await assert.rejects(runTeamCommand(host, `${teamId} review every 5`, commandContext().ctx), /Team .* is cancelled; its review cannot be changed/u);
	await runTeamCommand(host, `${teamId} review`, bare.ctx);
	assert.equal(bare.notifications.at(-1)!.text, "Review: off");
});

test("review command on a Team from history shows its schedule and reviews, and changes nothing", async () => {
	const at = 1_700_000_000_000;
	const data = [
		{ version: 2, kind: "launched", teamId: "hist-1", at, roster: { lead: "lead", members: ["lead", "worker"] }, goal: "Old goal", review: { by: "worker", everyMinutes: 20 } },
		{ version: 2, kind: "review", teamId: "hist-1", at: at + 1, review: { id: "review:abcd", at: at + 1, by: "worker", work: { workId: "work:x", revision: 1 }, status: "succeeded",
			verdict: "off_track", summary: "OFF TRACK: nothing merged.", snapshot: { elapsedMs: 125_000, works: { total: 1, resolved: 0, running: 1, blocked: 0, held: 0, failed: 0, cancelled: 0 }, finishedSinceLast: 0, budget: [] } } },
	].map((record) => ({ type: "custom", customType: TEAM_JOURNAL_ENTRY_TYPE, data: record }));
	const host = new TeamSessionHost({ assertAliasesAvailable: async () => undefined } as unknown as SessionBroker, () => undefined, data);
	assert.equal(host.history.skipped, 0);
	const { ctx, notifications } = commandContext();
	await runTeamCommand(host, "hist-1 review", ctx);
	assert.equal(notifications.at(-1)!.text, "Review: worker every 20 min\nreview:abcd · 2:05 · worker · off track: OFF TRACK: nothing merged.");
	await assert.rejects(runTeamCommand(host, "hist-1 review now", ctx), /read-only history/u);
});

/** Launch the Team and let the worker's native activation fail: the worker is faulted with its process still owned. */
function faultWorker(host: TeamSessionHost, teamId: string): void {
	const runtime = host.runtime;
	runtime.launch(teamId);
	const take = () => {
		const activation = runtime.takeNextActivation(teamId)!;
		assert.equal(runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId).ok, true);
		return activation;
	};
	const boot = take();
	assert.equal(runtime.handleAction(boot.binding, boot.scope, 1, "boot", { action: "yield" }, "boot").ok, true);
	runtime.nativeSettled(boot.binding, boot.scope.activationId, { status: "success", appliedToolCallId: "boot" });
	runtime.cleanupFinished(boot.binding, boot.scope.activationId, { ok: true });
	const work = take();
	runtime.nativeSettled(work.binding, work.scope.activationId, { status: "error", error: { code: "NATIVE_FAILURE", message: "boom" } });
	runtime.cleanupFinished(work.binding, work.scope.activationId, { ok: true });
}

test("/rail-team revive completes faulted aliases, confirms what happens, and reopens the member", async () => {
	const { host, teamId } = setup([{ to: "worker", task: "root" }]);
	faultWorker(host, teamId);
	let command: any;
	installTeamCommand({ registerCommand: (_name: string, value: any) => { command = value; } } as any, () => host);
	assert.ok(command.getArgumentCompletions(`${teamId} rev`).some((item: any) => item.label === "revive"));
	assert.deepEqual(command.getArgumentCompletions(`${teamId} revive `).map((item: any) => item.label), ["worker"], "only faulted members with a live process");

	const declined = commandContext({ confirmation: false });
	await runTeamCommand(host, `${teamId} revive worker`, declined.ctx);
	assert.equal(host.runtime.getTeam(teamId).members.find((member) => member.id === "worker")!.lifecycle, "faulted");
	await assert.rejects(runTeamCommand(host, `${teamId} revive`, declined.ctx), /requires a member alias/u);

	const { ctx, confirmations, notifications } = commandContext();
	await runTeamCommand(host, `${teamId} revive worker`, ctx);
	assert.match(confirmations[0]!.title, /Revive worker of /u);
	assert.match(confirmations[0]!.message, /reopened.*failed work stays failed/u);
	assert.doesNotMatch(confirmations[0]!.message, /held for the unavailable lead/u);
	assert.equal(host.runtime.getTeam(teamId).members.find((member) => member.id === "worker")!.lifecycle, "open");
	assert.match(notifications.at(-1)?.text ?? "", /worker revived/u);
	assert.equal(command.getArgumentCompletions(`${teamId} revive `), null);
});

test("a unique Team ID prefix is accepted wherever a teamId is parsed; an ambiguous or unknown one is refused", async () => {
	// Deterministic IDs that share a long prefix, as the popup's 8-character Team IDs can.
	let counter = 0;
	const host = new TeamSessionHost({ assertAliasesAvailable: async () => undefined } as unknown as SessionBroker, () => undefined, [], { createId: () => `shared-${String(++counter * 7919).padStart(8, "0")}` });
	const prepare = () => host.runtime.prepare({ members: [{ alias: "lead", roleDescription: "Lead." }, { alias: "worker", roleDescription: "Work." }], lead: "lead", brief: { goal: "Other." }, timeoutSeconds: null }).teamId;
	const teamId = prepare();
	const second = prepare();
	let common = 0;
	while (teamId[common] === second[common]) common++;
	assert.ok(common >= 7 && common < teamId.length - 1, `${teamId} ${second}`);
	const { ctx, notifications } = commandContext();
	await runTeamCommand(host, `${teamId.slice(0, common + 1)} status`, ctx);
	assert.ok(notifications.at(-1)!.text.includes(teamId));
	await assert.rejects(runTeamCommand(host, `${teamId.slice(0, common)} status`, ctx), (error: Error) => error.message.includes("Ambiguous") && error.message.includes(teamId) && error.message.includes(second));
	await assert.rejects(runTeamCommand(host, "nope status", ctx), /Unknown teamId nope/u);
	let command: any;
	installTeamCommand({ registerCommand: (_name: string, value: any) => { command = value; } } as any, () => host);
	assert.deepEqual(command.getArgumentCompletions(`${teamId.slice(0, common + 1)} lead `).map((item: any) => item.label), ["worker"], "completion also resolves a prefix");
});

test("popup v asks which faulted member to revive; l asks which open member becomes the lead", async () => {
	const { host, teamId } = setup([{ to: "worker", task: "root" }]);
	host.runtime.launch(teamId);
	const none = commandContext({ overlayKey: "v" });
	await runTeamCommand(host, "", none.ctx);
	assert.match(none.notifications[0]!.text, /no faulted member that can be revived/u);
	assert.equal(none.confirmations.length, 0);
	host.runtime.cancelTeam(teamId, "reset");

	const second = setup([{ to: "worker", task: "root" }]);
	faultWorker(second.host, second.teamId);
	const revive = commandContext({ overlayKey: "v" });
	const asked: string[][] = [];
	revive.ctx.ui.select = async (_title: string, choices: string[]) => { asked.push(choices); return choices[0]; };
	await runTeamCommand(second.host, "", revive.ctx);
	assert.deepEqual(asked, [["worker"]]);
	assert.match(revive.confirmations[0]!.title, /Revive worker of /u);
	assert.equal(second.host.runtime.getTeam(second.teamId).members.find((member) => member.id === "worker")!.lifecycle, "open");

	const third = setup();
	third.host.runtime.launch(third.teamId);
	const lead = commandContext({ overlayKey: "l" });
	const options: string[][] = [];
	lead.ctx.ui.select = async (_title: string, choices: string[]) => { options.push(choices); return choices[0]; };
	await runTeamCommand(third.host, "", lead.ctx);
	assert.deepEqual(options, [["worker"]], "only open members other than the lead");
	assert.match(lead.confirmations[0]!.title, /Make worker the lead/u);
	assert.equal(third.host.runtime.getTeam(third.teamId).lead, "worker");
});

test("/rail-team pause and continue confirm their effect; popup p toggles them; list, status and the popup summary show PAUSED", async () => {
	const { host, teamId } = setup([{ to: "worker", task: "root" }]);
	host.runtime.launch(teamId);
	let command: any;
	installTeamCommand({ registerCommand: (_name: string, value: any) => { command = value; } } as any, () => host);
	assert.ok(command.getArgumentCompletions(`${teamId} pa`).some((item: any) => item.label === "pause"));
	assert.ok(command.getArgumentCompletions(`${teamId} con`).some((item: any) => item.label === "continue"));
	const paused = () => !!host.runtime.getTeam(teamId).paused;

	const declined = commandContext({ confirmation: false });
	await runTeamCommand(host, `${teamId} pause`, declined.ctx);
	assert.equal(paused(), false, "declined");
	await assert.rejects(runTeamCommand(host, `${teamId} pause`, commandContext({ hasUI: false }).ctx), /needs interactive confirmation/u);
	const pause = commandContext();
	await runTeamCommand(host, `${teamId} pause lunch break`, pause.ctx);
	assert.match(pause.confirmations[0]!.title, /Pause Team /u);
	assert.match(pause.confirmations[0]!.message, /finish their current model request.*then stop.*Nothing new starts until you continue/u);
	assert.equal(paused(), true);
	assert.match(pause.notifications.at(-1)!.text, /paused/u);
	assert.ok(host.runtime.panelFacts(teamId).timeline.some((entry) => entry.text === "host paused the Team: lunch break"));
	await runTeamCommand(host, `${teamId} pause`, pause.ctx);
	assert.match(pause.notifications.at(-1)!.text, /was already paused/u);

	const list = commandContext();
	await runTeamCommand(host, "list", list.ctx);
	assert.match(list.notifications.at(-1)!.text, new RegExp(`${teamId} «Run host-control tests\\.» · ACTIVE · PAUSED · ok`, "u"));
	await runTeamCommand(host, `${teamId} status`, list.ctx);
	assert.match(list.notifications.at(-1)!.text, /Team \S+ «Run host-control tests\.» · ACTIVE · PAUSED · ok/u);
	assert.match(list.notifications.at(-1)!.text, /Waiting for: Paused by the host/u);

	const popupContinue = commandContext({ overlayKey: "p" });
	await runTeamCommand(host, "", popupContinue.ctx);
	assert.match(popupContinue.overlays[0]!.output, /ACTIVE · PAUSED · \d\d-\d\d \d\d:\d\d → now/u, "the popup header");
	assert.match(popupContinue.overlays[0]!.output, /p continue/u);
	assert.match(popupContinue.confirmations[0]!.title, /Continue Team /u);
	assert.match(popupContinue.confirmations[0]!.message, /Parked work resumes where it stopped.*The lead gets a message/u);
	assert.equal(paused(), false);
	assert.match(popupContinue.notifications.at(-1)!.text, /continued/u);
	await runTeamCommand(host, `${teamId} continue`, popupContinue.ctx);
	assert.match(popupContinue.notifications.at(-1)!.text, /was not paused/u);

	const popupPause = commandContext({ overlayKey: "p" });
	await runTeamCommand(host, "", popupPause.ctx);
	assert.match(popupPause.overlays[0]!.output, /p pause/u);
	assert.match(popupPause.confirmations[0]!.title, /Pause Team /u);
	assert.equal(paused(), true);

	host.runtime.cancelTeam(teamId, "done");
	await assert.rejects(runTeamCommand(host, `${teamId} continue`, commandContext().ctx), /is cancelled; it cannot be continued/u);
	await assert.rejects(runTeamCommand(host, `${teamId} pause`, commandContext().ctx), /is cancelled; it cannot be paused/u);
});
