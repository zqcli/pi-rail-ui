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
		assert.deepEqual(tool.parameters.properties.action.enum, ["prepare", "status", "cancel"]);
		assert.equal(tool.parameters.properties.action.anyOf, undefined);
		const prepared = await tool.execute("prepare", { action: "prepare", coordinator: "A", workers: ["B"], timeoutSeconds: null });
		const snapshot = prepared.details.snapshots[0];
		assert.equal(snapshot.deadline - snapshot.createdAt, 3600000);
		assert.match(prepared.content[0].text, /Budget: 3600s total from prepare/u);
		assert.match(prepared.content[0].text, /BOTH coordinator single and all workers grouped.*ONE assistant message/u);
		const status = await tool.execute("status", { action: "status", teamId: snapshot.id });
		assert.match(status.content[0].text, /REGISTERED/);
		assert.equal(JSON.stringify(status).includes("epoch"), false);
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
	assert.ok(text.length < 500);
	assert.match(tool.renderResult(cancelled).render(120).join("\n"), /Reason: Requested stop/u);
});
