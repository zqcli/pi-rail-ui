const OMITTED = "[… earlier text omitted]\n";

export function previewTail(text: string, length: number): string {
	const tail = text.slice(-length);
	const first = tail.charCodeAt(0);
	return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
}

/** Display-only tail. Never used to reconstruct or execute a tool's arguments. */
export class ToolCallPreview {
	private text = "";
	private whitespace = "";
	private omitted = false;
	private escape: "none" | "start" | "csi" | "string" = "none";
	private stringEscape = false;
	private afterCR = false;
	private highSurrogate = "";

	constructor(private readonly limit: number) {}

	append(delta: string): string {
		let clean = "";
		for (const char of delta) {
			// Match pi-tui's CSI/OSC/APC stripping, including a terminator in a later delta.
			// Withhold incomplete sequences rather than leak their payload into the preview.
			if (this.escape === "csi") {
				if (/[mGKHJ]/u.test(char)) this.escape = "none";
				continue;
			}
			if (this.escape === "string") {
				if (char === "\x07" || (this.stringEscape && char === "\\")) this.escape = "none";
				this.stringEscape = char === "\x1b";
				continue;
			}
			if (this.escape === "start") {
				this.escape = char === "[" ? "csi" : char === "]" || char === "_" ? "string" : "none";
				this.stringEscape = false;
				if (this.escape !== "none") continue;
				this.afterCR = false; // An unsupported ESC is removed after CRLF normalization.
			}
			if (char === "\x1b") {
				this.escape = "start";
				continue;
			}
			const afterCR = this.afterCR;
			this.afterCR = char === "\r";
			if (char === "\n" && afterCR) continue;
			if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(char)) continue;
			const next = char === "\r" ? "\n" : char;
			const code = next.charCodeAt(0);
			if (this.highSurrogate) {
				if (code >= 0xdc00 && code <= 0xdfff) {
					clean += this.highSurrogate + next;
					this.highSurrogate = "";
					continue;
				}
				clean += "\ufffd";
				this.highSurrogate = "";
			}
			if (next.length === 1 && code >= 0xd800 && code <= 0xdbff) this.highSurrogate = next;
			else clean += code >= 0xdc00 && code <= 0xdfff ? "\ufffd" : next;
		}

		// Keep trailing whitespace separately: trim() must not discard spaces that become
		// internal on the next delta, nor let a long blank suffix hide the last visible text.
		const combined = this.text ? `${this.text}${this.whitespace}${clean}` : clean.trimStart();
		const trimmed = combined.trimEnd();
		this.whitespace = combined.slice(trimmed.length).slice(-(this.limit + 1));
		this.omitted ||= trimmed.length > this.limit;
		// Preserve the existing 28-code-unit truncation reserve, but never split a pair.
		this.text = this.omitted ? previewTail(trimmed, this.limit - 28) : trimmed;
		return `${this.omitted ? OMITTED : ""}${this.text}`;
	}
}
