import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { getCurrentSystemMessage, type SystemMessage, type Usage } from "@earendil-works/pi-ai";
import { AgentSession, buildSessionContext, sessionEntryToContextMessages, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { prepareCompaction } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
import { installGptCompaction } from "../../tools/gpt-compaction/extension";
import { rebuildNativeHistory, rebuildNativeHistoryPrefix } from "../../tools/gpt-compaction/history";
import { readGptCompactionSettings, writeGptCompactionMode } from "../../tools/gpt-compaction/settings";
import { gptCompactionSummary, isGptCompactionSummaryText, type GptCompactionDetails } from "../../tools/gpt-compaction/types";

const usage: Usage = { input: 11, output: 3, cacheRead: 5, cacheWrite: 7, totalTokens: 26, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };
const model = { provider: "local", api: "openai-responses", id: "gpt-repair", name: "Local repair", baseUrl: "http://localhost.invalid/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 100 };
const tool = (name: string, description: string) => ({ name, description, parameters: { type: "object" as const, properties: {} } });
const user = (manager: SessionManager, content: string) => manager.appendMessage({ role: "user", content, timestamp: 1 });
const system = (manager: SessionManager, patch: Omit<SystemMessage, "role" | "timestamp">) => manager.appendMessage({ role: "system", timestamp: 1, ...patch });

function nativeBranch() {
	const manager = SessionManager.inMemory();
	system(manager, { content: "BASE", sections: { policy: "old", obsolete: "remove me" }, toolsAdded: [tool("read", "old"), tool("gone", "obsolete")] });
	user(manager, "summarized");
	const kept = user(manager, "retained");
	system(manager, { content: "DYNAMIC", sections: { policy: "new", obsolete: null }, toolsRemoved: [{ name: "gone" }], toolsAdded: [tool("read", "new")] });
	user(manager, "also retained");
	const native = manager.appendCompaction("native summary", kept, 100);
	system(manager, { content: "LIVE", sections: { policy: null, fresh: "current" }, toolsRemoved: [{ name: "read" }], toolsAdded: [tool("live", "live tool")] });
	user(manager, "new work");
	return { manager, kept, native };
}

test("native replay matches Pi 0.87 snapshot and post-boundary system deltas", () => {
	const { manager } = nativeBranch();
	const expected = manager.buildSessionContext().messages;
	const rebuilt = rebuildNativeHistory(manager.getBranch()).messages;
	assert.deepEqual(rebuilt, expected);
	const current = getCurrentSystemMessage(rebuilt);
	assert.deepEqual(current, getCurrentSystemMessage(expected));
	assert.equal(current?.content, "BASE\n\nDYNAMIC\n\nLIVE");
	assert.deepEqual(current?.sections, { fresh: "current" });
	assert.deepEqual(current?.toolsAdded, [tool("live", "live tool")]);
	assert.equal(rebuilt.filter((message) => message.role === "system").length, 2);
});

test("prefix cuts inside retained history use the complete native snapshot, without old deltas", () => {
	const { manager, kept, native } = nativeBranch();
	const branch = manager.getBranch();
	const keptIndex = branch.findIndex((entry) => entry.id === kept);
	const official = manager.buildContextEntries();
	for (let end = keptIndex + 1; end <= branch.length; end += 1) {
		// Keep the logical checkpoint even when the physical compaction is after the cut.
		const selected = official.filter((entry) => entry.id === native || branch.indexOf(entry) < end);
		const expected = selected.flatMap(sessionEntryToContextMessages);
		assert.deepEqual(rebuildNativeHistoryPrefix(branch, end)?.messages, expected, `cut ${end}`);
	}
	assert.deepEqual(rebuildNativeHistoryPrefix(branch, keptIndex)?.messages, buildSessionContext(branch.slice(0, keptIndex)).messages);
});

test("legacy native boundaries also follow official retained-system filtering", () => {
	const { manager, native } = nativeBranch();
	const branch = structuredClone(manager.getBranch());
	const entry = branch.find((candidate) => candidate.id === native);
	assert.equal(entry?.type, "compaction");
	if (entry?.type === "compaction") delete entry.systemMessage;
	assert.deepEqual(rebuildNativeHistory(branch).messages, buildSessionContext(branch).messages);
});

test("replay across a later remote checkpoint uses only the native snapshot and live deltas", () => {
	const { manager } = nativeBranch();
	const expected = manager.buildSessionContext().messages;
	manager.appendCompaction(gptCompactionSummary("later-remote"), manager.getLeafId()!, 100);
	system(manager, { content: "AFTER REMOTE", sections: { fresh: null }, toolsRemoved: [{ name: "live" }] });
	const branch = manager.getBranch();
	const messages = [...expected, ...sessionEntryToContextMessages(branch.at(-1)!)];
	assert.deepEqual(rebuildNativeHistory(branch).messages, messages);
	assert.deepEqual(rebuildNativeHistoryPrefix(branch, branch.length)?.messages, messages);
});

async function harness(t: TestContext, withUsage: boolean, reserveTokens = 200, validCheckpoint = true, tail: "messages" | "metadata" | "none" = "messages", withNative = false, history = ["history to summarize"]) {
	const sandbox = await mkdtemp(join(tmpdir(), "pi087-repair-"));
	const previous = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = sandbox;
	t.after(async () => {
		if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previous;
		await rm(sandbox, { recursive: true, force: true });
	});
	writeGptCompactionMode("on");
	const settings = SettingsManager.inMemory({ compaction: { reserveTokens: 32, keepRecentTokens: 50_000, modelOverrides: { "local/gpt-repair": { reserveTokens, keepRecentTokens: 1 } } } });
	let projectTrusted = false;
	const createSpy = t.mock.method(SettingsManager, "create", (...[_cwd, _agentDir, options]: Parameters<typeof SettingsManager.create>) => {
		assert.deepEqual(options, { projectTrusted });
		return settings;
	});
	const settingsSpy = t.mock.method(settings, "getCompactionSettings");
	const manager = SessionManager.inMemory(sandbox);
	system(manager, { content: "BASE", sections: { policy: "old" }, toolsAdded: [tool("read", "old")] });
	for (const content of history) user(manager, content);
	if (withNative) {
		const priorKept = user(manager, "prior retained");
		manager.appendCompaction("older native summary", priorKept, 100);
	}
	const kept = user(manager, "retained work");
	system(manager, { content: "DELTA", sections: { policy: null }, toolsRemoved: [{ name: "read" }] });
	user(manager, "also retained work");
	const identity = { provider: model.provider, api: model.api, model: model.id, baseUrl: model.baseUrl };
	const item = { type: "compaction" as const, encrypted_content: "opaque" };
	const details: GptCompactionDetails = {
		version: 2, strategy: "gpt-remote-compaction-v2", checkpointId: "repair",
		consumer: identity, producer: identity, checkpoint: item, replacement: [item],
		boundary: { parentEntryId: manager.getLeafId(), firstKeptEntryId: kept, tokensBefore: 100 },
		createdAt: new Date(0).toISOString(),
	};
	const checkpoint = manager.appendCompaction(gptCompactionSummary("repair"), kept, 100, validCheckpoint ? details : undefined);
	const usageEntries = withUsage ? [
		manager.appendUsage("cache_warm", model.provider, model.id, usage, "cache warm note"),
		manager.appendUsage("future-unknown-kind", model.provider, model.id, usage, "future operation"),
	] : [];
	if (tail === "messages") {
		system(manager, { content: "LIVE", sections: { policy: "new" }, toolsAdded: [tool("read", "redefined")] });
		user(manager, "live tail");
	}
	const originalLeaf = manager.getLeafId()!;
	const originalBranch = structuredClone(manager.getBranch());
	const originalSystem = getCurrentSystemMessage(manager.buildSessionContext().messages);
	const handlers = new Map<string, any>();
	const commands = new Map<string, any>();
	const notices: string[] = [];
	const requests: any[] = [];
	installGptCompaction({
		events: { emit() {}, on() {} },
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getActiveTools: () => [], getAllTools: () => [],
	} as any);
	let fail = false;
	let compactions = 0;
	let beforeHook: (() => void) | undefined;
	let duringSummary: (() => void) | undefined;
	let cancelCurrent: (() => void) | undefined;
	const ctx: any = {
		cwd: sandbox, model, sessionManager: manager, thinkingLevel: "off", hasUI: false,
		waitForIdle: async () => {}, getSystemPrompt: () => "", abort() {}, isProjectTrusted: () => projectTrusted,
		ui: { notify: (text: string) => notices.push(text), setStatus() {} },
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "local-test", baseUrl: model.baseUrl }),
			complete: async (_model: unknown, context: unknown, options: unknown) => {
				requests.push({ context, options });
				duringSummary?.();
				if (fail) throw new Error("local repair failed");
				return { role: "assistant", content: [{ type: "text", text: "repaired summary" }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: 1 };
			},
		},
		compact: (callbacks: any) => {
			compactions += 1;
			// Exercise the actual native preparation, hook, append and context rebuild.
			// Only runtime/UI/auth dependencies are offline adapters.
			const session = {
				model, sessionManager: manager, settingsManager: settings,
				agent: { state: { messages: manager.buildSessionContext().messages } },
				abort: async () => {}, _emit() {}, _clearManualCompactionState() {}, _emitSessionCompactFailed: async () => {},
				_getSummarizationRequestAuth: async () => {
					beforeHook?.();
					return { model, apiKey: "local-test" };
				},
				_refreshFinalizedContext: () => {
					session.agent.state.messages = manager.buildSessionProjection().messages;
				},
				_extensionRunner: {
					hasHandlers: (name: string) => handlers.has(name),
					emit: (event: any) => handlers.get(event.type)?.(event, ctx),
				},
			};
			cancelCurrent = () => AgentSession.prototype.abortCompaction.call(session as unknown as AgentSession);
			void AgentSession.prototype.compact.call(session as unknown as AgentSession).then(callbacks.onComplete, callbacks.onError);
		},
	};
	return { manager, originalLeaf, originalBranch, originalSystem, usageEntries, checkpoint, requests, notices, settingsSpy, createSpy,
		setTrusted: () => { projectTrusted = true; },
		beforeHook: (callback: () => void) => { beforeHook = callback; },
		duringSummary: (callback: () => void) => { duringSummary = callback; },
		cancel: () => cancelCurrent?.(),
		off: () => commands.get("rail-oai-compaction").handler("off", ctx),
		resume: () => handlers.get("session_start")({}, ctx),
		compact: () => new Promise((resolve, reject) => ctx.compact({ onComplete: resolve, onError: reject })),
		setFailure: (value: boolean) => { fail = value; },
		compactions: () => compactions,
	};
}

function totals(manager: SessionManager) {
	return AgentSession.prototype.getSessionStats.call({ sessionManager: manager, getContextUsage: () => undefined } as unknown as AgentSession);
}

test("off appends on the original branch and actual clone preserves each ledger entry exactly once", async (t) => {
	const h = await harness(t, true);
	h.beforeHook(() => assert.equal(h.manager.getLeafId(), h.originalLeaf, "compactable tail needs no temporary branch"));
	const before = totals(h.manager);
	assert.equal(before.cost, usage.cost.total * 2);
	assert.equal(before.tokens.total, usage.totalTokens * 2);
	await h.off();
	assert.equal(readGptCompactionSettings().mode, "off", h.notices.join("\n"));
	assert.equal(h.compactions(), 1);
	assert.deepEqual(h.manager.getEntries().filter((entry) => entry.type === "usage"), h.usageEntries);
	assert.deepEqual(h.manager.getBranch(h.originalLeaf), h.originalBranch);
	assert.deepEqual(h.manager.getBranch().slice(0, -1), h.originalBranch);
	assert.deepEqual(h.manager.getEntries().slice(0, -1), h.originalBranch);
	assert.equal(totals(h.manager).cost, before.cost + usage.cost.total, "only new summarization work is charged");
	assert.deepEqual(totals(h.manager).tokens, { input: 33, output: 9, cacheRead: 15, cacheWrite: 21, total: 78 });
	assert.equal(h.requests.length, 1);
	assert.equal(h.requests[0].options.maxTokens, model.maxTokens, "repair uses the model-specific reserve, not the ordinary 32 tokens");
	const repaired = h.manager.getLeafEntry();
	assert.equal(repaired?.type, "compaction");
	assert.ok(repaired?.type === "compaction" && repaired.systemMessage);
	assert.ok(h.manager.getBranch().findIndex((entry) => entry.id === repaired.firstKeptEntryId)
		> h.manager.getBranch().findIndex((entry) => entry.id === h.checkpoint));
	assert.ok(!JSON.stringify(h.manager.buildSessionContext().messages).includes(gptCompactionSummary("repair")));
	assert.ok(JSON.stringify(h.requests[0].context).includes("retained work"), "old retained messages must now be summarized");
	assert.ok(JSON.stringify(h.manager.buildSessionContext().messages).includes("live tail"));
	const snapshot = repaired.systemMessage;
	assert.equal(snapshot.content, "BASE\n\nDELTA\n\nLIVE");
	assert.deepEqual(snapshot.sections, { policy: "new" });
	assert.deepEqual(snapshot.toolsAdded, [tool("read", "redefined")]);
	const current = getCurrentSystemMessage(h.manager.buildSessionContext().messages);
	assert.deepEqual(current && { ...current, timestamp: 0 }, h.originalSystem && { ...h.originalSystem, timestamp: 0 });
	const after = totals(h.manager);
	await h.off();
	assert.deepEqual(totals(h.manager), after, "repeated off is idempotent");
	const context = h.manager.buildSessionContext();
	h.manager.createBranchedSession(h.manager.getLeafId()!);
	assert.equal(totals(h.manager).cost, after.cost);
	assert.deepEqual(totals(h.manager).tokens, after.tokens);
	assert.deepEqual(h.manager.buildSessionContext(), context);
	assert.deepEqual(h.manager.getEntries().filter((entry) => entry.type === "usage"), h.usageEntries);
});

test("repeated failed repair leaves all source entries untouched; retry does not duplicate usage", async (t) => {
	const h = await harness(t, true, 200, false);
	const before = totals(h.manager);
	h.setFailure(true);
	await h.off();
	await h.off();
	assert.equal(h.compactions(), 2, h.notices.join("\n"));
	assert.deepEqual(h.manager.getEntries(), h.originalBranch, "failed attempts must not append replayed messages or ledger entries");
	assert.equal(readGptCompactionSettings().mode, "on");
	assert.equal(h.manager.getLeafId(), h.originalLeaf);
	assert.equal(totals(h.manager).cost, before.cost);
	assert.deepEqual(h.manager.getEntries().filter((entry) => entry.type === "usage"), h.usageEntries);
	h.setFailure(false);
	await h.off();
	assert.equal(readGptCompactionSettings().mode, "off", h.notices.join("\n"));
	assert.equal(totals(h.manager).cost, before.cost + usage.cost.total);
	assert.deepEqual(h.manager.getEntries().filter((entry) => entry.type === "usage"), h.usageEntries);
	assert.deepEqual(h.manager.getEntries().slice(0, -1), h.originalBranch);
	h.manager.createBranchedSession(h.manager.getLeafId()!);
	assert.equal(totals(h.manager).cost, before.cost + usage.cost.total);
	assert.deepEqual(h.manager.getEntries().filter((entry) => entry.type === "usage"), h.usageEntries);
});

test("repair and unsafe resume resolve compaction budgets with the actual active model", async (t) => {
	const h = await harness(t, true, 127_800);
	const before = totals(h.manager);
	await h.resume();
	assert.equal(h.compactions(), 1, "model override leaves too little room, so resume must repair");
	assert.ok(h.settingsSpy.mock.calls.length >= 3);
	for (const call of h.settingsSpy.mock.calls) assert.equal(call.arguments[0], model);
	assert.ok(h.requests.length > 0);
	assert.equal(totals(h.manager).cost, before.cost + usage.cost.total);
	assert.equal(totals(h.manager).tokens.total, before.tokens.total + usage.totalTokens);
	assert.deepEqual(h.manager.getEntries().filter((entry) => entry.type === "usage"), h.usageEntries);
	assert.deepEqual(h.manager.getBranch().filter((entry) => entry.type === "usage"), h.usageEntries);
});

test("usage-only tail repairs without dropping any logical history and survives extraction", async (t) => {
	const h = await harness(t, true, 200, true, "metadata");
	const before = totals(h.manager);
	await h.off();
	assert.equal(readGptCompactionSettings().mode, "off", h.notices.join("\n"));
	assert.deepEqual(h.manager.getEntries().slice(0, -1), h.originalBranch);
	const prompt = JSON.stringify(h.requests[0].context);
	assert.ok(prompt.includes("history to summarize"));
	assert.ok(prompt.includes("retained work"));
	assert.ok(prompt.includes("also retained work"));
	assert.ok(!prompt.includes(gptCompactionSummary("repair")));
	assert.deepEqual(h.manager.buildSessionContext().messages.map((message) => message.role), ["system", "compactionSummary"]);
	h.manager.createBranchedSession(h.manager.getLeafId()!);
	assert.equal(totals(h.manager).cost, before.cost + usage.cost.total);
	assert.deepEqual(h.manager.getEntries().filter((entry) => entry.type === "usage"), h.usageEntries);
});

test("checkpoint-only slash off preserves successful sibling-native repair without duplicates", async (t) => {
	const h = await harness(t, false, 200, true, "none");
	const before = totals(h.manager);
	await assert.rejects(h.compact(), /Already compacted/);
	await h.off();
	await h.off();
	assert.equal(readGptCompactionSettings().mode, "off", h.notices.join("\n"));
	assert.equal(h.requests.length, 1);
	assert.deepEqual(h.manager.getEntries().slice(0, -1), h.originalBranch);
	assert.deepEqual(h.manager.getBranch(h.originalLeaf), h.originalBranch);
	assert.equal(h.manager.getLeafEntry()?.parentId, h.originalBranch.at(-1)?.parentId);
	assert.equal(totals(h.manager).cost, before.cost + usage.cost.total);
	assert.ok(!JSON.stringify(h.manager.buildSessionContext()).includes(gptCompactionSummary("repair")));
});

async function repeatedCheckpoint(t: TestContext, validOlder = true, safeTail = true) {
	const h = await harness(t, false, 200, validOlder, "none");
	if (safeTail) {
		h.manager.appendUsage("cache_warm", model.provider, model.id, usage, "between checkpoints");
		user(h.manager, "intervening logical history");
		h.manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "retained-call", name: "read", arguments: {} }],
			api: model.api, provider: model.provider, model: model.id, usage, stopReason: "toolUse", timestamp: 1 });
	}
	h.manager.appendMessage({ role: "toolResult", toolCallId: "retained-call", toolName: "read", content: [{ type: "text", text: "intervening tool output" }], isError: false, timestamp: 1 });
	const source = h.manager.getBranch();
	const olderIndex = source.findIndex((entry) => entry.id === h.checkpoint);
	// Use Pi's real preparation to find an admissible overlapping retained span,
	// rather than manufacture a boundary that remote compaction could never write.
	let preparation: ReturnType<typeof prepareCompaction>;
	for (let keepRecentTokens = 1; keepRecentTokens <= 1_000; keepRecentTokens += 1) {
		const candidate = prepareCompaction(source, { enabled: true, reserveTokens: 200, keepRecentTokens });
		if (candidate && source.findIndex((entry) => entry.id === candidate.firstKeptEntryId) < olderIndex) {
			preparation = candidate;
			break;
		}
	}
	assert.ok(preparation, "official preparation must admit an overlapping boundary");
	const identity = { provider: model.provider, api: model.api, model: model.id, baseUrl: model.baseUrl };
	const item = { type: "compaction" as const, encrypted_content: "newest opaque" };
	const details: GptCompactionDetails = {
		version: 2, strategy: "gpt-remote-compaction-v2", checkpointId: "newest",
		consumer: identity, producer: identity, checkpoint: item, replacement: [item],
		boundary: { parentEntryId: h.manager.getLeafId(), firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore },
		createdAt: new Date(0).toISOString(),
	};
	h.manager.appendCompaction(gptCompactionSummary("newest"), preparation.firstKeptEntryId, preparation.tokensBefore, details);
	return h;
}

test("checkpoint-only sibling repair excludes older remote and invalid markers at reachable overlapping boundaries", async (t) => {
	for (const validOlder of [true, false]) {
		await t.test(validOlder ? "remote" : "invalid", async (t) => {
			const h = await repeatedCheckpoint(t, validOlder);
			const original = structuredClone(h.manager.getEntries());
			const leaf = h.manager.getLeafId()!;
			const before = totals(h.manager);
			await h.off();
			assert.equal(readGptCompactionSettings().mode, "off", h.notices.join("\n"));
			const context = h.manager.buildSessionContext();
			assert.ok(!isGptCompactionSummaryText(JSON.stringify(context)), "no remote marker may survive in native context");
			assert.equal(h.requests.length, 1);
			const prompt = JSON.stringify(h.requests[0].context);
			assert.ok(!isGptCompactionSummaryText(prompt));
			for (const text of ["history to summarize", "retained work", "also retained work", "intervening logical history"]) assert.ok(prompt.includes(text), text);
			assert.deepEqual(context.messages.filter((message) => message.role !== "system").map((message) => message.role), ["compactionSummary", "assistant", "toolResult"]);
			assert.ok(JSON.stringify(context).includes("intervening tool output"));
			assert.deepEqual(h.manager.getEntries().slice(0, -1), original);
			assert.deepEqual(h.manager.getBranch(leaf), original);
			assert.equal(h.manager.getLeafEntry()?.parentId, original.at(-1)?.parentId);
			assert.equal(totals(h.manager).cost, before.cost + usage.cost.total);
			assert.equal(totals(h.manager).tokens.total, before.tokens.total + usage.totalTokens);
			const after = totals(h.manager);
			h.manager.createBranchedSession(h.manager.getLeafId()!);
			assert.deepEqual(h.manager.buildSessionContext(), context);
			assert.equal(totals(h.manager).cost, after.cost);
			assert.deepEqual(totals(h.manager).tokens, after.tokens);
			assert.deepEqual(h.manager.getEntries().filter((entry) => entry.type === "usage"), original.filter((entry) => entry.type === "usage"));
		});
	}
});

test("overlapping sibling repair fails closed without mutation when no paired safe anchor exists", async (t) => {
	const h = await repeatedCheckpoint(t, true, false);
	const original = structuredClone(h.manager.getEntries());
	const leaf = h.manager.getLeafId();
	const before = totals(h.manager);
	await h.off();
	assert.equal(readGptCompactionSettings().mode, "on");
	assert.ok(h.notices.some((notice) => notice.includes("no-safe-native-repair-boundary")));
	assert.equal(h.compactions(), 0);
	assert.equal(h.requests.length, 0);
	assert.equal(h.manager.getLeafId(), leaf);
	assert.deepEqual(h.manager.getEntries(), original);
	assert.deepEqual(totals(h.manager), before);
});

test("overlapping sibling repair cancellation restores the newest checkpoint and allows retry", async (t) => {
	const h = await repeatedCheckpoint(t);
	const original = structuredClone(h.manager.getEntries());
	const leaf = h.manager.getLeafId();
	const before = totals(h.manager);
	h.duringSummary(() => h.cancel());
	await h.off();
	assert.equal(readGptCompactionSettings().mode, "on");
	assert.equal(h.manager.getLeafId(), leaf);
	assert.deepEqual(h.manager.getEntries(), original);
	assert.deepEqual(totals(h.manager), before);
	h.duringSummary(() => {});
	await h.off();
	assert.equal(readGptCompactionSettings().mode, "off", h.notices.join("\n"));
	assert.ok(!isGptCompactionSummaryText(JSON.stringify(h.manager.buildSessionContext())));
	assert.deepEqual(h.manager.getEntries().slice(0, -1), original);
	assert.equal(totals(h.manager).cost, before.cost + usage.cost.total);
});

test("small usage-only tail repairs through source-branch admission when original history is compactable", async (t) => {
	const h = await harness(t, true, 200, true, "metadata", false, ["early history", "large original history ".repeat(12_000)]);
	h.settingsSpy.mock.mockImplementation(() => ({ enabled: true, reserveTokens: 200, keepRecentTokens: 50_000 }));
	h.beforeHook(() => assert.equal(h.manager.getLeafId(), h.originalBranch.find((entry) => entry.id === h.checkpoint)?.parentId));
	await h.off();
	assert.equal(readGptCompactionSettings().mode, "off", h.notices.join("\n"));
	assert.ok(h.requests.length >= 1);
	assert.deepEqual(h.manager.getEntries().slice(0, -1), h.originalBranch);
	assert.deepEqual(h.manager.getBranch().slice(0, -1), h.originalBranch);
	h.manager.createBranchedSession(h.manager.getLeafId()!);
	assert.deepEqual(h.manager.getEntries().filter((entry) => entry.type === "usage"), h.usageEntries);
});

test("native repair starts at the first canonical survivor after a remote checkpoint", async (t) => {
	const h = await harness(t, false, 200, true, "none");
	const omitted = user(h.manager, "post-checkpoint response omitted by context edit");
	h.manager.appendContextEdit(omitted, null);
	const live = user(h.manager, "post-checkpoint live request");
	// Make Pi's native preparation admit the compaction hook, while keeping its budget above the short live tail.
	h.settingsSpy.mock.mockImplementation(() => ({ enabled: true, reserveTokens: 200, keepRecentTokens: 10 }));

	await h.off();

	assert.equal(readGptCompactionSettings().mode, "off", h.notices.join("\n"));
	const native = h.manager.getLeafEntry();
	assert.equal(native?.type, "compaction");
	if (native?.type !== "compaction") return;
	assert.equal(native.firstKeptEntryId, live);
	const branch = h.manager.getBranch();
	assert.ok(branch.findIndex((entry) => entry.id === native.firstKeptEntryId) > branch.findIndex((entry) => entry.id === h.checkpoint));
	const request = JSON.stringify(h.requests[0]?.context);
	assert.match(request, /history to summarize/);
	assert.match(request, /retained work/);
	assert.doesNotMatch(request, /post-checkpoint response omitted by context edit|post-checkpoint live request/);
});

test("repair summarizes the logical native prefix, not previously discarded messages", async (t) => {
	const h = await harness(t, true, 200, true, "messages", true);
	await h.off();
	assert.equal(readGptCompactionSettings().mode, "off", h.notices.join("\n"));
	const prompt = JSON.stringify(h.requests[0].context);
	assert.ok(prompt.includes("older native summary"));
	assert.ok(prompt.includes("prior retained"));
	assert.ok(prompt.includes("retained work"));
	assert.ok(!prompt.includes("history to summarize"));
	assert.deepEqual(h.manager.getEntries().slice(0, -1), h.originalBranch);
});

test("retained tool calls and results stay paired, including nested tool usage, through clone", async (t) => {
	const h = await harness(t, true);
	h.manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
		api: model.api, provider: model.provider, model: model.id, usage, stopReason: "toolUse", timestamp: 1 });
	h.manager.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "tool output" }], usage, isError: false, timestamp: 1 });
	const original = structuredClone(h.manager.getEntries());
	const before = totals(h.manager);
	await h.off();
	assert.equal(readGptCompactionSettings().mode, "off", h.notices.join("\n"));
	assert.deepEqual(h.manager.getEntries().slice(0, -1), original);
	assert.deepEqual(h.manager.buildSessionContext().messages.map((message) => message.role), ["system", "compactionSummary", "assistant", "toolResult"]);
	h.manager.createBranchedSession(h.manager.getLeafId()!);
	assert.equal(totals(h.manager).cost, before.cost + usage.cost.total);
	assert.equal(totals(h.manager).tokens.total, before.tokens.total + usage.totalTokens);
});

test("a tool result crossing the opaque boundary cannot become an orphaned retained tail", async (t) => {
	const h = await harness(t, true, 200, true, "metadata");
	h.manager.appendMessage({ role: "toolResult", toolCallId: "pre-checkpoint-call", toolName: "read", content: [{ type: "text", text: "result" }], isError: false, timestamp: 1 });
	const original = structuredClone(h.manager.getEntries());
	await h.off();
	assert.equal(readGptCompactionSettings().mode, "on");
	assert.equal(h.requests.length, 0);
	assert.deepEqual(h.manager.getEntries(), original);
});

test("ordinary native repair hooks also keep the opaque checkpoint out of retained context", async (t) => {
	const h = await harness(t, true);
	writeGptCompactionMode("off");
	await h.compact();
	assert.deepEqual(h.manager.getEntries().slice(0, -1), h.originalBranch);
	assert.ok(!JSON.stringify(h.manager.buildSessionContext().messages).includes(gptCompactionSummary("repair")));
	assert.ok(JSON.stringify(h.requests[0].context).includes("retained work"));
});

test("cancellation restores exact entries and leaf, with and without a usage tail", async (t) => {
	for (const withUsage of [false, true]) {
		await t.test(String(withUsage), async (t) => {
			const h = await harness(t, withUsage, 200, true, "none");
			h.duringSummary(() => {
				if (withUsage) assert.equal(h.manager.getLeafId(), h.originalLeaf, "restore before provider I/O");
				h.cancel();
			});
			await h.off();
			assert.equal(readGptCompactionSettings().mode, "on");
			assert.deepEqual(h.manager.getEntries(), h.originalBranch);
			assert.equal(h.manager.getLeafId(), h.originalLeaf);
			h.duringSummary(() => {});
			await h.off();
			assert.equal(readGptCompactionSettings().mode, "off", h.notices.join("\n"));
			assert.deepEqual(h.manager.getEntries().slice(0, -1), h.originalBranch);
		});
	}
});

test("pre-hook failure restores the temporary branch and permits retry", async (t) => {
	const h = await harness(t, false, 200, true, "none");
	h.beforeHook(() => { throw new Error("auth failed before hook"); });
	await h.off();
	await h.off();
	assert.equal(h.requests.length, 0);
	assert.equal(h.manager.getLeafId(), h.originalLeaf);
	assert.deepEqual(h.manager.getEntries(), h.originalBranch);
	h.beforeHook(() => {});
	await h.off();
	assert.equal(readGptCompactionSettings().mode, "off", h.notices.join("\n"));
});

test("trusted projects pass the actual trust decision to repair settings", async (t) => {
	const h = await harness(t, true);
	h.setTrusted();
	await h.off();
	assert.equal(readGptCompactionSettings().mode, "off", h.notices.join("\n"));
	assert.ok(h.createSpy.mock.calls.length > 0);
});

test("external leaf changes before the hook or during summary are never overwritten", async (t) => {
	for (const phase of ["beforeHook", "duringSummary"] as const) {
		await t.test(phase, async (t) => {
			const h = await harness(t, true);
			const externalLeaf = h.originalBranch[1]!.id;
			h[phase](() => h.manager.branch(externalLeaf));
			await h.off();
			assert.equal(readGptCompactionSettings().mode, "on");
			assert.equal(h.manager.getLeafId(), externalLeaf);
			assert.deepEqual(h.manager.getEntries(), h.originalBranch);
		});
	}
});

test("cross-checkpoint tool results are summarized when a later safe anchor exists", async (t) => {
	const h = await harness(t, true);
	h.manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "crossing", name: "read", arguments: {} }],
		api: model.api, provider: model.provider, model: model.id, usage, stopReason: "toolUse", timestamp: 1 });
	h.manager.appendCompaction(gptCompactionSummary("crossing"), h.originalBranch[1]!.id, 100);
	h.manager.appendMessage({ role: "toolResult", toolCallId: "crossing", toolName: "read", content: [{ type: "text", text: "crossing output" }], isError: false, timestamp: 1 });
	user(h.manager, "later safe anchor");
	// Retain the whole tail by budget, so the repair must advance past the orphan.
	h.settingsSpy.mock.mockImplementation(() => ({ enabled: true, reserveTokens: 200, keepRecentTokens: 20 }));
	const original = structuredClone(h.manager.getEntries());
	await h.off();
	assert.equal(readGptCompactionSettings().mode, "off", h.notices.join("\n"));
	assert.deepEqual(h.manager.getEntries().slice(0, -1), original);
	assert.ok(JSON.stringify(h.requests).includes("crossing output"));
	assert.ok(!h.manager.buildSessionContext().messages.some((message) => message.role === "toolResult"));
	assert.ok(JSON.stringify(h.manager.buildSessionContext()).includes("later safe anchor"));
});
