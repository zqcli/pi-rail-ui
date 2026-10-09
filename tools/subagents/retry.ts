import { isContextOverflow, isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { prompt } from "../../core/prompts";

/** Outer retries after Pi has exhausted its own automatic recovery. */
export const RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 120_000, 300_000] as const;

export interface SubagentRetry {
	/** One-based scheduled retry, excluding the original attempt. */
	attempt: number;
	maxAttempts: number;
	/** Epoch milliseconds; displays derive their countdown from this deadline. */
	nextAt: number;
	error: string;
	/** Native Pi retries have their own budget and never increment Rail retryCount. */
	source?: "rail" | "pi";
}

export function retryableAssistantError(message: AssistantMessage, contextWindow?: number): boolean {
	return !isContextOverflow(message, contextWindow) && isRetryableAssistantError(message);
}

export function retryContinuation(error: string): string {
	return prompt("subagent", "retry_continuation", { error });
}

/** Cancellation removes both the timer and listener, including during backoff. */
export function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const abort = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			reject(new DOMException("Subagent retry was aborted", "AbortError"));
		};
		if (signal?.aborted) {
			reject(new DOMException("Subagent retry was aborted", "AbortError"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, delayMs);
		signal?.addEventListener("abort", abort, { once: true });
	});
}
