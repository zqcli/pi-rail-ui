// Stateless JSON fixture for hosted search accounting: two assistant turns with a
// compaction between them and three observed web_search_call entries (one duplicated
// with the same entry id and one malformed snapshot). Entries follow real Pi order:
// each turn's entry_appended arrives before its assistant message_end, so the
// message_end immediate flush carries the final count without any trailing delay.

const usage = {
	input: 12,
	output: 3,
	cacheRead: 2,
	cacheWrite: 0,
	totalTokens: 17,
	cost: { total: 0.04 },
};

const snapshot = (responseId, callIds) => ({
	version: 1,
	responseId,
	provider: "cus-resp",
	model: "gpt-5.6-luna",
	phase: "completed",
	startedAt: 1000,
	endedAt: 2000,
	calls: callIds.map((id) => ({ id, status: "completed", type: "search", query: `query ${id}` })),
	sources: [{ title: "Example", url: "https://example.com/source" }],
});

const entry = (id, responseId, callIds) => ({
	type: "entry_appended",
	entry: {
		id,
		type: "custom",
		customType: "rail-oai-hosted-search",
		data: snapshot(responseId, callIds),
	},
});

write({ type: "message_start", message: { role: "assistant", content: [] } });
write({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "search turn" } });
write(entry("search-entry-1", "resp_search_1", ["ws_1", "ws_2"]));
write(entry("search-entry-1", "resp_search_1", ["ws_1", "ws_2"]));
write(entry("search-entry-1", "resp_search_1", ["ws_1", "ws_2", "ws_3"]));
write({
	type: "entry_appended",
	entry: { id: "search-entry-bad", type: "custom", customType: "rail-oai-hosted-search", data: { version: 2 } },
});
write({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "search turn" }], usage, stopReason: "stop" } });

write({ type: "compaction_start", reason: "threshold" });
write({
	type: "compaction_end",
	reason: "threshold",
	result: {
		summary: "private summary",
		usage: { input_tokens: 100, output_tokens: 5, total_tokens: 125, input_tokens_details: { cached_tokens: 20 }, cost: { total: 0.5 } },
	},
	aborted: false,
	willRetry: false,
});

const secondUsage = { input: 5, output: 1, totalTokens: 6, cost: { total: 0.01 } };
write({ type: "message_start", message: { role: "assistant", content: [] } });
write({ type: "message_update", usage: secondUsage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "search done" } });
write(entry("search-entry-2", "resp_search_2", ["ws_4"]));
write({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "search done" }], usage: secondUsage, stopReason: "stop" } });

function write(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
