import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import type { TeamHub } from "./team-hub";
import { TEAM_HISTORY_TYPE, type TeamBrief, type TeamSnapshot } from "./team-protocol";
import { teamStatus } from "./team-runner";

function nullable(schema: TSchema) {
	return Type.Optional(Type.Union([schema, Type.Null()]));
}

const BriefSchema = Type.Object({
	goal: Type.String({ minLength: 1, maxLength: 8192, description: "Shared team goal" }),
	target: nullable(Type.String({ maxLength: 4096, description: "Target URL, repository, system, or business scope" })),
	acceptanceCriteria: nullable(Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 32 })),
	constraints: nullable(Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 32 })),
	authorizations: nullable(Type.Array(Type.Object({
		member: Type.String({ minLength: 1, maxLength: 64 }),
		allowed: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 32 }),
		forbidden: nullable(Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 32 })),
	}, { additionalProperties: false }), { maxItems: 9 })),
}, { additionalProperties: false });

function normalizeList(value: unknown, field: string): string[] | undefined {
	if (value == null) return undefined;
	if (!Array.isArray(value)) throw new Error(`brief.${field} must be an array or null`);
	if (value.length > 32) throw new Error(`brief.${field} supports at most 32 entries`);
	return value.map((item, index) => {
		if (typeof item !== "string" || !item.trim() || Buffer.byteLength(item, "utf8") > 8 * 1024) throw new Error(`brief.${field}[${index}] must be a non-empty string no larger than 8192 UTF-8 bytes`);
		return item.trim();
	});
}

function normalizeBrief(value: unknown, members: readonly string[]): TeamBrief | undefined {
	if (value == null) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("brief must be an object or null");
	const input = value as Record<string, unknown>;
	if (Object.keys(input).some((key) => !["goal", "target", "acceptanceCriteria", "constraints", "authorizations"].includes(key))) throw new Error("brief contains an unknown field");
	if (typeof input["goal"] !== "string" || !input["goal"].trim() || Buffer.byteLength(input["goal"], "utf8") > 8 * 1024) throw new Error("brief.goal is required and must be no larger than 8192 UTF-8 bytes");
	const target = input["target"] == null ? undefined : typeof input["target"] === "string" ? input["target"].trim() : undefined;
	if (input["target"] != null && typeof input["target"] !== "string") throw new Error("brief.target must be a string or null");
	if (target && Buffer.byteLength(target, "utf8") > 8 * 1024) throw new Error("brief.target exceeds 8192 UTF-8 bytes");
	let authorizations: TeamBrief["authorizations"];
	if (input["authorizations"] != null) {
		if (!Array.isArray(input["authorizations"])) throw new Error("brief.authorizations must be an array or null");
		if (input["authorizations"].length > 9) throw new Error("brief.authorizations supports at most 9 members");
		const seen = new Set<string>();
		authorizations = input["authorizations"].map((raw, index) => {
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`brief.authorizations[${index}] must be an object`);
			const item = raw as Record<string, unknown>;
			if (Object.keys(item).some((key) => !["member", "allowed", "forbidden"].includes(key))) throw new Error(`brief.authorizations[${index}] contains an unknown field`);
			if (typeof item["member"] !== "string" || !item["member"].trim() || !members.includes(item["member"].trim())) {
				throw new Error(`brief.authorizations[${index}].member must name a team member`);
			}
			const member = item["member"].trim();
			if (seen.has(member)) throw new Error(`brief.authorizations contains duplicate member ${member}`);
			seen.add(member);
			const allowed = normalizeList(item["allowed"], `authorizations[${index}].allowed`);
			if (!allowed) throw new Error(`brief.authorizations[${index}].allowed is required`);
			const forbidden = normalizeList(item["forbidden"], `authorizations[${index}].forbidden`);
			return { member, allowed, ...(forbidden ? { forbidden } : {}) };
		});
	}
	const acceptanceCriteria = normalizeList(input["acceptanceCriteria"], "acceptanceCriteria");
	const constraints = normalizeList(input["constraints"], "constraints");
	const brief: TeamBrief = {
		goal: input["goal"].trim(),
		...(target ? { target } : {}),
		...(acceptanceCriteria ? { acceptanceCriteria } : {}),
		...(constraints ? { constraints } : {}),
		...(authorizations ? { authorizations } : {}),
	};
	if (Buffer.byteLength(JSON.stringify(brief), "utf8") > 32 * 1024) throw new Error("brief exceeds 32768 UTF-8 bytes");
	return brief;
}

function previewText(value: string, maxBytes: number): string {
	const plain = stripTerminalSequences(value).replace(/\s+/gu, " ").trim();
	if (Buffer.byteLength(JSON.stringify(plain), "utf8") - 2 <= maxBytes) return plain;
	let result = "";
	for (const character of plain) {
		if (Buffer.byteLength(JSON.stringify(`${result}${character}…`), "utf8") - 2 > maxBytes) break;
		result += character;
	}
	return `${result}…`;
}

function modelSnapshot(snapshot: TeamSnapshot) {
	return {
		id: snapshot.id,
		coordinator: snapshot.coordinator,
		workers: snapshot.workers,
		phase: snapshot.phase,
		seq: snapshot.seq,
		createdAt: snapshot.createdAt,
		deadline: snapshot.deadline,
		...(snapshot.brief ? { brief: snapshot.brief } : {}),
		members: snapshot.members.map((member) => ({
			id: member.id,
			role: member.role,
			state: member.state,
			...(member.waitingFor ? { waitingFor: member.waitingFor } : {}),
			...(member.assignment ? { assignment: {
				memberId: member.assignment.memberId,
				taskPreview: previewText(member.assignment.task, 512),
				...(member.assignment.cwd ? { cwdPreview: previewText(member.assignment.cwd, 256) } : {}),
				...(member.assignment.model ? { modelPreview: previewText(member.assignment.model, 128) } : {}),
				fastMode: member.assignment.fastMode === true,
				searchMode: previewText(member.assignment.searchMode ?? "off", 32),
			} } : {}),
			...(member.result ? { result: {
				status: member.result.status,
				summaryPreview: previewText(member.result.summary, 1024),
				findingsCount: member.result.findings?.length ?? 0,
				evidenceCount: member.result.evidence?.length ?? 0,
				limitationsCount: member.result.limitations?.length ?? 0,
				artifactsCount: member.result.artifacts?.length ?? 0,
			} } : {}),
			...(member.error ? { errorPreview: previewText(member.error, 300) } : {}),
		})),
		events: snapshot.events
			.filter((event) => (event.kind === "message" || event.kind === "report") && event.from && event.to && event.message)
			.slice(-8)
			.map((event) => ({ seq: event.seq, kind: event.kind, from: event.from, to: event.to,
				...(event.messageId ? { messageId: event.messageId, timestamp: event.timestamp } : {}),
				...(event.replyTo ? { replyTo: event.replyTo } : {}),
				...(event.supersedes ? { supersedes: event.supersedes } : {}),
				messagePreview: previewText(event.message!, 240) })),
	};
}

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
		description: "Prepare a fixed team, inspect status, or cancel. After prepare, launch two sibling subagent calls with teamId: one single call for the designated child coordinator and one parallel call containing exactly all worker aliases. Give every member a self-contained task and put shared goal, target/URL, acceptance criteria, constraints and per-member authorization in brief. Emit BOTH calls in the same assistant message; never wait for one before starting the other. The hosting parent is not a team member/coordinator. Team messages are queued for a recipient's receiving context checkpoint; ordinary send does not interrupt an active turn or wake the parent model. Keep timeoutSeconds null (default 3600s) unless the user requests a deadline; it covers the whole team including reasoning, tools, waiting and the final summary. Pause is cooperative at safe points. Reload interrupts unfinished teams.",
		promptGuidelines: [
			"Team prepare: default timeoutSeconds to null. Do not invent short 120/180-second limits for code review or max-thinking models; explicit deadlines bound the entire workflow, not one tool call.",
			"Make each worker task self-contained: include the necessary target/URL, expected inputs, acceptance criteria, relevant constraints, and its own allowed/forbidden operations. Put shared goal and per-member authorization in brief so all assignments and policy are present before any child receives its first context.",
			"After Team prepare, emit the designated child coordinator single and all workers grouped in parallel as two sibling subagent calls in ONE assistant message. The hosting parent is not the team's coordinator and should not claim it receives a live wakeup. Ordinary team send queues a message for a recipient checkpoint; it is not an immediate stop or parent-model wakeup. If an unpaired call is rejected before joining, retry BOTH using the same prepared teamId rather than launching the missing side alone.",
		],
		executionMode: "parallel",
		parameters: Type.Object({
			action: StringEnum(["prepare", "status", "cancel"]),
			teamId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			coordinator: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			workers: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
			timeoutSeconds: Type.Optional(Type.Union([Type.Number({ exclusiveMinimum: 0, maximum: 86400 }), Type.Null()], { description: "Default null = 3600 seconds. Set only for a user-requested deadline. Total team budget from prepare, including startup, all model/tool work, waits and final summary; not a per-call timeout." })),
			reason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			brief: Type.Optional(Type.Union([BriefSchema, Type.Null()], { description: "Shared goal, target, acceptance criteria, constraints and member-specific authorization. Null optional fields are normalized away." })),
		}),
		async execute(_id, params) {
			const hub = getHub();
			let snapshots: TeamSnapshot[];
			if (params.action === "prepare") {
				if (params.teamId?.trim()) throw new Error("prepare creates a new team and does not accept teamId");
				if (!params.coordinator || !params.workers) throw new Error("prepare requires coordinator and workers");
				const brief = normalizeBrief(params.brief, [params.coordinator, ...params.workers]);
				snapshots = [hub.prepare({ coordinator: params.coordinator, workers: params.workers, ...(params.timeoutSeconds != null ? { timeoutSeconds: params.timeoutSeconds } : {}), ...(brief ? { brief } : {}) })];
			} else if (params.action === "cancel") {
				if (!params.teamId) throw new Error("cancel requires teamId");
				hub.cancel(params.teamId, params.reason ?? undefined);
				snapshots = [hub.get(params.teamId)];
			} else snapshots = params.teamId ? [hub.get(params.teamId)] : hub.list();
			const listing = params.action === "status" && !params.teamId;
			const readable = snapshots.map((snapshot) => {
				if (listing) return `${snapshot.id} · ${snapshot.phase.toUpperCase()} · coordinator ${snapshot.coordinator} · ${snapshot.workers.length} workers`;
				const status = `${snapshot.id}\n${teamStatus(snapshot)}`;
				if (params.action !== "prepare") return status;
				return `${status}\nBudget: ${(snapshot.deadline - snapshot.createdAt) / 1000}s total from prepare, including reasoning, tools, waiting and final summary.\nNext: emit BOTH coordinator single and all workers grouped with this teamId in ONE assistant message; do not wait between them.`;
			}).join("\n") || "No teams";
			const next = params.action === "prepare"
				? "Emit the designated child coordinator single call and all workers in one grouped parallel call as sibling subagent calls in the same assistant message. Messages are queued for receiving checkpoints; they do not wake or interrupt the hosting parent model."
				: "Use status with a specific teamId to inspect assignment/result previews and recent message routes. Previews are not full deliverables; structured results are retained in the native subagent result details and team journal. Listing teams returns summaries only. This response does not provide a live wakeup channel to the hosting parent model.";
			const response = {
				action: params.action,
				teamId: snapshots.length === 1 ? snapshots[0]!.id : params.teamId?.trim() || null,
				from: "@hub",
				to: "@parent",
				...(listing ? { snapshots: snapshots.map((snapshot) => ({
					id: snapshot.id, coordinator: snapshot.coordinator, phase: snapshot.phase,
					workerCount: snapshot.workers.length,
					completed: snapshot.members.filter((member) => member.state === "completed").length,
					failed: snapshot.members.filter((member) => member.state === "failed").length,
					blocked: snapshot.members.filter((member) => member.result?.status === "blocked").length,
				})) } : snapshots.length === 1 ? { snapshot: modelSnapshot(snapshots[0]!) } : { snapshots: [] }),
				next,
			};
			return { content: [{ type: "text", text: `${readable}\nJSON:\n${JSON.stringify(response)}` }], details: { snapshots, response } };
		},
		renderResult(result) {
			return new Text(result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"), 0, 0);
		},
	});
}
