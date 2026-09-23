import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	buildRemoteCompactionRequest,
	planContextReplay,
	rebuiltBranchMessages,
} from "../../tools/gpt-compaction/core";
import { compactionIdentity } from "../../tools/gpt-compaction/model-eligibility";
import { installGptCompaction } from "../../tools/gpt-compaction/extension";
import { materializeRailFreeProjection, projectHistoryRange } from "../../tools/gpt-compaction/history";
import { gptCompactionSummary, type GptCompactionDetails } from "../../tools/gpt-compaction/types";

const model = {
	provider: "context-edit-provider",
	api: "openai-responses",
	id: "gpt-context-edit",
	name: "Context edit test",
	baseUrl: "https://example.invalid/v1",
	input: ["text"],
	contextWindow: 128_000,
	maxTokens: 4_096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as any;

function appendUser(manager: SessionManager, content: string): string {
	return manager.appendMessage({ role: "user", content, timestamp: 1 });
}

function appendAssistant(manager: SessionManager, content: string): string {
	return manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: content }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		timestamp: 1,
	});
}

function remoteBranch(): { manager: SessionManager; branch: SessionEntry[]; identity: ReturnType<typeof compactionIdentity> } {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "system", content: "system prompt", timestamp: 1 });
	appendUser(manager, "before checkpoint");
	const discardedBeforeCheckpoint = appendAssistant(manager, "discarded pre-checkpoint response");
	manager.appendContextEdit(discardedBeforeCheckpoint, null);
	const kept = appendUser(manager, "kept original");
	manager.appendContextEdit(kept, { content: "kept replacement" });

	const identity = compactionIdentity(model);
	const checkpoint = { type: "compaction" as const, encrypted_content: "opaque-context-edit" };
	const parentEntryId = manager.getLeafId();
	const details: GptCompactionDetails = {
		version: 2,
		strategy: "gpt-remote-compaction-v2",
		checkpointId: "context-edit-checkpoint",
		consumer: identity,
		producer: identity,
		checkpoint,
		replacement: [checkpoint],
		boundary: { parentEntryId, firstKeptEntryId: kept, tokensBefore: 100 },
		createdAt: "2026-01-01T00:00:00.000Z",
	};
	manager.appendCompaction(gptCompactionSummary(details.checkpointId), kept, 100, details, true);
	// The edit is appended after the checkpoint but targets a retained message;
	// canonical projection must still apply it to the remote replay interval.
	manager.appendContextEdit(kept, { content: "post-checkpoint kept replacement" });
	const discardedLiveResponse = appendAssistant(manager, "discarded live response");
	manager.appendContextEdit(discardedLiveResponse, null);
	appendUser(manager, "after omission");
	return { manager, branch: manager.getBranch(), identity };
}

function replayContext(branch: SessionEntry[]) {
	return {
		model,
		sessionManager: { getBranch: () => branch },
	} as any;
}

test("canonical projection applies ContextEditEntry omission and replacement to recovery and remote replay", () => {
	const { manager, branch, identity } = remoteBranch();
	const canonical = manager.buildSessionProjection().messages;
	const recovered = rebuiltBranchMessages(branch);
	const canonicalText = JSON.stringify(canonical);
	const recoveredText = JSON.stringify(recovered);

	assert.match(canonicalText, /post-checkpoint kept replacement/);
	assert.doesNotMatch(canonicalText, /kept original|discarded pre-checkpoint response|discarded live response/);
	assert.match(recoveredText, /post-checkpoint kept replacement/);
	assert.match(recoveredText, /after omission/);
	assert.doesNotMatch(recoveredText, /opaque-context-edit|kept original|discarded pre-checkpoint response|discarded live response/);

	const request = buildRemoteCompactionRequest({ model, branchEntries: branch, identity });
	assert.equal(request.ok, true);
	if (!request.ok) return;
	const input = JSON.stringify(request.input);
	assert.match(input, /post-checkpoint kept replacement/);
	assert.match(input, /after omission/);
	assert.doesNotMatch(input, /kept original|discarded pre-checkpoint response|discarded live response/);
});

test("context replay replaces the full canonical transcript without reviving omitted responses", () => {
	const { branch, identity } = remoteBranch();
	const decision = planContextReplay({
		ctx: replayContext(branch),
		branchEntries: branch,
		remoteEnabled: false,
		identity,
		messages: [{ role: "system", content: "stale system" }, { role: "user", content: "stale placeholder" }] as any,
		storedMessages: [{ role: "system", content: "stale system" }, { role: "user", content: "stale placeholder" }] as any,
	});
	assert.equal(decision.action, "replace");
	if (decision.action !== "replace") return;
	const transcript = JSON.stringify(decision.messages);
	assert.match(transcript, /system prompt/);
	assert.match(transcript, /post-checkpoint kept replacement|after omission/);
	assert.doesNotMatch(transcript, /stale placeholder|kept original|discarded pre-checkpoint response|discarded live response/);
});

test("context replay removes an opaque checkpoint when canonical recovery is empty", () => {
	const manager = SessionManager.inMemory();
	const omitted = appendUser(manager, "only persisted message");
	manager.appendContextEdit(omitted, null);
	const identity = compactionIdentity(model);
	const checkpoint = { type: "compaction" as const, encrypted_content: "opaque-empty-recovery" };
	const parentEntryId = manager.getLeafId();
	const details: GptCompactionDetails = {
		version: 2,
		strategy: "gpt-remote-compaction-v2",
		checkpointId: "empty-recovery",
		consumer: identity,
		producer: identity,
		checkpoint,
		replacement: [checkpoint],
		boundary: { parentEntryId, firstKeptEntryId: omitted, tokensBefore: 1 },
		createdAt: "2026-01-01T00:00:00.000Z",
	};
	manager.appendCompaction(gptCompactionSummary(details.checkpointId), omitted, 1, details, true);
	const branch = manager.getBranch();
	const canonical = manager.buildSessionProjection().messages;
	assert.match(JSON.stringify(canonical), /empty-recovery/);

	const decision = planContextReplay({
		ctx: replayContext(branch),
		branchEntries: branch,
		remoteEnabled: false,
		identity,
		messages: canonical,
		storedMessages: canonical,
	});
	assert.deepEqual(decision, { action: "replace", messages: [] });
});

test("detached history ranges apply later context edits to their selected source entries", () => {
	const manager = SessionManager.inMemory();
	const edited = appendUser(manager, "old detached content");
	const kept = appendUser(manager, "native retained anchor");
	manager.appendCompaction("native summary", kept, 10);
	manager.appendContextEdit(edited, { content: "edited detached content" });

	const range = projectHistoryRange(manager.getBranch(), 0, 1);
	assert.match(JSON.stringify(range), /edited detached content/);
	assert.doesNotMatch(JSON.stringify(range), /old detached content/);
});

test("retain-none native compactions separate detached raw prefixes from the native summary", () => {
	const manager = SessionManager.inMemory();
	appendUser(manager, "raw history before retain-none");
	const nativeId = manager.appendCompaction("retain-none native summary", undefined as unknown as string, 10);
	appendUser(manager, "live history after retain-none");
	const branch = manager.getBranch();
	const nativeIndex = branch.findIndex((entry) => entry.id === nativeId);
	assert.equal(branch[nativeIndex]?.type, "compaction");
	assert.equal(branch[nativeIndex]?.type === "compaction" && branch[nativeIndex].firstKeptEntryId, nativeId);

	const detached = JSON.stringify(projectHistoryRange(branch, 0, nativeIndex));
	assert.match(detached, /raw history before retain-none/);
	assert.doesNotMatch(detached, /retain-none native summary/);
	const crossing = JSON.stringify(projectHistoryRange(branch, 0, nativeIndex + 1));
	assert.match(crossing, /retain-none native summary/);
	assert.doesNotMatch(crossing, /raw history before retain-none/);
});

test("materialized projections do not revive older inert native compactions", () => {
	const manager = SessionManager.inMemory();
	appendUser(manager, "summarized before both native checkpoints");
	const kept = appendUser(manager, "shared retained history");
	manager.appendCompaction("older native summary", kept, 10);
	appendUser(manager, "between native checkpoints");
	manager.appendCompaction("newest native summary", kept, 20);
	appendUser(manager, "live native tail");

	const canonical = manager.buildSessionProjection().messages;
	const materialized = materializeRailFreeProjection(manager.getBranch());
	assert.equal(materialized.filter((entry) => entry.type === "compaction").length, 1);
	assert.deepEqual(materialized.flatMap(sessionEntryToContextMessages), canonical);
});

test("GPT compaction registers the full-transcript 0.87 context_with_system hook", () => {
	const handlers = new Map<string, unknown>();
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	installGptCompaction({
		events: {
			emit: (event: string, data: unknown) => listeners.get(event)?.forEach((listener) => listener(data)),
			on: (event: string, listener: (data: unknown) => void) => {
				const current = listeners.get(event) ?? [];
				current.push(listener);
				listeners.set(event, current);
				return () => undefined;
			},
		},
		on: (event: string, handler: unknown) => { handlers.set(event, handler); },
		registerCommand: () => undefined,
		getActiveTools: () => [],
		getAllTools: () => [],
	} as any);

	assert.equal(handlers.has("context_with_system"), true);
	assert.equal(handlers.has("context"), false);
});
