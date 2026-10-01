import assert from "node:assert/strict";
import { test } from "node:test";
import installRailUi from "../../index";

async function railUiHandler() {
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const channels = new Map<string, Set<(data: unknown) => void>>();
	await installRailUi({
		registerTool: () => undefined,
		registerCommand: (name: string, options: any) => { commands.set(name, options.handler); },
		registerProvider: () => undefined,
		on: () => undefined,
		events: {
			emit: (channel: string, data: unknown) => { for (const handler of channels.get(channel) ?? []) handler(data); },
			on: (channel: string, handler: (data: unknown) => void) => {
				const handlers = channels.get(channel) ?? new Set<(data: unknown) => void>();
				handlers.add(handler);
				channels.set(channel, handlers);
				return () => handlers.delete(handler);
			},
		},
	} as any);
	return commands.get("rail-ui")!;
}

function context(mode: string) {
	const notifications: Array<[string, string]> = [];
	const ctx: any = {
		mode,
		ui: {
			notify: (text: string, level: string) => notifications.push([text, level]),
			setEditorComponent: () => undefined,
			setFooter: () => undefined,
		},
	};
	return { ctx, notifications };
}

test("/rail-ui outside the TUI warns and leaves the toggle untouched", async () => {
	const handler = await railUiHandler();
	const rpc = context("rpc");
	await handler("", rpc.ctx);
	assert.deepEqual(rpc.notifications, [["/rail-ui requires interactive TUI mode.", "warning"]]);

	// The ignored call must not have flipped the state: the first TUI toggle still disables.
	const tui = context("tui");
	await handler("", tui.ctx);
	assert.deepEqual(tui.notifications, [["Pi rail UI disabled", "info"]]);
});
