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
		const status = await tool.execute("status", { action: "status", teamId: snapshot.id });
		assert.match(status.content[0].text, /REGISTERED/);
		assert.equal(JSON.stringify(status).includes("epoch"), false);
		const cancelled = await tool.execute("cancel", { action: "cancel", teamId: snapshot.id, reason: null });
		assert.equal(cancelled.details.snapshots[0].phase, "cancelled");
		assert.equal((await tool.execute("list", { action: "status", teamId: null })).details.snapshots.length, 1);
	} finally { hub.dispose(); }
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
