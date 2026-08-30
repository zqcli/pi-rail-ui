import { resolve } from "node:path";
import type { ExtensionCommandContext, SessionInfo } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { pickSearchableOverlay } from "./searchable-picker";

function compact(value: string, maxLength = 72): string {
	const oneLine = stripTerminalSequences(value).replace(/\s+/gu, " ").trim();
	return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, maxLength - 3)}...`;
}

function searchText(info: SessionInfo): string {
	return [info.name, info.firstMessage, info.cwd, info.id]
		.filter((value): value is string => Boolean(value))
		.join(" ")
		.toLowerCase();
}

export function filterSessions(sessions: SessionInfo[], query: string): SessionInfo[] {
	const terms = query.toLowerCase().trim().split(/\s+/u).filter(Boolean);
	if (terms.length === 0) return sessions;
	return sessions.filter((info) => {
		const haystack = searchText(info);
		return terms.every((term) => haystack.includes(term));
	});
}

function sessionRow(info: SessionInfo, currentCwd: string): string {
	const current = resolve(info.cwd) === resolve(currentCwd);
	const project = compact(info.cwd.split(/[\\/]/u).filter(Boolean).at(-1) || "unknown", 24);
	const title = compact(info.name || info.firstMessage) || info.id.slice(0, 8);
	return `${current ? "Current" : project} · ${title} · ${info.modified.toLocaleDateString()}`;
}

export async function pickSessionOverlay(ctx: ExtensionCommandContext, sessions: SessionInfo[]): Promise<SessionInfo | undefined> {
	return pickSearchableOverlay(ctx, {
		title: "Link saved Pi session",
		items: sessions.map((session) => ({ value: session, label: sessionRow(session, ctx.cwd), searchText: searchText(session) })),
		emptyText: "No matching sessions",
		actionLabel: "link",
	});
}
