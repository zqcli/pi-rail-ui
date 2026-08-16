import type { ExtensionCommandContext, SessionInfo, Theme } from "@earendil-works/pi-coding-agent";
import { Input, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";

const MAX_VISIBLE = 8;

function compact(value: string, maxLength = 72): string {
	const oneLine = stripTerminalSequences(value).replace(/\s+/gu, " ").trim();
	return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, maxLength - 3)}...`;
}

function searchText(info: SessionInfo): string {
	return [info.name, info.firstMessage, info.cwd, info.id]
		.filter((value): value is string => Boolean(value))
		.join(" ")
		.toLowerCase();
}

export function filterSessions(sessions: SessionInfo[], query: string): SessionInfo[] {
	const terms = query.toLowerCase().trim().split(/\s+/u).filter(Boolean);
	if (terms.length === 0) return sessions;
	return sessions.filter((info) => {
		const haystack = searchText(info);
		return terms.every((term) => haystack.includes(term));
	});
}

function sessionRow(info: SessionInfo, currentCwd: string): string {
	const current = info.cwd === currentCwd;
	const project = compact(info.cwd.split(/[\\/]/u).filter(Boolean).at(-1) || "unknown", 24);
	const title = compact(info.name || info.firstMessage) || info.id.slice(0, 8);
	return `${current ? "Current" : project} · ${title} · ${info.modified.toLocaleDateString()}`;
}

function borderedLine(theme: Theme, content: string, innerWidth: number): string {
	return theme.fg("border", "│") + truncateToWidth(content, innerWidth, "", true) + theme.fg("border", "│");
}

export async function pickSessionOverlay(
	ctx: ExtensionCommandContext,
	sessions: SessionInfo[],
): Promise<SessionInfo | undefined> {
	return ctx.ui.custom<SessionInfo | undefined>((tui, theme, keybindings, done) => {
		const input = new Input();
		input.focused = true;
		let query = "";
		let selectedIndex = 0;
		let matches = sessions;
		const refresh = () => {
			query = input.getValue();
			matches = filterSessions(sessions, query);
			selectedIndex = Math.max(0, Math.min(selectedIndex, matches.length - 1));
			tui.requestRender();
		};
		const select = () => {
			const selected = matches[selectedIndex];
			if (selected) done(selected);
		};
		input.onSubmit = select;
		input.onEscape = () => done(undefined);

		return {
			handleInput(data: string) {
				if (keybindings.matches(data, "tui.select.up")) {
					if (matches.length > 0) selectedIndex = selectedIndex === 0 ? matches.length - 1 : selectedIndex - 1;
					tui.requestRender();
					return;
				}
				if (keybindings.matches(data, "tui.select.down")) {
					if (matches.length > 0) selectedIndex = (selectedIndex + 1) % matches.length;
					tui.requestRender();
					return;
				}
				if (keybindings.matches(data, "tui.select.confirm")) {
					select();
					return;
				}
				if (keybindings.matches(data, "tui.select.cancel")) {
					done(undefined);
					return;
				}
				const previousQuery = input.getValue();
				input.handleInput(data);
				if (input.getValue() !== previousQuery) selectedIndex = 0;
				refresh();
			},
			render(width: number): string[] {
				const innerWidth = Math.max(1, width - 2);
				const border = (left: string, fill: string, right: string) => theme.fg("borderAccent", `${left}${fill.repeat(innerWidth)}${right}`);
				const lines = [
					border("╭", "─", "╮"),
					borderedLine(theme, ` ${theme.fg("accent", theme.bold("Link saved Pi session"))}`, innerWidth),
					borderedLine(theme, "", innerWidth),
				];
				const inputLine = input.render(Math.max(1, innerWidth - 10))[0] ?? "";
				lines.push(borderedLine(theme, ` Search: ${inputLine}`, innerWidth));
				lines.push(borderedLine(theme, "", innerWidth));
				if (matches.length === 0) {
					lines.push(borderedLine(theme, ` ${theme.fg("warning", "No matching sessions")}`, innerWidth));
				} else {
					const start = Math.max(0, Math.min(selectedIndex - Math.floor(MAX_VISIBLE / 2), matches.length - MAX_VISIBLE));
					const end = Math.min(start + MAX_VISIBLE, matches.length);
					for (let index = start; index < end; index++) {
						const prefix = index === selectedIndex ? theme.fg("accent", " → ") : "   ";
						const row = sessionRow(matches[index]!, ctx.cwd);
						const text = index === selectedIndex ? theme.fg("accent", row) : theme.fg("text", row);
						lines.push(borderedLine(theme, `${prefix}${text}`, innerWidth));
					}
					if (matches.length > MAX_VISIBLE) {
						lines.push(borderedLine(theme, ` ${theme.fg("dim", `${selectedIndex + 1}/${matches.length}`)}`, innerWidth));
					}
				}
				lines.push(borderedLine(theme, "", innerWidth));
				lines.push(borderedLine(theme, ` ${theme.fg("dim", "type to filter · ↑↓ navigate · enter link · esc close")}`, innerWidth));
				lines.push(border("╰", "─", "╯"));
				return lines;
			},
			invalidate() {
				input.invalidate();
			},
		};
	}, {
		overlay: true,
		overlayOptions: {
			width: "70%",
			minWidth: 48,
			maxHeight: "80%",
			anchor: "center",
			margin: 1,
		},
	});
}
