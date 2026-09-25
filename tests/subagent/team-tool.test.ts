import assert from "node:assert/strict";
import { test } from "node:test";
import { TeamHub } from "../../tools/subagents/team-hub";
import { installTeamTool, restoreTeamHistory } from "../../tools/subagents/team-tool";
import { TEAM_HISTORY_TYPE } from "../../tools/subagents/team-protocol";

test("parent prepare/status/cancel handles null defaults and exposes no binding", async () => {
	const hub = new TeamHub();
	let tool: any;
	installTeamTool({ registerTool: (definition: any) => { tool = definition; } } as any, () => hub);
	try {
		assert.equal(tool.parameters.properties.action.type, "string");
		assert.deepEqual(tool.parameters.properties.action.enum, ["prepare", "launch", "status", "cancel"]);
		assert.equal(tool.parameters.properties.action.anyOf, undefined);
		await assert.rejects(tool.execute("bad-prepare", { action: "prepare", teamId: "ignored-id", coordinator: "A", workers: ["B"] }), /does not accept teamId/u);
		assert.equal(hub.list().length, 0, "a rejected prepare must not create a team");
		const prepared = await tool.execute("prepare", {
			action: "prepare", coordinator: "A", workers: ["B"], timeoutSeconds: null,
			brief: {
				goal: "Review the target service",
				target: "https://example.invalid/service",
				acceptanceCriteria: null,
				constraints: ["Do not modify production"],
				authorizations: [{ member: "B", allowed: ["Read repository files"], forbidden: null }],
			},
		});
		const snapshot = prepared.details.snapshots[0];
		assert.equal(snapshot.deadline - snapshot.createdAt, 3600000);
		assert.deepEqual(snapshot.brief, {
			goal: "Review the target service",
			target: "https://example.invalid/service",
			constraints: ["Do not modify production"],
			authorizations: [{ member: "B", allowed: ["Read repository files"] }],
		});
		assert.match(prepared.content[0].text, /Budget: 3600s total from prepare/u);
		assert.match(prepared.content[0].text, /exactly these two subagent calls, as siblings in ONE assistant message/u);
		assert.ok(prepared.content[0].text.includes(`{"teamId":"${snapshot.id}","alias":"A","task":"<coordinator task>"}`), "the coordinator call is copyable");
		assert.ok(prepared.content[0].text.includes(`{"teamId":"${snapshot.id}","tasks":[{"alias":"B","task":"<B task>"}]}`), "a single worker still uses a tasks array");
		const payload = JSON.parse(prepared.content[0].text.split("JSON:\n")[1]!);
		assert.equal(payload.action, "prepare");
		assert.equal(payload.teamId, snapshot.id);
		assert.equal(payload.from, "@hub");
		assert.equal(payload.to, "@parent");
		assert.equal(payload.snapshot.brief.goal, "Review the target service");
		assert.match(payload.next, /do not wake or interrupt/u);
		const status = await tool.execute("status", { action: "status", teamId: snapshot.id });
		assert.match(status.content[0].text, /REGISTERED/);
		assert.equal(JSON.parse(status.content[0].text.split("JSON:\n")[1]!).action, "status");
		assert.equal(JSON.stringify(status).includes("epoch"), false);
		hub.join(snapshot.id, ["A"], [{ memberId: "A", task: "Coordinate", model: "provider/model", fastMode: false, searchMode: "on" }]);
		const [worker] = hub.join(snapshot.id, ["B"], [{ memberId: "B", task: "Inspect the service", cwd: "/tmp/service", model: "provider/model", fastMode: true, searchMode: "on" }]);
		await hub.request(worker!, { requestId: "blocked", sequence: 1, action: "finish", result: { status: "blocked", summary: "Need approved credentials" } });
		const assignedStatus = await tool.execute("assigned-status", { action: "status", teamId: snapshot.id });
		const modelSnapshot = JSON.parse(assignedStatus.content[0].text.split("JSON:\n")[1]!).snapshot;
		const assignedWorker = modelSnapshot.members.find((member: any) => member.id === "B");
		assert.equal(assignedWorker.assignment.taskPreview, "Inspect the service");
		assert.equal(assignedWorker.assignment.fastMode, true);
		assert.equal(assignedWorker.result.status, "blocked");
		assert.equal(assignedWorker.result.summaryPreview, "Need approved credentials");
		assert.equal(JSON.stringify(modelSnapshot).includes("epoch"), false);
		const cancelled = await tool.execute("cancel", { action: "cancel", teamId: snapshot.id, reason: null });
		assert.equal(cancelled.details.snapshots[0].phase, "cancelled");
		assert.equal((await tool.execute("list", { action: "status", teamId: null })).details.snapshots.length, 1);
	} finally { hub.dispose(); }
});

test("prepare explains an explicit short total deadline without silently extending it", async (t) => {
	const hub = new TeamHub(); t.after(() => hub.dispose());
	let tool: any;
	installTeamTool({ registerTool: (definition: any) => { tool = definition; } } as any, () => hub);
	assert.match(tool.parameters.properties.timeoutSeconds.description, /Default null = 3600 seconds/u);
	assert.match(tool.promptGuidelines.join("\n"), /default timeoutSeconds to null/u);
	const result = await tool.execute("short", { action: "prepare", coordinator: "A", workers: ["B"], timeoutSeconds: 120 });
	const snapshot = result.details.snapshots[0];
	assert.equal(snapshot.deadline - snapshot.createdAt, 120000);
	assert.match(result.content[0].text, /Budget: 120s total from prepare, including reasoning, tools, waiting and final summary/u);
	assert.equal(snapshot.phase, "prepared");
});

test("status previews and a full 32-team listing stay bounded without discarding stored outcomes", async (t) => {
	const source = new TeamHub();
	const hub = new TeamHub();
	t.after(() => { source.dispose(); hub.dispose(); });
	const ids = Array.from({ length: 8 }, (_, index) => `B${index + 1}`);
	const snapshot = source.prepare({ coordinator: "A", workers: ids, brief: {
		goal: "g".repeat(8192), target: "t".repeat(8192), constraints: ["c".repeat(8192)],
	} });
	const assignment = (memberId: string) => ({ memberId, task: "\u0000".repeat(1200), cwd: "\u0000".repeat(1200), model: "provider/model", fastMode: false });
	const [coordinator] = source.join(snapshot.id, ["A"], [assignment("A")]);
	const workers = source.join(snapshot.id, ids, ids.map(assignment));
	for (const worker of workers) {
		assert.equal((await source.request(worker, { requestId: "result", sequence: 1, action: "finish", result: {
			status: "partial", summary: "\u0000".repeat(1200), findings: ["\u0000".repeat(700)],
		} })).ok, true);
		source.complete(worker, { status: "completed", output: "native result" });
	}
	await source.waitForWorkers(coordinator!);
	source.complete(coordinator!, { status: "completed", output: "final summary" });
	const completed = source.get(snapshot.id);
	hub.restore(Array.from({ length: 32 }, (_, index) => ({ ...completed, id: `history-${index}`, events: [] })));
	let tool: any;
	installTeamTool({ registerTool: (definition: any) => { tool = definition; } } as any, () => hub);
	const listed = await tool.execute("list", { action: "status" });
	assert.equal(listed.details.response.snapshots.length, 32);
	assert.ok(Buffer.byteLength(listed.content[0].text) < 32 * 1024, "listing must not repeat every team's full brief, assignments and results");
	const status = await tool.execute("status", { action: "status", teamId: "history-0" });
	assert.ok(Buffer.byteLength(status.content[0].text) < 64 * 1024, "single-team previews count JSON escaping overhead");
	const worker = status.details.response.snapshot.members.find((member: any) => member.id === "B1");
	assert.match(worker.result.summaryPreview, /…$/u);
	assert.equal(worker.result.findingsCount, 1);
	assert.equal(status.details.snapshots[0].members.find((member: any) => member.id === "B1").result.summary, "\u0000".repeat(1200), "stored outcome is complete; only status previews are bounded");
});

test("history restores latest journal snapshot per team as interrupted, rejecting old bindings", () => {
	const source = new TeamHub();
	const restored = new TeamHub();
	try {
		const prepared = source.prepare({ coordinator: "A", workers: ["B"] });
		const [old] = source.join(prepared.id, ["A"]);
		const latest = source.get(prepared.id);
		restoreTeamHistory(restored, [
			{ type: "custom", customType: TEAM_HISTORY_TYPE, data: prepared },
			{ type: "custom", customType: "unrelated", data: {} },
			{ type: "custom", customType: TEAM_HISTORY_TYPE, data: latest },
		]);
		assert.equal(restored.get(prepared.id).phase, "interrupted");
		assert.throws(() => restored.complete(old!, { status: "completed", output: "stale" }), /binding/);
	} finally { source.dispose(); restored.dispose(); }
});

test("status explains deadline and admission cancellation in model-visible text", async (t) => {
	let now = 1000;
	const hub = new TeamHub({ now: () => now, startupTimeoutMs: 30_000 });
	t.after(() => hub.dispose());
	let tool: any;
	installTeamTool({ registerTool: (definition: any) => { tool = definition; } } as any, () => hub);
	const expired = hub.prepare({ coordinator: "A", workers: ["B"], timeoutSeconds: 120 });
	now += 120_000;
	const deadline = await tool.execute("deadline", { action: "status", teamId: expired.id });
	assert.match(deadline.content[0].text, /Reason: Team deadline exceeded/u);
	const missingPeer = hub.prepare({ coordinator: "A2", workers: ["B2"] });
	hub.join(missingPeer.id, ["A2"]);
	now += 30_000;
	const admission = await tool.execute("admission", { action: "status", teamId: missingPeer.id });
	assert.match(admission.content[0].text, /Reason: Startup admission deadline exceeded/u);
});

test("cancel reason is visible but bounded and stripped of terminal control sequences", async (t) => {
	const hub = new TeamHub(); t.after(() => hub.dispose());
	let tool: any;
	installTeamTool({ registerTool: (definition: any) => { tool = definition; } } as any, () => hub);
	const team = hub.prepare({ coordinator: "A", workers: ["B"] });
	const cancelled = await tool.execute("cancel", { action: "cancel", teamId: team.id, reason: "\u001b[31mRequested stop\u001b[0m\n" + "more context ".repeat(80) });
	const text = cancelled.content[0].text;
	assert.match(text, /Reason: Requested stop more context/u);
	assert.doesNotMatch(text, /\u001b/u);
	assert.ok(text.length < 2500, "model-visible status JSON keeps cancellation context bounded");
	assert.match(tool.renderResult(cancelled).render(120).join("\n"), /Reason: Requested stop/u);
});

test("brief schema limits match the shared validator, which also bounds escaped aggregate size", async (t) => {
	const hub = new TeamHub(); t.after(() => hub.dispose());
	let tool: any;
	installTeamTool({ registerTool: (definition: any) => { tool = definition; } } as any, () => hub);
	const brief = tool.parameters.properties.brief.anyOf[0];
	const listItem = (schema: any) => schema.anyOf?.[0]?.items ?? schema.items;
	for (const schema of [brief.properties.goal, brief.properties.target.anyOf[0], listItem(brief.properties.constraints),
		listItem(brief.properties.acceptanceCriteria), listItem(brief.properties.authorizations.anyOf[0].items.properties.allowed)]) {
		assert.equal(schema.maxLength, 8192);
	}
	assert.equal(brief.properties.authorizations.anyOf[0].maxItems, 9);
	const accepted = await tool.execute("long", { action: "prepare", coordinator: "A", workers: ["B"], brief: { goal: "g", constraints: ["c".repeat(5000)] } });
	assert.equal(accepted.details.snapshots[0].brief.constraints[0].length, 5000, "a 5000-character constraint is valid on both sides");
	await assert.rejects(tool.execute("escaped", { action: "prepare", coordinator: "A", workers: ["B"], brief: {
		goal: "g", constraints: Array.from({ length: 6 }, () => "\u0001".repeat(1500)) } }), /exceeds 32768 serialized UTF-8 bytes/u);
});
