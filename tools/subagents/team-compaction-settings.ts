import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const COMPACT_THRESHOLD_CHOICES = [null, 60, 70, 80, 90, 95] as const;
const settingsPath = () => join(getAgentDir(), "rail-team", "settings.json");

export function readCompactThreshold(): number | null {
	try {
		const value = JSON.parse(readFileSync(settingsPath(), "utf8"));
		if (value.version === 1 && COMPACT_THRESHOLD_CHOICES.includes(value.compactThreshold)) return value.compactThreshold;
	} catch { /* Missing or invalid settings use the default. */ }
	return 80;
}

export function writeCompactThreshold(value: number | null): void {
	if (!COMPACT_THRESHOLD_CHOICES.some((choice) => choice === value)) throw new Error("Invalid Team compaction threshold");
	const path = settingsPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ version: 1, compactThreshold: value }, null, 2)}\n`, "utf8");
}
