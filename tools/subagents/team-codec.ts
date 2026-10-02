/**
 * Team v2 codec: public action normalization, private frame validation, size limits and
 * public projections. Shape and size only — state, ownership, versions and budgets are
 * checked by TeamRuntime. Must not depend on the runtime, RPC transport or extension install code.
 */
import { Type } from "typebox";
import { prompt } from "../../core/prompts";
import { isValidAgentAlias } from "./identity";
import {
	TEAM_ERROR_CODES, TEAM_MAX_ACTIVATION_INPUT_BYTES, TEAM_MAX_ALIAS_LENGTH, TEAM_MAX_BRIEF_BYTES, TEAM_MAX_FRAME_BYTES,
	TEAM_MAX_ACTION_BYTES, TEAM_MAX_PUBLIC_CHILDREN, TEAM_MAX_OWNED_CHILD_PREVIEWS,
	TEAM_MAX_CHILD_ISSUES, TEAM_MAX_CHILD_ISSUE_MESSAGE_BYTES,
	TEAM_MAX_ID_LENGTH, TEAM_MAX_INITIAL_REQUESTS, TEAM_MAX_INPUT_REFS, TEAM_MAX_MEMBERS, TEAM_MAX_NOTE_BYTES,
	TEAM_MAX_EVENT_MESSAGE_BYTES, TEAM_MAX_RESULT_BYTES, TEAM_MAX_RESULT_ITEMS, TEAM_MAX_ROLE_BYTES, TEAM_MAX_TASK_BYTES, TEAM_MAX_DELIVERED_TASK_BYTES, TEAM_MAX_TEXT_ITEM_BYTES,
	TEAM_MAX_DEPENDENCY_PREVIEW_BYTES, TEAM_MAX_DEPENDENCY_PREVIEWS, TEAM_MAX_TERMINAL_INCIDENTS,
	TEAM_MAX_TIMEOUT_SECONDS, TEAM_MAX_WAITING_FOR, TEAM_MAX_TOOL_NAMES, TEAM_MIN_MEMBERS, TEAM_MAX_DELIVERED_OUTCOMES, TEAM_MAX_EVENT_BATCH,
	TEAM_PROTOCOL_VERSION, TEAM_STATUS_DEFAULT_LIMIT,
	TEAM_STATUS_MAX_LIMIT, TEAM_BUDGET_PRESETS, TEAM_MAX_RESULT_RECORDS, TEAM_VIEW_MAX_BUDGET_ROOTS, TEAM_VIEW_MAX_GRANTS, TEAM_VIEW_MAX_INCIDENTS, DEFAULT_TEAM_BUDGET, WORK_STATES, sameWorkRef, workRefKey, ROOT_GRANTABLE_COUNTERS, TEAM_GRANTABLE_COUNTERS,
	TEAM_EVENT_KINDS, TEAM_MAX_REVIEW_MINUTES, TEAM_MAX_REVIEW_FOCUS_BYTES, REVIEW_VERDICTS,
	type ActivationInput, type ActivationScope, type BindingV2, type ChildFrame, type ChildIssue, type GateDecision, type ParentCommand,
	type Health, type HoldReason, type MemberActivity, type MemberLifecycle, type TeamEventView, type OutcomeView, type PauseState, type PrivateAction,
	type PrivateReply, type ResourceState, type TeamAction, type TeamBrief, type TeamControl, type TeamError,
	type TeamBudgetLimits, type TeamErrorCode, type TeamEvidence, type TeamIncidentView, type TeamMemberPlan,
	type TeamBudgetPreset, type TeamMemberPolicy, type TeamMemberView, type TeamPlan, type TeamReceipt, type TeamReply, type TeamReplyData,
	type TeamStatusPage, type TeamTeamView, type TeamWorkSummary, type TeamWorkView, type MemberRecord, type ResultRecord,
	type WorkError, type WorkRef, type WorkResult, type WorkState, type WorkVersion, type TeamBudgetGrantView, type TeamRootBudgetView,
	type TeamResult, type TeamReviewPlan, type TeamReviewRecord,
} from "./team-protocol";
import type { SubagentUsage } from "./session-broker";

/** A structured, model-correctable failure. `code` is always one of TEAM_ERROR_CODES. */
export class TeamProtocolError extends Error {
	override readonly name = "TeamProtocolError";
	constructor(readonly code: TeamErrorCode, message: string, readonly blockers?: TeamError["blockers"]) { super(message); }
	toTeamError(): TeamError {
		return { code: this.code, message: this.message, ...(this.blockers?.length ? { blockers: this.blockers } : {}) };
	}
}

const invalid = (message: string): never => { throw new TeamProtocolError("INVALID_ARGUMENT", message); };
const protocol = (message: string): never => { throw new TeamProtocolError("PROTOCOL_FAILURE", message); };

export function jsonBytes(value: unknown): number {
	assertJsonValue(value, new Set());
	const json = JSON.stringify(value);
	if (json === undefined) throw new TeamProtocolError("INVALID_ARGUMENT", "Value is not JSON-serializable");
	return Buffer.byteLength(json, "utf8");
}

function assertJsonValue(value: unknown, ancestors: Set<object>): void {
	if (value === null || typeof value === "boolean") return;
	if (typeof value === "string") {
		if (!value.isWellFormed()) throw new TeamProtocolError("INVALID_ARGUMENT", "JSON text must be valid UTF-8");
		return;
	}
	if (typeof value === "number") {
		if (Number.isFinite(value)) return;
		throw new TeamProtocolError("INVALID_ARGUMENT", "JSON numbers must be finite");
	}
	if (Array.isArray(value)) {
		if (Object.getPrototypeOf(value) !== Array.prototype) throw new TeamProtocolError("INVALID_ARGUMENT", "JSON arrays must use the standard array prototype");
		if (ancestors.has(value)) throw new TeamProtocolError("INVALID_ARGUMENT", "JSON value must not be cyclic");
		ancestors.add(value);
		for (const key of Reflect.ownKeys(value)) {
			if (key === "length") continue;
			if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) {
				throw new TeamProtocolError("INVALID_ARGUMENT", "JSON arrays may contain only indexed elements");
			}
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || !("value" in descriptor)) throw new TeamProtocolError("INVALID_ARGUMENT", "JSON arrays may contain only enumerable data elements");
			assertJsonValue(descriptor.value, ancestors);
		}
		if (Object.keys(value).length !== value.length) throw new TeamProtocolError("INVALID_ARGUMENT", "JSON arrays may not contain holes");
		ancestors.delete(value);
		return;
	}
	if (isRecord(value)) {
		if (ancestors.has(value)) throw new TeamProtocolError("INVALID_ARGUMENT", "JSON value must not be cyclic");
		ancestors.add(value);
		for (const key of Reflect.ownKeys(value)) {
			const descriptor = typeof key === "string" ? Object.getOwnPropertyDescriptor(value, key) : undefined;
			if (typeof key !== "string" || !key.isWellFormed() || !descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
				throw new TeamProtocolError("INVALID_ARGUMENT", "JSON objects may contain only string keys with defined values");
			}
			assertJsonValue(descriptor.value, ancestors);
		}
		ancestors.delete(value);
		return;
	}
	throw new TeamProtocolError("INVALID_ARGUMENT", "Value is not JSON-serializable");
}

/** UTF-8 bytes of a string's JSON-escaped content (excluding quotes); always >= its raw UTF-8 size. */
export function jsonTextBytes(value: string): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** Stable-key JSON for fingerprints: the same logical request always hashes the same. */
export function canonicalJson(value: unknown): string {
	assertJsonValue(value, new Set());
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

const TRUNCATED = "…";
/** Bounded one-line preview that never splits a Unicode character; JSON escaping counts. */
export function previewText(value: string, maxBytes: number): string {
	const plain = value.replace(/\s+/gu, " ").trim();
	if (jsonTextBytes(plain) <= maxBytes) return plain;
	let result = "";
	let bytes = jsonTextBytes(TRUNCATED);
	for (const character of plain) {
		const size = jsonTextBytes(character);
		if (bytes + size > maxBytes) break;
		bytes += size;
		result += character;
	}
	return result + TRUNCATED;
}

/** A complete member result as text: summary, findings, evidence, limitations and artifacts. */
export function formatWorkResult(result: WorkResult): string {
	return [
		result.summary,
		...(result.findings?.length ? ["Findings:", ...result.findings.map((item) => `- ${item}`)] : []),
		...(result.evidence?.length ? ["Evidence:", ...result.evidence.map((item) => `- ${item.basis}: ${item.source}${item.locator ? ` (${item.locator})` : ""}`)] : []),
		...(result.limitations?.length ? ["Limitations:", ...result.limitations.map((item) => `- ${item}`)] : []),
		...(result.artifacts?.length ? ["Artifacts:", ...result.artifacts.map((item) => `- ${item}`)] : []),
	].join("\n");
}

/** Truncate (keeping line structure) to a JSON-content byte budget; returns whether it was cut. */
export function truncateText(value: string, maxBytes: number): { text: string; truncated: boolean } {
	if (jsonTextBytes(value) <= maxBytes) return { text: value, truncated: false };
	const marker = "\n[truncated]";
	let result = "";
	let bytes = jsonTextBytes(marker);
	for (const character of value) {
		const size = jsonTextBytes(character);
		if (bytes + size > maxBytes) break;
		bytes += size;
		result += character;
	}
	return { text: result + marker, truncated: true };
}

/** Host/provider diagnostics are output, not model arguments. Repair Unicode and mark truncation. */
export function projectErrorText(value: string, maxBytes = TEAM_MAX_NOTE_BYTES): string {
	const wellFormed = value.toWellFormed();
	return truncateText(wellFormed.trim() ? wellFormed : "Unspecified error", maxBytes).text;
}

/** Keep the classification and uncertainty flag while bounding public diagnostic text. */
export function projectWorkError(error: WorkError): WorkError {
	return { code: projectErrorText(error.code, 128), message: projectErrorText(error.message),
		...(error.outcomeUnknown !== undefined ? { outcomeUnknown: error.outcomeUnknown } : {}) };
}

/** A projection only: callers must continue using the ledger for all child obligations. */
export function projectOwnedChildren(children: ActivationInput["ownedChildren"]): Pick<ActivationInput, "ownedChildren" | "ownedChildrenOmitted"> {
	return { ownedChildren: children.slice(0, TEAM_MAX_OWNED_CHILD_PREVIEWS).map(({ work, state }) => ({ work: { ...work }, state })),
		ownedChildrenOmitted: Math.max(0, children.length - TEAM_MAX_OWNED_CHILD_PREVIEWS) };
}

export function projectWorkChildren(children: readonly WorkRef[]): Pick<TeamWorkView, "children" | "childrenOmitted"> {
	return { children: children.slice(0, TEAM_MAX_PUBLIC_CHILDREN).map((work) => ({ ...work })),
		childrenOmitted: Math.max(0, children.length - TEAM_MAX_PUBLIC_CHILDREN) };
}

function text(value: unknown, field: string, maxBytes: number): string {
	if (typeof value !== "string") return invalid(`${field} must be a string`);
	if (!value.isWellFormed()) return invalid(`${field} is not valid UTF-8 text`);
	if (!value.trim()) return invalid(`${field} must not be empty`);
	if (jsonTextBytes(value) > maxBytes) return invalid(`${field} exceeds ${maxBytes} UTF-8 bytes (JSON-escaped)`);
	return value;
}

function optionalText(value: unknown, field: string, maxBytes: number): string | undefined {
	return value === undefined || value === null ? undefined : text(value, field, maxBytes);
}

export function normalizeAlias(value: unknown, field: string): string {
	if (typeof value !== "string" || !isValidAgentAlias(value) || value.length > TEAM_MAX_ALIAS_LENGTH) {
		return invalid(`${field} must be a member alias of 1-64 letters, digits, dot, underscore or hyphen`);
	}
	return value;
}

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
export function normalizeId(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length < 1 || value.length > TEAM_MAX_ID_LENGTH || !OPAQUE_ID.test(value)) {
		return invalid(`${field} must be an id returned by the team runtime`);
	}
	return value;
}

/** Native provider tool-call IDs are opaque: preserve their exact text, with only bounded UTF-8 validation. */
export function normalizeNativeToolCallId(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()
		|| Buffer.byteLength(value, "utf8") > TEAM_MAX_ID_LENGTH || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
		return protocol(`${field} is not a valid opaque native tool-call id`);
	}
	return value;
}

function safeInteger(value: unknown, field: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
		return invalid(`${field} must be an integer from ${min} to ${max}`);
	}
	return value;
}

export function normalizeWorkRef(value: unknown, field: string): WorkRef {
	if (!isRecord(value)) return invalid(`${field} must be {workId, revision}`);
	const extra = Object.keys(value).filter((key) => key !== "workId" && key !== "revision");
	if (extra.length) return invalid(`${field} has unsupported field(s) ${extra.join(", ")}`);
	return { workId: normalizeId(value["workId"], `${field}.workId`), revision: safeInteger(value["revision"], `${field}.revision`, 1) };
}

function array(value: unknown, field: string, maxItems: number): unknown[] {
	if (!Array.isArray(value)) return invalid(`${field} must be an array`);
	if (value.length > maxItems) return invalid(`${field} supports at most ${maxItems} entries`);
	return value;
}

function textList(value: unknown, field: string, maxItems = TEAM_MAX_RESULT_ITEMS, maxBytes = TEAM_MAX_TEXT_ITEM_BYTES): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	return array(value, field, maxItems).map((item, index) => text(item, `${field}[${index}]`, maxBytes));
}

function idList(value: unknown, field: string, maxItems: number): string[] {
	if (value === undefined || value === null) return [];
	const ids = array(value, field, maxItems).map((item, index) => normalizeId(item, `${field}[${index}]`));
	if (new Set(ids).size !== ids.length) return invalid(`${field} contains duplicates`);
	return ids;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
	const extra = Object.keys(value).filter((key) => !allowed.includes(key));
	if (extra.length) invalid(`${field} has unsupported field(s) ${extra.join(", ")}`);
}

export function normalizeWorkResult(value: unknown, field = "result"): WorkResult {
	if (!isRecord(value)) return invalid(`${field} must be an object {status, summary, findings?, evidence?, limitations?, artifacts?}`);
	onlyKeys(value, ["status", "summary", "findings", "evidence", "limitations", "artifacts"], field);
	const status = value["status"];
	if (status !== "succeeded" && status !== "partial" && status !== "failed") return invalid(`${field}.status must be succeeded, partial or failed`);
	const result: WorkResult = { status, summary: text(value["summary"], `${field}.summary`, TEAM_MAX_TEXT_ITEM_BYTES) };
	for (const key of ["findings", "limitations", "artifacts"] as const) {
		const list = textList(value[key], `${field}.${key}`);
		if (list?.length) result[key] = list;
	}
	if (value["evidence"] !== undefined && value["evidence"] !== null) {
		const evidence = array(value["evidence"], `${field}.evidence`, TEAM_MAX_RESULT_ITEMS).map((raw, index): TeamEvidence => {
			const name = `${field}.evidence[${index}]`;
			if (!isRecord(raw)) return invalid(`${name} must be {source, locator?, basis}`);
			onlyKeys(raw, ["source", "locator", "basis"], name);
			const basis = raw["basis"];
			if (basis !== "observed" && basis !== "verified" && basis !== "inferred" && basis !== "unverified") {
				return invalid(`${name}.basis must be observed, verified, inferred or unverified`);
			}
			const locator = optionalText(raw["locator"], `${name}.locator`, TEAM_MAX_TEXT_ITEM_BYTES);
			return { source: text(raw["source"], `${name}.source`, TEAM_MAX_TEXT_ITEM_BYTES), ...(locator !== undefined ? { locator } : {}), basis };
		});
		if (evidence.length) result.evidence = evidence;
	}
	if (jsonBytes(result) > TEAM_MAX_RESULT_BYTES) return invalid(`${field} exceeds ${TEAM_MAX_RESULT_BYTES} serialized UTF-8 bytes`);
	return result;
}

export function normalizeBrief(value: unknown, roster: readonly string[]): TeamBrief {
	if (!isRecord(value)) return invalid("brief must be an object with at least goal");
	onlyKeys(value, ["goal", "target", "acceptanceCriteria", "constraints", "authorizations"], "brief");
	const brief: TeamBrief = { goal: text(value["goal"], "brief.goal", TEAM_MAX_TEXT_ITEM_BYTES).trim() };
	const target = optionalText(value["target"], "brief.target", TEAM_MAX_TEXT_ITEM_BYTES);
	if (target !== undefined) brief.target = target.trim();
	for (const key of ["acceptanceCriteria", "constraints"] as const) {
		const list = textList(value[key], `brief.${key}`);
		if (list?.length) brief[key] = list.map((item) => item.trim());
	}
	if (value["authorizations"] !== undefined && value["authorizations"] !== null) {
		const seen = new Set<string>();
		brief.authorizations = array(value["authorizations"], "brief.authorizations", TEAM_MAX_MEMBERS).map((raw, index) => {
			const name = `brief.authorizations[${index}]`;
			if (!isRecord(raw)) return invalid(`${name} must be {member, allowed, forbidden?}`);
			onlyKeys(raw, ["member", "allowed", "forbidden"], name);
			const member = normalizeAlias(raw["member"], `${name}.member`);
			if (!roster.includes(member)) return invalid(`${name}.member must name a team member`);
			if (seen.has(member)) return invalid(`brief.authorizations contains duplicate member ${member}`);
			seen.add(member);
			const allowed = textList(raw["allowed"], `${name}.allowed`);
			if (!allowed) return invalid(`${name}.allowed is required`);
			const forbidden = textList(raw["forbidden"], `${name}.forbidden`);
			return { member, allowed, ...(forbidden ? { forbidden } : {}) };
		});
	}
	if (jsonBytes(brief) > TEAM_MAX_BRIEF_BYTES) return invalid(`brief exceeds ${TEAM_MAX_BRIEF_BYTES} serialized UTF-8 bytes`);
	return brief;
}

export const TEAM_PLAN_MIGRATION = "manager/workers were replaced by members plus lead: <alias>. List every member in members [{alias, roleDescription, ...}] and name the one that handles Team events with lead.";

/** A base-tool allowlist: unique tool names, empty means only the team tool. */
export function toolNames(value: unknown, field: string): string[] {
	const names = array(value, field, TEAM_MAX_TOOL_NAMES).map((name, index) => {
		if (typeof name !== "string" || !name.trim() || name.length > 128) return invalid(`${field}[${index}] must be a tool name`);
		return name.trim();
	});
	if (new Set(names).size !== names.length) return invalid(`${field} contains duplicate tool names`);
	return names;
}

function normalizeMemberPlan(value: unknown, field: string): TeamMemberPlan {
	if (!isRecord(value)) return invalid(`${field} must be an object {alias, roleDescription, model?, cwd?, fastMode?, contextWindow?, tools?}`);
	if (value["task"] !== undefined && value["task"] !== null) {
		return invalid(`${field}.task is no longer supported: put the role in roleDescription and initial work in initialRequests`);
	}
	onlyKeys(value, ["alias", "roleDescription", "model", "cwd", "fastMode", "contextWindow", "tools", "task"], field);
	const policy: TeamMemberPolicy = {};
	const model = optionalText(value["model"], `${field}.model`, 512);
	const cwd = optionalText(value["cwd"], `${field}.cwd`, 4096);
	if (model !== undefined) policy.model = model.trim();
	if (cwd !== undefined) policy.cwd = cwd.trim();
	if (value["fastMode"] !== undefined && value["fastMode"] !== null) {
		if (typeof value["fastMode"] !== "boolean") return invalid(`${field}.fastMode must be a boolean or null`);
		policy.fastMode = value["fastMode"];
	}
	if (value["contextWindow"] !== undefined && value["contextWindow"] !== null) {
		policy.contextWindow = safeInteger(value["contextWindow"], `${field}.contextWindow`, 1);
	}
	if (value["tools"] !== undefined && value["tools"] !== null) policy.tools = toolNames(value["tools"], `${field}.tools`);
	return {
		alias: normalizeAlias(value["alias"], `${field}.alias`),
		roleDescription: text(value["roleDescription"], `${field}.roleDescription`, TEAM_MAX_ROLE_BYTES),
		policy,
	};
}

/** Normalize a `subagent_team.prepare` plan. Model/cwd resolution is the launcher's job. */
export function normalizeTeamBudgetPreset(value: unknown): TeamBudgetPreset {
	if (value !== "standard" && value !== "long" && value !== "unlimited") return invalid("budget must be standard, long or unlimited");
	return value;
}

/** `by` must name a member other than the lead; the interval is whole minutes. */
export function normalizeReviewPlan(value: unknown, field: string, roster: readonly string[], lead: string): TeamReviewPlan {
	if (!isRecord(value)) return invalid(`${field} must be {by, everyMinutes} or null`);
	onlyKeys(value, ["by", "everyMinutes", "focus"], field);
	const by = normalizeAlias(value["by"], `${field}.by`);
	const focus = optionalText(value["focus"], `${field}.focus`, TEAM_MAX_REVIEW_FOCUS_BYTES)?.trim();
	if (!roster.includes(by) || by === lead) return invalid(`${field}.by must name a member other than the lead`);
	return { by, everyMinutes: safeInteger(value["everyMinutes"], `${field}.everyMinutes`, 1, TEAM_MAX_REVIEW_MINUTES), ...(focus ? { focus } : {}) };
}

export function normalizeTeamPlan(value: unknown): TeamPlan {
	assertJsonValue(value, new Set());
	if (!isRecord(value)) return invalid("prepare expects {members, lead, brief, initialRequests?, timeoutSeconds?}");
	if (present(value["manager"]) || present(value["workers"]) || present(value["coordinator"])) return invalid(TEAM_PLAN_MIGRATION);
	onlyKeys(value, ["members", "lead", "brief", "initialRequests", "timeoutSeconds", "budget", "review"], "prepare");
	const rawMembers = array(value["members"], "members", TEAM_MAX_MEMBERS);
	if (rawMembers.length < TEAM_MIN_MEMBERS) return invalid(`members must list ${TEAM_MIN_MEMBERS}-${TEAM_MAX_MEMBERS} members`);
	const members = rawMembers.map((member, index) => normalizeMemberPlan(member, `members[${index}]`));
	const roster = members.map((member) => member.alias);
	if (new Set(roster).size !== roster.length) return invalid("member aliases must be unique");
	const lead = normalizeAlias(value["lead"], "lead");
	if (!roster.includes(lead)) return invalid("lead must be the alias of one of the members");
	const brief = normalizeBrief(value["brief"], roster);
	const initialRequests = (value["initialRequests"] === undefined || value["initialRequests"] === null ? []
		: array(value["initialRequests"], "initialRequests", TEAM_MAX_INITIAL_REQUESTS)).map((raw, index) => {
		const name = `initialRequests[${index}]`;
		if (!isRecord(raw)) return invalid(`${name} must be {to, task, inputRefs?}`);
		onlyKeys(raw, ["to", "task", "inputRefs"], name);
		const to = normalizeAlias(raw["to"], `${name}.to`);
		if (to === lead) return invalid(`${name}.to must not be the lead (the lead requests the initial work)`);
		if (!roster.includes(to)) return invalid(`${name}.to must name a member of this team`);
		const inputRefs = idList(raw["inputRefs"], `${name}.inputRefs`, TEAM_MAX_INPUT_REFS);
		if (inputRefs.length) return invalid(`${name}.inputRefs must be empty: a new team has no results to reference`);
		return { to, task: text(raw["task"], `${name}.task`, TEAM_MAX_TASK_BYTES), inputRefs };
	});
	let timeoutSeconds: number | null = null;
	if (value["timeoutSeconds"] !== undefined && value["timeoutSeconds"] !== null) {
		const seconds = value["timeoutSeconds"];
		if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0 || seconds > TEAM_MAX_TIMEOUT_SECONDS) {
			return invalid(`timeoutSeconds must be null (no team deadline) or a number in (0, ${TEAM_MAX_TIMEOUT_SECONDS}]`);
		}
		timeoutSeconds = seconds;
	}
	return { members, lead, brief, initialRequests, timeoutSeconds,
		review: value["review"] == null ? null : normalizeReviewPlan(value["review"], "review", roster, lead),
		...(value["budget"] == null ? {} : { budget: normalizeTeamBudgetPreset(value["budget"]) }) };
}

// ---------------------------------------------------------------------------------------------
// Public `team` tool arguments. The model schema is one flat object; each action owns a subset of
// fields. Irrelevant declared fields may be null; any real value for them, and any undeclared
// field, is rejected rather than silently dropped.

const ACTION_FIELDS = {
	request: ["to", "task", "inputRefs"],
	reply: ["result"],
	yield: ["waitingFor", "checkpoint", "attention"],
	status: ["view", "id", "cursor", "limit"],
	control: ["command", "memberId", "workId", "expectedRevision", "task", "inputRefs", "reason", "incidentId", "instruction", "work", "disposition", "resultRefs", "outcome"],
} as const;
const CONTROL_FIELDS: Record<TeamControl["command"], readonly string[]> = {
	pause_member: ["memberId"],
	resume_member: ["memberId"],
	revise_work: ["workId", "expectedRevision", "task", "inputRefs"],
	cancel_work: ["workId", "expectedRevision", "reason"],
	resume_work: ["workId", "expectedRevision", "incidentId", "instruction"],
	accept_result: ["work", "disposition", "reason"],
	close_member: ["memberId"],
	close_team: ["resultRefs", "outcome", "reason"],
};
export const TEAM_ACTION_FIELDS: readonly string[] = [...new Set(Object.values(ACTION_FIELDS).flat())];

const schemaObject = (properties: Record<string, unknown>, description?: string) => Type.Object(properties as never, {
	additionalProperties: false,
	...(description ? { description } : {}),
});
const aliasSchema = Type.String({ minLength: 1, maxLength: TEAM_MAX_ALIAS_LENGTH, description: "Exact alias from the Team roster." });
const idSchema = Type.String({ minLength: 1, maxLength: TEAM_MAX_ID_LENGTH, description: "Opaque ID returned by Team status or a receipt." });
const resultIdSchema = Type.String({ minLength: 1, maxLength: TEAM_MAX_ID_LENGTH, description: "A result ID (result:…), never a work ID; a work's result ID is its resultRef in outcomes, events or status." });
const workRefSchema = schemaObject({ workId: idSchema, revision: Type.Integer({ minimum: 1 }) }, "An immutable work version reference.");
const resultSchema = schemaObject({
	status: Type.Union([Type.Literal("succeeded"), Type.Literal("partial"), Type.Literal("failed")]),
	summary: Type.String({ minLength: 1, maxLength: TEAM_MAX_TEXT_ITEM_BYTES }),
	findings: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: TEAM_MAX_TEXT_ITEM_BYTES }), { maxItems: TEAM_MAX_RESULT_ITEMS })),
	evidence: Type.Optional(Type.Array(schemaObject({
		source: Type.String({ minLength: 1, maxLength: TEAM_MAX_TEXT_ITEM_BYTES }),
		locator: Type.Optional(Type.String({ minLength: 1, maxLength: TEAM_MAX_TEXT_ITEM_BYTES })),
		basis: Type.Union([Type.Literal("observed"), Type.Literal("verified"), Type.Literal("inferred"), Type.Literal("unverified")]),
	}), { maxItems: TEAM_MAX_RESULT_ITEMS })),
	limitations: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: TEAM_MAX_TEXT_ITEM_BYTES }), { maxItems: TEAM_MAX_RESULT_ITEMS })),
	artifacts: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: TEAM_MAX_TEXT_ITEM_BYTES }), { maxItems: TEAM_MAX_RESULT_ITEMS })),
}, "Immutable candidate result for the current WorkRef; reply does not create new work.");
const controlAction = (command: string, properties: Record<string, unknown>, description: string) => schemaObject({
	action: Type.Literal("control"), command: Type.Literal(command), ...properties,
}, description);

/** Strict model-facing discriminated union. Runtime normalization remains authoritative. */
export const TEAM_TOOL_SCHEMA = Type.Union([
	schemaObject({ action: Type.Literal("request"), to: aliasSchema,
		task: Type.String({ minLength: 1, maxLength: TEAM_MAX_TASK_BYTES }),
		inputRefs: Type.Optional(Type.Array(resultIdSchema, { maxItems: TEAM_MAX_INPUT_REFS })),
	}, "Accept a child request for an exact recipient. A reply never creates a request."),
	schemaObject({ action: Type.Literal("reply"), result: resultSchema }, "Stage a result for only the current WorkRef; it commits after native settlement and cleanup."),
	schemaObject({ action: Type.Literal("yield"), waitingFor: Type.Array(workRefSchema, { minItems: 1, maxItems: TEAM_MAX_WAITING_FOR }),
		checkpoint: Type.String({ minLength: 1, maxLength: TEAM_MAX_NOTE_BYTES }),
	}, "Work activations only: end this work activation while waiting for the listed immutable WorkRefs."),
	schemaObject({ action: Type.Literal("yield"), attention: Type.String({ minLength: 1, maxLength: TEAM_MAX_NOTE_BYTES }),
		checkpoint: Type.String({ minLength: 1, maxLength: TEAM_MAX_NOTE_BYTES }),
	}, "Hold this work and ask for input: the member that requested a sub-task answers it (with resume_work, revise_work or cancel_work); the lead or host answers a root."),
	schemaObject({ action: Type.Literal("yield"), checkpoint: Type.Optional(Type.String({ minLength: 1, maxLength: TEAM_MAX_NOTE_BYTES })) },
		"Lead only: end this events activation. The lead never waits in-run; new Team events start its next activation automatically."),
	schemaObject({ action: Type.Literal("status"), view: Type.Optional(Type.Literal("team")),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: TEAM_STATUS_MAX_LIMIT })) },
	"Read the bounded Team summary. Team view does not accept an id or cursor."),
	...(["work", "result", "incident"] as const).flatMap((view) => [
		schemaObject({ action: Type.Literal("status"), view: Type.Literal(view),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: TEAM_STATUS_MAX_LIMIT })) },
		`Read a bounded ${view} page; status(result) is read-only and does not acknowledge child-result observation.`),
		schemaObject({ action: Type.Literal("status"), view: Type.Literal(view), id: idSchema,
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: TEAM_STATUS_MAX_LIMIT })) },
		`Read one exact ${view} id${view === "work" ? "; a member sees only the summary of another member's work" : ""}.`),
		schemaObject({ action: Type.Literal("status"), view: Type.Literal(view), cursor: idSchema,
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: TEAM_STATUS_MAX_LIMIT })) },
		`Continue a ${view} page from its opaque cursor.`),
	]),
	controlAction("pause_member", { memberId: aliasSchema }, "Lead only: prevent new member side effects and park at the next provider-safe point; already approved tools and valid end intents may finish."),
	controlAction("resume_member", { memberId: aliasSchema }, "Lead only: resume the same parked WorkRef after it reacquires a work permit; dependencies and budget holds remain."),
	controlAction("revise_work", { workId: idSchema, expectedRevision: Type.Integer({ minimum: 1 }),
		task: Type.String({ minLength: 1, maxLength: TEAM_MAX_TASK_BYTES }),
		inputRefs: Type.Optional(Type.Array(resultIdSchema, { maxItems: TEAM_MAX_INPUT_REFS })),
	}, "Work's requester or the lead: replace the exact current work revision; preserve its workId and result history; its unfinished sub-tasks become superseded."),
	controlAction("cancel_work", { workId: idSchema, expectedRevision: Type.Integer({ minimum: 1 }),
		reason: Type.String({ minLength: 1, maxLength: TEAM_MAX_NOTE_BYTES }),
	}, "Work's requester or the lead: cancel the exact current work subtree; cleanup uncertainty remains visible."),
	controlAction("resume_work", { workId: idSchema, expectedRevision: Type.Integer({ minimum: 1 }),
		incidentId: idSchema, instruction: Type.String({ minLength: 1, maxLength: TEAM_MAX_NOTE_BYTES }),
	}, "Work's requester or the lead: explicitly resume a held work revision after addressing its incident."),
	controlAction("accept_result", { work: workRefSchema,
		disposition: Type.Union([Type.Literal("accepted"), Type.Literal("waived")]),
		reason: Type.Optional(Type.String({ minLength: 1, maxLength: TEAM_MAX_NOTE_BYTES })),
	}, "Root's requester or the lead: explicitly accept a successful root or waive a terminal outcome with a reason."),
	controlAction("close_member", { memberId: aliasSchema }, "Lead only: close an idle member with no unresolved obligations."),
	controlAction("close_team", { resultRefs: Type.Array(resultIdSchema, { maxItems: TEAM_MAX_INPUT_REFS }),
		outcome: Type.Union([Type.Literal("succeeded"), Type.Literal("partial"), Type.Literal("failed")]),
		reason: Type.Optional(Type.String({ minLength: 1, maxLength: TEAM_MAX_NOTE_BYTES })),
	}, "Lead only: close the Team after all roots and member resources are explicitly settled."),
]);

export const TEAM_TOOL_DESCRIPTION = prompt("team", "tool_description");

const LEGACY_ACTIONS: Record<string, string> = {
	send: "send was replaced by request {to, task}; a reply never creates a new request",
	report: "report was replaced by reply {result} for the current work",
	wait: "wait was replaced by yield {waitingFor:[WorkRef], checkpoint}; waiting ends the native run instead of holding the member",
	finish: "finish was replaced by reply {result} for the current work, or control close_team for the lead",
	checkpoint: "checkpoint is internal to the runtime and not a model action",
};
const LEGACY_FIELDS: Record<string, string> = {
	afterSeq: "afterSeq was removed: deliveries are acknowledged by the runtime, not by a model cursor",
	supersedes: "supersedes was removed: the lead revises work with control revise_work",
	replyTo: "replyTo was removed: reply is bound to the current work automatically",
	message: "message was removed: use request.task, reply.result or yield.attention",
	wait: "wait was removed: use yield {waitingFor}",
};

const present = (value: unknown): boolean => value !== undefined && value !== null;

export function normalizeTeamAction(value: unknown): TeamAction {
	if (jsonBytes(value) > TEAM_MAX_ACTION_BYTES) return invalid(`team arguments exceed ${TEAM_MAX_ACTION_BYTES} serialized UTF-8 bytes`);
	if (!isRecord(value)) return invalid("team arguments must be an object with an action");
	for (const [key, message] of Object.entries(LEGACY_FIELDS)) if (present(value[key])) invalid(message);
	const action = value["action"];
	if (typeof action === "string" && LEGACY_ACTIONS[action]) return invalid(LEGACY_ACTIONS[action]);
	if (typeof action !== "string" || !Object.hasOwn(ACTION_FIELDS, action)) return invalid("action must be request, reply, yield, status or control");
	const allowed: readonly string[] = ACTION_FIELDS[action as keyof typeof ACTION_FIELDS];
	for (const key of Object.keys(value)) {
		if (key === "action") continue;
		if (!TEAM_ACTION_FIELDS.includes(key)) invalid(`unknown field ${key}`);
		if (!allowed.includes(key) && present(value[key])) invalid(`${key} is not used by ${action}; omit it or pass null`);
	}
	switch (action) {
		case "request":
			return { action, to: normalizeAlias(value["to"], "to"), task: text(value["task"], "task", TEAM_MAX_TASK_BYTES),
				inputRefs: idList(value["inputRefs"], "inputRefs", TEAM_MAX_INPUT_REFS) };
		case "reply":
			return { action, result: normalizeWorkResult(value["result"]) };
		case "yield": {
			const refs = present(value["waitingFor"]) ? array(value["waitingFor"], "waitingFor", TEAM_MAX_WAITING_FOR)
				.map((item, index) => normalizeWorkRef(item, `waitingFor[${index}]`)) : [];
			const unique = new Map(refs.map((ref) => [`${ref.workId}@${ref.revision}`, ref]));
			const waitingFor = [...unique.values()].sort((left, right) => left.workId < right.workId ? -1
				: left.workId > right.workId ? 1 : left.revision - right.revision);
			const checkpoint = optionalText(value["checkpoint"], "checkpoint", TEAM_MAX_NOTE_BYTES);
			const attention = optionalText(value["attention"], "attention", TEAM_MAX_NOTE_BYTES);
			if (waitingFor.length && attention !== undefined) return invalid("waitingFor and attention are mutually exclusive");
			return { action, waitingFor, ...(checkpoint !== undefined ? { checkpoint } : {}), ...(attention !== undefined ? { attention } : {}) };
		}
		case "status": {
			const view = value["view"] ?? "team";
			if (view !== "team" && view !== "work" && view !== "result" && view !== "incident") return invalid("view must be team, work, result or incident");
			const limit = present(value["limit"]) ? safeInteger(value["limit"], "limit", 1, TEAM_STATUS_MAX_LIMIT) : TEAM_STATUS_DEFAULT_LIMIT;
			const id = present(value["id"]) ? normalizeId(value["id"], "id") : undefined;
			const cursor = present(value["cursor"]) ? normalizeId(value["cursor"], "cursor") : undefined;
			if (view === "team" && (id !== undefined || cursor !== undefined)) return invalid("view team takes no id or cursor");
			if (id !== undefined && cursor !== undefined) return invalid("id and cursor are mutually exclusive");
			return { action, view, limit, ...(id !== undefined ? { id } : {}), ...(cursor !== undefined ? { cursor } : {}) };
		}
		case "control":
			return { action, control: normalizeControl(value) };
	}
	return invalid("unsupported action");
}

function normalizeControl(value: Record<string, unknown>): TeamControl {
	const command = value["command"];
	if (typeof command !== "string" || !Object.hasOwn(CONTROL_FIELDS, command)) {
		return invalid(`command must be one of ${Object.keys(CONTROL_FIELDS).join(", ")}`);
	}
	const fields = CONTROL_FIELDS[command as TeamControl["command"]];
	for (const key of ACTION_FIELDS.control) {
		if (key !== "command" && !fields.includes(key) && present(value[key])) invalid(`${key} is not used by ${command}; omit it or pass null`);
	}
	const reason = optionalText(value["reason"], "reason", TEAM_MAX_NOTE_BYTES);
	switch (command as TeamControl["command"]) {
		case "pause_member":
			return { command: "pause_member", memberId: normalizeAlias(value["memberId"], "memberId") };
		case "resume_member":
			return { command: "resume_member", memberId: normalizeAlias(value["memberId"], "memberId") };
		case "close_member":
			return { command: "close_member", memberId: normalizeAlias(value["memberId"], "memberId") };
		case "revise_work":
			return { command: "revise_work", workId: normalizeId(value["workId"], "workId"),
				expectedRevision: safeInteger(value["expectedRevision"], "expectedRevision", 1),
				task: text(value["task"], "task", TEAM_MAX_TASK_BYTES), inputRefs: idList(value["inputRefs"], "inputRefs", TEAM_MAX_INPUT_REFS) };
		case "cancel_work":
			if (reason === undefined) return invalid("cancel_work requires reason");
			return { command: "cancel_work", workId: normalizeId(value["workId"], "workId"),
				expectedRevision: safeInteger(value["expectedRevision"], "expectedRevision", 1), reason };
		case "resume_work":
			return { command: "resume_work", workId: normalizeId(value["workId"], "workId"),
				expectedRevision: safeInteger(value["expectedRevision"], "expectedRevision", 1),
				incidentId: normalizeId(value["incidentId"], "incidentId"),
				instruction: text(value["instruction"], "instruction", TEAM_MAX_NOTE_BYTES) };
		case "accept_result": {
			const disposition = value["disposition"];
			if (disposition !== "accepted" && disposition !== "waived") return invalid("disposition must be accepted or waived");
			if (disposition === "waived" && reason === undefined) return invalid("waived requires reason");
			return { command: "accept_result", work: normalizeWorkRef(value["work"], "work"), disposition, ...(reason !== undefined ? { reason } : {}) };
		}
		case "close_team": {
			const outcome = value["outcome"];
			if (outcome !== "succeeded" && outcome !== "partial" && outcome !== "failed") return invalid("outcome must be succeeded, partial or failed");
			return { command: "close_team", resultRefs: idList(value["resultRefs"], "resultRefs", TEAM_MAX_INPUT_REFS), outcome,
				...(reason !== undefined ? { reason } : {}) };
		}
	}
}

// ---------------------------------------------------------------------------------------------
// Private frames. Any shape violation is a protocol failure of the sending connection only.

function checkFrameSize(value: unknown): void {
	let bytes: number;
	try { bytes = jsonBytes(value); } catch { return protocol("Frame is not JSON"); }
	if (bytes > TEAM_MAX_FRAME_BYTES) protocol(`Frame exceeds ${TEAM_MAX_FRAME_BYTES} bytes`);
}

function frameVersion(value: Record<string, unknown>): void {
	if (value["version"] !== TEAM_PROTOCOL_VERSION) {
		throw new TeamProtocolError("UNSUPPORTED_PROTOCOL", `Unsupported team protocol version ${JSON.stringify(value["version"])}; expected ${TEAM_PROTOCOL_VERSION}`);
	}
}

function frameKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
	const extra = Object.keys(value).filter((key) => !allowed.includes(key));
	if (extra.length) protocol(`${field} has unexpected field(s) ${extra.join(", ")}`);
}

function frameId(value: unknown, field: string): string {
	try { return normalizeId(value, field); } catch { return protocol(`${field} is not a valid id`); }
}

function blockerId(value: unknown, field: string): string {
	if (typeof value === "string") {
		const match = /^(.+)@([1-9][0-9]*)$/u.exec(value);
		if (match) {
			try {
				normalizeId(match[1], `${field}.workId`);
				safeInteger(Number(match[2]), `${field}.revision`, 1);
				return value;
			} catch { /* Fall through to opaque-ID validation. */ }
		}
	}
	return frameId(value, field);
}

export function parseBinding(value: unknown): BindingV2 {
	if (!isRecord(value)) return protocol("binding must be an object");
	frameVersion(value);
	frameKeys(value, ["version", "teamId", "memberId", "epoch"], "binding");
	if (typeof value["memberId"] !== "string" || !isValidAgentAlias(value["memberId"])) return protocol("binding.memberId is invalid");
	return { version: TEAM_PROTOCOL_VERSION, teamId: frameId(value["teamId"], "binding.teamId"), memberId: value["memberId"],
		epoch: frameId(value["epoch"], "binding.epoch") };
}

export function parseActivationScope(value: unknown): ActivationScope {
	if (!isRecord(value)) return protocol("activation must be an object");
	frameKeys(value, ["activationId", "kind", "work", "eventBatchId"], "activation");
	const activationId = frameId(value["activationId"], "activation.activationId");
	if (value["kind"] === "work") {
		if (value["eventBatchId"] !== undefined) return protocol("work activation cannot carry eventBatchId");
		let work: WorkRef;
		try { work = normalizeWorkRef(value["work"], "activation.work"); } catch { return protocol("work activation requires a valid work reference"); }
		return { activationId, kind: "work", work };
	}
	if (value["kind"] === "events") {
		if (value["work"] !== undefined) return protocol("events activation cannot carry work");
		return { activationId, kind: "events", eventBatchId: frameId(value["eventBatchId"], "activation.eventBatchId") };
	}
	return protocol("activation.kind must be work or events");
}

export function sameBinding(left: BindingV2, right: BindingV2): boolean {
	return left.version === right.version && left.teamId === right.teamId && left.memberId === right.memberId && left.epoch === right.epoch;
}

export function sameScope(left: ActivationScope, right: ActivationScope): boolean {
	return left.activationId === right.activationId && left.kind === right.kind && left.eventBatchId === right.eventBatchId
		&& (left.work === undefined ? right.work === undefined
			: right.work !== undefined && left.work.workId === right.work.workId && left.work.revision === right.work.revision);
}

function parsePrivateAction(value: unknown): PrivateAction {
	if (!isRecord(value)) return protocol("request must be an object");
	switch (value["action"]) {
		case "business": {
			frameKeys(value, ["action", "args"], "business request");
			if (!isRecord(value["args"])) return protocol("business request args must be an object");
			return { action: "business", args: value["args"] };
		}
		case "input_ready":
			frameKeys(value, ["action", "deliveryId"], "input_ready");
			return { action: "input_ready", deliveryId: frameId(value["deliveryId"], "deliveryId") };
		case "provider_gate":
			frameKeys(value, ["action"], "provider_gate");
			return { action: "provider_gate" };
		case "tool_gate":
			frameKeys(value, ["action", "toolCallId", "toolName", "endIntent"], "tool_gate");
			if (typeof value["toolCallId"] !== "string") return protocol("tool_gate.toolCallId is invalid");
			if (typeof value["toolName"] !== "string" || !value["toolName"] || value["toolName"].length > 128) return protocol("tool_gate.toolName is invalid");
			if (typeof value["endIntent"] !== "boolean") return protocol("tool_gate.endIntent must be boolean");
			return { action: "tool_gate", toolCallId: normalizeNativeToolCallId(value["toolCallId"], "tool_gate.toolCallId"), toolName: value["toolName"], endIntent: value["endIntent"] };
		case "tool_result":
			frameKeys(value, ["action", "toolCallId", "toolName"], "tool_result");
			if (typeof value["toolName"] !== "string" || !value["toolName"] || value["toolName"].length > 128) return protocol("tool_result.toolName is invalid");
			return { action: "tool_result", toolCallId: normalizeNativeToolCallId(value["toolCallId"], "tool_result.toolCallId"), toolName: value["toolName"] };
		case "boundary":
			frameKeys(value, ["action", "kind"], "boundary");
			if (value["kind"] !== "turn_end" && value["kind"] !== "agent_end") return protocol("boundary.kind is invalid");
			return { action: "boundary", kind: value["kind"] };
	}
	return protocol("request.action is invalid");
}

/** Validate a child -> parent frame. Throws TeamProtocolError (PROTOCOL_FAILURE / UNSUPPORTED_PROTOCOL). */
function parseChildFrameInternal(value: unknown): ChildFrame {
	checkFrameSize(value);
	if (!isRecord(value)) return protocol("frame must be an object");
	frameVersion(value);
	if (value["kind"] === "request") {
		frameKeys(value, ["version", "kind", "binding", "activation", "sequence", "rpcRequestId", "request"], "request frame");
		const sequence = value["sequence"];
		if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) return protocol("sequence must be a positive safe integer");
		return { version: TEAM_PROTOCOL_VERSION, kind: "request", binding: parseBinding(value["binding"]),
			activation: parseActivationScope(value["activation"]), sequence, rpcRequestId: frameId(value["rpcRequestId"], "rpcRequestId"),
			request: parsePrivateAction(value["request"]) };
	}
	if (value["kind"] === "ack") {
		frameKeys(value, ["version", "kind", "commandId", "binding", "activation", "ok", "error"], "ack frame");
		if (typeof value["ok"] !== "boolean") return protocol("ack.ok must be boolean");
		if ((value["ok"] && value["error"] !== undefined) || (!value["ok"] && value["error"] === undefined)) return protocol("ack error must be present exactly when ok is false");
		if (value["error"] !== undefined) {
			try { text(value["error"], "ack.error", TEAM_MAX_NOTE_BYTES); }
			catch { return protocol("ack.error is invalid"); }
		}
		return { version: TEAM_PROTOCOL_VERSION, kind: "ack", commandId: frameId(value["commandId"], "commandId"), binding: parseBinding(value["binding"]),
			...(value["activation"] !== undefined ? { activation: parseActivationScope(value["activation"]) } : {}), ok: value["ok"],
			...(typeof value["error"] === "string" ? { error: value["error"] } : {}) };
	}
	return protocol("frame kind must be request or ack");
}

function privateBoundary<T>(parse: () => T, label: string): T {
	try { return parse(); }
	catch (error) {
		if (error instanceof TeamProtocolError && (error.code === "PROTOCOL_FAILURE" || error.code === "UNSUPPORTED_PROTOCOL")) throw error;
		return protocol(`${label} is invalid`);
	}
}

export function parseChildFrame(value: unknown): ChildFrame {
	return privateBoundary(() => parseChildFrameInternal(value), "Child frame");
}

function parseGateDecision(value: unknown): GateDecision {
	if (!isRecord(value) || typeof value["allow"] !== "boolean") return protocol("gate decision is invalid");
	if (value["allow"]) { frameKeys(value, ["allow"], "gate decision"); return { allow: true }; }
	frameKeys(value, ["allow", "reason", "message"], "gate decision");
	const reason = value["reason"];
	if (!["paused", "stale_scope", "budget", "activation_ending", "delivery_pending", "team_stopping", "policy_stop"].includes(String(reason))) return protocol("gate reason is invalid");
	let message: string;
	try { message = text(value["message"], "gate.message", TEAM_MAX_NOTE_BYTES); }
	catch { return protocol("gate message is invalid"); }
	return { allow: false, reason: reason as Exclude<GateDecision, { allow: true }>["reason"], message };
}

function parseWorkError(value: unknown, field: string): WorkError {
	if (!isRecord(value)) return protocol(`${field} must be an error object`);
	frameKeys(value, ["code", "message", "outcomeUnknown"], field);
	const error: WorkError = { code: text(value["code"], `${field}.code`, 128), message: text(value["message"], `${field}.message`, TEAM_MAX_NOTE_BYTES) };
	if (value["outcomeUnknown"] !== undefined) {
		if (typeof value["outcomeUnknown"] !== "boolean") return protocol(`${field}.outcomeUnknown must be boolean`);
		error.outcomeUnknown = value["outcomeUnknown"];
	}
	return error;
}

function parseTeamError(value: unknown): TeamError {
	if (!isRecord(value)) return protocol("team reply error must be an object");
	frameKeys(value, ["code", "message", "blockers"], "team reply error");
	const code = value["code"];
	if (!(TEAM_ERROR_CODES as readonly unknown[]).includes(code)) return protocol("team reply error code is invalid");
	const blockers = value["blockers"] === undefined ? undefined : array(value["blockers"], "team reply error.blockers", 32).map((item, index) => {
		const field = `team reply error.blockers[${index}]`;
		if (!isRecord(item)) return protocol(`${field} must be an object`);
		frameKeys(item, ["kind", "id", "reason"], field);
		return { kind: text(item["kind"], `${field}.kind`, 128),
			...(item["id"] !== undefined ? { id: blockerId(item["id"], `${field}.id`) } : {}),
			reason: text(item["reason"], `${field}.reason`, TEAM_MAX_NOTE_BYTES) };
	});
	return { code: code as TeamErrorCode, message: text(value["message"], "team reply error.message", TEAM_MAX_NOTE_BYTES),
		...(blockers?.length ? { blockers } : {}) };
}

function parseWorkVersion(value: unknown, field: string): WorkVersion {
	if (!isRecord(value)) return protocol(`${field} must be a work version`);
	frameKeys(value, ["revision", "task", "inputRefs", "state", "waitingFor", "observedOutcomes", "childIssues", "checkpoint", "resumeInstruction", "hold", "resultRef", "review", "error", "createdAt", "updatedAt"], field);
	const state = value["state"];
	if (!(WORK_STATES as readonly unknown[]).includes(state)) return protocol(`${field}.state is invalid`);
	const parseRefs = (raw: unknown, name: string, max: number): WorkRef[] => {
		const refs = array(raw, name, max).map((item, index) => normalizeWorkRef(item, `${name}[${index}]`));
		if (new Set(refs.map((ref) => `${ref.workId}@${ref.revision}`)).size !== refs.length) return protocol(`${name} contains duplicates`);
		return refs;
	};
	const checkpoint = value["checkpoint"] === undefined ? undefined : text(value["checkpoint"], `${field}.checkpoint`, TEAM_MAX_NOTE_BYTES);
	const resumeInstruction = value["resumeInstruction"] === undefined ? undefined : text(value["resumeInstruction"], `${field}.resumeInstruction`, TEAM_MAX_NOTE_BYTES);
	let hold: WorkVersion["hold"];
	if (value["hold"] !== undefined) {
		const raw = value["hold"];
		if (!isRecord(raw)) return protocol(`${field}.hold must be an object`);
		frameKeys(raw, ["reason", "incidentId"], `${field}.hold`);
		if (!["attention", "budget", "protocol", "lead_unavailable"].includes(String(raw["reason"]))) return protocol(`${field}.hold.reason is invalid`);
		hold = { reason: raw["reason"] as HoldReason, incidentId: frameId(raw["incidentId"], `${field}.hold.incidentId`) };
	}
	let review: WorkVersion["review"];
	if (value["review"] !== undefined) {
		const raw = value["review"];
		if (!isRecord(raw)) return protocol(`${field}.review must be an object`);
		frameKeys(raw, ["disposition", "reason"], `${field}.review`);
		if (raw["disposition"] !== "accepted" && raw["disposition"] !== "waived") return protocol(`${field}.review.disposition is invalid`);
		const reason = raw["reason"] === undefined ? undefined : text(raw["reason"], `${field}.review.reason`, TEAM_MAX_NOTE_BYTES);
		review = { disposition: raw["disposition"], ...(reason !== undefined ? { reason } : {}) };
	}
	const error = value["error"] === undefined ? undefined : parseWorkError(value["error"], `${field}.error`);
	const childIssues = value["childIssues"] === undefined ? undefined : parseChildIssues(value["childIssues"], `${field}.childIssues`, TEAM_MAX_PUBLIC_CHILDREN);
	const resultRef = value["resultRef"] === undefined ? undefined : frameId(value["resultRef"], `${field}.resultRef`);
	const createdAt = value["createdAt"];
	const updatedAt = value["updatedAt"];
	if (typeof createdAt !== "number" || !Number.isFinite(createdAt) || createdAt < 0
		|| typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt < createdAt) return protocol(`${field} timestamps are invalid`);
	return {
		revision: safeInteger(value["revision"], `${field}.revision`, 1), task: text(value["task"], `${field}.task`, TEAM_MAX_DELIVERED_TASK_BYTES),
		inputRefs: idList(value["inputRefs"], `${field}.inputRefs`, TEAM_MAX_INPUT_REFS), state: state as WorkState,
		waitingFor: parseRefs(value["waitingFor"], `${field}.waitingFor`, TEAM_MAX_WAITING_FOR),
		observedOutcomes: parseRefs(value["observedOutcomes"], `${field}.observedOutcomes`, TEAM_MAX_RESULT_RECORDS),
		...(childIssues?.length ? { childIssues } : {}),
		...(checkpoint !== undefined ? { checkpoint } : {}), ...(resumeInstruction !== undefined ? { resumeInstruction } : {}),
		...(hold ? { hold } : {}), ...(resultRef ? { resultRef } : {}), ...(review ? { review } : {}), ...(error ? { error } : {}),
		createdAt, updatedAt,
	};
}

function parseChildIssues(value: unknown, field: string, max: number): ChildIssue[] {
	return array(value, field, max).map((raw, index): ChildIssue => {
		const name = `${field}[${index}]`;
		if (!isRecord(raw)) return protocol(`${name} must be an object`);
		frameKeys(raw, ["work", "assignee", "incidentId", "reason", "message"], name);
		if (raw["reason"] !== "attention" && raw["reason"] !== "protocol") return protocol(`${name}.reason is invalid`);
		return { work: normalizeWorkRef(raw["work"], `${name}.work`), assignee: normalizeAlias(raw["assignee"], `${name}.assignee`),
			incidentId: frameId(raw["incidentId"], `${name}.incidentId`), reason: raw["reason"],
			message: text(raw["message"], `${name}.message`, TEAM_MAX_CHILD_ISSUE_MESSAGE_BYTES) };
	});
}

function parseIncident(value: unknown, field = "incident"): TeamIncidentView {
	if (!isRecord(value)) return protocol(`${field} must be an incident`);
	frameKeys(value, ["id", "code", "message", "state", "work", "rootId", "memberId", "createdAt"], field);
	const state = value["state"];
	if (state !== "open" && state !== "resolved") return protocol(`${field}.state is invalid`);
	const createdAt = value["createdAt"];
	if (typeof createdAt !== "number" || !Number.isFinite(createdAt) || createdAt < 0) return protocol(`${field}.createdAt is invalid`);
	return {
		id: frameId(value["id"], `${field}.id`), code: text(value["code"], `${field}.code`, 128), message: text(value["message"], `${field}.message`, TEAM_MAX_NOTE_BYTES), state,
		...(value["work"] !== undefined ? { work: normalizeWorkRef(value["work"], `${field}.work`) } : {}),
		...(value["rootId"] !== undefined ? { rootId: frameId(value["rootId"], `${field}.rootId`) } : {}),
		...(value["memberId"] !== undefined ? { memberId: normalizeAlias(value["memberId"], `${field}.memberId`) } : {}), createdAt,
	};
}

export function normalizeResultRecord(value: unknown, field = "result record"): ResultRecord {
	if (!isRecord(value)) return protocol(`${field} must be an object`);
	frameKeys(value, ["id", "work", "author", "result", "committedAt", "source"], field);
	const committedAt = value["committedAt"];
	if (typeof committedAt !== "number" || !Number.isFinite(committedAt) || committedAt < 0) return protocol(`${field}.committedAt is invalid`);
	const source = value["source"];
	if (source !== "explicit_reply" && source !== "natural_final") return protocol(`${field}.source is invalid`);
	return { id: frameId(value["id"], `${field}.id`), work: normalizeWorkRef(value["work"], `${field}.work`),
		author: normalizeAlias(value["author"], `${field}.author`), result: normalizeWorkResult(value["result"], `${field}.result`), committedAt, source };
}

/** Strict decoder for a review record written to the v2 history journal. */
export function normalizeTeamReviewRecord(value: unknown, field = "review record"): TeamReviewRecord {
	if (!isRecord(value)) return protocol(`${field} must be an object`);
	frameKeys(value, ["id", "at", "by", "work", "resultRef", "status", "verdict", "summary", "findings", "limitations", "snapshot"], field);
	const status = value["status"];
	if (status !== "succeeded" && status !== "partial" && status !== "failed") return protocol(`${field}.status is invalid`);
	const verdict = value["verdict"];
	if (verdict !== undefined && !(Object.values(REVIEW_VERDICTS) as readonly unknown[]).includes(verdict)) return protocol(`${field}.verdict is invalid`);
	const snapshot = value["snapshot"];
	if (!isRecord(snapshot)) return protocol(`${field}.snapshot must be an object`);
	frameKeys(snapshot, ["elapsedMs", "works", "finishedSinceLast", "budget"], `${field}.snapshot`);
	const works = snapshot["works"];
	if (!isRecord(works)) return protocol(`${field}.snapshot.works must be an object`);
	const counts = ["total", "resolved", "running", "blocked", "held", "failed", "cancelled"] as const;
	frameKeys(works, counts, `${field}.snapshot.works`);
	const findings = textList(value["findings"], `${field}.findings`);
	const limitations = textList(value["limitations"], `${field}.limitations`);
	return {
		id: frameId(value["id"], `${field}.id`), at: safeInteger(value["at"], `${field}.at`, 0), by: normalizeAlias(value["by"], `${field}.by`),
		work: normalizeWorkRef(value["work"], `${field}.work`), ...(value["resultRef"] !== undefined ? { resultRef: frameId(value["resultRef"], `${field}.resultRef`) } : {}),
		status, ...(verdict !== undefined ? { verdict: verdict as NonNullable<TeamReviewRecord["verdict"]> } : {}),
		summary: text(value["summary"], `${field}.summary`, TEAM_MAX_TEXT_ITEM_BYTES),
		...(findings?.length ? { findings } : {}), ...(limitations?.length ? { limitations } : {}),
		snapshot: {
			elapsedMs: safeInteger(snapshot["elapsedMs"], `${field}.snapshot.elapsedMs`, 0),
			works: Object.fromEntries(counts.map((key) => [key, safeInteger(works[key], `${field}.snapshot.works.${key}`, 0)])) as TeamReviewRecord["snapshot"]["works"],
			finishedSinceLast: safeInteger(snapshot["finishedSinceLast"], `${field}.snapshot.finishedSinceLast`, 0),
			budget: array(snapshot["budget"], `${field}.snapshot.budget`, 16).map((raw, index) => {
				const name = `${field}.snapshot.budget[${index}]`;
				if (!isRecord(raw)) return protocol(`${name} must be an object`);
				frameKeys(raw, ["counter", "used", "limit"], name);
				return { counter: text(raw["counter"], `${name}.counter`, 64), used: safeInteger(raw["used"], `${name}.used`, 0), limit: safeInteger(raw["limit"], `${name}.limit`, 0) };
			}),
		},
	};
}

/** Strict shared decoder for the terminal result written to the v2 history journal. */
export function normalizeTeamResult(value: unknown, field = "terminal.result"): TeamResult {
	if (!isRecord(value)) return protocol(`${field} must be an object`);
	frameKeys(value, ["version", "teamId", "lifecycle", "outcome", "reason", "finalResultRefs", "roots", "members", "usage", "unresolvedIncidents", "unresolvedIncidentsOmitted"], field);
	if (value["version"] !== TEAM_PROTOCOL_VERSION) return protocol(`${field}.version is invalid`);
	const lifecycle = value["lifecycle"];
	if (!( ["closed", "failed", "cancelled", "interrupted"] as readonly unknown[]).includes(lifecycle)) return protocol(`${field}.lifecycle is invalid`);
	const outcome = value["outcome"];
	if (outcome !== undefined && outcome !== "succeeded" && outcome !== "partial" && outcome !== "failed") return protocol(`${field}.outcome is invalid`);
	const reason = value["reason"] === undefined ? undefined : text(value["reason"], `${field}.reason`, 4096);
	const unresolvedIncidents = array(value["unresolvedIncidents"], `${field}.unresolvedIncidents`, TEAM_MAX_TERMINAL_INCIDENTS).map((raw, index) => {
		const incidentField = `${field}.unresolvedIncidents[${index}]`;
		if (!isRecord(raw)) return protocol(`${incidentField} must be an object`);
		frameKeys(raw, ["id", "code", "message"], incidentField);
		return { id: frameId(raw["id"], `${incidentField}.id`), code: text(raw["code"], `${incidentField}.code`, 128),
			message: text(raw["message"], `${incidentField}.message`, TEAM_MAX_NOTE_BYTES) };
	});
	const result: TeamResult = {
		version: TEAM_PROTOCOL_VERSION,
		teamId: frameId(value["teamId"], `${field}.teamId`),
		lifecycle: lifecycle as TeamResult["lifecycle"],
		finalResultRefs: idList(value["finalResultRefs"], `${field}.finalResultRefs`, 16_384),
		roots: normalizeTeamResultRoots(value["roots"], `${field}.roots`),
		members: parseTerminalMembers(value["members"], `${field}.members`),
		usage: parseUsage(value["usage"], `${field}.usage`),
		unresolvedIncidents,
	};
	if (outcome !== undefined) result.outcome = outcome;
	if (reason !== undefined) result.reason = reason;
	if (value["unresolvedIncidentsOmitted"] !== undefined) {
		result.unresolvedIncidentsOmitted = safeInteger(value["unresolvedIncidentsOmitted"], `${field}.unresolvedIncidentsOmitted`, 0);
	}
	if (result.lifecycle === "closed" && result.outcome === undefined) return protocol(`${field} closed lifecycle must include an outcome`);
	if (result.lifecycle !== "closed" && !result.reason) return protocol(`${field} non-closed lifecycle must include a reason`);
	return result;
}

export function normalizeTeamResultRoots(value: unknown, field = "roots"): TeamResult["roots"] {
	if (!Array.isArray(value) || value.length > TEAM_BUDGET_PRESETS.unlimited.teamWorks) return protocol(`${field} is invalid or exceeds capacity`);
	return value.map((raw, index) => {
		const rootField = `${field}[${index}]`;
		if (!isRecord(raw)) return protocol(`${rootField} must be an object`);
		frameKeys(raw, ["work", "state", "resultRef", "review"], rootField);
		const state = raw["state"];
		if (!(WORK_STATES as readonly unknown[]).includes(state) || !["resolved", "failed", "cancelled", "superseded"].includes(String(state))) {
			return protocol(`${rootField}.state must be terminal`);
		}
		let review: TeamResult["roots"][number]["review"];
		if (raw["review"] !== undefined) {
			if (!isRecord(raw["review"])) return protocol(`${rootField}.review must be an object`);
			frameKeys(raw["review"], ["disposition", "reason"], `${rootField}.review`);
			const disposition = raw["review"]["disposition"];
			if (disposition !== "accepted" && disposition !== "waived") return protocol(`${rootField}.review.disposition is invalid`);
			const reviewReason = raw["review"]["reason"] === undefined ? undefined : text(raw["review"]["reason"], `${rootField}.review.reason`, 4096);
			review = { disposition, ...(reviewReason !== undefined ? { reason: reviewReason } : {}) };
		}
		return { work: normalizeWorkRef(raw["work"], `${rootField}.work`), state: state as WorkState,
			...(raw["resultRef"] !== undefined ? { resultRef: frameId(raw["resultRef"], `${rootField}.resultRef`) } : {}),
			...(review ? { review } : {}) };
	});
}

function parseTerminalMembers(value: unknown, field: string): TeamResult["members"] {
	const members = array(value, field, TEAM_MAX_MEMBERS);
	if (members.length < 2) return protocol(`${field} roster is invalid`);
	const parsed = members.map((raw, index) => {
		const memberField = `${field}[${index}]`;
		if (!isRecord(raw)) return protocol(`${memberField} must be an object`);
		frameKeys(raw, ["id", "lifecycle", "resourceState"], memberField);
		const lifecycle = raw["lifecycle"];
		const resourceState = raw["resourceState"];
		if (!["starting", "open", "closing", "closed", "faulted"].includes(String(lifecycle))) return protocol(`${memberField}.lifecycle is invalid`);
		if (!["starting", "owned", "stopping", "released", "cleanup_failed"].includes(String(resourceState))) return protocol(`${memberField}.resourceState is invalid`);
		return { id: normalizeAlias(raw["id"], `${memberField}.id`), lifecycle: lifecycle as MemberLifecycle, resourceState: resourceState as ResourceState };
	});
	if (new Set(parsed.map((member) => member.id)).size !== parsed.length) return protocol(`${field} must contain unique IDs`);
	return parsed;
}

function parseWorkSummary(value: unknown): TeamWorkSummary {
	if (!isRecord(value)) return protocol("work summary must be an object");
	frameKeys(value, ["work", "parent", "requester", "assignee", "state", "taskPreview", "hold", "resultRef", "review", "kind"], "work summary");
	if (value["kind"] !== undefined && value["kind"] !== "review") return protocol("work summary kind is invalid");
	const state = value["state"];
	if (!(WORK_STATES as readonly unknown[]).includes(state)) return protocol("work summary state is invalid");
	const hold = value["hold"];
	if (hold !== undefined && !["attention", "budget", "protocol", "lead_unavailable"].includes(String(hold))) return protocol("work summary hold is invalid");
	const review = value["review"];
	if (review !== undefined && review !== "accepted" && review !== "waived") return protocol("work summary review is invalid");
	return { work: normalizeWorkRef(value["work"], "work summary.work"),
		...(value["parent"] !== undefined ? { parent: normalizeWorkRef(value["parent"], "work summary.parent") } : {}),
		requester: normalizeAlias(value["requester"], "work summary.requester"),
		assignee: normalizeAlias(value["assignee"], "work summary.assignee"), state: state as WorkState,
		taskPreview: text(value["taskPreview"], "work summary.taskPreview", TEAM_MAX_TASK_BYTES),
		...(hold !== undefined ? { hold: hold as HoldReason } : {}),
		...(value["resultRef"] !== undefined ? { resultRef: frameId(value["resultRef"], "work summary.resultRef") } : {}),
		...(review !== undefined ? { review } : {}), ...(value["kind"] ? { kind: "review" as const } : {}) };
}

function parseTeamWorkView(value: unknown): TeamWorkView {
	if (!isRecord(value)) return protocol("work view must be an object");
	frameKeys(value, ["id", "requester", "assignee", "rootId", "parent", "depth", "currentRevision", "current", "children", "childrenOmitted", "revisions", "rejectedCandidates"], "work view");
	const childrenOmitted = value["childrenOmitted"] === undefined ? undefined : safeInteger(value["childrenOmitted"], "work view.childrenOmitted", 0);
	const children = array(value["children"], "work view.children", TEAM_MAX_PUBLIC_CHILDREN).map((item, index) => normalizeWorkRef(item, `work view.children[${index}]`));
	const revisions = array(value["revisions"], "work view.revisions", TEAM_BUDGET_PRESETS.unlimited.workRevisions).map((item, index) => {
		const field = `work view.revisions[${index}]`;
		if (!isRecord(item)) return protocol(`${field} must be an object`);
		frameKeys(item, ["revision", "state", "resultRef"], field);
		if (!(WORK_STATES as readonly unknown[]).includes(item["state"])) return protocol(`${field}.state is invalid`);
		return { revision: safeInteger(item["revision"], `${field}.revision`, 1), state: item["state"] as WorkState,
			...(item["resultRef"] !== undefined ? { resultRef: frameId(item["resultRef"], `${field}.resultRef`) } : {}) };
	});
	const rejectedCandidates = value["rejectedCandidates"] === undefined ? undefined : array(value["rejectedCandidates"], "work view.rejectedCandidates", TEAM_BUDGET_PRESETS.unlimited.workRevisions).map((item, index) => {
		const field = `work view.rejectedCandidates[${index}]`;
		if (!isRecord(item)) return protocol(`${field} must be an object`);
		frameKeys(item, ["revision", "reason", "summary"], field);
		return { revision: safeInteger(item["revision"], `${field}.revision`, 1), reason: text(item["reason"], `${field}.reason`, TEAM_MAX_NOTE_BYTES),
			summary: text(item["summary"], `${field}.summary`, TEAM_MAX_TEXT_ITEM_BYTES) };
	});
	const current = parseWorkVersion(value["current"], "work view.current");
	const currentRevision = safeInteger(value["currentRevision"], "work view.currentRevision", 1);
	if (current.revision !== currentRevision) return protocol("work view current revision does not match currentVersion");
	return { id: frameId(value["id"], "work view.id"), requester: normalizeAlias(value["requester"], "work view.requester"),
		assignee: normalizeAlias(value["assignee"], "work view.assignee"), rootId: frameId(value["rootId"], "work view.rootId"),
		...(value["parent"] !== undefined ? { parent: normalizeWorkRef(value["parent"], "work view.parent") } : {}),
		depth: safeInteger(value["depth"], "work view.depth", 0), currentRevision, current, children, revisions,
		...(childrenOmitted !== undefined ? { childrenOmitted } : {}),
		...(rejectedCandidates ? { rejectedCandidates } : {}) };
}

function parsePolicy(value: unknown, field: string): TeamMemberPolicy {
	if (!isRecord(value)) return protocol(`${field} must be a policy object`);
	frameKeys(value, ["model", "cwd", "fastMode", "searchMode", "contextWindow", "tools"], field);
	const policy: TeamMemberPolicy = {};
	for (const key of ["model", "cwd", "searchMode"] as const) {
		if (value[key] !== undefined) policy[key] = text(value[key], `${field}.${key}`, 4096);
	}
	if (value["fastMode"] !== undefined) {
		if (typeof value["fastMode"] !== "boolean") return protocol(`${field}.fastMode must be boolean`);
		policy.fastMode = value["fastMode"];
	}
	if (value["contextWindow"] !== undefined) policy.contextWindow = safeInteger(value["contextWindow"], `${field}.contextWindow`, 1);
	if (value["tools"] !== undefined) policy.tools = toolNames(value["tools"], `${field}.tools`);
	return policy;
}

function parseTeamTeamView(value: unknown): TeamTeamView {
	if (!isRecord(value)) return protocol("team view must be an object");
	frameKeys(value, ["version", "teamId", "lifecycle", "health", "stateVersion", "eventSeq", "lead", "timeoutSeconds", "deadline", "brief", "members", "works", "incidents", "incidentsOmitted", "budget", "usage", "outcome", "reason"], "team view");
	if (value["version"] !== TEAM_PROTOCOL_VERSION) return protocol("team view version is invalid");
	const lifecycle = value["lifecycle"];
	if (!["prepared", "active", "closing", "closed", "failed", "cancelled", "interrupted"].includes(String(lifecycle))) return protocol("team view lifecycle is invalid");
	const health = value["health"];
	if (health !== "ok" && health !== "needs_attention") return protocol("team view health is invalid");
	const lead = normalizeAlias(value["lead"], "team view.lead");
	const rawMembers = array(value["members"], "team view.members", TEAM_MAX_MEMBERS);
	if (rawMembers.length < 2) return protocol("team view must contain at least two members");
	const members: TeamMemberView[] = rawMembers.map((item, index) => {
		const field = `team view.members[${index}]`;
		if (!isRecord(item)) return protocol(`${field} must be an object`);
		frameKeys(item, ["id", "roleDescription", "lifecycle", "activity", "pause", "currentWork", "resourceState", "error", "queued", "blocked", "held", "policy", "usage"], field);
		const memberLifecycle = item["lifecycle"];
		if (!["starting", "open", "closing", "closed", "faulted"].includes(String(memberLifecycle))) return protocol(`${field}.lifecycle is invalid`);
		const activity = item["activity"];
		if (activity !== "idle" && activity !== "running" && activity !== "settling") return protocol(`${field}.activity is invalid`);
		const pause = item["pause"];
		if (pause !== "none" && pause !== "requested" && pause !== "confirmed") return protocol(`${field}.pause is invalid`);
		const resourceState = item["resourceState"];
		if (!["starting", "owned", "stopping", "released", "cleanup_failed"].includes(String(resourceState))) return protocol(`${field}.resourceState is invalid`);
		let error: MemberRecord["error"];
		if (item["error"] !== undefined) {
			const parsed = parseWorkError(item["error"], `${field}.error`);
			error = { code: parsed.code, message: parsed.message };
		}
		return { id: normalizeAlias(item["id"], `${field}.id`), roleDescription: text(item["roleDescription"], `${field}.roleDescription`, TEAM_MAX_ROLE_BYTES),
			lifecycle: memberLifecycle as MemberLifecycle, activity: activity as MemberActivity, pause: pause as PauseState,
			...(item["currentWork"] !== undefined ? { currentWork: normalizeWorkRef(item["currentWork"], `${field}.currentWork`) } : {}),
			resourceState: resourceState as ResourceState, ...(error ? { error } : {}),
			queued: safeInteger(item["queued"], `${field}.queued`, 0), blocked: safeInteger(item["blocked"], `${field}.blocked`, 0), held: safeInteger(item["held"], `${field}.held`, 0),
			policy: parsePolicy(item["policy"], `${field}.policy`), usage: parseUsage(item["usage"], `${field}.usage`) };
	});
	const roster = members.map((member) => member.id);
	if (new Set(roster).size !== roster.length || !roster.includes(lead)) return protocol("team view roster/lead identity is inconsistent");
	const brief = normalizeBrief(value["brief"], roster);
	const works = value["works"];
	if (!isRecord(works)) return protocol("team view works must be an object");
	frameKeys(works, ["total", "queued", "running", "blocked", "held", "resolved", "failed", "cancelled", "roots", "rootsReviewed"], "team view works");
	const counts = {} as TeamTeamView["works"];
	for (const key of ["total", "queued", "running", "blocked", "held", "resolved", "failed", "cancelled", "roots", "rootsReviewed"] as const) {
		counts[key] = safeInteger(works[key], `team view works.${key}`, 0);
	}
	if (counts.rootsReviewed > counts.roots) return protocol("team view reviewed root count exceeds root count");
	const rawBudget = value["budget"];
	if (!isRecord(rawBudget)) return protocol("team view budget must be an object");
	frameKeys(rawBudget, ["limits", "used", "exhausted", "roots", "rootsOmitted", "grants", "grantsOmitted"], "team view budget");
	if (!isRecord(rawBudget["limits"])) return protocol("team view budget.limits must be an object");
	frameKeys(rawBudget["limits"], Object.keys(DEFAULT_TEAM_BUDGET), "team view budget.limits");
	const limits = {} as TeamBudgetLimits;
	for (const key of Object.keys(DEFAULT_TEAM_BUDGET) as Array<keyof TeamBudgetLimits>) limits[key] = safeInteger(rawBudget["limits"][key], `team view budget.limits.${key}`, 0);
	if (!isRecord(rawBudget["used"])) return protocol("team view budget.used must be an object");
	frameKeys(rawBudget["used"], ["teamWorks", "teamActivations", "leadActivations", "teamModelRequests", "teamToolCalls", "emergencyLeadActivations", "reservedResultBytes"], "team view budget.used");
	const usedKeys = ["teamWorks", "teamActivations", "leadActivations", "teamModelRequests", "teamToolCalls", "emergencyLeadActivations", "reservedResultBytes"] as const;
	const used = {} as TeamTeamView["budget"]["used"];
	for (const key of usedKeys) used[key] = safeInteger(rawBudget["used"][key], `team view budget.used.${key}`, 0);
	if (typeof rawBudget["exhausted"] !== "boolean") return protocol("team view budget.exhausted must be boolean");
	const outcome = value["outcome"];
	if (outcome !== undefined && outcome !== "succeeded" && outcome !== "partial" && outcome !== "failed") return protocol("team view outcome is invalid");
	const reason = value["reason"] === undefined ? undefined : text(value["reason"], "team view.reason", TEAM_MAX_NOTE_BYTES);
	const timeoutSeconds = value["timeoutSeconds"];
	if (timeoutSeconds !== null && (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > TEAM_MAX_TIMEOUT_SECONDS)) return protocol("team view timeoutSeconds is invalid");
	const deadline = value["deadline"];
	if (deadline !== null && (typeof deadline !== "number" || !Number.isFinite(deadline) || deadline < 0)) return protocol("team view deadline is invalid");
	return { version: TEAM_PROTOCOL_VERSION, teamId: frameId(value["teamId"], "team view.teamId"), lifecycle: lifecycle as TeamTeamView["lifecycle"], health: health as Health,
		stateVersion: safeInteger(value["stateVersion"], "team view.stateVersion", 0), eventSeq: safeInteger(value["eventSeq"], "team view.eventSeq", 0),
		lead, timeoutSeconds, deadline, brief, members, works: counts,
		incidents: array(value["incidents"], "team view.incidents", TEAM_VIEW_MAX_INCIDENTS).map((incident, index) => parseIncident(incident, `team view.incidents[${index}]`)),
		incidentsOmitted: safeInteger(value["incidentsOmitted"], "team view.incidentsOmitted", 0),
		budget: { limits, used, exhausted: rawBudget["exhausted"],
			roots: array(rawBudget["roots"], "team view budget.roots", TEAM_VIEW_MAX_BUDGET_ROOTS).map((root, index) => parseRootBudget(root, `team view budget.roots[${index}]`)),
			rootsOmitted: safeInteger(rawBudget["rootsOmitted"], "team view budget.rootsOmitted", 0),
			grants: array(rawBudget["grants"], "team view budget.grants", TEAM_VIEW_MAX_GRANTS).map((grant, index) => parseGrant(grant, `team view budget.grants[${index}]`)),
			grantsOmitted: safeInteger(rawBudget["grantsOmitted"], "team view budget.grantsOmitted", 0) },
		usage: parseUsage(value["usage"], "team view.usage"),
		...(outcome !== undefined ? { outcome } : {}), ...(reason !== undefined ? { reason } : {}) };
}

function parseUsage(value: unknown, field: string): SubagentUsage {
	if (!isRecord(value)) return protocol(`${field} must be an object`);
	frameKeys(value, ["input", "output", "cacheRead", "cacheWrite", "cost", "contextTokens", "turns", "searches"], field);
	const number = (key: string): number => {
		const raw = value[key];
		if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return protocol(`${field}.${key} must be a finite non-negative number`);
		return raw;
	};
	return { input: number("input"), output: number("output"), cacheRead: number("cacheRead"), cacheWrite: number("cacheWrite"), cost: number("cost"),
		contextTokens: number("contextTokens"), turns: number("turns"), ...(value["searches"] !== undefined ? { searches: number("searches") } : {}) };
}

function parseRootBudget(value: unknown, field: string): TeamRootBudgetView {
	if (!isRecord(value)) return protocol(`${field} must be an object`);
	frameKeys(value, ["rootId", "used", "limits"], field);
	const used = value["used"];
	const limits = value["limits"];
	if (!isRecord(used) || !isRecord(limits)) return protocol(`${field} used/limits must be objects`);
	frameKeys(used, ["rootActivations", "rootModelRequests", "rootToolCalls", "rootChildren"], `${field}.used`);
	frameKeys(limits, ROOT_GRANTABLE_COUNTERS, `${field}.limits`);
	return { rootId: frameId(value["rootId"], `${field}.rootId`),
		used: { rootActivations: safeInteger(used["rootActivations"], `${field}.used.rootActivations`, 0),
			rootModelRequests: safeInteger(used["rootModelRequests"], `${field}.used.rootModelRequests`, 0),
			rootToolCalls: safeInteger(used["rootToolCalls"], `${field}.used.rootToolCalls`, 0),
			rootChildren: safeInteger(used["rootChildren"], `${field}.used.rootChildren`, 0) },
		limits: Object.fromEntries(ROOT_GRANTABLE_COUNTERS.map((key) => [key, safeInteger(limits[key], `${field}.limits.${key}`, 0)])) as TeamRootBudgetView["limits"] };
}

export function normalizeTeamBudgetGrantRecord(value: unknown, field = "journal grant"): TeamBudgetGrantView {
	return parseGrant(value, field);
}

function parseGrant(value: unknown, field: string): TeamBudgetGrantView {
	if (!isRecord(value)) return protocol(`${field} must be an object`);
	frameKeys(value, ["id", "actor", "scope", "increments", "reason", "at", "preset"], field);
	if (value["actor"] !== "@host") return protocol(`${field}.actor must be @host`);
	const scope = value["scope"];
	if (!isRecord(scope)) return protocol(`${field}.scope must be an object`);
	let parsedScope: TeamBudgetGrantView["scope"];
	if (scope["kind"] === "team") { frameKeys(scope, ["kind"], `${field}.scope`); parsedScope = { kind: "team" }; }
	else if (scope["kind"] === "root") { frameKeys(scope, ["kind", "rootId"], `${field}.scope`); parsedScope = { kind: "root", rootId: frameId(scope["rootId"], `${field}.scope.rootId`) }; }
	else return protocol(`${field}.scope.kind is invalid`);
	const increments = value["increments"];
	if (!isRecord(increments)) return protocol(`${field}.increments must be an object`);
	const preset = value["preset"] === undefined ? undefined : normalizeTeamBudgetPreset(value["preset"]);
	if (preset && parsedScope.kind !== "team") return protocol(`${field}.preset requires Team scope`);
	const allowed: readonly string[] = preset ? Object.keys(TEAM_BUDGET_PRESETS[preset])
		: parsedScope.kind === "team" ? TEAM_GRANTABLE_COUNTERS : ROOT_GRANTABLE_COUNTERS;
	frameKeys(increments, allowed, `${field}.increments`);
	const parsedIncrements: TeamBudgetGrantView["increments"] = {};
	for (const [key, raw] of Object.entries(increments)) (parsedIncrements as Record<string, number>)[key] = safeInteger(raw, `${field}.increments.${key}`, 1);
	return { id: frameId(value["id"], `${field}.id`), actor: "@host", scope: parsedScope, increments: parsedIncrements, ...(preset ? { preset } : {}),
		reason: text(value["reason"], `${field}.reason`, 512), at: safeInteger(value["at"], `${field}.at`, 0) };
}

function parseStatusPage(value: unknown): TeamStatusPage {
	if (!isRecord(value)) return protocol("status page must be an object");
	frameKeys(value, ["view", "items", "cursor", "hasMore"], "status page");
	const view = value["view"];
	if (view !== "work" && view !== "result" && view !== "incident") return protocol("status page view is invalid");
	const rawItems = array(value["items"], "status page.items", TEAM_STATUS_MAX_LIMIT);
	const items: TeamStatusPage["items"] = view === "work" ? rawItems.map(parseWorkSummary)
		: view === "result" ? rawItems.map((item) => {
			if (!isRecord(item)) return protocol("result summary must be an object");
			frameKeys(item, ["id", "work", "author", "status", "summaryPreview"], "result summary");
			const status = item["status"];
			if (status !== "succeeded" && status !== "partial" && status !== "failed") return protocol("result summary status is invalid");
			return { id: frameId(item["id"], "result summary.id"), work: normalizeWorkRef(item["work"], "result summary.work"),
				author: normalizeAlias(item["author"], "result summary.author"), status,
				summaryPreview: text(item["summaryPreview"], "result summary.summaryPreview", TEAM_MAX_TEXT_ITEM_BYTES) };
		}) : rawItems.map((item, index) => parseIncident(item, `incident summary[${index}]`));
	if (typeof value["hasMore"] !== "boolean") return protocol("status page hasMore must be boolean");
	const cursor = value["cursor"] === undefined ? undefined : normalizeId(value["cursor"], "status page.cursor");
	return { view, items, ...(cursor !== undefined ? { cursor } : {}), hasMore: value["hasMore"] };
}

function parseReceipt(value: unknown): TeamReceipt {
	if (!isRecord(value)) return protocol("team reply receipt must be an object");
	switch (value["status"]) {
		case "accepted":
			frameKeys(value, ["status", "work", "recipient", "paused"], "accepted receipt");
			if (value["paused"] !== undefined && value["paused"] !== true) return protocol("accepted receipt paused must be true when present");
			return { status: "accepted", work: normalizeWorkRef(value["work"], "receipt.work"), recipient: normalizeAlias(value["recipient"], "receipt.recipient"), ...(value["paused"] === true ? { paused: true } : {}) };
		case "staged": {
			frameKeys(value, ["status", "intent", "work"], "staged receipt");
			const intent = value["intent"];
			if (!["reply", "yield_dependencies", "yield_attention", "idle", "close_team"].includes(String(intent))) return protocol("staged receipt intent is invalid");
			return { status: "staged", intent: intent as Extract<TeamReceipt, { status: "staged" }>["intent"], ...(value["work"] !== undefined ? { work: normalizeWorkRef(value["work"], "receipt.work") } : {}) };
		}
		case "applied": case "unchanged": {
			frameKeys(value, ["status", "command", "work", "memberId"], "control receipt");
			if (typeof value["command"] !== "string" || !Object.hasOwn(CONTROL_FIELDS, value["command"])) return protocol("control receipt command is invalid");
			return { status: value["status"], command: value["command"] as TeamControl["command"],
				...(value["work"] !== undefined ? { work: normalizeWorkRef(value["work"], "receipt.work") } : {}),
				...(value["memberId"] !== undefined ? { memberId: normalizeAlias(value["memberId"], "receipt.memberId") } : {}) };
		}
		case "closing":
			frameKeys(value, ["status", "command", "memberId", "closeId"], "closing receipt");
			if (value["command"] !== "close_member" && value["command"] !== "close_team") return protocol("closing receipt command is invalid");
			return { status: "closing", command: value["command"], ...(value["memberId"] !== undefined ? { memberId: normalizeAlias(value["memberId"], "receipt.memberId") } : {}), closeId: frameId(value["closeId"], "receipt.closeId") };
		default: return protocol("team reply receipt status is invalid");
	}
}

function parseReplyData(value: unknown): TeamReplyData {
	if (!isRecord(value)) return protocol("team reply data must be an object");
	if (value["version"] === TEAM_PROTOCOL_VERSION && value["teamId"] !== undefined) return parseTeamTeamView(value);
	if (value["view"] !== undefined && value["items"] !== undefined) return parseStatusPage(value);
	if (value["author"] !== undefined && value["result"] !== undefined) return normalizeResultRecord(value);
	if (value["current"] !== undefined && value["currentRevision"] !== undefined) return parseTeamWorkView(value);
	if (value["code"] !== undefined && value["createdAt"] !== undefined) return parseIncident(value);
	return protocol("team reply data does not match a public Team data type");
}

/** Validate a public TeamReply produced by the runtime (child side, before showing it to the model). */
function parseTeamReplyInternal(value: unknown): TeamReply {
	try { checkFrameSize(value); } catch { return protocol("team reply is not valid bounded JSON"); }
	if (!isRecord(value) || value["from"] !== "@hub" || typeof value["to"] !== "string") return protocol("team reply is invalid");
	const to = normalizeAlias(value["to"], "team reply.to");
	if (value["ok"] === true) {
		frameKeys(value, ["ok", "from", "to", "receipt", "data"], "team reply");
		return { ok: true, from: "@hub", to,
			...(value["receipt"] !== undefined ? { receipt: parseReceipt(value["receipt"]) } : {}),
			...(value["data"] !== undefined ? { data: parseReplyData(value["data"]) } : {}) };
	}
	if (value["ok"] !== false) return protocol("team reply ok must be boolean");
	frameKeys(value, ["ok", "from", "to", "error"], "team reply");
	return { ok: false, from: "@hub", to, error: parseTeamError(value["error"]) };
}

export function parseTeamReply(value: unknown): TeamReply {
	return privateBoundary(() => parseTeamReplyInternal(value), "Team reply");
}

function parseActivationInput(value: unknown, binding: BindingV2, deliveryId: string): ActivationInput {
	if (!isRecord(value) || value["version"] !== TEAM_PROTOCOL_VERSION || value["teamId"] !== binding.teamId || value["deliveryId"] !== deliveryId) {
		return protocol("activation input does not match its binding/delivery");
	}
	frameKeys(value, ["version", "teamId", "deliveryId", "member", "goal", "roster", "scope", "outcomes", "omittedOutcomes", "childIssues", "childIssuesOmitted", "ownedChildren", "ownedChildrenOmitted", "budget", "notice"], "activation input");
	const member = value["member"];
	if (!isRecord(member)) return protocol("activation input member is malformed");
	frameKeys(member, ["id", "lead", "roleDescription"], "activation input member");
	if (member["id"] !== binding.memberId) return protocol("activation input member does not match binding");
	if (typeof member["lead"] !== "boolean") return protocol("activation input member lead must be boolean");
	const lead = member["lead"];
	const roleDescription = text(member["roleDescription"], "activation input member.roleDescription", TEAM_MAX_ROLE_BYTES);
	const roster = array(value["roster"], "activation input.roster", TEAM_MAX_MEMBERS).map((raw, index) => {
		const field = `activation input.roster[${index}]`;
		if (!isRecord(raw)) return protocol(`${field} must be an object`);
		frameKeys(raw, ["id", "lead", "lifecycle"], field);
		if (raw["lead"] !== undefined && raw["lead"] !== true) return protocol(`${field}.lead must be true when present`);
		if (!["starting", "open", "closing", "closed", "faulted"].includes(String(raw["lifecycle"]))) return protocol(`${field}.lifecycle is invalid`);
		return { id: normalizeAlias(raw["id"], `${field}.id`), ...(raw["lead"] === true ? { lead: true as const } : {}), lifecycle: raw["lifecycle"] as MemberLifecycle };
	});
	const rosterIds = roster.map((item) => item.id);
	if (!rosterIds.includes(binding.memberId) || new Set(rosterIds).size !== rosterIds.length || roster.filter((item) => item.lead).length !== 1
		|| roster.find((item) => item.id === binding.memberId)?.lead !== (lead || undefined)) return protocol("activation input roster is inconsistent");
	const goal = text(value["goal"], "activation input.goal", TEAM_MAX_TEXT_ITEM_BYTES);
	const rawScope = value["scope"];
	if (!isRecord(rawScope)) return protocol("activation input scope is malformed");
	let scope: ActivationInput["scope"];
	if (rawScope["kind"] === "work") {
		frameKeys(rawScope, ["kind", "work", "task", "requester", "rootId", "parent", "depth", "inputRefs", "waitingFor", "checkpoint", "resumeInstruction", "previous"], "activation input work scope");
		const previous = rawScope["previous"];
		let previousView: Extract<ActivationInput["scope"], { kind: "work" }>["previous"];
		if (previous !== undefined) {
			if (!isRecord(previous)) return protocol("activation input previous revision is malformed");
			frameKeys(previous, ["revision", "state", "checkpoint", "resultRef", "error"], "activation input previous revision");
			if (!(WORK_STATES as readonly unknown[]).includes(previous["state"])) return protocol("activation input previous state is invalid");
			const checkpoint = previous["checkpoint"] === undefined ? undefined : text(previous["checkpoint"], "activation input previous.checkpoint", TEAM_MAX_NOTE_BYTES);
			previousView = { revision: safeInteger(previous["revision"], "activation input previous.revision", 1), state: previous["state"] as WorkState,
				...(checkpoint !== undefined ? { checkpoint } : {}),
				...(previous["resultRef"] !== undefined ? { resultRef: frameId(previous["resultRef"], "activation input previous.resultRef") } : {}),
				...(previous["error"] !== undefined ? { error: parseWorkError(previous["error"], "activation input previous.error") } : {}) };
		}
		const checkpoint = rawScope["checkpoint"] === undefined ? undefined : text(rawScope["checkpoint"], "activation input checkpoint", TEAM_MAX_NOTE_BYTES);
		const resumeInstruction = rawScope["resumeInstruction"] === undefined ? undefined : text(rawScope["resumeInstruction"], "activation input resumeInstruction", TEAM_MAX_NOTE_BYTES);
		const waitingFor = array(rawScope["waitingFor"], "activation input waitingFor", TEAM_MAX_WAITING_FOR).map((item, index) => normalizeWorkRef(item, `activation input waitingFor[${index}]`));
		if (new Set(waitingFor.map((ref) => `${ref.workId}@${ref.revision}`)).size !== waitingFor.length) return protocol("activation input waitingFor contains duplicates");
		scope = { kind: "work", work: normalizeWorkRef(rawScope["work"], "activation input work"),
			task: text(rawScope["task"], "activation input task", TEAM_MAX_DELIVERED_TASK_BYTES), requester: normalizeAlias(rawScope["requester"], "activation input requester"),
			rootId: frameId(rawScope["rootId"], "activation input rootId"),
			...(rawScope["parent"] !== undefined ? { parent: normalizeWorkRef(rawScope["parent"], "activation input parent") } : {}),
			depth: safeInteger(rawScope["depth"], "activation input depth", 0),
			inputRefs: idList(rawScope["inputRefs"], "activation input inputRefs", TEAM_MAX_INPUT_REFS), waitingFor,
			...(checkpoint !== undefined ? { checkpoint } : {}), ...(resumeInstruction !== undefined ? { resumeInstruction } : {}),
			...(previousView ? { previous: previousView } : {}) };
	} else if (rawScope["kind"] === "events") {
		if (!lead) return protocol("only the lead may receive events activations");
		frameKeys(rawScope, ["kind", "eventBatchId", "events", "checkpoint", "emergency"], "activation input events scope");
		if (typeof rawScope["emergency"] !== "boolean") return protocol("activation input emergency must be boolean");
		const events = array(rawScope["events"], "activation input events", TEAM_MAX_EVENT_BATCH).map((raw, index): TeamEventView => {
			const field = `activation input events[${index}]`;
			if (!isRecord(raw)) return protocol(`${field} must be an object`);
			frameKeys(raw, ["id", "kind", "message", "actor", "work", "memberId", "incidentId", "resultRef"], field);
			if (!(TEAM_EVENT_KINDS as readonly unknown[]).includes(raw["kind"])) return protocol(`${field}.kind is invalid`);
			if (raw["actor"] !== undefined && (raw["actor"] !== "@host" || raw["kind"] !== "USER_COMMAND")) return protocol(`${field}.actor is only valid as @host on USER_COMMAND`);
			return { id: frameId(raw["id"], `${field}.id`), kind: raw["kind"] as TeamEventView["kind"],
				message: text(raw["message"], `${field}.message`, TEAM_MAX_EVENT_MESSAGE_BYTES),
				...(raw["actor"] === "@host" ? { actor: "@host" as const } : {}),
				...(raw["work"] !== undefined ? { work: normalizeWorkRef(raw["work"], `${field}.work`) } : {}),
				...(raw["memberId"] !== undefined ? { memberId: normalizeAlias(raw["memberId"], `${field}.memberId`) } : {}),
				...(raw["incidentId"] !== undefined ? { incidentId: frameId(raw["incidentId"], `${field}.incidentId`) } : {}),
				...(raw["resultRef"] !== undefined ? { resultRef: frameId(raw["resultRef"], `${field}.resultRef`) } : {}) };
		});
		if (events.length === 0 || new Set(events.map((event) => event.id)).size !== events.length) return protocol("events activation batch must be non-empty and unique");
		const checkpoint = rawScope["checkpoint"] === undefined ? undefined : text(rawScope["checkpoint"], "activation input checkpoint", TEAM_MAX_NOTE_BYTES);
		scope = { kind: "events", eventBatchId: frameId(rawScope["eventBatchId"], "activation input eventBatchId"), events,
			...(checkpoint !== undefined ? { checkpoint } : {}), emergency: rawScope["emergency"] };
	} else return protocol("activation input scope kind is invalid");
	const outcomes = array(value["outcomes"], "activation input outcomes", TEAM_MAX_DELIVERED_OUTCOMES).map((raw, index): OutcomeView => {
		const field = `activation input outcomes[${index}]`;
		if (!isRecord(raw)) return protocol(`${field} must be an object`);
		frameKeys(raw, ["work", "state", "resultRef", "error", "preview"], field);
		const state = raw["state"];
		if (state !== "resolved" && state !== "failed" && state !== "cancelled" && state !== "superseded") return protocol(`${field}.state is invalid`);
		let preview: OutcomeView["preview"];
		if (raw["preview"] !== undefined) {
			if (!isRecord(raw["preview"])) return protocol(`${field}.preview must be an object`);
			frameKeys(raw["preview"], ["status", "summary"], `${field}.preview`);
			const status = raw["preview"]["status"];
			if (status !== "succeeded" && status !== "partial" && status !== "failed") return protocol(`${field}.preview.status is invalid`);
			preview = { status, summary: text(raw["preview"]["summary"], `${field}.preview.summary`, TEAM_MAX_TEXT_ITEM_BYTES) };
		}
		return { work: normalizeWorkRef(raw["work"], `${field}.work`), state,
			...(raw["resultRef"] !== undefined ? { resultRef: frameId(raw["resultRef"], `${field}.resultRef`) } : {}),
			...(raw["error"] !== undefined ? { error: parseWorkError(raw["error"], `${field}.error`) } : {}), ...(preview ? { preview } : {}) };
	});
	if (new Set(outcomes.map((outcome) => workRefKey(outcome.work))).size !== outcomes.length) return protocol("activation input outcomes contain duplicates");
	const previews = outcomes.filter((outcome) => outcome.preview);
	if (previews.length > TEAM_MAX_DEPENDENCY_PREVIEWS || jsonBytes(previews) > TEAM_MAX_DEPENDENCY_PREVIEW_BYTES) return protocol("activation dependency previews exceed their limit");
	const ownedChildrenOmitted = value["ownedChildrenOmitted"] === undefined ? undefined : safeInteger(value["ownedChildrenOmitted"], "activation input.ownedChildrenOmitted", 0);
	const ownedChildren = array(value["ownedChildren"], "activation input.ownedChildren", TEAM_MAX_PUBLIC_CHILDREN).map((raw, index) => {
		const field = `activation input.ownedChildren[${index}]`;
		if (!isRecord(raw)) return protocol(`${field} must be an object`);
		frameKeys(raw, ["work", "state"], field);
		if (!(WORK_STATES as readonly unknown[]).includes(raw["state"])) return protocol(`${field}.state is invalid`);
		return { work: normalizeWorkRef(raw["work"], `${field}.work`), state: raw["state"] as WorkState };
	});
	if (new Set(ownedChildren.map((child) => workRefKey(child.work))).size !== ownedChildren.length) return protocol("activation ownedChildren contains duplicates");
	if (scope.kind === "events" && (ownedChildren.length || ownedChildrenOmitted)) return protocol("events activation cannot have owned children");
	const omittedOutcomes = safeInteger(value["omittedOutcomes"], "activation input.omittedOutcomes", 0);
	const childIssues = value["childIssues"] === undefined ? undefined : parseChildIssues(value["childIssues"], "activation input.childIssues", TEAM_MAX_CHILD_ISSUES);
	const childIssuesOmitted = value["childIssuesOmitted"] === undefined ? undefined : safeInteger(value["childIssuesOmitted"], "activation input.childIssuesOmitted", 0);
	if (scope.kind === "events" && (childIssues?.length || childIssuesOmitted)) return protocol("events activation cannot have child issues");
	const rawBudget = value["budget"];
	if (!isRecord(rawBudget)) return protocol("activation input budget must be an object");
	frameKeys(rawBudget, ["emergency", "modelRequests", "toolCalls", "activations"], "activation input budget");
	if (typeof rawBudget["emergency"] !== "boolean" || rawBudget["emergency"] !== (scope.kind === "events" && scope.emergency)) {
		return protocol("activation input budget emergency must match its scope");
	}
	const budget = { emergency: rawBudget["emergency"], modelRequests: safeInteger(rawBudget["modelRequests"], "activation input budget.modelRequests", 0),
		toolCalls: safeInteger(rawBudget["toolCalls"], "activation input budget.toolCalls", 0),
		activations: safeInteger(rawBudget["activations"], "activation input budget.activations", 0) };
	const input: ActivationInput = { version: TEAM_PROTOCOL_VERSION, teamId: binding.teamId, deliveryId,
		member: { id: binding.memberId, lead, roleDescription }, goal, roster, scope, outcomes, omittedOutcomes, ownedChildren, budget,
		...(childIssues ? { childIssues } : {}), ...(childIssuesOmitted !== undefined ? { childIssuesOmitted } : {}),
		...(ownedChildrenOmitted !== undefined ? { ownedChildrenOmitted } : {}),
		notice: text(value["notice"], "activation input.notice", TEAM_MAX_NOTE_BYTES) };
	if (jsonBytes(input) > TEAM_MAX_ACTIVATION_INPUT_BYTES) return protocol("activation input exceeds its size limit");
	return input;
}

/** Validate a parent -> child command (child side). */
function parseParentCommandInternal(value: unknown): ParentCommand {
	checkFrameSize(value);
	if (!isRecord(value)) return protocol("command must be an object");
	frameVersion(value);
	const commandId = frameId(value["commandId"], "commandId");
	const binding = parseBinding(value["binding"]);
	switch (value["operation"]) {
		case "bind": {
			frameKeys(value, ["version", "commandId", "operation", "binding", "loadout"], "bind");
			const loadout = value["loadout"];
			if (!isRecord(loadout) || loadout["teamTool"] !== true) return protocol("bind.loadout is invalid");
			frameKeys(loadout, ["tools", "teamTool", "brief", "roster"], "bind.loadout");
			const roster = array(loadout["roster"], "bind.loadout.roster", TEAM_MAX_MEMBERS).map((raw, index) => {
				const field = `bind.loadout.roster[${index}]`;
				if (!isRecord(raw)) return protocol(`${field} must be an object`);
				frameKeys(raw, ["id", "rolePreview"], field);
				return { id: normalizeAlias(raw["id"], `${field}.id`), rolePreview: text(raw["rolePreview"], `${field}.rolePreview`, TEAM_MAX_ROLE_BYTES) };
			});
			if (!roster.some((item) => item.id === binding.memberId)) return protocol("bind.loadout.roster must include the bound member");
			return { version: TEAM_PROTOCOL_VERSION, commandId, operation: "bind", binding,
				loadout: { tools: loadout["tools"] === null ? null : toolNames(loadout["tools"], "bind.loadout.tools"), teamTool: true,
					brief: normalizeBrief(loadout["brief"], roster.map((item) => item.id)), roster } };
		}
		case "activate": {
			frameKeys(value, ["version", "commandId", "operation", "binding", "activation", "deliveryId", "input"], "activate");
			const activation = parseActivationScope(value["activation"]);
			const deliveryId = frameId(value["deliveryId"], "deliveryId");
			const input = parseActivationInput(value["input"], binding, deliveryId);
			if ((activation.kind === "work" && (input.scope.kind !== "work" || !sameWorkRef(activation.work!, input.scope.work)))
				|| (activation.kind === "events" && (input.scope.kind !== "events" || activation.eventBatchId !== input.scope.eventBatchId))) {
				return protocol("activation input scope does not match the activation frame");
			}
			return { version: TEAM_PROTOCOL_VERSION, commandId, operation: "activate", binding, activation, deliveryId,
				input };
		}
		case "reply": {
			frameKeys(value, ["version", "commandId", "operation", "binding", "activation", "rpcRequestId", "reply"], "reply");
			const reply = value["reply"];
			let parsed: PrivateReply;
			if (!isRecord(reply)) return protocol("reply payload is invalid");
			if (reply["kind"] === "business") parsed = { kind: "business", reply: parseTeamReply(reply["reply"]) };
			else if (reply["kind"] === "gate") parsed = { kind: "gate", decision: parseGateDecision(reply["decision"]) };
			else if (reply["kind"] === "ack") parsed = { kind: "ack" };
			else return protocol("reply kind is invalid");
			return { version: TEAM_PROTOCOL_VERSION, commandId, operation: "reply", binding, activation: parseActivationScope(value["activation"]),
				rpcRequestId: frameId(value["rpcRequestId"], "rpcRequestId"), reply: parsed };
		}
		case "deactivate":
			frameKeys(value, ["version", "commandId", "operation", "binding", "activation"], "deactivate");
			return { version: TEAM_PROTOCOL_VERSION, commandId, operation: "deactivate", binding, activation: parseActivationScope(value["activation"]) };
		case "unbind":
			frameKeys(value, ["version", "commandId", "operation", "binding"], "unbind");
			return { version: TEAM_PROTOCOL_VERSION, commandId, operation: "unbind", binding };
	}
	return protocol("command operation is invalid");
}

export function parseParentCommand(value: unknown): ParentCommand {
	return privateBoundary(() => parseParentCommandInternal(value), "Parent command");
}

/**
 * Project optional activation context without dropping the current task or permissions. Runtime
 * must record delivery from the returned outcomes, not from the unprojected candidate list.
 */
export function projectActivationInput(input: ActivationInput): ActivationInput {
	const projected = structuredClone(input);
	const children = projectOwnedChildren(input.ownedChildren);
	projected.ownedChildren = children.ownedChildren;
	projected.ownedChildrenOmitted = (input.ownedChildrenOmitted ?? 0) + children.ownedChildrenOmitted!;
	if (projected.scope.kind === "work" && projected.scope.previous?.error) {
		projected.scope.previous.error = projectWorkError(projected.scope.previous.error);
	}
	if (projected.scope.kind === "events") {
		for (const event of projected.scope.events) event.message = projectErrorText(event.message, TEAM_MAX_EVENT_MESSAGE_BYTES);
	}
	for (const outcome of projected.outcomes) if (outcome.error) outcome.error = projectWorkError(outcome.error);
	if (projected.childIssues) {
		const omitted = (input.childIssuesOmitted ?? 0) + Math.max(0, projected.childIssues.length - TEAM_MAX_CHILD_ISSUES);
		projected.childIssues = projected.childIssues.slice(0, TEAM_MAX_CHILD_ISSUES)
			.map((issue) => ({ ...issue, message: projectErrorText(issue.message, TEAM_MAX_CHILD_ISSUE_MESSAGE_BYTES) }));
		if (omitted) projected.childIssuesOmitted = omitted;
	}
	projected.omittedOutcomes += Math.max(0, projected.outcomes.length - TEAM_MAX_DELIVERED_OUTCOMES);
	projected.outcomes = projected.outcomes.slice(0, TEAM_MAX_DELIVERED_OUTCOMES);
	// The preview budget includes its outcome metadata (including any failure diagnostic).
	const previews = projected.outcomes.filter((outcome) => outcome.preview);
	while (previews.length > TEAM_MAX_DEPENDENCY_PREVIEWS) delete previews.pop()!.preview;
	while (jsonBytes(previews) > TEAM_MAX_DEPENDENCY_PREVIEW_BYTES) {
		const longest = previews.reduce((left, right) => jsonTextBytes(left.preview!.summary) >= jsonTextBytes(right.preview!.summary) ? left : right);
		const size = jsonTextBytes(longest.preview!.summary);
		if (size > 64) {
			// Keep the preview count when a shorter summary can leave room for exact refs/metadata.
			longest.preview!.summary = previewText(longest.preview!.summary,
				Math.max(64, size - (jsonBytes(previews) - TEAM_MAX_DEPENDENCY_PREVIEW_BYTES)));
		} else delete previews.pop()!.preview;
	}
	// Optional previews/child listings yield space before actual dependency outcomes do.
	while (jsonBytes(projected) > TEAM_MAX_ACTIVATION_INPUT_BYTES) {
		const preview = projected.outcomes.findLast((outcome) => outcome.preview);
		if (preview) { delete preview.preview; continue; }
		if (projected.ownedChildren.length) {
			projected.ownedChildren.pop();
			projected.ownedChildrenOmitted++;
			continue;
		}
		if (projected.outcomes.length) {
			projected.outcomes.pop();
			projected.omittedOutcomes++;
			continue;
		}
		break;
	}
	encodeActivationInput(projected); // Mandatory scope/brief/task overflow remains an explicit rejection.
	return projected;
}

/** Serialize an activation input, enforcing its transport limit. */
export function encodeActivationInput(input: ActivationInput): string {
	const bytes = jsonBytes(input);
	const json = JSON.stringify(input);
	if (bytes > TEAM_MAX_ACTIVATION_INPUT_BYTES) {
		throw new TeamProtocolError("INPUT_BUDGET_EXCEEDED", `activation input exceeds ${TEAM_MAX_ACTIVATION_INPUT_BYTES} bytes`);
	}
	return json;
}

export function okReply(to: string, fields: { receipt?: Extract<TeamReply, { ok: true }>["receipt"]; data?: Extract<TeamReply, { ok: true }>["data"] } = {}): TeamReply {
	return { ok: true, from: "@hub", to, ...(fields.receipt ? { receipt: fields.receipt } : {}), ...(fields.data ? { data: fields.data } : {}) };
}

export function errorReply(to: string, error: unknown): Extract<TeamReply, { ok: false }> {
	const source = error instanceof TeamProtocolError ? error.toTeamError()
		: { code: "PROTOCOL_FAILURE" as const, message: error instanceof Error ? error.message : String(error) };
	const teamError: TeamError = {
		code: source.code,
		message: projectErrorText(source.message),
		...(source.blockers?.length ? { blockers: source.blockers.slice(0, 32).map((blocker) => ({
			kind: projectErrorText(blocker.kind, 128),
			...(blocker.id !== undefined ? { id: blocker.id } : {}),
			reason: projectErrorText(blocker.reason),
		})) } : {}),
	};
	return { ok: false, from: "@hub", to, error: teamError };
}
