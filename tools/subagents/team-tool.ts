import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import type { TeamHub } from "./team-hub";
import {
	isTeamBrief, TEAM_HISTORY_TYPE, TEAM_MAX_BRIEF_BYTES, TEAM_MAX_MEMBERS, TEAM_MAX_MESSAGE_BYTES, TEAM_MAX_RESULT_ITEMS,
	TEAM_MAX_TEXT_BYTES, TEAM_MAX_WORKERS, type TeamBrief, type TeamSnapshot,
} from "./team-protocol";
import {
	deleteTeamLaunchPlan, setTeamLaunchPlan, teamDispatchTemplate, teamLaunchPlan, teamStatus,
	type TeamLaunchPlan, type TeamMemberPlan,
} from "./team-runner";
import type { TeamLauncher, TeamPlanSummary } from "./tool";

function nullable(schema: TSchema) {
	return Type.Optional(Type.Union([schema, Type.Null()]));
}

// Character limits match the shared UTF-8 byte validator; byte limits are enforced after normalization.
const BriefText = (description?: string) => Type.String({ minLength: 1, maxLength: TEAM_MAX_TEXT_BYTES, ...(description ? { description } : {}) });
const BriefList = () => Type.Array(BriefText(), { maxItems: TEAM_MAX_RESULT_ITEMS });
const BriefSchema = Type.Object({
	goal: BriefText("Shared team goal"),
	target: nullable(Type.String({ maxLength: TEAM_MAX_TEXT_BYTES, description: "Target URL, repository, system, or business scope" })),
	acceptanceCriteria: nullable(BriefList()),
	constraints: nullable(BriefList()),
	authorizations: nullable(Type.Array(Type.Object({
		member: Type.String({ minLength: 1, maxLength: 64 }),
		allowed: BriefList(),
		forbidden: nullable(BriefList()),
	}, { additionalProperties: false }), { maxItems: TEAM_MAX_MEMBERS })),
}, { additionalProperties: false, description: `At most ${TEAM_MAX_BRIEF_BYTES} serialized UTF-8 bytes in total.` });

// A member is fully described at prepare, so launch needs nothing but the teamId.
const MemberPlanSchema = Type.Object({
	alias: Type.String({ minLength: 1, maxLength: 64, description: "New persistent alias for this member" }),
	task: Type.String({ minLength: 1, description: "Concrete self-contained task for this member" }),
	model: nullable(Type.String({ description: "Pi model reference such as provider/model:thinking; null uses the current model" })),
	fastMode: nullable(Type.Boolean({ description: "true enables native Fast for an eligible GPT model; null means off" })),
	cwd: nullable(Type.String({ description: "Working directory; null uses the parent cwd" })),
}, { additionalProperties: false });

function normalizeMember(value: unknown, field: string): TeamMemberPlan {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object {alias, task, model?, fastMode?, cwd?}`);
	const input = value as Record<string, unknown>;
	const unknown = Object.keys(input).filter((key) => !["alias", "task", "model", "fastMode", "cwd"].includes(key));
	if (unknown.length) throw new Error(`${field} has unsupported field(s) ${unknown.join(", ")}; a member plan only has alias, task, model, fastMode and cwd`);
	const text = (key: string): string | undefined => {
		const raw = input[key];
		if (raw == null) return undefined;
		if (typeof raw !== "string") throw new Error(`${field}.${key} must be a string or null`);
		return raw.trim() || undefined;
	};
	const alias = text("alias");
	const task = text("task");
	if (!alias) throw new Error(`${field}.alias is required`);
	if (!task) throw new Error(`${field}.task is required: give ${alias} a concrete self-contained task`);
	if (Buffer.byteLength(task, "utf8") > TEAM_MAX_MESSAGE_BYTES) throw new Error(`${field}.task exceeds ${TEAM_MAX_MESSAGE_BYTES} UTF-8 bytes`);
	if (input["fastMode"] != null && typeof input["fastMode"] !== "boolean") throw new Error(`${field}.fastMode must be a boolean or null`);
	const model = text("model");
	const cwd = text("cwd");
	return {
		alias, task,
		...(model ? { model } : {}),
		...(typeof input["fastMode"] === "boolean" ? { fastMode: input["fastMode"] } : {}),
		...(cwd ? { cwd } : {}),
	};
}

/** Returns the launch plan, or undefined for the legacy alias-only form that is dispatched with paired subagent calls. */
function normalizePlan(coordinator: unknown, workers: unknown): { aliases: { coordinator: string; workers: string[] }; plan?: TeamLaunchPlan } {
	if (!Array.isArray(workers)) throw new Error("prepare requires coordinator and workers");
	if (typeof coordinator === "string" && workers.every((worker) => typeof worker === "string")) {
		return { aliases: { coordinator, workers: workers as string[] } };
	}
	if (typeof coordinator === "string" || workers.some((worker) => typeof worker === "string")) {
		throw new Error("Give every member as an object {alias, task, model?, fastMode?, cwd?}; do not mix alias strings and member objects");
	}
	if (workers.length < 1 || workers.length > TEAM_MAX_WORKERS) throw new Error(`workers must list 1–${TEAM_MAX_WORKERS} members`);
	const plan: TeamLaunchPlan = {
		coordinator: normalizeMember(coordinator, "coordinator"),
		workers: workers.map((worker, index) => normalizeMember(worker, `workers[${index}]`)),
	};
	return { aliases: { coordinator: plan.coordinator.alias, workers: plan.workers.map((worker) => worker.alias) }, plan };
}

function planLines(summaries: readonly TeamPlanSummary[] | undefined, plan: TeamLaunchPlan): string[] {
	return [plan.coordinator, ...plan.workers].map((member, index) => {
		const summary = summaries?.[index];
		const policy = summary ? ` · ${summary.model} · FAST ${summary.fastMode ? "on" : "off"} · SEARCH ${summary.searchMode}` : member.model ? ` · ${member.model}` : "";
		return `- ${member.alias} (${index === 0 ? "coordinator" : "worker"})${policy} · task: ${previewText(member.task, 200)}`;
	});
}

function normalizeList(value: unknown, field: string): string[] | undefined {
	if (value == null) return undefined;
	if (!Array.isArray(value)) throw new Error(`brief.${field} must be an array or null`);
	if (value.length > TEAM_MAX_RESULT_ITEMS) throw new Error(`brief.${field} supports at most ${TEAM_MAX_RESULT_ITEMS} entries`);
	return value.map((item, index) => {
		if (typeof item !== "string" || !item.trim() || Buffer.byteLength(item, "utf8") > TEAM_MAX_TEXT_BYTES) throw new Error(`brief.${field}[${index}] must be a non-empty string no larger than ${TEAM_MAX_TEXT_BYTES} UTF-8 bytes`);
		return item.trim();
	});
}

function normalizeBrief(value: unknown, members: readonly string[]): TeamBrief | undefined {
	if (value == null) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("brief must be an object or null");
	const input = value as Record<string, unknown>;
	if (Object.keys(input).some((key) => !["goal", "target", "acceptanceCriteria", "constraints", "authorizations"].includes(key))) throw new Error("brief contains an unknown field");
	if (typeof input["goal"] !== "string" || !input["goal"].trim() || Buffer.byteLength(input["goal"], "utf8") > TEAM_MAX_TEXT_BYTES) throw new Error(`brief.goal is required and must be no larger than ${TEAM_MAX_TEXT_BYTES} UTF-8 bytes`);
	const target = input["target"] == null ? undefined : typeof input["target"] === "string" ? input["target"].trim() : undefined;
	if (input["target"] != null && typeof input["target"] !== "string") throw new Error("brief.target must be a string or null");
	if (target && Buffer.byteLength(target, "utf8") > TEAM_MAX_TEXT_BYTES) throw new Error(`brief.target exceeds ${TEAM_MAX_TEXT_BYTES} UTF-8 bytes`);
	let authorizations: TeamBrief["authorizations"];
	if (input["authorizations"] != null) {
		if (!Array.isArray(input["authorizations"])) throw new Error("brief.authorizations must be an array or null");
		if (input["authorizations"].length > TEAM_MAX_MEMBERS) throw new Error(`brief.authorizations supports at most ${TEAM_MAX_MEMBERS} members`);
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
	// The shared validator is authoritative (aggregate JSON size including escaping).
	if (!isTeamBrief(brief)) throw new Error(`brief exceeds ${TEAM_MAX_BRIEF_BYTES} serialized UTF-8 bytes`);
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

/** Display-only history: the Hub keeps the latest valid entry per team and skips the rest. */
export function restoreTeamHistory(hub: TeamHub, entries: readonly { type: string; customType?: string; data?: unknown }[]): { restored: number; skipped: number } {
	const snapshots = entries.filter((entry) => entry.type === "custom" && entry.customType === TEAM_HISTORY_TYPE)
		.map((entry) => entry.data as TeamSnapshot);
	return hub.restore(snapshots);
}

export function installTeamTool(pi: ExtensionAPI, getHub: () => TeamHub, getLauncher?: () => TeamLauncher | undefined): void {
	pi.registerTool({
		name: "subagent_team",
		label: "Subagent Team",
		description: "Run a fixed team: one child coordinator plus 1–8 workers, all new persistent aliases. Two steps, one call each: "
			+ "(1) {\"action\":\"prepare\",\"coordinator\":{\"alias\":\"<A>\",\"task\":\"...\",\"model\":null,\"fastMode\":null,\"cwd\":null},\"workers\":[{\"alias\":\"<B1>\",\"task\":\"...\",\"model\":null,\"fastMode\":null,\"cwd\":null}, ...],\"brief\":{...}} "
			+ "validates the whole plan and returns the teamId without starting anything; "
			+ "(2) in your next message {\"action\":\"launch\",\"teamId\":\"<teamId>\"} starts every member and returns when the coordinator has finished with all worker outcomes. "
			+ "Do not use the subagent tool for team members. status and cancel take a teamId. "
			+ "Give every member a self-contained task and put shared goal, target/URL, acceptance criteria, constraints and per-member authorization in brief. The hosting parent is not a team member/coordinator. Team messages are queued for a recipient's receiving context checkpoint; ordinary send does not interrupt an active turn or wake the parent model. Keep timeoutSeconds null (default 3600s) unless the user requests a deadline; it covers the whole team including reasoning, tools, waiting and the final summary. Pause is cooperative at safe points. Reload interrupts unfinished teams.",
		promptGuidelines: [
			"Team prepare: default timeoutSeconds to null. Do not invent short 120/180-second limits for code review or max-thinking models; explicit deadlines bound the entire workflow, not one tool call.",
			"Make each worker task self-contained: include the necessary target/URL, expected inputs, acceptance criteria, relevant constraints, and its own allowed/forbidden operations. Put shared goal and per-member authorization in brief so all assignments and policy are present before any child receives its first context.",
			"Run a team with two subagent_team calls in consecutive messages: prepare with the complete member plan (coordinator object and workers array, each with alias, task and optional model/fastMode/cwd), then launch with only the returned teamId. Never start team members with the subagent tool. If prepare is rejected, fix the named field and prepare again; nothing was started. The hosting parent is not the team's coordinator and should not claim it receives a live wakeup. After a team fails or is cancelled, prepare a new team; started members keep their aliases, so use new aliases for them.",
		],
		executionMode: "parallel",
		parameters: Type.Object({
			action: StringEnum(["prepare", "launch", "status", "cancel"]),
			teamId: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "launch/status/cancel: the teamId returned by prepare (status without it lists teams). prepare: null." })),
			coordinator: Type.Optional(Type.Union([MemberPlanSchema, Type.String(), Type.Null()], { description: "prepare: the child coordinator as {alias, task, model, fastMode, cwd}. Other actions: null." })),
			workers: Type.Optional(Type.Union([Type.Array(Type.Union([MemberPlanSchema, Type.String()]), { minItems: 1, maxItems: TEAM_MAX_WORKERS }), Type.Null()], { description: "prepare: 1–8 workers, each {alias, task, model, fastMode, cwd}. Other actions: null." })),
			timeoutSeconds: Type.Optional(Type.Union([Type.Number({ exclusiveMinimum: 0, maximum: 86400 }), Type.Null()], { description: "Default null = 3600 seconds. Set only for a user-requested deadline. Total team budget from prepare, including startup, all model/tool work, waits and final summary; not a per-call timeout." })),
			reason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			brief: Type.Optional(Type.Union([BriefSchema, Type.Null()], { description: "Shared goal, target, acceptance criteria, constraints and member-specific authorization. Null optional fields are normalized away." })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
			const hub = getHub();
			if (params.action === "launch") {
				const teamId = params.teamId?.trim();
				if (!teamId) throw new Error("launch requires the teamId returned by prepare");
				let snapshot: TeamSnapshot;
				try { snapshot = hub.get(teamId); }
				catch { throw new Error(`Unknown teamId ${JSON.stringify(teamId.slice(0, 128))}: use the exact teamId returned by prepare (status without teamId lists teams).`); }
				// Placeholders (null, "", []) are fine; a real value would silently not apply, so reject it.
				const present = (value: unknown) => value != null && !(Array.isArray(value) && value.length === 0) && !(typeof value === "string" && !value.trim());
				const extra = (["coordinator", "workers", "brief", "timeoutSeconds"] as const).filter((key) => present(params[key]));
				if (extra.length) {
					throw new Error(`launch takes only teamId; ${extra.join(", ")} ${extra.length === 1 ? "was" : "were"} fixed at prepare. Send {"action":"launch","teamId":"${teamId}"}, or cancel this team and prepare again to change the plan. Nothing was started.`);
				}
				const plan = teamLaunchPlan(hub, teamId);
				if (!plan) {
					if (snapshot.phase !== "prepared" || snapshot.members.some((member) => member.state !== "registered")) {
						throw new Error(`Team ${teamId} is ${snapshot.phase} and cannot be launched again; use status to inspect it, or prepare a new team.`);
					}
					throw new Error(`Team ${teamId} was prepared with aliases only and has no launch plan. Cancel it and prepare again with member objects {alias, task, ...}.`);
				}
				const launcher = getLauncher?.();
				if (!launcher) throw new Error("Team launch is not available in this runtime");
				return launcher.launch(toolCallId, teamId, plan, signal, onUpdate as never, ctx) as never;
			}
			let snapshots: TeamSnapshot[];
			let prepared: { plan: TeamLaunchPlan; summaries?: TeamPlanSummary[] } | undefined;
			if (params.action === "prepare") {
				if (params.teamId?.trim()) throw new Error("prepare creates a new team and does not accept teamId");
				if (params.coordinator == null || params.workers == null) throw new Error("prepare requires coordinator and workers");
				const { aliases, plan } = normalizePlan(params.coordinator, params.workers);
				const brief = normalizeBrief(params.brief, [aliases.coordinator, ...aliases.workers]);
				const summaries = plan ? await getLauncher?.()?.validate(plan, ctx) : undefined;
				snapshots = [hub.prepare({ ...aliases, ...(params.timeoutSeconds != null ? { timeoutSeconds: params.timeoutSeconds } : {}), ...(brief ? { brief } : {}) })];
				if (plan) {
					// Pin what was validated and shown, so a later parent model or cwd change cannot alter the launch.
					const pin = (member: TeamMemberPlan, index: number): TeamMemberPlan => summaries?.[index]
						? { ...member, model: summaries[index]!.model, cwd: summaries[index]!.cwd }
						: member;
					setTeamLaunchPlan(hub, snapshots[0]!.id, { coordinator: pin(plan.coordinator, 0), workers: plan.workers.map((worker, index) => pin(worker, index + 1)) });
					prepared = { plan, ...(summaries ? { summaries } : {}) };
				}
			} else if (params.action === "cancel") {
				if (!params.teamId) throw new Error("cancel requires teamId");
				hub.cancel(params.teamId, params.reason ?? undefined);
				deleteTeamLaunchPlan(hub, params.teamId);
				snapshots = [hub.get(params.teamId)];
			} else snapshots = params.teamId ? [hub.get(params.teamId)] : hub.list();
			const listing = params.action === "status" && !params.teamId;
			const readable = snapshots.map((snapshot) => {
				if (listing) return `${snapshot.id} · ${snapshot.phase.toUpperCase()} · coordinator ${snapshot.coordinator} · ${snapshot.workers.length} workers`;
				const status = `${snapshot.id}\n${teamStatus(snapshot)}`;
				if (params.action !== "prepare") return status;
				const budget = `Budget: ${(snapshot.deadline - snapshot.createdAt) / 1000}s total from prepare, including reasoning, tools, waiting and final summary.`;
				if (!prepared) return `${status}\n${budget}\nNext: ${teamDispatchTemplate(snapshot)}`;
				return [status, "Plan (validated; nothing has started):", ...planLines(prepared.summaries, prepared.plan), budget,
					`Next: in your next message call subagent_team {"action":"launch","teamId":"${snapshot.id}"}. It starts every member and returns when the coordinator has finished. Do not start members with the subagent tool.`].join("\n");
			}).join("\n") || "No teams";
			const next = params.action === "prepare"
				? prepared
					? `Call subagent_team {"action":"launch","teamId":"${snapshots[0]!.id}"} in your next message. Messages are queued for receiving checkpoints; they do not wake or interrupt the hosting parent model.`
					: "Emit the two launch calls shown above as sibling subagent calls in the same assistant message; do not wait between them. Messages are queued for receiving checkpoints; they do not wake or interrupt the hosting parent model."
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
				...(prepared ? { plan: [prepared.plan.coordinator, ...prepared.plan.workers].map((member, index) => ({
					alias: member.alias, role: index === 0 ? "coordinator" : "worker", taskPreview: previewText(member.task, 512),
					...(prepared!.summaries?.[index] ? { model: prepared!.summaries[index]!.model, fastMode: prepared!.summaries[index]!.fastMode, searchMode: prepared!.summaries[index]!.searchMode } : {}),
				})) } : {}),
				next,
			};
			return { content: [{ type: "text", text: `${readable}\nJSON:\n${JSON.stringify(response)}` }], details: { snapshots, response } };
		},
		renderCall(args, theme) {
			const action = String(args.action ?? "");
			const team = typeof args.teamId === "string" && args.teamId.trim() ? ` · ${args.teamId.trim().slice(0, 8)}` : "";
			const members = action === "prepare" && Array.isArray(args.workers) ? ` · 1 coordinator + ${args.workers.length} workers` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent_team "))}${theme.fg("accent", `${action}${team}${members}`)}`, 0, 0);
		},
		renderResult(result, renderOptions, theme, context) {
			const details = result.details as { results?: unknown[] } | undefined;
			const launcher = getLauncher?.();
			if (launcher && Array.isArray(details?.results)) return launcher.renderResult(result, renderOptions, theme, context);
			return new Text(result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"), 0, 0);
		},
	});
}
