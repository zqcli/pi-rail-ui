import { writeFileSync } from "node:fs";

// Loaded with `-e` alongside the real Rail entry point in one Pi process. It
// observes the public ExtensionAPI/ExtensionContext surface only, so it proves
// the Rail factory completed and its registrations reached the live runtime
// without importing Rail at test time (which would bypass the native loader).
export default function pi087RegistrationObserver(pi: any): void {
	pi.on("session_start", (_event: any, ctx: any) => {
		const outputPath = process.env["PI_RAIL_REGISTRATION_OUTPUT"];
		if (!outputPath) throw new Error("PI_RAIL_REGISTRATION_OUTPUT is required");
		const provider = ctx.modelRegistry?.getRegisteredProviderConfig?.("rail-ws-probe");
		writeFileSync(outputPath, JSON.stringify({
			tools: pi.getAllTools().map((tool: any) => tool.name).sort(),
			activeTools: pi.getActiveTools().slice().sort(),
			commands: pi.getCommands().map((command: any) => command.name).sort(),
			provider: provider
				? { api: provider.api ?? null, hasStreamSimple: typeof provider.streamSimple === "function" }
				: null,
		}, null, 2), "utf8");
	});
}
