import assert from "node:assert/strict";
import { test } from "node:test";
import { installStatefulSubagentTool } from "../../subagent/tool";
import type { AgentConfig } from "../../subagent/agents";
import type { DispatchRequest, DispatchResult, SessionBroker } from "../../subagent/session-broker";

const reviewer: AgentConfig = {
	name: "reviewer",
	description: "Review code",
	systemPrompt: "Review carefully.",
	source: "user",
	filePath: "/tmp/reviewer.md",
};

class FakeBroker {
	readonly requests: DispatchRequest[] = [];

	async dispatch(request: DispatchRequest): Promise<DispatchResult> {
		this.requests.push(request);
		return {
			instance: {
				version: 1,
				agentId: "agt_auth",
				alias: request.alias ?? request.target ?? "auth-review",
				profile: reviewer,
				sessionId: "session-auth",
				sessionFile: "/tmp/auth.jsonl",
				cwd: request.cwd ?? "/tmp/project",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				lastTask: request.task,
				lastOutput: `done: ${request.task}`,
			},
			run: {
				output: `done: ${request.task}`,
				usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.1, contextTokens: 12, turns: 1 },
			},
		};
	}
}

test("stateful subagent tool creates by profile and continues by target without transcript duplication", async () => {
	let tool: any;
	const broker = new FakeBroker();
	const pi = { registerTool: (definition: any) => { tool = definition; } };
	installStatefulSubagentTool(pi as any, {
		broker: broker as unknown as SessionBroker,
		discoverProfiles: () => ({ agents: [reviewer], projectAgentsDir: null }),
	});
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		isProjectTrusted: () => true,
		ui: { confirm: async () => true },
	};

	const created = await tool.execute("call-1", {
		agent: "reviewer",
		alias: "auth-review",
		task: "review auth",
	}, undefined, undefined, ctx);
	const continued = await tool.execute("call-2", {
		target: "auth-review",
		task: "check tests",
	}, undefined, undefined, ctx);

	assert.equal(broker.requests[0]?.profile, reviewer);
	assert.equal(broker.requests[1]?.target, "auth-review");
	assert.match(created.content[0].text, /Reuse with target="auth-review"/);
	assert.match(continued.content[0].text, /done: check tests/);
	assert.equal("messages" in continued.details.results[0], false);
	assert.deepEqual(continued.details.results[0].usage, {
		input: 10,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0.1,
		contextTokens: 12,
		turns: 1,
	});
});

test("stateful subagent tool confirms before forking an ordinary session", async () => {
	let tool: any;
	let confirmations = 0;
	const broker = new FakeBroker();
	installStatefulSubagentTool({ registerTool: (definition: any) => { tool = definition; } } as any, {
		broker: broker as unknown as SessionBroker,
		discoverProfiles: () => ({ agents: [reviewer], projectAgentsDir: null }),
	});

	await tool.execute("call-3", {
		agent: "reviewer",
		alias: "adopted-review",
		task: "continue review",
		session: { mode: "fork", path: "/tmp/source.jsonl" },
	}, undefined, undefined, {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { confirm: async () => { confirmations++; return true; } },
	});

	assert.equal(confirmations, 1);
	assert.deepEqual(broker.requests[0]?.session, { mode: "fork", path: "/tmp/source.jsonl" });
});
