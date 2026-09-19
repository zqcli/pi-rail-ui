import assert from "node:assert/strict";
import { test } from "node:test";
import { TeamHub } from "../../tools/subagents/team-hub";
import { TeamRunManager, teamCallSignal, teamStatus } from "../../tools/subagents/team-runner";
import { emptySubagentUsage } from "../../tools/subagents/usage";

const run = (output: string) => ({ output, usage: emptySubagentUsage() });

test("early coordinator settlement waits, then generates a snapshot continuation before completion", async () => {
	const hub = new TeamHub();
	try {
		const manager = new TeamRunManager(hub);
		const team = hub.prepare({ coordinator: "A", workers: ["B1", "B2"] });
		const [a] = manager.join(team.id, "single", [{ alias: "A", task: "coordinate" }]);
		const [b1, b2] = manager.join(team.id, "parallel", [{ alias: "B1", task: "one" }, { alias: "B2", task: "two" }]);
		const coordinator = manager.channel(a!);
		let released = false;
		const finalPrompt = coordinator.afterRun!(run("early answer")).then((prompt) => { released = true; return prompt; });
		await manager.channel(b1!).afterRun!(run("result one"));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(released, false);
		manager.fail(b2!, "worker failed");
		const prompt = await finalPrompt;
		assert.match(prompt!, /result one/);
		assert.match(prompt!, /worker failed/);
		assert.ok(!prompt!.includes(a!.epoch));
		assert.equal(hub.get(team.id).phase, "finalizing");
		assert.match(teamStatus(hub.get(team.id)), /FINALIZING/);
		assert.equal(await coordinator.afterRun!(run("final summary")), undefined);
		assert.equal(hub.get(team.id).phase, "completed");
		assert.equal(hub.get(team.id).members[0]!.output, "final summary");
	} finally { hub.dispose(); }
});

test("continuation rebinding retains monotonically increasing hub request sequences", async () => {
	const hub = new TeamHub();
	try {
		const manager = new TeamRunManager(hub);
		const team = hub.prepare({ coordinator: "A", workers: ["B"] });
		const [a] = manager.join(team.id, "single", [{ alias: "A", task: "coordinate" }]);
		const [b] = manager.join(team.id, "parallel", [{ alias: "B", task: "work" }]);
		const channel = manager.channel(a!);
		assert.equal((await channel.onRequest({ requestId: "first", sequence: 1, action: "checkpoint" })).ok, true);
		await manager.channel(b!).afterRun!(run("worker result"));
		await channel.afterRun!(run("early"));
		assert.equal((await channel.onRequest({ requestId: "rebound", sequence: 1, action: "checkpoint" })).ok, true);
		await channel.afterRun!(run("summary"));
	} finally { hub.dispose(); }
});

test("final summary rejects new cooperation, empty output, native error and cancelled completion", async () => {
	for (const failure of ["wait", "empty", "error", "cancelled"] as const) {
		const hub = new TeamHub();
		try {
			const manager = new TeamRunManager(hub);
			const team = hub.prepare({ coordinator: "A", workers: ["B"] });
			const [a] = manager.join(team.id, "single", [{ alias: "A", task: "coordinate" }]);
			const [b] = manager.join(team.id, "parallel", [{ alias: "B", task: "work" }]);
			const channel = manager.channel(a!);
			await manager.channel(b!).afterRun!(run("worker result"));
			await channel.afterRun!(run("early answer"));
			if (failure === "wait") {
				await assert.rejects(channel.onRequest({ requestId: "late", sequence: 1, action: "wait", wait: { kind: "message" } }), /must not wait/);
			} else if (failure === "empty") {
				await assert.rejects(channel.afterRun!(run("  ")), /summary is empty/);
			} else if (failure === "error") {
				await channel.afterRun!({ ...run("partial answer"), stopReason: "error", errorMessage: "provider failed" });
			} else {
				hub.cancel(team.id, "user cancelled");
				await assert.rejects(channel.afterRun!(run("late success")), /cannot publish/);
			}
			assert.notEqual(hub.get(team.id).phase, "completed");
			assert.notEqual(hub.get(team.id).members[0]!.state, "completed");
		} finally { hub.dispose(); }
	}
});

test("fixed roster validation is atomic and rejects incompatible lifecycle before joining", () => {
	const hub = new TeamHub();
	try {
		const manager = new TeamRunManager(hub);
		const team = hub.prepare({ coordinator: "A", workers: ["B1", "B2"] });
		for (const items of [
			[{ alias: "B1", task: "one" }],
			[{ alias: "B1", task: "one" }, { alias: "B1", task: "two" }],
			[{ alias: "B1", task: "one" }, { alias: "B2", task: "two", target: "old" }],
			[{ alias: "B1", task: "one" }, { alias: "B2", task: "two", session: {} }],
		]) assert.throws(() => manager.join(team.id, "parallel", items), /Team requires/);
		assert.ok(hub.get(team.id).members.every((member) => member.state === "registered"));
		assert.throws(() => manager.join(team.id, "chain", [{ alias: "A", task: "work" }]), /Team requires/);
	} finally { hub.dispose(); }
});

test("coordinator failure and caller abort cancel teammates; signal listeners can be disposed", () => {
	const hub = new TeamHub();
	try {
		const manager = new TeamRunManager(hub);
		const team = hub.prepare({ coordinator: "A", workers: ["B"] });
		const [a] = manager.join(team.id, "single", [{ alias: "A", task: "work" }]);
		const caller = new AbortController();
		const scope = teamCallSignal(hub, team.id, caller.signal);
		manager.fail(a!, "coordinator failed");
		assert.equal(scope.signal.aborted, true);
		scope.dispose();
		const next = hub.prepare({ coordinator: "C", workers: ["D"] });
		const disposed = teamCallSignal(hub, next.id, caller.signal);
		disposed.dispose();
		caller.abort();
		assert.equal(hub.signal(next.id).aborted, false);
		const alreadyAborted = teamCallSignal(hub, next.id, caller.signal);
		assert.equal(alreadyAborted.signal.aborted, true);
		alreadyAborted.dispose();
	} finally { hub.dispose(); }
});

test("confirmed team cancellation preserves its signal reason and the underlying error cause", () => {
	const hub = new TeamHub();
	try {
		const manager = new TeamRunManager(hub);
		const team = hub.prepare({ coordinator: "A", workers: ["B"] });
		const [a] = manager.join(team.id, "single", [{ alias: "A", task: "work" }]);
		const transport = new Error("Subagent RPC process stopped");
		assert.equal(manager.dispatchError(a!, transport), transport, "uncancelled transport failures must remain unchanged");
		const scope = teamCallSignal(hub, team.id);
		hub.cancel(team.id, "Team deadline exceeded");
		assert.equal(scope.signal.reason, "Team deadline exceeded");
		scope.dispose();
		const lateScope = teamCallSignal(hub, team.id);
		assert.equal(lateScope.signal.reason, "Team deadline exceeded");
		lateScope.dispose();
		const error = manager.dispatchError(a!, transport);
		assert.ok(error instanceof Error);
		assert.match(error.message, /^Team deadline exceeded\nUnderlying subagent error: Subagent RPC process stopped$/);
		assert.equal(error.cause, transport);
		const authoritative = new Error("Team deadline exceeded");
		assert.equal(manager.dispatchError(a!, authoritative), authoritative);
	} finally { hub.dispose(); }
});

test("missing sibling has a finite admission deadline", async () => {
	const hub = new TeamHub({ startupTimeoutMs: 15 });
	try {
		const manager = new TeamRunManager(hub);
		const team = hub.prepare({ coordinator: "A", workers: ["B"] });
		const [a] = manager.join(team.id, "single", [{ alias: "A", task: "work" }]);
		const promise = manager.channel(a!).afterRun!(run("early"));
		const check = assert.rejects(promise, /admission|Startup/);
		await new Promise((resolve) => setTimeout(resolve, 25));
		await check;
	} finally { hub.dispose(); }
});
