import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { FileAgentInstanceStore } from "../../tools/subagents/instance-store";
import { FileSessionLeaseManager } from "../../tools/subagents/session-lease";
import {
	SessionBroker,
	type AgentInstance,
	type AgentInstanceStore,
	type AgentRoster,
	type SessionWorker,
	type SessionWorkerFactory,
	type DispatchProgress,
	type WorkerSendOptions,
	type WorkerRunResult,
	type WorkerStartSpec,
	WorkerControlError,
} from "../../tools/subagents/session-broker";
import type { RailModelRef } from "../../tools/subagents/models";
import { RpcProcessExitTimeoutError } from "../../tools/subagents/rpc-transport";

test("team continuation reserves the operation, rejects target insertion and sums native usage", async () => {
	const store = new MemoryInstanceStore();
	const roster = new MemoryRoster();
	const worker = new FakeWorker("team-session", "/tmp/team-session.jsonl");
	const broker = new SessionBroker({ store, roster, workerFactory: async () => worker });
	let release!: () => void;
	const barrier = new Promise<void>((resolve) => { release = resolve; });
	let waiting!: () => void;
	const atBarrier = new Promise<void>((resolve) => { waiting = resolve; });
	let runs = 0;
	const dispatch = broker.dispatch({ model: reviewerModel(), alias: "team-A", task: "initial", team: {
		binding: { version: 1, teamId: "team", memberId: "A", role: "coordinator", epoch: "epoch" },
		onRequest: async () => ({ ok: true }),
		afterRun: async () => { if (++runs === 1) { waiting(); await barrier; return "summary"; } return undefined; },
	} });
	await atBarrier;
	assert.equal(broker.runtimeStatus(roster.resolve("team-A")!).phase, "queued"); // Native run settled, but its operation is still reserved.
	await assert.rejects(broker.dispatch({ target: "team-A", task: "intruder" }), /active team/);
	await assert.rejects(broker.control({ target: "team-A", delivery: "steer", message: "intruder" }), /team control/);
	assert.deepEqual(worker.tasks, ["initial"]);
	release();
	const result = await dispatch;
	assert.deepEqual(worker.tasks, ["initial", "summary"]);
	assert.equal(result.run.usage.turns, 2);
	assert.equal(result.run.output, "done: summary");
	assert.equal(JSON.stringify(result.instance).includes("epoch"), false);
	await broker.dispatch({ target: "team-A", task: "ordinary followup" });
	await broker.shutdown();
});

test("stopping a team member aborts its between-native-runs barrier without losing the lease reservation", async () => {
	const worker = new FakeWorker("team-session", "/tmp/team-session.jsonl");
	const broker = new SessionBroker({ store: new MemoryInstanceStore(), roster: new MemoryRoster(), workerFactory: async () => worker });
	let waiting!: () => void;
	const atBarrier = new Promise<void>((resolve) => { waiting = resolve; });
	const dispatch = broker.dispatch({ model: reviewerModel(), alias: "team-A", task: "initial", team: {
		binding: { version: 1, teamId: "team", memberId: "A", role: "coordinator", epoch: "epoch" },
		onRequest: async () => ({ ok: true }),
		afterRun: async (_run, signal) => new Promise<undefined>((_resolve, reject) => {
			signal!.addEventListener("abort", () => reject(new Error("barrier aborted")), { once: true });
			waiting();
		}),
	} });
	const rejected = assert.rejects(dispatch, /barrier aborted/);
	await atBarrier;
	await broker.stop("team-A");
	await rejected;
	assert.equal(worker.stopped, true);
	assert.deepEqual(worker.tasks, ["initial"]);
	await broker.shutdown();
});

test("a competing team cannot remove another dispatch's alias reservation", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let starting!: () => void;
	const started = new Promise<void>((resolve) => { starting = resolve; });
	const worker = new FakeWorker("reserved", "/tmp/reserved.jsonl");
	const broker = new SessionBroker({ store: new MemoryInstanceStore(), roster: new MemoryRoster(), workerFactory: async () => { starting(); await gate; return worker; } });
	const request = { model: reviewerModel(), alias: "shared", task: "work", team: {
		binding: { version: 1 as const, teamId: "one", memberId: "shared", role: "worker" as const, epoch: "private" }, onRequest: async () => ({ ok: true }),
	} };
	const first = broker.dispatch(request);
	try {
		await started;
		await assert.rejects(broker.dispatch({ ...request, alias: " shared ", team: { ...request.team, binding: { ...request.team.binding, teamId: "two" } } }), /active team/);
		await assert.rejects(broker.dispatch({ target: "shared", task: "intruder" }), /active team/);
	} finally { release(); await first; await broker.shutdown(); }
});

test("ordinary dispatch preserves the native run and usage objects", async () => {
	const worker = new FakeWorker("ordinary", "/tmp/ordinary.jsonl");
	const native = { output: "unchanged", usage: emptyUsage() };
	worker.send = async () => native;
	const broker = new SessionBroker({ store: new MemoryInstanceStore(), roster: new MemoryRoster(), workerFactory: async () => worker });
	try {
		const result = await broker.dispatch({ model: reviewerModel(), alias: "ordinary", task: "work" });
		assert.equal(result.run, native);
		assert.equal(result.run.usage, native.usage);
	} finally { await broker.shutdown(); }
});

test("team cancellation during startup waits for the new worker's cleanup", async () => {
	let finishStartup!: () => void;
	const startup = new Promise<void>((resolve) => { finishStartup = resolve; });
	let finishCleanup!: () => void;
	const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
	let notifyStartup!: () => void;
	const starting = new Promise<void>((resolve) => { notifyStartup = resolve; });
	let notifyCleanup!: () => void;
	const cleaning = new Promise<void>((resolve) => { notifyCleanup = resolve; });
	const worker = new FakeWorker("cancelled", "/tmp/cancelled.jsonl");
	worker.stop = async () => { notifyCleanup(); await cleanup; worker.stopped = true; };
	const broker = new SessionBroker({ store: new MemoryInstanceStore(), roster: new MemoryRoster(), workerFactory: async () => { notifyStartup(); await startup; return worker; } });
	const controller = new AbortController();
	let settled = false;
	const result = broker.dispatch({ model: reviewerModel(), alias: "cancelled", task: "work", signal: controller.signal, team: {
		binding: { version: 1, teamId: "team", memberId: "cancelled", role: "worker", epoch: "private" }, onRequest: async () => ({ ok: true }),
	} }).finally(() => { settled = true; });
	const rejected = assert.rejects(result, /aborted during startup/);
	try {
		await starting;
		controller.abort();
		finishStartup();
		await cleaning;
		assert.equal(settled, false);
		assert.deepEqual(worker.tasks, []);
	} finally { finishStartup(); finishCleanup(); await rejected; await broker.shutdown(); }
	assert.equal(worker.stopped, true);
});

test("direct broker callers get the normalized contextWindow, never a raw null", async () => {
	const worker = new FakeWorker("normalized", "/tmp/normalized.jsonl");
	const options: Array<WorkerSendOptions | undefined> = [];
	const send = worker.send.bind(worker);
	worker.send = async (task, sendOptions) => { options.push(sendOptions); return send(task, sendOptions); };
	const broker = new SessionBroker({ store: new MemoryInstanceStore(), roster: new MemoryRoster(), workerFactory: async () => worker });
	try {
		await broker.dispatch({ model: reviewerModel(), alias: "normalized", task: "work", contextWindow: null as unknown as number });
		assert.equal(Object.hasOwn(options[0]!, "contextWindow"), false);
	} finally { await broker.shutdown(); }
});

test("a failed team member that never passed a team gate releases its alias; a started member keeps it", async () => {
	for (const started of [false, true]) {
		const store = new MemoryInstanceStore();
		const roster = new MemoryRoster();
		const workers: FakeWorker[] = [];
		const broker = new SessionBroker({ store, roster, workerFactory: async () => {
			const worker = new FakeWorker(`session-${workers.length}`, `/tmp/rail-missing-team-${workers.length}.jsonl`);
			worker.send = async () => { throw new Error("Startup admission deadline exceeded"); };
			workers.push(worker);
			return worker;
		} });
		try {
			const team = {
				binding: { version: 1 as const, teamId: "team", memberId: "B", role: "worker" as const, epoch: "private" },
				onRequest: async () => ({ ok: true }), started: () => started,
			};
			await assert.rejects(broker.dispatch({ model: reviewerModel(), alias: "B", task: "work", team }), /admission/);
			assert.equal(workers[0]!.stopped, true);
			if (started) {
				assert.equal(roster.resolve("B") !== undefined, true, "a started member keeps its session for inspection");
				assert.equal(store.instances.size, 1);
				await assert.rejects(broker.dispatch({ model: reviewerModel(), alias: "B", task: "retry", team: { ...team, binding: { ...team.binding, teamId: "retry" } } }), /already exists/);
			} else {
				assert.equal(roster.resolve("B"), undefined);
				assert.equal(store.instances.size, 0);
				await assert.rejects(broker.dispatch({ model: reviewerModel(), alias: "B", task: "retry", team: { ...team, binding: { ...team.binding, teamId: "retry" } } }), /admission/,
					"the same alias can be used again; only the fake worker fails");
			}
		} finally { await broker.shutdown(); }
	}
});

class MemoryInstanceStore implements AgentInstanceStore {
	readonly instances = new Map<string, AgentInstance>();
	getDelayMs = 0;
	readonly getBlockers: Promise<void>[] = [];
	readonly listBlockers: Promise<void>[] = [];
	getStarted?: (agentId: string) => void;
	listStarted?: () => void;

	async get(agentId: string): Promise<AgentInstance | undefined> {
		const value = this.instances.get(agentId);
		this.getStarted?.(agentId);
		if (this.getDelayMs) await new Promise((resolve) => setTimeout(resolve, this.getDelayMs));
		await this.getBlockers.shift();
		return value === undefined ? undefined : structuredClone(value);
	}

	async put(instance: AgentInstance): Promise<void> {
		this.instances.set(instance.agentId, structuredClone(instance));
	}

	async delete(agentId: string): Promise<void> {
		this.instances.delete(agentId);
	}

	async list(): Promise<AgentInstance[]> {
		const values = Array.from(this.instances.values()).map((instance) => structuredClone(instance));
		this.listStarted?.();
		await this.listBlockers.shift();
		return values;
	}
}

class MemoryRoster implements AgentRoster {
	readonly aliases = new Map<string, string>();

	resolve(target: string): string | undefined {
		return this.aliases.get(target) ?? (Array.from(this.aliases.values()).includes(target) ? target : undefined);
	}

	link(alias: string, agentId: string): void {
		this.aliases.set(alias, agentId);
	}

	unlink(alias: string): void {
		this.aliases.delete(alias);
	}

	list() {
		return Array.from(this.aliases, ([alias, agentId]) => ({ alias, agentId }));
	}
}

class FakeWorker implements SessionWorker {
	readonly tasks: string[] = [];
	readonly controls: Array<{ delivery: "steer" | "followUp"; message: string }> = [];
	readonly controlStarts: string[] = [];
	active = 0;
	maxActive = 0;
	stopped = false;
	model: RailModelRef | undefined;
	delayMs = 5;
	controlDelayMs = 0;
	modelDelayMs = 0;
	unknownControlMessage: string | undefined;
	settleBeforeReturn = false;
	settled = false;
	controlAckGate: Promise<void> | undefined;
	private settledCallback: (() => void) | undefined;

	constructor(
		readonly sessionId: string,
		readonly sessionFile: string,
	) {}

	async send(task: string, _options?: WorkerSendOptions): Promise<WorkerRunResult> {
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		_options?.onAccepted?.();
		this.tasks.push(task);
		this.settledCallback = () => {
			this.settled = true;
			_options?.onSettled?.();
		};
		if (this.settleBeforeReturn) {
			this.settledCallback();
		}
		await new Promise((resolve) => setTimeout(resolve, this.delayMs));
		this.active--;
		return { output: `done: ${task}`, usage: emptyUsage() };
	}

	async stop(): Promise<void> {
		this.stopped = true;
	}

	async setModel(model: RailModelRef): Promise<RailModelRef> {
		if (this.modelDelayMs) await new Promise((resolve) => setTimeout(resolve, this.modelDelayMs));
		this.model = model;
		return model;
	}

	async control(request: { delivery: "steer" | "followUp"; message: string }): Promise<void> {
		this.controlStarts.push(request.message);
		await this.controlAckGate;
		if (this.controlDelayMs) await new Promise((resolve) => setTimeout(resolve, this.controlDelayMs));
		if (request.message === this.unknownControlMessage) throw new WorkerControlError("ack lost", "unknown");
		this.controls.push(request);
	}

	settleRun(): void {
		this.settledCallback?.();
	}
}

function emptyUsage() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 };
}

function reviewerModel(): RailModelRef {
	return { provider: "cus-resp", modelId: "gpt-5.6-sol", thinkingLevel: "xhigh" };
}

function savedAgent(agentId: string, alias: string, fastMode = true): AgentInstance {
	return {
		version: 2,
		agentId,
		alias,
		model: reviewerModel(),
		sessionId: `session-${agentId}`,
		sessionFile: `/tmp/${agentId}.jsonl`,
		cwd: "/tmp/project",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		lastTask: "saved",
		fastMode,
	};
}

function setup() {
	const store = new MemoryInstanceStore();
	const roster = new MemoryRoster();
	const starts: WorkerStartSpec[] = [];
	const workers: FakeWorker[] = [];
	const workerFactory: SessionWorkerFactory = async (spec) => {
		starts.push(spec);
		const index = workers.length + 1;
		const worker = new FakeWorker(`session-${index}`, spec.mode === "open" ? spec.sessionPath! : `/tmp/session-${index}.jsonl`);
		workers.push(worker);
		return worker;
	};
	const broker = new SessionBroker({ store, roster, workerFactory, parentSessionLabel: "Main Auth Work" });
	return { broker, store, roster, starts, workers, workerFactory };
}

describe("SessionBroker", () => {
	test("shutdown stops an active send before draining a queued model change", { timeout: 2000 }, async () => {
		const { broker, workers, store } = setup();
		const instance = await broker.attach({ model: reviewerModel(), alias: "shutdown-model" });
		const worker = workers[0]!;
		const started = Promise.withResolvers<void>();
		const stopped = Promise.withResolvers<void>();
		let modelUpdates = 0;
		worker.send = async () => {
			started.resolve();
			await stopped.promise;
			return { output: "stopped", usage: emptyUsage() };
		};
		worker.stop = async () => { worker.stopped = true; stopped.resolve(); };
		worker.setModel = async (model) => { modelUpdates++; return model; };
		const sending = broker.dispatch({ target: instance.agentId, task: "wait for stop" });
		await started.promise;
		const changing = broker.changeModel(instance.agentId, { provider: "test", modelId: "never-applied" });
		const rejected = assert.rejects(changing, /shutting down/);
		// Let resolveInstance finish so the model operation is actually queued.
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(broker.runtimeStatus(instance.agentId).queued, 1);
		await broker.shutdown();
		await sending;
		await rejected;
		assert.equal(worker.stopped, true);
		assert.equal(modelUpdates, 0);
		assert.deepEqual((await store.get(instance.agentId))?.model, reviewerModel());
		await assert.rejects(broker.changeModel(instance.agentId, reviewerModel()), /shutting down/);
	});

	test("team continuation serializes a queued model change until the coordinator's rounds settle", async () => {
		const store = new MemoryInstanceStore();
		const roster = new MemoryRoster();
		const worker = new FakeWorker("team-model-session", "/tmp/team-model-session.jsonl");
		const broker = new SessionBroker({ store, roster, workerFactory: async () => worker });
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => { release = resolve; });
		let waiting!: () => void;
		const atBarrier = new Promise<void>((resolve) => { waiting = resolve; });
		let rounds = 0;
		const nextModel = { provider: "test", modelId: "queued-after-rounds" };
		const dispatch = broker.dispatch({ model: reviewerModel(), alias: "team-model", task: "round-1", team: {
			binding: { version: 1, teamId: "team", memberId: "A", role: "coordinator", epoch: "epoch" },
			onRequest: async () => ({ ok: true }),
			afterRun: async () => { if (++rounds === 1) { waiting(); await barrier; return "round-2"; } return undefined; },
		} });
		await atBarrier;
		let setModelCalls = 0;
		let sendsAtSetModel = -1;
		worker.setModel = async (model) => { setModelCalls++; sendsAtSetModel = worker.tasks.length; return model; };
		const changing = broker.changeModel("team-model", nextModel);
		release();
		const result = await dispatch;
		await changing;
		assert.equal(setModelCalls, 1);
		assert.equal(sendsAtSetModel, 2);
		assert.deepEqual(worker.tasks, ["round-1", "round-2"]);
		assert.equal(result.run.usage.turns, 2);
		const agentId = roster.resolve("team-model")!;
		assert.deepEqual((await store.get(agentId))?.model, nextModel);
		assert.equal(broker.runtimeStatus(agentId).phase, "idle");
		await broker.shutdown();
	});

	test("shutdown cancels a coordinator waiting between rounds before draining a queued model change", { timeout: 2000 }, async () => {
		const store = new MemoryInstanceStore();
		const roster = new MemoryRoster();
		const worker = new FakeWorker("team-halt-session", "/tmp/team-halt-session.jsonl");
		const broker = new SessionBroker({ store, roster, workerFactory: async () => worker });
		let waiting!: () => void;
		const atBarrier = new Promise<void>((resolve) => { waiting = resolve; });
		const dispatch = broker.dispatch({ model: reviewerModel(), alias: "team-halt", task: "initial", team: {
			binding: { version: 1, teamId: "team", memberId: "A", role: "coordinator", epoch: "epoch" },
			onRequest: async () => ({ ok: true }),
			afterRun: async (_run, signal) => new Promise<undefined>((_resolve, reject) => {
				signal!.addEventListener("abort", () => reject(new Error("coordinator barrier aborted")), { once: true });
				waiting();
			}),
		} });
		const rejected = assert.rejects(dispatch, /barrier aborted/);
		await atBarrier;
		const changing = broker.changeModel("team-halt", { provider: "test", modelId: "never-applied" });
		const rejectedChange = assert.rejects(changing, /shutting down/);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(broker.runtimeStatus(roster.resolve("team-halt")!).queued, 1);
		await broker.shutdown();
		await rejected;
		await rejectedChange;
		assert.equal(worker.stopped, true);
		assert.deepEqual(worker.tasks, ["initial"]);
		assert.deepEqual((await store.get(roster.resolve("team-halt")!))?.model, reviewerModel());
	});

	test("delete cancels a coordinator waiting between rounds before converging a queued model change", { timeout: 2000 }, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "rail-team-delete-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const sessionFile = join(root, "child.jsonl");
		await writeFile(sessionFile, "");
		const store = new MemoryInstanceStore();
		const roster = new MemoryRoster();
		const worker = new FakeWorker("team-delete-session", sessionFile);
		const broker = new SessionBroker({ store, roster, workerFactory: async () => worker });
		let waiting!: () => void;
		const atBarrier = new Promise<void>((resolve) => { waiting = resolve; });
		const dispatch = broker.dispatch({ model: reviewerModel(), alias: "team-delete", task: "initial", team: {
			binding: { version: 1, teamId: "team", memberId: "A", role: "coordinator", epoch: "epoch" },
			onRequest: async () => ({ ok: true }),
			afterRun: async (_run, signal) => new Promise<undefined>((_resolve, reject) => {
				signal!.addEventListener("abort", () => reject(new Error("coordinator barrier aborted")), { once: true });
				waiting();
			}),
		} });
		const rejected = assert.rejects(dispatch, /barrier aborted/);
		await atBarrier;
		const agentId = roster.resolve("team-delete")!;
		// The change queues behind the parked team operation; delete must cancel the
		// operation so the maintenance can converge instead of blocking forever.
		const changing = broker.changeModel("team-delete", { provider: "test", modelId: "queued" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(broker.runtimeStatus(agentId).queued, 1);
		await broker.delete("team-delete");
		await rejected;
		await changing;
		assert.deepEqual(worker.model, { provider: "test", modelId: "queued" });
		assert.equal(worker.stopped, true);
		assert.deepEqual(worker.tasks, ["initial"]);
		assert.equal(await store.get(agentId), undefined);
		assert.equal(roster.resolve("team-delete"), undefined);
		await assert.rejects(access(sessionFile), { code: "ENOENT" });
		assert.equal(broker.hasLocalWorker(agentId), false);
		assert.equal(broker.runtimeStatus(agentId).phase, "stopped");
		await broker.shutdown();
	});

	test("context window budgets follow the actual child model through pending changes and team dispatch", async (t) => {
		const root = await mkdtemp(join(tmpdir(), "broker-budget-086-"));
		const agentDir = join(root, "agent");
		const childCwd = join(root, "child");
		const previous = process.env["PI_CODING_AGENT_DIR"];
		process.env["PI_CODING_AGENT_DIR"] = agentDir;
		t.after(async () => {
			if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"];
			else process.env["PI_CODING_AGENT_DIR"] = previous;
			await rm(root, { recursive: true, force: true });
		});
		await mkdir(agentDir, { recursive: true });
		await mkdir(join(childCwd, ".pi"), { recursive: true });
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { reserveTokens: 65_536 } }));
		await writeFile(join(childCwd, ".pi/settings.json"), JSON.stringify({ compaction: { modelOverrides: {
			"budget-test/child/small": { reserveTokens: 8192 },
			"budget-test/child/large": { reserveTokens: 32_768 },
		} } }));
		new ProjectTrustStore(agentDir).set(root, true);
		const small = { provider: "budget-test", modelId: "child/small" };
		const large = { provider: "budget-test", modelId: "child/large" };
		const store = new MemoryInstanceStore();
		const roster = new MemoryRoster();
		const workers: FakeWorker[] = [];
		const broker = new SessionBroker({ store, roster, defaultCwd: childCwd, workerFactory: async () => {
			const worker = new FakeWorker(`budget-${workers.length + 1}`, "/tmp/budget-session.jsonl");
			workers.push(worker);
			return worker;
		} });
		// Team dispatch validates the requested child model before any worker exists.
		await assert.rejects(
			broker.dispatch({ model: large, alias: "team-budget", task: "must not start", contextWindow: 16_000, team: {
				binding: { version: 1, teamId: "team", memberId: "budget", role: "worker", epoch: "private" },
				onRequest: async () => ({ ok: true }),
			} }),
			/reserveTokens \(32768\)/u,
		);
		assert.equal(workers.length, 0);
		assert.deepEqual(await store.list(), []);
		const instance = await broker.attach({ model: small, alias: "budget-target", cwd: childCwd });
		const worker = workers[0]!;
		let setModelStarted!: () => void;
		const startedSetModel = new Promise<void>((resolve) => { setModelStarted = resolve; });
		let releaseSetModel!: () => void;
		const setModelGate = new Promise<void>((resolve) => { releaseSetModel = resolve; });
		worker.setModel = async (model) => { setModelStarted(); await setModelGate; worker.model = model; return model; };
		const changing = broker.changeModel("budget-target", large);
		await startedSetModel;
		// Preflight and/or the worker queue must reject after the pending change's budget applies.
		const blocked = assert.rejects(
			broker.dispatch({ target: "budget-target", task: "blocked", contextWindow: 24_000 }),
			/reserveTokens \(32768\)/u,
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(worker.tasks, []);
		releaseSetModel();
		await changing;
		await blocked;
		assert.deepEqual((await store.get(instance.agentId))?.model, large);
		const resumed = await broker.dispatch({ target: "budget-target", task: "resumed", contextWindow: 40_000 });
		assert.equal(resumed.run.output, "done: resumed");
		assert.deepEqual(worker.tasks, ["resumed"]);
		assert.equal(broker.runtimeStatus(instance.agentId).phase, "idle");
		await broker.shutdown();
	});

	test("rejects an invalid new-instance budget before creating a worker", async () => {
		const { broker, store, workers } = setup();

		await assert.rejects(
			() => broker.dispatch({ model: reviewerModel(), alias: "invalid-window", task: "must not start", contextWindow: 1 }),
			/reserveTokens/,
		);
		assert.equal(workers.length, 0);
		assert.deepEqual(await store.list(), []);
	});

	test("creates a persistent instance and reuses it by alias", async () => {
		const { broker, store, roster, starts, workers } = setup();

		const first = await broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "review auth" });
		const second = await broker.dispatch({ target: "auth-review", task: "check tests" });

		assert.equal(first.instance.alias, "auth-review");
		assert.equal(first.instance.sessionName, "subagent · Main Auth Work · auth-review");
		assert.equal(second.instance.agentId, first.instance.agentId);
		assert.equal(roster.resolve("auth-review"), first.instance.agentId);
		assert.equal((await store.get(first.instance.agentId))?.sessionFile, "/tmp/session-1.jsonl");
		assert.deepEqual(starts.map((start) => start.mode), ["new"]);
		assert.equal(starts[0]?.sessionName, "subagent · Main Auth Work · auth-review");
		assert.deepEqual(workers[0]?.tasks, ["review auth", "check tests"]);
	});

	test("publishes persistent identity, model, and initial zero usage before the child produces output", async () => {
		const { broker } = setup();
		const created = await broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "initial" });
		const progress: DispatchProgress[] = [];

		await broker.dispatch({ target: "auth-review", task: "continue", onUpdate: (update) => progress.push(update) });

		assert.equal(progress[0]?.instance.agentId, created.instance.agentId);
		assert.equal(progress[0]?.instance.sessionId, created.instance.sessionId);
		assert.deepEqual(progress[0]?.instance.model, reviewerModel());
		assert.equal(progress[0]?.run.output, "(starting...)");
		assert.deepEqual(progress[0]?.run.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });
	});

	test("allows one Pi model to own multiple independent sessions", async () => {
		const { broker } = setup();

		const first = await broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "review auth" });
		const second = await broker.dispatch({ model: reviewerModel(), alias: "db-review", task: "review db" });

		assert.notEqual(first.instance.agentId, second.instance.agentId);
		assert.notEqual(first.instance.sessionId, second.instance.sessionId);
		assert.deepEqual(first.instance.model, second.instance.model);
	});

	test("attaches a session without injecting a synthetic task", async () => {
		const { broker, workers } = setup();

		const attached = await broker.attach({
			model: reviewerModel(),
			alias: "auth-review",
			session: { mode: "fork", path: "/tmp/source.jsonl" },
		});

		assert.equal(attached.lastTask, "(attached; no task yet)");
		assert.deepEqual(workers[0]?.tasks, []);
		assert.deepEqual((await broker.listLinked()).map((item) => item.alias), ["auth-review"]);
	});

	test("uses the parent-session alias when a managed instance is linked under a new name", async () => {
		const { broker, roster, store } = setup();
		const created = await broker.dispatch({ model: reviewerModel(), alias: "original", task: "initial" });
		roster.link("auth-review", created.instance.agentId);

		const continued = await broker.dispatch({ target: "auth-review", task: "continue" });

		assert.equal(continued.instance.alias, "auth-review");
		assert.equal((await broker.listLinked()).some((item) => item.alias === "auth-review"), true);
		assert.equal((await broker.listLinked()).some((item) => item.alias === "original"), true);
		assert.equal((await store.get(created.instance.agentId))?.alias, "original");
	});

	test("detaching one alias keeps the worker alive while another alias remains linked", async () => {
		const { broker, roster, workers } = setup();
		const created = await broker.dispatch({ model: reviewerModel(), alias: "original", task: "initial" });
		roster.link("auth-review", created.instance.agentId);

		await broker.detach("auth-review");

		assert.equal(roster.resolve("original"), created.instance.agentId);
		assert.equal(roster.resolve("auth-review"), undefined);
		assert.equal(workers[0]?.stopped, false);
		assert.deepEqual(broker.runtimeStatus(created.instance.agentId), { phase: "idle", queued: 0 });
	});

	test("permanently deletes the child JSONL, descriptor, and current roster links", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-subagent-delete-"));
		try {
			const sessionFile = join(dir, "child.jsonl");
			await writeFile(sessionFile, "session\n");
			const store = new MemoryInstanceStore();
			const roster = new MemoryRoster();
			const saved: AgentInstance = {
				version: 2,
				agentId: "agt_delete",
				alias: "delete-review",
				model: reviewerModel(),
				sessionId: "session-delete",
				sessionFile,
				cwd: dir,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				lastTask: "review",
				fastMode: true,
			};
			await store.put(saved);
			roster.link(saved.alias, saved.agentId);
			const broker = new SessionBroker({ store, roster, workerFactory: async () => new FakeWorker(saved.sessionId, sessionFile) });
			await broker.listLinked();
			assert.equal(broker.knownFastMode(saved.alias), true);

			await broker.delete(saved.agentId);

			assert.equal(await store.get(saved.agentId), undefined);
			assert.equal(roster.resolve(saved.alias), undefined);
			assert.equal(broker.knownFastMode(saved.agentId), undefined);
			await assert.rejects(() => access(sessionFile));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("reopens the saved child session after the broker restarts", async () => {
		const { broker, store, roster, workerFactory, starts } = setup();
		const first = await broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "review auth" });
		await broker.shutdown();

		const restarted = new SessionBroker({ store, roster, workerFactory, parentSessionLabel: "Main Auth Work" });
		const resumed = await restarted.dispatch({ target: "auth-review", task: "continue" });

		assert.equal(resumed.instance.agentId, first.instance.agentId);
		assert.equal(starts.at(-1)?.mode, "open");
		assert.equal(starts.at(-1)?.sessionPath, first.instance.sessionFile);
	});

	for (const action of ["delete", "stop", "shutdown", "changeModel"] as const) {
		test(`${action} waits for the complete dispatch metadata write`, async () => {
			const dir = await mkdtemp(join(tmpdir(), "pi-subagent-finalize-"));
			const store = new MemoryInstanceStore();
			const worker = new FakeWorker("child", join(dir, "child.jsonl"));
			const broker = new SessionBroker({ store, roster: new MemoryRoster(), workerFactory: async () => worker });
			const agent = await broker.attach({ model: reviewerModel(), alias: "review" });
			let release!: () => void;
			let started!: () => void;
			const gate = new Promise<void>((resolve) => { release = resolve; });
			const writing = new Promise<void>((resolve) => { started = resolve; });
			const put = store.put.bind(store);
			let held = false;
			store.put = async (instance) => {
				if (instance.lastTask === "finish" && !held) {
					held = true;
					started();
					await gate;
				}
				await put(instance);
			};
			const run = broker.dispatch({ target: agent.agentId, task: "finish" });
			await writing;
			let finished = false;
			const replacement = { provider: "test", modelId: "replacement" };
			const operation = (action === "shutdown" ? broker.shutdown()
				: action === "changeModel" ? broker.changeModel(agent.agentId, replacement)
					: broker[action](agent.agentId)).then(() => { finished = true; });
			try {
				await new Promise((resolve) => setTimeout(resolve, 30));
				assert.equal(finished, false, "lifecycle operation must not overtake dispatch persistence");
			} finally {
				release();
				await Promise.all([run, operation]);
				await broker.shutdown();
				await rm(dir, { recursive: true, force: true });
			}
			const stored = await store.get(agent.agentId);
			if (action === "delete") assert.equal(stored, undefined);
			else {
				assert.equal(stored?.lastTask, "finish");
				if (action === "changeModel") assert.deepEqual(stored?.model, replacement);
			}
		});
	}

	test("lazily assigns a stable subagent session name to legacy descriptors on open", async () => {
		const { broker, store, roster, workerFactory, starts } = setup();
		const first = await broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "initial" });
		const stored = await store.get(first.instance.agentId);
		assert.ok(stored);
		const { sessionName: _oldName, ...legacy } = stored;
		await store.put(legacy);
		await broker.shutdown();

		const restarted = new SessionBroker({ store, roster, workerFactory, parentSessionLabel: "Main Auth Work" });
		await restarted.dispatch({ target: "auth-review", task: "continue" });

		assert.equal(starts.at(-1)?.sessionName, "subagent · Main Auth Work · auth-review");
		assert.equal((await store.get(first.instance.agentId))?.sessionName, "subagent · Main Auth Work · auth-review");
	});

	test("links a globally addressed agentId into the current parent roster", async () => {
		const { broker, store, workerFactory } = setup();
		const first = await broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "review auth" });
		await broker.shutdown();
		const emptyRoster = new MemoryRoster();
		const restarted = new SessionBroker({ store, roster: emptyRoster, workerFactory, parentSessionLabel: "Main Auth Work" });

		await restarted.dispatch({ target: first.instance.agentId, task: "continue" });

		assert.equal(emptyRoster.resolve("auth-review"), first.instance.agentId);
	});

	test("forks an ordinary saved session before adopting it", async () => {
		const { broker, starts } = setup();

		await broker.dispatch({
			model: reviewerModel(),
			alias: "legacy-review",
			task: "continue the old review",
			session: { mode: "fork", path: "/tmp/existing.jsonl" },
		});

		assert.equal(starts[0]?.mode, "fork");
		assert.equal(starts[0]?.sessionPath, "/tmp/existing.jsonl");
	});

	test("serializes concurrent messages sent to the same instance", async () => {
		const { broker, workers } = setup();
		await broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "initial" });

		await Promise.all([
			broker.dispatch({ target: "auth-review", task: "one" }),
			broker.dispatch({ target: "auth-review", task: "two" }),
		]);

		assert.equal(workers[0]?.maxActive, 1);
		assert.deepEqual(workers[0]?.tasks, ["initial", "one", "two"]);
	});

	test("propagates persistent fastMode into creation and descriptor reloads", async () => {
		const { broker, store, roster, workerFactory, starts } = setup();
		const first = await broker.dispatch({ model: reviewerModel(), alias: "fast-review", task: "review quickly", fastMode: true });

		assert.equal(first.instance.fastMode, true);
		assert.equal(broker.knownFastMode("fast-review"), true);
		assert.equal(starts[0]?.fastMode, true);
		assert.equal((await store.get(first.instance.agentId))?.fastMode, true);

		await broker.shutdown();
		const restarted = new SessionBroker({ store, roster, workerFactory, parentSessionLabel: "Main Auth Work" });
		assert.equal(restarted.knownFastMode("fast-review"), undefined);
		await restarted.listLinked();
		assert.equal(restarted.knownFastMode("fast-review"), true);
		await restarted.dispatch({ target: "fast-review", task: "continue quickly" });
		assert.equal(starts.at(-1)?.mode, "open");
		assert.equal(starts.at(-1)?.fastMode, true);
		await restarted.shutdown();
	});

	test("prewarms saved Fast policy for unlinked descriptors", async () => {
		const { broker, store } = setup();
		const saved = savedAgent("agt_unlinked", "unlinked-review");
		await store.put(saved);

		assert.equal(broker.knownFastMode(saved.agentId), undefined);
		await broker.prewarmFastModes();
		assert.equal(broker.knownFastMode(saved.agentId), true);
		assert.equal(broker.knownFastMode(saved.alias), undefined);
	});

	test("descriptor snapshots expose model and fast policy together at creation", async () => {
		const { broker } = setup();
		const created = await broker.dispatch({ model: reviewerModel(), alias: "descriptor-review", task: "initial", fastMode: true });

		assert.deepEqual(broker.knownModel("descriptor-review"), reviewerModel());
		assert.deepEqual(broker.knownModel(created.instance.agentId), reviewerModel());
		assert.equal(broker.knownFastMode("descriptor-review"), true);
		assert.equal(broker.knownModel("missing-review"), undefined);
		assert.equal(broker.knownFastMode("missing-review"), undefined);
	});

	test("listLinked and prewarm refresh model snapshots for linked and saved descriptors", async () => {
		const { broker, store, roster } = setup();
		const linked = savedAgent("agt_linked_snapshot", "linked-snapshot");
		const saved = savedAgent("agt_saved_snapshot", "saved-snapshot");
		await store.put(linked);
		await store.put(saved);
		roster.link(linked.alias, linked.agentId);

		assert.equal(broker.knownModel(linked.agentId), undefined);
		await broker.listLinked();
		assert.deepEqual(broker.knownModel(linked.agentId), linked.model);
		assert.equal(broker.knownFastMode(linked.alias), true);

		assert.equal(broker.knownModel(saved.agentId), undefined);
		await broker.prewarmFastModes();
		assert.deepEqual(broker.knownModel(saved.agentId), saved.model);
		assert.equal(broker.knownFastMode(saved.agentId), true);
	});

	test("descriptor snapshots isolate model clones from callers and live descriptors", async () => {
		const instances = new Map<string, AgentInstance>();
		const liveStore: AgentInstanceStore = {
			get: async (agentId) => instances.get(agentId),
			put: async (instance) => { instances.set(instance.agentId, instance); },
			delete: async (agentId) => { instances.delete(agentId); },
			list: async () => Array.from(instances.values()),
		};
		const saved = savedAgent("agt_clone", "clone-review");
		instances.set(saved.agentId, saved);
		const broker = new SessionBroker({ store: liveStore, roster: new MemoryRoster(), workerFactory: async () => new FakeWorker(saved.sessionId, saved.sessionFile) });
		await broker.prewarmFastModes();

		const returned = broker.knownModel(saved.agentId);
		assert.deepEqual(returned, reviewerModel());
		returned!.modelId = "tampered-read";
		assert.deepEqual(broker.knownModel(saved.agentId), reviewerModel(), "callers must not mutate the cached descriptor");

		saved.model.modelId = "tampered-live";
		saved.fastMode = false;
		assert.deepEqual(broker.knownModel(saved.agentId), reviewerModel(), "the snapshot must not alias the store's live descriptor");
		assert.equal(broker.knownFastMode(saved.agentId), true);
	});

	test("changeModel and setFastMode keep the other half of the descriptor snapshot intact", async () => {
		const { broker } = setup();
		const created = await broker.dispatch({ model: reviewerModel(), alias: "descriptor-update", task: "initial", fastMode: true });
		const replacement: RailModelRef = { provider: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: "high" };

		await broker.changeModel(created.instance.agentId, replacement);
		assert.deepEqual(broker.knownModel(created.instance.agentId), replacement);
		assert.equal(broker.knownFastMode(created.instance.agentId), true, "a model change must preserve the fast policy");

		await broker.setFastMode(created.instance.agentId, false);
		assert.deepEqual(broker.knownModel(created.instance.agentId), replacement, "a fast-mode change must preserve the model");
		assert.equal(broker.knownFastMode(created.instance.agentId), false);
	});

	test("delete clears both halves of the descriptor snapshot", async () => {
		const { broker } = setup();
		const created = await broker.dispatch({ model: reviewerModel(), alias: "descriptor-delete", task: "initial", fastMode: true });

		assert.deepEqual(broker.knownModel(created.instance.agentId), reviewerModel());
		await broker.delete(created.instance.agentId);
		assert.equal(broker.knownModel(created.instance.agentId), undefined);
		assert.equal(broker.knownFastMode(created.instance.agentId), undefined);
	});

	for (const readKind of ["listLinked", "prewarm"] as const) {
		for (const mutation of ["setFastMode", "changeModel", "delete"] as const) {
			test(`${readKind} ignores an old read after ${mutation}`, async () => {
				const store = new MemoryInstanceStore();
				const roster = new MemoryRoster();
				const saved = savedAgent(`agt_${readKind}_${mutation}`, `${readKind}-${mutation}`);
				await store.put(saved);
				roster.link(saved.alias, saved.agentId);
				const broker = new SessionBroker({ store, roster, workerFactory: async () => new FakeWorker(saved.sessionId, saved.sessionFile) });
				await broker.prewarmFastModes();
				assert.equal(broker.knownFastMode(saved.agentId), true);
				assert.deepEqual(broker.knownModel(saved.agentId), saved.model);

				const started = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				if (readKind === "listLinked") {
					store.getStarted = () => started.resolve();
					store.getBlockers.push(release.promise);
				} else {
					store.listStarted = () => started.resolve();
					store.listBlockers.push(release.promise);
				}
				const oldRead = readKind === "listLinked" ? broker.listLinked() : broker.prewarmFastModes();
				await started.promise;

				const replacement: RailModelRef = { provider: "test", modelId: "replacement-model" };
				if (mutation === "setFastMode") {
					await broker.setFastMode(saved.agentId, false, { sessionLeaseHeld: true });
					assert.equal(broker.knownFastMode(saved.agentId), false);
					assert.deepEqual(broker.knownModel(saved.agentId), saved.model);
				} else if (mutation === "changeModel") {
					await broker.changeModel(saved.agentId, replacement);
					assert.deepEqual(broker.knownModel(saved.agentId), replacement);
					assert.equal(broker.knownFastMode(saved.agentId), true);
				} else {
					await broker.delete(saved.agentId);
					assert.equal(broker.knownFastMode(saved.agentId), undefined);
					assert.equal(broker.knownModel(saved.agentId), undefined);
				}
				release.resolve();
				await oldRead;

				if (mutation === "setFastMode") {
					assert.equal(broker.knownFastMode(saved.agentId), false);
					assert.deepEqual(broker.knownModel(saved.agentId), saved.model);
				} else if (mutation === "changeModel") {
					assert.deepEqual(broker.knownModel(saved.agentId), replacement);
					assert.equal(broker.knownFastMode(saved.agentId), true);
				} else {
					assert.equal(broker.knownFastMode(saved.agentId), undefined);
					assert.equal(broker.knownModel(saved.agentId), undefined);
				}
			});
		}

		test(`${readKind} cannot restore a superseded model and fast-mode combination`, async () => {
			const store = new MemoryInstanceStore();
			const roster = new MemoryRoster();
			const saved = savedAgent(`agt_combo_${readKind}`, `combo-${readKind}`);
			await store.put(saved);
			roster.link(saved.alias, saved.agentId);
			const broker = new SessionBroker({ store, roster, workerFactory: async () => new FakeWorker(saved.sessionId, saved.sessionFile) });
			await broker.prewarmFastModes();

			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			if (readKind === "listLinked") {
				store.getStarted = () => started.resolve();
				store.getBlockers.push(release.promise);
			} else {
				store.listStarted = () => started.resolve();
				store.listBlockers.push(release.promise);
			}
			const oldRead = readKind === "listLinked" ? broker.listLinked() : broker.prewarmFastModes();
			await started.promise;

			const replacement: RailModelRef = { provider: "test", modelId: "combo-replacement" };
			await broker.changeModel(saved.agentId, replacement);
			await broker.setFastMode(saved.agentId, false, { sessionLeaseHeld: true });
			release.resolve();
			await oldRead;

			assert.deepEqual(broker.knownModel(saved.agentId), replacement);
			assert.equal(broker.knownFastMode(saved.agentId), false);
		});
	}

	test("setFastMode updates an idle or stopped agent and reopens it with the saved policy", async () => {
		const { broker, store, workers, starts } = setup();
		const created = await broker.dispatch({ model: reviewerModel(), alias: "fast-review", task: "initial" });
		let workerStoppedAtPolicyWrite: boolean | undefined;
		const put = store.put.bind(store);
		store.put = async (instance) => {
			if (instance.agentId === created.instance.agentId && instance.fastMode === true) {
				workerStoppedAtPolicyWrite = workers[0]?.stopped;
			}
			await put(instance);
		};

		const enabled = await broker.setFastMode(created.instance.agentId, true);
		assert.equal(enabled.fastMode, true);
		assert.equal(broker.knownFastMode(created.instance.agentId), true);
		assert.equal(workerStoppedAtPolicyWrite, false, "the local worker lease must still be held while the descriptor changes");
		assert.equal((await store.get(created.instance.agentId))?.fastMode, true);
		assert.equal(workers[0]?.stopped, true);

		await broker.dispatch({ target: created.instance.agentId, task: "after toggle" });
		assert.equal(starts.at(-1)?.fastMode, true);
		await broker.stop(created.instance.agentId);
		await assert.rejects(
			() => broker.setFastMode(created.instance.agentId, false),
			/held session lease/,
		);
		const disabled = await broker.setFastMode(created.instance.agentId, false, { sessionLeaseHeld: true });
		assert.equal(disabled.fastMode, false);
		assert.equal(broker.knownFastMode(created.instance.agentId), false);
		assert.equal((await store.get(created.instance.agentId))?.fastMode, false);
	});

	test("setFastMode blocks a dispatch race and clears its barrier after persistence failure", async () => {
		const { broker, workers } = setup();
		const created = await broker.dispatch({ model: reviewerModel(), alias: "fast-review", task: "initial" });
		const setting = broker.setFastMode(created.instance.agentId, true);
		await assert.rejects(() => broker.dispatch({ target: created.instance.agentId, task: "racing dispatch" }), /stopping|interrupted|changing/);
		await setting;
		assert.equal(workers[0]?.stopped, true);

		const next = setup();
		const nextCreated = await next.broker.dispatch({ model: reviewerModel(), alias: "persist-failure", task: "initial" });
		const put = next.store.put.bind(next.store);
		next.store.put = async (instance) => {
			if (instance.fastMode === true) throw new Error("descriptor write failed");
			await put(instance);
		};
		await assert.rejects(() => next.broker.setFastMode(nextCreated.instance.agentId, true), /descriptor write failed/);
		assert.deepEqual(next.broker.runtimeStatus(nextCreated.instance.agentId), { phase: "idle", queued: 0 });
		next.store.put = put;
		await next.broker.dispatch({ target: nextCreated.instance.agentId, task: "after failed toggle" });
		await next.broker.shutdown();
	});

	test("delete waits for an in-flight fast-mode update and cannot leave a resurrected descriptor", async () => {
		const { broker, store, roster } = setup();
		const created = await broker.dispatch({ model: reviewerModel(), alias: "fast-delete", task: "initial" });
		const writeStarted = Promise.withResolvers<void>();
		const releaseWrite = Promise.withResolvers<void>();
		const put = store.put.bind(store);
		store.put = async (instance) => {
			if (instance.agentId === created.instance.agentId && instance.fastMode === true) {
				writeStarted.resolve();
				await releaseWrite.promise;
			}
			await put(instance);
		};

		const setting = broker.setFastMode(created.instance.agentId, true);
		await writeStarted.promise;
		let deleted = false;
		const deleting = broker.delete(created.instance.agentId).then(() => { deleted = true; });
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(deleted, false);
		releaseWrite.resolve();
		await Promise.all([setting, deleting]);

		assert.equal(await store.get(created.instance.agentId), undefined);
		assert.equal(roster.resolve("fast-delete"), undefined);
	});

	test("reports running, queued, idle, and stopped runtime phases truthfully", async () => {
		const { broker } = setup();
		const created = await broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "initial" });
		assert.deepEqual(broker.runtimeStatus(created.instance.agentId), { phase: "idle", queued: 0 });

		const one = broker.dispatch({ target: "auth-review", task: "one" });
		const two = broker.dispatch({ target: "auth-review", task: "two" });
		await new Promise((resolve) => setTimeout(resolve, 1));
		assert.deepEqual(broker.runtimeStatus(created.instance.agentId), { phase: "running", queued: 1 });
		await Promise.all([one, two]);
		assert.deepEqual(broker.runtimeStatus(created.instance.agentId), { phase: "idle", queued: 0 });

		await broker.stop("auth-review");
		assert.deepEqual(broker.runtimeStatus(created.instance.agentId), { phase: "stopped", queued: 0 });
	});

	test("keeps compaction as a running subphase and leaves control admission open", async () => {
		const { broker, workers } = setup();
		const created = await broker.attach({ model: reviewerModel(), alias: "auth-review" });
		const worker = workers[0]!;
		const release = Promise.withResolvers<void>();
		worker.send = async (_task, options) => {
			options?.onAccepted?.();
			options?.onUpdate?.({ output: "(running...)", usage: emptyUsage(), isCompacting: true });
			assert.deepEqual(broker.runtimeStatus(created.agentId), { phase: "running", queued: 0, isCompacting: true });
			await release.promise;
			options?.onUpdate?.({ output: "done", usage: emptyUsage() });
			return { output: "done", usage: emptyUsage() };
		};

		const pending = broker.dispatch({ target: created.agentId, task: "compact" });
		while (broker.runtimeStatus(created.agentId).isCompacting !== true) await new Promise((resolve) => setImmediate(resolve));
		assert.equal(broker.runtimeStatus(created.agentId).phase, "running");
		await broker.control({ target: created.agentId, delivery: "steer", message: "keep going" });
		assert.deepEqual(worker.controls, [{ delivery: "steer", message: "keep going" }]);
		release.resolve();
		await pending;
		assert.deepEqual(broker.runtimeStatus(created.agentId), { phase: "idle", queued: 0 });
	});

	test("delivers steer and follow-up controls to an actively running persistent worker", async () => {
		const { broker, workers } = setup();
		const created = await broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "initial" });
		workers[0]!.delayMs = 40;
		const pending = broker.dispatch({ target: created.instance.agentId, task: "long review" });
		while (broker.runtimeStatus(created.instance.agentId).phase !== "running") {
			await new Promise((resolve) => setImmediate(resolve));
		}

		await Promise.all([
			broker.control({ target: "auth-review", delivery: "steer", message: "Focus on tests" }),
			broker.control({ target: "auth-review", delivery: "followUp", message: "Then summarize risks" }),
		]);

		assert.deepEqual(workers[0]!.controls, [
			{ delivery: "steer", message: "Focus on tests" },
			{ delivery: "followUp", message: "Then summarize risks" },
		]);
		await pending;
		await assert.rejects(
			() => broker.control({ target: "auth-review", delivery: "steer", message: "too late" }),
			/not currently running/,
		);
	});

	test("controls stay closed until the child accepts the prompt", async () => {
		const { broker, workers } = setup();
		const created = await broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "initial" });
		let rejectPrompt!: () => void;
		const promptGate = new Promise<void>((resolve) => { rejectPrompt = resolve; });
		workers[0]!.send = async () => {
			await promptGate;
			throw new Error("prompt rejected");
		};
		const pending = broker.dispatch({ target: created.instance.agentId, task: "preflight" });
		while (broker.runtimeStatus(created.instance.agentId).phase !== "starting") await new Promise((resolve) => setImmediate(resolve));

		await assert.rejects(
			() => broker.control({ target: "auth-review", delivery: "steer", message: "must not be orphaned" }),
			/has not accepted the running prompt/,
		);
		rejectPrompt();
		await assert.rejects(pending, /prompt rejected/);
		assert.deepEqual(workers[0]!.controls, []);
	});

	test("closes control admission at native settlement before worker cleanup returns", async () => {
		const { broker, workers } = setup();
		const agent = await broker.attach({ model: reviewerModel(), alias: "settled" });
		const worker = workers[0]!;
		worker.delayMs = 40;
		worker.settleBeforeReturn = true;
		const pending = broker.dispatch({ target: agent.agentId, task: "settle before reset" });
		while (!worker.settled) await new Promise((resolve) => setImmediate(resolve));

		assert.notEqual(broker.runtimeStatus(agent.agentId).phase, "running");
		await assert.rejects(
			() => broker.control({ target: agent.agentId, delivery: "steer", message: "must wait for cleanup" }),
			/not currently running/,
		);
		await pending;
	});

	test("poisons a control whose acknowledgement crosses native settlement", async () => {
		const { broker, workers } = setup();
		const agent = await broker.attach({ model: reviewerModel(), alias: "settled-ack" });
		const worker = workers[0]!;
		let releaseAck!: () => void;
		worker.controlAckGate = new Promise<void>((resolve) => { releaseAck = resolve; });
		const pending = broker.dispatch({ target: agent.agentId, task: "settle with delayed control ack" });
		while (!worker.tasks.length) await new Promise((resolve) => setImmediate(resolve));
		const control = broker.control({ target: agent.agentId, delivery: "steer", message: "crosses settlement" });
		while (!worker.controlStarts.length) await new Promise((resolve) => setImmediate(resolve));
		worker.settleRun();

		await assert.rejects(
			() => broker.control({ target: agent.agentId, delivery: "steer", message: "new control after settlement" }),
			/not currently running/,
		);
		releaseAck();
		await assert.rejects(control, (error: unknown) => error instanceof WorkerControlError && error.outcome === "unknown");
		await pending;
		assert.deepEqual(worker.controlStarts, ["crosses settlement"]);
		assert.deepEqual(worker.controls.map((entry) => entry.message), ["crosses settlement"]);
	});

	test("controls close when the child finishes, before metadata persistence completes", async () => {
		const { broker, store } = setup();
		const agent = await broker.attach({ model: reviewerModel(), alias: "review" });
		const writing = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const put = store.put.bind(store);
		store.put = async (instance) => {
			writing.resolve();
			await release.promise;
			await put(instance);
		};
		const pending = broker.dispatch({ target: agent.agentId, task: "finish" });
		await writing.promise;
		try {
			await assert.rejects(broker.control({ target: agent.agentId, delivery: "steer", message: "too late" }), /not currently running/);
			assert.notEqual(broker.runtimeStatus(agent.agentId).phase, "running");
		} finally {
			release.resolve();
			await pending;
			await broker.shutdown();
		}
	});

	test("a failed control does not link a stopped global instance into the parent roster", async () => {
		const { broker, store, roster } = setup();
		await store.put({
			version: 2,
			agentId: "agt_global",
			alias: "global-review",
			model: reviewerModel(),
			sessionId: "session-global",
			sessionFile: "/tmp/global.jsonl",
			cwd: "/tmp/project",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			lastTask: "review",
		});

		await assert.rejects(
			() => broker.control({ target: "agt_global", delivery: "steer", message: "Focus" }),
			/not currently running/,
		);
		assert.deepEqual(roster.list(), []);
	});

	test("queued controls stay bound to the run that was active when requested", async () => {
		const { broker, workers } = setup();
		const created = await broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "initial" });
		const worker = workers[0]!;
		worker.delayMs = 20;
		worker.controlDelayMs = 30;
		const firstRun = broker.dispatch({ target: created.instance.agentId, task: "run one" });
		while (broker.runtimeStatus(created.instance.agentId).phase !== "running") await new Promise((resolve) => setImmediate(resolve));
		const firstControl = broker.control({ target: "auth-review", delivery: "steer", message: "first control" });
		const staleControl = broker.control({ target: "auth-review", delivery: "followUp", message: "must not reach run two" });
		const secondRun = broker.dispatch({ target: created.instance.agentId, task: "run two" });
		const staleControlRejected = assert.rejects(staleControl, /finished before the control could be delivered|unknown delivery outcome/);
		const secondRunRejected = assert.rejects(secondRun, /acknowledged (?:the|a) control after the target run ended/);

		await assert.rejects(firstControl, /acknowledged the control after the target run ended/);
		await staleControlRejected;
		await firstRun;
		await secondRunRejected;
		assert.deepEqual(worker.controls, [{ delivery: "steer", message: "first control" }]);
		assert.deepEqual(worker.tasks, ["initial", "run one"]);
	});

	test("maintenance operations do not make an agent eligible for live controls", async () => {
		const { broker, workers } = setup();
		const created = await broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "initial" });
		workers[0]!.modelDelayMs = 30;
		const changing = broker.changeModel(created.instance.agentId, { provider: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: "high" });
		while (broker.runtimeStatus(created.instance.agentId).phase !== "queued") await new Promise((resolve) => setImmediate(resolve));

		await assert.rejects(
			() => broker.control({ target: "auth-review", delivery: "steer", message: "must not queue" }),
			/not currently running/,
		);
		await changing;
	});

	test("unknown control delivery blocks later controls in the same run", async () => {
		const { broker, workers } = setup();
		const created = await broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "initial" });
		workers[0]!.delayMs = 40;
		workers[0]!.controlDelayMs = 10;
		workers[0]!.unknownControlMessage = "uncertain";
		const pending = broker.dispatch({ target: created.instance.agentId, task: "long review" });
		while (broker.runtimeStatus(created.instance.agentId).phase !== "running") await new Promise((resolve) => setImmediate(resolve));

		const uncertain = broker.control({ target: "auth-review", delivery: "steer", message: "uncertain" });
		const later = broker.control({ target: "auth-review", delivery: "followUp", message: "later" });
		await assert.rejects(
			uncertain,
			/ack lost/,
		);
		await assert.rejects(
			later,
			/unknown delivery outcome/,
		);
		assert.deepEqual(workers[0]!.controlStarts, ["uncertain"]);
		await pending;
		assert.equal(broker.runtimeStatus(created.instance.agentId).phase, "error");
		const resumed = await broker.dispatch({ target: "auth-review", task: "recover on a clean worker" });
		assert.equal(resumed.run.output, "done: recover on a clean worker");
		assert.equal(workers.length, 2);
		assert.equal(workers[0]!.stopped, true);
		assert.deepEqual(workers[1]!.tasks, ["recover on a clean worker"]);
	});

	test("stop invalidates queued controls without hanging shutdown", async () => {
		const { broker, workers } = setup();
		const created = await broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "initial" });
		const worker = workers[0]!;
		worker.delayMs = 60;
		worker.controlDelayMs = 30;
		const pending = broker.dispatch({ target: created.instance.agentId, task: "long review" });
		while (broker.runtimeStatus(created.instance.agentId).phase !== "running") await new Promise((resolve) => setImmediate(resolve));
		const firstControl = broker.control({ target: "auth-review", delivery: "steer", message: "already sent" });
		while (worker.controlStarts.length === 0) await new Promise((resolve) => setImmediate(resolve));
		const queuedControl = broker.control({ target: "auth-review", delivery: "followUp", message: "must be cancelled" });
		const stopping = broker.stop("auth-review");
		const queuedControlRejected = assert.rejects(queuedControl, /finished before the control could be delivered/);

		await assert.rejects(firstControl, /delivery outcome is unknown/);
		await queuedControlRejected;
		await Promise.race([
			stopping,
			new Promise((_, reject) => setTimeout(() => reject(new Error("stop timed out")), 500)),
		]);
		await pending.catch(() => undefined);
		assert.deepEqual(worker.controls, [{ delivery: "steer", message: "already sent" }]);
	});

	test("stop and shutdown close control admission before asynchronous cleanup", async () => {
		const { broker, store, workers } = setup();
		const created = await broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "initial" });
		workers[0]!.delayMs = 60;
		const pending = broker.dispatch({ target: created.instance.agentId, task: "long review" });
		while (broker.runtimeStatus(created.instance.agentId).phase !== "running") await new Promise((resolve) => setImmediate(resolve));
		store.getDelayMs = 30;
		const stopping = broker.stop("auth-review");
		await assert.rejects(
			() => broker.control({ target: "auth-review", delivery: "steer", message: "too late" }),
			/worker is stopping/,
		);
		await stopping;
		await pending.catch(() => undefined);

		const second = setup();
		const active = await second.broker.dispatch({ model: reviewerModel(), alias: "second-review", task: "initial" });
		second.workers[0]!.delayMs = 60;
		const activeRun = second.broker.dispatch({ target: active.instance.agentId, task: "long review" });
		while (second.broker.runtimeStatus(active.instance.agentId).phase !== "running") await new Promise((resolve) => setImmediate(resolve));
		const shutdown = second.broker.shutdown();
		await assert.rejects(
			() => second.broker.control({ target: "second-review", delivery: "followUp", message: "too late" }),
			/worker is stopping/,
		);
		await shutdown;
		await activeRun.catch(() => undefined);
	});

	test("dispatches already in descriptor I/O cannot resurrect workers after stop or shutdown", async () => {
		const first = setup();
		const created = await first.broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "initial" });
		first.store.getDelayMs = 30;
		const delayedAfterStop = first.broker.dispatch({ target: created.instance.agentId, task: "must not run" });
		const stopping = first.broker.stop("auth-review");
		await assert.rejects(delayedAfterStop, /interrupted by stop or shutdown/);
		await stopping;
		assert.equal(first.workers.length, 1);
		assert.equal(first.workers[0]!.stopped, true);
		assert.deepEqual(first.workers[0]!.tasks, ["initial"]);

		const second = setup();
		const active = await second.broker.dispatch({ model: reviewerModel(), alias: "shutdown-review", task: "initial" });
		second.store.getDelayMs = 30;
		const delayedAfterShutdown = second.broker.dispatch({ target: active.instance.agentId, task: "must not run" });
		const shutdown = second.broker.shutdown();
		await assert.rejects(delayedAfterShutdown, /interrupted by stop or shutdown/);
		await shutdown;
		assert.equal(second.workers.length, 1);
		assert.equal(second.workers[0]!.stopped, true);
		assert.deepEqual(second.workers[0]!.tasks, ["initial"]);
	});

	test("shutdown waits for an in-flight persistent creation and stops its worker", async () => {
		const store = new MemoryInstanceStore();
		const roster = new MemoryRoster();
		let releaseFactory!: () => void;
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => { markStarted = resolve; });
		const gate = new Promise<void>((resolve) => { releaseFactory = resolve; });
		let worker: FakeWorker | undefined;
		const broker = new SessionBroker({
			store,
			roster,
			workerFactory: async () => {
				markStarted();
				await gate;
				worker = new FakeWorker("session-creating", "/tmp/creating.jsonl");
				return worker;
			},
		});
		const creating = broker.dispatch({ model: reviewerModel(), alias: "creating-review", task: "initial" });
		await started;
		const shutdown = broker.shutdown();
		releaseFactory();

		await assert.rejects(creating, /shutting down/);
		await shutdown;
		assert.equal(worker?.stopped, true);
		assert.deepEqual(await store.list(), []);
		assert.deepEqual(roster.list(), []);
	});

	test("cancelling a queued request keeps the healthy worker idle", async () => {
		const store = new MemoryInstanceStore();
		const roster = new MemoryRoster();
		let releaseHold!: () => void;
		const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
		const worker = new FakeWorker("session-1", "/tmp/queued-cancel.jsonl");
		worker.send = async (task, options) => {
			if (task === "hold") await hold;
			if (options?.signal?.aborted) throw new Error("Subagent request was aborted before dispatch");
			return { output: `done: ${task}`, usage: emptyUsage() };
		};
		const broker = new SessionBroker({ store, roster, workerFactory: async () => worker });
		const created = await broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "initial" });
		const first = broker.dispatch({ target: "auth-review", task: "hold" });
		const controller = new AbortController();
		const second = broker.dispatch({ target: "auth-review", task: "cancelled", signal: controller.signal });
		await new Promise((resolve) => setImmediate(resolve));
		controller.abort();
		releaseHold();

		await first;
		await assert.rejects(second, /aborted/);
		assert.equal(worker.stopped, false);
		assert.deepEqual(broker.runtimeStatus(created.instance.agentId), { phase: "idle", queued: 0 });
	});

	test("changes exactly one persistent session model while idle", async () => {
		const { broker, store, workers } = setup();
		const created = await broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "initial" });
		const replacement: RailModelRef = { provider: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: "high" };

		const updated = await broker.changeModel(created.instance.agentId, replacement);

		assert.deepEqual(updated.model, replacement);
		assert.deepEqual(workers[0]?.model, replacement);
		assert.deepEqual((await store.get(created.instance.agentId))?.model, replacement);
	});

	test("retires a failed transport and reports error until the next worker opens", async () => {
		const store = new MemoryInstanceStore();
		const roster = new MemoryRoster();
		let starts = 0;
		const broker = new SessionBroker({
			store,
			roster,
			workerFactory: async (spec) => {
				starts++;
				const worker = new FakeWorker(`session-${starts}`, spec.mode === "open" ? spec.sessionPath! : "/tmp/failing.jsonl");
				if (starts === 1) {
					const send = worker.send.bind(worker);
					worker.send = async (task) => task === "crash" ? Promise.reject(new Error("transport crashed")) : send(task);
				}
				return worker;
			},
		});
		const created = await broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "initial" });

		await assert.rejects(() => broker.dispatch({ target: "auth-review", task: "crash" }), /transport crashed/);
		assert.deepEqual(broker.runtimeStatus(created.instance.agentId), { phase: "error", queued: 0, errorMessage: "transport crashed" });

		const recovery = broker.dispatch({ target: "auth-review", task: "recover" });
		while (broker.runtimeStatus(created.instance.agentId).phase !== "running") await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(broker.runtimeStatus(created.instance.agentId), { phase: "running", queued: 0 });
		await recovery;
		assert.equal(starts, 2);
		assert.deepEqual(broker.runtimeStatus(created.instance.agentId), { phase: "idle", queued: 0 });
	});

	for (const rollbackFails of [false, true]) {
		test(`a partial model change ${rollbackFails ? "retires the worker when rollback fails" : "rolls back before reuse"}`, async () => {
			const { broker, workers, store, starts } = setup();
			const agent = await broker.attach({ model: reviewerModel(), alias: "review" });
			const worker = workers[0]!;
			worker.setModel = async (model) => {
				if (model.modelId === "replacement") {
					worker.model = model;
					throw new Error("thinking update failed");
				}
				if (rollbackFails) throw new Error("rollback failed");
				worker.model = model;
				return model;
			};
			await assert.rejects(
				broker.changeModel(agent.agentId, { provider: "test", modelId: "replacement" }),
				rollbackFails ? /rollback failed/ : /thinking update failed/,
			);
			assert.deepEqual((await store.get(agent.agentId))?.model, reviewerModel());
			assert.equal(worker.stopped, rollbackFails);
			assert.equal(broker.runtimeStatus(agent.agentId).phase, rollbackFails ? "error" : "idle");
			if (!rollbackFails) assert.deepEqual(worker.model, reviewerModel());
			await broker.dispatch({ target: agent.agentId, task: "continue with original model" });
			assert.equal(workers.length, rollbackFails ? 2 : 1);
			assert.deepEqual(starts.at(-1)?.model, reviewerModel());
			await broker.shutdown();
		});
	}

	test("single-flights worker startup before serializing concurrent messages after restart", async () => {
		const { broker, store, roster, workerFactory, starts, workers } = setup();
		await broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "initial" });
		await broker.shutdown();
		const restarted = new SessionBroker({ store, roster, workerFactory, parentSessionLabel: "Main Auth Work" });

		await Promise.all([
			restarted.dispatch({ target: "auth-review", task: "one" }),
			restarted.dispatch({ target: "auth-review", task: "two" }),
		]);

		assert.equal(starts.filter((start) => start.mode === "open").length, 1);
		assert.equal(workers.at(-1)?.maxActive, 1);
		assert.deepEqual(workers.at(-1)?.tasks, ["one", "two"]);
	});

	test("rejects concurrent creation of the same alias", async () => {
		const { broker, workers } = setup();

		const results = await Promise.allSettled([
			broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "one" }),
			broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "two" }),
		]);

		assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
		assert.equal(results.filter((result) => result.status === "rejected").length, 1);
		assert.equal(workers.length, 1);
	});

	test("reserves aliases across broker processes before creating persistent sessions", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-subagent-alias-reservation-"));
		try {
			const store = new FileAgentInstanceStore(dir);
			const workerFactory: SessionWorkerFactory = async (spec) => new FakeWorker(`session-${spec.agentId}`, `/tmp/${spec.agentId}.jsonl`);
			const first = new SessionBroker({
				store, roster: new MemoryRoster(), workerFactory,
				aliasLeaseManager: new FileSessionLeaseManager(dir),
			});
			const second = new SessionBroker({
				store, roster: new MemoryRoster(), workerFactory,
				aliasLeaseManager: new FileSessionLeaseManager(dir),
			});

			const results = await Promise.allSettled([
				first.dispatch({ model: reviewerModel(), alias: "shared-review", task: "one" }),
				second.dispatch({ model: reviewerModel(), alias: "shared-review", task: "two" }),
			]);

			assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
			assert.equal((await store.list()).filter((instance) => instance.alias === "shared-review").length, 1);
			await first.shutdown();
			await second.shutdown();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("stops a created worker when instance persistence fails", async () => {
		const worker = new FakeWorker("session-1", "/tmp/session-1.jsonl");
		const broker = new SessionBroker({
			store: {
				get: async () => undefined,
				put: async () => { throw new Error("store failed"); },
				delete: async () => undefined,
				list: async () => [],
			},
			roster: new MemoryRoster(),
			workerFactory: async () => worker,
		});

		await assert.rejects(() => broker.attach({ model: reviewerModel(), alias: "auth-review" }), /store failed/);
		assert.equal(worker.stopped, true);
	});
});

test("team prepare can reject aliases that a new persistent member could not claim", async () => {
	const broker = new SessionBroker({ store: new MemoryInstanceStore(), roster: new MemoryRoster(), workerFactory: async () => new FakeWorker("taken", "/tmp/taken.jsonl") });
	try {
		await broker.dispatch({ model: reviewerModel(), alias: "taken", task: "work" });
		await assert.rejects(broker.assertAliasesAvailable(["free", "taken"]), /alias already exists: taken\. Team members need new aliases/u);
		await broker.assertAliasesAvailable(["free", "other"]);
	} finally { await broker.shutdown(); }
});

test("a child that outlives SIGKILL keeps its session file until it is reaped", async () => {
	const dir = await mkdtemp(join(tmpdir(), "rail-unreaped-"));
	try {
		for (const path of ["cleanup", "delete"] as const) {
			const sessionFile = join(dir, `${path}.jsonl`);
			await writeFile(sessionFile, "{}\n");
			let reap!: () => void;
			const exited = new Promise<void>((resolve) => { reap = resolve; });
			const worker = new FakeWorker(`session-${path}`, sessionFile);
			worker.stop = async () => { throw new RpcProcessExitTimeoutError("did not exit after SIGKILL", exited); };
			const store = new MemoryInstanceStore();
			const broker = new SessionBroker({ store, roster: new MemoryRoster(), workerFactory: async () => worker });
			if (path === "cleanup") {
				// A team member that never passed a gate is removed, but its file waits for the reap.
				worker.send = async () => { throw new Error("Startup admission deadline exceeded"); };
				const team = {
					binding: { version: 1 as const, teamId: "team", memberId: "B", role: "worker" as const, epoch: "private" },
					onRequest: async () => ({ ok: true }), started: () => false,
				};
				await assert.rejects(broker.dispatch({ model: reviewerModel(), alias: "B", task: "work", team }), /admission/u);
				assert.equal(store.instances.size, 0, "the descriptor and alias are released");
			} else {
				await broker.dispatch({ model: reviewerModel(), alias: "D", task: "work" });
				await assert.rejects(broker.delete("D"), /did not exit after SIGKILL/u);
				await assert.rejects(broker.delete("D"), /has not exited yet; retry delete after it is reaped/u);
			}
			await access(sessionFile);
			reap();
			await new Promise((resolve) => setTimeout(resolve, 20));
			if (path === "cleanup") await assert.rejects(access(sessionFile), /ENOENT/u);
			else {
				await broker.delete("D");
				await assert.rejects(access(sessionFile), /ENOENT/u);
			}
			await broker.shutdown();
		}
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("a cleanup that races an in-flight stop waits for its outcome before removing the session file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "rail-stop-race-"));
	try {
		const sessionFile = join(dir, "race.jsonl");
		await writeFile(sessionFile, "{}\n");
		let reap!: () => void;
		const exited = new Promise<void>((resolve) => { reap = resolve; });
		let sendStarted!: () => void;
		const sending = new Promise<void>((resolve) => { sendStarted = resolve; });
		let rejectSend!: (error: Error) => void;
		let timeOut!: () => void;
		const worker = new FakeWorker("session-race", sessionFile);
		worker.send = () => new Promise((_resolve, reject) => { rejectSend = reject; sendStarted(); });
		worker.stop = () => {
			rejectSend(new Error("Subagent RPC process stopped"));
			return new Promise((_resolve, reject) => { timeOut = () => reject(new RpcProcessExitTimeoutError("did not exit after SIGKILL", exited)); });
		};
		const store = new MemoryInstanceStore();
		const broker = new SessionBroker({ store, roster: new MemoryRoster(), workerFactory: async () => worker });
		const team = {
			binding: { version: 1 as const, teamId: "team", memberId: "B", role: "worker" as const, epoch: "private" },
			onRequest: async () => ({ ok: true }), started: () => false,
		};
		const dispatching = broker.dispatch({ model: reviewerModel(), alias: "B", task: "work", team }).then(() => undefined, (error: Error) => error);
		await sending;
		const stopping = broker.stop("B").catch(() => undefined);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await access(sessionFile);
		timeOut();
		assert.match(String(await dispatching), /stopped/u);
		await stopping;
		await access(sessionFile);
		reap();
		await new Promise((resolve) => setTimeout(resolve, 20));
		await assert.rejects(access(sessionFile), /ENOENT/u);
		await broker.shutdown();
	} finally { await rm(dir, { recursive: true, force: true }); }
});
