import { TUI } from "@earendil-works/pi-tui";
import { createStore, restorePrototypePatches, type PrototypePatchTarget } from "../../core/patching";

const BEGIN_SYNCHRONIZED_OUTPUT = "\x1b[?2026h";
const END_SYNCHRONIZED_OUTPUT = "\x1b[?2026l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CAPTURE_ACTIVE = Symbol.for("pi-rail-ui.tui-output-coalescing.active");

type TuiCtor = { prototype: any };

type TerminalOutputCoalescingStore = {
	targets: PrototypePatchTarget[];
};

const getTerminalOutputCoalescingStore = createStore<TerminalOutputCoalescingStore>(
	"terminal-output-coalescing",
	() => ({ targets: [] }),
);

async function resolveNativeTuiExport<T>(exportName: string): Promise<T | undefined> {
	try {
		const packageUrl = import.meta.resolve("@earendil-works/pi-tui");
		const nativeModule = (await import(packageUrl)) as Record<string, T | undefined>;
		return nativeModule[exportName];
	} catch {
		return undefined;
	}
}

export function coalesceTerminalOutputChunks(chunks: string[]): string {
	if (chunks.length === 0) return "";
	const combined = chunks.join("");
	const endIndex = combined.lastIndexOf(END_SYNCHRONIZED_OUTPUT);
	if (endIndex < 0 || endIndex + END_SYNCHRONIZED_OUTPUT.length >= combined.length) return combined;
	const beforeEnd = combined.slice(0, endIndex);
	if (!beforeEnd.includes(BEGIN_SYNCHRONIZED_OUTPUT)) return combined;
	const afterEnd = combined.slice(endIndex + END_SYNCHRONIZED_OUTPUT.length);
	return `${beforeEnd}${afterEnd}${END_SYNCHRONIZED_OUTPUT}`;
}

export function withCoalescedTerminalOutput<T>(tui: any, render: () => T): T {
	const terminal = tui?.terminal;
	if (!terminal || typeof terminal.write !== "function" || terminal[CAPTURE_ACTIVE]) return render();

	const originalWrite = terminal.write;
	const originalHideCursor = typeof terminal.hideCursor === "function" ? terminal.hideCursor : undefined;
	const originalShowCursor = typeof terminal.showCursor === "function" ? terminal.showCursor : undefined;
	const chunks: string[] = [];
	let result!: T;
	let thrown: unknown;
	let didThrow = false;

	terminal[CAPTURE_ACTIVE] = true;
	terminal.write = function capturedTerminalWrite(data: string): void {
		chunks.push(String(data ?? ""));
	};
	if (originalHideCursor) {
		terminal.hideCursor = function capturedTerminalHideCursor(): void {
			chunks.push(HIDE_CURSOR);
		};
	}
	if (originalShowCursor) {
		terminal.showCursor = function capturedTerminalShowCursor(): void {
			chunks.push(SHOW_CURSOR);
		};
	}

	try {
		result = render();
	} catch (error) {
		thrown = error;
		didThrow = true;
	} finally {
		terminal.write = originalWrite;
		if (originalHideCursor) terminal.hideCursor = originalHideCursor;
		if (originalShowCursor) terminal.showCursor = originalShowCursor;
		delete terminal[CAPTURE_ACTIVE];
		const output = coalesceTerminalOutputChunks(chunks);
		if (output.length > 0) originalWrite.call(terminal, output);
	}

	if (didThrow) throw thrown;
	return result;
}

function patchTuiOutputCoalescing(ctor: TuiCtor | undefined, store: TerminalOutputCoalescingStore): void {
	if (!ctor?.prototype || typeof ctor.prototype.doRender !== "function") return;
	if (store.targets.some((target) => target.ctor === ctor && target.methodName === "doRender")) return;

	const originalDoRender = ctor.prototype.doRender;
	ctor.prototype.doRender = function patchedRailUiDoRender(this: any, ...args: any[]) {
		return withCoalescedTerminalOutput(this, () => originalDoRender.apply(this, args));
	};
	store.targets.push({ ctor, methodName: "doRender", original: originalDoRender });
}

export async function installTerminalOutputCoalescing(): Promise<void> {
	const store = getTerminalOutputCoalescingStore();
	patchTuiOutputCoalescing(TUI as unknown as TuiCtor, store);
	patchTuiOutputCoalescing(await resolveNativeTuiExport<TuiCtor>("TUI"), store);
}

export function uninstallTerminalOutputCoalescing(): void {
	const store = getTerminalOutputCoalescingStore();
	restorePrototypePatches(store.targets);
}
