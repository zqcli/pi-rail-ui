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

		const newSessionManager = SessionManager.create(currentCwd, sessionDir, { parentSession });

		const entries = ctx.sessionManager.getEntries();
		for (const entry of entries) {
			if (entry.type === "message") {
				newSessionManager.appendMessage(entry.message);
			}
		}

		const newSessionId = newSessionManager.getSessionId();
		ctx.ui.notify(`Sibling session created: ${newSessionId}. Use /resume to switch.`, "info");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Failed to duplicate: ${message}`, "error");
	}
}
