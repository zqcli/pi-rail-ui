import { writeFile } from "node:fs/promises";
import {
	Container,
	MouseRegion,
	ScrollView,
	Text,
	TuiAltScreen,
	VStack,
	visibleWidth,
	type AutocompleteProvider,
	type Terminal,
} from "@earendil-works/pi-tui";
import {
	AssistantMessageComponent,
	getMarkdownTheme,
	initTheme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { RailEditor } from "../../components/editor";
import { stripAnsi } from "../../core/utils";
import { GutterContainer, installGutterWrappers, uninstallGutterWrappers } from "../../rail/gutter";
import { installAssistantMessageRail, uninstallAssistantMessageRail } from "../../components/messages";
import { installExecutionRails, uninstallExecutionRails } from "../../components/executions";
import { defineRailSection, setRailUiActive, wasRailSectionManuallyToggled } from "../../rail/rail-section";

// Real 0.85.1 bundled native-UI smoke. Input goes through the public Terminal
// seam: `tui.start()` captures the fake terminal's onInput handler and every
// SGR press/motion/release travels that real path. The displayed viewport is
// rebuilt from the public `Terminal.write()` stream; editor/autocomplete/
// selection use public getCursor/getText/setAutocompleteProvider/copySelection.
// `expanded` on native components is an observable internal, not a purely
// public field; tests only assert observable states, event coordinates and
// explicit counts.

const CURSOR_MARKER = "\x1b_pi:c\x07";

class CapturingTerminal implements Terminal {
	input?: (data: string) => void;
	resize?: (() => void) | undefined;
	readonly writes: string[] = [];

	constructor(
		readonly columns: number,
		readonly rows: number,
	) {}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.input = onInput;
		this.resize = onResize;
	}

	stop(): void {}
	drainInput = async (): Promise<void> => {};
	write(data: string): void {
		this.writes.push(data);
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	send(data: string): void {
		this.input?.(data);
	}
}

const editorTheme: any = {
	borderColor: (text: string) => text,
	selectList: {
		selectedPrefix: (t: string) => t,
		selectedText: (t: string) => t,
		description: (t: string) => t,
		scrollInfo: (t: string) => t,
		noMatch: (t: string) => t,
	},
};
const appTheme = { fg: (_name: string, value: string) => value } as any;
const keybindings = { matches: () => false } as any;
const toolUi: any = { requestRender() {}, terminal: { columns: 60, rows: 30 } };

const sgr = {
	press: (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}M`,
	release: (x: number, y: number) => `\x1b[<0;${x + 1};${y + 1}m`,
	motion: (x: number, y: number) => `\x1b[<32;${x + 1};${y + 1}M`,
};

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
		promise.then(
			(value) => { clearTimeout(timer); resolve(value); },
			(error) => { clearTimeout(timer); reject(error); },
		);
	});
}

function screenLines(terminal: CapturingTerminal, height: number): string[] {
	const out = Array.from({ length: height }, () => "");
	const all = terminal.writes.join("");
	const re = /\x1b\[(\d+);1H\x1b\[2K/g;
	const matches = [...all.matchAll(re)];
	for (let index = 0; index < matches.length; index++) {
		const row = Number(matches[index]![1]);
		if (row < 1 || row > height) continue;
		const start = matches[index]!.index + matches[index]![0].length;
		const end = index + 1 < matches.length ? matches[index + 1]!.index : all.length;
		out[row - 1] = all.slice(start, end);
	}
	return out.map((line) => stripAnsi(line.replaceAll(CURSOR_MARKER, "").replaceAll("\x1b[?2026l", "")).replace(/\r$/u, ""));
}

function cellAt(rows: string[], needle: string, char: string): { row: number; column: number } {
	const row = rows.findIndex((line: string) => line.includes(needle));
	if (row < 0) throw new Error(`needle ${JSON.stringify(needle)} not rendered`);
	const stringIndex = rows[row]!.indexOf(char);
	if (stringIndex < 0) throw new Error(`char ${JSON.stringify(char)} not rendered`);
	return { row, column: visibleWidth(rows[row]!.slice(0, stringIndex)) };
}

const createdTuis: any[] = [];
function registerTui(tui: any): any {
	createdTuis.push(tui);
	return tui;
}

function setupEditor(columns: number, gutter: boolean, text: string, options: Record<string, unknown> = {}): { tui: any; editor: any; terminal: CapturingTerminal } {
	const terminal = new CapturingTerminal(columns, 20);
	const tui: any = registerTui(new TuiAltScreen(terminal, false, undefined, options));
	const editor: any = new RailEditor(tui, editorTheme, keybindings, appTheme);
	editor.setText(text);
	tui.setLayoutRoot(gutter ? new GutterContainer(editor) : editor);
	tui.setFocus(editor);
	tui.start();
	tui.renderNow();
	return { tui, editor, terminal };
}

function chatShell(component: any, extra: any[] = []): { transcript: ScrollView; modeRef: any; terminal: CapturingTerminal; tui: any } {
	const document = new Container();
	const chat = new Container();
	for (const item of extra) document.addChild(item);
	document.addChild(chat);
	chat.addChild(component);
	const transcript = new ScrollView(document, { follow: "end", primary: true, scrollbar: "hidden" });
	const root = new VStack([{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 }]);
	const modeRef: any = { documentContainer: document, fullscreenLayoutRoot: root, transcriptScrollView: transcript };
	installGutterWrappers(modeRef);
	const terminal = new CapturingTerminal(60, 6);
	const tui: any = registerTui(new TuiAltScreen(terminal, false, undefined, {}));
	tui.setLayoutRoot(root);
	tui.start();
	tui.renderNow();
	return { transcript, modeRef, terminal, tui };
}

function clickCell(terminal: CapturingTerminal, column: number, row: number): void {
	terminal.send(sgr.press(column, row));
	terminal.send(sgr.release(column, row));
}

export default async function bundleNativeUiProbe(): Promise<void> {
	const outputPath = process.env["PI_RAIL_NATIVE_UI_PROBE_OUTPUT"];
	if (!outputPath) throw new Error("PI_RAIL_NATIVE_UI_PROBE_OUTPUT is required");

	initTheme("dark", true);
	setRailUiActive(true);
	await installExecutionRails({ fg: (_color: string, value: string) => value });

	const results: Record<string, unknown> = {};
	const errors: string[] = [];
	const run = async (name: string, probe: () => Promise<void> | void): Promise<void> => {
		try {
			await probe();
		} catch (error) {
			errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			uninstallGutterWrappers();
			for (const tui of createdTuis.splice(0)) await tui.stop();
		}
	};

	try {
		await run("plain-no-gutter", async () => {
			const { editor, terminal } = setupEditor(40, false, "abcdefghijklmnopqrstuvwxyz 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ");
			const cell = cellAt(screenLines(terminal, 20), "abcdefghijklm", "m");
			clickCell(terminal, cell.column, cell.row);
			results["plain-no-gutter"] = { cursor: editor.getCursor() };
		});

		await run("scrolled-guttered", async () => {
			const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}: click target`);
			const { editor, terminal } = setupEditor(60, true, lines.join("\n"));
			const cell = cellAt(screenLines(terminal, 20), "line 9: click target", "t");
			clickCell(terminal, cell.column, cell.row);
			results["scrolled-guttered"] = { cursor: editor.getCursor() };
		});

		await run("wide-grapheme", async () => {
			const text = "alpha 中文内容 omega 😀🔥 beta";
			const { editor, terminal } = setupEditor(40, true, text);
			const rows = screenLines(terminal, 20);
			const graphemes: unknown[] = [];
			for (const char of ["内", "🔥"]) {
				const needle = char === "内" ? "alpha 中文内容 omega" : "😀🔥 beta";
				const cell = cellAt(rows, needle, char);
				clickCell(terminal, cell.column, cell.row);
				graphemes.push({ char, cursor: editor.getCursor() });
			}
			results["wide-grapheme"] = graphemes;
		});

		await run("drag-copy", async () => {
			let copied = "";
			let resolveCopied!: () => void;
			const copiedPromise = new Promise<void>((resolve) => { resolveCopied = resolve; });
			const { tui, editor, terminal } = setupEditor(40, true, "alpha select omega", {
				copySelection: async (text: string) => {
					copied = text;
					resolveCopied();
					return true;
				},
			});
			const rows = screenLines(terminal, 20);
			const row = rows.findIndex((line) => line.includes("alpha select omega"));
			const start = rows[row]!.indexOf("select");
			const end = start + "select".length - 1;
			const before = editor.getCursor();
			terminal.send(sgr.press(start, row));
			terminal.send(sgr.motion(end, row));
			terminal.send(sgr.release(end, row));
			await withTimeout(copiedPromise, 2000, "copySelection");
			results["drag-copy"] = { copied, before, after: editor.getCursor(), hasSelection: tui.hasActiveSelection() };
		});

		await run("real-autocomplete", async () => {
			const { tui, editor, terminal } = setupEditor(40, false, "");
			let resolveSuggestions!: () => void;
			const suggestionsReady = new Promise<void>((resolve) => { resolveSuggestions = resolve; });
			const provider: AutocompleteProvider = {
				triggerCharacters: ["/"],
				async getSuggestions(lines) {
					resolveSuggestions();
					const prefix = lines[0] ?? "";
					return {
						items: [
							{ value: "rail-oai-search", label: "rail-oai-search" },
							{ value: "rail-oai-fast", label: "rail-oai-fast" },
						],
						prefix,
					};
				},
				applyCompletion(lines, line, _col, item, prefix) {
					const text = lines[line] ?? "";
					return {
						lines: [text.slice(0, text.length - prefix.length) + item.value],
						cursorLine: line,
						cursorCol: text.length - prefix.length + item.value.length,
					};
				},
			};
			editor.setAutocompleteProvider(provider);
			for (const char of "/rail-oai-") terminal.send(char);
			await withTimeout(suggestionsReady, 3000, "autocomplete suggestions");
			tui.renderNow();
			const rows = screenLines(terminal, 20);
			const row = rows.findIndex((line) => line.includes("rail-oai-fast"));
			if (row < 0) throw new Error("completion rows not rendered");
			const column = rows[row]!.indexOf("rail-oai-fast");
			clickCell(terminal, column, row);
			results["real-autocomplete"] = { rendered: rows.filter((line) => line.includes("rail-oai")), text: editor.getText() };
		});

		await run("renderer-tree-open-close", async () => {
			const tool: any = new ToolExecutionComponent("demo", "renderer", {}, {}, {
				renderCall: () => new Text("RENDERER HEADER result text", 0, 0),
			}, toolUi, process.cwd());
			defineRailSection(tool, "toolExecution");
			tool.updateResult({ content: [{ type: "text", text: "result text" }], details: {} }, false);
			tool.setExpanded(false);
		const { terminal, tui } = chatShell(tool);
			tui.setFocus(tool);
			tui.renderNow();
			const states: boolean[] = [];
			const rowMarkers: string[] = [];
			for (let click = 0; click < 2; click++) {
				const rows = screenLines(terminal, 6);
				const target = rows.findIndex((line) => line.includes("to expand") || line.includes("RENDERER HEADER"));
				if (target < 0) throw new Error(`renderer row missing (click ${click})`);
				clickCell(terminal, 20, target);
				tui.renderNow();
				states.push(tool.expanded);
				const after = screenLines(terminal, 6);
				rowMarkers.push(tool.expanded ? (after.some((l) => l.includes("RENDERER HEADER")) ? "content" : "?") : (after.some((l) => l.includes("to expand")) ? "hint" : "?"));
			}
			results["renderer-tree-open-close"] = { states, rowMarkers };
		});

		await run("renderer-disabled", async () => {
			const tool: any = new ToolExecutionComponent("demo", "disabled", {}, {}, {
				renderCall: () => new Text("DISABLED HEADER", 0, 0),
			}, toolUi, process.cwd());
			defineRailSection(tool, "toolExecution", { clickToToggle: false });
			tool.updateResult({ content: [{ type: "text", text: "result text" }], details: {} }, false);
			tool.setExpanded(true);
			const setValues: boolean[] = [];
			const originalSet = tool.setExpanded.bind(tool);
			tool.setExpanded = (value: boolean) => {
				setValues.push(value);
				return originalSet(value);
			};
			const { terminal, tui } = chatShell(tool);
			tui.setFocus(tool);
			tui.renderNow();
			const rows = screenLines(terminal, 6);
			const row = rows.findIndex((line) => line.includes("DISABLED HEADER"));
			if (row < 0) throw new Error("disabled renderer header not rendered");
			clickCell(terminal, 20, row);
			results["renderer-disabled"] = {
				expanded: tool.expanded,
				setValues,
				manuallyToggled: wasRailSectionManuallyToggled(tool),
			};
		});

		await run("custom-control-phases", async () => {
			const phaseEvents: Array<{ type: string; x: number; y: number; width: number }> = [];
			let renderWidth = 0;
			class PhaseControl {
				render(width: number): string[] {
					renderWidth = width;
					return ["PHASE CONTROL"];
				}
				invalidate(): void {}
				handleMouse(event: any): any {
					phaseEvents.push({ type: event.type, x: event.x, y: event.y, width: event.width });
					return event.type === "press" ? { handled: true, capture: true } : { handled: true };
				}
			}
			const tool: any = new ToolExecutionComponent("demo", "phases", {}, {}, {
				renderShell: "self",
				renderCall: () => new PhaseControl(),
			}, toolUi, process.cwd());
			defineRailSection(tool, "toolExecution");
			tool.updateResult({ content: [{ type: "text", text: "x" }], details: {} }, false);
			tool.setExpanded(true);
			const { terminal, tui } = chatShell(tool);
			tui.setFocus(tool);
			tui.renderNow();
			const rows = screenLines(terminal, 6);
			const row = rows.findIndex((line) => line.includes("PHASE CONTROL"));
			if (row < 0) throw new Error("phase control not rendered");
			const column = rows[row]!.indexOf("PHASE CONTROL") + 2;
			terminal.send(sgr.press(column, row));
			terminal.send(sgr.motion(column + 2, row));
			terminal.send(sgr.release(column + 2, row));
			results["custom-control-phases"] = { renderWidth, phaseEvents, expanded: tool.expanded };
		});

		await run("simple-collapsed-hidden", async () => {
			const childEvents: Array<{ type: string }> = [];
			const tool: any = new ToolExecutionComponent("demo", "simple", {}, {}, {
				renderCall: () => new MouseRegion(new Text("HIDDEN CONTROL", 0, 0), (event: any) => {
					childEvents.push({ type: event.type });
					return event.type === "click" ? { handled: true } : undefined;
				}),
			}, toolUi, process.cwd());
			defineRailSection(tool, "toolExecution");
			tool.updateResult({ content: [{ type: "text", text: "short" }], details: {} }, false);
			tool.setExpanded(true);
			const { terminal, tui } = chatShell(tool);
			tui.setFocus(tool);
			tui.renderNow();
			const expandedRows = screenLines(terminal, 6);
			if (!expandedRows.some((line) => line.includes("HIDDEN CONTROL"))) throw new Error("expanded control not rendered");
			tool.setExpanded(false);
			tui.renderNow();
			const collapsedRows = screenLines(terminal, 6);
			if (collapsedRows.some((line) => line.includes("HIDDEN CONTROL"))) throw new Error("collapsed simple rows must hide the control");
			const collapseRow = collapsedRows.findIndex((line) => line.trim().length > 0);
			if (collapseRow < 0) throw new Error("simple collapsed rows not rendered");
			// Hidden control must not receive press/motion on the collapsed block.
			terminal.send(sgr.press(20, collapseRow + 1));
			terminal.send(sgr.motion(20, collapseRow + 1));
			terminal.send(sgr.release(20, collapseRow + 1));
			const phaseEventsWhileCollapsed = childEvents.length;
			// A click on the collapsed block still toggles the section (rail owns it).
			const beforeClick = tool.expanded;
			clickCell(terminal, 20, collapseRow + 1);
			results["simple-collapsed-hidden"] = {
				collapsed: { expanded: tool.expanded, childEvents: childEvents.length },
				phaseEventsWhileCollapsed,
				toggledOnCollapsedClick: tool.expanded !== beforeClick,
				expandedFinal: tool.expanded,
			};
		});

		await run("follow-end-anchor", async () => {
			const tool: any = new ToolExecutionComponent("demo", "anchor", {}, {}, undefined, toolUi, process.cwd());
			defineRailSection(tool, "toolExecution");
			tool.updateResult({ content: [{ type: "text", text: Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") }], details: {} }, false);
			tool.setExpanded(true);
			const filler = new Text("F1\nF2\nF3\nF4\nF5", 0, 0);
			const { transcript, modeRef, terminal, tui } = chatShell(tool, [filler]);
			tui.setFocus(tool);
			const scrollCalls: Array<{ top: number; disableFollow?: boolean }> = [];
			const spy = new Proxy(transcript, {
				get(target, prop, receiver) {
					if (prop === "scrollTo") {
						return (top: number, options?: { disableFollow?: boolean }) => {
							const call: { top: number; disableFollow?: boolean } = { top };
							if (options?.disableFollow !== undefined) call.disableFollow = options.disableFollow;
							scrollCalls.push(call);
							return Reflect.get(target, prop, receiver).call(target, top, options);
						};
					}
					return Reflect.get(target, prop, receiver);
				},
			});
			modeRef.transcriptScrollView = spy;
			tui.renderNow();
			const before = { follow: transcript.isFollowingEnd, top: transcript.scrollTop };
			const rows = screenLines(terminal, 6);
			const hintRow = rows.findIndex((line) => line.includes("to expand"));
			if (hintRow < 0) throw new Error("anchor hint not rendered");
			clickCell(terminal, 20, hintRow);
			tui.renderNow();
			const after = { follow: transcript.isFollowingEnd, top: transcript.scrollTop, expanded: tool.expanded };
			results["follow-end-anchor"] = { before, after, scrollCalls };
		});

		await run("assistant-thinking", async () => {
			await installAssistantMessageRail(appTheme);
			const message: any = {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: Array.from({ length: 8 }, (_, i) => `thinking line ${i + 1}`).join("\n") },
					{ type: "text", text: "reply text" },
				],
			};
			const msg = new AssistantMessageComponent(message, false, getMarkdownTheme()) as any;
			msg.updateContent(message, false);
			const { terminal, tui } = chatShell(msg);
			tui.setFocus(msg);
			tui.renderNow();
			const hintRow = screenLines(terminal, 6).findIndex((line) => line.includes("to expand"));
			if (hintRow < 0) throw new Error("thinking preview hint not rendered");
			clickCell(terminal, 20, hintRow);
			tui.renderNow();
			const railRows = screenLines(terminal, 6);
			results["assistant-thinking-rail"] = {
				railExpandedVisible: railRows.some((line) => line.includes("thinking line 5")),
				nativeHiddenLabel: railRows.some((line) => line.includes("Thinking...")),
				hideThinkingBlock: msg.hideThinkingBlock,
			};

			uninstallAssistantMessageRail();
			msg.updateContent(message, false);
			const terminal2 = new CapturingTerminal(60, 8);
			const tui2: any = registerTui(new TuiAltScreen(terminal2, false, undefined, {}));
			tui2.setLayoutRoot(new ScrollView(msg, { follow: "end", primary: true, scrollbar: "hidden" }));
			tui2.setFocus(msg);
			tui2.start();
			tui2.renderNow();
			const nativeRows = screenLines(terminal2, 8);
			const thinkingRow = nativeRows.findIndex((line) => line.includes("thinking line 4"));
			if (thinkingRow < 0) throw new Error("native thinking not rendered after disable");
			clickCell(terminal2, thinkingRow >= 0 ? 20 : 0, thinkingRow);
			await withTimeout(new Promise<void>((resolve) => {
				const poll = () => {
					if (screenLines(terminal2, 8).some((line) => line.includes("Thinking..."))) resolve();
					else setTimeout(poll, 20);
				};
				poll();
			}), 2000, "native thinking hide");
			results["assistant-thinking-native"] = { hiddenLabelVisible: screenLines(terminal2, 8).some((line) => line.includes("Thinking...")) };
		});
	} finally {
		uninstallExecutionRails();
		uninstallAssistantMessageRail();
		uninstallGutterWrappers();
		for (const tui of createdTuis.splice(0)) await tui.stop();
	}

	await writeFile(outputPath, JSON.stringify({ results, errors }, null, 2), "utf8");
}