import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth } from "@earendil-works/pi-tui";

const MAX_VISIBLE = 8;

export interface SearchablePickerItem<T> {
	value: T;
	label: string;
	searchText: string;
}

export interface SearchablePickerOptions<T> {
	title: string;
	items: SearchablePickerItem<T>[];
	emptyText: string;
	actionLabel: string;
}

function borderedLine(theme: Theme, content: string, innerWidth: number): string {
	return theme.fg("border", "│") + truncateToWidth(content, innerWidth, "", true) + theme.fg("border", "│");
}

export async function pickSearchableOverlay<T>(
	ctx: ExtensionCommandContext,
	options: SearchablePickerOptions<T>,
): Promise<T | undefined> {
	return ctx.ui.custom<T | undefined>((tui, theme, keybindings, done) => {
		const input = new Input();
		input.focused = true;
		let selectedIndex = 0;
		let matches = options.items;
		const refresh = () => {
			const terms = input.getValue().toLowerCase().trim().split(/\s+/u).filter(Boolean);
			matches = terms.length === 0
				? options.items
				: options.items.filter((item) => terms.every((term) => item.searchText.includes(term)));
			selectedIndex = Math.max(0, Math.min(selectedIndex, matches.length - 1));
			tui.requestRender();
		};
		const select = () => {
			const selected = matches[selectedIndex];
			if (selected) done(selected.value);
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
					borderedLine(theme, ` ${theme.fg("accent", theme.bold(options.title))}`, innerWidth),
					borderedLine(theme, "", innerWidth),
				];
				const inputLine = input.render(Math.max(1, innerWidth - 10))[0] ?? "";
				lines.push(borderedLine(theme, ` Search: ${inputLine}`, innerWidth));
				lines.push(borderedLine(theme, "", innerWidth));
				if (matches.length === 0) {
					lines.push(borderedLine(theme, ` ${theme.fg("warning", options.emptyText)}`, innerWidth));
				} else {
					const start = Math.max(0, Math.min(selectedIndex - Math.floor(MAX_VISIBLE / 2), matches.length - MAX_VISIBLE));
					const end = Math.min(start + MAX_VISIBLE, matches.length);
					for (let index = start; index < end; index++) {
						const prefix = index === selectedIndex ? theme.fg("accent", " → ") : "   ";
						const row = matches[index]!.label;
						const text = index === selectedIndex ? theme.fg("accent", row) : theme.fg("text", row);
						lines.push(borderedLine(theme, `${prefix}${text}`, innerWidth));
					}
					if (matches.length > MAX_VISIBLE) lines.push(borderedLine(theme, ` ${theme.fg("dim", `${selectedIndex + 1}/${matches.length}`)}`, innerWidth));
				}
				lines.push(borderedLine(theme, "", innerWidth));
				lines.push(borderedLine(theme, ` ${theme.fg("dim", `type to filter · ↑↓ navigate · enter ${options.actionLabel} · esc close`)}`, innerWidth));
				lines.push(border("╰", "─", "╯"));
				return lines;
			},
			invalidate() {
				input.invalidate();
			},
		};
	}, {
		overlay: true,
		overlayOptions: { width: "70%", minWidth: 48, maxHeight: "80%", anchor: "center", margin: 1 },
	});
}
