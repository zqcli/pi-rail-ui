import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PAUSE_ENTRY_TYPE, PAUSE_GATE_FLAG } from "./pause";

const POLL_MS = 500;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

/**
 * Child half of a subagent pause, the counterpart of a Team member's provider gate: while the
 * parent's gate file exists, every new provider request and tool call waits here. Work already in
 * flight finishes; removing the file continues the same native run.
 */
export default function installPauseGate(pi: ExtensionAPI): void {
	pi.registerFlag(PAUSE_GATE_FLAG, {
		description: "Rail subagent pause gate file",
		type: "string",
	});

	let holding = 0;
	const hold = async (signal?: AbortSignal): Promise<void> => {
		const file = pi.getFlag(PAUSE_GATE_FLAG);
		if (typeof file !== "string" || !file || signal?.aborted || !existsSync(file)) return;
		if (holding++ === 0) pi.appendEntry(PAUSE_ENTRY_TYPE, { parked: true });
		try {
			while (!signal?.aborted && existsSync(file)) await sleep(POLL_MS, signal);
		} finally {
			if (--holding === 0) pi.appendEntry(PAUSE_ENTRY_TYPE, { parked: false });
		}
	};

	pi.on("context", async (_event, ctx) => {
		await hold(ctx.signal);
	});
	pi.on("tool_call", async (_event, ctx) => {
		await hold(ctx.signal);
	});
}
