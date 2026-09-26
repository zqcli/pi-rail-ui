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
import { TeamRuntime, type RuntimeActivation } from "../../tools/subagents/team-runtime";
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

async function createHarness(t: { after(fn: () => Promise<void>): void }, scenario: "n02" | "mixed-end" | "retry" | "compaction" | "close-loop" | "close-mixed" | "pause-mixed" | "revise-live" | "cancel-live" | "hang-live",
	open: readonly string[] = ["lead", "w1", "w2"], runtimeOptions: ConstructorParameters<typeof TeamRuntime>[0] = {}) {
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
	const runtime = new TeamRuntime(runtimeOptions);
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Review Team outcomes.", model: "rail-team-local/probe", cwd: root, fastMode: false },
		workers: [
			{ alias: "w1", roleDescription: "Handle W1's assigned work and answer peer questions.", model: "rail-team-local/probe", cwd: root, fastMode: false,
				...(scenario === "compaction" ? { contextWindow: 64000 } : {}) },
			{ alias: "w2", roleDescription: "Handle W2's assigned work and ask W1 for independent facts.", model: "rail-team-local/probe", cwd: root, fastMode: false },
		],
		brief: { goal: "Verify same-session Team v2 activation and result settlement." },
		initialRequests: scenario === "close-loop" || scenario === "close-mixed" ? []
			: scenario === "cancel-live" ? [
				{ to: "w1", task: "cancel target", inputRefs: [] },
				{ to: "w1", task: "unrelated root", inputRefs: [] },
			]
			: [{ to: "w1", task: scenario === "mixed-end" ? "N04 mixed end" : "W1 root", inputRefs: [] }],
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
	for (const memberId of open) {
		handles.set(memberId, await driver.openMember({ teamId: prepared.teamId, memberId, model: MODEL, cwd: root }));
	}
	return { root, runtime, teamId: prepared.teamId, driver, handles, broker, store, plan: prepared };
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

async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${description}`);
}

async function waitForGateOrCancel(gate: Promise<void>, lifetime: Promise<unknown>, runtime: TeamRuntime, teamId: string,
	handles: Map<string, Awaited<ReturnType<TeamMemberDriver["openMember"]>>>, description: string): Promise<void> {
	let gateTimer: ReturnType<typeof setTimeout> | undefined;
	const reached = await Promise.race([gate.then(() => true), new Promise<boolean>((resolve) => { gateTimer = setTimeout(() => resolve(false), 5000); })]);
	if (gateTimer) clearTimeout(gateTimer);
	if (reached) return;
	const diagnostics: Record<string, unknown> = {};
	for (const memberId of ["lead", "w1", "w2"]) {
		const handle = handles.get(memberId)!;
		const entries = parseSession(await readFile(handle.instance.sessionFile, "utf8"));
		diagnostics[memberId] = entries.filter((entry) => entry.type === "custom" && ["team-v2-provider", TEAM_PRIVATE_ENTRY_TYPE].includes(entry.customType))
			.map((entry) => ({ type: entry.customType, data: entry.customType === "team-v2-provider"
				? { turn: entry.data.turn, delivery: entry.data.activationDeliveryId, messages: entry.data.messages?.slice(-4) }
				: entry.data }));
	}
	runtime.hostControl(teamId).cancel_team(`test harness canceled after ${description} was not reached`);
	const settled = await Promise.race([lifetime.then(() => true, () => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10000))]);
	throw new Error(`Timed out waiting for ${description}; host cancellation settled=${settled}; runtime=${JSON.stringify(runtime.getTeam(teamId))}; native=${JSON.stringify(diagnostics)}`);
}

async function awaitLifetimeOrCancel<T>(lifetime: Promise<T>, runtime: TeamRuntime, teamId: string,
	handles: Map<string, Awaited<ReturnType<TeamMemberDriver["openMember"]>>>, description: string): Promise<T> {
	let lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
	const settled = await Promise.race([
		lifetime.then((value) => ({ kind: "value" as const, value }), (error: unknown) => ({ kind: "error" as const, error })),
		new Promise<{ kind: "timeout" }>((resolve) => { lifetimeTimer = setTimeout(() => resolve({ kind: "timeout" }), 10000); }),
	]);
	if (lifetimeTimer) clearTimeout(lifetimeTimer);
	if (settled.kind === "value") return settled.value;
	if (settled.kind === "error") throw settled.error;
	const diagnostics: Record<string, unknown> = {};
	for (const memberId of ["lead", "w1", "w2"]) {
		try {
			const entries = parseSession(await readFile(handles.get(memberId)!.instance.sessionFile, "utf8"));
			diagnostics[memberId] = entries.filter((entry) => entry.type === "custom" && entry.customType === "team-v2-provider")
				.map((entry) => ({ turn: entry.data.turn, delivery: entry.data.activationDeliveryId,
					lastUsers: entry.data.messages?.filter((message: any) => message.role === "user").slice(-3).map((message: any) => message.content) }));
		} catch (error) { diagnostics[memberId] = { sessionUnavailable: String(error) }; }
	}
	const teamBeforeCancel = runtime.getTeam(teamId);
	runtime.hostControl(teamId).cancel_team(`test cleanup after ${description} did not finish`);
	let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
	const cleanupSettled = await Promise.race([
		lifetime.then(() => true, () => true), new Promise<boolean>((resolve) => { cleanupTimer = setTimeout(() => resolve(false), 10000); }),
	]);
	if (cleanupTimer) clearTimeout(cleanupTimer);
	throw new Error(`Team lifetime did not finish ${description}; cleanup=${cleanupSettled}; before=${JSON.stringify(teamBeforeCancel)}; after=${JSON.stringify(runtime.getTeam(teamId))}; providers=${JSON.stringify(diagnostics)}`);
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
		const nativeToolCallIds = new Set(entries.flatMap((entry) => entry.type === "message" && entry.message?.role === "assistant"
			? (entry.message.content ?? []).filter((part: any) => part.type === "toolCall").map((part: any) => part.id) : []));
		const nativeToolResultIds = new Set(entries.filter((entry) => entry.type === "message" && entry.message?.role === "toolResult")
			.map((entry) => entry.message.toolCallId));
		const toolGates = privateEntries.map((entry) => entry.data).filter((frame) => frame.kind === "request" && frame.request?.action === "tool_gate");
		const toolResults = privateEntries.map((entry) => entry.data).filter((frame) => frame.kind === "request" && frame.request?.action === "tool_result");
		if (nativeToolCallIds.size > 0) assert.ok(toolGates.length > 0, `${memberId} reports native tool preflight through Runtime`);
		for (const frame of toolGates) {
			assert.ok(nativeToolCallIds.has(frame.request.toolCallId), "tool_gate carries the exact native toolCallId");
			assert.ok(nativeToolResultIds.has(frame.request.toolCallId), "the preflighted call has a real native toolResult");
		}
		assert.deepEqual(new Set(toolResults.map((frame) => frame.request.toolCallId)), new Set(toolGates.map((frame) => frame.request.toolCallId)),
			"every real tool result clears precisely its matching preflight latch");
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
			return close();
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

test("TeamMemberDriver.stopTeam cancels a prepared Team without provider calls and closes only the opened lifetimes", { timeout: 60000 }, async (t) => {
	const { teamId, driver, handles } = await createHarness(t, "n02", ["lead", "w1"]);
	const stopped = await driver.stopTeam(teamId, "re-prepare with a different model policy");
	assert.equal(stopped.lifecycle, "cancelled");
	assert.equal(stopped.reason, "re-prepare with a different model policy");
	assert.deepEqual(stopped.members.map(({ id, lifecycle, resourceState }) => ({ id, lifecycle, resourceState })), [
		{ id: "lead", lifecycle: "closed", resourceState: "released" },
		{ id: "w1", lifecycle: "closed", resourceState: "released" },
		{ id: "w2", lifecycle: "closed", resourceState: "released" },
	]);
	assert.ok(stopped.roots.length > 0 && stopped.roots.every((root) => root.state === "cancelled"), "initial requests are cancelled, not dropped");
	assert.deepEqual(await driver.stopTeam(teamId, "repeat"), stopped, "a repeated stop is idempotent");
	assert.throws(() => driver.launch(teamId), /Cannot launch Team in cancelled/u);
	await assert.rejects(driver.openMember({ teamId, memberId: "w2", model: MODEL }), /Cannot open a native lifetime for a cancelled Team/u);
	for (const memberId of ["lead", "w1"]) {
		const entries = parseSession(await readFile(handles.get(memberId)!.instance.sessionFile, "utf8").catch(() => ""));
		assert.equal(entries.filter((entry) => entry.type === "custom" && entry.customType === "team-v2-provider").length, 0,
			`${memberId} never reached a provider`);
		assert.equal(entries.map(promptInput).filter(Boolean).length, 0, `${memberId} never received an activation`);
	}
});

test("TeamMemberDriver.stopTeam cancels a launched native lifetime directly", { timeout: 60000 }, async (t) => {
	const { runtime, teamId, driver } = await createHarness(t, "n02");
	const lifetime = driver.launch(teamId);
	await waitUntil(() => runtime.getTeam(teamId).works.resolved > 0, "a native worker result before explicit Team stop");
	const stopped = await driver.stopTeam(teamId, "parent shutdown requested Team cancellation");
	assert.equal(stopped.lifecycle, "cancelled");
	assert.equal(stopped.reason, "parent shutdown requested Team cancellation");
	assert.ok(stopped.members.every((member) => member.lifecycle === "closed" && member.resourceState === "released"));
	assert.deepEqual(await lifetime, stopped);
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

test("real Pi pauses a partially preflighted tool batch, accounts for both tool_results, then resumes the same WorkRef", { timeout: 90000 }, async (t) => {
	const { runtime, teamId, driver, handles } = await createHarness(t, "pause-mixed");
	const worker = handles.get("w1")!;
	const originalRun = worker.runActivation.bind(worker);
	let signalGate!: () => void;
	let releaseGate!: () => void;
	const gateReached = new Promise<void>((resolve) => { signalGate = resolve; });
	const gateRelease = new Promise<void>((resolve) => { releaseGate = resolve; });
	worker.runActivation = async (activation, onRequest, onNativeSettled, signal) => originalRun(activation, async (frame, intentId) => {
		const reply = await onRequest(frame, intentId);
		if (frame.request.action === "tool_gate" && frame.request.toolCallId === "pause-approved-bash") {
			assert.equal(reply.kind, "gate");
			if (reply.kind === "gate") assert.equal(reply.decision.allow, true);
			signalGate();
			await gateRelease;
		}
		return reply;
	}, onNativeSettled, signal);
	const lifetime = driver.launch(teamId).then((result) => ({ ok: true as const, result }), (error: unknown) => ({ ok: false as const, error }));
	await gateReached;
	const originalRef = runtime.getTeam(teamId).members.find((member) => member.id === "w1")?.currentWork;
	assert.ok(originalRef);
	runtime.hostControl(teamId).message_manager("pause w1 after this approved tool finishes");
	await waitUntil(() => runtime.getTeam(teamId).members.find((member) => member.id === "w1")?.pause === "requested", "Manager pause request");
	releaseGate();
	await waitUntil(() => runtime.getTeam(teamId).members.find((member) => member.id === "w1")?.pause === "confirmed", "native provider-safe pause");
	assert.equal(runtime.getTeam(teamId).members.find((member) => member.id === "w1")?.activity, "running",
		"a parked native activation is not reported as idle");
	runtime.hostControl(teamId).message_manager("resume w1 after its provider gate parks");
	const launched = await lifetime;
	assert.equal(launched.ok, true, launched.ok ? "" : String(launched.error));
	if (!launched.ok) return;
	assert.equal(launched.result.lifecycle, "closed");
	assert.equal(launched.result.outcome, "succeeded");
	assert.equal(runtime.getWork(teamId, originalRef)?.current.state, "resolved");
	const entries = parseSession(await readFile(worker.instance.sessionFile, "utf8"));
	const privateRequests = entries.filter((entry) => entry.type === "custom" && entry.customType === TEAM_PRIVATE_ENTRY_TYPE)
		.map((entry) => entry.data).filter((frame) => frame.kind === "request");
	const toolGates = privateRequests.filter((frame) => frame.request.action === "tool_gate");
	const toolResults = privateRequests.filter((frame) => frame.request.action === "tool_result");
	assert.ok(toolGates.some((frame) => frame.request.toolCallId === "pause-approved-bash"));
	assert.ok(toolGates.some((frame) => frame.request.toolCallId === "pause-blocked-bash"));
	assert.ok(toolResults.some((frame) => frame.request.toolCallId === "pause-approved-bash"));
	assert.ok(toolResults.some((frame) => frame.request.toolCallId === "pause-blocked-bash"),
		`the blocked sibling is acknowledged, not stranded: ${JSON.stringify({ toolGates: toolGates.map((frame) => frame.request), toolResults: toolResults.map((frame) => frame.request), nativeResults: entries.filter((entry) => entry.type === "message" && entry.message?.role === "toolResult").map((entry) => entry.message) })}`);
	const nativeResults = entries.filter((entry) => entry.type === "message" && entry.message?.role === "toolResult");
	assert.equal(nativeResults.find((entry) => entry.message.toolCallId === "pause-approved-bash")?.message.isError, false);
	assert.equal(nativeResults.find((entry) => entry.message.toolCallId === "pause-blocked-bash")?.message.isError, true);
	assert.equal(nativeResults.find((entry) => entry.message.toolCallId === "reply-after-resume")?.message.isError, false);
	const managerInputs = parseSession(await readFile(handles.get("lead")!.instance.sessionFile, "utf8")).map(promptInput).filter(Boolean);
	assert.ok(managerInputs.some((input) => input.scope.kind === "management"
		&& input.scope.events.some((event: any) => event.kind === "USER_COMMAND" && event.actor === "@host")),
	"host messages remain host-attributed in the actual Manager activation input");
});

async function runScopedStopScenario(t: { after(fn: () => Promise<void>): void }, scenario: "revise-live" | "cancel-live",
	targetTask: string, toolCallId: string, command: "revise_work" | "cancel_work") {
	const { runtime, teamId, driver, handles } = await createHarness(t, scenario);
	const worker = handles.get("w1")!;
	const originalRun = worker.runActivation.bind(worker);
	let signalGate!: () => void;
	const gateReached = new Promise<void>((resolve) => { signalGate = resolve; });
	let approvedAt = 0;
	let target: RuntimeActivation | undefined;
	let targetSettled: { status: string; elapsedMs: number; activity: string | undefined; currentWork: unknown } | undefined;
	let targetReason: string | undefined;
	worker.runActivation = async (activation, onRequest, onNativeSettled, signal) => {
		if (activation.input.scope.kind === "work" && activation.input.scope.task === targetTask) target = activation;
		const isTarget = target?.scope.activationId === activation.scope.activationId;
		return originalRun(activation, async (frame, intentId) => {
			const reply = await onRequest(frame, intentId);
			if (frame.request.action === "tool_gate" && frame.request.toolCallId === toolCallId) {
				assert.equal(reply.kind === "gate" && reply.decision.allow, true);
				approvedAt = Date.now();
				signalGate();
			}
			return reply;
		}, async (completion) => {
			if (isTarget) {
				// Snapshot before Runtime observes settlement: the old scope must still own the member slot.
				const member = runtime.getTeam(teamId).members.find((item) => item.id === "w1");
				targetSettled = { status: completion.status, elapsedMs: Date.now() - approvedAt, activity: member?.activity, currentWork: member?.currentWork };
			}
			await onNativeSettled(completion);
			if (isTarget) targetReason = runtime.activationCompletionReason(activation.binding, activation.scope.activationId);
		}, signal);
	};
	const lifetime = driver.launch(teamId).then((result) => ({ ok: true as const, result }), (error: unknown) => ({ ok: false as const, error }));
	await waitForGateOrCancel(gateReached, lifetime, runtime, teamId, handles, `${command} native tool gate`);
	const activation = target;
	const ref = activation?.scope.work;
	if (!activation || !ref) throw new Error(`${targetTask} activation was not captured`);
	runtime.hostControl(teamId).message_manager(JSON.stringify({ command, workId: ref.workId, expectedRevision: ref.revision }));
	const launched = await awaitLifetimeOrCancel(lifetime, runtime, teamId, handles, `${command} of a running sleep tool`);
	assert.equal(launched.ok, true, launched.ok ? "" : String(launched.error));
	if (!launched.ok) throw new Error("unreachable");
	assert.ok(targetSettled, "the stopped activation reached a real native settlement");
	assert.equal(targetSettled.status, "aborted");
	assert.equal(targetSettled.activity, "running", "the member slot stays occupied until native settlement and cleanup");
	assert.deepEqual(targetSettled.currentWork, ref);
	assert.ok(targetSettled.elapsedMs < 20000, `the scoped stop interrupted the 30s tool instead of awaiting it (${targetSettled.elapsedMs}ms)`);
	assert.equal(targetReason, command === "revise_work" ? "policy_superseded" : "policy_cancelled");
	const entries = parseSession(await readFile(worker.instance.sessionFile, "utf8"));
	const toolResult = entries.find((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId === toolCallId);
	assert.equal(toolResult?.message.isError, true, "Pi aborted the approved tool");
	assert.doesNotMatch(JSON.stringify(toolResult?.message.content ?? ""), /finished/u, "the interrupted tool never completed");
	assert.ok(entries.some((entry) => entry.type === "custom" && entry.customType === TEAM_PRIVATE_ENTRY_TYPE
		&& entry.data?.kind === "request" && entry.data.request?.action === "tool_result"
		&& entry.data.request.toolCallId === toolCallId), "the interrupted call still reports its exact native tool_result");
	return { runtime, teamId, result: launched.result, ref, activations: entries.map(promptInput).filter((input) => input?.scope.kind === "work") };
}

test("real Pi pause requested while a reply is being staged lets the reply commit without aborting the native run", { timeout: 90000 }, async (t) => {
	const { runtime, teamId, driver, handles } = await createHarness(t, "close-loop");
	const worker = handles.get("w1")!;
	const originalRun = worker.runActivation.bind(worker);
	let signalGate!: () => void;
	let releaseGate!: () => void;
	const gateReached = new Promise<void>((resolve) => { signalGate = resolve; });
	const gateRelease = new Promise<void>((resolve) => { releaseGate = resolve; });
	const workerStatuses: string[] = [];
	worker.runActivation = async (activation, onRequest, onNativeSettled, signal) => originalRun(activation, async (frame, intentId) => {
		const reply = await onRequest(frame, intentId);
		if (frame.request.action === "tool_gate" && frame.request.endIntent) {
			assert.equal(reply.kind === "gate" && reply.decision.allow, true);
			signalGate();
			await gateRelease;
		}
		return reply;
	}, async (completion) => { workerStatuses.push(completion.status); await onNativeSettled(completion); }, signal);
	const lifetime = driver.launch(teamId).then((result) => ({ ok: true as const, result }), (error: unknown) => ({ ok: false as const, error }));
	await waitForGateOrCancel(gateReached, lifetime, runtime, teamId, handles, "worker reply tool gate");
	runtime.hostControl(teamId).message_manager("pause w1");
	await waitUntil(() => runtime.getTeam(teamId).members.find((member) => member.id === "w1")?.pause === "requested", "pause request during the reply");
	releaseGate();
	const launched = await awaitLifetimeOrCancel(lifetime, runtime, teamId, handles, "reply commit under a pause request");
	assert.equal(launched.ok, true, launched.ok ? "" : String(launched.error));
	if (!launched.ok) return;
	assert.equal(launched.result.lifecycle, "closed");
	assert.equal(launched.result.outcome, "succeeded");
	assert.deepEqual(workerStatuses, ["success"], "the staged reply's native run settled normally, without an abort");
	const root = launched.result.roots[0]!;
	assert.equal(root.state, "resolved");
	assert.equal(runtime.getResult(teamId, root.resultRef!)?.source, "explicit_reply");
});

test("real Pi X09: a tool ignoring abort is terminated after the stop bound, releases its owner, and allows an explicit ordinary reopen", { timeout: 90000 }, async (t) => {
	const { runtime, teamId, driver, handles, broker, store } = await createHarness(t, "hang-live", ["lead", "w1", "w2"], { activationStopTimeoutMs: 1000 });
	const worker = handles.get("w1")!;
	const originalRun = worker.runActivation.bind(worker);
	let signalGate!: () => void;
	const gateReached = new Promise<void>((resolve) => { signalGate = resolve; });
	worker.runActivation = async (activation, onRequest, onNativeSettled, signal) => originalRun(activation, async (frame, intentId) => {
		const reply = await onRequest(frame, intentId);
		if (frame.request.action === "tool_gate" && frame.request.toolCallId === "hang-call") signalGate();
		return reply;
	}, onNativeSettled, signal);
	const lifetime = driver.launch(teamId);
	await waitForGateOrCancel(gateReached.then(() => new Promise((resolve) => setTimeout(resolve, 200))), lifetime.then(() => undefined), runtime, teamId, handles, "hanging tool gate");
	const started = Date.now();
	const result = await awaitLifetimeOrCancel(driver.stopTeam(teamId, "user stop during a hung tool"), runtime, teamId, handles, "termination of a hung tool");
	assert.ok(Date.now() - started < 15000, "the stop bound, not the tool, decides when the run ends");
	assert.equal(result.lifecycle, "cancelled");
	const w1 = result.members.find((member) => member.id === "w1")!;
	assert.deepEqual({ lifecycle: w1.lifecycle, resourceState: w1.resourceState }, { lifecycle: "faulted", resourceState: "released" });
	assert.ok(result.members.filter((member) => member.id !== "w1").every((member) => member.lifecycle === "closed" && member.resourceState === "released"));
	const entries = parseSession(await readFile(worker.instance.sessionFile, "utf8"));
	assert.ok(entries.some((entry) => entry.type === "custom" && entry.customType === "team-v2-hang-started"), "the hung tool really ran");
	assert.equal(entries.some((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId === "hang-call"), false,
		"no fabricated tool result is written for the terminated call");
	assert.ok(await store.get(worker.instance.agentId), "the faulted member's descriptor/session history is kept");
	await driver.close();
	const reopened = await broker.dispatch({ target: "w1", task: "ordinary reopen marker" });
	assert.equal(reopened.instance.sessionId, worker.instance.sessionId);
	assert.equal(reopened.run.output, "Ordinary session reopened with its previous Team history.");
});

test("real Pi revision interrupts the old scope's running tool and runs the new revision only after cleanup", { timeout: 90000 }, async (t) => {
	const { runtime, teamId, result, ref, activations } = await runScopedStopScenario(t, "revise-live", "W1 root", "revise-latched-bash", "revise_work");
	assert.equal(result.lifecycle, "closed");
	assert.equal(result.outcome, "succeeded");
	assert.equal(runtime.getWork(teamId, ref)?.current.state, "superseded");
	const revisionTwo = runtime.getWork(teamId, { workId: ref.workId, revision: 2 })!;
	assert.equal(revisionTwo.current.state, "resolved");
	assert.equal(runtime.getResult(teamId, revisionTwo.current.resultRef!)?.result.summary, "Revision two completed on the same W1 session.");
	assert.deepEqual(activations.map((input) => input.scope.task), ["W1 root", "revised root"]);
});

test("real Pi work cancellation interrupts only the selected root's running tool and preserves another root on the same member", { timeout: 90000 }, async (t) => {
	const { runtime, teamId, result, ref, activations } = await runScopedStopScenario(t, "cancel-live", "cancel target", "cancel-latched-bash", "cancel_work");
	assert.equal(result.lifecycle, "closed");
	assert.equal(result.outcome, "failed");
	assert.equal(runtime.getWork(teamId, ref)?.current.state, "cancelled");
	const unrelated = result.roots.find((root) => root.work.workId !== ref.workId)!;
	assert.equal(unrelated.state, "resolved");
	assert.equal(runtime.getResult(teamId, unrelated.resultRef!)?.result.summary, "Unrelated same-member root continued after cancellation cleanup.");
	assert.deepEqual(activations.map((input) => input.scope.task), ["cancel target", "unrelated root"]);
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
			close: async () => { closedMembers.push(binding.memberId); return {}; },
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
			close: async () => { closedMembers.push(binding.memberId); return {}; },
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

test("prepared stopTeam waits for an in-flight open, closes that late handle, and never opens a new lifetime", { timeout: 10000 }, async () => {
	const runtime = new TeamRuntime();
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage." },
		workers: [{ alias: "w1", roleDescription: "Slow to open." }, { alias: "w2", roleDescription: "Never opened." }],
		brief: { goal: "Prepared cancel races a native open." },
		initialRequests: [{ to: "w1", task: "never starts" }], timeoutSeconds: null,
	});
	let releaseOpen!: () => void;
	const slowOpen = new Promise<void>((resolve) => { releaseOpen = resolve; });
	const opened: string[] = [];
	const closed: string[] = [];
	let activations = 0;
	const broker = {
		openTeamMember: async ({ binding }: any) => {
			if (binding.memberId === "w1") await slowOpen;
			opened.push(binding.memberId);
			return {
				instance: { agentId: binding.memberId, alias: binding.memberId, sessionId: `session-${binding.memberId}` },
				sessionId: `session-${binding.memberId}`,
				runActivation: async () => { activations++; },
				terminate: () => undefined,
				close: async () => { closed.push(binding.memberId); return {}; },
			};
		},
	} as unknown as SessionBroker;
	const driver = new TeamMemberDriver(runtime, broker);
	await driver.openMember({ teamId: prepared.teamId, memberId: "lead", model: MODEL });
	const openingW1 = driver.openMember({ teamId: prepared.teamId, memberId: "w1", model: MODEL });
	const stopping = driver.stopTeam(prepared.teamId, "cancel before launch");
	assert.equal(runtime.getTeam(prepared.teamId).members.find((member) => member.id === "w1")?.resourceState, "stopping",
		"a claimed lifetime is not reported released before its open settles and closes");
	await assert.rejects(driver.openMember({ teamId: prepared.teamId, memberId: "w2", model: MODEL }), /cancelled Team/u);
	releaseOpen();
	await openingW1;
	const result = await stopping;
	assert.equal(result.lifecycle, "cancelled");
	assert.deepEqual(opened, ["lead", "w1"]);
	assert.deepEqual(closed.sort(), ["lead", "w1"]);
	assert.equal(activations, 0);
	assert.ok(result.members.every((member) => member.lifecycle === "closed" && member.resourceState === "released"));
	await driver.close();
});

function fakeMemberBroker(behavior: {
	workerFailure?: TeamActivationFailure;
	closeResult?: (memberId: string) => Promise<{ protocolError?: string }>;
	managerCloses?: boolean;
}) {
	const closeCalls: string[] = [];
	const broker = {
		openTeamMember: async ({ binding }: any) => ({
			instance: { agentId: binding.memberId, alias: binding.memberId, sessionId: `session-${binding.memberId}` },
			sessionId: `session-${binding.memberId}`,
			runActivation: async (activation: any, onRequest: any, onNativeSettled: any) => {
				if (activation.scope.kind === "work" && behavior.workerFailure) throw behavior.workerFailure;
				const closesTeam = behavior.managerCloses === true && activation.scope.kind === "management"
					&& !activation.input.scope.events.some((event: any) => event.kind === "BOOT");
				const ready = await onRequest({ version: 2, kind: "request", binding: activation.binding, activation: activation.scope,
					sequence: 1, rpcRequestId: `ready-${activation.scope.activationId}`, request: { action: "input_ready", deliveryId: activation.deliveryId } });
				assert.equal(ready.kind, "ack");
				const args = closesTeam ? { action: "control", command: "close_team", resultRefs: [], outcome: "failed", reason: "synthetic close" }
					: activation.scope.kind === "management" ? { action: "yield" }
						: { action: "reply", result: { status: "succeeded", summary: "done" } };
				const toolCallId = `intent-${activation.scope.activationId}`;
				const reply = await onRequest({ version: 2, kind: "request", binding: activation.binding, activation: activation.scope,
					sequence: 2, rpcRequestId: `rpc-${activation.scope.activationId}`, request: { action: "business", args } }, toolCallId);
				assert.equal(reply.kind === "business" && reply.reply.ok, true, JSON.stringify(reply));
				onNativeSettled({ status: "success", appliedToolCallId: toolCallId });
			},
			terminate: () => undefined,
			close: async () => {
				closeCalls.push(binding.memberId);
				return behavior.closeResult ? behavior.closeResult(binding.memberId) : {};
			},
		}),
	} as unknown as SessionBroker;
	return { broker, closeCalls };
}

test("a confirmed-exit worker fault releases its Broker owner once; Team cancel and shutdown never re-close it", { timeout: 10000 }, async () => {
	const runtime = new TeamRuntime();
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage." }, workers: [{ alias: "w1", roleDescription: "Terminated worker." }],
		brief: { goal: "Converge a terminated member." }, initialRequests: [{ to: "w1", task: "terminated work" }], timeoutSeconds: null,
	});
	const { broker, closeCalls } = fakeMemberBroker({
		workerFailure: new TeamActivationFailure("terminated after a missed stop bound", true),
		closeResult: async (memberId) => memberId === "w1" ? { protocolError: "Team v2 connection terminated" } : {},
	});
	const driver = new TeamMemberDriver(runtime, broker);
	for (const memberId of ["lead", "w1"]) await driver.openMember({ teamId: prepared.teamId, memberId, model: MODEL });
	const lifetime = driver.launch(prepared.teamId);
	for (let attempt = 0; attempt < 200 && !closeCalls.includes("w1"); attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
	assert.deepEqual(closeCalls, ["w1"], "the confirmed exit releases the Broker owner as soon as Runtime records it");
	const faulted = runtime.getTeam(prepared.teamId).members.find((member) => member.id === "w1")!;
	assert.deepEqual({ lifecycle: faulted.lifecycle, resourceState: faulted.resourceState }, { lifecycle: "faulted", resourceState: "released" });
	await driver.stopTeam(prepared.teamId, "host stop after the fault");
	const result = await lifetime;
	assert.equal(result.lifecycle, "cancelled");
	assert.deepEqual(result.members.map(({ id, lifecycle, resourceState }) => ({ id, lifecycle, resourceState })), [
		{ id: "lead", lifecycle: "closed", resourceState: "released" },
		{ id: "w1", lifecycle: "faulted", resourceState: "released" },
	], "faulted history is kept; the released member is not rewritten as closed");
	await driver.close();
	assert.deepEqual(closeCalls.sort(), ["lead", "w1"], "no second release of the terminated member");
	runtime.assertInvariants(prepared.teamId);
});

test("an unknown-exit worker fault keeps its owner through Team cancel; only an explicit retry reconciles the late exit", { timeout: 10000 }, async () => {
	const runtime = new TeamRuntime();
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage." }, workers: [{ alias: "w1", roleDescription: "Unknown exit." }],
		brief: { goal: "Keep an unknown exit owned." }, initialRequests: [{ to: "w1", task: "unknown exit work" }], timeoutSeconds: null,
	});
	let exited = false;
	const { broker, closeCalls } = fakeMemberBroker({
		workerFailure: new TeamActivationFailure("process exit not confirmed", false),
		closeResult: async (memberId) => {
			if (memberId === "w1" && !exited) throw new Error("exit still unknown");
			return memberId === "w1" ? { protocolError: "Team v2 connection failed" } : {};
		},
	});
	const driver = new TeamMemberDriver(runtime, broker);
	for (const memberId of ["lead", "w1"]) await driver.openMember({ teamId: prepared.teamId, memberId, model: MODEL });
	const lifetime = driver.launch(prepared.teamId);
	for (let attempt = 0; attempt < 200 && runtime.getTeam(prepared.teamId).members.find((member) => member.id === "w1")?.lifecycle !== "faulted"; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	await driver.stopTeam(prepared.teamId, "host stop after unknown exit");
	const result = await lifetime;
	assert.equal(result.lifecycle, "cancelled");
	assert.deepEqual(result.members.find((member) => member.id === "w1"), { id: "w1", role: "worker", lifecycle: "faulted", resourceState: "cleanup_failed" });
	assert.deepEqual(closeCalls, ["lead"], "an unknown exit is never released by the Team cancel path");
	const workRef = result.roots[0]!.work;
	const failedWork = runtime.getWork(prepared.teamId, workRef)!.current;
	assert.equal(failedWork.error?.outcomeUnknown, true);

	await assert.rejects(driver.close(), /exits are unconfirmed/u);
	assert.equal(runtime.getTeam(prepared.teamId).members.find((member) => member.id === "w1")?.resourceState, "cleanup_failed");
	exited = true;
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.deepEqual(closeCalls, ["lead", "w1"], "the late exit alone triggers no automatic retry");
	assert.equal(runtime.getTeam(prepared.teamId).members.find((member) => member.id === "w1")?.resourceState, "cleanup_failed");
	await driver.close();
	assert.deepEqual(closeCalls, ["lead", "w1", "w1"]);
	const reconciled = runtime.getTeam(prepared.teamId).members.find((member) => member.id === "w1")!;
	assert.deepEqual({ lifecycle: reconciled.lifecycle, resourceState: reconciled.resourceState, activity: reconciled.activity },
		{ lifecycle: "faulted", resourceState: "released", activity: "idle" }, "Runtime follows the Broker's confirmed exit; the fault history stays");
	assert.deepEqual(runtime.getWork(prepared.teamId, workRef)!.current, failedWork, "work outcome and outcomeUnknown evidence are unchanged");
	assert.equal(runtime.getTeamResult(prepared.teamId)?.lifecycle, "cancelled");
	assert.equal(runtime.memberExitConfirmed(runtime.bindingForDriver(prepared.teamId, "w1")).ok, true, "a repeated confirmation is idempotent");
	await driver.close();
	assert.deepEqual(closeCalls, ["lead", "w1", "w1"], "no second release");
	runtime.assertInvariants(prepared.teamId);
});

test("a normal close whose private unbind fails releases the exited resource but the Team is failed, not closed", { timeout: 10000 }, async () => {
	const runtime = new TeamRuntime();
	const prepared = runtime.prepare({
		manager: { alias: "lead", roleDescription: "Manage and close." }, workers: [{ alias: "w1", roleDescription: "Idle worker." }],
		brief: { goal: "Unclean unbind is not a clean close." }, timeoutSeconds: null,
	});
	const { broker, closeCalls } = fakeMemberBroker({
		managerCloses: true,
		closeResult: async (memberId) => memberId === "w1" ? { protocolError: "private unbind was rejected" } : {},
	});
	const driver = new TeamMemberDriver(runtime, broker);
	for (const memberId of ["lead", "w1"]) await driver.openMember({ teamId: prepared.teamId, memberId, model: MODEL });
	const result = await driver.launch(prepared.teamId);
	assert.equal(result.lifecycle, "failed");
	assert.match(result.reason ?? "", /close cleanup failed/u);
	assert.deepEqual(result.members.map(({ id, lifecycle, resourceState }) => ({ id, lifecycle, resourceState })), [
		{ id: "lead", lifecycle: "closed", resourceState: "released" },
		{ id: "w1", lifecycle: "faulted", resourceState: "released" },
	]);
	assert.deepEqual(closeCalls.sort(), ["lead", "w1"]);
	await driver.close();
	assert.deepEqual(closeCalls.sort(), ["lead", "w1"], "released members are not closed again");
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
			close: async () => { closeCalls++; return {}; },
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
		return close();
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
				close: async () => ({}),
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