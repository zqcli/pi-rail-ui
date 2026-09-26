import { TEAM_JOURNAL_ENTRY_TYPE } from "./team-journal";
import {
	TEAM_MAX_RESERVED_RESULT_BYTES, TEAM_MAX_WORKERS,
	type ResultRecord, type TeamLifecycle, type TeamOutcome, type TeamResult, type WorkRef,
} from "./team-protocol";
import {
	canonicalJson, jsonBytes, jsonTextBytes, normalizeAlias, normalizeId, normalizeResultRecord, normalizeTeamBudgetGrantRecord,
	normalizeTeamResult, normalizeTeamResultRoots, normalizeWorkRef,
} from "./team-codec";

/** Custom-entry type of retired v1 Team snapshots; only read, never written. */
export const LEGACY_TEAM_HISTORY_TYPE = "rail-subagent-team";

const LEGACY_TERMINAL = ["completed", "failed", "cancelled", "interrupted"] as const;
/** Retired v1 phases that had no terminal record; they are displayed as interrupted, never resumed. */
const LEGACY_UNFINISHED = ["prepared", "running", "finalizing"] as const;
const MAX_HISTORY_RESULTS = 16_384;

/**
 * Display-only history of one Team on the current branch. Nothing here can be resumed: a Team whose
 * terminal record is missing or invalid is shown as interrupted, and no member, gate or work is revived.
 */
export interface TeamHistoryEntry {
	teamId: string;
	version: 1 | 2;
	lifecycle: TeamLifecycle | "completed";
	outcome?: TeamOutcome;
	reason?: string;
	manager?: string;
	workers: string[];
	goal?: string;
	results: ResultRecord[];
	finalResultRefs: string[];
	at: number;
}

export interface TeamHistory {
	teams: TeamHistoryEntry[];
	/** Malformed entries skipped with a diagnostic count; they never disable new Teams. */
	skipped: number;
}

type BranchEntry = { type: string; customType?: string; data?: unknown };
type CloseDecisionHistory = { closeId: string; outcome: TeamOutcome; resultRefs: string[]; roots: TeamResult["roots"]; reason?: string };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function restoreTeamHistory(entries: readonly BranchEntry[]): TeamHistory {
	const teams = new Map<string, TeamHistoryEntry>();
	const results = new Map<string, Map<string, ResultRecord>>();
	const resultBytes = new Map<string, number>();
	const closeDecisions = new Map<string, CloseDecisionHistory>();
	const ended = new Set<string>();
	let skipped = 0;
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		try {
			if (entry.customType === TEAM_JOURNAL_ENTRY_TYPE) {
				if (!applyJournalRecord(teams, results, resultBytes, closeDecisions, ended, entry.data)) skipped++;
			} else if (entry.customType === LEGACY_TEAM_HISTORY_TYPE) {
				if (!applyLegacySnapshot(teams, entry.data)) skipped++;
			}
		} catch {
			// One damaged record is diagnostic only; it never prevents other history or live Teams.
			skipped++;
		}
	}
	return { teams: [...teams.values()], skipped };
}

function applyJournalRecord(
	teams: Map<string, TeamHistoryEntry>,
	resultsByTeam: Map<string, Map<string, ResultRecord>>,
	resultBytesByTeam: Map<string, number>,
	closeByTeam: Map<string, CloseDecisionHistory>,
	ended: Set<string>,
	data: unknown,
): boolean {
	if (!isRecord(data) || data["version"] !== 2 || !validTime(data["at"])) return false;
	const kind = data["kind"];
	const teamId = normalizeId(data["teamId"], "journal.teamId");
	const at = data["at"] as number;
	const current = teams.get(teamId);
	switch (kind) {
		case "launched": {
			onlyKeys(data, ["version", "kind", "teamId", "at", "roster", "goal"]);
			if (current) return false;
			const roster = data["roster"];
			if (!isRecord(roster)) return false;
			onlyKeys(roster, ["manager", "workers"]);
			const manager = normalizeAlias(roster["manager"], "journal.roster.manager");
			const workers = parseAliases(roster["workers"]);
			if (workers.length < 1 || workers.length > TEAM_MAX_WORKERS || new Set([manager, ...workers]).size !== workers.length + 1) return false;
			const goal = boundedText(data["goal"], 512, "journal.goal");
			teams.set(teamId, { teamId, version: 2, lifecycle: "interrupted", manager, workers, goal, results: [], finalResultRefs: [], at });
			resultsByTeam.set(teamId, new Map());
			resultBytesByTeam.set(teamId, 0);
			return true;
		}
		case "interrupted": {
			onlyKeys(data, ["version", "kind", "teamId", "at", "reason"]);
			if (!current || current.version !== 2) return false;
			// A previously validated terminal fact is stronger than a later shutdown marker.
			if (ended.has(teamId)) return true;
			current.lifecycle = "interrupted";
			current.reason = boundedText(data["reason"], 4096, "journal.interrupted.reason");
			current.at = at;
			ended.add(teamId);
			return true;
		}
		case "result": {
			onlyKeys(data, ["version", "kind", "teamId", "at", "result"]);
			if (!current || current.version !== 2 || ended.has(teamId)) return false;
			const result = normalizeResultRecord(data["result"]);
			if (![current.manager, ...current.workers].includes(result.author)) return false;
			const records = resultsByTeam.get(teamId)!;
			const bytes = jsonBytes(result);
			if (records.has(result.id) || current.results.length >= MAX_HISTORY_RESULTS
				|| resultBytesByTeam.get(teamId)! + bytes > TEAM_MAX_RESERVED_RESULT_BYTES) return false;
			records.set(result.id, result);
			resultBytesByTeam.set(teamId, resultBytesByTeam.get(teamId)! + bytes);
			current.results.push(result);
			return true;
		}
		case "decision": {
			onlyKeys(data, ["version", "kind", "teamId", "at", "decision", "work", "reason"]);
			if (!current || current.version !== 2 || ended.has(teamId)
				|| (data["decision"] !== "revise_work" && data["decision"] !== "cancel_work")) return false;
			normalizeWorkRef(data["work"], "journal.decision.work");
			if (data["reason"] !== undefined) boundedText(data["reason"], 4096, "journal.decision.reason");
			return true;
		}
		case "close_decision": {
			onlyKeys(data, ["version", "kind", "teamId", "at", "closeId", "outcome", "resultRefs", "roots", "reason"]);
			if (!current || current.version !== 2 || ended.has(teamId) || closeByTeam.has(teamId)) return false;
			const closeId = normalizeId(data["closeId"], "journal.close_decision.closeId");
			const outcome = parseOutcome(data["outcome"]);
			const resultRefs = parseIds(data["resultRefs"], "journal.close_decision.resultRefs");
			const knownResults = resultsByTeam.get(teamId)!;
			if (resultRefs.some((ref) => !knownResults.has(ref))) return false;
			const roots = parseRoots(data["roots"]);
			if (!rootsMatchResults(roots, knownResults)) return false;
			const reason = data["reason"] === undefined ? undefined : boundedText(data["reason"], 4096, "journal.close_decision.reason");
			if (!validCloseOutcome(outcome, roots, resultRefs, knownResults, reason)) return false;
			closeByTeam.set(teamId, { closeId, outcome, resultRefs, roots, ...(reason !== undefined ? { reason } : {}) });
			return true;
		}
		case "grant": {
			onlyKeys(data, ["version", "kind", "teamId", "at", "grant"]);
			if (!current || current.version !== 2 || ended.has(teamId)) return false;
			normalizeTeamBudgetGrantRecord(data["grant"], "journal.grant");
			return true;
		}
		case "terminal": {
			onlyKeys(data, ["version", "kind", "teamId", "at", "closeId", "result"]);
			if (!current || current.version !== 2 || ended.has(teamId)) return false;
			const close = closeByTeam.get(teamId);
			const closeId = data["closeId"] === undefined ? undefined : normalizeId(data["closeId"], "journal.terminal.closeId");
			if ((close && closeId !== close.closeId) || (!close && closeId !== undefined)) return false;
			const result = parseTeamResult(data["result"]);
			if (result.teamId !== teamId || !terminalMatchesHistory(result, current, resultsByTeam.get(teamId)!, close)) return false;
			current.lifecycle = result.lifecycle;
			if (result.outcome) current.outcome = result.outcome;
			if (result.reason) current.reason = result.reason;
			current.finalResultRefs = result.finalResultRefs;
			current.at = at;
			ended.add(teamId);
			return true;
		}
		default:
			return false;
	}
}

function terminalMatchesHistory(result: TeamResult, history: TeamHistoryEntry, results: Map<string, ResultRecord>, close: CloseDecisionHistory | undefined): boolean {
	if (![history.manager, ...history.workers].includes(result.members.find((member) => member.role === "manager")?.id ?? "")) return false;
	if (result.members.length !== history.workers.length + 1) return false;
	const roster = new Map([[history.manager!, "manager" as const], ...history.workers.map((worker) => [worker, "worker" as const] as const)]);
	if (result.members.some((member) => roster.get(member.id) !== member.role)) return false;
	if (result.finalResultRefs.some((ref) => !results.has(ref))) return false;
	if (!rootsMatchResults(result.roots, results)) return false;
	if (result.lifecycle === "closed") {
		if (!close || result.outcome !== close.outcome || !sameStrings(result.finalResultRefs, close.resultRefs)
			|| canonicalJson(result.roots) !== canonicalJson(close.roots) || result.reason !== close.reason
			|| result.outcome === undefined
			|| result.members.some((member) => member.resourceState !== "released"
				|| (member.role === "manager" ? member.lifecycle !== "closed" : member.lifecycle !== "closed" && member.lifecycle !== "faulted"))) return false;
		return true;
	}
	if (close) {
		if (result.lifecycle !== "failed" || result.outcome !== close.outcome || !sameStrings(result.finalResultRefs, close.resultRefs)
			|| canonicalJson(result.roots) !== canonicalJson(close.roots) || !result.reason) return false;
	} else if (result.finalResultRefs.length || result.outcome !== undefined) return false;
	return Boolean(result.reason);
}

function parseTeamResult(value: unknown): TeamResult {
	return normalizeTeamResult(value);
}

function parseRoots(value: unknown): TeamResult["roots"] {
	return normalizeTeamResultRoots(value, "journal roots");
}







function rootsMatchResults(roots: TeamResult["roots"], results: Map<string, ResultRecord>): boolean {
	const seen = new Set<string>();
	for (const root of roots) {
		if (seen.has(root.work.workId)) return false;
		seen.add(root.work.workId);
		const record = root.resultRef ? results.get(root.resultRef) : undefined;
		if (root.resultRef && (!record || !sameWork(record.work, root.work))) return false;
		if (root.review?.disposition === "accepted" && (root.state !== "resolved" || !record || record.result.status !== "succeeded")) return false;
	}
	return true;
}

function validCloseOutcome(outcome: TeamOutcome, roots: TeamResult["roots"], refs: string[], results: Map<string, ResultRecord>, reason?: string): boolean {
	if (roots.some((root) => !root.review)) return false;
	if (outcome === "succeeded") return refs.length > 0 && roots.every((root) => root.state === "resolved" && root.review?.disposition === "accepted"
		&& !!root.resultRef && results.get(root.resultRef)?.result.status === "succeeded");
	if (outcome === "partial") return !!reason && refs.length > 0;
	return !!reason;
}

function parseAliases(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > TEAM_MAX_WORKERS) throw new Error("journal roster workers are invalid");
	return value.map((item, index) => normalizeAlias(item, `journal.roster.workers[${index}]`));
}

function parseIds(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.length > MAX_HISTORY_RESULTS) throw new Error(`${field} is invalid or exceeds capacity`);
	const ids = value.map((item, index) => normalizeId(item, `${field}[${index}]`));
	if (new Set(ids).size !== ids.length) throw new Error(`${field} contains duplicates`);
	return ids;
}

function parseOutcome(value: unknown): TeamOutcome {
	if (value !== "succeeded" && value !== "partial" && value !== "failed") throw new Error("Team outcome is invalid");
	return value;
}

function boundedText(value: unknown, max: number, field: string): string {
	if (typeof value !== "string" || !value.isWellFormed() || !value.trim() || jsonTextBytes(value) > max) throw new Error(`${field} is invalid or exceeds ${max} UTF-8 bytes`);
	return value;
}

function validTime(value: unknown): boolean { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function sameStrings(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((item, index) => item === right[index]); }
function sameWork(left: WorkRef, right: WorkRef): boolean { return left.workId === right.workId && left.revision === right.revision; }
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
	if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("history record has unsupported fields");
}

/** Read-only mapping of the retired v1 snapshot; unfinished runs never become live. */
function applyLegacySnapshot(teams: Map<string, TeamHistoryEntry>, data: unknown): boolean {
	if (!isRecord(data)) return false;
	const teamId = typeof data["id"] === "string" ? normalizeId(data["id"], "legacy.teamId") : undefined;
	const manager = typeof data["coordinator"] === "string" ? normalizeAlias(data["coordinator"], "legacy.coordinator") : undefined;
	const rawWorkers = data["workers"];
	const phase = data["phase"];
	if (!teamId || !manager || !Array.isArray(rawWorkers) || typeof phase !== "string") return false;
	const existing = teams.get(teamId);
	if (existing && existing.version !== 1) return false;
	if (!(LEGACY_TERMINAL as readonly string[]).includes(phase) && !(LEGACY_UNFINISHED as readonly string[]).includes(phase)) return false;
	const workers = rawWorkers.map((item, index) => normalizeAlias(item, `legacy.workers[${index}]`));
	if (workers.length < 1 || workers.length > TEAM_MAX_WORKERS || new Set([manager, ...workers]).size !== workers.length + 1) return false;
	teams.set(teamId, {
		teamId, version: 1, manager, workers,
		lifecycle: (LEGACY_TERMINAL as readonly string[]).includes(phase) ? phase as TeamHistoryEntry["lifecycle"] : "interrupted",
		results: [], finalResultRefs: [], at: validTime(data["createdAt"]) ? data["createdAt"] as number : 0,
	});
	return true;
}
