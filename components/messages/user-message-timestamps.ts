function textFromUserMessage(message: any): string | undefined {
	if (message?.role !== "user") return undefined;
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;

	let text = "";
	for (const part of content) {
		if (part?.type !== "text" || typeof part.text !== "string") continue;
		text += text ? `\n${part.text}` : part.text;
	}
	return text || undefined;
}

function timestampFromMessageOrEntry(message: any, entry?: any): number | undefined {
	const raw = message?.timestamp ?? entry?.timestamp;
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	if (typeof raw === "string") {
		const parsed = new Date(raw).getTime();
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

const userMessageTimeFormatter = new Intl.DateTimeFormat("en-US", {
	hour: "numeric",
	minute: "2-digit",
	hour12: true,
});
const userMessageDateFormatter = new Intl.DateTimeFormat("en-US", {
	month: "numeric",
	day: "numeric",
	year: "numeric",
});

export function formatUserMessageTimestamp(timestamp: number): string {
	const date = new Date(timestamp);
	return `${userMessageTimeFormatter.format(date)} · ${userMessageDateFormatter.format(date)}`;
}

export class UserMessageTimestampRegistry {
	private timestampsByText = new Map<string, number[]>();
	private timestampCursorByText = new Map<string, number>();
	private assignedTimestamps = new WeakMap<object, number>();
	private fallbackTimestamps = new WeakMap<object, number>();

	remember(message: any, entry?: any): void {
		const text = textFromUserMessage(message);
		const timestamp = timestampFromMessageOrEntry(message, entry);
		if (!text || timestamp === undefined) return;

		const timestamps = this.timestampsByText.get(text) ?? [];
		if (timestamps[timestamps.length - 1] !== timestamp) timestamps.push(timestamp);
		this.timestampsByText.set(text, timestamps);
	}

	refresh(entries: any[]): void {
		this.clear();
		for (const entry of entries) {
			if (entry?.type !== "message") continue;
			this.remember(entry.message, entry);
		}
		if (this.timestampsByText.size > 200) {
			const entriesToKeep = [...this.timestampsByText.entries()];
			this.timestampsByText = new Map(entriesToKeep.slice(entriesToKeep.length - 200));
		}
	}

	timestampFor(component: object, sourceText: string | undefined): number {
		const assigned = this.assignedTimestamps.get(component);
		if (assigned !== undefined) return assigned;

		const timestamps = sourceText ? this.timestampsByText.get(sourceText) : undefined;
		if (sourceText && timestamps?.length) {
			const cursor = this.timestampCursorByText.get(sourceText) ?? 0;
			const timestamp = timestamps[Math.min(cursor, timestamps.length - 1)]!;
			this.timestampCursorByText.set(sourceText, cursor + 1);
			this.assignedTimestamps.set(component, timestamp);
			return timestamp;
		}

		let fallback = this.fallbackTimestamps.get(component);
		if (fallback === undefined) {
			fallback = Date.now();
			this.fallbackTimestamps.set(component, fallback);
		}
		return fallback;
	}

	clear(): void {
		this.timestampsByText.clear();
		this.timestampCursorByText.clear();
		this.assignedTimestamps = new WeakMap<object, number>();
		this.fallbackTimestamps = new WeakMap<object, number>();
	}
}
