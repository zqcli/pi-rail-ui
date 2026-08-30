import type { SubagentUsage } from "./session-broker";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function amount(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function emptySubagentUsage(): SubagentUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function providerReportedUsage(value: unknown): SubagentUsage | undefined {
	const usage = record(value);
	if (!usage) return undefined;
	const cost = record(usage["cost"]);
	return {
		input: amount(usage["input"]),
		output: amount(usage["output"]),
		cacheRead: amount(usage["cacheRead"]),
		cacheWrite: amount(usage["cacheWrite"]),
		cost: amount(cost?.["total"]),
		contextTokens: amount(usage["totalTokens"]),
		turns: 0,
	};
}

export function addCompletedAssistantUsage(total: SubagentUsage, message: unknown): boolean {
	const value = record(message);
	if (value?.["role"] !== "assistant") return false;
	const usage = providerReportedUsage(value["usage"]);
	if (!usage) return false;
	total.input += usage.input;
	total.output += usage.output;
	total.cacheRead += usage.cacheRead;
	total.cacheWrite += usage.cacheWrite;
	total.cost += usage.cost;
	total.contextTokens = usage.contextTokens || total.contextTokens;
	total.turns++;
	return true;
}

export function usageWithActiveTurn(completed: SubagentUsage, active: SubagentUsage | undefined): SubagentUsage {
	if (!active) return { ...completed };
	return {
		input: completed.input + active.input,
		output: completed.output + active.output,
		cacheRead: completed.cacheRead + active.cacheRead,
		cacheWrite: completed.cacheWrite + active.cacheWrite,
		cost: completed.cost + active.cost,
		contextTokens: active.contextTokens || completed.contextTokens,
		turns: completed.turns + 1,
	};
}
