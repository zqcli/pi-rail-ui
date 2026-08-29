import { getMarkdownTheme, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, type Component } from "@earendil-works/pi-tui";
import {
	HostedSearchActivity,
	hostedSearchActivityForMessage,
	type HostedSearchCall,
	type HostedSearchPhase,
	type HostedSearchSnapshot,
} from "../../openai/hosted-search-activity";
import { RailSectionBlock } from "../../rail/rail-section-block";
import {
	defineRailSection,
	isRailUiActive,
	markRailSectionManuallyToggled,
	wasRailSectionManuallyToggled,
} from "../../rail/rail-section";
import { markRailClickRows, unregisterRailClickComponent } from "../executions/rail-click";

const HOSTED_SEARCH_BLOCK_KEY = Symbol.for("pi-rail-ui.hosted-search-block");
const ASSISTANT_RENDER_CACHE_KEY = Symbol.for("pi-rail-ui.assistant-render-cache");

type SearchMessage = {
	provider: string;
	model: string;
	responseId?: string | undefined;
	timestamp?: number | undefined;
};

type SearchOwner = {
	[HOSTED_SEARCH_BLOCK_KEY]?: HostedSearchRailBlock;
	[ASSISTANT_RENDER_CACHE_KEY]?: unknown;
};

function escapeMarkdown(text: string): string {
	return text.replace(/\s+/gu, " ").replace(/[\\`*_[\]<>]/gu, "\\$&");
}

function durationLabel(snapshot: HostedSearchSnapshot): string {
	const seconds = Math.max(0, ((snapshot.endedAt ?? snapshot.startedAt) - snapshot.startedAt) / 1000);
	return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

function expandHint(theme: Theme): string {
	try {
		return theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`);
	} catch {
		return theme.fg("muted", "(ctrl+o to expand)");
	}
}

function phaseLabel(phase: HostedSearchPhase): string {
	if (phase === "running" || phase === "pending") return "searching";
	return phase;
}

function actionLine(call: HostedSearchCall): string {
	if (call.type === "search") return `Search: ${escapeMarkdown(call.query ?? "web")}`;
	if (call.type === "open_page") return call.url ? `Opened: <${call.url}>` : "Opened page";
	if (call.type === "find_in_page") {
		const query = escapeMarkdown(call.query ?? "text");
		return call.url ? `Find: ${query} in <${call.url}>` : `Find: ${query}`;
	}
	return call.status === "completed" ? "Search call completed" : "Searching…";
}

function detailsMarkdown(snapshot: HostedSearchSnapshot): string {
	const lines: string[] = snapshot.calls.map((call) => `- ${actionLine(call)}`);
	if (snapshot.sources.length > 0) {
		lines.push("", "Sources");
		for (const source of snapshot.sources) {
			const label = escapeMarkdown(source.title ?? source.url);
			lines.push(`- [${label}](<${source.url}>)`);
		}
	}
	if (snapshot.error) lines.push("", `Error: ${escapeMarkdown(snapshot.error)}`);
	return lines.join("\n");
}

class HostedSearchContent implements Component {
	expanded = true;
	private activity: HostedSearchActivity;
	private theme: Theme;
	private unsubscribe: (() => void) | undefined;
	private cached: { width: number; signature: string; rows: string[] } | undefined;

	constructor(
		activity: HostedSearchActivity,
		theme: Theme,
		private readonly owner: SearchOwner,
	) {
		this.activity = activity;
		this.theme = theme;
		this.subscribe();
	}

	update(activity: HostedSearchActivity, theme: Theme): void {
		if (activity !== this.activity) {
			this.unsubscribe?.();
			this.activity = activity;
			this.subscribe();
		}
		this.theme = theme;
		this.invalidate();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.invalidate();
	}

	invalidate(): void {
		this.cached = undefined;
		delete this.owner[ASSISTANT_RENDER_CACHE_KEY];
	}

	get visible(): boolean {
		return this.activity.observed;
	}

	render(width: number): string[] {
		if (!this.activity.observed) return [];
		const snapshot = this.activity.snapshot();
		if (!wasRailSectionManuallyToggled(this)) this.expanded = snapshot.phase !== "completed";
		const signature = JSON.stringify([this.expanded, snapshot]);
		if (this.cached?.width === width && this.cached.signature === signature) return this.cached.rows;

		const status = phaseLabel(snapshot.phase);
		const duration = snapshot.endedAt === undefined ? "" : ` · ${durationLabel(snapshot)}`;
		const summary = `WEB SEARCH · ${status} · ${snapshot.calls.length} call${snapshot.calls.length === 1 ? "" : "s"} · ${snapshot.sources.length} source${snapshot.sources.length === 1 ? "" : "s"}${duration}${this.expanded ? "" : ` ${expandHint(this.theme)}`}`;
		const color = snapshot.phase === "failed"
			? "error"
			: snapshot.phase === "completed"
				? "success"
				: snapshot.phase === "cancelled"
					? "warning"
					: "accent";
		const title = new Text(this.theme.fg(color, this.theme.bold(summary)), 0, 0);
		const rows = title.render(width);
		if (this.expanded) {
			const details = detailsMarkdown(snapshot);
			if (details) rows.push(...new Markdown(details, 0, 0, getMarkdownTheme()).render(width));
		}
		this.cached = { width, signature, rows };
		return rows;
	}

	private subscribe(): void {
		this.unsubscribe = this.activity.subscribe(() => this.invalidate());
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}
}

export class HostedSearchRailBlock implements Component {
	private readonly content: HostedSearchContent;
	private readonly surface: RailSectionBlock;

	constructor(activity: HostedSearchActivity, theme: Theme, owner: SearchOwner) {
		this.content = new HostedSearchContent(activity, theme, owner);
		this.surface = new RailSectionBlock(this.content, "hostedSearch");
		defineRailSection(this, "hostedSearch");
	}

	get expanded(): boolean { return this.content.expanded; }
	get visible(): boolean { return isRailUiActive() && this.content.visible; }

	setExpanded(expanded: boolean): void {
		markRailSectionManuallyToggled(this.content);
		this.content.setExpanded(expanded);
		this.surface.invalidate();
	}

	update(activity: HostedSearchActivity, theme: Theme): void {
		this.content.update(activity, theme);
		this.surface.invalidate();
	}

	invalidate(): void {
		this.surface.invalidate();
	}

	dispose(): void {
		this.content.dispose();
		unregisterRailClickComponent(this);
	}

	render(width: number): string[] {
		if (!this.visible) return [];
		return markRailClickRows(this, this.surface.render(width));
	}
}

export function hostedSearchBlockForAssistant(
	owner: object,
	message: SearchMessage,
	theme: Theme,
): HostedSearchRailBlock | undefined {
	const searchOwner = owner as SearchOwner;
	const activity = hostedSearchActivityForMessage(message);
	let block = searchOwner[HOSTED_SEARCH_BLOCK_KEY];
	if (!activity) {
		block?.dispose();
		delete searchOwner[HOSTED_SEARCH_BLOCK_KEY];
		delete searchOwner[ASSISTANT_RENDER_CACHE_KEY];
		return undefined;
	}
	if (!block) block = searchOwner[HOSTED_SEARCH_BLOCK_KEY] = new HostedSearchRailBlock(activity, theme, searchOwner);
	else block.update(activity, theme);
	return block;
}
