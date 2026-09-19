import assert from "node:assert/strict";
import { test } from "node:test";
import {
	HOSTED_SEARCH_ENTRY_TYPE,
	HostedSearchActivity,
	HostedSearchSseObserver,
	hostedSearchActivityForMessage,
	hostedSearchCallsFromEntry,
	resetHostedSearchActivities,
	restoreHostedSearchActivities,
	setActiveHostedSearchActivity,
	type HostedSearchSnapshot,
} from "../../openai/hosted-search-activity";

function sse(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

test("parses chunked hosted search calls, actions, sources, and terminal response", () => {
	resetHostedSearchActivities();
	const activity = new HostedSearchActivity({ provider: "custom", model: "gpt-5.6-luna", startedAt: 1000 });
	setActiveHostedSearchActivity(activity);
	const observer = new HostedSearchSseObserver(activity);
	const payload = [
		sse("response.created", { type: "response.created", response: { id: "resp_1" } }),
		sse("response.output_item.added", {
			type: "response.output_item.added",
			item: { id: "ws_1", type: "web_search_call", status: "in_progress" },
		}),
		sse("response.web_search_call.searching", {
			type: "response.web_search_call.searching",
			item_id: "ws_1",
		}),
		sse("response.output_item.done", {
			type: "response.output_item.done",
			item: {
				id: "ws_1",
				type: "web_search_call",
				status: "completed",
				action: {
					type: "search",
					query: "latest codex commit",
					sources: [{ title: "Codex", url: "https://github.com/openai/codex" }],
				},
			},
		}),
		sse("response.output_item.done", {
			type: "response.output_item.done",
			item: {
				id: "ws_2",
				type: "web_search_call",
				status: "completed",
				action: { type: "open_page", url: "https://github.com/openai/codex/commits/main" },
			},
		}),
		sse("response.content_part.done", {
			type: "response.content_part.done",
			part: {
				type: "output_text",
				annotations: [{ type: "url_citation", title: "Commit", url: "https://github.com/openai/codex/commit/abc" }],
			},
		}),
		sse("response.completed", {
			type: "response.completed",
			response: { id: "resp_1", completed_at: 2, output: [] },
		}),
	].join("");
	const bytes = new TextEncoder().encode(payload);
	for (const byte of bytes) observer.push(Uint8Array.of(byte));
	observer.end();

	assert.deepEqual(activity.snapshot(), {
		version: 1,
		responseId: "resp_1",
		assistantTimestamp: undefined,
		callCount: 2,
		provider: "custom",
		model: "gpt-5.6-luna",
		phase: "completed",
		startedAt: 1000,
		endedAt: 2000,
		calls: [
			{ id: "ws_1", status: "completed", type: "search", query: "latest codex commit", url: undefined },
			{ id: "ws_2", status: "completed", type: "open_page", query: undefined, url: "https://github.com/openai/codex/commits/main" },
		],
		sources: [
			{ title: "Codex", url: "https://github.com/openai/codex" },
			{ title: undefined, url: "https://github.com/openai/codex/commits/main" },
			{ title: "Commit", url: "https://github.com/openai/codex/commit/abc" },
		],
		error: undefined,
	});
	assert.equal(hostedSearchActivityForMessage({ provider: "custom", model: "gpt-5.6-luna", responseId: "resp_1" }), activity);
});

test("ignores malformed SSE and remains invisible without a real web_search_call", () => {
	const activity = new HostedSearchActivity({ provider: "custom", model: "gpt-5.6-luna" });
	const observer = new HostedSearchSseObserver(activity);
	observer.push("event: response.output_item.done\r\ndata: not-json\r\n\r\n");
	observer.push("data: [DONE]\n\n");
	observer.end();
	assert.equal(activity.observed, false);
	assert.equal(activity.phase, "pending");
});

test("sanitizes C1 controls and keeps generic provider error messages", () => {
	const activity = new HostedSearchActivity({ provider: "custom", model: "gpt-5.6-luna" });
	const observer = new HostedSearchSseObserver(activity);
	observer.push(sse("response.output_item.done", {
		type: "response.output_item.done",
		item: {
			id: "ws_error",
			type: "web_search_call",
			status: "completed",
			action: { type: "search", query: "safe\u009dhidden" },
		},
	}));
	observer.push(sse("error", { type: "error", message: "provider\u009cexploded" }));
	observer.end();

	const snapshot = activity.snapshot();
	assert.equal(snapshot.calls[0]?.query, "safehidden");
	assert.equal(snapshot.phase, "failed");
	assert.equal(snapshot.error, "providerexploded");
});

test("keeps a failed search call failed when the response completes", () => {
	const activity = new HostedSearchActivity({ provider: "custom", model: "gpt-5.6-luna", startedAt: 1000 });
	const observer = new HostedSearchSseObserver(activity);
	observer.push(sse("response.output_item.done", {
		type: "response.output_item.done",
		item: {
			id: "ws_failed",
			type: "web_search_call",
			status: "failed",
			action: { type: "search", queries: ["alpha", "beta"] },
		},
	}));
	observer.push(sse("response.output_text.annotation.added", {
		type: "response.output_text.annotation.added",
		annotation: { type: "url_citation", title: "Observed", url: "https://example.com/observed" },
	}));
	observer.push(sse("response.completed", {
		type: "response.completed",
		response: { id: "resp_failed_search", completed_at: 2, output: [] },
	}));
	observer.end();

	const snapshot = activity.snapshot();
	assert.equal(snapshot.phase, "failed");
	assert.equal(snapshot.error, "Search call failed");
	assert.equal(snapshot.endedAt, 2000);
	assert.equal(snapshot.calls[0]?.query, "alpha · beta");
	assert.deepEqual(snapshot.sources, [{ title: "Observed", url: "https://example.com/observed" }]);
});

test("preserves a persisted cancelled phase when a call failed before abort", () => {
	const activity = new HostedSearchActivity({ provider: "custom", model: "gpt", startedAt: 1000 });
	activity.upsertCall("ws_failed", "failed", { type: "search", query: "before abort" });
	activity.cancel(3000);
	const snapshot = activity.snapshot();

	assert.equal(snapshot.phase, "cancelled");
	assert.deepEqual(HostedSearchActivity.restore(snapshot).snapshot(), snapshot);
});

test("drops oversized malformed SSE frames and resumes at the next event", () => {
	const activity = new HostedSearchActivity({ provider: "custom", model: "gpt-5.6-luna" });
	const observer = new HostedSearchSseObserver(activity);
	observer.push(`data: ${"x".repeat(2_000_100)}`);
	observer.push(`\n\ndata: ${JSON.stringify({
		type: "response.output_item.done",
		item: {
			id: "ws_after_oversize",
			type: "web_search_call",
			status: "completed",
			action: { type: "search", query: "still parsed" },
		},
	})}\n\n`);
	observer.end();
	assert.equal(activity.snapshot().calls[0]?.query, "still parsed");
});

test("restores persisted activities by response id without treating entries as messages", () => {
	resetHostedSearchActivities();
	restoreHostedSearchActivities([
		{
			type: "custom",
			customType: HOSTED_SEARCH_ENTRY_TYPE,
			data: {
				version: 1,
				responseId: "resp_saved",
				provider: "custom",
				model: "gpt-5.6-luna",
				phase: "completed",
				startedAt: 1000,
				endedAt: 2000,
				calls: [{ id: "ws_saved", status: "completed", type: "search", query: "saved" }],
				sources: [{ title: "Saved", url: "https://example.com/source" }],
			},
		},
	]);
	const activity = hostedSearchActivityForMessage({
		provider: "custom",
		model: "gpt-5.6-luna",
		responseId: "resp_saved",
	});
	assert.ok(activity);
	assert.equal(activity.observed, true);
	assert.equal(activity.snapshot().calls[0]?.query, "saved");
});

test("scopes restored identities by provider and model with a timestamp fallback", () => {
	resetHostedSearchActivities();
	restoreHostedSearchActivities([
		{
			type: "custom",
			customType: HOSTED_SEARCH_ENTRY_TYPE,
			data: {
				version: 1,
				responseId: "resp_shared",
				assistantTimestamp: 1234,
				provider: "provider-a",
				model: "gpt-a",
				phase: "completed",
				startedAt: 1000,
				calls: [{ id: "ws_a", status: "completed", type: "search", query: "provider a" }],
				sources: [],
			},
		},
		{
			type: "custom",
			customType: HOSTED_SEARCH_ENTRY_TYPE,
			data: {
				version: 1,
				responseId: "resp_shared",
				assistantTimestamp: 5678,
				provider: "provider-b",
				model: "gpt-b",
				phase: "completed",
				startedAt: 2000,
				calls: [{ id: "ws_b", status: "completed", type: "search", query: "provider b" }],
				sources: [],
			},
		},
	]);
	assert.equal(hostedSearchActivityForMessage({
		provider: "provider-a",
		model: "gpt-a",
		responseId: "resp_shared",
	})?.snapshot().calls[0]?.query, "provider a");
	assert.equal(hostedSearchActivityForMessage({
		provider: "provider-b",
		model: "gpt-b",
		timestamp: 5678,
	})?.snapshot().calls[0]?.query, "provider b");
	assert.equal(hostedSearchActivityForMessage({
		provider: "provider-a",
		model: "gpt-b",
		responseId: "resp_shared",
	}), undefined);
});

test("extracts hosted search call counts only from strictly valid custom entries", () => {
	const snapshot = {
		version: 1,
		responseId: "resp_count",
		provider: "custom",
		model: "gpt-5.6-luna",
		phase: "completed",
		startedAt: 1000,
		calls: [
			{ id: "ws_1", status: "completed", type: "search", query: "one" },
			{ id: "ws_2", status: "completed", type: "open_page", url: "https://example.com/page" },
		],
		sources: [{ title: "Example", url: "https://example.com/page" }],
	};
	const entry = (data: unknown, overrides: Record<string, unknown> = {}) => ({
		id: "entry-count",
		type: "custom",
		customType: HOSTED_SEARCH_ENTRY_TYPE,
		data,
		...overrides,
	});

	assert.equal(hostedSearchCallsFromEntry(entry(snapshot)), 2);
	assert.equal(hostedSearchCallsFromEntry(entry({ ...snapshot, version: 2 })), undefined);
	assert.equal(hostedSearchCallsFromEntry(entry({ ...snapshot, phase: "done" })), undefined);
	assert.equal(hostedSearchCallsFromEntry(entry({ ...snapshot, startedAt: Number.NaN })), undefined);
	assert.equal(hostedSearchCallsFromEntry(entry({ ...snapshot, provider: "" })), undefined);
	assert.equal(hostedSearchCallsFromEntry(entry({ ...snapshot, calls: undefined })), undefined);
	assert.equal(hostedSearchCallsFromEntry(entry(snapshot, { type: "custom_message" })), undefined);
	assert.equal(hostedSearchCallsFromEntry(entry(snapshot, { customType: "other" })), undefined);
	assert.equal(hostedSearchCallsFromEntry(undefined), undefined);
	assert.equal(hostedSearchCallsFromEntry({ type: "custom", customType: HOSTED_SEARCH_ENTRY_TYPE }), undefined);

	const partiallyInvalid = entry({ ...snapshot, calls: [snapshot.calls[0], { status: "completed" }, null] });
	assert.equal(hostedSearchCallsFromEntry(partiallyInvalid), 1);
});

test("tracks observed call ids beyond the bounded snapshot list", () => {
	const activity = new HostedSearchActivity({ provider: "custom", model: "gpt-5.6-luna", startedAt: 1000 });
	for (let index = 0; index < 40; index++) {
		activity.upsertCall(`ws_${index}`, "in_progress");
		activity.upsertCall(`ws_${index}`, "completed");
	}

	const snapshot = activity.snapshot();
	assert.equal(snapshot.calls.length, 24);
	assert.equal(snapshot.callCount, 40);
	assert.equal(snapshot.calls[23]?.id, "ws_23");
	assert.equal(snapshot.calls[23]?.status, "completed");

	const entry = {
		id: "entry-bounded",
		type: "custom",
		customType: HOSTED_SEARCH_ENTRY_TYPE,
		data: snapshot,
	};
	assert.equal(hostedSearchCallsFromEntry(entry), 40);
	assert.equal(HostedSearchActivity.restore(snapshot).snapshot().callCount, 40);
});

test("falls back to unique persisted call ids when a snapshot predates callCount", () => {
	const legacySnapshot = (calls: HostedSearchSnapshot["calls"]): HostedSearchSnapshot => ({
		version: 1,
		responseId: "resp_legacy",
		provider: "custom",
		model: "gpt-5.6-luna",
		phase: "completed",
		startedAt: 1000,
		calls,
		sources: [],
	});
	const entry = (calls: HostedSearchSnapshot["calls"]) => ({
		id: "legacy-count",
		type: "custom",
		customType: HOSTED_SEARCH_ENTRY_TYPE,
		data: legacySnapshot(calls),
	});
	const call = (id: string) => ({ id, status: "completed", type: "search" as const, query: id });

	assert.equal(hostedSearchCallsFromEntry(entry([call("ws_1"), call("ws_2"), call("ws_1")])), 2);
	assert.equal(hostedSearchCallsFromEntry(entry([call("ws_1"), call("ws_1"), call("ws_1")])), 1);
	assert.equal(hostedSearchCallsFromEntry(entry([])), 0);

	const restored = HostedSearchActivity.restore(legacySnapshot([call("ws_1"), call("ws_2"), call("ws_1")]));
	assert.equal(restored.snapshot().calls.length, 2);
	assert.equal(restored.snapshot().callCount, 2);
});

test("rejects persisted call counts that are negative, fractional, or below the unique call ids", () => {
	const calls = [
		{ id: "ws_1", status: "completed", type: "search", query: "one" },
		{ id: "ws_2", status: "completed", type: "search", query: "two" },
		{ id: "ws_1", status: "completed", type: "search", query: "one again" },
	];
	const entry = (callCount: unknown) => ({
		id: "invalid-count",
		type: "custom",
		customType: HOSTED_SEARCH_ENTRY_TYPE,
		data: {
			version: 1,
			responseId: "resp_invalid",
			provider: "custom",
			model: "gpt-5.6-luna",
			phase: "completed",
			startedAt: 1000,
			calls,
			sources: [],
			callCount,
		},
	});

	for (const invalid of [-1, 0, 1, 1.5, "2", Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(hostedSearchCallsFromEntry(entry(invalid)), undefined, `callCount ${String(invalid)} should be rejected`);
	}
	assert.equal(hostedSearchCallsFromEntry(entry(2)), 2);
	assert.equal(hostedSearchCallsFromEntry(entry(7)), 7);

	resetHostedSearchActivities();
	restoreHostedSearchActivities([entry(-1)]);
	assert.equal(hostedSearchActivityForMessage({ provider: "custom", model: "gpt-5.6-luna", responseId: "resp_invalid" }), undefined);
});

test("does not attach a live activity to another assistant and rejects invalid persisted phases", () => {
	resetHostedSearchActivities();
	const live = new HostedSearchActivity({ provider: "custom", model: "gpt" });
	live.associateMessage({ provider: "custom", model: "gpt", timestamp: 100 });
	setActiveHostedSearchActivity(live);
	assert.equal(hostedSearchActivityForMessage({ provider: "custom", model: "gpt", timestamp: 101 }), undefined);

	restoreHostedSearchActivities([{
		type: "custom",
		customType: HOSTED_SEARCH_ENTRY_TYPE,
		data: {
			version: 1,
			responseId: "bad",
			provider: "custom",
			model: "gpt",
			phase: "completed but malicious",
			startedAt: 1,
			calls: [],
			sources: [],
		},
	}]);
	assert.equal(hostedSearchActivityForMessage({ provider: "custom", model: "gpt", responseId: "bad" }), undefined);
});
