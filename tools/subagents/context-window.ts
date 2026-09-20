import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { getAgentDir, hasTrustRequiringProjectResources, parseSessionEntries, ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * Noninteractive CLI fallback: nearest saved cwd/ancestor decision, then the
 * global default (ask cannot prompt). Never inherit the parent's temporary
 * trust or approve a child. The helper uses its actual ExtensionContext trust,
 * which additionally accounts for child-local project_trust extension decisions.
 */
export function createChildContextSettings(cwd: string): SettingsManager {
	const agentDir = getAgentDir();
	const global = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const trusted = !hasTrustRequiringProjectResources(cwd)
		|| (new ProjectTrustStore(agentDir).get(cwd) ?? (global.getDefaultProjectTrust() === "always"));
	return trusted ? SettingsManager.create(cwd, agentDir, { projectTrusted: true }) : global;
}

/** --session restores the saved cwd; --fork creates a session in the requested cwd. */
export async function resolveChildContextCwd(cwd: string, session?: { mode: string; path?: string }): Promise<string> {
	if (!session?.path || (session.mode !== "open" && session.mode !== "exclusive")) return cwd;
	const stream = createReadStream(resolve(cwd, session.path), { encoding: "utf8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		// Only the header is needed; do not load a potentially large conversation.
		for await (const line of lines) {
			const entry = parseSessionEntries(line)[0];
			if (entry?.type !== "session") continue;
			return typeof entry.cwd === "string" && entry.cwd.trim() ? resolve(cwd, entry.cwd) : cwd;
		}
	} catch (error) {
		// Pi also accepts a new explicit session path, which has no saved cwd yet.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return cwd;
		throw error;
	} finally {
		lines.close();
		stream.destroy();
	}
	return cwd;
}

export const CONTEXT_WINDOW_FLAG = "rail-context-window";
export const CONTEXT_PROTOCOL_FLAG = "rail-context-protocol";
export const CONTEXT_PROTOCOL_VERSION = "1";
export const CONTEXT_COMMAND = "rail-context-internal-v1";
export const CONTEXT_PROTOCOL_ERROR_PREFIX = "[rail-context-protocol-error] ";

export class ContextProtocolError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ContextProtocolError";
	}
}

export class ContextWindowValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ContextWindowValidationError";
	}
}

export function contextExtensionPath(): string {
	return fileURLToPath(new URL("./context-extension.ts", import.meta.url));
}

export function formatContextProtocolError(message: string): string {
	return message.startsWith(CONTEXT_PROTOCOL_ERROR_PREFIX) ? message : `${CONTEXT_PROTOCOL_ERROR_PREFIX}${message}`;
}

export function readContextProtocolError(value: unknown): string | undefined {
	const message = typeof value === "string" ? value : value instanceof Error ? value.message : String(value);
	return message.startsWith(CONTEXT_PROTOCOL_ERROR_PREFIX)
		? message.slice(CONTEXT_PROTOCOL_ERROR_PREFIX.length).trim()
		: undefined;
}

function describe(value: unknown): string {
	if (value === undefined) return "omitted";
	if (typeof value === "number" && Number.isNaN(value)) return "NaN";
	return String(value);
}

export function normalizeContextWindow(value: unknown): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value) || value <= 0) {
		throw new ContextWindowValidationError(`contextWindow must be a positive safe integer; received ${describe(value)}`);
	}
	return value;
}

export function parseContextWindowFlag(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) {
		throw new ContextWindowValidationError(`--${CONTEXT_WINDOW_FLAG} must be a decimal positive safe integer`);
	}
	return normalizeContextWindow(Number(value));
}

export function formatContextWindow(value: number | undefined): string {
	const normalized = normalizeContextWindow(value);
	if (normalized === undefined) throw new Error("contextWindow is required for explicit protocol encoding");
	return String(normalized);
}

export function validateContextWindowReserve(
	value: number | undefined,
	reserveTokens: number,
	compactionEnabled: boolean,
): number | undefined {
	const normalized = normalizeContextWindow(value);
	if (normalized !== undefined && compactionEnabled && normalized <= reserveTokens) {
		throw new ContextWindowValidationError(`contextWindow must be greater than the child reserveTokens (${reserveTokens}) when compaction is enabled`);
	}
	return normalized;
}