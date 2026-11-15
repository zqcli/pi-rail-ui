/** Offline paired benchmark: node --import tsx tests/benchmarks/gpt-request-context.bench.ts <baseline-checkout> */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { getCurrentTools, type Api, type Model } from "@earendil-works/pi-ai";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { convertToLlm, SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { rememberLiveRequestContext } from "../../tools/gpt-compaction/core";
import { compactionIdentity } from "../../tools/gpt-compaction/model-eligibility";
import { getCompactionRequestExtras } from "../../tools/gpt-compaction/request-context";

const baselineRoot = process.argv[2];
assert.ok(baselineRoot, "Pass an unchanged baseline checkout with the same installed dependencies");
const baselineCore = await import(pathToFileURL(resolve(baselineRoot, "tools/gpt-compaction/core.ts")).href) as typeof import("../../tools/gpt-compaction/core");
const baselineCache = await import(pathToFileURL(resolve(baselineRoot, "tools/gpt-compaction/request-context.ts")).href) as typeof import("../../tools/gpt-compaction/request-context");
const warmups = 10;
const samples = 40;
const model: Model<Api> = {
	provider: "benchmark", api: "openai-responses", id: "gpt-test", name: "Offline benchmark",
	baseUrl: "https://example.invalid/v1", reasoning: true, input: ["text"],
	contextWindow: 128_000, maxTokens: 8_192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const tools = ["read", "bash"].map((name) => ({ name, description: name, parameters: Type.Object({ input: Type.String() }) }));
const payload = {
	model: model.id, tools: convertResponsesTools(tools, { strict: false, supportsStrictMode: false }),
	reasoning: { effort: "high" }, service_tier: "priority", prompt_cache_key: "offline-benchmark",
};

function fixture(count: number, compacted: boolean) {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "system", content: "Benchmark prompt", toolsAdded: tools, timestamp: 0 });
	const ids = [];
	for (let index = 0; index < count; index += 1) {
		const prefix = `${index}: `;
		ids.push(manager.appendMessage({ role: "user", content: prefix + "x".repeat(2_048 - prefix.length), timestamp: index + 1 }));
	}
	// Pi's real native checkpoint snapshot, retaining the most recent 100 messages.
	if (compacted) manager.appendCompaction("Native benchmark summary", ids[count - 100]!, count * 512);
	const ctx = { model, sessionManager: manager } as unknown as ExtensionContext;
	return { manager, ctx };
}

function stats(values: number[]) {
	const sorted = [...values].sort((left, right) => left - right);
	return {
		median_ms: (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2,
		p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
		min_ms: sorted[0]!,
	};
}

function cloneCounts(run: () => void) {
	const original = globalThis.structuredClone;
	let calls = 0;
	let sessionEntries = 0;
	globalThis.structuredClone = (value) => {
		calls += 1;
		if (value && typeof value === "object" && "parentId" in value && "id" in value) sessionEntries += 1;
		return original(value);
	};
	try { run(); } finally { globalThis.structuredClone = original; }
	return { calls, sessionEntries };
}

const revision = (cwd: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
console.log(JSON.stringify({
	node: process.version, baseline: revision(baselineRoot), candidate: revision(process.cwd()), warmups, samples,
	note: "Candidate is the current checkout, including uncommitted changes. Alternating paired order; same in-memory SessionManager and payload; no provider calls.",
}));

for (const count of [1_000, 5_000, 10_000]) {
	for (const compacted of [false, true]) {
		const { manager, ctx } = fixture(count, compacted);
		const before = JSON.stringify(manager.getBranch());
		const runBefore = () => baselineCore.rememberLiveRequestContext(ctx, payload);
		const runAfter = () => rememberLiveRequestContext(ctx, payload);
		for (let index = 0; index < warmups; index += 1) { runBefore(); runAfter(); }
		const beforeMs: number[] = [];
		const afterMs: number[] = [];
		const measure = (run: () => void, output: number[]) => {
			const start = performance.now();
			run();
			output.push(performance.now() - start);
		};
		for (let index = 0; index < samples; index += 1) {
			if (index % 2 === 0) { measure(runBefore, beforeMs); measure(runAfter, afterMs); }
			else { measure(runAfter, afterMs); measure(runBefore, beforeMs); }
		}
		const beforeClones = cloneCounts(runBefore);
		const afterClones = cloneCounts(runAfter);
		const identity = compactionIdentity(model);
		assert.deepEqual(getCompactionRequestExtras(identity, manager.getSessionId()),
			baselineCache.getCompactionRequestExtras(identity, manager.getSessionId()));
		assert.deepEqual(getCurrentTools(convertToLlm(manager.buildSessionProjection().messages)), tools);
		assert.equal(JSON.stringify(manager.getBranch()), before, "neither capture may mutate the session");
		const oldStats = stats(beforeMs);
		const newStats = stats(afterMs);
		console.log(JSON.stringify({
			messages: count, content_bytes_per_message: 2_048, native_compaction: compacted,
			entries: manager.getBranch().length, before: oldStats, after: newStats,
			median_ratio: oldStats.median_ms / newStats.median_ms,
			before_clones: beforeClones, after_clones: afterClones,
		}));
	}
}
