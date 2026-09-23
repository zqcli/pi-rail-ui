import { writeFileSync } from "node:fs";

const OBSERVE_COMMAND = "pi087-observe-registrations";

function observe(pi: any, ctx: any, requestedPath: string | undefined, phase: string): void {
	const outputPath = requestedPath?.trim() || process.env["PI_RAIL_REGISTRATION_OUTPUT"];
	if (!outputPath) throw new Error("PI_RAIL_REGISTRATION_OUTPUT or an observation path is required");
	const provider = ctx.modelRegistry?.getRegisteredProviderConfig?.("rail-ws-probe");
	const tools = pi.getAllTools();
	const commands = pi.getCommands();
	writeFileSync(outputPath, JSON.stringify({
		phase,
		tools: tools.map((tool: any) => tool.name).sort(),
		activeTools: pi.getActiveTools().slice().sort(),
		commands: commands.map((command: any) => command.name).sort(),
		toolInfo: tools
			.filter((tool: any) => ["subagent", "subagent_team", "team"].includes(tool.name))
			.map((tool: any) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			}))
			.sort((left: any, right: any) => left.name.localeCompare(right.name)),
		provider: provider
			? { api: provider.api ?? null, hasStreamSimple: typeof provider.streamSimple === "function" }
			: null,
	}, null, 2), "utf8");
}

// Loaded with `-e` alongside the real Rail entry point in one Pi process. It
// observes the public ExtensionAPI/ExtensionContext surface only, so it proves
// the Rail factory completed and its registrations reached the live runtime
// without importing Rail at test time (which would bypass the native loader).
// The explicit observation command also lets the native child-helper probe
// inspect the post-bind tool registry without starting a model generation.
export default function pi087RegistrationObserver(pi: any): void {
	pi.registerCommand(OBSERVE_COMMAND, {
		description: "Write the native registration snapshot to a test path",
		handler: async (args: string, ctx: any) => {
			observe(pi, ctx, args, "command");
		},
	});
	pi.on("session_start", (_event: any, ctx: any) => {
		observe(pi, ctx, undefined, "session_start");
	});
}
