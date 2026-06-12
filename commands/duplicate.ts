import { readFileSync, writeFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getParentSessionFile } from "../utils/session-utils";

export async function handleDuplicateCommand(ctx: ExtensionContext): Promise<void> {
	const currentSessionFile = ctx.sessionManager.getSessionFile();
	if (!currentSessionFile) {
		ctx.ui.notify("Cannot duplicate in-memory session", "error");
		return;
	}

	try {
		const currentCwd = ctx.sessionManager.getCwd();
		const sessionDir = ctx.sessionManager.getSessionDir();
		const parentSession = getParentSessionFile(ctx.sessionManager);

		const tempSessionManager = SessionManager.forkFrom(currentSessionFile, currentCwd, sessionDir);
		const newSessionFile = tempSessionManager.getSessionFile();
		if (!newSessionFile) {
			ctx.ui.notify("Failed to create session file", "error");
			return;
		}

		const content = readFileSync(newSessionFile, "utf8");
		const lines = content.split("\n");
		const header = JSON.parse(lines[0]);
		header.parentSession = parentSession;
		lines[0] = JSON.stringify(header);
		writeFileSync(newSessionFile, lines.join("\n"));

		const newSessionId = header.id;
		ctx.ui.notify(`Sibling session created: ${newSessionId}. Use /resume to switch.`, "info");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Failed to duplicate: ${message}`, "error");
	}
}
