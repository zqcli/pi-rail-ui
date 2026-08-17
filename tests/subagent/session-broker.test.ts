import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	SessionBroker,
	type AgentInstance,
	type AgentInstanceStore,
	type AgentRoster,
	type SessionWorker,
	type SessionWorkerFactory,
	type DispatchProgress,
	type WorkerRunResult,
	type WorkerStartSpec,
} from "../../subagent/session-broker";
import type { RailModelRef } from "../../subagent/models";

class MemoryInstanceStore implements AgentInstanceStore {
	readonly instances = new Map<string, AgentInstance>();

	async get(agentId: string): Promise<AgentInstance | undefined> {
		return this.instances.get(agentId);
	}

	async put(instance: AgentInstance): Promise<void> {
		this.instances.set(instance.agentId, structuredClone(instance));
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
	active = 0;
	maxActive = 0;
	stopped = false;

	constructor(
		readonly sessionId: string,
		readonly sessionFile: string,
	) {}

	async send(task: string): Promise<WorkerRunResult> {
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		this.tasks.push(task);
		await new Promise((resolve) => setTimeout(resolve, 5));
		this.active--;
		return { output: `done: ${task}`, usage: emptyUsage() };
	}

	async stop(): Promise<void> {
		this.stopped = true;
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
	const broker = new SessionBroker({ store, roster, workerFactory });
	return { broker, store, roster, starts, workers, workerFactory };
}

describe("SessionBroker", () => {
	test("creates a persistent instance and reuses it by alias", async () => {
		const { broker, store, roster, starts, workers } = setup();

		const first = await broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "review auth" });
		const second = await broker.dispatch({ target: "auth-review", task: "check tests" });

		assert.equal(first.instance.alias, "auth-review");
		assert.equal(second.instance.agentId, first.instance.agentId);
		assert.equal(roster.resolve("auth-review"), first.instance.agentId);
		assert.equal((await store.get(first.instance.agentId))?.sessionFile, "/tmp/session-1.jsonl");
		assert.deepEqual(starts.map((start) => start.mode), ["new"]);
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

	test("reopens the saved child session after the broker restarts", async () => {
		const { broker, store, roster, workerFactory, starts } = setup();
		const first = await broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "review auth" });
		await broker.shutdown();

		const restarted = new SessionBroker({ store, roster, workerFactory });
		const resumed = await restarted.dispatch({ target: "auth-review", task: "continue" });

		assert.equal(resumed.instance.agentId, first.instance.agentId);
		assert.equal(starts.at(-1)?.mode, "open");
		assert.equal(starts.at(-1)?.sessionPath, first.instance.sessionFile);
	});

	test("links a globally addressed agentId into the current parent roster", async () => {
		const { broker, store, workerFactory } = setup();
		const first = await broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "review auth" });
		await broker.shutdown();
		const emptyRoster = new MemoryRoster();
		const restarted = new SessionBroker({ store, roster: emptyRoster, workerFactory });

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

	test("single-flights worker startup before serializing concurrent messages after restart", async () => {
		const { broker, store, roster, workerFactory, starts, workers } = setup();
		await broker.dispatch({ model: reviewerModel(), alias: "auth-review", task: "initial" });
		await broker.shutdown();
		const restarted = new SessionBroker({ store, roster, workerFactory });

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

	test("stops a created worker when instance persistence fails", async () => {
		const worker = new FakeWorker("session-1", "/tmp/session-1.jsonl");
		const broker = new SessionBroker({
			store: {
				get: async () => undefined,
				put: async () => { throw new Error("store failed"); },
				list: async () => [],
			},
			roster: new MemoryRoster(),
			workerFactory: async () => worker,
		});

		await assert.rejects(() => broker.attach({ model: reviewerModel(), alias: "auth-review" }), /store failed/);
		assert.equal(worker.stopped, true);
	});
});
