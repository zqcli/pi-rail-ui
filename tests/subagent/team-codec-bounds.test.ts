import assert from "node:assert/strict";
import { test } from "node:test";
import { Check } from "typebox/value";
import {
	errorReply, jsonBytes, jsonTextBytes, normalizeTeamAction, parseParentCommand, parseTeamReply,
	projectActivationInput, projectErrorText, projectOwnedChildren, projectWorkChildren, projectWorkError,
	TEAM_TOOL_SCHEMA, TeamProtocolError,
} from "../../tools/subagents/team-codec";
import {
	TEAM_MAX_ACTION_BYTES, TEAM_MAX_ACTIVATION_INPUT_BYTES, TEAM_MAX_FRAME_BYTES, TEAM_MAX_NOTE_BYTES,
	TEAM_MAX_OWNED_CHILD_PREVIEWS, TEAM_MAX_PUBLIC_CHILDREN, TEAM_MAX_TEXT_ITEM_BYTES, TEAM_STATUS_MAX_LIMIT,
	type ActivationInput, type BindingV2, type ParentCommand, type TeamWorkSummary, type TeamWorkView, type WorkRef,
} from "../../tools/subagents/team-protocol";

const binding: BindingV2 = { version: 2, teamId: "team", memberId: "owner", role: "worker", epoch: "epoch" };
const work: WorkRef = { workId: "root", revision: 1 };
function input(): ActivationInput {
	return {
		version: 2, teamId: "team", deliveryId: "delivery", member: { id: "owner", role: "worker", roleDescription: "Do the work." },
		brief: { goal: "Keep all accepted work." },
		roster: [
			{ id: "lead", role: "manager", lifecycle: "open", rolePreview: "Manage." },
			{ id: "owner", role: "worker", lifecycle: "open", rolePreview: "Work." },
		],
		scope: { kind: "work", work, task: "Required task", requester: "lead", rootId: "root", depth: 0, inputRefs: [], waitingFor: [] },
		outcomes: [], omittedOutcomes: 0, ownedChildren: [],
		budget: { emergency: false, modelRequests: 1, toolCalls: 1, activations: 1 }, notice: "Only the current work is authorized.",
	};
}
function activate(value: ActivationInput): ParentCommand {
	return { version: 2, commandId: "activate", operation: "activate", binding,
		activation: { activationId: "activation", kind: "work", work }, deliveryId: "delivery", input: value };
}
function workView(): TeamWorkView {
	return { id: "root", requester: "lead", assignee: "owner", rootId: "root", depth: 0, currentRevision: 1,
		current: { revision: 1, task: "Required task", inputRefs: [], state: "failed", waitingFor: [], observedOutcomes: [], createdAt: 0, updatedAt: 1 },
		children: [], revisions: [{ revision: 1, state: "failed" }] };
}
const protocolFailure = (error: unknown) => error instanceof TeamProtocolError && error.code === "PROTOCOL_FAILURE";
const invalidArgument = (error: unknown) => error instanceof TeamProtocolError && error.code === "INVALID_ARGUMENT";

test("6 KiB provider/host errors need bounded output projection, not relaxed private validation", () => {
	for (const message of ["proxy failure: " + "x".repeat(6000), "代理错误😀\n".repeat(1200), "\u0000".repeat(2000), "\ud800", "  "]) {
		const raw = { code: "NATIVE_FAILURE", message, outcomeUnknown: true };
		const error = projectWorkError(raw);
		assert.equal(error.code, raw.code);
		assert.equal(error.outcomeUnknown, true);
		assert.ok(error.message.isWellFormed());
		assert.ok(error.message.trim());
		assert.ok(jsonTextBytes(error.message) <= TEAM_MAX_NOTE_BYTES);
		if (jsonTextBytes(message) > TEAM_MAX_NOTE_BYTES) assert.match(error.message, /\[truncated\]$/u);
		const original = input();
		original.outcomes = [{ work: { workId: "child", revision: 1 }, state: "failed", error: raw }];
		assert.throws(() => parseParentCommand(activate(original)), protocolFailure);
		const projected = projectActivationInput(original);
		assert.deepEqual(parseParentCommand(activate(projected)), activate(projected));
		assert.deepEqual(original.outcomes[0]!.error, raw, "projection must not mutate the ledger's diagnostic");
		const view = workView();
		view.current.error = error;
		assert.doesNotThrow(() => parseTeamReply({ ok: true, from: "@hub", to: "owner", data: view }));
	}
	assert.deepEqual(projectWorkError({ code: "CUSTOM_HOST_CODE", message: "exact\nmessage", outcomeUnknown: false }),
		{ code: "CUSTOM_HOST_CODE", message: "exact\nmessage", outcomeUnknown: false });
});

test("error replies and ACK diagnostics remain valid for empty, malformed-Unicode and escaped host errors", () => {
	for (const message of ["", "\ud800", "\n".repeat(6000)]) {
		const reply = errorReply("owner", new TeamProtocolError("CLEANUP_FAILED", message, [{ kind: "resource", id: "child", reason: message }]));
		assert.deepEqual(parseTeamReply(reply), reply);
		assert.ok(jsonTextBytes(projectErrorText(message)) <= TEAM_MAX_NOTE_BYTES);
	}
});

test("65 and 512 owned children project to bounded previews, with complete refs in parent-labelled work pages", () => {
	for (const count of [65, 512]) {
		const children = Array.from({ length: count }, (_, index) => ({ workId: `child-${index}`, revision: 1 }));
		const original = input();
		original.ownedChildren = children.map((child) => ({ work: child, state: "resolved" }));
		assert.throws(() => parseParentCommand(activate(original)), protocolFailure, "raw ledger arrays must not be sent");
		const projected = projectActivationInput(original);
		assert.equal(projected.ownedChildren.length, TEAM_MAX_OWNED_CHILD_PREVIEWS);
		assert.equal(projected.ownedChildrenOmitted, count - TEAM_MAX_OWNED_CHILD_PREVIEWS);
		assert.deepEqual(projected.scope, original.scope);
		assert.deepEqual(parseParentCommand(activate(projected)), activate(projected));
		assert.equal(original.ownedChildren.length, count);
		const view = { ...workView(), ...projectWorkChildren(children) };
		assert.equal(view.children.length, TEAM_MAX_PUBLIC_CHILDREN);
		assert.equal(view.childrenOmitted, count - TEAM_MAX_PUBLIC_CHILDREN);
		assert.doesNotThrow(() => parseTeamReply({ ok: true, from: "@hub", to: "owner", data: view }));
		const allRefs: WorkRef[] = [];
		for (let offset = 0; offset < count; offset += TEAM_STATUS_MAX_LIMIT) {
			const items: TeamWorkSummary[] = children.slice(offset, offset + TEAM_STATUS_MAX_LIMIT).map((child) => ({
				work: child, parent: work, requester: "owner", assignee: "lead", state: "resolved", taskPreview: "Child task",
			}));
			const hasMore = offset + items.length < count;
			const page = { view: "work" as const, items, hasMore, ...(hasMore ? { cursor: `page:${offset + items.length}` } : {}) };
			assert.deepEqual(parseTeamReply({ ok: true, from: "@hub", to: "owner", data: page }), { ok: true, from: "@hub", to: "owner", data: page });
			allRefs.push(...items.filter((item) => item.parent?.workId === work.workId && item.parent.revision === work.revision).map((item) => item.work));
		}
		assert.deepEqual(allRefs, children, "codec preserves every page's exact owner revision and child reference");
	}
});

test("activation projection budgets combined errors and previews, without dropping mandatory task/brief or claiming omitted delivery", () => {
	const original = input();
	original.scope = { ...original.scope, kind: "work", work, requester: "lead", rootId: "root", depth: 0, inputRefs: [], waitingFor: [],
		task: "T".repeat(8192), previous: { revision: 1, state: "failed", error: { code: "HOST_FAILURE", message: "x".repeat(6000), outcomeUnknown: true } } };
	original.brief = { goal: "G".repeat(8192), constraints: ["C".repeat(8192), "D".repeat(8192)] };
	original.ownedChildren = Array.from({ length: 65 }, (_, i) => ({ work: { workId: `child-${i}`, revision: 1 }, state: "failed" }));
	original.outcomes = original.ownedChildren.slice(0, 32).map(({ work }) => ({ work, state: "failed",
		error: { code: "NATIVE_FAILURE", message: "X".repeat(6000), outcomeUnknown: true }, preview: { status: "failed", summary: "failure" } }));
	const projected = projectActivationInput(original);
	assert.ok(jsonBytes(projected) <= TEAM_MAX_ACTIVATION_INPUT_BYTES);
	assert.equal(projected.scope.kind === "work" && projected.scope.task, "T".repeat(8192));
	assert.deepEqual(projected.brief, original.brief);
	assert.ok(projected.outcomes.length > 0 && projected.omittedOutcomes > 0);
	assert.equal(projected.outcomes.length + projected.omittedOutcomes, original.outcomes.length);
	assert.equal(projected.ownedChildren.length + projected.ownedChildrenOmitted!, 65);
	assert.deepEqual(projected.outcomes.map(({ work }) => work), original.outcomes.slice(0, projected.outcomes.length).map(({ work }) => work));
	assert.deepEqual(projectActivationInput(projected), projected, "projection is idempotent");
	assert.doesNotThrow(() => parseParentCommand(activate(projected)));
	const impossible = input();
	impossible.scope = { ...original.scope, task: "T".repeat(TEAM_MAX_ACTIVATION_INPUT_BYTES) };
	assert.throws(() => projectActivationInput(impossible), (error: unknown) => error instanceof TeamProtocolError && error.code === "INPUT_BUDGET_EXCEEDED");
});

test("the model-facing schema requires a checkpoint on work yields, as the Runtime does", () => {
	const ref = { workId: "work:1", revision: 1 };
	assert.equal(Check(TEAM_TOOL_SCHEMA, { action: "yield", waitingFor: [ref] }), false);
	assert.equal(Check(TEAM_TOOL_SCHEMA, { action: "yield", attention: "decide scope" }), false);
	assert.equal(Check(TEAM_TOOL_SCHEMA, { action: "yield", waitingFor: [ref], checkpoint: "step 1 done" }), true);
	assert.equal(Check(TEAM_TOOL_SCHEMA, { action: "yield", attention: "decide scope", checkpoint: "step 1 done" }), true);
	assert.equal(Check(TEAM_TOOL_SCHEMA, { action: "yield" }), true, "the Manager's plain yield stays valid");
});

test("schema-valid ~1.32 MB result is INVALID_ARGUMENT before a private frame can be built", () => {
	const text = "x".repeat(TEAM_MAX_TEXT_ITEM_BYTES);
	const list = Array.from({ length: 32 }, () => text);
	const action = { action: "reply", result: { status: "failed", summary: text, findings: list, limitations: list, artifacts: list,
		evidence: list.map((source) => ({ source, locator: source, basis: "observed" })) } };
	assert.equal(Check(TEAM_TOOL_SCHEMA, action), true);
	assert.ok(jsonBytes(action) > TEAM_MAX_FRAME_BYTES);
	assert.throws(() => normalizeTeamAction(action), invalidArgument);
	assert.ok(TEAM_MAX_ACTION_BYTES < TEAM_MAX_FRAME_BYTES);
});

test("business normalization rejects UTF-8, escaped-content and combined-result overflows independently of schema", () => {
	for (const action of [
		{ action: "request", to: "lead", task: "中".repeat(3000) },
		{ action: "request", to: "lead", task: "\n".repeat(5000) },
		{ action: "request", to: "lead", task: "\ud800" },
		{ action: "reply", result: { status: "succeeded", summary: "x".repeat(8000), findings: ["y".repeat(8000)] } },
		{ action: "status", extra: "forged" },
		[],
	]) assert.throws(() => normalizeTeamAction(action), invalidArgument);
	assert.deepEqual(normalizeTeamAction({ action: "control", command: "pause_member", memberId: "owner" }),
		{ action: "control", control: { command: "pause_member", memberId: "owner" } });
});

test("omission metadata is strict, and projection retains detached copies of child references", () => {
	const child = { work: { workId: "child", revision: 1 }, state: "queued" as const };
	const projection = projectOwnedChildren([child]);
	projection.ownedChildren[0]!.work.revision = 2;
	assert.equal(child.work.revision, 1);
	for (const omitted of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
		assert.throws(() => parseParentCommand(activate({ ...input(), ownedChildrenOmitted: omitted })), protocolFailure);
		assert.throws(() => parseTeamReply({ ok: true, from: "@hub", to: "owner", data: { ...workView(), childrenOmitted: omitted } }), protocolFailure);
	}
});
