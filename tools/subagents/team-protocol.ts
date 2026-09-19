import { fileURLToPath } from "node:url";

export const TEAM_PROTOCOL_VERSION = 1 as const;
export const TEAM_COMMAND = "rail-subagent-team-protocol";
export const TEAM_ENTRY_TYPE = "rail-subagent-team-protocol";
export const TEAM_HISTORY_TYPE = "rail-subagent-team";
export const TEAM_MAX_MESSAGE_BYTES = 8 * 1024;
export const TEAM_MAX_EVENTS = 64;
export const TEAM_MAX_WORKERS = 8;

export function teamExtensionPath(): string {
	return fileURLToPath(new URL("./team-extension.ts", import.meta.url));
}

export type TeamRole = "coordinator" | "worker";
export type TeamMemberState = "registered" | "starting" | "running" | "waiting" | "pause_requested" | "paused" | "finalizing" | "completed" | "failed" | "cancelled";
export type TeamPhase = "prepared" | "running" | "finalizing" | "completed" | "failed" | "cancelled" | "interrupted";

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
	afterSeq?: number;
}

export interface TeamRequest {
	requestId: string;
	sequence: number;
	action: "checkpoint" | "send" | "report" | "wait" | "control" | "finish";
	/** Only the native context gate may consume inbox messages into model context. */
	receive?: boolean;
	to?: string;
	message?: string;
	wait?: TeamWait;
	command?: "pause" | "resume" | "redirect";
}

export interface TeamEvent {
	seq: number;
	kind: "message" | "report" | "state" | "result" | "control" | "cancelled";
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
}

export interface TeamSnapshot {
	id: string;
	coordinator: string;
	workers: string[];
	phase: TeamPhase;
	seq: number;
	createdAt: number;
	deadline: number;
	members: TeamMemberSnapshot[];
	events: TeamEvent[];
}

export interface TeamReply {
	ok: boolean;
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

export function isTeamRequest(value: unknown): value is TeamRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const item = value as Record<string, unknown>;
	if (typeof item["requestId"] !== "string" || !item["requestId"] || item["requestId"].length > 128
		|| !Number.isSafeInteger(item["sequence"]) || (item["sequence"] as number) < 1
		|| !["checkpoint", "send", "report", "wait", "control", "finish"].includes(String(item["action"]))) return false;
	if (item["receive"] !== undefined && (typeof item["receive"] !== "boolean" || item["action"] !== "checkpoint")) return false;
	if (item["to"] !== undefined && (typeof item["to"] !== "string" || item["to"].length > 64)) return false;
	if (item["message"] !== undefined && (typeof item["message"] !== "string" || Buffer.byteLength(item["message"], "utf8") > TEAM_MAX_MESSAGE_BYTES)) return false;
	if (item["command"] !== undefined && !["pause", "resume", "redirect"].includes(String(item["command"]))) return false;
	if (item["wait"] !== undefined) {
		if (!item["wait"] || typeof item["wait"] !== "object" || Array.isArray(item["wait"])) return false;
		const wait = item["wait"] as Record<string, unknown>;
		if (!["message", "member", "workers"].includes(String(wait["kind"]))) return false;
		if (wait["member"] !== undefined && (typeof wait["member"] !== "string" || wait["member"].length > 64)) return false;
		if (wait["afterSeq"] !== undefined && (!Number.isSafeInteger(wait["afterSeq"]) || (wait["afterSeq"] as number) < 0)) return false;
	}
	return true;
}
