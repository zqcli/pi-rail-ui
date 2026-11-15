import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { setCapabilityOverrides, TuiAltScreen, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { installUserMessageRail, uninstallUserMessageRail } from "../../../components/messages/user-message";
import { formatUserMessageTimestamp } from "../../../components/messages/user-message-timestamps";
import { ANSI_RE, OSC133_ZONE_END, OSC133_ZONE_FINAL, OSC133_ZONE_START, padToWidth, stripAnsi } from "../../../core/utils";
import { railUserMessageSurface } from "../../../rail/rail-surface";

const nativeRender = UserMessageComponent.prototype.render;
const timestamp = new Date(2026, 0, 2, 15, 4).getTime();

function context(text: string): any {
	return {
		ui: { theme: undefined },
		sessionManager: {
			getBranch: () => [{ type: "message", timestamp, message: { role: "user", content: text } }],
		},
	};
}

// Interpret the real emitted SGR stream, including both full and background-only
// resets. Merely finding a color escape in a row misses a later overriding color.
function cellBackgrounds(line: string): string[] {
	const cells: string[] = [];
	let background = "default";
	let offset = 0;
	for (const match of line.matchAll(ANSI_RE)) {
		cells.push(...Array<string>(visibleWidth(line.slice(offset, match.index))).fill(background));
		offset = match.index + match[0].length;
		if (!match[0].startsWith("\x1b[") || !match[0].endsWith("m")) continue;
		const codes = match[0].slice(2, -1).split(";").map(Number);
		for (let i = 0; i < codes.length; i++) {
			const code = codes[i];
			if (code === 0 || code === 49) background = "default";
			else if (code === 38 || code === 48) {
				const count = codes[i + 1] === 2 ? 4 : 2;
				if (code === 48) background = codes.slice(i, i + count + 1).join(";");
				i += count;
			} else if (code !== undefined && ((code >= 40 && code <= 47) || (code >= 100 && code <= 107))) {
				background = String(code);
			}
		}
	}
	cells.push(...Array<string>(visibleWidth(line.slice(offset))).fill(background));
	return cells;
}

afterEach(() => {
	uninstallUserMessageRail();
	setCapabilityOverrides({});
	initTheme("dark");
});

test("uses Pi's native message background for every timestamp cell in each theme and color mode", async () => {
	const text = "A **wrapped** user message with 中文 and `inline code`.\n\nSecond paragraph stays native.";
	const startCol = railUserMessageSurface.contentStartCol();
	for (const trueColor of [false, true]) {
		setCapabilityOverrides({ trueColor });
		for (const theme of ["dark", "light", "system"]) {
			initTheme(theme);
			await installUserMessageRail(context(text));
			for (const width of [80, 24, 9, railUserMessageSurface.minRenderableWidth()]) {
				for (const outputPad of [0, 1, 2]) {
					const component = new UserMessageComponent(text, undefined, outputPad);
					const native = nativeRender.call(component, width - startCol);
					const rows = component.render(width);
					const timeRow = rows.at(-2)!;
					const label = `${theme}, trueColor=${trueColor}, width=${width}, outputPad=${outputPad}`;
					assert.equal(rows.length, native.length + 1, label);
					assert.ok(rows.every((line) => visibleWidth(line) === width), label);
					assert.deepEqual(cellBackgrounds(timeRow).slice(startCol), cellBackgrounds(native[0]!), label);
					assert.equal(stripAnsi(timeRow).slice(startCol), " " + stripAnsi(padToWidth(formatUserMessageTimestamp(timestamp), width - startCol - 1)), label);
					assert.ok(rows[0]!.startsWith(OSC133_ZONE_START), label);
					assert.ok(rows.at(-1)!.startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL), label);
					assert.ok(!timeRow.includes("\x1b]133;"), label);
					const bodyRows = [...rows.slice(0, -2), rows.at(-1)!];
					for (const [index, line] of bodyRows.entries()) {
						const nativeLine = native[index]!;
						const markers = nativeLine.match(/^(?:\x1b\]133;[ABC]\x07)*/)?.[0] ?? "";
						// Preserve the existing Rail wrapper byte-for-byte, including
						// its clipping if native outputPad exceeds the available width.
						assert.equal(line, markers + railUserMessageSurface.renderSurfaceRow(width, nativeLine.slice(markers.length)), label);
					}
				}
			}
			uninstallUserMessageRail();
		}
	}
});

test("uses a real custom Pi theme instead of a built-in or Rail background", async () => {
	const dir = mkdtempSync(join(tmpdir(), "rail-user-theme-"));
	const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
	try {
		const path = new URL("modes/interactive/theme/dark.json", import.meta.resolve("@earendil-works/pi-coding-agent"));
		const custom = JSON.parse(readFileSync(path, "utf8"));
		custom.name = "rail-user-test";
		custom.colors.userMessageBg = "#173b61";
		mkdirSync(join(dir, "themes"));
		writeFileSync(join(dir, "themes", `${custom.name}.json`), JSON.stringify(custom));
		process.env["PI_CODING_AGENT_DIR"] = dir;
		setCapabilityOverrides({ trueColor: true });
		initTheme(custom.name);
		const text = "Custom theme";
		const component = new UserMessageComponent(text);
		const native = component.render(39);
		assert.deepEqual(new Set(cellBackgrounds(native[0]!)), new Set(["48;2;23;59;97"]));
		await installUserMessageRail(context(text));
		assert.deepEqual(cellBackgrounds(component.render(40).at(-2)!).slice(1), cellBackgrounds(native[0]!));
	} finally {
		if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("invalidates the Rail render when Pi changes theme without replacing the message children", async () => {
	const text = "Theme changes in place";
	initTheme("dark");
	await installUserMessageRail(context(text));
	const component = new UserMessageComponent(text);
	const children = component.children;
	const before = component.render(60);
	assert.equal(component.render(60), before, "unchanged renders still reuse the cache");
	initTheme("light");
	component.invalidate();
	const expected = nativeRender.call(new UserMessageComponent(text), 59);
	const after = component.render(60);
	assert.equal(component.children, children);
	assert.notEqual(after, before);
	assert.notDeepEqual(cellBackgrounds(before[1]!), cellBackgrounds(after[1]!));
	assert.deepEqual(cellBackgrounds(after[1]!).slice(1), cellBackgrounds(expected[1]!));
	assert.deepEqual(cellBackgrounds(after.at(-2)!).slice(1), cellBackgrounds(expected[0]!));
});

test("keeps the native fallback below Rail's minimum width and after uninstall", async () => {
	initTheme("dark");
	const text = "Narrow native fallback";
	const component = new UserMessageComponent(text);
	await installUserMessageRail(context(text));
	for (const width of [1, railUserMessageSurface.minRenderableWidth() - 1]) {
		assert.deepEqual(component.render(width), nativeRender.call(component, width));
	}
	uninstallUserMessageRail();
	assert.deepEqual(component.render(80), nativeRender.call(component, 80));
});

class SelectionTerminal implements Terminal {
	columns = 60;
	rows = 10;
	input?: (data: string) => void;
	start(onInput: (data: string) => void): void { this.input = onInput; }
	stop(): void {}
	drainInput(): Promise<void> { return Promise.resolve(); }
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}
	get kittyProtocolActive(): boolean { return false; }
}

test("preserves Pi fullscreen drag selection and copy for message text and timestamp", async () => {
	initTheme("dark");
	const text = "Native selection still works";
	await installUserMessageRail(context(text));
	const component = new UserMessageComponent(text);
	const terminal = new SelectionTerminal();
	const copied: string[] = [];
	const tui = new TuiAltScreen(terminal, false, undefined, {
		copySelection: async (value) => { copied.push(value); return true; },
	});
	tui.setCopyOnSelect(false);
	tui.setLayoutRoot(component);
	try {
		tui.start();
		tui.renderNow(true);
		for (const value of [text, formatUserMessageTimestamp(timestamp)]) {
			const screen = tui.getScreenLines().map(stripAnsi);
			const row = screen.findIndex((line) => line.includes(value));
			assert.ok(row >= 0);
			const col = screen[row]!.indexOf(value);
			terminal.input!(`\x1b[<0;${col + 1};${row + 1}M`);
			terminal.input!(`\x1b[<32;${col + value.length};${row + 1}M`);
			terminal.input!(`\x1b[<0;${col + value.length};${row + 1}m`);
			tui.renderNow(true);
			assert.equal(tui.hasActiveSelection(), true);
			assert.equal(await tui.copyActiveSelectionToClipboard(), true);
			assert.equal(copied.at(-1), value);
			tui.resetTextSelection();
			tui.renderNow(true);
		}
	} finally {
		await tui.stop();
	}
});
