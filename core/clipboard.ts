import { spawnSync } from "node:child_process";

const DUPLICATE_COPY_SKIP_MS = 1000;

let lastCopiedText = "";
let lastCopyAt = 0;

function writeClipboardProcess(command: string, args: string[], text: string): boolean {
	try {
		const result = spawnSync(command, args, {
			input: text,
			stdio: ["pipe", "ignore", "ignore"],
			timeout: 1500,
			maxBuffer: Math.max(1024 * 1024, text.length * 2),
		});
		return result.status === 0;
	} catch {
		return false;
	}
}

function copyViaPlatformClipboard(text: string): boolean {
	if (process.platform === "darwin") return writeClipboardProcess("pbcopy", [], text);
	if (process.platform === "win32") return writeClipboardProcess("clip.exe", [], text);
	return (
		writeClipboardProcess("wl-copy", [], text) ||
		writeClipboardProcess("xclip", ["-selection", "clipboard"], text) ||
		writeClipboardProcess("xsel", ["--clipboard", "--input"], text)
	);
}

function copyViaOsc52(text: string): boolean {
	try {
		if (!process.stdout.isTTY) return false;
		process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
		return true;
	} catch {
		return false;
	}
}

export function copyToClipboard(text: string): boolean {
	if (!text) return false;

	const now = Date.now();
	if (text === lastCopiedText && now - lastCopyAt < DUPLICATE_COPY_SKIP_MS) return true;

	const copied = copyViaOsc52(text) || copyViaPlatformClipboard(text);
	if (copied) {
		lastCopiedText = text;
		lastCopyAt = now;
	}
	return copied;
}
