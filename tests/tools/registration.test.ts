import assert from "node:assert/strict";
import { test } from "node:test";
import installRailUi from "../../index";

async function collectRegistrations(depth: number): Promise<{
	tools: string[];
	commands: string[];
	providers: string[];
	toolDefinitions: Array<{ name: string; description?: string; executionMode?: string; parameters?: any }>;
}> {
	const previousDepth = process.env["PI_SUBAGENT_DEPTH"];
	process.env["PI_SUBAGENT_DEPTH"] = String(depth);
	const tools: string[] = [];
	const toolDefinitions: Array<{ name: string; description?: string; executionMode?: string; parameters?: any }> = [];
	const commands: string[] = [];
	const providers: string[] = [];
	const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
	try {
		await installRailUi({
			registerTool: (definition: { name: string; description?: string; executionMode?: string; parameters?: any }) => {
				tools.push(definition.name);
				toolDefinitions.push(definition);
			},
			registerCommand: (name: string) => { commands.push(name); },
			registerProvider: (name: string) => { providers.push(name); },
			on: () => undefined,
			events: {
				emit: (channel: string, data: unknown) => { for (const handler of eventHandlers.get(channel) ?? []) handler(data); },
				on: (channel: string, handler: (data: unknown) => void) => {
					const handlers = eventHandlers.get(channel) ?? new Set<(data: unknown) => void>();
					handlers.add(handler);
					eventHandlers.set(channel, handlers);
					return () => handlers.delete(handler);
				},
			},
		} as any);
		return { tools, commands, providers, toolDefinitions };
	} finally {
		if (previousDepth === undefined) delete process.env["PI_SUBAGENT_DEPTH"];
		else process.env["PI_SUBAGENT_DEPTH"] = previousDepth;
	}
}

test("Rail root loads apply-patch and subagent tools", async () => {
	const registrations = await collectRegistrations(0);
	assert.deepEqual(registrations.tools, ["apply-patch", "subagent_team", "subagent"]);
	const team = registrations.toolDefinitions.find((definition) => definition.name === "subagent_team");
	assert.ok(team, "the Team parent tool must be registered");
	assert.equal(team.executionMode, "parallel");
	assert.deepEqual(team.parameters?.properties?.action?.enum, ["prepare", "launch", "status", "cancel"]);
	assert.match(team.description ?? "", /\{"action":"launch","teamId":"<teamId>"\}/);
	assert.equal(registrations.commands.filter((name) => name === "rail-agent").length, 1);
});

test("Rail root keeps subagent disabled in child sessions", async () => {
	const registrations = await collectRegistrations(1);
	assert.deepEqual(registrations.tools, ["apply-patch"]);
	assert.equal(registrations.toolDefinitions.some((definition) => definition.name === "subagent_team"), false);
	assert.equal(registrations.commands.includes("rail-agent"), false);
});