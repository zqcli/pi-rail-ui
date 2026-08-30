import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
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

class MemoryInstanceStore implements AgentInstanceStore {
	readonly instances = new Map<string, AgentInstance>();
	getDelayMs = 0;

	async get(agentId: string): Promise<AgentInstance | undefined> {
		if (this.getDelayMs) await new Promise((resolve) => setTimeout(resolve, this.getDelayMs));
		return this.instances.get(agentId);
	}

	async put(instance: AgentInstance): Promise<void> {
		this.instances.set(instance.agentId, structuredClone(instance));
	}

	async delete(agentId: string): Promise<void> {
		this.instances.delete(agentId);
	}

	async list(): Promise<AgentInstance[]> {
		return Array.from(this.instances.values());
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

	constructor(
		readonly sessionId: string,
		readonly sessionFile: string,
	) {}

	async send(task: string, _options?: WorkerSendOptions): Promise<WorkerRunResult> {
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		_options?.onAccepted?.();
		this.tasks.push(task);
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
		if (this.controlDelayMs) await new Promise((resolve) => setTimeout(resolve, this.controlDelayMs));
		if (request.message === this.unknownControlMessage) throw new WorkerControlError("ack lost", "unknown");
		this.controls.push(request);
	}
}

function emptyUsage() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 };
}

function reviewerModel(): RailModelRef {
	return { provider: "cus-resp", modelId: "gpt-5.6-sol", thinkingLevel: "xhigh" };
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

	test("publishes persistent identity and model before the child produces output", async () => {
		const { broker } = setup();
		const created = await broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "initial" });
		const progress: DispatchProgress[] = [];

		await broker.dispatch({ target: "auth-review", task: "continue", onUpdate: (update) => progress.push(update) });

		assert.equal(progress[0]?.instance.agentId, created.instance.agentId);
		assert.equal(progress[0]?.instance.sessionId, created.instance.sessionId);
		assert.deepEqual(progress[0]?.instance.model, reviewerModel());
		assert.equal(progress[0]?.run.output, "(starting...)");
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
			};
			await store.put(saved);
			roster.link(saved.alias, saved.agentId);
			const broker = new SessionBroker({ store, roster, workerFactory: async () => new FakeWorker(saved.sessionId, sessionFile) });

			await broker.delete(saved.agentId);

			assert.equal(await store.get(saved.agentId), undefined);
			assert.equal(roster.resolve(saved.alias), undefined);
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
