import { getSelectListTheme, type ExtensionCommandContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor, Input, Key, ScrollView, matchesKey, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { parseRailContinueDuration, type RailContinueController, type RailContinueSnapshot } from "../../commands/rail-continue-scheduler";

const oneLine = (text: string) => stripTerminalSequences(text).replace(/\s+/gu, " ").trim();
const fit = (text: string, width: number) => truncateToWidth(text, Math.max(1, width), "", true);
const interval = (ms: number) => ms % 3_600_000 === 0 ? `${ms / 3_600_000}h` : ms % 60_000 === 0 ? `${ms / 60_000}m` : `${ms / 1000}s`;
const countdown = (at: number, now: number) => {
	const seconds = Math.max(0, Math.ceil((at - now) / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
const stamp = (at: number) => {
	const date = new Date(at);
	return Number.isNaN(date.getTime()) ? "beyond calendar range" : date.toLocaleString();
};

/** A view of session-local tasks; closing it never cancels or pauses the controller. */
export class RailContinueOverlayComponent implements Focusable {
	private snapshot: RailContinueSnapshot;
	private tab: "pending" | "create" = "pending";
	private selected = 0;
	private selectedId: string | undefined;
	private detailId: string | undefined;
	private confirmationId: string | undefined;
	private formFocus = 0;
	private readonly durationInput = new Input({ prompt: "", placeholder: "5m", placeholderStyle: (text) => this.theme.fg("dim", text) });
	private readonly messageEditor: Editor;
	private readonly detailScroll: ScrollView;
	private readonly unsubscribe: () => void;
	private timer: ReturnType<typeof setInterval> | undefined;
	private notice = "";
	private disposed = false;
	private _focused = false;
	private detailRows = 1;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly done: () => void,
		private readonly controller: RailContinueController,
		private readonly now: () => number = Date.now,
	) {
		this.snapshot = controller.snapshot();
		this.selectedId = this.snapshot.tasks[0]?.id;
		this.durationInput.setValue("5m");
		this.messageEditor = new Editor(tui, { borderColor: (text) => theme.fg("border", text), selectList: getSelectListTheme() });
		this.messageEditor.disableSubmit = true;
		this.detailScroll = new ScrollView({ render: (width) => this.detailLines(width), invalidate: () => {} });
		this.unsubscribe = controller.subscribe(() => this.refresh());
		this.syncTimer();
	}

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) { this._focused = value; this.syncFocus(); }

	invalidate(): void {
		this.durationInput.invalidate();
		this.messageEditor.invalidate();
		this.detailScroll.invalidate();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.syncFocus();
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.unsubscribe();
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (matchesKey(data, Key.ctrl("c"))) { this.finish(); return; }
		if (this.confirmationId) {
			if (this.isCancel(data) || data === "n" || data === "N") this.confirmationId = undefined;
			else if (data === "y" || data === "Y") {
				const id = this.confirmationId;
				this.confirmationId = undefined;
				this.notice = this.controller.cancel(id) ? `Cancelled ${id}` : `${id} is no longer pending`;
				this.refresh();
			}
		} else if (this.detailId) {
			if (this.isCancel(data)) this.detailId = undefined;
			else if (data === "d") this.confirmationId = this.detailId;
			else this.scrollDetail(data);
		} else if (this.tab === "create") this.handleCreateInput(data);
		else this.handlePendingInput(data);
		this.syncFocus();
		this.requestRender();
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const height = this.height();
		const inner = Math.max(1, width - 2);
		const framed = width >= 4 && height >= 5;
		const contentWidth = framed ? inner : width;
		const header = this.tabs(contentWidth);
		const help = this.help();
		const showSummary = height >= 10;
		const showNotice = Boolean(this.notice) && height >= 8;
		const reserved = (framed ? 2 : 0) + 2 + Number(showSummary) + Number(showNotice);
		const bodyRows = Math.max(1, height - reserved);
		const body = this.confirmationId ? this.renderConfirmation(contentWidth, bodyRows)
			: this.detailId ? this.renderDetail(contentWidth, bodyRows)
				: this.tab === "create" ? this.renderCreate(contentWidth, bodyRows)
					: this.renderPending(contentWidth, bodyRows);
		const lines = [header];
		if (showSummary) {
			const summary = this.tab === "create" ? "Interval: integer s/m/h · bare = minutes · Arm starts countdown"
				: this.snapshot.busyReason ? `Last check · ${oneLine(this.snapshot.busyReason)}` : "Checks only at deadline · busy → full interval";
			lines.push(` ${this.theme.fg("dim", summary)}`);
		}
		lines.push(...body);
		if (showNotice) lines.push(` ${this.theme.fg("warning", oneLine(this.notice))}`);
		lines.push(` ${this.theme.fg("dim", help)}`);
		if (!framed) return lines.slice(0, height).map((text) => fit(text, width));
		const border = (text: string) => this.theme.fg("borderAccent", text);
		const row = (text: string) => `${this.theme.fg("border", "│")}${fit(text, inner)}${this.theme.fg("border", "│")}`;
		return [border(`╭${"─".repeat(inner)}╮`), ...lines.map(row), border(`╰${"─".repeat(inner)}╯`)];
	}

	private height(): number {
		const rows = this.tui.terminal?.rows ?? 30;
		return Math.max(1, Math.min(Math.floor(rows * 0.88), rows - 2));
	}

	private tabs(width: number): string {
		const pending = `Pending ${this.snapshot.tasks.length}`;
		const tabs = this.tab === "pending" ? `${this.theme.fg("accent", `[${pending}]`)} ${this.theme.fg("dim", "Create")}`
			: `${this.theme.fg("dim", pending)} ${this.theme.fg("accent", "[Create]")}`;
		return width >= 42 ? ` ${this.theme.fg("accent", this.theme.bold("Rail Continue"))}  ${tabs}` : ` ${tabs}`;
	}

	private renderPending(width: number, rows: number): string[] {
		if (!this.snapshot.tasks.length) return [" No pending tasks · n create"];
		const perTask = rows >= 4 ? 2 : 1;
		const visible = Math.max(1, Math.floor(rows / perTask));
		const start = Math.max(0, Math.min(this.selected - Math.floor(visible / 2), this.snapshot.tasks.length - visible));
		const lines: string[] = [];
		for (let index = start; index < Math.min(start + visible, this.snapshot.tasks.length); index++) {
			const task = this.snapshot.tasks[index]!;
			const prefix = index === this.selected ? this.theme.fg("accent", " → ") : "   ";
			const check = `CHECK ${countdown(task.nextCheckAt, this.now())}`;
			const text = `${task.id} · ${check} · every ${interval(task.intervalMs)} · resets ${task.resetCount}`;
			lines.push(`${prefix}${index === this.selected ? this.theme.fg("accent", text) : text}`);
			if (perTask > 1) {
				const reason = task.lastCheckReason ? `${oneLine(task.lastCheckReason)} · ` : "";
				lines.push(`   ${this.theme.fg("muted", truncateToWidth(`${reason}${oneLine(task.message)}`, Math.max(1, width - 3), "…"))}`);
			}
		}
		return lines;
	}

	private detailLines(width: number): string[] {
		const task = this.snapshot.tasks.find((entry) => entry.id === this.detailId);
		if (!task) return [" Task is no longer pending"];
		const text = [
			`Task ${task.id}`,
			`Next CHECK: ${countdown(task.nextCheckAt, this.now())} · ${stamp(task.nextCheckAt)}`,
			"This is a check time, not a guaranteed execution time.",
			`Interval: ${interval(task.intervalMs)} · resets: ${task.resetCount}`,
			`Last check: ${task.lastCheckReason ?? "not checked yet"}`,
			`Created: ${stamp(task.createdAt)}`,
			"One submission attempt consumes the task; no automatic send retries.",
			"Message:",
			...task.message.split("\n"),
		];
		return text.flatMap((line) => wrapTextWithAnsi(stripTerminalSequences(line).replace(/\t/gu, "    "), Math.max(1, width)));
	}

	private renderDetail(width: number, rows: number): string[] {
		this.detailRows = rows;
		const lines = this.detailScroll.render(Math.max(1, width - 2));
		this.detailScroll.updateLayout(lines.length, rows, () => this.requestRender());
		return lines.slice(this.detailScroll.scrollTop, this.detailScroll.scrollTop + rows).map((line) => ` ${line}`);
	}

	private renderCreate(width: number, rows: number): string[] {
		const durationPrefix = width >= 22 ? " Interval: " : width >= 8 ? " I: " : "";
		const durationLine = `${durationPrefix}${this.durationInput.render(Math.max(1, width - durationPrefix.length - 1))[0] ?? ""}`;
		const arm = this.formFocus === 2 ? this.theme.fg("accent", " → [Arm task]") : "   [Arm task]";
		if (rows < 3) return this.formFocus === 0 ? [durationLine] : this.formFocus === 2 ? [arm] : this.editorLines(width, rows);
		const messageRows = Math.max(1, rows - (rows >= 5 ? 3 : 2));
		return [durationLine, ...(rows >= 5 ? [` ${this.theme.fg("muted", "Message (Enter newline):")}`] : []), ...this.editorLines(width, messageRows), arm];
	}

	private editorLines(width: number, rows: number): string[] {
		const lines = this.messageEditor.render(Math.max(1, width - 2)).slice(1, -1);
		const cursor = lines.findIndex((line) => line.includes(CURSOR_MARKER));
		const start = Math.max(0, Math.min(cursor < 0 ? lines.length - rows : cursor - rows + 1, lines.length - rows));
		return lines.slice(start, start + rows).map((line) => ` ${line}`);
	}

	private renderConfirmation(width: number, rows: number): string[] {
		return [`Cancel task ${this.confirmationId}?`, "Only this stable ID will be cancelled.", "y confirm · n / esc keep task"]
			.flatMap((text) => wrapTextWithAnsi(text, Math.max(1, width - 2))).slice(0, rows).map((text) => ` ${this.theme.fg("warning", text)}`);
	}

	private help(): string {
		if (this.confirmationId) return "y cancel by ID · n / esc back";
		if (this.detailId) return "↑↓ / PgUp PgDn scroll · d cancel · esc back";
		if (this.tab === "create") return "tab fields · enter newline / arm · esc pending";
		return "↑↓ select · enter detail · d cancel · n / tab create · esc close";
	}

	private handlePendingInput(data: string): void {
		if (this.isCancel(data)) { this.finish(); return; }
		if (data === "n" || matchesKey(data, Key.tab) || matchesKey(data, Key.right) || matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
			this.tab = "create";
			this.notice = "";
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up)) this.selected--;
		else if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.down)) this.selected++;
		else if (matchesKey(data, Key.home)) this.selected = 0;
		else if (matchesKey(data, Key.end)) this.selected = this.snapshot.tasks.length - 1;
		this.selected = Math.max(0, Math.min(this.selected, this.snapshot.tasks.length - 1));
		this.selectedId = this.snapshot.tasks[this.selected]?.id;
		if (this.isConfirm(data) && this.selectedId) { this.detailId = this.selectedId; this.detailScroll.scrollToStart(); }
		else if (data === "d" && this.selectedId) this.confirmationId = this.selectedId;
	}

	private handleCreateInput(data: string): void {
		if (matchesKey(data, Key.escape)) { this.tab = "pending"; this.notice = ""; return; }
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			this.formFocus = (this.formFocus + (matchesKey(data, Key.tab) ? 1 : 2)) % 3;
			return;
		}
		if (this.formFocus === 0) {
			if (this.isEditorSubmit(data)) this.formFocus = 1;
			else this.durationInput.handleInput(data);
		} else if (this.formFocus === 1) {
			// Enter edits the draft. Only the separate Arm action authorizes a task.
			if (this.isEditorSubmit(data)) this.messageEditor.insertTextAtCursor("\n");
			else this.messageEditor.handleInput(data);
		} else if (this.isConfirm(data)) this.arm();
	}

	private arm(): void {
		try {
			const intervalMs = parseRailContinueDuration(this.durationInput.getValue());
			const message = this.messageEditor.getExpandedText();
			if (!message.trim()) throw new Error("Message cannot be empty");
			const task = this.controller.create(intervalMs, message);
			this.selectedId = task.id;
			this.messageEditor.setText("");
			this.formFocus = 0;
			this.tab = "pending";
			this.notice = `Armed ${task.id} · next CHECK in ${interval(task.intervalMs)}`;
			this.refresh();
		} catch (error) {
			this.notice = error instanceof Error ? error.message : String(error);
		}
	}

	private scrollDetail(data: string): void {
		if (matchesKey(data, Key.home)) this.detailScroll.scrollToStart();
		else if (matchesKey(data, Key.end)) this.detailScroll.scrollToEnd();
		else if (matchesKey(data, Key.pageUp)) this.detailScroll.scrollBy(-this.detailRows);
		else if (matchesKey(data, Key.pageDown)) this.detailScroll.scrollBy(this.detailRows);
		else if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up)) this.detailScroll.scrollBy(-1);
		else if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.down)) this.detailScroll.scrollBy(1);
	}

	private refresh(): void {
		if (this.disposed) return;
		this.snapshot = this.controller.snapshot();
		if (!this.snapshot.active) { this.finish(); return; }
		const index = this.snapshot.tasks.findIndex((task) => task.id === this.selectedId);
		this.selected = index >= 0 ? index : Math.max(0, Math.min(this.selected, this.snapshot.tasks.length - 1));
		this.selectedId = this.snapshot.tasks[this.selected]?.id;
		if (this.detailId && !this.snapshot.tasks.some((task) => task.id === this.detailId)) this.detailId = undefined;
		this.syncTimer();
		this.requestRender();
	}

	private syncTimer(): void {
		if (this.snapshot.active && this.snapshot.tasks.length && !this.timer) {
			this.timer = setInterval(() => this.requestRender(), 1000);
			this.timer.unref();
		} else if ((!this.snapshot.active || !this.snapshot.tasks.length) && this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	private syncFocus(): void {
		const editable = this._focused && !this.disposed && this.tab === "create" && !this.confirmationId && !this.detailId;
		this.durationInput.focused = editable && this.formFocus === 0;
		this.messageEditor.focused = editable && this.formFocus === 1;
	}

	private isCancel(data: string): boolean { return matchesKey(data, Key.escape) || this.keybindings.matches(data, "tui.select.cancel"); }
	private isConfirm(data: string): boolean { return matchesKey(data, Key.enter) || this.keybindings.matches(data, "tui.select.confirm"); }
	private isEditorSubmit(data: string): boolean { return matchesKey(data, Key.enter) || this.keybindings.matches(data, "tui.input.submit"); }
	private requestRender(): void {
		if (this.disposed) return;
		try { this.tui.requestRender(); } catch { this.dispose(); }
	}
	private finish(): void {
		if (this.disposed) return;
		this.dispose();
		try { this.done(); } catch { /* Session replacement may have already removed the native overlay. */ }
	}
}

export async function openRailContinueOverlay(ctx: ExtensionCommandContext, controller: RailContinueController): Promise<void> {
	if (!controller.snapshot().active) return;
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => new RailContinueOverlayComponent(tui, theme, keybindings, done, controller), {
		overlay: true,
		overlayOptions: { anchor: "center", width: "92%", maxHeight: "88%", margin: { top: 1, bottom: 1 } },
	});
}
