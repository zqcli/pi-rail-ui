import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PiRpcProcessTransport } from "../../tools/subagents/rpc-transport";
import { RpcSessionWorker, buildRpcWorkerArgs } from "../../tools/subagents/rpc-worker";
import type { AgentInstance, AgentInstanceStore, AgentRoster, SessionWorkerFactory } from "../../tools/subagents/session-broker";
import { SessionBroker } from "../../tools/subagents/session-broker";
import { TeamMemberDriver } from "../../tools/subagents/team-member-driver";
import { TeamRuntime } from "../../tools/subagents/team-runtime";
import { TeamActivationFailure } from "../../tools/subagents/team-rpc-v2";
import type { RailModelRef } from "../../tools/subagents/models";
import { TEAM_ACTIVATION_MESSAGE_TYPE, TEAM_ACTIVATION_TRIGGER, TEAM_PRIVATE_ENTRY_TYPE } from "../../tools/subagents/team-protocol";

const MODEL: RailModelRef = { provider: "rail-team-local", modelId: "probe" };
const CLI = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const PROVIDER = fileURLToPath(new URL("../fixtures/team-v2-local-provider.mjs", import.meta.url));

class MemoryStore implements AgentInstanceStore {
	private readonly values = new Map<string, AgentInstance>();
	async get(agentId: string) { const value = this.values.get(agentId); return value ? structuredClone(value) : undefined; }
	async put(instance: AgentInstance) { this.values.set(instance.agentId, structuredClone(instance)); }
	async delete(agentId: string) { this.values.delete(agentId); }
	async list() { return [...this.values.values()].map((value) => structuredClone(value)); }
}

class MemoryRoster implements AgentRoster {
	private readonly values = new Map<string, string>();
	resolve(target: string) { return this.values.get(target); }
	link(alias: string, agentId: string) { this.values.set(alias, agentId); }
	unlink(alias: string) { this.values.delete(alias); }
	list() { return [...this.values].map(([alias, agentId]) => ({ alias, agentId })); }
}

function parseSession(text: string): any[] {
	return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function promptInput(entry: any): any | undefined {
	if (entry.type !== "custom_message" || entry.customType !== TEAM_ACTIVATION_MESSAGE_TYPE) return;
	const content = typeof entry.content === "string" ? entry.content
		: Array.isArray(entry.content) ? entry.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("") : "";
	return JSON.parse(content);
}

async function createHarness(t: { after(fn: () => Promise<void>): void }, scenario: "n02" | "mixed-end" | "retry" | "compaction" | "close-loop" | "close-mixed") {
	const root = await mkdtemp(join(tmpdir(), "rail-team-v2-driver-"));
	await writeFile(join(root, "settings.json"), JSON.stringify({
		compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 1 },
		retry: { enabled: true, maxRetries: 1, baseDelayMs: 10 },
	}));
	const sessionDir = join(root, "sessions");
	const store = new MemoryStore();
	const roster = new MemoryRoster();
	const workerFactory: SessionWorkerFactory = async (spec) => {
		const args = buildRpcWorkerArgs(spec);
		const modelIndex = args.indexOf("--model");
		if (modelIndex < 0) throw new Error("Worker args omitted the model");
		args.splice(modelIndex, 0, "-e", PROVIDER);
		const transport = new PiRpcProcessTransport({
			command: process.execPath,
			args: [CLI, "--offline", "--no-extensions", "--session-dir", sessionDir, ...args],
			cwd: spec.cwd,
			env: {
				PATH: process.env["PATH"] ?? "",
				HOME: root,
				PI_CODING_AGENT_DIR: root,
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
				PI_SKIP_VERSION_CHECK: "1",
				TEAM_V2_SCENARIO: scenario,
			},
		});
		await transport.start();
		return RpcSessionWorker.connect(spec, transport);
	};
	const broker = new SessionBroker({ store, roster, workerFactory, defaultCwd: root });
	const runtime = new TeamRuntime();
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Review Team outcomes.", model: "rail-team-local/probe", cwd: root, fastMode: false },
		workers: [
			{ alias: "w1", roleDescription: "Handle W1's assigned work and answer peer questions.", model: "rail-team-local/probe", cwd: root, fastMode: false,
				...(scenario === "compaction" ? { contextWindow: 64000 } : {}) },
			{ alias: "w2", roleDescription: "Handle W2's assigned work and ask W1 for independent facts.", model: "rail-team-local/probe", cwd: root, fastMode: false },
		],
		brief: { goal: "Verify same-session Team v2 activation and result settlement." },
		initialRequests: scenario === "close-loop" || scenario === "close-mixed" ? [] : [{ to: "w1", task: scenario === "mixed-end" ? "N04 mixed end" : "W1 root", inputRefs: [] }],
		timeoutSeconds: null,
	});
	const driver = new TeamMemberDriver(runtime, broker);
	const handles = new Map<string, Awaited<ReturnType<TeamMemberDriver["openMember"]>>>();
	t.after(async () => {
		const failures: unknown[] = [];
		try { await driver.close(); } catch (error) { failures.push(error); }
		try { await broker.shutdown(); } catch (error) { failures.push(error); }
		try { await rm(root, { recursive: true, force: true }); } catch (error) { failures.push(error); }
		if (failures.length) throw new AggregateError(failures, "Team driver harness cleanup failed");
	});
	for (const memberId of ["lead", "w1", "w2"]) {
		handles.set(memberId, await driver.openMember({ teamId: prepared.teamId, memberId, model: MODEL, cwd: root }));
	}
	return { root, runtime, teamId: prepared.teamId, driver, handles, broker, store };
}

async function drain(driver: TeamMemberDriver, teamId: string, max = 24) {
	const runs = [];
	for (let attempt = 0; attempt < max; attempt++) {
		const next = await driver.runNext(teamId);
		if (!next) return runs;
		runs.push(next);
	}
	throw new Error(`Team Runtime did not quiesce after ${max} native activations`);
}

test("real Pi 0.87.1 Team v2 lifetime supports W1/W2 return-trip work with settled cleanup on one session per member", { timeout: 60000 }, async (t) => {
	const { runtime, teamId, driver, handles, broker } = await createHarness(t, "n02");
	runtime.launch(teamId);
	await assert.rejects(broker.dispatch({ target: "w1", task: "ordinary writer intrusion" }), /active team operation/u);
	await assert.rejects(broker.control({ target: "w1", delivery: "steer", message: "intrusion" }), /Team-owned/u);
	await assert.rejects(broker.setFastMode("w1", true), /Team-owned/u);
	await assert.rejects(broker.changeModel("w1", { provider: "test", modelId: "other" }), /Team-owned/u);
	await assert.rejects(broker.stop("w1"), /Team-owned/u);
	await assert.rejects(broker.delete("w1"), /Team-owned/u);
	await assert.rejects(broker.detach("w1"), /Team-owned/u);
	const runs = await drain(driver, teamId);
	assert.equal(runtime.getTeam(teamId).lifecycle, "active");
	assert.equal(runtime.getTeam(teamId).works.resolved, 3);
	const workRuns = runs.filter((run) => run.activation.scope.kind === "work");
	assert.equal(workRuns.length, 5, "root, W2 child, W1 callback, and both resumed results use Runtime reservations");
	assert.ok(workRuns.every((run) => run.completion.status === "success" && run.completion.appliedToolCallId),
		"each accepted reply/yield is backed by a sole finalized toolCall/result with native terminate evidence");
	assert.equal(runs.filter((run) => run.activation.scope.kind === "management").length, 2, "BOOT and final result events remain Manager Runtime activations");

	const refs = new Map<string, { workId: string; revision: number }>();
	for (const run of workRuns) {
		const ref = run.activation.scope.work!;
		refs.set(`${ref.workId}@${ref.revision}`, ref);
	}
	assert.equal(refs.size, 3);
	for (const ref of refs.values()) {
		const work = runtime.getWork(teamId, ref)!;
		assert.equal(work.current.state, "resolved");
		assert.equal(runtime.getResult(teamId, work.current.resultRef!)?.source, "explicit_reply");
	}

	const byMember = new Map<string, typeof runs>();
	for (const run of runs) {
		const list = byMember.get(run.activation.binding.memberId) ?? [];
		list.push(run);
		byMember.set(run.activation.binding.memberId, list);
	}
	assert.equal(byMember.get("w1")?.length, 3);
	assert.equal(byMember.get("w2")?.length, 2);
	assert.equal(new Set(byMember.get("w1")!.map((run) => run.sessionId)).size, 1,
		"all W1 work and the independent W2 callback use the same Broker-owned native session");
	for (const memberId of ["lead", "w1", "w2"]) {
		const runtimeMember = runtime.getTeam(teamId).members.find((member) => member.id === memberId)!;
		const instance = handles.get(memberId)!.instance;
		const entries = parseSession(await readFile(instance.sessionFile, "utf8"));
		const privateEntries = entries.filter((entry) => entry.type === "custom" && entry.customType === TEAM_PRIVATE_ENTRY_TYPE);
		const activations = entries.map(promptInput).filter(Boolean);
		const triggerPrompts = entries.filter((entry) => entry.type === "message" && entry.message?.role === "user"
			&& entry.message.content?.some?.((part: any) => part.type === "text" && part.text === TEAM_ACTIVATION_TRIGGER));
		const inputReady = privateEntries.filter((entry) => entry.data?.kind === "request" && entry.data.request?.action === "input_ready");
		const bindAcks = privateEntries.filter((entry) => entry.data?.kind === "ack" && !entry.data.activation);
		assert.equal(activations.length, byMember.get(memberId)?.length);
		assert.equal(triggerPrompts.length, activations.length, `${memberId} gets one fixed native trigger per activation`);
		assert.equal(inputReady.length, activations.length, `${memberId} acknowledges each exact native activation input once`);
		assert.equal(bindAcks.length, 1, `${memberId} binds its v2 protocol once for the entire native lifetime`);
		assert.equal(runtimeMember.activity, "idle");
		const providerCalls = entries.filter((entry) => entry.type === "custom" && entry.customType === "team-v2-provider");
		const turnsByDelivery = new Map<string, number>();
		for (const call of providerCalls) {
			const input = call.data.messages.map((message: any) => {
				if (message.role !== "user") return undefined;
				const text = typeof message.content === "string" ? message.content : (message.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("");
				try {
					const value = JSON.parse(text);
					return value?.version === 2 && typeof value.deliveryId === "string" ? value : undefined;
				} catch { return undefined; }
			}).filter(Boolean).at(-1);
			if (input) turnsByDelivery.set(input.deliveryId, (turnsByDelivery.get(input.deliveryId) ?? 0) + 1);
			if (input) assert.equal(call.data.messages.some((message: any) => message.role === "user" && message.content?.some?.((part: any) => part.text === TEAM_ACTIVATION_TRIGGER)), true);
		}
		for (const run of byMember.get(memberId) ?? []) {
			const count = turnsByDelivery.get(run.activation.deliveryId) ?? 0;
			assert.ok(count >= 1);
			if (run.completion.appliedToolCallId) {
				const input = run.activation.input;
				const expectedTurns = input.scope.kind === "work" && input.outcomes.length === 0
					&& (input.scope.task === "W1 root" || input.scope.task === "W2 assigned") ? 2 : 1;
				assert.equal(count, expectedTurns, "Pi's native terminate prevents a provider poll after the staged reply/yield tool result");
			}
		}
	}
	assert.ok(runs.every((run) => !run.completion.pendingToolCalls));
});

test("real Pi Runtime scheduler completes request, reply, Manager acceptance, close_team, and confirmed member exits", { timeout: 90000 }, async (t) => {
	const { runtime, teamId, driver, handles, store } = await createHarness(t, "close-loop");
	const closeObserved = new Set<string>();
	const managerHandle = handles.get("lead")!;
	for (const memberId of ["lead", "w1", "w2"]) {
		const handle = handles.get(memberId)!;
		const close = handle.close.bind(handle);
		handle.close = async () => {
			const team = runtime.getTeam(teamId);
			const manager = team.members.find((member) => member.id === "lead")!;
			assert.equal(manager.lifecycle, "closing");
			assert.equal(manager.activity, "idle", "no member may exit while the Manager's close activation is active");
			const entries = parseSession(await readFile(managerHandle.instance.sessionFile, "utf8"));
			assert.ok(entries.some((entry) => entry.type === "message" && entry.message?.role === "toolResult"
				&& entry.message.toolCallId === "close-team" && entry.message.isError !== true),
			"all resource exits follow the Manager's successful native close_team result");
			closeObserved.add(memberId);
			await close();
		};
	}
	const result = await driver.launch(teamId);
	const managerEntries = parseSession(await readFile(handles.get("lead")!.instance.sessionFile, "utf8"));
	assert.equal(result.lifecycle, "closed", JSON.stringify(result));
	assert.equal(result.outcome, "succeeded");
	assert.equal(result.finalResultRefs.length, 1);
	assert.equal(runtime.getTeam(teamId).lifecycle, "closed");
	assert.equal(runtime.getTeam(teamId).works.resolved, 1);
	assert.ok(runtime.getTeam(teamId).members.every((member) => member.lifecycle === "closed" && member.resourceState === "released"));
	assert.deepEqual([...closeObserved].sort(), ["lead", "w1", "w2"]);
	const work = runtime.getWork(teamId, result.roots[0]!.work)!;
	assert.equal(work.current.review?.disposition, "accepted");
	assert.equal(work.current.resultRef, result.finalResultRefs[0]);
	for (const memberId of ["lead", "w1", "w2"]) {
		const handle = handles.get(memberId)!;
		assert.ok(await store.get(handle.instance.agentId), `${memberId}'s persistent descriptor survives normal Team close`);
	}
	const managerActivations = managerEntries.map(promptInput).filter(Boolean);
	assert.ok(managerActivations.some((activation) => activation.scope.kind === "management"
		&& activation.scope.events.some((event: any) => event.kind === "BOOT")));
	assert.ok(managerActivations.some((activation) => activation.scope.kind === "management"
		&& activation.scope.events.some((event: any) => event.kind === "ROOT_RESULT_READY")));
});

test("real Pi rejects flat close_team when another tool shares the finalized assistant batch", { timeout: 60000 }, async (t) => {
	const { runtime, teamId, driver, handles } = await createHarness(t, "close-mixed");
	runtime.launch(teamId);
	const run = await driver.runNext(teamId);
	assert.equal(run?.activation.scope.kind, "management");
	assert.equal(run?.completion.status, "success");
	assert.equal(run?.completion.appliedToolCallId, undefined, "mixed close_team never stages Runtime termination evidence");
	const team = runtime.getTeam(teamId);
	assert.equal(team.lifecycle, "active");
	assert.equal(team.members.find((member) => member.id === "lead")?.lifecycle, "open");
	assert.equal(team.members.find((member) => member.id === "lead")?.activity, "idle");
	const entries = parseSession(await readFile(handles.get("lead")!.instance.sessionFile, "utf8"));
	const results = entries.filter((entry) => entry.type === "message" && entry.message?.role === "toolResult");
	assert.equal(results.find((entry) => entry.message.toolCallId === "mixed-close-team")?.message.isError, true);
	assert.equal(results.find((entry) => entry.message.toolCallId === "mixed-sibling-status")?.message.isError, false);
});

test("Manager cleanup failure returns failed after worker exits while retaining the unknown Manager lifetime", { timeout: 10000 }, async () => {
	const runtime = new TeamRuntime();
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage and close." },
		workers: [{ alias: "w1", roleDescription: "Idle worker." }],
		brief: { goal: "Verify failed close convergence." },
		timeoutSeconds: null,
	});
	const closedMembers: string[] = [];
	const broker = {
		openTeamMember: async ({ binding }: any) => ({
			instance: { agentId: binding.memberId, alias: binding.memberId, sessionId: `session-${binding.memberId}` },
			sessionId: `session-${binding.memberId}`,
			runActivation: async (activation: any, onRequest: any, onNativeSettled: any) => {
				const closesTeam = activation.scope.kind === "management"
					&& !activation.input.scope.events.some((event: any) => event.kind === "BOOT");
				const args = closesTeam
					? { action: "control", command: "close_team", resultRefs: [], outcome: "failed", reason: "synthetic close" }
					: { action: "yield" };
				const ready = await onRequest({
					version: 2, kind: "request", binding: activation.binding, activation: activation.scope,
					sequence: 1, rpcRequestId: `ready-${activation.scope.activationId}`,
					request: { action: "input_ready", deliveryId: activation.deliveryId },
				});
				assert.equal(ready.kind, "ack");
				const toolCallId = `intent-${activation.scope.activationId}`;
				const frame = {
					version: 2, kind: "request", binding: activation.binding, activation: activation.scope,
					sequence: 2, rpcRequestId: `rpc-${activation.scope.activationId}`, request: { action: "business", args },
				};
				const reply = await onRequest(frame, toolCallId);
				assert.equal(reply.kind, "business");
				assert.equal(reply.reply.ok, true, JSON.stringify(reply));
				onNativeSettled({ status: "success", appliedToolCallId: toolCallId });
				if (closesTeam) throw new Error("Manager deactivate/reset failed after agent_settled");
			},
			close: async () => { closedMembers.push(binding.memberId); },
		}),
	} as unknown as SessionBroker;
	const driver = new TeamMemberDriver(runtime, broker);
	for (const memberId of ["lead", "w1"]) await driver.openMember({ teamId: prepared.teamId, memberId, model: MODEL });

	const result = await driver.launch(prepared.teamId);
	assert.equal(result.lifecycle, "failed");
	assert.match(result.reason ?? "", /close activation cleanup failed/u);
	assert.deepEqual(closedMembers, ["w1"], "the worker exit is confirmed but the uncertain Manager writer is not stopped or released");
	const team = runtime.getTeam(prepared.teamId);
	const manager = team.members.find((member) => member.id === "lead")!;
	const worker = team.members.find((member) => member.id === "w1")!;
	assert.equal(manager.lifecycle, "faulted");
	assert.equal(manager.resourceState, "cleanup_failed");
	assert.equal(manager.activity, "settling", "the unknown Manager activation remains attached to its owned lifetime");
	assert.equal(worker.lifecycle, "closed");
	assert.equal(worker.resourceState, "released");
	runtime.assertInvariants(prepared.teamId);
});

test("an internal cleanup transition error is fail-closed, visible, and allows other exits to converge", { timeout: 10000 }, async () => {
	const runtime = new TeamRuntime();
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage and close." },
		workers: [{ alias: "w1", roleDescription: "Idle worker." }],
		brief: { goal: "Verify cleanup-transition failure handling." },
		timeoutSeconds: null,
	});
	const closedMembers: string[] = [];
	const broker = {
		openTeamMember: async ({ binding }: any) => ({
			instance: { agentId: binding.memberId, alias: binding.memberId, sessionId: `session-${binding.memberId}` },
			sessionId: `session-${binding.memberId}`,
			runActivation: async (activation: any, onRequest: any, onNativeSettled: any) => {
				const closesTeam = activation.scope.kind === "management"
					&& !activation.input.scope.events.some((event: any) => event.kind === "BOOT");
				const args = closesTeam
					? { action: "control", command: "close_team", resultRefs: [], outcome: "failed", reason: "synthetic close" }
					: { action: "yield" };
				const ready = await onRequest({
					version: 2, kind: "request", binding: activation.binding, activation: activation.scope,
					sequence: 1, rpcRequestId: `ready-${activation.scope.activationId}`,
					request: { action: "input_ready", deliveryId: activation.deliveryId },
				});
				assert.equal(ready.kind, "ack");
				const toolCallId = `intent-${activation.scope.activationId}`;
				const frame = {
					version: 2, kind: "request", binding: activation.binding, activation: activation.scope,
					sequence: 2, rpcRequestId: `rpc-${activation.scope.activationId}`, request: { action: "business", args },
				};
				const reply = await onRequest(frame, toolCallId);
				assert.equal(reply.kind, "business");
				assert.equal(reply.reply.ok, true, JSON.stringify(reply));
				onNativeSettled({ status: "success", appliedToolCallId: toolCallId });
				if (closesTeam) throw new Error("native reset completed with unknown cleanup");
			},
			close: async () => { closedMembers.push(binding.memberId); },
		}),
	} as unknown as SessionBroker;
	const driver = new TeamMemberDriver(runtime, broker);
	for (const memberId of ["lead", "w1"]) await driver.openMember({ teamId: prepared.teamId, memberId, model: MODEL });
	const nativeCleanupFinished = runtime.cleanupFinished.bind(runtime);
	runtime.cleanupFinished = (binding, activationId, cleanup) => {
		if (!cleanup.ok) throw new Error("injected cleanup transition failure");
		return nativeCleanupFinished(binding, activationId, cleanup);
	};

	const result = await driver.launch(prepared.teamId);
	assert.equal(result.lifecycle, "failed");
	assert.match(result.reason ?? "", /cleanup report failed.*injected cleanup transition failure/u);
	assert.deepEqual(closedMembers, ["w1"]);
	const manager = runtime.getTeam(prepared.teamId).members.find((member) => member.id === "lead")!;
	assert.equal(manager.lifecycle, "faulted");
	assert.equal(manager.resourceState, "cleanup_failed");
	assert.equal(runtime.getTeam(prepared.teamId).members.find((member) => member.id === "w1")?.resourceState, "released");
	runtime.assertInvariants(prepared.teamId);
});

test("launch failure preserves the original error and detaches the never-started executor", async () => {
	const runtime = new TeamRuntime();
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage." },
		workers: [{ alias: "w1", roleDescription: "Work." }],
		brief: { goal: "Verify executor rollback before launch." },
		timeoutSeconds: null,
	});
	let closeCalls = 0;
	const broker = {
		openTeamMember: async ({ binding }: any) => ({
			instance: { agentId: binding.memberId, alias: binding.memberId, sessionId: `session-${binding.memberId}` },
			sessionId: `session-${binding.memberId}`,
			runActivation: async () => undefined,
			close: async () => { closeCalls++; },
		}),
	} as unknown as SessionBroker;
	const driver = new TeamMemberDriver(runtime, broker);
	for (const memberId of ["lead", "w1"]) await driver.openMember({ teamId: prepared.teamId, memberId, model: MODEL });
	const expected = new Error("injected launch admission failure");
	const originalLaunch = runtime.launch.bind(runtime);
	runtime.launch = (() => { throw expected; }) as typeof runtime.launch;
	assert.throws(() => driver.launch(prepared.teamId), (error) => error === expected);
	assert.equal(runtime.getTeam(prepared.teamId).lifecycle, "prepared");
	const executor = runtime.attachExecutor(prepared.teamId, { runActivation: async () => undefined, closeMember: async () => ({ ok: true }) });
	executor();
	runtime.launch = originalLaunch;
	await driver.close();
	assert.equal(closeCalls, 2);
});

test("TeamMemberDriver.close retains a failed member handle for a confirmed retry", { timeout: 60000 }, async (t) => {
	const { teamId, driver, handles, store } = await createHarness(t, "n02");
	const member = handles.get("w1")!;
	const close = member.close.bind(member);
	let failOnce = true;
	let closeAttempts = 0;
	member.close = async () => {
		closeAttempts++;
		if (failOnce) { failOnce = false; throw new Error("unconfirmed exit"); }
		await close();
	};
	await assert.rejects(driver.close(), /exits are unconfirmed/u);
	assert.equal(closeAttempts, 1);
	assert.ok(await store.get(member.instance.agentId), "the handle's descriptor remains persistent after the failed close");
	await assert.rejects(driver.openMember({ teamId, memberId: "w1", model: MODEL }), /already has a native lifetime/u);
	await driver.close();
	assert.equal(closeAttempts, 2, "the same handle is retried rather than forgotten");
	assert.ok(await store.get(member.instance.agentId), "confirmed close does not delete the descriptor");
});

test("a pre-settlement native send failure is isolated without inventing native completion or retaining the running slot", async () => {
	const runtime = new TeamRuntime();
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage the work." },
		workers: [{ alias: "w1", roleDescription: "Complete assigned work." }, { alias: "w2", roleDescription: "Complete assigned work." }],
		brief: { goal: "Verify transport-loss isolation." },
		initialRequests: [{ to: "w1", task: "run before transport failure" }], timeoutSeconds: null,
	});
	let failedWorkRef: { workId: string; revision: number } | undefined;
	const broker = {
		openTeamMember: async ({ binding }: any) => {
			const handle = {
				instance: { agentId: binding.memberId, alias: binding.memberId, sessionId: `session-${binding.memberId}` },
				sessionId: `session-${binding.memberId}`,
				runActivation: async (_activation: any, _onRequest: any, onNativeSettled: any) => {
					if (binding.memberId === "w1") {
						failedWorkRef = _activation.scope.work;
						throw new TeamActivationFailure("transport failed before agent_settled", true);
					}
					onNativeSettled({ status: "success", finalAssistantText: "boot complete" });
				},
				close: async () => undefined,
			};
			return handle;
		},
	} as unknown as SessionBroker;
	const driver = new TeamMemberDriver(runtime, broker);
	for (const memberId of ["lead", "w1", "w2"]) await driver.openMember({ teamId: prepared.teamId, memberId, model: MODEL });
	runtime.launch(prepared.teamId);
	const cancelledBeforeReservation = new AbortController();
	cancelledBeforeReservation.abort();
	const beforeCancel = runtime.getTeam(prepared.teamId);
	assert.equal(await driver.runNext(prepared.teamId, { signal: cancelledBeforeReservation.signal }), undefined);
	assert.deepEqual(runtime.getTeam(prepared.teamId), beforeCancel, "pre-aborted execution does not reserve or mutate an activation");
	const managerBoot = await driver.runNext(prepared.teamId);
	assert.equal(managerBoot?.completion.status, "success");
	await assert.rejects(driver.runNext(prepared.teamId), /transport failed before agent_settled/u);
	const team = runtime.getTeam(prepared.teamId);
	const worker = team.members.find((member) => member.id === "w1")!;
	assert.equal(worker.lifecycle, "faulted");
	assert.equal(worker.activity, "idle");
	assert.equal(worker.currentWork, undefined);
	assert.equal(worker.resourceState, "released");
	assert.ok(failedWorkRef);
	const failedWork = runtime.getWork(prepared.teamId, failedWorkRef);
	assert.equal(failedWork?.current.state, "failed");
	assert.equal(failedWork?.current.error?.outcomeUnknown, true);
	runtime.assertInvariants(prepared.teamId);
	await driver.close();
});

test("real Pi automatic retry remains inside the Team native run and settles one activation", { timeout: 90000 }, async (t) => {
	const { runtime, teamId, driver, handles } = await createHarness(t, "retry");
	runtime.launch(teamId);
	const runs = await drain(driver, teamId);
	assert.ok(runs.some((run: any) => run.completion.status === "success"));
	const workerEntries = parseSession(await readFile(handles.get("w1")!.instance.sessionFile, "utf8"));
	const providerCalls = workerEntries.filter((entry) => entry.type === "custom" && entry.customType === "team-v2-provider");
	const retriedDelivery = providerCalls[0].data.activationDeliveryId;
	assert.ok(retriedDelivery);
	const retryTurns = providerCalls.filter((entry) => entry.data.activationDeliveryId === retriedDelivery);
	assert.deepEqual(retryTurns.map((entry) => entry.data.turn), [1, 2, 3],
		"the first provider failure, automatic retry, and tool continuation all remain inside one native activation delivery");
	assert.equal(retryTurns[0].data.retry, true);
	assert.equal(retryTurns[1].data.retry, false);
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "w1")?.lifecycle, "open");
	assert.equal(runtime.getTeam(teamId).works.failed, 0);
});

test("real Pi threshold compaction occurs inside a Team activation without losing provider/native ownership", { timeout: 90000 }, async (t) => {
	const { runtime, teamId, driver, handles } = await createHarness(t, "compaction");
	runtime.launch(teamId);
	await drain(driver, teamId);
	const workerEntries = parseSession(await readFile(handles.get("w1")!.instance.sessionFile, "utf8"));
	assert.ok(workerEntries.some((entry) => entry.type === "compaction"), "native compaction writes its actual session checkpoint");
	const compaction = workerEntries.find((entry) => entry.type === "custom" && entry.customType === "team-v2-compaction");
	assert.ok(compaction, "the extension observes native session_before_compact");
	assert.equal(compaction.data.contextWindow, 64000);
	assert.equal(runtime.getTeam(teamId).works.failed, 0);
	const providerCalls = workerEntries.filter((entry) => entry.type === "custom" && entry.customType === "team-v2-provider");
	assert.ok(providerCalls.some((entry) => entry.data.activationDeliveryId && entry.data.modelContextWindow === 64000));
});

test("real Pi rejects a non-sole end intent and Runtime commits only the true natural final", { timeout: 60000 }, async (t) => {
	const { runtime, teamId, driver, handles } = await createHarness(t, "mixed-end");
	runtime.launch(teamId);
	const manager = await driver.runNext(teamId);
	assert.equal(manager?.completion.status, "success");
	const run = await driver.runNext(teamId);
	assert.ok(run);
	assert.equal(run.completion.appliedToolCallId, undefined, "the rejected non-sole reply is not applied native evidence");
	assert.equal(run.completion.finalAssistantText, "Natural final after the rejected non-sole reply.", JSON.stringify(run.completion));
	const ref = run.activation.scope.work!;
	const work = runtime.getWork(teamId, ref)!;
	assert.equal(work.current.state, "resolved");
	assert.equal(runtime.getResult(teamId, work.current.resultRef!)?.source, "natural_final");
	const instance = handles.get("w1")!.instance;
	const entries = parseSession(await readFile(instance.sessionFile, "utf8"));
	assert.equal(entries.filter((entry) => entry.type === "custom" && entry.customType === "team-v2-probe-executed").length, 1);
	assert.equal(entries.filter((entry) => entry.type === "custom" && entry.customType === "team-v2-provider").length, 2,
		"the mixed batch is rejected, then one genuine native final answer completes the activation");
});

test("normal Team close preserves the native session and descriptor for ordinary history reopen", { timeout: 60000 }, async (t) => {
	const { runtime, teamId, driver, handles, broker, store } = await createHarness(t, "n02");
	runtime.launch(teamId);
	await drain(driver, teamId);
	const member = handles.get("w1")!;
	const original = member.instance;
	const sessionFile = original.sessionFile;
	const before = parseSession(await readFile(sessionFile, "utf8"));
	const oldCustomInputs = before.filter((entry) => entry.type === "custom_message" && entry.customType === TEAM_ACTIVATION_MESSAGE_TYPE).length;
	assert.ok(oldCustomInputs > 0);

	await driver.close();
	const persisted = await store.get(original.agentId);
	assert.ok(persisted, "normal close keeps the persistent descriptor");
	assert.equal(persisted.sessionId, original.sessionId);
	assert.ok((await readFile(sessionFile, "utf8")).length > 0, "normal close keeps the JSONL session");

	const reopened = await broker.dispatch({ target: "w1", task: "ordinary reopen marker" });
	assert.equal(reopened.instance.sessionId, original.sessionId);
	assert.equal(reopened.run.output, "Ordinary session reopened with its previous Team history.");
	const after = parseSession(await readFile(sessionFile, "utf8"));
	assert.equal(after.filter((entry) => entry.type === "custom_message" && entry.customType === TEAM_ACTIVATION_MESSAGE_TYPE).length, oldCustomInputs);
	assert.equal(after.filter((entry) => entry.type === "custom" && entry.customType === TEAM_PRIVATE_ENTRY_TYPE && entry.data?.kind === "ack" && entry.data?.commandId).length > 0, true);
	const provider = after.filter((entry) => entry.type === "custom" && entry.customType === "team-v2-provider").at(-1)!;
	assert.equal(provider.data.teamCalls, 0, "ordinary reopen has no live Team tool loadout");
	assert.equal(runtime.getTeam(teamId).lifecycle, "active", "Stage B resource close does not invent a Team close decision");
});