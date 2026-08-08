import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";
import { initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { OSC133_ZONE_END, OSC133_ZONE_FINAL, OSC133_ZONE_START, stripAnsi } from "../../../core/utils";
import {
	installUserMessageRail,
	uninstallUserMessageRail,
} from "../../../components/messages/user-message";

before(() => {
	initTheme("dark");
});

afterEach(() => {
	uninstallUserMessageRail();
});

function extensionContextWithUserMessage(text: string, timestamp: number): any {
	return {
		ui: { theme: undefined },
		sessionManager: {
			getBranch: () => [{
				type: "message",
				timestamp,
				message: { role: "user", content: [{ type: "text", text }] },
			}],
		},
	};
}

test("renders the persisted send time on a Pi user message", async () => {
	const text = "timestamp regression";
	const timestamp = new Date(2026, 0, 2, 15, 4).getTime();

	await installUserMessageRail(extensionContextWithUserMessage(text, timestamp));
	const component = new UserMessageComponent(text);
	const rows = component.render(80);
	const rendered = rows.map(stripAnsi).join("\n");

	assert.match(rendered, /3:04 PM · 1\/2\/2026/);
	assert.ok(rows[0]?.startsWith(OSC133_ZONE_START));
	assert.ok(rows.at(-1)?.startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL));
});

test("keeps the timestamp and rail surface after Pi rebuilds user message children", async () => {
	const text = "rebuilt user message";
	const timestamp = new Date(2026, 0, 3, 9, 12).getTime();

	await installUserMessageRail(extensionContextWithUserMessage(text, timestamp));
	const component = new UserMessageComponent(text);
	component.setOutputPad(0);
	const renderedRows = component.render(80).map(stripAnsi);

	assert.ok(renderedRows.some((line) => line.startsWith("▎")));
	assert.match(renderedRows.join("\n"), /9:12 AM · 1\/3\/2026/);
});

test("preserves native user Markdown transformers and outputPad", async () => {
	const text = "native user message";
	const timestamp = new Date(2026, 0, 3, 9, 30).getTime();
	const transformContexts: any[] = [];
	const transformer = (markdown: string, context: any) => {
		transformContexts.push(context);
		return markdown.replace("native user", "transformed user");
	};

	await installUserMessageRail(extensionContextWithUserMessage(text, timestamp));
	const component = new (UserMessageComponent as any)(text, undefined, 0, [transformer]);
	const contentBox = component.children[0];
	const rendered = stripAnsi(component.render(80).join("\n"));

	assert.equal(contentBox.paddingX, 0);
	if ("markdownTransformers" in component) {
		assert.match(rendered, /transformed user message/);
		assert.deepEqual(transformContexts.at(-1), {
			messageType: "user",
			isStreaming: false,
			availableWidth: 79,
		});
	} else {
		assert.match(rendered, /native user message/);
	}
});

test("keeps compatibility with the pre-0.80.3 contentBox layout", async () => {
	const text = "legacy user message";
	const timestamp = new Date(2026, 0, 3, 10, 25).getTime();

	await installUserMessageRail(extensionContextWithUserMessage(text, timestamp));
	const component = new UserMessageComponent(text) as any;
	component.contentBox = component.children[0];
	component.children = [];
	const rendered = component.render(80).map(stripAnsi).join("\n");

	assert.match(rendered, /10:25 AM · 1\/3\/2026/);
});