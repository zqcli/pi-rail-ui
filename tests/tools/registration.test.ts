import assert from "node:assert/strict";
import { test } from "node:test";
import installRailUi from "../../index";

async function collectRegistrations(depth: number): Promise<{ tools: string[]; commands: string[] }> {
	const previousDepth = process.env["PI_SUBAGENT_DEPTH"];
	process.env["PI_SUBAGENT_DEPTH"] = String(depth);
	const tools: string[] = [];
	const commands: string[] = [];
	try {
		await installRailUi({
			registerTool: (definition: { name: string }) => { tools.push(definition.name); },
			registerCommand: (name: string) => { commands.push(name); },
			on: () => undefined,
		} as any);
		return { tools, commands };
	} finally {
		if (previousDepth === undefined) delete process.env["PI_SUBAGENT_DEPTH"];
		else process.env["PI_SUBAGENT_DEPTH"] = previousDepth;
	}
}

test("Rail root loads apply-patch and subagent tools", async () => {
	const registrations = await collectRegistrations(0);
	assert.deepEqual(registrations.tools, ["apply-patch", "subagent"]);
	assert.equal(registrations.commands.filter((name) => name === "rail-agent").length, 1);
});

test("Rail root keeps subagent disabled in child sessions", async () => {
	const registrations = await collectRegistrations(1);
	assert.deepEqual(registrations.tools, ["apply-patch"]);
	assert.equal(registrations.commands.includes("rail-agent"), false);
});