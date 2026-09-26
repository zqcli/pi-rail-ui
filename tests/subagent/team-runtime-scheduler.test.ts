import assert from "node:assert/strict";
import { test } from "node:test";
import { TEAM_MAX_MANAGER_EVENT_BATCH } from "../../tools/subagents/team-protocol";
import { TeamRuntime, type RuntimeActivation, type TeamRuntimeExecutor } from "../../tools/subagents/team-runtime";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function makeRuntime(requestCount: number) {
	let ids = 0;
	const runtime = new TeamRuntime({ createId: () => `scheduler-${++ids}` });
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage work and close the Team." },
		workers: [{ alias: "w1", roleDescription: "Complete assigned work." }],
		brief: { goal: "Exercise Runtime-owned scheduling." },
		initialRequests: Array.from({ length: requestCount }, (_, index) => ({ to: "w1", task: `root ${index + 1}` })),
		timeoutSeconds: null,
	});
	return { runtime, teamId: prepared.teamId };
}

function apply(runtime: TeamRuntime, activation: RuntimeActivation, sequence: number, id: string, args: unknown) {
	const result = runtime.handleAction(activation.binding, activation.scope, sequence, `${activation.scope.activationId}:${id}`, args, id);
	assert.equal(result.ok, true, JSON.stringify(result));
	return result;
}

function finish(runtime: TeamRuntime, activation: RuntimeActivation, toolCallId: string) {
	const settled = runtime.nativeSettled(activation.binding, activation.scope.activationId, {
		status: "success", appliedToolCallId: toolCallId,
	});
	assert.equal(settled.ok, true, JSON.stringify(settled));
	const cleanup = runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true });
	assert.equal(cleanup.ok, true, JSON.stringify(cleanup));
}

async function flushOneTurn() {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

test("Runtime event drain reserves one same-member activation and schedules the next only after cleanup", { timeout: 10000 }, async () => {
	const { runtime, teamId } = makeRuntime(2);
	const firstWorkStarted = deferred();
	const firstWorkGate = deferred();
	const secondWorkStarted = deferred();
	const secondWorkGate = deferred();
	const finishQuiescence = deferred();
	const failures: unknown[] = [];
	const started: RuntimeActivation[] = [];
	const managerBatches: Array<Array<{ id: string; kind: string }>> = [];
	let workCount = 0;
	let completedManagement = 0;
	const executor: TeamRuntimeExecutor = {
		runActivation: async (activation) => {
			started.push(structuredClone(activation));
			try {
				const ready = runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId);
				assert.equal(ready.ok, true, JSON.stringify(ready));
				if (activation.scope.kind === "management") {
					assert.equal(activation.input.scope.kind, "management");
					const events = activation.input.scope.events;
					managerBatches.push(events.map(({ id, kind }) => ({ id, kind })));
					const hasQuiescence = events.some((event) => event.kind === "TEAM_QUIESCENT");
					const callId = `idle-${completedManagement++}`;
					apply(runtime, activation, 1, callId, { action: "yield" });
					finish(runtime, activation, callId);
					if (hasQuiescence) finishQuiescence.resolve();
					return;
				}
				workCount++;
				if (workCount === 1) {
					firstWorkStarted.resolve();
					await firstWorkGate.promise;
				} else if (workCount === 2) {
					secondWorkStarted.resolve();
					await secondWorkGate.promise;
				}
				const callId = `reply-${workCount}`;
				apply(runtime, activation, 1, callId, { action: "reply", result: { status: "succeeded", summary: `completed ${workCount}` } });
				finish(runtime, activation, callId);
			} catch (error) {
				failures.push(error);
				throw error;
			}
		},
		closeMember: async () => ({ ok: true }),
	};
	const detach = runtime.attachExecutor(teamId, executor);
	runtime.launch(teamId);
	assert.throws(() => runtime.takeNextActivation(teamId), /executor owns activation scheduling/u,
		"manual reservations cannot compete with the attached Runtime event drain");

	await firstWorkStarted.promise;
	await flushOneTurn();
	assert.equal(started.filter((activation) => activation.scope.kind === "work").length, 1,
		"the second same-member WorkRef stays queued behind the first native writer");
	assert.equal(runtime.getTeam(teamId).works.queued, 1);
	firstWorkGate.resolve();
	await secondWorkStarted.promise;
	assert.equal(started.filter((activation) => activation.scope.kind === "work").length, 2);
	secondWorkGate.resolve();
	await finishQuiescence.promise;
	await flushOneTurn();

	assert.equal(runtime.getTeam(teamId).lifecycle, "active");
	assert.equal(runtime.getTeam(teamId).works.resolved, 2);
	assert.equal(managerBatches.flat().filter((event) => event.kind === "TEAM_QUIESCENT").length, 1);
	const countAtIdle = started.length;
	await flushOneTurn();
	assert.equal(started.length, countAtIdle, "Runtime does not poll an idle Team or repeat unchanged quiescence");
	assert.deepEqual(failures, []);
	runtime.assertInvariants(teamId);
	assert.throws(detach, /terminal lifecycle/u);
});

test("Manager event batches are finite and semantic quiescence remains idle without repeated execution", { timeout: 15000 }, async () => {
	const { runtime, teamId } = makeRuntime(0);
	const heldManager = deferred();
	const releaseManager = deferred();
	const allWorkSettled = deferred();
	const quiescenceSettled = deferred();
	const failures: unknown[] = [];
	const managerBatches: Array<Array<{ id: string; kind: string }>> = [];
	let requested = false;
	let held = false;
	let completedWork = 0;
	const executor: TeamRuntimeExecutor = {
		runActivation: async (activation) => {
			try {
				const ready = runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId);
				assert.equal(ready.ok, true, JSON.stringify(ready));
				if (activation.scope.kind === "management") {
					assert.equal(activation.input.scope.kind, "management");
					const events = activation.input.scope.events;
					if (events.some((event) => event.kind === "BOOT")) {
						assert.equal(requested, false);
						requested = true;
						for (let index = 0; index < 20; index++) {
							apply(runtime, activation, index + 1, `request-${index}`, {
								action: "request", to: "w1", task: `root ${index + 1}`,
							});
						}
						apply(runtime, activation, 21, "boot-yield", { action: "yield" });
						finish(runtime, activation, "boot-yield");
						return;
					}
					managerBatches.push(events.map(({ id, kind }) => ({ id, kind })));
					if (!held && events.some((event) => event.kind === "ROOT_RESULT_READY")) {
						held = true;
						heldManager.resolve();
						await releaseManager.promise;
					}
					const hasQuiescence = events.some((event) => event.kind === "TEAM_QUIESCENT");
					apply(runtime, activation, 1, `manager-yield-${managerBatches.length}`, { action: "yield" });
					finish(runtime, activation, `manager-yield-${managerBatches.length}`);
					if (hasQuiescence) quiescenceSettled.resolve();
					return;
				}
				const callId = `work-reply-${completedWork}`;
				apply(runtime, activation, 1, callId, {
					action: "reply", result: { status: "succeeded", summary: `root ${completedWork + 1} completed` },
				});
				finish(runtime, activation, callId);
				completedWork++;
				if (completedWork === 20) allWorkSettled.resolve();
			} catch (error) {
				failures.push(error);
				throw error;
			}
		},
		closeMember: async () => ({ ok: true }),
	};
	const detach = runtime.attachExecutor(teamId, executor);
	runtime.launch(teamId);

	await heldManager.promise;
	await allWorkSettled.promise;
	assert.equal(managerBatches.length, 1, "one Manager event batch is held while the workers continue independently");
	releaseManager.resolve();
	await quiescenceSettled.promise;
	await flushOneTurn();

	const eventBatches = managerBatches.slice(1);
	assert.ok(eventBatches.length >= 2);
	assert.ok(eventBatches.every((batch) => batch.length <= TEAM_MAX_MANAGER_EVENT_BATCH));
	assert.ok(eventBatches.some((batch) => batch.length === TEAM_MAX_MANAGER_EVENT_BATCH), "pending events are split at the finite batch limit");
	const deliveredEvents = managerBatches.flat().filter((event) => event.kind !== "BOOT");
	assert.equal(new Set(deliveredEvents.map((event) => event.id)).size, deliveredEvents.length, "each Manager event is delivered in at most one batch");
	assert.equal(deliveredEvents.filter((event) => event.kind === "TEAM_QUIESCENT").length, 1);
	assert.equal(runtime.getTeam(teamId).lifecycle, "active", "quiescence and all-idle do not automatically fail or close the Team");
	assert.equal(runtime.getTeam(teamId).works.resolved, 20);
	const countAtIdle = managerBatches.length;
	await flushOneTurn();
	assert.equal(managerBatches.length, countAtIdle, "idle does not poll or re-enqueue the same semantic quiescence");
	assert.deepEqual(failures, []);
	runtime.assertInvariants(teamId);
	assert.throws(detach, /terminal lifecycle/u, "a live Team keeps its sole executor attached");
});

test("new Manager events stay in the next sealed batch and faults outrank incidents stably", { timeout: 10000 }, async () => {
	let ids = 0;
	const runtime = new TeamRuntime({ createId: () => `priority-${++ids}` });
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage events." },
		workers: [
			{ alias: "w1", roleDescription: "Return one successful result." },
			{ alias: "w2", roleDescription: "Inject a local worker fault." },
			{ alias: "w3", roleDescription: "Inject another local worker fault." },
		],
		brief: { goal: "Verify sealed Manager batch ordering." },
		initialRequests: [
			{ to: "w1", task: "successful root" },
			{ to: "w2", task: "faulted root two" },
			{ to: "w3", task: "faulted root three" },
		],
		timeoutSeconds: null,
	});
	const managerHeld = deferred();
	const releaseManager = deferred();
	const worker2Started = deferred();
	const worker3Started = deferred();
	const failWorker2 = deferred();
	const failWorker3 = deferred();
	const worker2Failed = deferred();
	const worker3Failed = deferred();
	const secondManagerBatchSettled = deferred();
	const managerBatches: Array<Array<{ id: string; kind: string; memberId?: string }>> = [];
	const failures: unknown[] = [];
	let managementRuns = 0;
	const runtimeExecutor: TeamRuntimeExecutor = {
		runActivation: async (activation) => {
			try {
				const inputReady = runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId);
				assert.equal(inputReady.ok, true, JSON.stringify(inputReady));
				if (activation.scope.kind === "management") {
					assert.equal(activation.input.scope.kind, "management");
					const events = activation.input.scope.events;
					if (events.some((event) => event.kind === "BOOT")) {
						apply(runtime, activation, 1, "boot-yield", { action: "yield" });
						finish(runtime, activation, "boot-yield");
						return;
					}
					managementRuns++;
					managerBatches.push(events.map(({ id, kind, memberId }) => ({ id, kind, ...(memberId ? { memberId } : {}) })));
					if (managementRuns === 1) {
						managerHeld.resolve();
						await releaseManager.promise;
					}
					const hasFaults = events.filter((event) => event.kind === "MEMBER_FAULTED").length === 2;
					const callId = `manager-yield-${managementRuns}`;
					apply(runtime, activation, 1, callId, { action: "yield" });
					finish(runtime, activation, callId);
					if (hasFaults) secondManagerBatchSettled.resolve();
					return;
				}
				if (activation.binding.memberId === "w1") {
					apply(runtime, activation, 1, "w1-reply", { action: "reply", result: { status: "succeeded", summary: "w1 done" } });
					finish(runtime, activation, "w1-reply");
					return;
				}
			const memberId = activation.binding.memberId;
			if (memberId === "w2") {
				worker2Started.resolve();
				await failWorker2.promise;
			} else {
				worker3Started.resolve();
				await failWorker3.promise;
			}
			const lost = runtime.activationLost(activation.binding, activation.scope.activationId,
				{ code: "SYNTHETIC_WORKER_FAULT", message: `${memberId} stopped before settlement` }, true);
			assert.equal(lost.ok, true, JSON.stringify(lost));
			(memberId === "w2" ? worker2Failed : worker3Failed).resolve();
			} catch (error) {
				failures.push(error);
				throw error;
			}
		},
		closeMember: async () => ({ ok: true }),
	};
	runtime.attachExecutor(prepared.teamId, runtimeExecutor);
	runtime.launch(prepared.teamId);

	await Promise.all([managerHeld.promise, worker2Started.promise, worker3Started.promise]);
	assert.deepEqual(managerBatches[0]!.map((event) => event.kind), ["ROOT_RESULT_READY"],
		"the running Manager activation keeps its immutable event batch");
	failWorker2.resolve();
	await worker2Failed.promise;
	failWorker3.resolve();
	await worker3Failed.promise;
	releaseManager.resolve();
	await secondManagerBatchSettled.promise;

	const nextBatch = managerBatches[1]!;
	assert.deepEqual(nextBatch.map((event) => event.kind), [
		"MEMBER_FAULTED", "MEMBER_FAULTED", "DEPENDENCY_UNAVAILABLE", "DEPENDENCY_UNAVAILABLE", "TEAM_QUIESCENT",
	]);
	assert.deepEqual(nextBatch.filter((event) => event.kind === "MEMBER_FAULTED").map((event) => event.memberId), ["w2", "w3"],
		"equal-priority faults retain event creation order");
	assert.equal(new Set([...managerBatches.flat().map((event) => event.id)]).size, managerBatches.flat().length,
		"events raised during a running activation are delivered once in a later batch");
	assert.deepEqual(failures, []);
	runtime.assertInvariants(prepared.teamId);
});

test("an internal memberReleased exception is observable as failed and does not become an unhandled effect rejection", { timeout: 10000 }, async () => {
	const { runtime, teamId } = makeRuntime(0);
	const closeCalls: string[] = [];
	let managerRuns = 0;
	const executor: TeamRuntimeExecutor = {
		runActivation: async (activation) => {
			const ready = runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId);
			assert.equal(ready.ok, true, JSON.stringify(ready));
			const callId = `internal-close-${managerRuns++}`;
			const args = managerRuns === 1 ? { action: "yield" }
				: { action: "control", command: "close_team", resultRefs: [], outcome: "failed", reason: "test close" };
			apply(runtime, activation, 1, callId, args);
			finish(runtime, activation, callId);
		},
		closeMember: async (binding) => { closeCalls.push(binding.memberId); return { ok: true }; },
	};
	const reportRelease = runtime.memberReleased.bind(runtime);
	runtime.memberReleased = (binding, closeId, result) => {
		if (binding.memberId === "w1") throw new Error("injected memberReleased runtime failure");
		return reportRelease(binding, closeId, result);
	};
	runtime.attachExecutor(teamId, executor);
	const lifetime = runtime.waitForCompletion(teamId);
	runtime.launch(teamId);
	const result = await lifetime;

	assert.equal(result.lifecycle, "failed");
	assert.match(result.reason ?? "", /member exit report processing failed.*injected memberReleased runtime failure/u);
	assert.deepEqual(closeCalls.sort(), ["lead", "w1"], "the independent Manager exit effect still settles");
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "w1")?.resourceState, "cleanup_failed");
	runtime.assertInvariants(teamId);
});

test("G10: Manager native failure parks workers and HostControl cancels without another Manager activation", { timeout: 10000 }, async () => {
	let ids = 0;
	const runtime = new TeamRuntime({ createId: () => `manager-fault-${++ids}`, activationStopTimeoutMs: 250 });
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage work." },
		workers: [{ alias: "w1", roleDescription: "First worker." }, { alias: "w2", roleDescription: "Second worker." }],
		brief: { goal: "Verify Manager fault containment." },
		initialRequests: [{ to: "w1", task: "worker one" }, { to: "w2", task: "worker two" }],
		timeoutSeconds: null,
	});
	const closeCalls: string[] = [];
	const stopped: string[] = [];
	const failures: unknown[] = [];
	let managerRuns = 0;
	const executor: TeamRuntimeExecutor = {
		runActivation: async (activation) => {
			try {
				const ready = runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId);
				assert.equal(ready.ok, true, JSON.stringify(ready));
				if (activation.scope.kind === "management") {
					managerRuns++;
					assert.equal(runtime.nativeSettled(activation.binding, activation.scope.activationId, {
						status: "error", error: { code: "SYNTHETIC_MANAGER_FAILURE", message: "Manager provider failed" },
					}).ok, true);
					assert.equal(runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true }).ok, true);
					return;
				}
				const decision = await runtime.waitAtProviderGate(activation.binding, activation.scope);
				assert.equal(decision.allow, false, "a faulted Manager cannot allow new worker provider effects");
				assert.equal(runtime.nativeSettled(activation.binding, activation.scope.activationId, { status: "aborted" }).ok, true);
				assert.equal(runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true }).ok, true);
			} catch (error) {
				failures.push(error);
				throw error;
			}
		},
		stopActivation: (_binding, activationId) => { stopped.push(activationId); },
		closeMember: async (binding) => { closeCalls.push(binding.memberId); return { ok: true }; },
	};
	runtime.attachExecutor(prepared.teamId, executor);
	const lifetime = runtime.waitForCompletion(prepared.teamId);
	runtime.launch(prepared.teamId);
	for (let attempt = 0; attempt < 100; attempt++) {
		const members = runtime.getTeam(prepared.teamId).members;
		if (members.find((member) => member.id === "lead")?.lifecycle === "faulted"
			&& members.filter((member) => member.role === "worker").every((member) => member.pause === "confirmed")) break;
		await flushOneTurn();
	}
	const beforeCancel = runtime.getTeam(prepared.teamId);
	assert.equal(beforeCancel.members.find((member) => member.id === "lead")?.lifecycle, "faulted");
	assert.ok(beforeCancel.members.filter((member) => member.role === "worker").every((member) => member.pause === "confirmed"));
	const receipt = runtime.hostControl(prepared.teamId).cancel_team("Host canceled after Manager fault");
	assert.equal(receipt.actor, "@host");
	const result = await lifetime;
	assert.equal(result.lifecycle, "cancelled");
	assert.equal(result.outcome, undefined, "host cancellation is not a business outcome");
	assert.deepEqual(result.members.find((member) => member.id === "lead"), { id: "lead", role: "manager", lifecycle: "faulted", resourceState: "released" },
		"the faulted Manager's resource is released but its fault is not rewritten as a normal close");
	assert.equal(managerRuns, 1, "host cancellation does not wait for a replacement/second Manager LLM turn");
	assert.deepEqual(closeCalls.sort(), ["lead", "w1", "w2"]);
	assert.equal(stopped.length, 2, "both active worker scopes receive activation-only cancellation");
	assert.deepEqual(failures, []);
	runtime.assertInvariants(prepared.teamId);
});

test("X08: deadline starts at launch, user cancellation wins later deadline, and an earlier close decision is retained", { timeout: 10000 }, async () => {
	let ids = 0;
	const runtime = new TeamRuntime({ createId: () => `deadline-${++ids}` });
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage and close." },
		workers: [{ alias: "w1", roleDescription: "Work." }],
		brief: { goal: "Verify launch-admitted deadline." },
		timeoutSeconds: 1,
	});
	const quiescenceSettled = deferred();
	const closed: string[] = [];
	let managerRuns = 0;
	const executor: TeamRuntimeExecutor = {
		runActivation: async (activation) => {
			const ready = runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId);
			assert.equal(ready.ok, true, JSON.stringify(ready));
			assert.equal(activation.scope.kind, "management");
			if (activation.input.scope.kind !== "management") throw new Error("Expected Manager activation input");
			const quiescent = activation.input.scope.events.some((event) => event.kind === "TEAM_QUIESCENT");
			const callId = `deadline-yield-${managerRuns++}`;
			apply(runtime, activation, 1, callId, { action: "yield" });
			finish(runtime, activation, callId);
			if (quiescent) quiescenceSettled.resolve();
		},
		closeMember: async (binding) => { closed.push(binding.memberId); return { ok: true }; },
	};
	runtime.attachExecutor(prepared.teamId, executor);
	const lifetime = runtime.waitForCompletion(prepared.teamId);
	await new Promise((resolve) => setTimeout(resolve, 1100));
	assert.equal(runtime.getTeam(prepared.teamId).lifecycle, "prepared", "prepare time does not consume the Team deadline");
	runtime.launch(prepared.teamId);
	await quiescenceSettled.promise;
	assert.equal(runtime.getTeam(prepared.teamId).lifecycle, "active");
	const first = runtime.hostControl(prepared.teamId).cancel_team("explicit user cancellation wins");
	assert.equal(first.status, "applied");
	const cancelled = await lifetime;
	assert.equal(cancelled.lifecycle, "cancelled");
	assert.equal(cancelled.reason, "explicit user cancellation wins");
	await new Promise((resolve) => setTimeout(resolve, 1050));
	assert.equal(runtime.getTeam(prepared.teamId).lifecycle, "cancelled", "the cleared deadline cannot replace the first terminal reason");
	assert.deepEqual(closed.sort(), ["lead", "w1"]);
	assert.equal(managerRuns, 2);

	const closeRuntime = new TeamRuntime();
	const closing = closeRuntime.prepare({
		manager: { alias: "lead", roleDescription: "Manage and close." }, workers: [{ alias: "w1", roleDescription: "Work." }],
		brief: { goal: "Verify close wins the terminal decision." }, timeoutSeconds: null,
	});
	closeRuntime.launch(closing.teamId);
	const manager = closeRuntime.takeNextActivation(closing.teamId)!;
	assert.equal(closeRuntime.inputReady(manager.binding, manager.scope.activationId, manager.deliveryId).ok, true);
	const closeId = "first-close-decision";
	const staged = closeRuntime.handleAction(manager.binding, manager.scope, 1, closeId,
		{ action: "control", command: "close_team", resultRefs: [], outcome: "failed", reason: "close won first" }, closeId);
	assert.equal(staged.ok && staged.receipt?.status, "closing");
	closeRuntime.nativeSettled(manager.binding, manager.scope.activationId, { status: "success", appliedToolCallId: closeId });
	closeRuntime.cleanupFinished(manager.binding, manager.scope.activationId, { ok: true });
	const ignoredCancel = closeRuntime.hostControl(closing.teamId).cancel_team("later cancellation");
	assert.equal(ignoredCancel.status, "unchanged");
	assert.equal(closeRuntime.getTeam(closing.teamId).lifecycle, "closing");
	assert.match(closeRuntime.getTeam(closing.teamId).reason ?? "", /close won first/u);
	closeRuntime.assertInvariants(closing.teamId);
});

test("X09/13.3: host cancel interrupts a running approved tool at once, then terminates a native run that never settles", { timeout: 10000 }, async () => {
	let ids = 0;
	const runtime = new TeamRuntime({ createId: () => `terminate-${++ids}`, activationStopTimeoutMs: 200 });
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage work." },
		workers: [{ alias: "w1", roleDescription: "Runs a tool that ignores abort." }],
		brief: { goal: "Verify interrupt-first cancellation and bounded process termination." },
		initialRequests: [{ to: "w1", task: "hang in a tool" }],
		timeoutSeconds: null,
	});
	const toolRunning = deferred();
	const stops: Array<{ activationId: string; reason: string; at: number }> = [];
	const terminations: Array<{ activationId: string; code: string; at: number }> = [];
	const closed: string[] = [];
	let hungActivation: RuntimeActivation | undefined;
	const executor: TeamRuntimeExecutor = {
		runActivation: async (activation) => {
			assert.equal(runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId).ok, true);
			if (activation.scope.kind === "management") {
				apply(runtime, activation, 1, "boot-yield", { action: "yield" });
				finish(runtime, activation, "boot-yield");
				return;
			}
			hungActivation = activation;
			assert.equal(runtime.gate(activation.binding, activation.scope, "tool_gate", "hung-tool", "bash").allow, true);
			toolRunning.resolve();
			// The native tool ignores Pi's abort; only process termination ends this send.
		},
		stopActivation: (_binding, activationId, reason) => { stops.push({ activationId, reason, at: Date.now() }); },
		terminateActivation: (binding, activationId, error) => {
			terminations.push({ activationId, code: error.code, at: Date.now() });
			// The driver reports the send's loss only after the process stop is confirmed.
			setImmediate(() => runtime.activationLost(binding, activationId, { ...error, message: `terminated: ${error.message}` }, true));
		},
		closeMember: async (binding) => { closed.push(binding.memberId); return { ok: true }; },
	};
	runtime.attachExecutor(prepared.teamId, executor);
	const lifetime = runtime.waitForCompletion(prepared.teamId);
	runtime.launch(prepared.teamId);
	await toolRunning.promise;
	const cancelledAt = Date.now();
	runtime.hostControl(prepared.teamId).cancel_team("user stop");
	assert.equal(stops.length, 1, "the stop is sent immediately instead of waiting for the approved tool to return");
	assert.equal(stops[0]!.reason, "policy_cancelled");
	assert.equal(terminations.length, 0);
	assert.equal(runtime.getTeam(prepared.teamId).members.find((member) => member.id === "w1")?.activity, "running",
		"memory state does not pretend the native run ended");
	const result = await lifetime;
	assert.equal(terminations.length, 1, "a missed stop bound escalates to process termination");
	assert.equal(terminations[0]!.activationId, hungActivation!.scope.activationId);
	assert.equal(terminations[0]!.code, "NATIVE_OUTCOME_UNKNOWN");
	assert.ok(terminations[0]!.at - cancelledAt >= 150);
	assert.equal(result.lifecycle, "cancelled");
	assert.equal(result.reason, "user stop");
	const worker = result.members.find((member) => member.id === "w1")!;
	assert.deepEqual({ lifecycle: worker.lifecycle, resourceState: worker.resourceState }, { lifecycle: "faulted", resourceState: "released" });
	assert.deepEqual(closed, ["lead"], "the terminated worker is not also reported as a clean close");
	runtime.assertInvariants(prepared.teamId);
});

test("6.1/6.3: prepared cancel closes only claimed lifetimes and keeps an unconfirmed exit as cleanup_failed", { timeout: 10000 }, async () => {
	const runtime = new TeamRuntime();
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage." },
		workers: [{ alias: "w1", roleDescription: "Opened worker." }, { alias: "w2", roleDescription: "Never opened." }],
		brief: { goal: "Cancel a partially opened prepared Team." },
		initialRequests: [{ to: "w1", task: "never starts" }],
		timeoutSeconds: null,
	});
	runtime.claimNativeLifetime(prepared.teamId, "lead");
	runtime.claimNativeLifetime(prepared.teamId, "w1");
	const closeCalls: string[] = [];
	let activations = 0;
	runtime.attachExecutor(prepared.teamId, {
		runActivation: async () => { activations++; },
		closeMember: async (binding) => {
			closeCalls.push(binding.memberId);
			return binding.memberId === "w1"
				? { ok: false, error: { code: "CLEANUP_FAILED", message: "w1 exit not confirmed", outcomeUnknown: true } }
				: { ok: true };
		},
	});
	runtime.hostControl(prepared.teamId).cancel_team("policy changed before launch");
	const result = await runtime.waitForCompletion(prepared.teamId);
	assert.equal(activations, 0, "no provider activation is ever reserved");
	assert.deepEqual(closeCalls.sort(), ["lead", "w1"]);
	assert.equal(result.lifecycle, "cancelled");
	assert.deepEqual(result.members.map(({ id, lifecycle, resourceState }) => ({ id, lifecycle, resourceState })), [
		{ id: "lead", lifecycle: "closed", resourceState: "released" },
		{ id: "w1", lifecycle: "faulted", resourceState: "cleanup_failed" },
		{ id: "w2", lifecycle: "closed", resourceState: "released" },
	]);
	runtime.assertInvariants(prepared.teamId);
});

test("14.4/19.2: a worker native_failure keeps faulted history when host cancel releases its still-owned resource", { timeout: 10000 }, async () => {
	let ids = 0;
	const runtime = new TeamRuntime({ createId: () => `worker-fault-${++ids}` });
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage work." },
		workers: [{ alias: "w1", roleDescription: "Fails natively." }, { alias: "w2", roleDescription: "Healthy." }],
		brief: { goal: "Keep a faulted worker faulted through host cleanup." },
		initialRequests: [{ to: "w1", task: "provider fails" }],
		timeoutSeconds: null,
	});
	const workerFailed = deferred();
	const closed: string[] = [];
	const executor: TeamRuntimeExecutor = {
		runActivation: async (activation) => {
			assert.equal(runtime.inputReady(activation.binding, activation.scope.activationId, activation.deliveryId).ok, true);
			if (activation.scope.kind === "management") {
				apply(runtime, activation, 1, "yield", { action: "yield" });
				finish(runtime, activation, "yield");
				return;
			}
			assert.equal(runtime.nativeSettled(activation.binding, activation.scope.activationId, {
				status: "error", error: { code: "UPSTREAM", message: "provider failed" } }).ok, true);
			assert.equal(runtime.cleanupFinished(activation.binding, activation.scope.activationId, { ok: true }).ok, true);
			workerFailed.resolve();
		},
		closeMember: async (binding) => { closed.push(binding.memberId); return { ok: true }; },
	};
	runtime.attachExecutor(prepared.teamId, executor);
	const lifetime = runtime.waitForCompletion(prepared.teamId);
	runtime.launch(prepared.teamId);
	await workerFailed.promise;
	for (let attempt = 0; attempt < 100 && runtime.getTeam(prepared.teamId).members.some((member) => member.activity !== "idle"); attempt++) await flushOneTurn();
	const faulted = runtime.getTeam(prepared.teamId).members.find((member) => member.id === "w1")!;
	assert.deepEqual({ lifecycle: faulted.lifecycle, resourceState: faulted.resourceState }, { lifecycle: "faulted", resourceState: "owned" });
	runtime.hostControl(prepared.teamId).cancel_team("host cleanup after worker fault");
	const result = await lifetime;
	assert.equal(result.lifecycle, "cancelled");
	assert.equal(result.outcome, undefined);
	assert.deepEqual(result.members.map(({ id, lifecycle, resourceState }) => ({ id, lifecycle, resourceState })), [
		{ id: "lead", lifecycle: "closed", resourceState: "released" },
		{ id: "w1", lifecycle: "faulted", resourceState: "released" },
		{ id: "w2", lifecycle: "closed", resourceState: "released" },
	]);
	assert.deepEqual(closed.sort(), ["lead", "w1", "w2"], "the still-owned faulted resource is really closed");
	assert.equal(runtime.getTeam(prepared.teamId).members.find((member) => member.id === "w1")?.error?.code, "UPSTREAM", "the fault record is kept");
	runtime.assertInvariants(prepared.teamId);
});

test("memberExitConfirmed accepts only an exact faulted unknown-exit lifetime", () => {
	const runtime = new TeamRuntime();
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage." }, workers: [{ alias: "w1", roleDescription: "Work." }],
		brief: { goal: "Reject invalid exit reconciliation." }, initialRequests: [{ to: "w1", task: "lost" }], timeoutSeconds: null,
	});
	runtime.launch(prepared.teamId);
	const boot = runtime.takeNextActivation(prepared.teamId)!;
	assert.equal(runtime.inputReady(boot.binding, boot.scope.activationId, boot.deliveryId).ok, true);
	apply(runtime, boot, 1, "boot", { action: "yield" });
	finish(runtime, boot, "boot");
	const binding = runtime.bindingForDriver(prepared.teamId, "w1");
	assert.throws(() => runtime.memberExitConfirmed(binding), /no unconfirmed exit/u, "an open, owned member cannot be marked released");
	const work = runtime.takeNextActivation(prepared.teamId)!;
	runtime.activationLost(work.binding, work.scope.activationId, { code: "NATIVE_OUTCOME_UNKNOWN", message: "lost", outcomeUnknown: true }, false);
	assert.throws(() => runtime.memberExitConfirmed({ ...binding, epoch: "another-lifetime" }), /./u, "a different lifetime epoch is rejected");
	assert.equal(runtime.getTeam(prepared.teamId).members.find((member) => member.id === "w1")?.resourceState, "cleanup_failed");
	assert.equal(runtime.memberExitConfirmed(binding).ok, true);
	assert.equal(runtime.getTeam(prepared.teamId).members.find((member) => member.id === "w1")?.resourceState, "released");
	runtime.assertInvariants(prepared.teamId);
});
