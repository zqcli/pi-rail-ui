import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RailAgentManager } from "../../tools/subagents/agent-manager";
import { sessionLeaseDirectoryName } from "../../tools/subagents/session-lease";
import { sessionLeaseKey } from "../../tools/subagents/worker-factory";

function instance(agentId: string, alias: string, sessionFile: string) {
	return {
		version: 2 as const,
		agentId,
		alias,
		model: { provider: "cus-resp", modelId: "gpt-5.6-sol", thinkingLevel: "xhigh" as const },
		sessionId: `session-${agentId}`,
		sessionFile,
		cwd: "/tmp/project",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		lastTask: "review",
	};
}

test("RailAgentManager combines current links, local runtime state, and foreign leases", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-rail-agent-manager-"));
	const foreignOwner = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], { stdio: "ignore" });
	try {
		await once(foreignOwner, "spawn");
		const local = instance("agt_local", "local-review", join(dir, "local.jsonl"));
		const foreign = instance("agt_foreign", "foreign-review", join(dir, "foreign.jsonl"));
		const stopped = instance("agt_stopped", "stopped-review", join(dir, "stopped.jsonl"));
		const instances = new Map([[local.agentId, local], [foreign.agentId, foreign], [stopped.agentId, stopped]]);
		const links = [{ alias: "local-review", agentId: local.agentId }];
		const foreignLock = join(dir, "leases", sessionLeaseDirectoryName(sessionLeaseKey(foreign.sessionFile)));
		await mkdir(foreignLock, { recursive: true });
		await writeFile(join(foreignLock, "owner.json"), JSON.stringify({ pid: foreignOwner.pid, token: "foreign", createdAt: new Date().toISOString() }));
		const controls: unknown[] = [];
		const broker = {
			runtimeStatus: (agentId: string) => agentId === local.agentId ? { phase: "running", queued: 2 } : { phase: "stopped", queued: 0 },
			subscribeRuntime: () => () => undefined,
			control: async (request: unknown) => { controls.push(request); return { instance: local, delivery: "steer" }; },
		};
		const manager = new RailAgentManager(
			broker as any,
			{ get: async (id: string) => instances.get(id), put: async () => undefined, list: async () => [...instances.values()] } as any,
			{ list: () => links, link: () => undefined, unlink: () => undefined, resolve: () => undefined } as any,
			dir,
		);

		const snapshot = await manager.snapshot();

		assert.deepEqual(snapshot.counts, { linked: 1, global: 3, running: 1, queued: 2, idle: 0, stopped: 1, inUseElsewhere: 1, errors: 0 });
		assert.equal(snapshot.agents.find((agent) => agent.instance.agentId === local.agentId)?.phase, "running");
		assert.equal(snapshot.agents.find((agent) => agent.instance.agentId === foreign.agentId)?.phase, "in-use-elsewhere");
		assert.equal(snapshot.agents.find((agent) => agent.instance.agentId === stopped.agentId)?.phase, "stopped");
		await manager.control(local.agentId, { delivery: "steer", message: "Focus on tests" });
		assert.deepEqual(controls, [{ target: local.agentId, delivery: "steer", message: "Focus on tests" }]);
		await assert.rejects(
			() => manager.control(stopped.agentId, { delivery: "followUp", message: "Summarize" }),
			/not currently running/,
		);
		await assert.rejects(
			() => manager.control(foreign.agentId, { delivery: "steer", message: "Focus" }),
			/owned by process/,
		);
	} finally {
		if (foreignOwner.exitCode === null && foreignOwner.signalCode === null) {
			const exited = once(foreignOwner, "exit");
			foreignOwner.kill();
			await exited;
		}
		await rm(dir, { recursive: true, force: true });
	}
});
