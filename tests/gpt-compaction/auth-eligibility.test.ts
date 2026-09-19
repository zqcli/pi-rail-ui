import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCompactionHeaders, buildResponsesUrl, resolveCompactionAuth } from "../../tools/gpt-compaction/auth";
import { isGptModel } from "../../openai/model-eligibility";
import { modelSupportsRemoteCompaction } from "../../tools/gpt-compaction/model-eligibility";

const model = {
	provider: "cus-resp",
	api: "openai-responses",
	id: "gpt-5.6-sol",
	name: "GPT 5.6 Sol",
	baseUrl: "https://gateway.example/v1",
} as any;

test("GPT Responses eligibility is provider-independent but not model-independent", () => {
	assert.equal(isGptModel({ id: "gpt-5.6-sol" }), true);
	assert.equal(modelSupportsRemoteCompaction(model).supported, true);
	assert.equal(modelSupportsRemoteCompaction({ ...model, id: "claude-3", name: "Claude 3" }).supported, false);
	assert.equal(modelSupportsRemoteCompaction({ ...model, api: "openai-completions" }).supported, false);
	assert.equal(modelSupportsRemoteCompaction({ ...model, api: "azure-openai-responses" }).supported, false);
});

test("Responses URLs append paths without swallowing endpoint query parameters", () => {
	assert.equal(buildResponsesUrl("https://proxy.example/v1?api-version=2025-01-01", "openai-responses"), "https://proxy.example/v1/responses?api-version=2025-01-01");
	assert.equal(buildResponsesUrl("https://proxy.example/codex?tenant=local", "openai-codex-responses"), "https://proxy.example/codex/responses?tenant=local");
});

test("compaction auth reuses header-only credentials and stores only a non-secret fingerprint", async () => {
	const ctx = {
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({
				ok: true as const,
				baseUrl: "https://proxy.example/v1",
				headers: { Authorization: "Bearer top-secret", "X-Client": "rail" },
			}),
		},
	} as any;
	const resolved = await resolveCompactionAuth(ctx, model);
	assert.equal(resolved.ok, true);
	if (!resolved.ok) return;
	assert.equal(resolved.baseUrl, "https://proxy.example/v1");
	assert.equal(resolved.headers?.["Authorization"], "Bearer top-secret");
	assert.equal(resolved.identity.authFingerprint?.includes("top-secret"), false);
	assert.equal(JSON.stringify(resolved.identity).includes("Bearer"), false);
	const headers = buildCompactionHeaders({ auth: resolved, sessionId: "session-1" });
	assert.equal(headers["authorization"], "Bearer top-secret");
	assert.equal(headers["x-client-request-id"], "session-1");
});
