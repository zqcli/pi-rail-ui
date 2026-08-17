import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { FileAgentInstanceStore } from "../../subagent/instance-store";
import {
	SUBAGENT_LINK_ENTRY_TYPE,
	SessionAgentRoster,
	type SubagentLinkEntry,
} from "../../subagent/session-links";
import type { AgentInstance } from "../../subagent/session-broker";

function instance(agentId: string, alias: string): AgentInstance {
	return {
		version: 2,
		agentId,
		alias,
		model: { provider: "cus-resp", modelId: "gpt-5.6-sol", thinkingLevel: "xhigh" },
		sessionId: `session-${agentId}`,
		sessionFile: `/tmp/${agentId}.jsonl`,
		cwd: "/tmp/project",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		lastTask: "review",
	};
}

describe("FileAgentInstanceStore", () => {
	test("persists independent agent files and lists them by recency", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-subagent-store-"));
		try {
			const store = new FileAgentInstanceStore(dir);
			const older = instance("agt_old", "old-review");
			const newer = { ...instance("agt_new", "new-review"), updatedAt: "2026-02-01T00:00:00.000Z" };

			await store.put(older);
			await store.put(newer);

			assert.deepEqual(await store.get("agt_old"), older);
			assert.deepEqual((await store.list()).map((item) => item.agentId), ["agt_new", "agt_old"]);
			assert.equal((await readFile(join(dir, "instances", "agt_old.json"), "utf8")).endsWith("\n"), true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("migrates a profile-backed descriptor from the child session model", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-subagent-migrate-"));
		try {
			const sessionFile = join(dir, "child.jsonl");
			await writeFile(sessionFile, `${JSON.stringify({ type: "model_change", provider: "cus-resp", modelId: "gpt-5.6-terra" })}\n`);
			await mkdir(join(dir, "instances"));
			await writeFile(join(dir, "instances", "agt_legacy.json"), JSON.stringify({
				version: 1,
				agentId: "agt_legacy",
				alias: "legacy",
				profile: { model: "deepseek/deepseek-v4-flash:max", systemPrompt: "legacy prompt" },
				sessionId: "session-legacy",
				sessionFile,
				cwd: "/tmp/project",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-02T00:00:00.000Z",
				lastTask: "review",
			}));

			const migrated = await new FileAgentInstanceStore(dir).get("agt_legacy");

			assert.equal(migrated?.version, 2);
			assert.deepEqual(migrated?.model, { provider: "cus-resp", modelId: "gpt-5.6-terra" });
			assert.equal("profile" in (migrated as unknown as Record<string, unknown>), false);
			assert.equal(JSON.parse(await readFile(join(dir, "instances", "agt_legacy.json"), "utf8")).version, 2);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("SessionAgentRoster", () => {
	test("reconstructs links from the active parent branch", () => {
		const roster = new SessionAgentRoster();
		const entries: SubagentLinkEntry[] = [
			linkEntry("one", { action: "link", alias: "review", agentId: "agt_1" }),
			linkEntry("two", { action: "unlink", alias: "review" }),
			linkEntry("three", { action: "link", alias: "review", agentId: "agt_2" }),
		];

		roster.restore(entries);

		assert.equal(roster.resolve("review"), "agt_2");
		assert.deepEqual(roster.list(), [{ alias: "review", agentId: "agt_2" }]);
	});

	test("persists newly linked aliases through the parent session callback", () => {
		const appended: Array<{ type: string; data: unknown }> = [];
		const roster = new SessionAgentRoster((type, data) => appended.push({ type, data }));

		roster.link("auth-review", "agt_auth");
		roster.unlink("auth-review");

		assert.deepEqual(appended, [
			{ type: SUBAGENT_LINK_ENTRY_TYPE, data: { action: "link", alias: "auth-review", agentId: "agt_auth" } },
			{ type: SUBAGENT_LINK_ENTRY_TYPE, data: { action: "unlink", alias: "auth-review" } },
		]);
	});

	test("rejects aliases that could inject parent-session prompt text", () => {
		const roster = new SessionAgentRoster(() => undefined);
		assert.throws(() => roster.link("bad\nalias", "agt_1"), /alias must be/);
	});

	test("does not overwrite an alias already linked to another instance", () => {
		const roster = new SessionAgentRoster(() => undefined);
		roster.link("auth-review", "agt_1");
		assert.throws(() => roster.link("auth-review", "agt_2"), /already exists/);
		assert.equal(roster.resolve("auth-review"), "agt_1");
	});
});

function linkEntry(id: string, data: NonNullable<SubagentLinkEntry["data"]>): SubagentLinkEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		customType: SUBAGENT_LINK_ENTRY_TYPE,
		data,
	};
}
