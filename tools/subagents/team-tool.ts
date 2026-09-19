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
		description: "Prepare a fixed team, inspect status, or cancel. After prepare, launch two sibling subagent calls with teamId: single alias=coordinator and tasks with exactly all worker aliases. All members require new persistent sessions and concrete tasks. Do not launch serially: admission has a short timeout. Pause is cooperative at safe points. Reload interrupts unfinished teams.",
		executionMode: "parallel",
		parameters: Type.Object({
			action: StringEnum(["prepare", "status", "cancel"]),
			teamId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			coordinator: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			workers: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
			timeoutSeconds: Type.Optional(Type.Union([Type.Number({ exclusiveMinimum: 0, maximum: 86400 }), Type.Null()])),
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
			return { content: [{ type: "text", text: snapshots.map((snapshot) => `${snapshot.id}\n${teamStatus(snapshot)}`).join("\n") || "No teams" }], details: { snapshots } };
		},
		renderResult(result) {
			return new Text(result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"), 0, 0);
		},
	});
}
