import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import install, { parseTeamCommand, publicTeamReply, strictTeamRequest, TEAM_DELIVERY_TYPE, TEAM_FRAME_BYTES } from "../../tools/subagents/team-extension";
import { TEAM_COMMAND, TEAM_ENTRY_TYPE, type TeamBinding } from "../../tools/subagents/team-protocol";

const binding: TeamBinding = { version: 1, teamId: "t", memberId: "b", role: "worker", epoch: "private-epoch" };
const structuredResult = {
	status: "partial" as const, summary: "Checked the assigned files", findings: ["One finding"],
	evidence: [{ source: "local test", locator: "case-1", basis: "verified" as const }], limitations: ["No integration run"], artifacts: ["report.md"],
};
function harness(role: TeamBinding["role"] = "worker", branch: any[] = []) {
	const runtimeBinding = { ...binding, role };
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const entries: any[] = [];
	const deliveries: any[] = [];
	let active = ["read", "subagent"];
	let aborted = 0;
	const controller = new AbortController();
	const ctx = { signal: controller.signal, abort: () => { aborted++; controller.abort(); }, isIdle: () => true, sessionManager: { getBranch: () => branch } };
	const pi = {
		on: (name: string, fn: any) => handlers.set(name, fn),
		registerCommand: (name: string, def: any) => commands.set(name, def),
		registerTool: (def: any) => tools.set(def.name, def),
		getAllTools: () => [...tools.values()],
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
		appendEntry: (_type: string, data: any) => entries.push(data),
		sendMessage: (message: any, options: any) => deliveries.push({ message, options }),
	};
	install(pi as unknown as ExtensionAPI);
	const command = (operation: string, extra = {}) => commands.get(TEAM_COMMAND).handler(JSON.stringify({ version: 1, commandId: `c${entries.length}`, operation, binding: runtimeBinding, ...extra }), ctx);
	return { handlers, tools, entries, deliveries, branch, ctx, controller, command, active: () => active, aborted: () => aborted };
}

test("strict team parser rejects sender injection, extra fields and UTF-8 overflow", () => {
	assert.equal(strictTeamRequest({ requestId: "r", sequence: 1, action: "send", to: "a", message: "hello" }), true);
	assert.equal(strictTeamRequest({ requestId: "r", sequence: 2, action: "send", to: "a", message: "hello", replyTo: "t:1", supersedes: "t:0" }), true);
	assert.equal(strictTeamRequest({ requestId: "r", sequence: 3, action: "wait", wait: { kind: "message", from: "a" } }), true);
	assert.equal(strictTeamRequest({ requestId: "r", sequence: 4, action: "finish", message: "candidate" }), true);
	assert.equal(strictTeamRequest({ requestId: "r", sequence: 5, action: "finish", result: structuredResult }), true);
	for (const input of [
		{ action: "send", to: "a", message: "x", sender: "a" },
		{ action: "send", to: "a", message: "x", from: "a" },
		{ action: "send", to: "a", message: "中".repeat(3000) },
		{ action: "wait", wait: { kind: "member" } },
		{ action: "wait", wait: { kind: "workers", from: "a" } },
		{ action: "finish", wait: { kind: "message" } },
		{ action: "finish", message: "candidate", result: structuredResult },
		{ action: "finish", result: { status: "done", summary: "invalid" } },
		{ action: "send", to: "a", message: "x", revision: 1 },
		{ action: "control", to: "a", command: "redirect" },
		{ action: "send", to: "a", message: "" },
		{ action: "send", to: "a", message: "  " },
		{ action: "send", to: "a", message: "hello", wait: null },
		{ action: "wait", wait: { kind: "message", member: null } },
		{ action: "wait", wait: { kind: "message", afterSeq: null } },
	]) assert.equal(strictTeamRequest({ requestId: "r", sequence: 1, ...input }), false);
	assert.throws(() => parseTeamCommand(JSON.stringify({ version: 1, operation: "bind", commandId: "c", binding, surprise: true })));
	assert.throws(() => parseTeamCommand("{"));
	assert.throws(() => publicTeamReply({ ok: true, events: Array(65).fill({ seq: 1, kind: "message" }) }));
	assert.equal(JSON.stringify(publicTeamReply({ ok: true, events: [{ seq: 1, kind: "message", message: "hi", epoch: "secret" }] })).includes("secret"), false);
});

test("public replies preserve strict routing, receipts, v2 events and scoped snapshots without private binding data", () => {
	const result = { ...structuredResult, evidence: [{ source: "test", locator: "line-1", basis: "verified" as const, epoch: "hidden" }] };
	const reply = {
		ok: true, from: "b", to: "a", requestId: "request-7", revision: 4,
		receipt: { status: "queued", messageId: "t:9", recipient: "a", seq: 9 },
		events: [{ version: 2, messageId: "t:9", timestamp: 1700000000000, from: "b", to: "a", replyTo: "t:8", supersedes: "t:7", seq: 9, kind: "message", message: "READY", epoch: "hidden" },
			{ seq: 10, kind: "state", member: "b", state: "running" }],
		snapshot: {
			id: "t", coordinator: "a", workers: ["b"], phase: "running", seq: 10, createdAt: 1, deadline: 100,
			brief: { goal: "Complete the assigned review", target: "module", acceptanceCriteria: ["Report findings"], constraints: ["Stay in scope"],
				authorizations: [{ member: "b", allowed: ["read"], forbidden: ["write"], epoch: "hidden" }], epoch: "hidden" },
			members: [
				{ id: "a", role: "coordinator", state: "running" },
				{ id: "b", role: "worker", state: "running", assignment: { memberId: "b", task: "Review module", epoch: "hidden" }, result, instructionRevision: 4, observedRevision: 3, epoch: "hidden" },
			], events: [{ seq: 10, kind: "state", member: "b", state: "running" }], epoch: "hidden",
		},
	};
	const projected = publicTeamReply(reply);
	assert.deepEqual(projected.from, "b");
	assert.deepEqual(projected.to, "a");
	assert.deepEqual(projected.requestId, "request-7");
	assert.deepEqual(projected.receipt, reply.receipt);
	assert.deepEqual(projected.events?.[0], { version: 2, messageId: "t:9", timestamp: 1700000000000, replyTo: "t:8", supersedes: "t:7", seq: 9, kind: "message", from: "b", to: "a", message: "READY" });
	assert.deepEqual(projected.events?.[1], { seq: 10, kind: "state", member: "b", state: "running" });
	assert.equal(projected.snapshot?.brief?.goal, "Complete the assigned review");
	assert.deepEqual(projected.snapshot?.members[1]?.assignment, { memberId: "b", task: "Review module" });
	assert.deepEqual(projected.snapshot?.members[1]?.result?.evidence, [{ source: "test", locator: "line-1", basis: "verified" }]);
	assert.equal(projected.snapshot?.members[1]?.instructionRevision, 4);
	assert.equal(projected.snapshot?.members[1]?.observedRevision, 3);
	assert.doesNotMatch(JSON.stringify(projected), /hidden|epoch|binding/);
	assert.deepEqual(publicTeamReply({ ok: true, from: "@hub", to: "b", requestId: "control-1", receipt: { status: "applied", recipient: "b", seq: 11 } }).receipt,
		{ status: "applied", recipient: "b", seq: 11 });
	const routedReply = { ...projected, from: "@hub", to: "b" };
	const command = parseTeamCommand(JSON.stringify({ version: 1, commandId: "c1", operation: "reply", binding, requestId: "request-7", reply: routedReply }));
	assert.equal(command.operation, "reply");
	if (command.operation === "reply") assert.deepEqual(command.reply, routedReply, "v1 wire framing preserves the additive public reply schema");
	assert.throws(() => parseTeamCommand(JSON.stringify({ version: 1, commandId: "c2", operation: "reply", binding, requestId: "other", reply: routedReply })), /Mismatched team reply request id/);
	assert.throws(() => parseTeamCommand(JSON.stringify({ version: 1, commandId: "c3", operation: "reply", binding, requestId: "request-7", reply: { ...routedReply, from: "b" } })), /Mismatched team reply routing/);

	for (const mutate of [
		(value: any) => { value.from = ""; },
		(value: any) => { value.requestId = null; },
		(value: any) => { value.receipt.status = "sent"; },
		(value: any) => { value.receipt.seq = -1; },
		(value: any) => { delete value.receipt.recipient; },
		(value: any) => { value.events[0].version = 3; },
		(value: any) => { value.events[0].timestamp = -1; },
		(value: any) => { value.events[0].messageId = "t:10"; },
		(value: any) => { delete value.events[0].from; },
		(value: any) => { value.snapshot.members[1].assignment.fastMode = "yes"; },
		(value: any) => { value.snapshot.members[1].result.status = "unknown"; },
		(value: any) => { value.snapshot.members[1].instructionRevision = -1; },
		(value: any) => { value.code = "stale_instruction"; },
		(value: any) => { value.events[0].unexpected = true; },
	]) {
		const invalid = structuredClone(reply);
		mutate(invalid);
		assert.throws(() => publicTeamReply(invalid));
	}
	assert.throws(() => publicTeamReply({ ...reply, ok: false, code: "other" }));
	assert.throws(() => publicTeamReply({ ...reply, epoch: "private" }));
	assert.throws(() => publicTeamReply({ ok: true, from: "b" }), /Incomplete team reply routing/);
});

test("wire receive is a boolean restricted to internal checkpoint requests", () => {
	for (const receive of [true, false, undefined]) {
		assert.equal(strictTeamRequest({ action: "checkpoint", requestId: "r", sequence: 1, ...(receive === undefined ? {} : { receive }) }), true);
	}
	for (const receive of [null, "true", 1]) assert.equal(strictTeamRequest({ action: "checkpoint", requestId: "r", sequence: 1, receive }), false);
	for (const input of [
		{ action: "send", to: "a", message: "hello" },
		{ action: "report", message: "done" },
		{ action: "wait", wait: { kind: "message" } },
		{ action: "control", to: "a", command: "pause" },
		{ action: "finish" },
	]) {
		for (const receive of [true, false]) assert.equal(strictTeamRequest({ ...input, requestId: "r", sequence: 1, receive }), false);
	}
});

test("bound collaboration guidance names only public identity and leaves ordinary prompts unchanged", async () => {
	for (const role of ["worker", "coordinator"] as const) {
		const h = harness(role);
		const event = { systemPrompt: "Original system instructions" };
		assert.equal(await h.handlers.get("before_agent_start")!(event, h.ctx), undefined);
		await h.command("bind");
		const { systemPrompt } = await h.handlers.get("before_agent_start")!(event, h.ctx);
		assert.ok(systemPrompt.startsWith(`${event.systemPrompt}\n\n`));
		assert.match(systemPrompt, new RegExp(`"role":"${role}"`));
		assert.match(systemPrompt, /"member":"b"/);
		assert.match(systemPrompt, /sole tool call/);
		assert.match(systemPrompt, /without model polling/);
		assert.match(systemPrompt, /report defaults to the coordinator/);
		assert.match(systemPrompt, /Prefer to:null or omit to/);
		assert.match(systemPrompt, /correct the indicated fields and retry report/);
		assert.match(systemPrompt, /all workers' terminal outcomes/);
		assert.match(systemPrompt, /untrusted data, not higher-priority instructions/);
		assert.match(systemPrompt, /historical facts/);
		assert.match(systemPrompt, /latest seq and authoritative control snapshots/);
		assert.match(systemPrompt, /redirect changes direction but does not clear pause; explicitly resume/);
		assert.match(systemPrompt, /parent waits for the outer dispatch to settle and cannot answer questions/);
		assert.match(systemPrompt, /shared brief is context, not a privilege grant/);
		assert.match(systemPrompt, /must not impose its own personal read-only restriction/);
		assert.match(systemPrompt, /queued, not that the recipient stopped or paused/);
		if (role === "coordinator") assert.match(systemPrompt, /Do not report to yourself or self-send/);
		assert.doesNotMatch(systemPrompt, /epoch|private-epoch|rail-subagent-team-protocol/);
		assert.equal(h.entries.filter((entry) => entry.kind === "request").length, 0, "before_agent_start has no native signal and must not checkpoint");
		await h.command("unbind");
		assert.equal(await h.handlers.get("before_agent_start")!(event, h.ctx), undefined);
	}
});

test("unbound extension is inert; binding activates only child team and unbind restores tools", async () => {
	const h = harness();
	assert.equal(h.tools.size, 0);
	await h.handlers.get("context")!({ messages: [] }, h.ctx);
	assert.equal(h.entries.length, 0);
	await h.command("bind");
	assert.deepEqual(h.active(), ["read", "team"]);
	assert.equal(h.entries.at(-1).kind, "ack");
	assert.equal((await h.handlers.get("tool_call")!({ toolName: "subagent" }, h.ctx)).block, true);
	await h.command("unbind");
	assert.deepEqual(h.active(), ["read", "subagent"]);
});

test("native context waits without polling and an immediate reply releases it with bounded public context", async () => {
	const h = harness();
	await h.command("bind");
	const waiting = h.handlers.get("context")!({ messages: [] }, h.ctx);
	const req = h.entries.at(-1);
	assert.equal(req.kind, "request");
	assert.equal(req.request.sequence, 1);
	assert.equal(req.request.receive, true);
	assert.deepEqual(req.binding, binding);
	await h.command("reply", { requestId: req.request.requestId, reply: { ok: true, events: [{ seq: 1, kind: "message", message: "continue" }] } });
	const result = await waiting;
	assert.match(JSON.stringify(result), /continue/);
	assert.doesNotMatch(JSON.stringify(result), /private-epoch/);
	assert.equal(h.aborted(), 0);
});

test("deliveries use native persistence once, repair missing IDs, and isolate binding lifetimes", async () => {
	const h = harness();
	await h.command("bind");
	const context = async (reply: any, messages: any[] = []) => {
		const result = h.handlers.get("context")!({ messages }, h.ctx);
		await h.command("reply", { requestId: h.entries.at(-1).request.requestId, reply });
		return await result;
	};
	const reply = { ok: true, events: [{ seq: 1, kind: "message", message: "READY" }] };
	const first = await context(reply);
	assert.equal(h.deliveries.length, 1);
	assert.deepEqual(h.deliveries[0].options, { triggerTurn: false });
	const message = h.deliveries[0].message;
	assert.equal(message.customType, TEAM_DELIVERY_TYPE);
	assert.equal(message.display, false);
	assert.deepEqual(Object.keys(message.details).sort(), ["deliveryId", "memberId", "teamId"]);
	assert.deepEqual(JSON.parse(message.content), reply);
	assert.deepEqual(first.messages, [message]);
	assert.doesNotMatch(JSON.stringify(message), /epoch|binding/);
	// Simulate the native writer's turn_end flush; before that there is no replay log.
	h.branch.push({ ...message, type: "custom_message", id: "native-delivery", timestamp: new Date().toISOString() });
	const projected = (await context({ ok: true }, first.messages))?.messages ?? first.messages;
	assert.equal(projected.length, 1, "visible ID is never duplicated");
	assert.equal(projected[0].details.deliveryId, message.details.deliveryId);
	assert.equal(projected[0].content, message.content);
	assert.equal(projected[0].timestamp, Date.parse(h.branch[0].timestamp), "native source supplies the canonical timestamp");
	assert.match(JSON.stringify(await context({ ok: true })), /READY/, "compacted/missing native context repaired from branch");
	assert.equal(h.deliveries.length, 1, "recovery never writes another native message");
	h.branch.push({ ...h.branch[0], id: "foreign", details: { ...message.details, teamId: "other", deliveryId: "foreign" }, content: '{"ok":true,"events":[{"seq":2,"kind":"message","message":"FOREIGN"}]}' });
	assert.doesNotMatch(JSON.stringify(await context({ ok: true })), /FOREIGN/);
	await h.command("unbind");
	assert.equal(await h.handlers.get("context")!({ messages: [] }, h.ctx), undefined);
	await h.command("bind");
	assert.match(JSON.stringify(await context({ ok: true })), /READY/, "same binding across sends preserves its origin");
	await h.command("unbind");
	const renewed = { ...binding, epoch: "new-private-epoch" };
	await h.command("bind", { binding: renewed });
	for (const messages of [[], first.messages]) {
		const next = h.handlers.get("context")!({ messages }, h.ctx);
		await h.command("reply", { binding: renewed, requestId: h.entries.at(-1).request.requestId, reply: { ok: true } });
		assert.deepEqual((await next)?.messages ?? messages, [], "new epoch must remove old visible facts as well as refuse recovery");
	}
});

test("context-edit omissions are not revived by durable team delivery recovery", async () => {
	const content = JSON.stringify({ ok: true, events: [{ seq: 1, kind: "message", message: "ORIGINAL-DELIVERY" }] });
	const branch = [
		{ id: "protocol", type: "custom", customType: TEAM_ENTRY_TYPE, data: { version: 1, kind: "ack", binding, ok: true } },
		{ id: "delivery", type: "custom_message", customType: TEAM_DELIVERY_TYPE, content, display: false,
			details: { teamId: "t", memberId: "b", deliveryId: "delivery" }, timestamp: new Date(1).toISOString() },
		{ id: "edit", type: "context_edit", targetId: "delivery", replacement: null, timestamp: new Date(2).toISOString() },
	];
	const h = harness("worker", branch);
	await h.command("bind");
	const waiting = h.handlers.get("context")!({ messages: [{ role: "custom", customType: TEAM_DELIVERY_TYPE, content, display: false,
		details: { teamId: "t", memberId: "b", deliveryId: "delivery" }, timestamp: 1 }] }, h.ctx);
	await h.command("reply", { requestId: h.entries.at(-1).request.requestId, reply: { ok: true } });
	const result = await waiting;

	assert.deepEqual(result.messages, []);
	assert.equal(branch[1]?.content, content, "recovery must not rewrite append-only native history");
});

test("durable team delivery recovery uses the latest context-edit replacement", async () => {
	const content = JSON.stringify({ ok: true, events: [{ seq: 1, kind: "message", message: "ORIGINAL-DELIVERY" }] });
	const branch = [
		{ id: "protocol", type: "custom", customType: TEAM_ENTRY_TYPE, data: { version: 1, kind: "ack", binding, ok: true } },
		{ id: "delivery", type: "custom_message", customType: TEAM_DELIVERY_TYPE, content, display: false,
			details: { teamId: "t", memberId: "b", deliveryId: "delivery" }, timestamp: new Date(1).toISOString() },
		{ id: "edit-1", type: "context_edit", targetId: "delivery", replacement: { content: "earlier replacement" }, timestamp: new Date(2).toISOString() },
		{ id: "edit-2", type: "context_edit", targetId: "delivery", replacement: { content: "latest replacement" }, timestamp: new Date(3).toISOString() },
	];
	const h = harness("worker", branch);
	await h.command("bind");
	const waiting = h.handlers.get("context")!({ messages: [] }, h.ctx);
	await h.command("reply", { requestId: h.entries.at(-1).request.requestId, reply: { ok: true } });
	const result = await waiting;

	assert.equal(result.messages.length, 1);
	assert.equal(result.messages[0]?.content, "latest replacement");
	assert.doesNotMatch(JSON.stringify(result.messages), /ORIGINAL-DELIVERY|earlier replacement/);
	assert.equal(branch[1]?.content, content, "recovery must not rewrite append-only native history");
});

test("reload recovers facts only with matching native protocol lifetime evidence", async () => {
	for (const evidence of [binding, { ...binding, epoch: "older-epoch" }, undefined]) {
		const branch: any[] = [
			...(evidence ? [{ id: "protocol", type: "custom", customType: TEAM_ENTRY_TYPE, data: { version: 1, kind: "ack", binding: evidence, ok: true } }] : []),
			{ id: "delivery", type: "custom_message", customType: TEAM_DELIVERY_TYPE, content: JSON.stringify({ ok: true, events: [{ seq: 1, kind: "message", message: "RELOAD-READY" }] }),
				details: { teamId: "t", memberId: "b", deliveryId: "delivery" }, timestamp: new Date().toISOString() },
		];
		const h = harness("worker", branch);
		await h.command("bind");
		for (const visible of [false, true]) {
			const entry = branch.at(-1);
			const messages = visible ? [{ ...entry, role: "custom", timestamp: Date.parse(entry.timestamp) }] : [];
			const result = h.handlers.get("context")!({ messages }, h.ctx);
			await h.command("reply", { requestId: h.entries.at(-1).request.requestId, reply: { ok: true } });
			const actual = (await result)?.messages ?? messages;
			if (evidence === binding) assert.match(JSON.stringify(actual), /RELOAD-READY/);
			else assert.deepEqual(actual, [], "public visible identity alone cannot establish an epoch boundary");
		}
		assert.equal(h.deliveries.length, 0);
	}
});

test("invalid native delivery history is skipped and valid history is projected before model use", async () => {
	const h = harness();
	await h.command("bind");
	const bad = ["not-json", JSON.stringify({ ok: "true" }), JSON.stringify({ ok: true, events: [{ seq: -1, kind: "message", message: "BAD" }] }),
		JSON.stringify({ ok: true, events: [{ seq: 1, kind: "message", message: "x".repeat(8193) }] }), JSON.stringify({ ok: true, binding }),
		JSON.stringify({ ok: false, error: "BAD" }), "x".repeat(TEAM_FRAME_BYTES + 1)];
	for (const [i, content] of [...bad, JSON.stringify({ ok: true, events: [{ seq: 2, kind: "message", message: "VALID", epoch: "private-leak", binding }] })].entries()) {
		h.branch.push({ id: `d${i}`, type: "custom_message", customType: TEAM_DELIVERY_TYPE, content, timestamp: new Date().toISOString(),
			details: { teamId: "t", memberId: "b", deliveryId: `d${i}`, epoch: "private-leak" } });
	}
	const original = JSON.stringify(h.branch);
	for (const visible of [false, true]) {
		const messages = visible ? h.branch.map((entry) => ({ ...entry, role: "custom", timestamp: Date.parse(entry.timestamp) })) : [];
		const result = h.handlers.get("context")!({ messages }, h.ctx);
		await h.command("reply", { requestId: h.entries.at(-1).request.requestId, reply: { ok: true } });
		const repaired = await result;
		assert.equal(repaired.messages.length, 1);
		assert.match(JSON.stringify(repaired), /VALID/);
		assert.doesNotMatch(JSON.stringify(repaired), /BAD|private-leak|private-epoch|binding/);
		assert.deepEqual(Object.keys(repaired.messages[0].details).sort(), ["deliveryId", "memberId", "teamId"]);
		assert.equal(JSON.stringify(h.branch), original, "validation must not rewrite native history");
	}
	assert.equal(h.aborted(), 0);
});

test("recovery retains a compact roster with at most 64 messages and a total frame-byte budget", async () => {
	for (const large of [false, true]) {
		const h = harness();
		await h.command("bind");
		const assignment = { memberId: "b", task: "Inspect assigned files" };
		const snapshot = { id: "t", coordinator: "a", workers: ["b"], phase: "running", seq: 1, createdAt: 1, deadline: 100,
			brief: { goal: "Review the assigned module", authorizations: [{ member: "b", allowed: ["read"] }] },
			members: [{ id: "a", role: "coordinator", state: "running", output: "obsolete-output" },
				{ id: "b", role: "worker", state: "running", assignment,
					result: { status: "partial", summary: "obsolete-result" }, instructionRevision: 3, observedRevision: 2 }], events: [] };
		const add = (id: string, data: any) => h.branch.push({ id, type: "custom_message", customType: TEAM_DELIVERY_TYPE, display: false, timestamp: new Date().toISOString(),
			content: JSON.stringify(data), details: { teamId: "t", memberId: "b", deliveryId: id } });
		add("roster", { ok: true, snapshot });
		for (let i = 0; i < 80; i++) add(`delivery-${i}`, { ok: true, events: Array.from({ length: large ? 16 : 1 }, (_, j) => ({ seq: i * 16 + j + 2, kind: "message", message: large ? "中".repeat(2000) : `READY-${i}` })) });
		const result = h.handlers.get("context")!({ messages: [] }, h.ctx);
		await h.command("reply", { requestId: h.entries.at(-1).request.requestId, reply: large ? { ok: true, events: [{ seq: 9999, kind: "message", message: "CURRENT" }] } : { ok: true } });
		const { messages } = await result;
		assert.ok(messages.length <= 64);
		if (!large) assert.equal(messages.length, 64);
		assert.ok(Buffer.byteLength(JSON.stringify(messages)) <= TEAM_FRAME_BYTES);
		assert.equal(new Set(messages.map((m: any) => m.details.deliveryId)).size, messages.length);
		assert.ok(messages.some((m: any) => m.details.deliveryId === "delivery-79"));
		assert.ok(!messages.some((m: any) => m.details.deliveryId === "delivery-0"));
		const roster = messages.find((m: any) => m.details.deliveryId === "roster");
		const compactRoster = JSON.parse(roster.content).snapshot;
		assert.equal(compactRoster.coordinator, "a");
		assert.deepEqual(compactRoster.brief, snapshot.brief);
		assert.deepEqual(compactRoster.members[1].assignment, assignment);
		assert.equal(compactRoster.members[1].instructionRevision, 3);
		assert.equal(compactRoster.members[1].observedRevision, 2);
		assert.equal(Object.hasOwn(compactRoster.members[1], "result"), false);
		assert.equal(Object.hasOwn(compactRoster.members[0], "output"), false);
		assert.doesNotMatch(roster.content, /obsolete-output|obsolete-result/);
		assert.equal(messages[0].details.deliveryId, "roster", "restoration preserves native delivery chronology");
		assert.equal(h.deliveries.length, large ? 1 : 0);
		if (large) assert.match(messages.at(-1).content, /CURRENT/);
	}
});

test("after native compaction only retained deliveries are repaired, plus the compact roster", async () => {
	const h = harness();
	await h.command("bind");
	const add = (id: string, data: any) => h.branch.push({ id, type: "custom_message", customType: TEAM_DELIVERY_TYPE, display: false, timestamp: new Date().toISOString(),
		content: JSON.stringify(data), details: { teamId: "t", memberId: "b", deliveryId: id } });
	const snapshot = { id: "t", coordinator: "a", workers: ["b"], phase: "running", seq: 1, createdAt: 1, deadline: 100,
		members: [{ id: "a", role: "coordinator", state: "running" }, { id: "b", role: "worker", state: "running", assignment: { memberId: "b", task: "Inspect" } }], events: [] };
	add("roster", { ok: true, events: [{ seq: 1, kind: "message", message: "ROSTER-EVENT" }], snapshot });
	for (let i = 0; i < 5; i++) add(`summarized-${i}`, { ok: true, events: [{ seq: i + 2, kind: "message", message: `SUMMARIZED-${i}` }] });
	h.branch.push({ id: "kept", type: "message", message: { role: "user", content: "kept" } });
	add("retained", { ok: true, events: [{ seq: 10, kind: "message", message: "RETAINED" }] });
	h.branch.push({ id: "compaction", type: "compaction", summary: "summary", firstKeptEntryId: "kept", tokensBefore: 1 });
	add("after", { ok: true, events: [{ seq: 11, kind: "message", message: "AFTER" }] });
	const result = h.handlers.get("context")!({ messages: [] }, h.ctx);
	await h.command("reply", { requestId: h.entries.at(-1).request.requestId, reply: { ok: true } });
	const text = JSON.stringify((await result).messages);
	assert.match(text, /RETAINED/);
	assert.match(text, /AFTER/);
	assert.doesNotMatch(text, /SUMMARIZED-/, "summarized deliveries stay summarized");
	assert.match(text, /Inspect/, "the compact roster keeps the assignment");
	assert.doesNotMatch(text, /ROSTER-EVENT/, "the compact roster drops its original events");
});

test("visible and missing deliveries share one native selection, byte/count cap and chronological unique IDs", async () => {
	for (const large of [false, true]) {
		const h = harness();
		await h.command("bind");
		for (let i = 0; i < 80; i++) h.branch.push({ id: `d${i}`, type: "custom_message", customType: TEAM_DELIVERY_TYPE, display: false,
			timestamp: new Date().toISOString(), details: { teamId: "t", memberId: "b", deliveryId: `d${i}` },
			content: JSON.stringify({ ok: true, events: Array.from({ length: large ? 4 : 1 }, (_, j) => ({ seq: i * 4 + j, kind: "message", message: large ? "中".repeat(2000) : `READY-${i}` })) }) });
		const visible = h.branch.slice(0, 60).map((entry) => ({ ...entry, role: "custom", timestamp: Date.parse(entry.timestamp) }));
		if (large) assert.ok(Buffer.byteLength(JSON.stringify(visible)) > TEAM_FRAME_BYTES, "fixture already exceeds the total byte budget");
		const unrelated = [{ role: "user", content: "preserve this", timestamp: 1 }, { role: "custom", customType: "other-extension", content: "also preserve", timestamp: 2 }];
		let expected: any[] | undefined;
		const original = JSON.stringify(h.branch);
		for (const existing of [[], visible, [...visible].reverse().concat(visible)]) {
			const forged = { ...visible[59], content: "FORGED-VISIBLE-CONTENT" };
			const unknown = { ...forged, details: { ...forged.details, deliveryId: "not-in-native-history" } };
			const input = [unrelated[0], ...existing, ...(existing.length ? [forged, unknown] : []), unrelated[1]];
			const result = h.handlers.get("context")!({ messages: input }, h.ctx);
			await h.command("reply", { requestId: h.entries.at(-1).request.requestId, reply: { ok: true } });
			const { messages } = await result;
			const deliveries = messages.filter((m: any) => m.customType === TEAM_DELIVERY_TYPE);
			assert.ok(deliveries.length <= 64);
			if (!large) assert.equal(deliveries.length, 64);
			assert.ok(Buffer.byteLength(JSON.stringify(deliveries)) <= TEAM_FRAME_BYTES);
			const ids = deliveries.map((m: any) => Number(m.details.deliveryId.slice(1)));
			assert.equal(new Set(ids).size, ids.length);
			assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
			assert.equal(ids.at(-1), 79);
			assert.doesNotMatch(JSON.stringify(deliveries), /FORGED-VISIBLE-CONTENT|not-in-native-history/);
			const retained = messages.filter((m: any) => m.customType !== TEAM_DELIVERY_TYPE);
			assert.equal(retained[0], unrelated[0]);
			assert.equal(retained[1], unrelated[1]);
			if (expected) assert.deepEqual(deliveries, expected, "visible slots cannot affect selection or authoritative content");
			else expected = deliveries;
		}
		assert.equal(h.deliveries.length, 0, "selection never persists history again");
		assert.equal(JSON.stringify(h.branch), original);
	}
});

test("wait/report-wait/finish reject mixed batch before release; worker control cannot forge role", async () => {
	const h = harness();
	await h.command("bind");
	h.branch.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "one" }, { type: "toolCall", id: "two" }] } });
	for (const params of [{ action: "wait", wait: { kind: "message" } }, { action: "report", to: "a", message: "done", wait: { kind: "message" } }, { action: "finish" }]) {
		await assert.rejects(h.tools.get("team").execute("one", params, h.ctx.signal, undefined, h.ctx), /sole tool/);
	}
	await assert.rejects(h.tools.get("team").execute("one", { action: "control", to: "a", command: "pause" }, undefined, undefined, h.ctx), /coordinator/);
	assert.equal(h.entries.filter((e) => e.kind === "request").length, 0);
});

test("abort and unbind release hung gates; negative checkpoint explicitly aborts despite swallowed handler errors", async () => {
	for (const mode of ["abort", "unbind", "denied"] as const) {
		const h = harness();
		await h.command("bind");
		const gate = h.handlers.get("context")!({ messages: [] }, h.ctx);
		const rejected = assert.rejects(gate);
		const req = h.entries.at(-1).request;
		if (mode === "abort") h.controller.abort();
		else if (mode === "unbind") await h.command("unbind");
		else await h.command("reply", { requestId: req.requestId, reply: { ok: false, error: "denied" } });
		await rejected;
		assert.ok(h.aborted() > 0);
	}
});

test("missing native signal fails closed without emitting an unabortable checkpoint", async () => {
	const h = harness();
	await h.command("bind");
	await assert.rejects(h.handlers.get("context")!({ messages: [] }, { ...h.ctx, signal: undefined }), /native abort signal/);
	assert.equal(h.entries.filter((entry) => entry.kind === "request").length, 0);
	assert.ok(h.aborted() > 0);
});

test("only context checkpoints receive messages; provider/tool checkpoints request permission without consuming", async () => {
	const h = harness();
	await h.command("bind");
	for (const event of ["before_provider_request", "tool_call"]) {
		const gate = h.handlers.get(event)!({ toolName: "read" }, h.ctx);
		const request = h.entries.at(-1).request;
		assert.equal(request.action, "checkpoint");
		assert.equal(request.receive, false);
		await h.command("reply", { requestId: request.requestId, reply: { ok: true } });
		await gate;
	}
	const context = h.handlers.get("context")!({ messages: [] }, h.ctx);
	assert.equal(h.entries.at(-1).request.receive, true);
	await h.command("reply", { requestId: h.entries.at(-1).request.requestId, reply: { ok: true, events: [{ seq: 1, kind: "message", message: "next-context" }] } });
	assert.match(JSON.stringify(await context), /next-context/);
	const next = h.handlers.get("context")!({ messages: [] }, h.ctx);
	await h.command("reply", { requestId: h.entries.at(-1).request.requestId, reply: { ok: true } });
	assert.equal(await next, undefined);
});

test("stale tool preflight blocks only the generated call and leaves redirected inbox messages for context", async () => {
	const h = harness();
	await h.command("bind");
	const initialContext = h.handlers.get("context")!({ messages: [] }, h.ctx);
	assert.equal(h.entries.at(-1).request.receive, true);
	await h.command("reply", { requestId: h.entries.at(-1).request.requestId, reply: { ok: true, revision: 5 } });
	await initialContext;

	h.branch.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "generated-read" }] } });
	const preflight = h.handlers.get("tool_call")!({ toolName: "read" }, h.ctx);
	const checkpoint = h.entries.at(-1).request;
	assert.equal(checkpoint.action, "checkpoint");
	assert.equal(checkpoint.receive, false);
	assert.equal(checkpoint.revision, 5);
	await h.command("reply", { requestId: checkpoint.requestId, reply: { ok: false, code: "stale_instruction", revision: 6, error: "redirected" } });
	const blocked = await preflight;
	assert.equal(blocked.block, true);
	assert.match(blocked.reason, /replan against the latest team direction/);
	assert.equal(blocked.terminate, undefined, "a redirect is recoverable and should trigger a fresh model plan");
	assert.equal(h.aborted(), 0);
	assert.equal(h.deliveries.length, 0, "permit-only stale reply cannot consume an inbox message");

	const nextContext = h.handlers.get("context")!({ messages: [] }, h.ctx);
	const receive = h.entries.at(-1).request;
	assert.equal(receive.action, "checkpoint");
	assert.equal(receive.receive, true);
	await h.command("reply", { requestId: receive.requestId, reply: { ok: true, revision: 6, events: [{ seq: 1, kind: "message", from: "a", to: "b", message: "redirected work" }] } });
	const contextResult = await nextContext;
	assert.match(JSON.stringify(contextResult), /redirected work/);
	assert.equal(h.deliveries.length, 1);
	assert.equal(h.aborted(), 0);
});

test("a helper returning consumed messages to a permit-only gate fails closed instead of losing the wakeup", async () => {
	const h = harness();
	await h.command("bind");
	const gate = h.handlers.get("before_provider_request")!({}, h.ctx);
	const rejected = assert.rejects(gate, /permit-only checkpoint/);
	await h.command("reply", { requestId: h.entries.at(-1).request.requestId, reply: { ok: true, events: [{ seq: 1, kind: "message", message: "must not be hidden" }] } });
	await rejected;
	assert.ok(h.aborted() > 0);
});

test("sole report-and-wait appends one atomic runtime request and unbind releases its promise", async () => {
	const h = harness();
	await h.command("bind");
	h.branch.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "one" }] } });
	const waiting = h.tools.get("team").execute("one", { action: "report", message: "milestone", wait: { kind: "message" } }, h.ctx.signal, undefined, h.ctx);
	const rejection = assert.rejects(waiting, /unbound/);
	const requests = h.entries.filter((entry) => entry.kind === "request");
	assert.equal(requests.length, 1);
	assert.equal(requests[0].request.action, "report");
	assert.deepEqual(requests[0].request.wait, { kind: "message" });
	await h.command("unbind");
	await rejection;
});

test("report accepts a coordinator to assertion and preserves it in the atomic report/wait wire request", async () => {
	assert.equal(strictTeamRequest({ requestId: "r", sequence: 1, action: "report", to: "a", message: "READY", wait: { kind: "message" } }), true);
	const h = harness();
	await h.command("bind");
	h.branch.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "one" }] } });
	for (const to of ["a", null, undefined]) {
		const params = Object.freeze({ action: "report", ...(to === undefined ? {} : { to }), message: "READY", wait: Object.freeze({ kind: "message", member: null, afterSeq: null }), command: null });
		const before = structuredClone(params);
		const result = h.tools.get("team").execute("one", params, h.ctx.signal, undefined, h.ctx);
		const request = h.entries.at(-1).request;
		assert.equal(request.action, "report", "must not downgrade to send");
		assert.equal(request.to, to ?? undefined);
		assert.equal(request.message, "READY");
		assert.deepEqual(request.wait, { kind: "message" });
		await h.command("reply", { requestId: request.requestId, reply: { ok: true, events: [{ seq: 1, kind: "message", from: "a", message: "CONTINUE" }] } });
		assert.match(JSON.stringify(await result), /CONTINUE/);
		assert.deepEqual(params, before);
	}
	assert.equal(h.aborted(), 0);
});

test("report preserves a wrong to for authoritative rejection and allows correction without abort", async () => {
	const h = harness();
	await h.command("bind");
	h.branch.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "one" }] } });
	const params = Object.freeze({ action: "report", to: "other-worker", message: "READY", wait: Object.freeze({ kind: "message" }) });
	const result = h.tools.get("team").execute("one", params, h.ctx.signal, undefined, h.ctx);
	const rejected = assert.rejects(result, /team report rejected: report\.to must match coordinator a/);
	const wrong = h.entries.at(-1).request;
	assert.equal(wrong.action, "report");
	assert.equal(wrong.to, "other-worker", "must not silently discard the assertion or downgrade to send");
	assert.deepEqual(wrong.wait, { kind: "message" });
	await h.command("reply", { requestId: wrong.requestId, reply: { ok: false, error: "report.to must match coordinator a" } });
	await rejected;
	assert.equal(h.aborted(), 0);
	const corrected = h.tools.get("team").execute("one", { ...params, to: "a" }, h.ctx.signal, undefined, h.ctx);
	await h.command("reply", { requestId: h.entries.at(-1).request.requestId, reply: { ok: true } });
	await corrected;
	assert.deepEqual(h.entries.filter((entry) => entry.kind === "request").map((entry) => entry.request.action), ["report", "report"]);
	assert.equal(params.to, "other-worker");
	assert.equal(h.aborted(), 0);
});

test("argument errors identify action and corrective fields without sending an empty report or entering wait", async () => {
	const h = harness();
	await h.command("bind");
	for (const [params, expected] of [
		[{ action: "report", to: "a", message: "", wait: { kind: "message" } }, /action=report:.*message cannot be empty/],
		[{ action: "report", to: "a", message: null, wait: { kind: "message" } }, /action=report:.*requires a non-empty message/],
		[{ action: "report", to: "a", message: "READY", wait: { kind: "message", member: "a" } }, /action=report:.*wait\.member.*message\/workers use member:null/],
		[{ action: "report", to: "a", message: "READY", command: "pause" }, /action=report:.*command must be null or omitted/],
		[{ action: "report", to: "a", message: "中".repeat(3000) }, /action=report:.*8192 UTF-8 bytes/],
		[{ action: "wait", wait: { kind: "message", member: "a" } }, /action=wait:.*wait\.member/],
		[{ action: "send", message: "hello" }, /action=send:.*requires non-empty to and message/],
		[{ action: "finish", to: "a" }, /action=finish:.*takes no to/],
		[{ action: "finish", message: "candidate", result: structuredResult }, /action=finish:.*message or structured result/],
	] as const) {
		const before = structuredClone(params);
		await assert.rejects(h.tools.get("team").execute("one", params, h.ctx.signal, undefined, h.ctx), expected);
		assert.deepEqual(params, before);
	}
	assert.equal(strictTeamRequest({ requestId: "r", sequence: 1, action: "report", to: "a", message: "READY", wait: { kind: "message", member: "a" } }), false);
	assert.equal(strictTeamRequest({ requestId: "r", sequence: 1, action: "report", to: "a", message: "READY", command: "pause" }), false);
	assert.equal(strictTeamRequest({ requestId: "r", sequence: 1, action: "wait", wait: { kind: "member", member: "a", from: "b" } }), false);
	assert.equal(h.entries.filter((entry) => entry.kind === "request").length, 0);
	assert.equal(h.aborted(), 0);
});

test("team optional schemas are nullable/default null and provider placeholders normalize before strict wire validation", async () => {
	const h = harness("coordinator");
	await h.command("bind");
	h.branch.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "one" }] } });
	const tool = h.tools.get("team");
	assert.match(tool.description, /report defaults to the coordinator/);
	assert.match(tool.parameters.properties.to.anyOf.find((schema: any) => schema.type === "string").description, /supplied to asserts the coordinator alias and must match it/);
	assert.equal(Object.hasOwn(tool.parameters.properties, "receive"), false);
	for (const name of ["to", "message", "replyTo", "supersedes", "result", "command", "wait"]) {
		assert.equal(tool.parameters.properties[name].default, null);
		assert.ok(tool.parameters.properties[name].anyOf.some((schema: any) => schema.type === "null"));
	}
	assert.equal(Object.hasOwn(tool.parameters.properties, "from"), false, "sender identity is runtime-bound, not model-selected");
	assert.equal(Object.hasOwn(tool.parameters.properties, "revision"), false, "context revision is internal to preflight");
	const waitSchema = tool.parameters.properties.wait.anyOf.find((schema: any) => schema.type === "object");
	for (const name of ["member", "from", "afterSeq"]) {
		assert.equal(waitSchema.properties[name].default, null);
		assert.ok(waitSchema.properties[name].anyOf.some((schema: any) => schema.type === "null"));
	}
	const resultSchema = tool.parameters.properties.result.anyOf.find((schema: any) => schema.type === "object");
	for (const name of ["findings", "evidence", "limitations", "artifacts"]) {
		assert.equal(resultSchema.properties[name].default, null);
		assert.ok(resultSchema.properties[name].anyOf.some((schema: any) => schema.type === "null"));
	}
	const evidenceSchema = resultSchema.properties.evidence.anyOf.find((schema: any) => schema.type === "array").items;
	assert.equal(evidenceSchema.properties.locator.default, null);
	assert.ok(evidenceSchema.properties.locator.anyOf.some((schema: any) => schema.type === "null"));
	const cases = [
		{ input: { action: "send", to: " a ", message: "  keep message spacing  ", replyTo: " t:1 ", supersedes: null, wait: null, command: null }, expected: { action: "send", to: "a", message: "  keep message spacing  ", replyTo: "t:1" } },
		{ input: { action: "wait", to: null, message: null, command: null, wait: { kind: "message", member: null, from: null, afterSeq: null } }, expected: { action: "wait", wait: { kind: "message" } } },
		{ input: { action: "wait", to: " ", message: "", command: "", wait: { kind: "message", member: " ", from: " a ", afterSeq: 0 } }, expected: { action: "wait", wait: { kind: "message", from: "a", afterSeq: 0 } } },
		{ input: { action: "report", to: "", message: "done", replyTo: "t:1", supersedes: "t:0", command: null, wait: { kind: "member", member: " a ", from: null, afterSeq: null } }, expected: { action: "report", message: "done", replyTo: "t:1", supersedes: "t:0", wait: { kind: "member", member: "a" } } },
		{ input: { action: "control", to: " a ", message: null, command: "pause", wait: null }, expected: { action: "control", to: "a", command: "pause" } },
		{ input: { action: "finish", to: "", message: "", command: "", wait: null }, expected: { action: "finish" } },
		{ input: { action: "finish", to: null, message: "candidate", result: null, command: null, wait: null }, expected: { action: "finish", message: "candidate" } },
		{ input: { action: "finish", to: null, message: null, result: { ...structuredResult, findings: null, evidence: [{ source: "test", basis: "verified", locator: null }], limitations: null, artifacts: null }, command: null, wait: null },
			expected: { action: "finish", result: { status: "partial", summary: "Checked the assigned files", evidence: [{ source: "test", basis: "verified" }] } } },
	];
	for (const { input, expected } of cases) {
		const original = structuredClone(input);
		const result = tool.execute("one", input, h.ctx.signal, undefined, h.ctx);
		const request = h.entries.at(-1).request;
		const { requestId, sequence, ...wireInput } = request;
		assert.deepEqual(wireInput, expected);
		assert.equal(strictTeamRequest(request), true);
		assert.ok(sequence > 0);
		assert.deepEqual(input, original, "normalization does not mutate Pi's stored tool arguments");
		await h.command("reply", { requestId, reply: { ok: true } });
		await result;
	}
});

test("normalization does not hide missing meaningful messages, invalid waits or unknown sender fields", async () => {
	const h = harness("coordinator");
	await h.command("bind");
	for (const action of ["send", "report", "control"]) {
		for (const message of [null, "", " \n "]) {
			const input = { action, to: action === "report" ? null : "a", message, wait: null, command: action === "control" ? "redirect" : null };
			await assert.rejects(h.tools.get("team").execute("one", input, h.ctx.signal, undefined, h.ctx), /Invalid team arguments|message cannot be empty/);
		}
	}
	for (const input of [
		{ action: "send", to: "a", message: "hi", sender: null },
		{ action: "send", to: "a", message: "hi", receive: null },
		{ action: "wait", wait: { kind: "message" }, receive: true },
		{ action: "checkpoint", receive: true },
		{ action: "checkpoint" },
		{ action: "wait", wait: { kind: "member", member: "" } },
		{ action: "wait", wait: { kind: "message", afterSeq: "" } },
		{ action: "wait", wait: { kind: "message", from: " " } },
	]) await assert.rejects(h.tools.get("team").execute("one", input, h.ctx.signal, undefined, h.ctx), /Invalid team arguments/);
	assert.equal(h.entries.filter((entry) => entry.kind === "request").length, 0);
	assert.equal(h.aborted(), 0);
});

test("business reply rejection is a tool error without aborting or poisoning the next request", async () => {
	const h = harness();
	await h.command("bind");
	const denied = h.tools.get("team").execute("one", { action: "send", to: "a", message: "hello", wait: null, command: null }, h.ctx.signal, undefined, h.ctx);
	const rejected = assert.rejects(denied, /recipient unavailable/);
	await h.command("reply", { requestId: h.entries.at(-1).request.requestId, reply: { ok: false, error: "recipient unavailable" } });
	await rejected;
	assert.equal(h.aborted(), 0);
	const next = h.handlers.get("context")!({ messages: [] }, h.ctx);
	await h.command("reply", { requestId: h.entries.at(-1).request.requestId, reply: { ok: true } });
	await next;
	assert.equal(h.aborted(), 0);
});
