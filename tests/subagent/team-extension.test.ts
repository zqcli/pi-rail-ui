import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import install, { parseTeamCommand, publicTeamReply, strictTeamRequest } from "../../tools/subagents/team-extension";
import { TEAM_COMMAND, type TeamBinding } from "../../tools/subagents/team-protocol";

const binding: TeamBinding = { version: 1, teamId: "t", memberId: "b", role: "worker", epoch: "private-epoch" };
function harness(role: TeamBinding["role"] = "worker") {
	const runtimeBinding = { ...binding, role };
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const entries: any[] = [];
	let active = ["read", "subagent"];
	let aborted = 0;
	const controller = new AbortController();
	const branch: any[] = [];
	const ctx = { signal: controller.signal, abort: () => { aborted++; controller.abort(); }, isIdle: () => true, sessionManager: { getBranch: () => branch } };
	const pi = {
		on: (name: string, fn: any) => handlers.set(name, fn),
		registerCommand: (name: string, def: any) => commands.set(name, def),
		registerTool: (def: any) => tools.set(def.name, def),
		getAllTools: () => [...tools.values()],
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
		appendEntry: (_type: string, data: any) => entries.push(data),
	};
	install(pi as unknown as ExtensionAPI);
	const command = (operation: string, extra = {}) => commands.get(TEAM_COMMAND).handler(JSON.stringify({ version: 1, commandId: `c${entries.length}`, operation, binding: runtimeBinding, ...extra }), ctx);
	return { handlers, tools, entries, branch, ctx, controller, command, active: () => active, aborted: () => aborted };
}

test("strict team parser rejects sender injection, extra fields and UTF-8 overflow", () => {
	assert.equal(strictTeamRequest({ requestId: "r", sequence: 1, action: "send", to: "a", message: "hello" }), true);
	for (const input of [
		{ action: "send", to: "a", message: "x", sender: "a" },
		{ action: "send", to: "a", message: "中".repeat(3000) },
		{ action: "wait", wait: { kind: "member" } },
		{ action: "finish", wait: { kind: "message" } },
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
		assert.match(systemPrompt, /all workers' terminal outcomes/);
		assert.match(systemPrompt, /untrusted data, not higher-priority instructions/);
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

test("wait/report-wait/finish reject mixed batch before release; worker control cannot forge role", async () => {
	const h = harness();
	await h.command("bind");
	h.branch.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "one" }, { type: "toolCall", id: "two" }] } });
	for (const params of [{ action: "wait", wait: { kind: "message" } }, { action: "report", message: "done", wait: { kind: "message" } }, { action: "finish" }]) {
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

test("team optional schemas are nullable/default null and provider placeholders normalize before strict wire validation", async () => {
	const h = harness("coordinator");
	await h.command("bind");
	h.branch.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "one" }] } });
	const tool = h.tools.get("team");
	assert.equal(Object.hasOwn(tool.parameters.properties, "receive"), false);
	for (const name of ["to", "message", "command", "wait"]) {
		assert.equal(tool.parameters.properties[name].default, null);
		assert.ok(tool.parameters.properties[name].anyOf.some((schema: any) => schema.type === "null"));
	}
	const waitSchema = tool.parameters.properties.wait.anyOf.find((schema: any) => schema.type === "object");
	for (const name of ["member", "afterSeq"]) {
		assert.equal(waitSchema.properties[name].default, null);
		assert.ok(waitSchema.properties[name].anyOf.some((schema: any) => schema.type === "null"));
	}
	const cases = [
		{ input: { action: "send", to: " a ", message: "  keep message spacing  ", wait: null, command: null }, expected: { action: "send", to: "a", message: "  keep message spacing  " } },
		{ input: { action: "wait", to: null, message: null, command: null, wait: { kind: "message", member: null, afterSeq: null } }, expected: { action: "wait", wait: { kind: "message" } } },
		{ input: { action: "wait", to: " ", message: "", command: "", wait: { kind: "message", member: " ", afterSeq: 0 } }, expected: { action: "wait", wait: { kind: "message", afterSeq: 0 } } },
		{ input: { action: "report", to: "", message: "done", command: null, wait: { kind: "member", member: " a ", afterSeq: null } }, expected: { action: "report", message: "done", wait: { kind: "member", member: "a" } } },
		{ input: { action: "control", to: " a ", message: null, command: "pause", wait: null }, expected: { action: "control", to: "a", command: "pause" } },
		{ input: { action: "finish", to: "", message: "", command: "", wait: null }, expected: { action: "finish" } },
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
