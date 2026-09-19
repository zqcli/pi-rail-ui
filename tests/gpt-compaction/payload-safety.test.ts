import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { installGptCompaction } from "../../tools/gpt-compaction/extension";
import { writeGptCompactionMode } from "../../tools/gpt-compaction/settings";
import { gptCompactionSummary, type GptCompactionDetails } from "../../tools/gpt-compaction/types";

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

const identity = {
	provider: model.provider,
	api: model.api,
	model: model.id,
	baseUrl: model.baseUrl,
	authFingerprint: createHash("sha256").update("api-key:probe-key").digest("hex"),
};

function message(id: string, parentId: string | null, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
	} as SessionEntry;
}

function details(checkpointId: string): GptCompactionDetails {
	const checkpoint = { type: "compaction" as const, encrypted_content: `opaque-${checkpointId}` };
	return {
		version: 2,
		strategy: "gpt-remote-compaction-v2",
		checkpointId,
		consumer: identity,
		producer: identity,
		checkpoint,
		replacement: [checkpoint],
		boundary: { parentEntryId: "a1", firstKeptEntryId: "u1", tokensBefore: 100 },
		createdAt: "2025-01-01T00:00:00.000Z",
	};
}

function remoteEntry(id: string, checkpointDetails: GptCompactionDetails): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId: "a1",
		timestamp: "2025-01-01T00:00:00.000Z",
		summary: gptCompactionSummary(checkpointDetails.checkpointId),
		firstKeptEntryId: "u1",
		tokensBefore: 100,
		details: checkpointDetails,
		fromHook: true,
	} as SessionEntry;
}

function eventBus() {
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	return {
		emit: (event: string, data: unknown) => listeners.get(event)?.forEach((listener) => listener(data)),
		on: (event: string, listener: (data: unknown) => void) => {
			const registered = listeners.get(event) ?? [];
			registered.push(listener);
			listeners.set(event, registered);
			return () => undefined;
		},
	};
}

function setup(branch: SessionEntry[]) {
	const handlers = new Map<string, any>();
	const notices: string[] = [];
	const aborts: string[] = [];
	const pi = {
		events: eventBus(),
		registerCommand: () => undefined,
		on: (event: string, handler: any) => handlers.set(event, handler),
		getActiveTools: () => [],
		getAllTools: () => [],
	};
	installGptCompaction(pi as any);
	const ctx: any = {
		mode: "tui",
		hasUI: true,
		model,
		signal: new AbortController().signal,
		abort: () => aborts.push("aborted"),
		ui: { notify: (text: string) => notices.push(text), setStatus: () => undefined },
		sessionManager: { getBranch: () => branch, getSessionId: () => "payload-safety", buildContextEntries: () => [] },
		modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "probe-key", baseUrl: model.baseUrl }) },
	};
	return { run: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args), notices, aborts, ctx };
}

async function withMode<T>(mode: "on" | "off", run: () => Promise<T>): Promise<T> {
	const agentDir = await mkdtemp(join(tmpdir(), "rail-payload-safety-"));
	const previous = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	if (mode === "on") writeGptCompactionMode("on", agentDir);
	try {
		return await run();
	} finally {
		if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previous;
		await rm(agentDir, { recursive: true, force: true });
	}
}

function branchWith(checkpointDetails: GptCompactionDetails): SessionEntry[] {
	return [message("u1", null, "original"), message("a1", "u1", "answer"), remoteEntry("c1", checkpointDetails), message("u2", "c1", "latest")];
}

const rewrittenPayload = (cp: GptCompactionDetails) => ({
	model: model.id,
	input: [cp.checkpoint, { role: "user", content: "latest" }],
	tools: [{ type: "function", name: "read" }],
});

test("an already rewritten checkpoint is blocked before the provider request when replay is off", async () => {
	await withMode("off", async () => {
		const cp = details("hook-off");
		const harness = setup(branchWith(cp));
		const result = await harness.run("before_provider_request", { payload: rewrittenPayload(cp) }, harness.ctx);
		assert.equal(harness.aborts.length, 1, "the hook must abort the outgoing request");
		assert.deepEqual((result as any).input, [{ type: "rail_compaction_blocked", reason: "checkpoint-anchor-not-replayed" }]);
		assert.equal(JSON.stringify(result).includes(cp.checkpoint.encrypted_content), false, "opaque ciphertext must never leave while replay is off");
	});
});

test("a different account or endpoint cannot send another identity's rewritten checkpoint", async () => {
	await withMode("on", async () => {
		const cp = details("hook-cross");
		// The checkpoint's consumer fingerprint belongs to probe-key, but the live
		// registry resolves account-b, so replay must still fail closed.
		const crossAccount = setup(branchWith(cp));
		crossAccount.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "account-b-key", baseUrl: model.baseUrl });
		const accountResult = await crossAccount.run("before_provider_request", { payload: rewrittenPayload(cp) }, crossAccount.ctx);
		assert.equal(crossAccount.aborts.length, 1);
		assert.deepEqual((accountResult as any).input, [{ type: "rail_compaction_blocked", reason: "checkpoint-anchor-not-replayed" }]);

		const crossEndpoint = setup(branchWith(cp));
		crossEndpoint.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "probe-key", baseUrl: "https://other.example/v1" });
		const endpointResult = await crossEndpoint.run("before_provider_request", { payload: rewrittenPayload(cp) }, crossEndpoint.ctx);
		assert.equal(crossEndpoint.aborts.length, 1);
		assert.deepEqual((endpointResult as any).input, [{ type: "rail_compaction_blocked", reason: "checkpoint-anchor-not-replayed" }]);
	});
});

test("duplicate summary anchors are blocked before the provider request", async () => {
	await withMode("on", async () => {
		const cp = details("hook-dup");
		const marker = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${gptCompactionSummary(cp.checkpointId)}\n</summary>`;
		const harness = setup(branchWith(cp));
		const result = await harness.run("before_provider_request", {
			payload: { model: model.id, input: [{ role: "user", content: marker }, { role: "user", content: marker }] },
		}, harness.ctx);
		assert.equal(harness.aborts.length, 1);
		assert.deepEqual((result as any).input, [{ type: "rail_compaction_blocked", reason: "checkpoint-anchor-ambiguous" }]);
	});
});

test("a same-identity rewritten checkpoint and an unrelated payload pass through untouched", async () => {
	await withMode("on", async () => {
		const cp = details("hook-ok");
		const harness = setup(branchWith(cp));
		const payload = rewrittenPayload(cp);
		const result = await harness.run("before_provider_request", { payload }, harness.ctx);
		assert.equal(harness.aborts.length, 0);
		assert.equal(result, undefined, "the hook leaves the payload in place and records request context");

		const plain = setup([message("plain-u", null, "plain history without any checkpoint")]);
		const plainResult = await plain.run("before_provider_request", { payload: { model: model.id, input: [{ role: "user", content: "plain" }] } }, plain.ctx);
		assert.equal(plain.aborts.length, 0);
		assert.equal(plainResult, undefined);
	});
});
