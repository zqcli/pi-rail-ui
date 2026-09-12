import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Persistence scope: the global agent directory only. The mode is shared by the
 * main session and every Rail child process that uses the same agent dir, and it
 * is intentionally not project-local so a project cannot flip compaction policy
 * without trust resolution.
 */
export type GptCompactionMode = "on" | "off";

export const GPT_COMPACTION_SETTINGS_VERSION = 1;
export const GPT_COMPACTION_SETTINGS_DIR = "rail-gpt-compaction";

interface GptCompactionSettingsFile {
	version: number;
	remoteCompaction: GptCompactionMode;
}

export interface GptCompactionSettings {
	mode: GptCompactionMode;
	path: string;
	warning?: string;
}

export function gptCompactionSettingsPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, GPT_COMPACTION_SETTINGS_DIR, "settings.json");
}

export function parseGptCompactionMode(value: unknown): GptCompactionMode | undefined {
	return value === "on" || value === "off" ? value : undefined;
}

export function readGptCompactionSettings(agentDir?: string): GptCompactionSettings {
	const path = gptCompactionSettingsPath(agentDir);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return { mode: "off", path };
	}
	try {
		const parsed = JSON.parse(raw) as Partial<GptCompactionSettingsFile> | null;
		const mode = parseGptCompactionMode(parsed?.remoteCompaction);
		if (parsed?.version !== GPT_COMPACTION_SETTINGS_VERSION || mode === undefined) {
			return { mode: "off", path, warning: "Rail GPT compaction settings are unreadable; using off" };
		}
		return { mode, path };
	} catch {
		return { mode: "off", path, warning: "Rail GPT compaction settings are not valid JSON; using off" };
	}
}

export function readGptCompactionMode(agentDir?: string): GptCompactionMode {
	return readGptCompactionSettings(agentDir).mode;
}

export function writeGptCompactionMode(mode: GptCompactionMode, agentDir?: string): GptCompactionSettings {
	const path = gptCompactionSettingsPath(agentDir);
	const payload: GptCompactionSettingsFile = {
		version: GPT_COMPACTION_SETTINGS_VERSION,
		remoteCompaction: mode,
	};
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, path);
	return { mode, path };
}

export type GptCompactionCommand = { operation: "menu" } | { operation: "set"; mode: GptCompactionMode };

export function parseGptCompactionCommand(args: string): GptCompactionCommand {
	const parts = args.trim().split(/\s+/u).filter(Boolean);
	if (parts.length === 0) return { operation: "menu" };
	if (parts.length === 1) {
		const mode = parseGptCompactionMode(parts[0]);
		if (mode) return { operation: "set", mode };
	}
	throw new Error("Usage: /rail-gpt-compaction [on|off]");
}

/**
 * Human-readable persistence scope, printed with every mode change so a user
 * never has to guess whether the switch is session-local or global.
 */
export function gptCompactionSettingsScope(path: string = gptCompactionSettingsPath()): string {
	return `global agent setting (${path})`;
}

export function describeGptCompactionMode(mode: GptCompactionMode): string {
	return mode === "on" ? "on — GPT Responses models use Remote Compaction v2" : "off — Pi native compaction";
}
