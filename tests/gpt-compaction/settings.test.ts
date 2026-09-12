import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	describeGptCompactionMode,
	gptCompactionSettingsPath,
	parseGptCompactionCommand,
	readGptCompactionSettings,
	writeGptCompactionMode,
} from "../../tools/gpt-compaction/settings";
import { installGptCompaction } from "../../tools/gpt-compaction/extension";

test("GPT compaction settings default to off and persist outside session files", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "rail-gpt-settings-"));
	t.after(() => rm(agentDir, { recursive: true, force: true }));
	assert.equal(readGptCompactionSettings(agentDir).mode, "off");
	const saved = writeGptCompactionMode("on", agentDir);
	assert.equal(saved.path, gptCompactionSettingsPath(agentDir));
	assert.equal(readGptCompactionSettings(agentDir).mode, "on");
	assert.match(await readFile(saved.path, "utf8"), /"remoteCompaction": "on"/);
	assert.equal(describeGptCompactionMode("off"), "off — Pi native compaction");
});

test("GPT compaction command parsing is strict and supports menu, on, and off", () => {
	assert.deepEqual(parseGptCompactionCommand(""), { operation: "menu" });
	assert.deepEqual(parseGptCompactionCommand("  on  "), { operation: "set", mode: "on" });
	assert.deepEqual(parseGptCompactionCommand("off"), { operation: "set", mode: "off" });
	assert.throws(() => parseGptCompactionCommand("yes"), /Usage/);
	assert.throws(() => parseGptCompactionCommand("on extra"), /Usage/);
});

test("the real extension registration exposes stateful menu, completion, and persistence", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "rail-gpt-extension-"));
	t.after(() => rm(agentDir, { recursive: true, force: true }));
	const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
	});
	const commands = new Map<string, any>();
	const handlers = new Map<string, any>();
	const notices: string[] = [];
	const selections: Array<{ title: string; options: string[] }> = [];
	const pi = {
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
		on: (event: string, handler: unknown) => handlers.set(event, handler),
	} as any;
	installGptCompaction(pi);
	assert.equal(commands.has("rail-gpt-compaction"), true);
	const command = commands.get("rail-gpt-compaction");
	assert.deepEqual(command.getArgumentCompletions("on")?.map((item: any) => item.value), ["on"]);
	assert.deepEqual(command.getArgumentCompletions("x"), null);
	const ctx = {
		mode: "tui",
		hasUI: true,
		model: undefined,
		ui: {
			select: async (title: string, options: string[]) => {
				selections.push({ title, options });
				return "on";
			},
			notify: (message: string) => notices.push(message),
			setStatus: () => undefined,
		},
		waitForIdle: async () => undefined,
		sessionManager: { getSessionId: () => "settings-test", getBranch: () => [], buildContextEntries: () => [] },
	} as any;
	await command.handler("", ctx);
	assert.equal(readGptCompactionSettings(agentDir).mode, "on");
	assert.deepEqual(selections, [{ title: "GPT Remote Compaction v2 — currently off", options: ["on", "off"] }]);
	assert.match(notices.join("\n"), /global agent setting/);
	await command.handler("off", ctx);
	assert.equal(readGptCompactionSettings(agentDir).mode, "off");
});
