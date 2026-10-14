import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import installPauseGate from "../../tools/subagents/pause-extension";
import { PAUSE_ENTRY_TYPE, PAUSE_GATE_FLAG, PauseGate, pauseStatusText, SubagentPauseRegistry } from "../../tools/subagents/pause";
import { nextRailRetry, RETRY_DELAYS_MS, waitBeforeRetry } from "../../tools/subagents/retry";

async function scratch(t: { after(fn: () => Promise<void>): void }): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "rail-pause-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function parkedEvent(parked: boolean) {
	return { type: "entry_appended", entry: { type: "custom", customType: PAUSE_ENTRY_TYPE, data: { parked } } };
}

test("a pause stays requested while the child runs and is confirmed once it parks or goes idle", async (t) => {
	const file = join(await scratch(t), "gate");
	await writeFile(file, "");
	const gate = new PauseGate(file, () => 1_000);
	assert.equal(existsSync(file), false, "a stale gate from a crashed parent never holds a new child");
	gate.setRunning(true);
	assert.equal(gate.pause(), true);
	assert.equal(gate.pause(), false);
	assert.equal(existsSync(file), true);
	assert.deepEqual(gate.paused, { state: "requested", since: 1_000 });
	assert.equal(gate.observe(parkedEvent(true)), true);
	assert.deepEqual(gate.paused, { state: "confirmed", since: 1_000 });
	assert.equal(gate.observe({ type: "message_end" }), false);
	gate.observe(parkedEvent(false));
	assert.equal(gate.paused?.state, "requested");
	gate.setRunning(false);
	assert.equal(gate.paused?.state, "confirmed");
	assert.equal(gate.resume(), true);
	assert.equal(gate.resume(), false);
	assert.equal(existsSync(file), false);
	assert.equal(gate.paused, undefined);
});

test("a retry waits out its backoff and then any pause, and abort ends the wait", async (t) => {
	const gate = new PauseGate(join(await scratch(t), "gate"));
	assert.equal(nextRailRetry("503", RETRY_DELAYS_MS.length), undefined);
	assert.deepEqual(nextRailRetry("503", 1, 0), { delayMs: 30_000, retry: { attempt: 2, maxAttempts: 5, nextAt: 30_000, error: "503", source: "rail" } });
	gate.setRunning(true);
	gate.pause();
	let done = false;
	const waiting = waitBeforeRetry(10, undefined, gate, async () => undefined).then(() => { done = true; });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(done, false);
	assert.equal(gate.paused?.state, "confirmed", "a parent waiting between attempts counts as parked");
	gate.resume();
	await waiting;
	assert.equal(done, true);

	gate.pause();
	const controller = new AbortController();
	const aborted = gate.waitUntilResumed(controller.signal);
	controller.abort();
	await assert.rejects(aborted, { name: "AbortError" });
});

test("the registry pauses every live gate and runs that start before resumeAll", async (t) => {
	const dir = await scratch(t);
	const registry = new SubagentPauseRegistry();
	const first = new PauseGate(join(dir, "a"));
	const unregister = registry.register({ gate: first, label: "a" });
	assert.equal(registry.pauseAll(), 1);
	const second = new PauseGate(join(dir, "b"));
	registry.register({ gate: second, label: "b" });
	assert.equal(second.paused?.state, "confirmed");
	assert.equal(registry.resumeAll(), 2);
	assert.equal(first.paused, undefined);
	unregister();
	assert.deepEqual(registry.list().map((target) => target.label), ["b"]);
	assert.equal(pauseStatusText({ state: "requested", since: 0 }), "Pausing · finishing current step");
	assert.equal(pauseStatusText({ state: "confirmed", since: 0 }, 125_000), "Paused · 2m");
});

test("the child extension holds provider requests and tool calls while the gate file exists", async (t) => {
	const file = join(await scratch(t), "gate");
	const handlers = new Map<string, (event: unknown, ctx: { signal?: AbortSignal }) => Promise<void>>();
	const entries: unknown[] = [];
	installPauseGate({
		registerFlag: () => undefined,
		getFlag: (name: string) => name === PAUSE_GATE_FLAG ? file : undefined,
		appendEntry: (type: string, data: unknown) => { entries.push({ type, data }); },
		on: (event: string, handler: (event: unknown, ctx: { signal?: AbortSignal }) => Promise<void>) => { handlers.set(event, handler); },
	} as never);
	await handlers.get("context")!({}, {});
	assert.deepEqual(entries, [], "an open gate passes without entries");

	await writeFile(file, "");
	let released = 0;
	const context = handlers.get("context")!({}, {}).then(() => { released++; });
	const tool = handlers.get("tool_call")!({}, {}).then(() => { released++; });
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(released, 0);
	assert.deepEqual(entries, [{ type: PAUSE_ENTRY_TYPE, data: { parked: true } }], "one entry for any number of held calls");
	await rm(file);
	await Promise.all([context, tool]);
	assert.equal(released, 2);
	assert.deepEqual(entries.at(-1), { type: PAUSE_ENTRY_TYPE, data: { parked: false } });

	await writeFile(file, "");
	const controller = new AbortController();
	const aborted = handlers.get("context")!({}, { signal: controller.signal });
	controller.abort();
	await aborted;
	assert.equal(entries.length, 4);
});
