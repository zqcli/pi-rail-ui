import { readFileSync } from "node:fs";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

export function getParentSessionFile(sessionManager: SessionManager): string | undefined {
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) return undefined;

	try {
		const firstLine = readFileSync(sessionFile, "utf8").split("\n")[0];
		if (!firstLine?.trim()) return undefined;
		const header = JSON.parse(firstLine);
		return header.parentSession;
	} catch {
		return undefined;
	}
}
