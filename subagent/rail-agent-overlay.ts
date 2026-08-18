import * as path from "node:path";
import type { ExtensionCommandContext, KeybindingsManager, SessionInfo, Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, stripTerminalSequences, truncateToWidth, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { RailAgentManager, RailAgentManagerSnapshot, RailAgentPhase, RailAgentView } from "./agent-manager";
import { assertValidAgentAlias } from "./identity";
import {
	availableThinkingLevels,
	railModelKey,
	railModelReference,
	type RailModelRef,
	type RailThinkingLevel,
} from "./models";

const MAX_VISIBLE_ROWS = 8;
const TABS = ["current", "all", "create"] as const;
type OverlayTab = typeof TABS[number];
type EditField = "alias" | "cwd" | "task";
type Picker =
	| { kind: "model"; targetAgentId?: string; query: Input; selected: number }
	| { kind: "session"; query: Input; selected: number };
type ControlComposer = {
	agentId: string;
	alias: string;
	delivery: "steer" | "followUp";
	input: Input;
};

export interface RailAgentOverlayOptions {
	manager: RailAgentManager;
	models: RailModelRef[];
	sessions?: SessionInfo[];
	loadSessions?: () => Promise<SessionInfo[]>;
	currentCwd: string;
	insertMention(alias: string): void;
}

interface CreateForm {
	mode: "new" | "adopt";
	alias: string;
	model: RailModelRef;
	thinkingLevel: RailThinkingLevel;
	session?: SessionInfo;
	adoptMode: "fork" | "exclusive";
	cwd: string;
	task: string;
}

function compact(value: string, maxLength = 80): string {
	const oneLine = stripTerminalSequences(value).replace(/\s+/gu, " ").trim();
	return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, maxLength - 3)}...`;
}

function defaultAlias(modelId: string, seed: string): string {
	const base = modelId.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^[._-]+|[._-]+$/gu, "").slice(0, 36) || "model";
	const suffix = seed.replace(/[^A-Za-z0-9]+/gu, "").slice(0, 6).toLowerCase() || Date.now().toString(36).slice(-6);
	return `${base}-${suffix}`;
}

function sessionSearchText(session: SessionInfo): string {
	return [session.name, session.firstMessage, session.cwd, session.id].filter(Boolean).join(" ").toLowerCase();
}

function modelSearchText(model: RailModelRef): string {
	return `${railModelReference(model)} ${model.name ?? ""}`.toLowerCase();
}

function phaseLabel(agent: RailAgentView): string {
	if (agent.phase === "running" && agent.queued > 0) return `RUNNING +${agent.queued}`;
	if (agent.phase === "in-use-elsewhere") return "IN USE ELSEWHERE";
	if (agent.phase === "stopped") return "NOT CONNECTED";
	return agent.phase.toUpperCase();
}

function phaseColor(phase: RailAgentPhase): "success" | "warning" | "error" | "muted" | "dim" {
	if (phase === "running") return "success";
	if (phase === "starting" || phase === "queued") return "warning";
	if (phase === "error") return "error";
	if (phase === "idle") return "muted";
	return "dim";
}

function sessionLabel(session: SessionInfo, currentCwd: string): string {
	const project = path.basename(session.cwd || path.dirname(session.path)) || "unknown";
	const title = compact(session.name || session.firstMessage || session.id.slice(0, 8), 52);
	const current = path.resolve(session.cwd || path.dirname(session.path)) === path.resolve(currentCwd);
	return `${current ? "Current" : project} · ${title} · ${session.modified.toLocaleDateString()}`;
}

function fit(content: string, width: number): string {
	return truncateToWidth(content, Math.max(1, width), "", true);
}

export class RailAgentOverlayComponent implements Focusable {
	private snapshot: RailAgentManagerSnapshot;
	private tab: OverlayTab;
	private selectedIndex = 0;
	private readonly searchInput = new Input();
	private searching = false;
	private picker: Picker | undefined;
	private edit: { field: EditField; input: Input } | undefined;
	private control: ControlComposer | undefined;
	private form: CreateForm;
	private formIndex = 0;
	private aliasEdited = false;
	private busy = false;
	private operationAbort: AbortController | undefined;
	private notice = "";
	private disposed = false;
	private refreshing = false;
	private readonly unsubscribe: () => void;
	private readonly interval: NodeJS.Timeout;
	private _focused = false;
	private sessions: SessionInfo[];
	private sessionsLoaded: boolean;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly done: () => void,
		private readonly ctx: ExtensionCommandContext,
		private readonly options: RailAgentOverlayOptions,
		initialSnapshot: RailAgentManagerSnapshot,
		initialTab: OverlayTab = "current",
	) {
		this.snapshot = initialSnapshot;
		this.tab = initialTab;
		this.sessions = options.sessions ?? [];
		this.sessionsLoaded = options.sessions !== undefined;
		const model = options.models[0] ?? { provider: "unavailable", modelId: "no-authenticated-model" };
		const levels = availableThinkingLevels(model, ctx);
		const thinkingLevel = model.thinkingLevel && levels.includes(model.thinkingLevel) ? model.thinkingLevel : levels.at(-1) ?? "off";
		this.form = {
			mode: "new",
			alias: defaultAlias(model.modelId, ctx.sessionManager.getSessionId()),
			model,
			thinkingLevel,
			adoptMode: "fork",
			cwd: options.currentCwd,
			task: "",
		};
		this.unsubscribe = options.manager.subscribe(() => { void this.refresh(); });
		this.interval = setInterval(() => { void this.refresh(); }, 1500);
		this.interval.unref();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.syncInputFocus();
	}

	handleInput(data: string): void {
		if (this.busy) {
			if (this.isCancel(data)) {
				this.operationAbort?.abort();
				this.notice = "Cancelling operation...";
			}
			this.renderSoon();
			return;
		}
		if (this.picker) return this.handlePickerInput(data);
		if (this.edit) return this.handleEditInput(data);
		if (this.control) return this.handleControlInput(data);
		if (this.searching) return this.handleSearchInput(data);
		if (this.isCancel(data)) {
			this.done();
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.switchTab(-1);
			return;
		}
		if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
			this.switchTab(1);
			return;
		}
		if (this.tab === "create") this.handleFormInput(data);
		else this.handleAgentInput(data);
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const border = (value: string) => this.theme.fg("borderAccent", value);
		const line = (content = "") => `${this.theme.fg("border", "│")}${fit(content, innerWidth)}${this.theme.fg("border", "│")}`;
		const lines = [border(`╭${"─".repeat(innerWidth)}╮`)];
		lines.push(line(` ${this.theme.fg("accent", this.theme.bold("Rail Agents"))}  ${this.renderTabs()}`));
		lines.push(line(` ${this.theme.fg("dim", this.summaryText())}`));
		lines.push(line());
		if (this.picker) lines.push(...this.renderPicker(innerWidth).map(line));
		else if (this.tab === "create") lines.push(...this.renderForm(innerWidth).map(line));
		else lines.push(...this.renderAgents(innerWidth).map(line));
		if (this.notice) lines.push(line(` ${this.theme.fg("warning", compact(this.notice, innerWidth - 2))}`));
		lines.push(line(` ${this.theme.fg("dim", this.helpText())}`));
		lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}

	invalidate(): void {
		this.searchInput.invalidate();
		this.picker?.query.invalidate();
		this.edit?.input.invalidate();
		this.control?.input.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		this.operationAbort?.abort();
		clearInterval(this.interval);
		this.unsubscribe();
	}

	private renderTabs(): string {
		return TABS.map((tab) => {
			const label = tab === "current" ? `Current ${this.snapshot.counts.linked}` : tab === "all" ? `All ${this.snapshot.counts.global}` : "Create / Adopt";
			return tab === this.tab ? this.theme.fg("accent", `[${label}]`) : this.theme.fg("dim", ` ${label} `);
		}).join(" ");
	}

	private summaryText(): string {
		const counts = this.snapshot.counts;
		return `${counts.running} running · ${counts.queued} queued · ${counts.idle} idle · ${counts.stopped} not connected · ${counts.inUseElsewhere} elsewhere${counts.errors ? ` · ${counts.errors} errors` : ""}`;
	}

	private renderAgents(innerWidth: number): string[] {
		const agents = this.filteredAgents();
		const lines: string[] = [];
		if (this.searching || this.searchInput.getValue()) {
			const search = this.searchInput.render(Math.max(1, innerWidth - 11))[0] ?? "";
			lines.push(` Search: ${search}`);
			lines.push("");
		}
		if (agents.length === 0) {
			lines.push(` ${this.theme.fg("muted", this.tab === "current" ? "No persistent agents are linked to this conversation" : "No matching persistent agents")}`);
			lines.push("");
			return lines;
		}
		const visibleRows = this.maxVisibleRows();
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(visibleRows / 2), agents.length - visibleRows));
		for (let index = start; index < Math.min(start + visibleRows, agents.length); index++) {
			const agent = agents[index]!;
			const selected = index === this.selectedIndex;
			const prefix = selected ? this.theme.fg("accent", " → ") : "   ";
			const phase = this.theme.fg(phaseColor(agent.phase), phaseLabel(agent));
			const alias = agent.linkedAliases[0] ?? agent.instance.alias;
			const row = `${alias}  ${phase}  ${railModelReference(agent.instance.model)}`;
			lines.push(`${prefix}${selected ? this.theme.fg("accent", row) : row}`);
		}
		const selected = agents[this.selectedIndex];
		if (selected && !this.compactControlLayout()) {
			lines.push("");
			lines.push(` ${this.theme.fg("toolTitle", this.theme.bold(selected.linkedAliases[0] ?? selected.instance.alias))} ${this.theme.fg("dim", `· ${selected.instance.agentId}`)}`);
			lines.push(` ${this.theme.fg("muted", compact(selected.instance.cwd, innerWidth - 2))}`);
			lines.push(` ${this.theme.fg("dim", `Last task: ${compact(selected.instance.lastTask, innerWidth - 13)}`)}`);
			if (selected.instance.lastOutput) lines.push(` ${this.theme.fg("dim", `Last answer: ${compact(selected.instance.lastOutput, innerWidth - 15)}`)}`);
			if (selected.errorMessage) lines.push(` ${this.theme.fg("error", compact(selected.errorMessage, innerWidth - 2))}`);
		}
		if (this.control) {
			const label = this.control.delivery === "steer" ? "Steer" : "Follow-up";
			lines.push("");
			lines.push(` ${this.theme.fg("toolTitle", this.theme.bold(`${label} ${this.control.alias}`))}`);
			lines.push(` Message: ${this.control.input.render(Math.max(1, innerWidth - 11))[0] ?? ""}`);
		}
		return lines;
	}

	private renderForm(innerWidth: number): string[] {
		const fields = this.formFields();
		const lines = [` ${this.theme.fg("toolTitle", this.theme.bold(this.form.mode === "new" ? "Create persistent agent" : "Adopt saved session"))}`, ""];
		const visibleRows = Math.max(3, Math.min(fields.length, this.maxVisibleRows()));
		const start = Math.max(0, Math.min(this.formIndex - Math.floor(visibleRows / 2), fields.length - visibleRows));
		for (let index = start; index < Math.min(start + visibleRows, fields.length); index++) {
			const field = fields[index]!;
			const selected = index === this.formIndex;
			const prefix = selected ? this.theme.fg("accent", " → ") : "   ";
			const label = selected ? this.theme.fg("accent", field.label.padEnd(12)) : this.theme.fg("muted", field.label.padEnd(12));
			const value = this.edit?.field === field.id
				? this.edit.input.render(Math.max(1, innerWidth - 18))[0] ?? ""
				: field.value;
			lines.push(`${prefix}${label}${selected ? this.theme.fg("accent", value) : value}`);
		}
		if (fields.length > visibleRows) lines.push(` ${this.theme.fg("dim", `${this.formIndex + 1}/${fields.length} fields`)}`);
		return lines;
	}

	private renderPicker(innerWidth: number): string[] {
		const picker = this.picker!;
		const models = picker.kind === "model" ? this.filteredModels(picker.query.getValue()) : [];
		const sessions = picker.kind === "session" ? this.filteredSessions(picker.query.getValue()) : [];
		const count = picker.kind === "model" ? models.length : sessions.length;
		const title = picker.kind === "model" ? "Select model" : "Select saved session";
		const input = picker.query.render(Math.max(1, innerWidth - 11))[0] ?? "";
		const lines = [` ${this.theme.fg("toolTitle", this.theme.bold(title))}`, ` Search: ${input}`, ""];
		if (count === 0) return [...lines, ` ${this.theme.fg("warning", "No matching options")}`];
		picker.selected = Math.max(0, Math.min(picker.selected, count - 1));
		const visibleRows = this.maxVisibleRows();
		const start = Math.max(0, Math.min(picker.selected - Math.floor(visibleRows / 2), count - visibleRows));
		for (let index = start; index < Math.min(start + visibleRows, count); index++) {
			const selected = index === picker.selected;
			const label = picker.kind === "model"
				? railModelReference(models[index]!) + (models[index]!.name ? ` — ${models[index]!.name}` : "")
				: sessionLabel(sessions[index]!, this.options.currentCwd);
			lines.push(`${selected ? this.theme.fg("accent", " → ") : "   "}${selected ? this.theme.fg("accent", label) : label}`);
		}
		return lines;
	}

	private formFields(): Array<{ id: EditField | "mode" | "model" | "thinking" | "session" | "adoptMode" | "submit"; label: string; value: string }> {
		const fields: Array<{ id: EditField | "mode" | "model" | "thinking" | "session" | "adoptMode" | "submit"; label: string; value: string }> = [
			{ id: "mode", label: "Mode", value: this.form.mode === "new" ? "New persistent session ▾" : "Adopt saved session ▾" },
			{ id: "alias", label: "Alias", value: this.form.alias || "(required)" },
			{ id: "model", label: "Model", value: `${railModelKey(this.form.model)} ▾` },
			{ id: "thinking", label: "Thinking", value: `${this.form.thinkingLevel} ▾` },
		];
		if (this.form.mode === "adopt") {
			fields.push(
				{ id: "session", label: "Session", value: this.form.session ? `${compact(this.form.session.name || this.form.session.firstMessage || this.form.session.id, 56)} ▾` : "Select saved session ▾" },
				{ id: "adoptMode", label: "Adopt as", value: this.form.adoptMode === "fork" ? "Safe copy ▾" : "Exclusive in place ▾" },
			);
		}
		fields.push(
			{ id: "cwd", label: "Cwd", value: this.form.cwd },
			{ id: "task", label: this.form.mode === "new" ? "First task" : "First task", value: this.form.task || (this.form.mode === "new" ? "(required)" : "(optional)") },
			{ id: "submit", label: "Action", value: this.form.mode === "new" || this.form.task.trim() ? "Create & Run" : "Adopt & Link" },
		);
		return fields;
	}

	private helpText(): string {
		if (this.picker) return "type to filter · ↑↓ navigate · enter select · esc back";
		if (this.edit) return "enter apply · esc cancel";
		if (this.control) return "type message · enter send · esc cancel";
		if (this.tab === "create") return "↑↓ fields · enter edit/open · ←→ or tab switch tabs · esc close";
		return "/ search · ↑↓ select · enter continue/link · g steer · f follow-up · m model · t thinking · s stop · d detach · x delete · n new";
	}

	private handleAgentInput(data: string): void {
		const agents = this.filteredAgents();
		if (matchesKey(data, "/")) {
			this.searching = true;
			this.syncInputFocus();
			this.renderSoon();
			return;
		}
		if (matchesKey(data, "n")) {
			this.tab = "create";
			this.formIndex = 0;
			this.renderSoon();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		else if (this.keybindings.matches(data, "tui.select.down")) this.selectedIndex = Math.min(Math.max(0, agents.length - 1), this.selectedIndex + 1);
		else {
			const selected = agents[this.selectedIndex];
			if (!selected) return;
			if (this.keybindings.matches(data, "tui.select.confirm")) void this.continueAgent(selected);
			else if (matchesKey(data, "m")) {
				if (this.options.models.length === 0) {
					this.notice = "No authenticated Pi models are available";
					this.renderSoon();
					return;
				}
				if (selected.phase === "running" || selected.phase === "queued" || selected.phase === "starting" || selected.phase === "in-use-elsewhere") {
					this.notice = "Model can change only when the agent is idle or not connected";
				} else this.openModelPicker(selected.instance.agentId);
			}
			else if (matchesKey(data, "t")) void this.cycleAgentThinking(selected);
			else if (matchesKey(data, "g")) this.startControl(selected, "steer");
			else if (matchesKey(data, "f")) this.startControl(selected, "followUp");
			else if (matchesKey(data, "s")) void this.stopAgent(selected);
			else if (matchesKey(data, "d") && selected.linkedToCurrentSession) void this.detachAgent(selected);
			else if (matchesKey(data, "x")) void this.deleteAgent(selected);
		}
		this.renderSoon();
	}

	private handleFormInput(data: string): void {
		const fields = this.formFields();
		if (this.keybindings.matches(data, "tui.select.up")) this.formIndex = Math.max(0, this.formIndex - 1);
		else if (this.keybindings.matches(data, "tui.select.down")) this.formIndex = Math.min(fields.length - 1, this.formIndex + 1);
		else if (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.space)) this.activateFormField(fields[this.formIndex]!.id);
		this.renderSoon();
	}

	private activateFormField(field: ReturnType<RailAgentOverlayComponent["formFields"]>[number]["id"]): void {
		if (field === "mode") {
			this.form.mode = this.form.mode === "new" ? "adopt" : "new";
			return;
		}
		if (field === "alias" || field === "cwd" || field === "task") {
			this.startEdit(field, this.form[field]);
			return;
		}
		if (field === "model") return this.openModelPicker();
		if (field === "thinking") return this.cycleFormThinking();
		if (field === "session") {
			void this.openSessionPicker();
			return;
		}
		if (field === "adoptMode") {
			this.form.adoptMode = this.form.adoptMode === "fork" ? "exclusive" : "fork";
			return;
		}
		if (field === "submit") void this.submitForm();
	}

	private handleSearchInput(data: string): void {
		if (this.isCancel(data)) {
			this.searching = false;
			this.syncInputFocus();
			this.renderSoon();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up") || this.keybindings.matches(data, "tui.select.down")) {
			this.searching = false;
			this.handleAgentInput(data);
			this.syncInputFocus();
			return;
		}
		const previous = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		if (previous !== this.searchInput.getValue()) this.selectedIndex = 0;
		this.renderSoon();
	}

	private handleEditInput(data: string): void {
		const edit = this.edit!;
		if (this.isCancel(data)) {
			this.edit = undefined;
			this.syncInputFocus();
			this.renderSoon();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.form[edit.field] = edit.input.getValue().trim();
			if (edit.field === "alias") this.aliasEdited = true;
			this.edit = undefined;
			this.syncInputFocus();
			this.renderSoon();
			return;
		}
		edit.input.handleInput(data);
		this.renderSoon();
	}

	private handleControlInput(data: string): void {
		const control = this.control!;
		if (this.isCancel(data)) {
			this.control = undefined;
			this.syncInputFocus();
			this.renderSoon();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const message = control.input.getValue().trim();
			if (!message) {
				this.notice = "Control message cannot be empty";
				this.renderSoon();
				return;
			}
			this.control = undefined;
			this.syncInputFocus();
			void this.runOperation(control.delivery === "steer" ? "Sending steer..." : "Queueing follow-up...", async (signal) => {
				await this.options.manager.control(control.agentId, { delivery: control.delivery, message }, signal);
				this.notice = `${control.delivery === "steer" ? "Steer" : "Follow-up"} accepted by ${control.alias}`;
			});
			return;
		}
		control.input.handleInput(data);
		this.renderSoon();
	}

	private handlePickerInput(data: string): void {
		const picker = this.picker!;
		if (this.isCancel(data)) {
			this.picker = undefined;
			this.syncInputFocus();
			this.renderSoon();
			return;
		}
		const count = picker.kind === "model" ? this.filteredModels(picker.query.getValue()).length : this.filteredSessions(picker.query.getValue()).length;
		if (this.keybindings.matches(data, "tui.select.up")) picker.selected = picker.selected === 0 ? Math.max(0, count - 1) : picker.selected - 1;
		else if (this.keybindings.matches(data, "tui.select.down")) picker.selected = count === 0 ? 0 : (picker.selected + 1) % count;
		else if (this.keybindings.matches(data, "tui.select.confirm")) void this.selectPickerValue();
		else {
			const previous = picker.query.getValue();
			picker.query.handleInput(data);
			if (previous !== picker.query.getValue()) picker.selected = 0;
		}
		this.renderSoon();
	}

	private async selectPickerValue(): Promise<void> {
		const picker = this.picker!;
		if (picker.kind === "model") {
			const model = this.filteredModels(picker.query.getValue())[picker.selected];
			if (!model) return;
			if (picker.targetAgentId) {
				this.picker = undefined;
				await this.runOperation("Changing model...", async () => {
					await this.options.manager.changeModel(picker.targetAgentId!, model);
					this.notice = `Model changed to ${railModelReference(model)}`;
				});
				return;
			}
			this.setFormModel(model);
		} else {
			const session = this.filteredSessions(picker.query.getValue())[picker.selected];
			if (!session) return;
			this.form.session = session;
			this.form.cwd = session.cwd || path.dirname(session.path);
			if (!this.aliasEdited) this.form.alias = defaultAlias(this.form.model.modelId, session.id);
		}
		this.picker = undefined;
		this.syncInputFocus();
		this.renderSoon();
	}

	private async continueAgent(agent: RailAgentView): Promise<void> {
		if (agent.phase === "in-use-elsewhere") {
			this.notice = `Session is owned by process ${agent.ownerPid ?? "unknown"}; use Create / Adopt to make a safe copy`;
			this.renderSoon();
			return;
		}
		if (!agent.linkedToCurrentSession) await this.options.manager.link(agent.instance.agentId);
		this.options.insertMention(agent.linkedAliases[0] ?? agent.instance.alias);
		this.done();
	}

	private startControl(agent: RailAgentView, delivery: "steer" | "followUp"): void {
		if (agent.phase !== "running") {
			this.notice = agent.phase === "in-use-elsewhere"
				? "Live controls cannot reach a worker owned by another process"
				: agent.phase === "starting" || agent.phase === "queued"
					? "Live controls require a running local agent; wait for the pending operation"
					: "Live controls require a running local agent; use continue for an idle or stopped session";
			this.renderSoon();
			return;
		}
		this.control = {
			agentId: agent.instance.agentId,
			alias: agent.linkedAliases[0] ?? agent.instance.alias,
			delivery,
			input: new Input(),
		};
		this.notice = "";
		this.syncInputFocus();
		this.renderSoon();
	}

	private async stopAgent(agent: RailAgentView): Promise<void> {
		if (agent.phase === "stopped" || agent.phase === "in-use-elsewhere") {
			this.notice = agent.phase === "stopped" ? "Worker is already stopped" : "A worker owned by another process cannot be stopped here";
			this.renderSoon();
			return;
		}
		const approved = await this.ctx.ui.confirm("Stop subagent worker?", `${agent.instance.alias}\nThe persistent session and current link will be kept.`);
		if (!approved) return;
		await this.runOperation("Stopping worker...", async () => {
			await this.options.manager.stop(agent.instance.agentId);
			this.notice = `Stopped ${agent.instance.alias}; session retained`;
		});
	}

	private async detachAgent(agent: RailAgentView): Promise<void> {
		const alias = agent.linkedAliases[0] ?? agent.instance.alias;
		const approved = await this.ctx.ui.confirm("Detach persistent agent?", `${alias}\nThe child JSONL will be retained and can be linked again.`);
		if (!approved) return;
		await this.runOperation("Detaching agent...", async () => {
			await this.options.manager.detach(alias);
			this.notice = `Detached ${alias}; child session retained`;
		});
	}

	private async deleteAgent(agent: RailAgentView): Promise<void> {
		if (agent.phase === "in-use-elsewhere" || agent.phase === "unknown") {
			this.notice = "A session owned by another process cannot be deleted here";
			this.renderSoon();
			return;
		}
		const alias = agent.linkedAliases[0] ?? agent.instance.alias;
		const approved = await this.ctx.ui.confirm(
			"Delete persistent agent permanently?",
			`${alias}\n${agent.instance.sessionFile}\n\nThis deletes the child JSONL and Rail descriptor. Other parent sessions are not rewritten; future calls from them will fail.`,
		);
		if (!approved) return;
		await this.runOperation("Deleting persistent agent...", async () => {
			await this.options.manager.delete(agent.instance.agentId);
			this.notice = `Deleted ${alias} and its child JSONL`;
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		});
	}

	private async cycleAgentThinking(agent: RailAgentView): Promise<void> {
		if (agent.phase === "running" || agent.phase === "queued" || agent.phase === "starting" || agent.phase === "in-use-elsewhere") {
			this.notice = "Thinking level can change only when the agent is idle or not connected";
			this.renderSoon();
			return;
		}
		const levels = availableThinkingLevels(agent.instance.model, this.ctx);
		const current = agent.instance.model.thinkingLevel ?? levels[0]!;
		const next = levels[(levels.indexOf(current) + 1) % levels.length]!;
		await this.runOperation("Changing thinking level...", async () => {
			await this.options.manager.changeModel(agent.instance.agentId, { ...agent.instance.model, thinkingLevel: next });
			this.notice = `${agent.instance.alias} thinking: ${next}`;
		});
	}

	private async submitForm(): Promise<void> {
		if (this.options.models.length === 0) {
			this.notice = "No authenticated Pi models are available for create or adopt";
			this.renderSoon();
			return;
		}
		try {
			assertValidAgentAlias(this.form.alias);
		} catch (error) {
			this.notice = error instanceof Error ? error.message : String(error);
			this.renderSoon();
			return;
		}
		if (!this.form.cwd.trim()) {
			this.notice = "Working directory is required";
			this.renderSoon();
			return;
		}
		if (this.form.mode === "new" && !this.form.task.trim()) {
			this.notice = "A concrete first task is required for a new persistent agent";
			this.renderSoon();
			return;
		}
		if (this.form.mode === "adopt" && !this.form.session) {
			this.notice = "Select a saved session to adopt";
			this.renderSoon();
			return;
		}
		if (this.form.adoptMode === "exclusive") {
			const approved = await this.ctx.ui.confirm(
				"Use saved session in place?",
				"Only continue if no other Pi process has this session open. Safe copy is recommended.",
			);
			if (!approved) return;
		}
		const model = { ...this.form.model, thinkingLevel: this.form.thinkingLevel };
		await this.runOperation(this.form.mode === "new" ? "Creating and running agent..." : "Adopting saved session...", async (signal) => {
			if (this.form.mode === "adopt") {
				const managed = this.snapshot.agents.find((agent) => path.resolve(agent.instance.sessionFile) === path.resolve(this.form.session!.path));
				if (managed && managed.phase !== "in-use-elsewhere" && managed.phase !== "unknown") {
					const linked = await this.options.manager.link(managed.instance.agentId);
					if (this.form.task.trim()) {
						const result = await this.options.manager.continue(linked.agentId, this.form.task, signal);
						if (result.run.stopReason === "aborted") throw new Error("Subagent run was aborted");
					}
					this.notice = this.form.task.trim()
						? `Linked and continued existing Rail agent ${managed.instance.alias}`
						: `Linked existing Rail agent ${managed.instance.alias}`;
					this.tab = "current";
					return;
				}
				const session = { mode: this.form.adoptMode, path: this.form.session!.path } as const;
				if (this.form.task.trim()) {
					const result = await this.options.manager.create({ model, alias: this.form.alias, task: this.form.task, cwd: this.form.cwd, session, signal });
					if (result.run.stopReason === "aborted") throw new Error("Subagent run was aborted");
				} else {
					await this.options.manager.adopt({ model, alias: this.form.alias, cwd: this.form.cwd, session });
				}
				this.notice = `Adopted ${this.form.alias} as ${this.form.adoptMode === "fork" ? "a safe copy" : "an exclusive session"}`;
			} else {
				const result = await this.options.manager.create({ model, alias: this.form.alias, task: this.form.task, cwd: this.form.cwd, signal });
				if (result.run.stopReason === "aborted") throw new Error("Subagent run was aborted");
				this.notice = `Created ${this.form.alias}`;
			}
			this.tab = "current";
			this.selectedIndex = 0;
			this.form.task = "";
			this.aliasEdited = false;
			this.form.alias = defaultAlias(this.form.model.modelId, Date.now().toString(36));
		});
	}

	private async runOperation(label: string, operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.operationAbort = new AbortController();
		this.notice = label;
		this.renderSoon();
		try {
			await operation(this.operationAbort.signal);
			await this.refresh();
		} catch (error) {
			this.notice = error instanceof Error ? error.message : String(error);
		} finally {
			this.busy = false;
			this.operationAbort = undefined;
			this.renderSoon();
		}
	}

	private setFormModel(model: RailModelRef): void {
		this.form.model = model;
		const levels = availableThinkingLevels(model, this.ctx);
		this.form.thinkingLevel = model.thinkingLevel && levels.includes(model.thinkingLevel) ? model.thinkingLevel : levels.at(-1) ?? "off";
		if (!this.aliasEdited) {
			this.form.alias = defaultAlias(model.modelId, this.form.session?.id ?? this.ctx.sessionManager.getSessionId());
		}
	}

	private cycleFormThinking(): void {
		const levels = availableThinkingLevels(this.form.model, this.ctx);
		const index = levels.indexOf(this.form.thinkingLevel);
		this.form.thinkingLevel = levels[(index + 1) % levels.length]!;
	}

	private openModelPicker(targetAgentId?: string): void {
		if (this.options.models.length === 0) {
			this.notice = "No authenticated Pi models are available";
			this.renderSoon();
			return;
		}
		this.picker = { kind: "model", ...(targetAgentId ? { targetAgentId } : {}), query: new Input(), selected: 0 };
		this.syncInputFocus();
		this.renderSoon();
	}

	private async openSessionPicker(): Promise<void> {
		if (!this.sessionsLoaded) {
			await this.runOperation("Loading saved Pi sessions...", async () => {
				this.sessions = await this.options.loadSessions?.() ?? [];
				this.sessionsLoaded = true;
			});
			if (!this.sessionsLoaded) return;
		}
		this.picker = { kind: "session", query: new Input(), selected: 0 };
		this.syncInputFocus();
		this.renderSoon();
	}

	private startEdit(field: EditField, value: string): void {
		const input = new Input();
		input.setValue(value);
		this.edit = { field, input };
		this.syncInputFocus();
	}

	private filteredAgents(): RailAgentView[] {
		const query = this.searchInput.getValue().toLowerCase().trim();
		return this.snapshot.agents.filter((agent) => {
			if (this.tab === "current" && !agent.linkedToCurrentSession) return false;
			if (!query) return true;
			const text = [agent.instance.alias, ...agent.linkedAliases, railModelReference(agent.instance.model), agent.instance.cwd, agent.instance.lastTask, agent.phase].join(" ").toLowerCase();
			return query.split(/\s+/u).every((term) => text.includes(term));
		});
	}

	private filteredModels(query: string): RailModelRef[] {
		const terms = query.toLowerCase().trim().split(/\s+/u).filter(Boolean);
		return terms.length === 0 ? this.options.models : this.options.models.filter((model) => terms.every((term) => modelSearchText(model).includes(term)));
	}

	private filteredSessions(query: string): SessionInfo[] {
		const terms = query.toLowerCase().trim().split(/\s+/u).filter(Boolean);
		return terms.length === 0 ? this.sessions : this.sessions.filter((session) => terms.every((term) => sessionSearchText(session).includes(term)));
	}

	private switchTab(direction: number): void {
		const index = TABS.indexOf(this.tab);
		this.tab = TABS[(index + direction + TABS.length) % TABS.length]!;
		this.selectedIndex = 0;
		this.formIndex = 0;
		this.notice = "";
		this.renderSoon();
	}

	private syncInputFocus(): void {
		this.searchInput.focused = this._focused && this.searching;
		if (this.picker) this.picker.query.focused = this._focused;
		if (this.edit) this.edit.input.focused = this._focused;
		if (this.control) this.control.input.focused = this._focused;
	}

	private async refresh(): Promise<void> {
		if (this.disposed || this.refreshing) return;
		this.refreshing = true;
		try {
			this.snapshot = await this.options.manager.snapshot();
			this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.filteredAgents().length - 1));
			this.renderSoon();
		} finally {
			this.refreshing = false;
		}
	}

	private renderSoon(): void {
		if (!this.disposed) this.tui.requestRender();
	}

	private maxVisibleRows(): number {
		const rows = this.tui.terminal?.rows ?? 30;
		return Math.max(1, Math.min(MAX_VISIBLE_ROWS, rows - (this.control ? 16 : 13)));
	}

	private compactControlLayout(): boolean {
		return this.control !== undefined && (this.tui.terminal?.rows ?? 30) < 22;
	}

	private isCancel(data: string): boolean {
		return matchesKey(data, Key.escape) || this.keybindings.matches(data, "tui.select.cancel");
	}
}

export async function showRailAgentOverlay(
	ctx: ExtensionCommandContext,
	options: RailAgentOverlayOptions,
): Promise<void> {
	const snapshot = await options.manager.snapshot();
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => new RailAgentOverlayComponent(
		tui,
		theme,
		keybindings,
		done,
		ctx,
		options,
		snapshot,
	), {
		overlay: true,
		overlayOptions: { width: "92%", minWidth: 60, maxHeight: "88%", anchor: "center", margin: 1 },
	});
}
