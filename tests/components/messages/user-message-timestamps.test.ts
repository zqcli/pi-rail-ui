import assert from "node:assert/strict";
import test from "node:test";
import { UserMessageTimestampRegistry } from "../../../components/messages/user-message-timestamps";

test("assigns repeated user message timestamps in session order", () => {
	const text = "same prompt";
	const firstTimestamp = new Date(2026, 0, 4, 8, 30).getTime();
	const secondTimestamp = new Date(2026, 0, 4, 9, 45).getTime();
	const registry = new UserMessageTimestampRegistry();
	registry.refresh([
		{
			type: "message",
			timestamp: firstTimestamp,
			message: { role: "user", content: [{ type: "text", text }] },
		},
		{
			type: "message",
			timestamp: secondTimestamp,
			message: { role: "user", content: [{ type: "text", text }] },
		},
	]);

	assert.equal(registry.timestampFor({}, text), firstTimestamp);
	assert.equal(registry.timestampFor({}, text), secondTimestamp);
});