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
