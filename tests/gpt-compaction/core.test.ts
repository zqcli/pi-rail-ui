import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	buildRemoteCompactionRequest,
	planContextReplay,
	planPayloadRewrite,
	runNativeRepairCompaction,
} from "../../tools/gpt-compaction/core";
import { compactionIdentity, type CompactionIdentity } from "../../tools/gpt-compaction/model-eligibility";
import { serializeMessagesToResponsesInput } from "../../tools/gpt-compaction/serializer";
import { transformMessagesForResponses } from "../../tools/gpt-compaction/serializer";
import {
	getGptCompactionDetails,
	gptCompactionSummary,
	resolveSessionCheckpoint,
	type GptCompactionDetails,
} from "../../tools/gpt-compaction/types";

const model = {
	provider: "cus-resp",
	api: "openai-responses",
	id: "gpt-5.6-sol",
	name: "GPT 5.6 Sol",
	baseUrl: "https://gateway.example/v1",
	input: ["text", "image"],
	contextWindow: 128_000,
	maxTokens: 8_192,
} as any;

const otherModel = {
	...model,
	provider: "other-gateway",
	baseUrl: "https://other.example/v1",
} as any;

const identity: CompactionIdentity = {
	provider: model.provider,
	api: model.api,
	model: model.id,
	baseUrl: model.baseUrl,
	authFingerprint: "account-a",
};

function message(id: string, parentId: string | null, text: string, role: "user" | "assistant" = "user"): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00.000Z",
		message: role === "user"
			? { role, content: [{ type: "text", text }], timestamp: 1 }
			: {
				role,
				content: [{ type: "text", text }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "stop",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				timestamp: 1,
			},
	} as SessionEntry;
}

function details(checkpointId: string, parentEntryId: string, firstKeptEntryId: string, encrypted = `opaque-${checkpointId}`): GptCompactionDetails {
	const checkpoint = { type: "compaction" as const, encrypted_content: encrypted };
	return {
		version: 2,
		strategy: "gpt-remote-compaction-v2",
		checkpointId,
		consumer: identity,
		producer: identity,
		checkpoint,
		replacement: [checkpoint],
		boundary: { parentEntryId, firstKeptEntryId, tokensBefore: 100 },
		createdAt: "2025-01-01T00:00:00.000Z",
	};
}

function remoteEntry(id: string, parentId: string, checkpointDetails: GptCompactionDetails): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00.000Z",
		summary: gptCompactionSummary(checkpointDetails.checkpointId),
		firstKeptEntryId: checkpointDetails.boundary.firstKeptEntryId,
		tokensBefore: checkpointDetails.boundary.tokensBefore,
		details: checkpointDetails,
		fromHook: true,
	} as SessionEntry;
}

function context(branch: SessionEntry[], currentModel = model): any {
	return {
		model: currentModel,
		sessionManager: { getBranch: () => branch },
	};
}

test("remote checkpoint replay follows the branch boundary and supports continuous compaction", () => {
	const u1 = message("u1", null, "old history");
	const a1 = message("a1", "u1", "old answer", "assistant");
	const u2 = message("u2", "a1", "retained request");
	const a2 = message("a2", "u2", "retained answer", "assistant");
	const first = details("cp-1", "a2", "u2");
	const c1 = remoteEntry("c1", "a2", first);
	const u3 = message("u3", "c1", "new request");
	const a3 = message("a3", "u3", "new answer", "assistant");

	const request = buildRemoteCompactionRequest({ model, branchEntries: [u1, a1, u2, a2, c1, u3, a3], identity });
	assert.equal(request.ok, true);
	if (!request.ok) return;
	assert.deepEqual(request.input[0], first.checkpoint);
	assert.equal(request.input.length, 5, "checkpoint plus retained and live-tail messages must be sent");
	assert.equal(JSON.stringify(request.input).includes(gptCompactionSummary(first.checkpointId)), false);

	const secondDetails = details("cp-2", "a3", "u3", "opaque-2");
	const c2 = remoteEntry("c2", "a3", secondDetails);
	const second = buildRemoteCompactionRequest({ model, branchEntries: [u1, a1, u2, a2, c1, u3, a3], identity });
	assert.equal(second.ok, true);
	if (second.ok) assert.deepEqual(second.input[0], first.checkpoint, "the next request continues from the latest installed checkpoint");
	assert.equal(resolveSessionCheckpoint([u1, a1, u2, a2, c1, u3, a3, c2]).status, "remote");
});

test("opaque checkpoints are rebuilt for off mode and a different provider identity", () => {
	const u1 = message("u1", null, "original user");
	const a1 = message("a1", "u1", "original answer", "assistant");
	const cp = details("cp-1", "a1", "u1");
	const c1 = remoteEntry("c1", "a1", cp);
	const u2 = message("u2", "c1", "latest user");
	const branch = [u1, a1, c1, u2];

	const off = planContextReplay({ ctx: context(branch), branchEntries: branch, remoteEnabled: false, identity });
	assert.equal(off.action, "replace");
	if (off.action === "replace") {
		assert.equal(off.messages.some((item) => item.role === "compactionSummary"), false);
		assert.equal(JSON.stringify(off.messages).includes(cp.checkpoint.encrypted_content), false);
	}
	const liveUser = { role: "user", content: "typed after reload", timestamp: 99 } as any;
	const withLiveTail = planContextReplay({
		ctx: context(branch),
		branchEntries: branch,
		remoteEnabled: false,
		identity,
		messages: [{ role: "compactionSummary", summary: "placeholder", timestamp: 1 }, liveUser] as any,
		storedMessages: [{ role: "compactionSummary", summary: "placeholder", timestamp: 1 }] as any,
	});
	assert.equal(withLiveTail.action, "replace");
	if (withLiveTail.action === "replace") assert.deepEqual(withLiveTail.messages.at(-1), liveUser);
	const repeatedReplay = planContextReplay({
		ctx: context(branch),
		branchEntries: branch,
		remoteEnabled: false,
		identity,
		messages: [...(withLiveTail.action === "replace" ? withLiveTail.messages : []), { role: "assistant", content: [{ type: "text", text: "tool-capable response" }], timestamp: 100 } as any],
		storedMessages: [{ role: "compactionSummary", summary: "placeholder", timestamp: 1 }] as any,
	});
	assert.equal(repeatedReplay.action, "replace", "a second provider call in the same turn must keep the already rebuilt prefix");
	if (repeatedReplay.action === "replace") assert.equal(repeatedReplay.messages.at(-1)?.role, "assistant");

	const switched = buildRemoteCompactionRequest({ model: otherModel, branchEntries: branch, identity: {
		...identity,
		provider: otherModel.provider,
		baseUrl: otherModel.baseUrl,
		authFingerprint: "account-b",
	} });
	assert.equal(switched.ok, true);
	if (switched.ok) {
		assert.equal(switched.input.some((item) => JSON.stringify(item).includes(cp.checkpoint.encrypted_content)), false);
		assert.equal(JSON.stringify(switched.input).includes("original user"), true);
	}
});

test("payload replay replaces only the display anchor and never duplicates an already rewritten checkpoint", () => {
	const u1 = message("u1", null, "original");
	const a1 = message("a1", "u1", "answer", "assistant");
	const cp = details("cp-1", "a1", "u1");
	const c1 = remoteEntry("c1", "a1", cp);
	const u2 = message("u2", "c1", "latest");
	const branch = [u1, a1, c1, u2];
	const marker = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${gptCompactionSummary(cp.checkpointId)}\n</summary>`;
	const payload = {
		model: model.id,
		input: [{ role: "user", content: [{ type: "input_text", text: marker }] }, { role: "user", content: [{ type: "input_text", text: "latest" }] }],
		tools: [{ type: "web_search_preview", search_context_size: "high" }],
		include: ["web_search_call.action.sources"],
		previous_response_id: "codex-response-1",
	};
	const rewritten = planPayloadRewrite({ ctx: context(branch), branchEntries: branch, payload, remoteEnabled: true, identity });
	assert.equal(rewritten.action, "rewrite");
	if (rewritten.action === "rewrite") {
		assert.equal(JSON.stringify(rewritten.payload).includes(gptCompactionSummary(cp.checkpointId)), false);
		assert.equal((rewritten.payload as any).input.filter((item: any) => item.type === "compaction").length, 1);
		assert.deepEqual((rewritten.payload as any).tools, payload.tools);
		assert.deepEqual((rewritten.payload as any).include, payload.include);
		assert.equal((rewritten.payload as any).previous_response_id, payload.previous_response_id);
	}

	const alreadyRewritten = planPayloadRewrite({
		ctx: context(branch),
		branchEntries: branch,
		payload: { model: model.id, input: [cp.checkpoint, { role: "user", content: "latest" }] },
		remoteEnabled: true,
		identity,
	});
	assert.deepEqual(alreadyRewritten, { action: "none" });
	const ambiguous = planPayloadRewrite({
		ctx: context(branch),
		branchEntries: branch,
		payload: { model: model.id, input: [cp.checkpoint, { role: "user", content: marker }] },
		remoteEnabled: true,
		identity,
	});
	assert.deepEqual(ambiguous, { action: "fail", reason: "checkpoint-anchor-ambiguous" });
});

test("native compaction entries remain native while malformed Rail markers are invalid", () => {
	const native = {
		type: "compaction",
		id: "native",
		parentId: null,
		timestamp: "2025-01-01T00:00:00.000Z",
		summary: "ordinary native summary",
		firstKeptEntryId: "u1",
		tokensBefore: 10,
		details: { readFiles: [], modifiedFiles: [] },
	} as SessionEntry;
	assert.equal(resolveSessionCheckpoint([native]).status, "native");
	const malformed = { ...native, id: "bad", summary: gptCompactionSummary("bad") } as SessionEntry;
	assert.equal(resolveSessionCheckpoint([malformed]).status, "invalid");
	assert.equal(getGptCompactionDetails(native), undefined);
});

test("native repair summarizes rebuilt records after remote mode is disabled", async () => {
	const u1 = message("u1", null, "old user");
	const a1 = message("a1", "u1", "old answer", "assistant");
	const u2 = message("u2", "a1", "retained user");
	const cp = details("cp-repair", "a1", "u2", "opaque-repair");
	const c1 = remoteEntry("c1", "a1", cp);
	const calls: any[] = [];
	const event = {
		branchEntries: [u1, a1, c1, u2],
		preparation: {
			firstKeptEntryId: "u2",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 },
		},
		signal: new AbortController().signal,
		customInstructions: undefined,
		reason: "manual",
		willRetry: false,
	} as any;
	const result = await runNativeRepairCompaction({
		event,
		ctx: {
			model,
			thinkingLevel: "off",
			getSystemPrompt: () => "system",
			sessionManager: { getSessionId: () => "repair-session" },
			modelRegistry: {
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "repair-key", baseUrl: model.baseUrl }),
			},
		} as any,
		deps: {
			nativeSummary: async (messages: any[]) => {
				calls.push(messages);
				return {
					text: "native repair summary",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
			},
		},
	});
	assert.equal(result.outcome, "success");
	assert.equal(calls.length, 1);
	assert.equal(JSON.stringify(calls[0]).includes("opaque-repair"), false);
	if (result.outcome === "success") {
		assert.equal(result.compaction.firstKeptEntryId, "u2");
		assert.equal(result.compaction.summary, "native repair summary");
	}
});

test("Responses replay preserves images and synthesizes only missing tool results", () => {
	const assistant = {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1|fc_1", name: "read", arguments: { path: "a.ts" } }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "toolUse",
		timestamp: 1,
	};
	const result = {
		role: "toolResult",
		toolCallId: "call-1|fc_1",
		toolName: "read",
		content: [
			{ type: "text", text: "source" },
			{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
		],
		isError: false,
		timestamp: 2,
	};
	const transformed = transformMessagesForResponses([assistant, result] as any, model);
	assert.equal(transformed.filter((item: any) => item.role === "toolResult").length, 1);
	assert.equal(JSON.stringify(serializeMessagesToResponsesInput(model, [assistant, result] as any)).includes("input_image"), true);

	const missing = transformMessagesForResponses([assistant] as any, model);
	assert.equal(missing.filter((item: any) => item.role === "toolResult").length, 1);
	const orphan = transformMessagesForResponses([result] as any, model);
	assert.equal(orphan.length, 0, "an orphan result must not be sent as an invalid provider conversation");
});

test("model-only identity comparison is not enough for opaque checkpoint replay", () => {
	const u1 = message("u1", null, "original");
	const a1 = message("a1", "u1", "answer", "assistant");
	const cp = details("cp-auth", "a1", "u1");
	const c1 = remoteEntry("c1", "a1", cp);
	const branch = [u1, a1, c1];
	const modelIdentity = compactionIdentity(model);
	const decision = planPayloadRewrite({ ctx: context(branch), branchEntries: branch, payload: { input: [{ role: "user", content: gptCompactionSummary(cp.checkpointId) }] }, remoteEnabled: true, identity: modelIdentity });
	assert.equal(decision.action, "fail", "a checkpoint scoped to an account cannot be replayed from model/base URL alone");
});
