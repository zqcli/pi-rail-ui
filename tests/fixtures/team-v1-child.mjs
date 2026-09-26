import { appendFileSync } from "node:fs";
import { join } from "node:path";

// A retired v1 Team child: it exposes only the v1 private command. Any prompt, command delivery or
// model request reaching it is recorded so the parent-side handshake can be proven to refuse it first.
function record(ctx, kind) {
	appendFileSync(join(ctx.cwd, "p01-v1-child-activity.log"), `${kind}\n`);
}

export default function install(pi) {
	pi.registerCommand("rail-subagent-team-protocol", {
		description: "Rail private team protocol v1",
		handler: async (_args, ctx) => record(ctx, "v1-command"),
	});
	pi.on("before_agent_start", (_event, ctx) => record(ctx, "before_agent_start"));
	pi.on("context", (_event, ctx) => record(ctx, "provider-context"));
}
