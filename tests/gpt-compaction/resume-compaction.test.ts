import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSession, SessionManager, type AgentSessionEvent, type CompactOptions, type CompactionResult, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requestNativeRepairCompaction } from "../../tools/gpt-compaction/resume-compaction";

const repaired: CompactionResult = { summary: "native repair", firstKeptEntryId: "retained", tokensBefore: 100 };

function preparingSession(event?: AgentSessionEvent) {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	let automatic = 0;
	const session = Object.assign(Object.create(AgentSession.prototype), {
		sessionManager: SessionManager.inMemory(),
		agent: { state: { isStreaming: false } },
		_isAgentRunActive: true,
		subscribe(listener: (event: AgentSessionEvent) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async _runAutoCompaction(reason: string, willRetry: boolean) {
			assert.equal(reason, "threshold");
			assert.equal(willRetry, false);
			automatic += 1;
			if (event) for (const listener of listeners) listener(event);
			return false;
		},
	}) as AgentSession;
	const ctx = {
		sessionManager: session.sessionManager,
		compact(options: CompactOptions) {
			void session.compact().then(options.onComplete, options.onError);
		},
	} as unknown as ExtensionContext;
	return { session, ctx, listeners, automatic: () => automatic };
}

function request(ctx: ExtensionContext, beforeStart?: () => void): Promise<CompactionResult> {
	return new Promise((resolve, reject) => requestNativeRepairCompaction(ctx, { onComplete: resolve, onError: reject }, beforeStart));
}

test("native repair bridges only its own preparing run and immediately restores manual compaction", async (t) => {
	let manual = 0;
	const original = t.mock.method(AgentSession.prototype, "compact", async () => { manual += 1; return repaired; });
	for (const phase of ["preparing", "idle", "other-session"] as const) {
		let prepared = 0;
		const harness = preparingSession({ type: "compaction_end", reason: "threshold", result: repaired, aborted: false, willRetry: false });
		if (phase === "idle") Object.assign(harness.session, { _isAgentRunActive: false });
		if (phase === "other-session") harness.ctx.sessionManager = SessionManager.inMemory();
		const pending = request(harness.ctx, () => { prepared += 1; });
		assert.equal(AgentSession.prototype.compact, original, "other operations must not retain the bridge while repair is pending");
		assert.equal(await pending, repaired);
		assert.equal(harness.automatic(), phase === "preparing" ? 1 : 0);
		assert.equal(prepared, phase === "other-session" ? 0 : 1);
		assert.equal(harness.listeners.size, 0);
	}
	assert.equal(manual, 2);
});

for (const phase of ["provider", "post-run", "compacting"] as const) {
	test(`native repair rejects an overlapping ${phase} phase without starting manual or automatic compaction`, async (t) => {
		let prepared = false;
		const manual = t.mock.method(AgentSession.prototype, "compact", async () => repaired);
		const harness = preparingSession();
		if (phase === "provider") Object.assign(harness.session.agent.state, { isStreaming: true });
		if (phase === "post-run") Object.assign(harness.session, { _runSystemPromptOptions: {} });
		if (phase === "compacting") Object.assign(harness.session, { _autoCompactionAbortController: new AbortController() });
		await assert.rejects(request(harness.ctx, () => { prepared = true; }), phase === "compacting" ? /overlap an active compaction/ : /active response/);
		assert.equal(prepared, false, "a rejected repair must not borrow the branch of the active operation");
		assert.equal(harness.automatic(), 0);
		assert.equal(manual.mock.callCount(), 0);
		assert.equal(AgentSession.prototype.compact, manual);
	});
}

test("an overlapping compaction completing in a microtask keeps its original parent leaf", async () => {
	const harness = preparingSession();
	const manager = harness.session.sessionManager;
	const parent = manager.appendMessage({ role: "user", content: "old history", timestamp: 1 });
	const originalLeaf = manager.appendMessage({ role: "user", content: "current history", timestamp: 2 });
	Object.assign(harness.session, { _autoCompactionAbortController: new AbortController() });
	const repair = request(harness.ctx, () => manager.branch(parent));
	const completion = Promise.resolve().then(() => manager.appendCompaction("original operation", originalLeaf, 10));
	await assert.rejects(repair, /overlap an active compaction/);
	const checkpoint = manager.getEntry(await completion);
	assert.equal(checkpoint?.parentId, originalLeaf);
});

for (const [name, event, expected] of [
	["rejected preparation", undefined, /Nothing to compact/],
	["cancelled repair", { type: "compaction_end", reason: "threshold", result: undefined, aborted: true, willRetry: false }, /Compaction cancelled/],
	["failed repair", { type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false, errorMessage: "summary unavailable" }, /summary unavailable/],
] as const) {
	test(`${name} rejects the pending repair without waiting for a missing result`, async () => {
		const harness = preparingSession(event);
		const original = AgentSession.prototype.compact;
		await assert.rejects(request(harness.ctx), expected);
		assert.equal(AgentSession.prototype.compact, original);
		assert.equal(harness.listeners.size, 0);
	});
}
