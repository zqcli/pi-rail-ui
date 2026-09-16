import { fileURLToPath } from "node:url";

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