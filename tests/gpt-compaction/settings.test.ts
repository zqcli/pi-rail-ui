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
