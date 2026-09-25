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

test("an explicit finish or workers barrier plus receiving checkpoint avoids another continuation", async () => {
	for (const action of ["finish", "wait"] as const) {
		const hub = new TeamHub();
		try {
			const manager = new TeamRunManager(hub);
			const team = hub.prepare({ coordinator: "A", workers: ["B"] });
			const [a] = manager.join(team.id, "single", [{ alias: "A", task: "coordinate" }]);
			const [b] = manager.join(team.id, "parallel", [{ alias: "B", task: "work" }]);
			const coordinator = manager.channel(a!);
			await manager.channel(b!).afterRun!(run("worker result"));
			const barrier = await coordinator.onRequest(action === "wait"
				? { requestId: "workers-done", sequence: 1, action, wait: { kind: "workers" } }
				: { requestId: "workers-done", sequence: 1, action });
			assert.equal(barrier.ok, true);
			assert.equal(barrier.snapshot?.phase, "finalizing");
			const received = await coordinator.onRequest({
				requestId: "receive-results", sequence: 2, action: "checkpoint", receive: true,
			});
			assert.equal(received.ok, true);
			assert.ok(received.events?.some((event) => event.kind === "result"));
			assert.equal(await coordinator.afterRun!(run("summary from complete results")), undefined);
			assert.equal(hub.get(team.id).phase, "completed");
			assert.equal(hub.get(team.id).members[0]!.output, "summary from complete results");
		} finally { hub.dispose(); }
	}
});

test("a completed barrier without a receiving checkpoint keeps the one continuation fallback", async () => {
	const hub = new TeamHub();
	try {
		const manager = new TeamRunManager(hub);
		const team = hub.prepare({ coordinator: "A", workers: ["B"] });
		const [a] = manager.join(team.id, "single", [{ alias: "A", task: "coordinate" }]);
		const [b] = manager.join(team.id, "parallel", [{ alias: "B", task: "work" }]);
		const coordinator = manager.channel(a!);
		await manager.channel(b!).afterRun!(run("worker result"));
		await coordinator.onRequest({ requestId: "workers-done", sequence: 1, action: "finish" });
		const continuation = await coordinator.afterRun!(run("premature natural answer"));
		assert.match(continuation!, /complete team snapshot/u);
		assert.equal(hub.get(team.id).phase, "finalizing");
		assert.equal(await coordinator.afterRun!(run("final summary")), undefined);
		assert.equal(hub.get(team.id).phase, "completed");
	} finally { hub.dispose(); }
});

test("worker empty native output fails only that member unless a structured result was reported", async () => {
	for (const structured of [false, true]) {
		const hub = new TeamHub();
		try {
			const manager = new TeamRunManager(hub);
			const team = hub.prepare({ coordinator: "A", workers: ["B"] });
			manager.join(team.id, "single", [{ alias: "A", task: "coordinate" }]);
			const [worker] = manager.join(team.id, "parallel", [{ alias: "B", task: "work" }]);
			if (structured) {
				await manager.channel(worker!).onRequest({
					requestId: "structured-result", sequence: 1, action: "finish",
					result: { status: "failed", summary: "The task could not be completed" },
				});
			}
			await manager.channel(worker!).afterRun!(run("  "));
			const member = hub.get(team.id).members.find((item) => item.id === "B")!;
			if (structured) {
				assert.equal(member.state, "completed", "runtime completion is separate from the task result status");
				assert.equal(member.output, "  ", "the team preserves the native output verbatim instead of inventing a replacement");
				assert.equal(member.result?.status, "failed");
			} else {
				assert.equal(member.state, "failed");
				assert.match(member.error!, /native output is empty/u);
				assert.equal(hub.get(team.id).phase, "running", "one worker failure must not cancel the team");
				assert.equal(hub.signal(team.id).aborted, false);
			}
		} finally { hub.dispose(); }
	}
});

test("assignment status shows task policy and bounded recent routes without exposing dispatch bindings", () => {
	const hub = new TeamHub();
	try {
		const team = hub.prepare({ coordinator: "A", workers: ["B"] });
		const snapshot = {
			...team,
			members: team.members.map((member) => member.id === "B" ? {
				...member,
				assignment: { memberId: "B", task: "Inspect the target", cwd: "/tmp/project", model: "provider/model", fastMode: true, searchMode: "on" },
				result: { status: "blocked" as const, summary: "Waiting for an approved test account" },
			} : member),
			events: Array.from({ length: 12 }, (_, index) => ({
				seq: index + 1, kind: "message" as const, from: "B", to: "A", message: `message ${index}`,
			})),
		};
		const text = teamStatus(snapshot);
		assert.match(text, /B: REGISTERED · blocked/u);
		assert.match(text, /task: Inspect the target/u);
		assert.match(text, /provider\/model · FAST on · SEARCH on/u);
		assert.match(text, /result BLOCKED: Waiting for an approved test account/u);
		assert.match(text, /Message B -> A: message 11/u);
		assert.doesNotMatch(text, /message 0(?:\D|$)/u);
		assert.doesNotMatch(text, /epoch|binding/u);
		assert.ok(Buffer.byteLength(text, "utf8") <= 8 * 1024);
	} finally { hub.dispose(); }
});

test("final summary rejects new cooperation as a tool error, and rejects empty output, native error and cancelled completion", async () => {
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
				const late = await channel.onRequest({ requestId: "late", sequence: 1, action: "wait", wait: { kind: "message" } });
				assert.deepEqual([late.ok, late.from, late.to, late.requestId], [false, "@hub", "A", "late"]);
				assert.match(late.error!, /finalizing.*Write your final answer now/u);
				assert.equal(hub.get(team.id).phase, "finalizing", "a post-barrier mistake must not fail the team");
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
		assert.throws(() => manager.join(team.id, "parallel", [
			{ alias: "B1", task: "x".repeat(8 * 1024 + 1) }, { alias: "B2", task: "two" },
		]), /exceeds 8192 UTF-8 bytes/u);
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

test("a stall during the host-side barrier becomes one coordinator turn instead of a deadline wait", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const hub = new TeamHub({ stallGraceMs: 10 });
	try {
		const manager = new TeamRunManager(hub);
		const team = hub.prepare({ coordinator: "A", workers: ["B"] });
		const [a] = manager.join(team.id, "single", [{ alias: "A", task: "coordinate" }]);
		const [b] = manager.join(team.id, "parallel", [{ alias: "B", task: "work" }]);
		const coordinator = manager.channel(a!);
		const worker = manager.channel(b!);
		const parked = worker.onRequest({ requestId: "wait", sequence: 1, action: "wait", wait: { kind: "message", from: "A" } });
		const prompt = coordinator.afterRun!(run("premature answer"));
		await new Promise((resolve) => setImmediate(resolve));
		t.mock.timers.tick(10);
		const continuation = await prompt;
		assert.match(continuation!, /Team stalled: A waits for all workers; B waits for a message from A/u);
		assert.match(continuation!, /call team finish/u);
		assert.doesNotMatch(continuation!, /All workers have settled/u);
		assert.equal((await coordinator.onRequest({ requestId: "unblock", sequence: 1, action: "send", to: "B", message: "go" })).ok, true,
			"a stall turn may still cooperate; it is not the final-summary continuation");
		assert.equal((await parked).events?.[0]?.message, "go");
		await worker.afterRun!(run("worker result"));
		const summary = await coordinator.afterRun!(run("answer after unblocking"));
		assert.match(summary!, /All workers have settled/u);
		assert.equal(await coordinator.afterRun!(run("final summary")), undefined);
		assert.equal(hub.get(team.id).phase, "completed");
	} finally { hub.dispose(); }
});

test("a worker cancelled by the coordinator keeps its authoritative cancelled outcome", async () => {
	const hub = new TeamHub();
	try {
		const manager = new TeamRunManager(hub);
		const team = hub.prepare({ coordinator: "A", workers: ["B1", "B2"] });
		const [a] = manager.join(team.id, "single", [{ alias: "A", task: "coordinate" }]);
		const [b1] = manager.join(team.id, "parallel", [{ alias: "B1", task: "one" }, { alias: "B2", task: "two" }]);
		assert.equal((await manager.channel(a!).onRequest({ requestId: "cancel", sequence: 1, action: "control", to: "B1", command: "cancel" })).ok, true);
		const signal = hub.memberSignal(team.id, "B1");
		assert.equal(await manager.channel(b1!).afterRun!({ ...run("aborted"), stopReason: "aborted" }, signal), undefined);
		const member = hub.get(team.id).members.find((candidate) => candidate.id === "B1")!;
		assert.equal(member.state, "cancelled");
		assert.equal(member.error, "Cancelled by coordinator A");
		assert.equal(hub.get(team.id).phase, "running");
		assert.equal(hub.signal(team.id).aborted, false);
	} finally { hub.dispose(); }
});

test("after an explicit barrier, extra coordinator calls are correctable tool errors and a repeated barrier is idempotent", async () => {
	const hub = new TeamHub();
	try {
		const manager = new TeamRunManager(hub);
		const team = hub.prepare({ coordinator: "A", workers: ["B"] });
		const [a] = manager.join(team.id, "single", [{ alias: "A", task: "coordinate" }]);
		const [b] = manager.join(team.id, "parallel", [{ alias: "B", task: "work" }]);
		const coordinator = manager.channel(a!);
		await manager.channel(b!).afterRun!(run("worker result"));
		const barrier = await coordinator.onRequest({ requestId: "barrier", sequence: 1, action: "finish" });
		assert.equal(barrier.snapshot?.phase, "finalizing");
		assert.equal((await coordinator.onRequest({ requestId: "context", sequence: 2, action: "checkpoint", receive: true })).ok, true);
		for (const [index, request] of ([
			{ action: "send", to: "B", message: "double-check" },
			{ action: "control", to: "B", command: "pause" },
			{ action: "wait", wait: { kind: "message" } },
		] as const).entries()) {
			const reply = await coordinator.onRequest({ requestId: `late-${index}`, sequence: 3 + index, ...request });
			assert.equal(reply.ok, false);
			assert.match(reply.error!, /finalizing/u);
		}
		const repeated = await coordinator.onRequest({ requestId: "again", sequence: 6, action: "wait", wait: { kind: "workers" } });
		assert.equal(repeated.ok, true);
		assert.equal(repeated.snapshot?.members.find((member) => member.id === "B")?.output, "worker result");
		assert.equal(hub.get(team.id).phase, "finalizing");
		assert.equal((await coordinator.onRequest({ requestId: "context-2", sequence: 7, action: "checkpoint", receive: true })).ok, true);
		assert.equal(await coordinator.afterRun!(run("final summary")), undefined);
		assert.equal(hub.get(team.id).phase, "completed");
		assert.equal(hub.get(team.id).members.find((member) => member.id === "A")?.output, "final summary");
	} finally { hub.dispose(); }
});

test("a redirect that races a worker's natural settlement continues the worker instead of failing it", async () => {
	const hub = new TeamHub();
	try {
		const manager = new TeamRunManager(hub);
		const team = hub.prepare({ coordinator: "A", workers: ["B"] });
		const [a] = manager.join(team.id, "single", [{ alias: "A", task: "coordinate" }]);
		const [b] = manager.join(team.id, "parallel", [{ alias: "B", task: "work" }]);
		const worker = manager.channel(b!);
		assert.equal((await worker.onRequest({ requestId: "context", sequence: 1, action: "checkpoint", receive: true })).revision, 0);
		await manager.channel(a!).onRequest({ requestId: "redirect", sequence: 1, action: "control", to: "B", command: "redirect", message: "use the new API" });
		const continuation = await worker.afterRun!(run("answer for the old direction"));
		assert.match(continuation!, /changed your direction/u);
		assert.equal(hub.get(team.id).members.find((member) => member.id === "B")?.state, "running");
		// The continuation is a new native send: the child rebinds and restarts its wire sequence.
		const next = await worker.onRequest({ requestId: "next-context", sequence: 1, action: "checkpoint", receive: true });
		assert.equal(next.revision, 1);
		assert.ok(next.events?.some((event) => event.message === "use the new API"));
		assert.equal(await worker.afterRun!(run("answer for the new direction")), undefined);
		const member = hub.get(team.id).members.find((candidate) => candidate.id === "B")!;
		assert.equal(member.state, "completed");
		assert.equal(member.output, "answer for the new direction");
	} finally { hub.dispose(); }
});

test("the dispatch channel reports whether its member passed a team gate", async () => {
	const hub = new TeamHub();
	try {
		const manager = new TeamRunManager(hub);
		const team = hub.prepare({ coordinator: "A", workers: ["B"] });
		const [a] = manager.join(team.id, "single", [{ alias: "A", task: "coordinate" }]);
		const coordinator = manager.channel(a!);
		assert.equal(coordinator.started?.(), false);
		const gate = coordinator.onRequest({ requestId: "gate", sequence: 1, action: "checkpoint", receive: true });
		assert.equal(coordinator.started?.(), false, "a gate parked for admission is not a start");
		hub.cancel(team.id, "admission failed");
		assert.equal((await gate).ok, false);
		assert.equal(coordinator.started?.(), false);
	} finally { hub.dispose(); }
});
