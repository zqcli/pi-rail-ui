import { basename } from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

const MAX_PARENT_LENGTH = 48;
const MAX_ALIAS_LENGTH = 64;

function cleanSegment(value: string, maxLength: number): string {
	const clean = stripTerminalSequences(value)
		.replace(/[\u0000-\u001F\u007F]/gu, " ")
		.replace(/[·/\\]+/gu, "-")
		.replace(/\s+/gu, " ")
		.trim();
	return clean.slice(0, maxLength).trim();
}

export function buildParentSessionLabel(sessionName: string | undefined, sessionId: string, cwd: string): string {
	const named = cleanSegment(sessionName ?? "", MAX_PARENT_LENGTH);
	if (named) return named;
	const project = cleanSegment(basename(cwd), 32) || "main";
	const shortId = cleanSegment(sessionId, 8) || "session";
	return `${project}-${shortId}`;
}

export function buildSubagentSessionName(parentLabel: string, alias: string): string {
	const parent = cleanSegment(parentLabel, MAX_PARENT_LENGTH) || "main";
	const child = cleanSegment(alias, MAX_ALIAS_LENGTH) || "agent";
	return `subagent · ${parent} · ${child}`;
}
