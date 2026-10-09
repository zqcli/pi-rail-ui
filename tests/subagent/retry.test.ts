import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { RETRY_DELAYS_MS, retryContinuation, retryableAssistantError, waitForRetry } from "../../tools/subagents/retry";

function assistant(errorMessage: string, stopReason: AssistantMessage["stopReason"] = "error"): AssistantMessage {
	return {
		role: "assistant", content: [], api: "openai-responses", provider: "local", model: "fixture",
		stopReason, errorMessage, timestamp: 1000,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

test("ordinary retry uses the bounded production schedule and native transient classification", () => {
	assert.deepEqual(RETRY_DELAYS_MS, [10_000, 30_000, 60_000, 120_000, 300_000]);
	for (const error of ["503 unavailable", "429 too many requests", "fetch failed", "socket hang up"]) {
		assert.equal(retryableAssistantError(assistant(error)), true, error);
	}
	for (const error of ["401 Unauthorized", "400 invalid arguments", "429 insufficient_quota", "billing quota exceeded", "503 context length exceeded"]) {
		assert.equal(retryableAssistantError(assistant(error)), false, error);
	}
	for (const reason of ["stop", "length", "aborted"] as const) {
		assert.equal(retryableAssistantError(assistant("503 unavailable", reason)), false, reason);
	}
});

test("retry continuation preserves the original conversation rather than redispatching a task", () => {
	assert.equal(retryContinuation("503 unavailable"),
		"Your previous request stopped on a temporary provider error (503 unavailable); earlier tool results are still in this conversation. Continue from where you stopped and do not repeat completed side effects.");
});

test("retry wait observes its deadline and releases its cancellation listener", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const controller = new AbortController();
	let complete = false;
	const waiting = waitForRetry(30_000, controller.signal).then(() => { complete = true; });
	assert.equal(getEventListeners(controller.signal, "abort").length, 1);
	t.mock.timers.tick(29_999);
	await Promise.resolve();
	assert.equal(complete, false);
	t.mock.timers.tick(1);
	await waiting;
	assert.equal(complete, true);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("retry wait cancels promptly before and during a long backoff", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const controller = new AbortController();
	const waiting = waitForRetry(300_000, controller.signal);
	controller.abort();
	await assert.rejects(waiting, { name: "AbortError" });
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	await assert.rejects(waitForRetry(300_000, controller.signal), { name: "AbortError" });
	t.mock.timers.tick(300_000);
});
