import { readFileSync, writeFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export async function handleDuplicateCommand(ctx: ExtensionContext): Promise<void> {
	const currentSessionFile = ctx.sessionManager.getSessionFile();
	if (!currentSessionFile) {
		ctx.ui.notify("Cannot duplicate in-memory session", "error");
		return;
	}

	try {
		const currentCwd = ctx.sessionManager.getCwd();
		const sessionDir = ctx.sessionManager.getSessionDir();
		const parentSession = ctx.sessionManager.getHeader()?.parentSession;

		const newSessionManager = SessionManager.forkFrom(currentSessionFile, currentCwd, sessionDir);
		const newSessionFile = newSessionManager.getSessionFile();
		if (!newSessionFile) {
			ctx.ui.notify("Failed to create session file", "error");
			return;
		}

		// forkFrom points parentSession at the source, which would make the copy
		// a child. Rewrite the header so the copy shares the source's parent and
		// shows up as a sibling instead.
		const lines = readFileSync(newSessionFile, "utf8").split("\n");
		const header = JSON.parse(lines[0]!);
		header.parentSession = parentSession;
		lines[0] = JSON.stringify(header);
		writeFileSync(newSessionFile, lines.join("\n"));

		ctx.ui.notify(`Sibling session created: ${header.id}. Use /resume to switch.`, "info");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Failed to duplicate: ${message}`, "error");
	}
}
