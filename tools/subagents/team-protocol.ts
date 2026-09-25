import { fileURLToPath } from "node:url";

export const TEAM_PROTOCOL_VERSION = 1 as const;
export const TEAM_COMMAND = "rail-subagent-team-protocol";
export const TEAM_ENTRY_TYPE = "rail-subagent-team-protocol";
export const TEAM_HISTORY_TYPE = "rail-subagent-team";
export const TEAM_MAX_MESSAGE_BYTES = 8 * 1024;
export const TEAM_MAX_EVENTS = 64;
export const TEAM_MAX_WORKERS = 8;

export const TEAM_MAX_TEXT_BYTES = 8 * 1024;
export const TEAM_MAX_OUTPUT_BYTES = 16 * 1024;
export const TEAM_MAX_ERROR_BYTES = 8 * 1024;
export const TEAM_MAX_RESULT_ITEMS = 32;
const TEAM_MAX_BRIEF_AUTHORIZATIONS = TEAM_MAX_WORKERS + 1; // one per member
export const TEAM_MAX_BRIEF_BYTES = 32 * 1024;
export const TEAM_MAX_ASSIGNMENT_BYTES = 16 * 1024;
export const TEAM_MAX_TASK_RESULT_BYTES = 12 * 1024;
export const TEAM_MAX_MEMBERS = TEAM_MAX_WORKERS + 1;

export function teamExtensionPath(): string {
	return fileURLToPath(new URL("./team-extension.ts", import.meta.url));
}

export type TeamRole = "coordinator" | "worker";
export const TEAM_MEMBER_STATES = ["registered", "starting", "running", "waiting", "pause_requested", "paused", "finalizing", "completed", "failed", "cancelled"] as const;
export type TeamMemberState = typeof TEAM_MEMBER_STATES[number];
export const TEAM_PHASES = ["prepared", "running", "finalizing", "completed", "failed", "cancelled", "interrupted"] as const;
export type TeamPhase = typeof TEAM_PHASES[number];

/** Dispatch-local capability. Never expose it in tool results or model prompts. */
export interface TeamBinding {
	version: typeof TEAM_PROTOCOL_VERSION;
	teamId: string;
	memberId: string;
	role: TeamRole;
	epoch: string;
}

export interface TeamWait {
	kind: "message" | "member" | "workers";
	member?: string;
	/** Filter message/report deliveries by authenticated sender, not member terminal state. */
	from?: string;
	afterSeq?: number;
}

export interface TeamEvidence {
	source: string;
	locator?: string;
	basis: "observed" | "verified" | "inferred" | "unverified";
}

export interface TeamTaskResult {
	status: "succeeded" | "partial" | "blocked" | "failed";
	summary: string;
	findings?: string[];
	evidence?: TeamEvidence[];
	limitations?: string[];
	artifacts?: string[];
}

/** Parent-supplied scope, not a grant of additional operating-system privileges. */
export interface TeamBrief {
	goal: string;
	target?: string;
	acceptanceCriteria?: string[];
	constraints?: string[];
	authorizations?: { member: string; allowed: string[]; forbidden?: string[] }[];
}

export interface TeamAssignment {
	memberId: string;
	task: string;
	cwd?: string;
	model?: string;
	fastMode?: boolean;
	searchMode?: string;
}

export interface TeamRequest {
	requestId: string;
	sequence: number;
	action: "checkpoint" | "send" | "report" | "wait" | "control" | "finish";
	/** Only the native context gate may consume inbox messages into model context. */
	receive?: boolean;
	/** Context revision under which a tool call was generated. Internal only. */
	revision?: number;
	to?: string;
	message?: string;
	replyTo?: string;
	supersedes?: string;
	result?: TeamTaskResult;
	wait?: TeamWait;
	command?: TeamControlCommand;
}

export const TEAM_CONTROL_COMMANDS = ["pause", "resume", "redirect", "cancel"] as const;
export type TeamControlCommand = typeof TEAM_CONTROL_COMMANDS[number];
export const TEAM_EVENT_KINDS = ["message", "report", "state", "result", "control", "cancelled", "undelivered"] as const;
export const TEAM_REPLY_CODES = ["stale_instruction", "team_stalled"] as const;

export interface TeamEvent {
	/** Absent only on legacy persisted events. New public events use v2 routing. */
	version?: 2;
	messageId?: string;
	timestamp?: number;
	replyTo?: string;
	supersedes?: string;
	seq: number;
	kind: typeof TEAM_EVENT_KINDS[number];
	from?: string;
	to?: string;
	message?: string;
	member?: string;
	state?: TeamMemberState;
}

export interface TeamMemberSnapshot {
	id: string;
	role: TeamRole;
	state: TeamMemberState;
	waitingFor?: string;
	output?: string;
	error?: string;
	assignment?: TeamAssignment;
	result?: TeamTaskResult;
	instructionRevision?: number;
	observedRevision?: number;
}

export interface TeamSnapshot {
	id: string;
	coordinator: string;
	workers: string[];
	phase: TeamPhase;
	seq: number;
	createdAt: number;
	deadline: number;
	brief?: TeamBrief;
	members: TeamMemberSnapshot[];
	events: TeamEvent[];
}

export interface TeamReply {
	ok: boolean;
	/** Runtime-authenticated reply routing; absent only on legacy fixtures/history. */
	from?: string;
	to?: string;
	requestId?: string;
	revision?: number;
	code?: typeof TEAM_REPLY_CODES[number];
	receipt?: { status: "queued" | "applied"; messageId?: string; recipient?: string; seq?: number };
	events?: TeamEvent[];
	snapshot?: TeamSnapshot;
	error?: string;
}

export interface TeamOutcome {
	status: "completed" | "failed" | "cancelled";
	output: string;
	error?: string;
}

/** In-process adapter; callbacks and capabilities are never persisted. */
export interface TeamWorkerChannel {
	binding: TeamBinding;
	onRequest(request: TeamRequest, signal?: AbortSignal): Promise<TeamReply>;
}

export interface TeamDispatchChannel extends TeamWorkerChannel {
	/** Called after real native settlement, within the same broker operation. */
	afterRun?(run: import("./session-broker").WorkerRunResult, signal?: AbortSignal): Promise<string | undefined>;
	/** True once the member passed a team gate, i.e. its model may have acted. */
	started?(): boolean;
}

export type TeamCommand =
	| { version: 1; commandId: string; operation: "bind"; binding: TeamBinding }
	| { version: 1; commandId: string; operation: "reply"; binding: TeamBinding; requestId: string; reply: TeamReply }
	| { version: 1; commandId: string; operation: "unbind"; binding: TeamBinding };

export type TeamWireEvent =
	| { version: 1; kind: "request"; binding: TeamBinding; request: TeamRequest }
	| { version: 1; kind: "ack"; commandId: string; binding: TeamBinding; ok: boolean; error?: string };

export function sameTeamBinding(left: TeamBinding, right: TeamBinding): boolean {
	return left.version === right.version && left.teamId === right.teamId && left.memberId === right.memberId
		&& left.epoch === right.epoch && left.role === right.role;
}

export function isTeamBinding(value: unknown): value is TeamBinding {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const item = value as Record<string, unknown>;
	return item["version"] === TEAM_PROTOCOL_VERSION
		&& typeof item["teamId"] === "string" && item["teamId"].length > 0 && item["teamId"].length <= 128
		&& typeof item["memberId"] === "string" && item["memberId"].length > 0 && item["memberId"].length <= 64
		&& typeof item["epoch"] === "string" && item["epoch"].length > 0 && item["epoch"].length <= 128
		&& (item["role"] === "coordinator" || item["role"] === "worker");
}

function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function boundedText(value: unknown, maxBytes = TEAM_MAX_TEXT_BYTES): value is string {
	return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function boundedStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length <= TEAM_MAX_RESULT_ITEMS && value.every((item) => boundedText(item));
}

export function isTeamTaskResult(value: unknown): value is TeamTaskResult {
	if (!record(value) || !onlyKeys(value, ["status", "summary", "findings", "evidence", "limitations", "artifacts"])) return false;
	if (!["succeeded", "partial", "blocked", "failed"].includes(String(value["status"])) || !boundedText(value["summary"])) return false;
	for (const key of ["findings", "limitations", "artifacts"] as const) {
		if (value[key] !== undefined && !boundedStringArray(value[key])) return false;
	}
	if (value["evidence"] !== undefined) {
		if (!Array.isArray(value["evidence"]) || value["evidence"].length > TEAM_MAX_RESULT_ITEMS) return false;
		for (const item of value["evidence"]) {
			if (!record(item) || !onlyKeys(item, ["source", "locator", "basis"]) || !boundedText(item["source"])
				|| (item["locator"] !== undefined && !boundedText(item["locator"]))
				|| !["observed", "verified", "inferred", "unverified"].includes(String(item["basis"]))) return false;
		}
	}
	const json = JSON.stringify(value);
	return json !== undefined && Buffer.byteLength(json, "utf8") <= TEAM_MAX_TASK_RESULT_BYTES;
}

export function isTeamBrief(value: unknown): value is TeamBrief {
	if (!record(value) || !onlyKeys(value, ["goal", "target", "acceptanceCriteria", "constraints", "authorizations"])
		|| !boundedText(value["goal"])) return false;
	if (value["target"] !== undefined && !boundedText(value["target"])) return false;
	for (const key of ["acceptanceCriteria", "constraints"] as const) {
		if (value[key] !== undefined && !boundedStringArray(value[key])) return false;
	}
	if (value["authorizations"] !== undefined) {
		const authorizations = value["authorizations"];
		if (!Array.isArray(authorizations) || authorizations.length > TEAM_MAX_BRIEF_AUTHORIZATIONS) return false;
		for (const item of authorizations) {
			if (!record(item) || !onlyKeys(item, ["member", "allowed", "forbidden"])
				|| !boundedText(item["member"], 64) || !boundedStringArray(item["allowed"])
				|| (item["forbidden"] !== undefined && !boundedStringArray(item["forbidden"]))) return false;
		}
	}
	const json = JSON.stringify(value);
	return json !== undefined && Buffer.byteLength(json, "utf8") <= TEAM_MAX_BRIEF_BYTES;
}

export function isTeamAssignment(value: unknown): value is TeamAssignment {
	if (!record(value) || !onlyKeys(value, ["memberId", "task", "cwd", "model", "fastMode", "searchMode"])
		|| !boundedText(value["memberId"], 64) || !boundedText(value["task"])) return false;
	for (const key of ["cwd", "model", "searchMode"] as const) {
		if (value[key] !== undefined && !boundedText(value[key])) return false;
	}
	if (value["fastMode"] !== undefined && typeof value["fastMode"] !== "boolean") return false;
	const json = JSON.stringify(value);
	return json !== undefined && Buffer.byteLength(json, "utf8") <= TEAM_MAX_ASSIGNMENT_BYTES;
}

/** A public team message id: `<teamId>:<seq>`. */
export function isTeamMessageReference(value: unknown): value is string {
	return typeof value === "string" && value.length <= 256 && /^[A-Za-z0-9._-]{1,128}:\d+$/u.test(value);
}

export function isTeamRequest(value: unknown): value is TeamRequest {
	if (!record(value)) return false;
	const item = value;
	if (typeof item["requestId"] !== "string" || !item["requestId"] || item["requestId"].length > 128
		|| !Number.isSafeInteger(item["sequence"]) || (item["sequence"] as number) < 1
		|| !["checkpoint", "send", "report", "wait", "control", "finish"].includes(String(item["action"]))) return false;
	if (item["receive"] !== undefined && (typeof item["receive"] !== "boolean" || item["action"] !== "checkpoint")) return false;
	if (item["revision"] !== undefined && (!Number.isSafeInteger(item["revision"]) || (item["revision"] as number) < 0 || item["action"] !== "checkpoint")) return false;
	if (item["to"] !== undefined && (typeof item["to"] !== "string" || item["to"].length > 64)) return false;
	if (item["message"] !== undefined && (typeof item["message"] !== "string" || Buffer.byteLength(item["message"], "utf8") > TEAM_MAX_MESSAGE_BYTES)) return false;
	if (item["command"] !== undefined && !(TEAM_CONTROL_COMMANDS as readonly string[]).includes(String(item["command"]))) return false;
	if (item["replyTo"] !== undefined && (!isTeamMessageReference(item["replyTo"]) || !["send", "report"].includes(String(item["action"])))) return false;
	if (item["supersedes"] !== undefined && (!isTeamMessageReference(item["supersedes"]) || !["send", "report"].includes(String(item["action"])))) return false;
	if (item["result"] !== undefined && (item["action"] !== "finish" || !isTeamTaskResult(item["result"]))) return false;
	if (item["action"] === "finish" && item["message"] !== undefined && item["result"] !== undefined) return false;
	if (item["message"] !== undefined && (typeof item["message"] !== "string" || !item["message"].trim())) return false;
	if (item["wait"] !== undefined) {
		if (!record(item["wait"])) return false;
		const wait = item["wait"];
		if (!["message", "member", "workers"].includes(String(wait["kind"]))) return false;
		if (wait["member"] !== undefined && (typeof wait["member"] !== "string" || !wait["member"].trim() || wait["member"].length > 64 || wait["kind"] !== "member")) return false;
		if (wait["afterSeq"] !== undefined && (!Number.isSafeInteger(wait["afterSeq"]) || (wait["afterSeq"] as number) < 0 || wait["kind"] !== "message")) return false;
		if (wait["from"] !== undefined && (typeof wait["from"] !== "string" || !wait["from"].trim() || wait["from"].length > 64 || wait["kind"] !== "message")) return false;
	}
	switch (item["action"]) {
		case "checkpoint": return item["to"] === undefined && item["message"] === undefined && item["replyTo"] === undefined
			&& item["supersedes"] === undefined && item["result"] === undefined && item["wait"] === undefined && item["command"] === undefined;
		case "send": return typeof item["to"] === "string" && !!item["to"] && typeof item["message"] === "string"
			&& item["wait"] === undefined && item["command"] === undefined && item["result"] === undefined;
		case "report": return typeof item["message"] === "string" && item["command"] === undefined && item["result"] === undefined;
		case "wait": return item["wait"] !== undefined && item["to"] === undefined && item["message"] === undefined
			&& item["replyTo"] === undefined && item["supersedes"] === undefined && item["result"] === undefined && item["command"] === undefined;
		case "control": return typeof item["to"] === "string" && !!item["to"] && typeof item["command"] === "string"
			&& item["wait"] === undefined && item["replyTo"] === undefined && item["supersedes"] === undefined && item["result"] === undefined
			// redirect requires a direction; cancel accepts an optional reason.
			&& (item["command"] === "redirect" ? typeof item["message"] === "string" : item["command"] === "cancel" || item["message"] === undefined);
		case "finish": return item["to"] === undefined && item["wait"] === undefined && item["command"] === undefined
			&& item["replyTo"] === undefined && item["supersedes"] === undefined;
	}
	return false;
}
