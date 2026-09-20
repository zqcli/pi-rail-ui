import type { SubagentUsage } from "./session-broker";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function amount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageNumber(usage: UnknownRecord, camel: string, snake: string): number | undefined {
	const value = usage[camel] ?? usage[snake];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function emptySubagentUsage(): SubagentUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function providerReportedUsage(value: unknown): SubagentUsage | undefined {
	const usage = record(value);
	if (!usage) return undefined;
	const cost = record(usage["cost"]);
	const details = record(usage["input_tokens_details"]);
	const cacheRead = usageNumber(usage, "cacheRead", "cached_tokens")
		?? amount(details?.["cached_tokens"]);
	const cacheWrite = usageNumber(usage, "cacheWrite", "cache_write_tokens")
		?? amount(details?.["cache_write_tokens"]);
	const explicitInput = usageNumber(usage, "input", "input_tokens");
	const rawInput = usageNumber(usage, "input_tokens", "input_tokens");
	const input = usage["input"] !== undefined
		? amount(explicitInput)
		: Math.max(0, amount(rawInput) - cacheRead - cacheWrite);
	const output = usageNumber(usage, "output", "output_tokens") ?? 0;
	const contextTokens = usageNumber(usage, "totalTokens", "total_tokens") ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		cost: amount(cost?.["total"]),
		contextTokens,
		turns: 0,
	};
}

export function addUsage(total: SubagentUsage, usage: SubagentUsage, countTurn: boolean): void {
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.cost += usage.cost;
	const searches = usage.searches ?? 0;
	if (searches > 0) total.searches = (total.searches ?? 0) + searches;
	if (countTurn) {
		total.contextTokens = usage.contextTokens || total.contextTokens;
		total.turns++;
	}
}

export function addCompletedAssistantUsage(total: SubagentUsage, message: unknown): boolean {
	const value = record(message);
	if (value?.["role"] !== "assistant") return false;
	const usage = providerReportedUsage(value["usage"]);
	if (!usage) return false;
	addUsage(total, usage, true);
	return true;
}

/** Tool-owned LLM work is billed without changing the main assistant context. */
export function addCompletedToolResultUsage(total: SubagentUsage, message: unknown): boolean {
	const value = record(message);
	if (value?.["role"] !== "toolResult") return false;
	const usage = providerReportedUsage(value["usage"]);
	if (!usage) return false;
	addUsage(total, usage, false);
	return true;
}

/** Add one compaction provider call without turning it into an assistant turn. */
export function addCompactionUsage(total: SubagentUsage, result: unknown): boolean {
	const usage = providerReportedUsage(record(result)?.["usage"]);
	if (!usage) return false;
	addUsage(total, usage, false);
	return true;
}

export function usageWithActiveTurn(completed: SubagentUsage, active: SubagentUsage | undefined): SubagentUsage {
	const searches = (completed.searches ?? 0) + (active?.searches ?? 0);
	const result: SubagentUsage = active
		? {
			input: completed.input + active.input,
			output: completed.output + active.output,
			cacheRead: completed.cacheRead + active.cacheRead,
			cacheWrite: completed.cacheWrite + active.cacheWrite,
			cost: completed.cost + active.cost,
			contextTokens: active.contextTokens || completed.contextTokens,
			turns: completed.turns + 1,
		}
		: { ...completed };
	if (searches > 0) result.searches = searches;
	else delete result.searches;
	return result;
}
