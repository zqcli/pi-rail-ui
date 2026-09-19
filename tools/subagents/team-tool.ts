import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { TeamHub } from "./team-hub";
import { TEAM_HISTORY_TYPE, type TeamSnapshot } from "./team-protocol";
import { teamStatus } from "./team-runner";

export function restoreTeamHistory(hub: TeamHub, entries: readonly { type: string; customType?: string; data?: unknown }[]): void {
	const latest = new Map<string, TeamSnapshot>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== TEAM_HISTORY_TYPE) continue;
		const data = entry.data as TeamSnapshot | undefined;
		if (data && typeof data.id === "string" && Array.isArray(data.members) && Array.isArray(data.workers) && Array.isArray(data.events)) latest.set(data.id, data);
	}
	hub.restore([...latest.values()]);
}

export function installTeamTool(pi: ExtensionAPI, getHub: () => TeamHub): void {
	pi.registerTool({
		name: "subagent_team",
		label: "Subagent Team",
		description: "Prepare a fixed team, inspect status, or cancel. After prepare, launch two sibling subagent calls with teamId: single alias=coordinator and tasks with exactly all worker aliases. All members require new persistent sessions and concrete tasks. Emit BOTH calls in the same assistant message; never wait for A before starting workers. Keep timeoutSeconds null (default 3600s) unless the user requests a deadline; it covers the whole team including reasoning, tools, waiting and the final summary. Pause is cooperative at safe points. Reload interrupts unfinished teams.",
		promptGuidelines: [
			"Team prepare: default timeoutSeconds to null. Do not invent short 120/180-second limits for code review or max-thinking models; explicit deadlines bound the entire workflow, not one tool call.",
			"After Team prepare, emit coordinator single and workers grouped as two sibling subagent calls in ONE assistant message. If an unpaired call is rejected before joining, retry BOTH using the same prepared teamId rather than launching the missing side alone.",
		],
		executionMode: "parallel",
		parameters: Type.Object({
			action: StringEnum(["prepare", "status", "cancel"]),
			teamId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			coordinator: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			workers: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
			timeoutSeconds: Type.Optional(Type.Union([Type.Number({ exclusiveMinimum: 0, maximum: 86400 }), Type.Null()], { description: "Default null = 3600 seconds. Set only for a user-requested deadline. Total team budget from prepare, including startup, all model/tool work, waits and final summary; not a per-call timeout." })),
			reason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		}),
		async execute(_id, params) {
			const hub = getHub();
			let snapshots: TeamSnapshot[];
			if (params.action === "prepare") {
				if (!params.coordinator || !params.workers) throw new Error("prepare requires coordinator and workers");
				snapshots = [hub.prepare({ coordinator: params.coordinator, workers: params.workers, ...(params.timeoutSeconds != null ? { timeoutSeconds: params.timeoutSeconds } : {}) })];
			} else if (params.action === "cancel") {
				if (!params.teamId) throw new Error("cancel requires teamId");
				hub.cancel(params.teamId, params.reason ?? undefined);
				snapshots = [hub.get(params.teamId)];
			} else snapshots = params.teamId ? [hub.get(params.teamId)] : hub.list();
			const text = snapshots.map((snapshot) => {
				const status = `${snapshot.id}\n${teamStatus(snapshot)}`;
				if (params.action !== "prepare") return status;
				return `${status}\nBudget: ${(snapshot.deadline - snapshot.createdAt) / 1000}s total from prepare, including reasoning, tools, waiting and final summary.\nNext: emit BOTH coordinator single and all workers grouped with this teamId in ONE assistant message; do not wait between them.`;
			}).join("\n") || "No teams";
			return { content: [{ type: "text", text }], details: { snapshots } };
		},
		renderResult(result) {
			return new Text(result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"), 0, 0);
		},
	});
}
