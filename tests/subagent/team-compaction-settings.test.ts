import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { COMPACT_THRESHOLD_CHOICES, readCompactThreshold, writeCompactThreshold } from "../../tools/subagents/team-compaction-settings";

test("Team compaction settings: default, invalid files, allowed values, and live changes", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "team-compact-settings-"));
	const previous = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = dir;
	t.after(() => {
		if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previous;
		rmSync(dir, { recursive: true, force: true });
	});
	assert.equal(readCompactThreshold(), 80);
	mkdirSync(join(dir, "rail-team"));
	for (const value of ["{", "null", '{"version":2,"compactThreshold":60}', '{"version":1,"compactThreshold":42}', '{"version":1,"compactThreshold":"80"}']) {
		writeFileSync(join(dir, "rail-team", "settings.json"), value);
		assert.equal(readCompactThreshold(), 80);
	}
	assert.deepEqual(COMPACT_THRESHOLD_CHOICES, [null, 60, 70, 80, 90, 95]);
	for (const value of COMPACT_THRESHOLD_CHOICES) {
		writeCompactThreshold(value);
		assert.equal(readCompactThreshold(), value);
	}
	assert.throws(() => writeCompactThreshold(81), /Invalid/);
	assert.equal(readCompactThreshold(), 95);
});
