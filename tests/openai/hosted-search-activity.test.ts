import assert from "node:assert/strict";
import { test } from "node:test";
import {
	HOSTED_SEARCH_ENTRY_TYPE,
	HostedSearchActivity,
	HostedSearchSseObserver,
	hostedSearchActivityForMessage,
	resetHostedSearchActivities,
	restoreHostedSearchActivities,
	setActiveHostedSearchActivity,
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
