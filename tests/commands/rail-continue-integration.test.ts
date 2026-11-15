import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type CreateAgentSessionRuntimeFactory,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { installRailContinue, railContinueLabel, railContinueStatus } from "../../commands/rail-continue";

type HoldPoint = "input" | "message_end" | "turn_end" | "agent_end" | "agent_before_settle" | "tool" | "compaction";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

async function until(predicate: () => boolean, description: string, timeout = 4000): Promise<void> {
	const expires = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() >= expires) throw new Error(`Timed out waiting for ${description}`);
		await sleep(10);
	}
}

// Uses public SDK/runtime boundaries and an in-memory provider: no online endpoint,
// inherited credentials, private host patch, or invocation of the parent conversation.
async function harness(t: TestContext, options: { persisted?: boolean; retry?: boolean } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "rail-continue-integration-"));
	const provider = `rail-continue-local-${directory.split("-").at(-1)}`;
	const requests: string[] = [];
	const requestSessions: Array<string | undefined> = [];
	const inputs: Array<{ text: string; source: string; idle: boolean }> = [];
	const errors: string[] = [];
	const contexts: ExtensionContext[] = [];
	let slashDispatches = 0;
	let hold: { point: HoldPoint; entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; used: boolean } | undefined;
	let failNext = false;
	let retryStarted = false;
	let lastContext: ExtensionContext | undefined;
	const maybeHold = async (point: HoldPoint, ctx: ExtensionContext) => {
		lastContext = ctx;
		if (!hold || hold.point !== point || hold.used) return;
		hold.used = true;
		hold.entered.resolve();
		await hold.release.promise;
	};
	const factory = (pi: ExtensionAPI) => {
		pi.registerProvider(provider, {
			api: "openai-responses", baseUrl: "http://127.0.0.1:1/never-requested", apiKey: "offline-only",
			models: [{ id: "local", name: "Rail continue offline probe", reasoning: false, input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 64 }],
			streamSimple(model, context, streamOptions) {
				const stream = createAssistantMessageEventStream();
				void (async () => {
					await streamOptions?.onPayload?.({ offline: true }, model);
					await streamOptions?.onResponse?.({ status: 200, headers: {} }, model);
					const lastUser = context.messages.findLast(message => message.role === "user");
					const text = lastUser?.role === "user" ? typeof lastUser.content === "string" ? lastUser.content
						: lastUser.content.filter(block => block.type === "text").map(block => block.text).join("\n") : "";
					requests.push(text);
					requestSessions.push(streamOptions?.sessionId);
					const lastUserIndex = context.messages.findLastIndex(message => message.role === "user");
					const needsTool = text === "hold tools" && !context.messages.slice(lastUserIndex + 1).some(message => message.role === "toolResult");
					const failed = failNext;
					failNext = false;
					const message: AssistantMessage = { role: "assistant", provider: model.provider, model: model.id, api: model.api,
						content: failed ? [] : needsTool ? [{ type: "toolCall", id: "offline-tool", name: "continue_wait", arguments: {} }]
							: [{ type: "text", text: "offline completed" }],
						stopReason: failed ? "error" : needsTool ? "toolUse" : "stop", timestamp: Date.now(),
						usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						...(failed ? { errorMessage: "429 rate limit exceeded" } : {}) };
					stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
					if (failed) stream.push({ type: "error", reason: "error", error: message });
					else stream.push({ type: "done", reason: needsTool ? "toolUse" : "stop", message });
					stream.end(message);
				})().catch(error => { errors.push(String(error)); stream.end(); });
				return stream;
			},
		});
		installRailContinue(pi);
		pi.on("session_start", (_event, ctx) => { contexts.push(ctx); lastContext = ctx; });
		pi.on("input", async (event, ctx) => {
			inputs.push({ text: event.text, source: event.source, idle: ctx.isIdle() });
			if (event.source === "extension") await maybeHold("input", ctx);
		});
		pi.on("message_end", async (event, ctx) => { if (event.message.role === "assistant") await maybeHold("message_end", ctx); });
		pi.on("turn_end", async (_event, ctx) => { await maybeHold("turn_end", ctx); });
		pi.on("agent_end", async (_event, ctx) => { await maybeHold("agent_end", ctx); });
		pi.on("agent_before_settle", async (_event, ctx) => { await maybeHold("agent_before_settle", ctx); });
		pi.on("session_before_compact", async (_event, ctx) => { await maybeHold("compaction", ctx); return { cancel: true }; });
		pi.registerTool({ name: "continue_wait", label: "Offline wait", description: "Controlled offline wait",
			parameters: Type.Object({}), async execute(_id, _args, _signal, _update, ctx) {
				await maybeHold("tool", ctx);
				return { content: [{ type: "text", text: "released" }], details: undefined };
			} });
		pi.registerCommand("danger", { handler: async () => { slashDispatches++; } });
	};
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({ cwd, agentDir,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 },
				retry: { enabled: options.retry ?? false, maxRetries: 1, baseDelayMs: 1500 }, cacheWarming: "off" }),
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
				noContextFiles: true, extensionFactories: [factory] } });
		const model = services.modelRuntime.getModel(provider, "local");
		assert.ok(model, JSON.stringify(services.diagnostics));
		return { ...await createAgentSessionFromServices({ services, sessionManager, model, thinkingLevel: "off", noTools: "builtin",
			...(sessionStartEvent ? { sessionStartEvent } : {}) }), services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd: directory, agentDir: join(directory, "agent"),
		sessionManager: options.persisted ? SessionManager.create(directory, join(directory, "sessions")) : SessionManager.inMemory(directory) });
	const bind = async (session: AgentSession) => {
		await session.bindExtensions({ mode: "json", onError: error => { errors.push(`${error.event}: ${error.error}`); } });
		session.subscribe(event => { if (event.type === "auto_retry_start") retryStarted = true; });
	};
	runtime.setRebindSession(bind);
	await bind(runtime.session);
	t.after(async () => { hold?.release.resolve(); await runtime.dispose(); await rm(directory, { recursive: true, force: true }); });
	return {
		runtime, requests, requestSessions, inputs, errors, contexts,
		get session() { return runtime.session; },
		get ctx() { assert.ok(lastContext); return lastContext; },
		get slashDispatches() { return slashDispatches; },
		get retryStarted() { return retryStarted; },
		failNext() { failNext = true; },
		block(point: HoldPoint) {
			hold = { point, entered: deferred(), release: deferred(), used: false };
			return { entered: hold.entered.promise, release: hold.release.resolve };
		},
		label() { return railContinueLabel(runtime.session.sessionManager); },
		status() { return railContinueStatus(runtime.session.sessionManager); },
		command(args: string) { return runtime.session.prompt(`/rail-continue ${args}`); },
	};
}

test("real pinned Pi remains busy through assistant/tool/turn/agent gaps and restarts only at the deadline", { timeout: 30_000 }, async t => {
	for (const point of ["message_end", "tool", "turn_end", "agent_end", "agent_before_settle"] as const) {
		await t.test(point, async child => {
			const h = await harness(child);
			const gate = h.block(point);
			const run = h.session.prompt(point === "tool" ? "hold tools" : `hold ${point}`);
			await gate.entered;
			assert.equal(h.ctx.isIdle(), false, `${point} must not expose idle inside the same run`);
			await h.command(`1s deferred ${point}`);
			assert.equal(h.label(), "CONT-1-1m");
			await sleep(1150);
			assert.equal(h.requests.includes(`deferred ${point}`), false, h.status());
			assert.match(h.status(), /resets 1\b/, "only the due check performs the full restart");
			assert.equal(h.label(), "CONT-1-1m", "busy deadline must retain the task");
			gate.release();
			await run;
			await sleep(100);
			assert.equal(h.requests.includes(`deferred ${point}`), false, "settling early must not submit before the restarted interval");
			await until(() => h.requests.includes(`deferred ${point}`), `${point} restarted deadline`);
			await h.session.waitForIdle();
			assert.equal(h.label(), undefined, "one submission attempt consumes the task");
			await sleep(100);
			assert.equal(h.requests.filter(text => text === `deferred ${point}`).length, 1);
			assert.deepEqual(h.errors, []);
		});
	}
});

test("real session becoming idle before the first deadline never causes an early send", { timeout: 10_000 }, async t => {
	const h = await harness(t);
	const gate = h.block("tool");
	const run = h.session.prompt("hold tools");
	await gate.entered;
	await h.command("1s first deadline");
	await sleep(100);
	gate.release();
	await run;
	await sleep(200);
	assert.equal(h.requests.includes("first deadline"), false);
	assert.match(h.status(), /resets 0\b/);
	await until(() => h.requests.includes("first deadline"), "original deadline after early idle");
	await h.session.waitForIdle();
	assert.equal(h.label(), undefined);
	assert.deepEqual(h.errors, []);
});

test("real public send preserves literal slash, case and multiline text and never repeats", { timeout: 10_000 }, async t => {
	const h = await harness(t);
	const message = "/danger KeepCase 中文\nsecond LINE";
	await h.command(`1s ${message}`);
	await until(() => h.requests.includes(message), "literal scheduled user message");
	await h.session.waitForIdle();
	assert.equal(h.slashDispatches, 0, "scheduled leading slash must not execute an extension command");
	assert.ok(h.inputs.some(input => input.text === message && input.source === "extension"));
	assert.equal(h.label(), undefined);
	await sleep(1150);
	assert.deepEqual(h.requests, [message], "one-shot is not a periodic task");
	assert.deepEqual(h.errors, []);
});

test("public void send preflight race is consumed once, never queued or automatically retried", { timeout: 10_000 }, async t => {
	const h = await harness(t);
	const input = h.block("input");
	await h.command("1s preflight attempt");
	await input.entered;
	assert.equal(h.ctx.isIdle(), true, "pinned Pi has not reserved the run during awaited input preflight");
	assert.equal(h.label(), undefined, "void public send is an attempt, not a delivery acknowledgement");
	const tool = h.block("tool");
	const run = h.session.prompt("hold tools");
	await tool.entered;
	input.release();
	await until(() => h.errors.some(error => /already processing/u.test(error)), "public asynchronous send rejection");
	assert.equal(h.ctx.hasPendingMessages(), false, "no deliverAs means the raced attempt must not become queued work");
	tool.release();
	await run;
	await sleep(1150);
	assert.equal(h.requests.includes("preflight attempt"), false);
	assert.equal(h.inputs.filter(event => event.text === "preflight attempt").length, 1, "a rejected attempt is never retried");
	assert.equal(h.errors.length, 1, JSON.stringify(h.errors));
});

test("real queued steering/follow-up and retry backoff stay busy without postponing on input", { timeout: 10_000 }, async t => {
	await t.test("queued work", async child => {
		const h = await harness(child);
		const gate = h.block("tool");
		const run = h.session.prompt("hold tools");
		await gate.entered;
		await h.command("1s queued guard");
		await sleep(250);
		await h.session.steer("steering queued");
		await h.session.followUp("follow-up queued");
		assert.equal(h.ctx.hasPendingMessages(), true);
		await sleep(900);
		assert.equal(h.requests.includes("queued guard"), false, h.status());
		assert.match(h.status(), /resets 1\b/, "queued input must not postpone the first deadline");
		gate.release();
		await run;
		assert.ok(h.requests.includes("follow-up queued"), "real Pi drains follow-up work before settlement");
		await sleep(100);
		assert.equal(h.requests.includes("queued guard"), false);
		await until(() => h.requests.includes("queued guard"), "deadline after queued work");
		await h.session.waitForIdle();
		assert.deepEqual(h.errors, []);
	});
	await t.test("retry sleep", async child => {
		const h = await harness(child, { retry: true });
		h.failNext();
		const run = h.session.prompt("retry this locally");
		await until(() => h.retryStarted, "real automatic retry backoff");
		assert.equal(h.ctx.isIdle(), false);
		await h.command("1s retry guard");
		await sleep(1150);
		assert.equal(h.session.isRetrying, true);
		assert.equal(h.requests.includes("retry guard"), false, h.status());
		await run;
		assert.equal(h.requests.includes("retry guard"), false, "retry completion must not trigger early submission");
		await until(() => h.requests.includes("retry guard"), "deadline after retry settlement");
		await h.session.waitForIdle();
		assert.deepEqual(h.errors, []);
	});
});

test("real compaction is busy; cancellation, reload, new, switch, fork and tree invalidate tasks", { timeout: 20_000 }, async t => {
	await t.test("blocked manual compaction", async child => {
		const h = await harness(child);
		await h.session.prompt("first");
		await h.session.prompt("second");
		const gate = h.block("compaction");
		const compact = h.session.compact();
		await gate.entered;
		assert.equal(h.ctx.isIdle(), false);
		await h.command("1s compaction guard");
		await sleep(1150);
		assert.equal(h.requests.includes("compaction guard"), false, h.status());
		gate.release();
		await compact.catch(() => undefined);
		await sleep(100);
		assert.equal(h.requests.includes("compaction guard"), false);
		await until(() => h.requests.includes("compaction guard"), "post-compaction deadline");
		await h.session.waitForIdle();
		assert.deepEqual(h.errors, []);
	});
	await t.test("direct SDK disposal invalidates captured timer owners", async child => {
		const h = await harness(child);
		await h.command("1s disposed orphan");
		h.session.dispose();
		await sleep(1150);
		assert.equal(h.requests.includes("disposed orphan"), false);
		assert.equal(h.label(), undefined);
		assert.deepEqual(h.errors, []);
	});
	await t.test("already handed-off preflight is not transactional across session replacement", async child => {
		const h = await harness(child);
		const originalId = h.session.sessionId;
		const input = h.block("input");
		await h.command("1s old preflight handoff");
		await input.entered;
		assert.equal(h.label(), undefined, "attempt was consumed before the runtime changed");
		await h.runtime.newSession();
		assert.notEqual(h.session.sessionId, originalId);
		assert.equal(h.label(), undefined, "no task authorization carries into the replacement session");
		input.release();
		await until(() => h.errors.length > 0, "pinned public API's already-started old-session preflight");
		assert.deepEqual(h.requestSessions, [originalId],
			"Pi can still call the provider for the disposed old session, not the new owner");
		assert.equal(h.session.messages.some(message => message.role === "user"), false);
		assert.ok(h.errors.every(error => /turn_end could not resolve the persisted assistant entry ID/u.test(error)), JSON.stringify(h.errors));
		child.diagnostic("Pinned Pi limitation: a void send already awaiting input can still reach the old-session provider after replacement; no task or user history carries into the new session.");
	});
	await t.test("cancel and runtime replacement", async child => {
		const h = await harness(child, { persisted: true });
		await h.session.prompt("establish persisted history");
		const originalFile = h.session.sessionFile;
		assert.ok(originalFile);
		await h.command("1s cancelled");
		await h.command("cancel all");
		assert.equal(h.label(), undefined);
		await h.command("1s reload orphan");
		await h.session.reload();
		assert.equal(h.label(), undefined);
		await h.command("1s new orphan");
		await h.runtime.newSession();
		assert.equal(h.label(), undefined);
		await h.command("1s switch orphan");
		await h.runtime.switchSession(originalFile);
		assert.equal(h.label(), undefined);
		const user = h.session.sessionManager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user");
		assert.ok(user);
		await h.command("1s fork orphan");
		await h.runtime.fork(user.id, { position: "at" });
		assert.equal(h.label(), undefined);
		await h.session.prompt("fork continuation");
		await h.command("1s tree orphan");
		await h.session.navigateTree(user.id, { summarize: false });
		assert.equal(h.label(), undefined);
		await sleep(1150);
		assert.equal(h.requests.some(text => /orphan|cancelled/u.test(text)), false, "old callbacks must not regain authorization in another context");
		assert.deepEqual(h.errors, []);
	});
});
