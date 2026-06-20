import { constants } from "fs";
import {
	access as fsAccess,
	mkdir as fsMkdir,
	readFile as fsReadFile,
	rename as fsRename,
	unlink as fsUnlink,
	writeFile as fsWriteFile,
} from "fs/promises";
import { homedir } from "os";
import { dirname, isAbsolute, normalize, resolve } from "path";
import { generateDiffString, generateUnifiedPatch, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export const PATCH_PREFIX = "*** Begin Patch";
export const PATCH_SUFFIX = "*** End Patch";

const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const END_OF_FILE = "*** End of File";

export type ApplyPatchAction = "add" | "delete" | "update";

export type ApplyPatchFileSummary = {
	action: ApplyPatchAction;
	path: string;
	movePath?: string | undefined;
};

export type HunkLine = {
	kind: "context" | "remove" | "add";
	text: string;
};

export type PatchHunk = {
	header?: string | undefined;
	lines: HunkLine[];
	endOfFile: boolean;
};

export type AddFileChange = {
	action: "add";
	path: string;
	lines: string[];
};

export type DeleteFileChange = {
	action: "delete";
	path: string;
};

export type UpdateFileChange = {
	action: "update";
	path: string;
	movePath?: string | undefined;
	hunks: PatchHunk[];
};

export type ApplyPatchChange = AddFileChange | DeleteFileChange | UpdateFileChange;

export type ParsedApplyPatch = {
	changes: ApplyPatchChange[];
};

export type AppliedPatchFile = ApplyPatchFileSummary & {
	absolutePath: string;
	absoluteMovePath?: string | undefined;
	diff: string;
	patch: string;
	additions: number;
	deletions: number;
	firstChangedLine?: number | undefined;
};

export type ApplyPatchResult = {
	files: AppliedPatchFile[];
	diff: string;
	patch: string;
	additions: number;
	deletions: number;
};

export type ApplyPatchOperations = {
	readFile: (absolutePath: string) => Promise<Buffer>;
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	mkdir: (dir: string) => Promise<void>;
	unlink: (absolutePath: string) => Promise<void>;
	rename: (from: string, to: string) => Promise<void>;
	access: (absolutePath: string) => Promise<void>;
};

export type ApplyPatchOptions = {
	cwd: string;
	signal?: AbortSignal | undefined;
	operations?: ApplyPatchOperations;
};

export class ApplyPatchError extends Error {
	constructor(
		message: string,
		public readonly code: string,
		public readonly file?: string,
	) {
		super(file ? `${file}: ${message}` : message);
		this.name = "ApplyPatchError";
	}
}

const defaultOperations: ApplyPatchOperations = {
	readFile: (absolutePath) => fsReadFile(absolutePath),
	writeFile: (absolutePath, content) => fsWriteFile(absolutePath, content, "utf-8"),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => undefined),
	unlink: (absolutePath) => fsUnlink(absolutePath),
	rename: (from, to) => fsRename(from, to),
	access: (absolutePath) => fsAccess(absolutePath, constants.F_OK),
};

function formatError(message: string, line?: number): ApplyPatchError {
	return new ApplyPatchError(line === undefined ? message : `${message} at patch line ${line + 1}`, "invalidPatchFormat");
}

function contextError(file: string, message: string): ApplyPatchError {
	return new ApplyPatchError(message, "contextNotFound", file);
}

function isFileHeader(line: string): boolean {
	return line.startsWith(ADD_FILE) || line.startsWith(DELETE_FILE) || line.startsWith(UPDATE_FILE);
}

function lineAt(lines: readonly string[], index: number): string {
	return lines[index] ?? "";
}

function parseHeaderPath(line: string, prefix: string, lineIndex: number): string {
	const value = line.slice(prefix.length).trim();
	if (!value) throw formatError(`Missing path after ${prefix.trimEnd()}`, lineIndex);
	return value;
}

function normalizePatchText(input: string): string {
	return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function parseApplyPatch(input: string): ParsedApplyPatch {
	const lines = normalizePatchText(input).split("\n");
	if (lines[0] !== PATCH_PREFIX) throw formatError(`Patch must start with ${PATCH_PREFIX}`);

	let endIndex = lines.length - 1;
	while (endIndex > 0 && lineAt(lines, endIndex) === "") endIndex--;
	if (lineAt(lines, endIndex) !== PATCH_SUFFIX) throw formatError(`Patch must end with ${PATCH_SUFFIX}`);

	const changes: ApplyPatchChange[] = [];
	let i = 1;
	while (i < endIndex) {
		const line = lineAt(lines, i);
		if (line.startsWith(ADD_FILE)) {
			const path = parseHeaderPath(line, ADD_FILE, i);
			const content: string[] = [];
			i++;
			while (i < endIndex && !isFileHeader(lineAt(lines, i))) {
				const contentLine = lineAt(lines, i);
				if (!contentLine.startsWith("+")) {
					throw formatError("Add File lines must start with +, including blank lines", i);
				}
				content.push(contentLine.slice(1));
				i++;
			}
			changes.push({ action: "add", path, lines: content });
			continue;
		}

		if (line.startsWith(DELETE_FILE)) {
			const path = parseHeaderPath(line, DELETE_FILE, i);
			changes.push({ action: "delete", path });
			i++;
			continue;
		}

		if (line.startsWith(UPDATE_FILE)) {
			const path = parseHeaderPath(line, UPDATE_FILE, i);
			const hunks: PatchHunk[] = [];
			let movePath: string | undefined;
			i++;
			if (i < endIndex && lineAt(lines, i).startsWith(MOVE_TO)) {
				movePath = parseHeaderPath(lineAt(lines, i), MOVE_TO, i);
				i++;
			}

			while (i < endIndex && !isFileHeader(lineAt(lines, i))) {
				const hunkHeaderLine = lineAt(lines, i);
				if (!hunkHeaderLine.startsWith("@@")) throw formatError("Update File sections must contain @@ hunks", i);
				const header = hunkHeaderLine.slice(2).trim() || undefined;
				const hunkLines: HunkLine[] = [];
				let endOfFile = false;
				i++;

				while (i < endIndex && !lineAt(lines, i).startsWith("@@") && !isFileHeader(lineAt(lines, i))) {
					const hunkLine = lineAt(lines, i);
					if (hunkLine === END_OF_FILE) {
						endOfFile = true;
						i++;
						break;
					}
					const prefix = hunkLine[0];
					if (prefix !== " " && prefix !== "-" && prefix !== "+") {
						throw formatError(
							"Hunk lines must start with space, -, or +; unchanged blank lines need a single leading space",
							i,
						);
					}
					hunkLines.push({
						kind: prefix === " " ? "context" : prefix === "-" ? "remove" : "add",
						text: hunkLine.slice(1),
					});
					i++;
				}

				hunks.push({ header, lines: hunkLines, endOfFile });
			}

			if (!movePath && hunks.length === 0) throw formatError("Update File needs a hunk or Move to header", i);
			changes.push({ action: "update", path, movePath, hunks });
			continue;
		}

		throw formatError("Expected Add File, Delete File, or Update File header", i);
	}

	if (changes.length === 0) throw formatError("Patch does not contain any file operations");
	return { changes };
}

export function summarizeApplyPatch(input: string): ApplyPatchFileSummary[] {
	try {
		return parseApplyPatch(input).changes.map((change) => ({
			action: change.action,
			path: change.path,
			movePath: change.action === "update" ? change.movePath : undefined,
		}));
	} catch {
		return summarizePatchHeaders(input);
	}
}

function summarizePatchHeaders(input: string): ApplyPatchFileSummary[] {
	const lines = normalizePatchText(input).split("\n");
	const summaries: ApplyPatchFileSummary[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lineAt(lines, i);
		if (line.startsWith(ADD_FILE)) {
			summaries.push({ action: "add", path: line.slice(ADD_FILE.length).trim() });
		} else if (line.startsWith(DELETE_FILE)) {
			summaries.push({ action: "delete", path: line.slice(DELETE_FILE.length).trim() });
		} else if (line.startsWith(UPDATE_FILE)) {
			const path = line.slice(UPDATE_FILE.length).trim();
			const next = lines[i + 1];
			const movePath = next?.startsWith(MOVE_TO) ? next.slice(MOVE_TO.length).trim() : undefined;
			summaries.push({ action: "update", path, movePath });
		}
	}
	return summaries.filter((summary) => summary.path.length > 0);
}

function stripAtPrefix(filePath: string): string {
	return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

export function resolvePatchPath(filePath: string, cwd: string): string {
	let normalizedPath = stripAtPrefix(filePath.trim());
	if (normalizedPath === "~") normalizedPath = homedir();
	else if (normalizedPath.startsWith("~/")) normalizedPath = resolve(homedir(), normalizedPath.slice(2));
	return normalize(isAbsolute(normalizedPath) ? normalizedPath : resolve(cwd, normalizedPath));
}

function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function detectLineEnding(content: string): "\n" | "\r\n" {
	const crlf = content.indexOf("\r\n");
	const lf = content.indexOf("\n");
	if (lf === -1 || crlf === -1) return "\n";
	return crlf < lf ? "\r\n" : "\n";
}

function normalizeToLF(content: string): string {
	return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(content: string, ending: "\n" | "\r\n"): string {
	return ending === "\r\n" ? content.replace(/\n/g, "\r\n") : content;
}

function findLineContaining(lines: readonly string[], needle: string, start: number): number {
	for (let i = Math.max(0, start); i < lines.length; i++) {
		if (lineAt(lines, i).includes(needle)) return i;
	}
	return -1;
}

function linesMatchAt(lines: readonly string[], needle: readonly string[], start: number): boolean {
	if (start < 0 || start + needle.length > lines.length) return false;
	for (let i = 0; i < needle.length; i++) {
		if (lineAt(lines, start + i) !== needle[i]!) return false;
	}
	return true;
}

function findSubsequence(lines: readonly string[], needle: readonly string[], start: number): number {
	if (needle.length === 0) return Math.min(Math.max(0, start), lines.length);
	for (let i = Math.max(0, start); i <= lines.length - needle.length; i++) {
		if (linesMatchAt(lines, needle, i)) return i;
	}
	return -1;
}

export function applyPatchHunks(content: string, hunks: readonly PatchHunk[], file: string): string {
	const lines = content.split("\n");
	let cursor = 0;

	for (const hunk of hunks) {
		const oldLines = hunk.lines
			.filter((line) => line.kind !== "add")
			.map((line) => line.text);
		const newLines = hunk.lines
			.filter((line) => line.kind !== "remove")
			.map((line) => line.text);

		const anchor = hunk.header
			? findLineContaining(lines, hunk.header, cursor) !== -1
				? findLineContaining(lines, hunk.header, cursor)
				: findLineContaining(lines, hunk.header, 0)
			: -1;

		if (oldLines.length === 0 && newLines.length === 0) {
			if (hunk.header && anchor === -1) throw contextError(file, `Could not find hunk header "${hunk.header}"`);
			if (anchor !== -1) cursor = anchor;
			continue;
		}

		let index = -1;
		if (oldLines.length === 0) {
			if (hunk.endOfFile) index = lines.length;
			else if (anchor !== -1) index = anchor + 1;
			else throw contextError(file, "Pure insertion hunks need a header or context lines");
		} else if (hunk.endOfFile && linesMatchAt(lines, oldLines, lines.length - oldLines.length)) {
			index = lines.length - oldLines.length;
		} else {
			const searchStart = anchor !== -1 ? anchor : cursor;
			index = findSubsequence(lines, oldLines, searchStart);
			if (index === -1 && searchStart !== 0) index = findSubsequence(lines, oldLines, 0);
		}

		if (index === -1) throw contextError(file, "Could not find hunk context");
		lines.splice(index, oldLines.length, ...newLines);
		cursor = index + newLines.length;
	}

	return lines.join("\n");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

async function pathExists(absolutePath: string, ops: ApplyPatchOperations): Promise<boolean> {
	try {
		await ops.access(absolutePath);
		return true;
	} catch (error) {
		if (isMissingPathError(error)) return false;
		throw error;
	}
}

function countChangedLines(diff: string): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) additions++;
		else if (line.startsWith("-")) deletions++;
	}
	return { additions, deletions };
}

function buildAppliedFile(
	change: ApplyPatchFileSummary,
	absolutePath: string,
	oldContent: string,
	newContent: string,
	absoluteMovePath?: string,
): AppliedPatchFile {
	if (oldContent === newContent) {
		return {
			...change,
			absolutePath,
			absoluteMovePath,
			diff: "",
			patch: "",
			additions: 0,
			deletions: 0,
		};
	}

	const diffResult = generateDiffString(oldContent, newContent);
	const patchPath = change.movePath ? `${change.path} -> ${change.movePath}` : change.path;
	const patch = generateUnifiedPatch(patchPath, oldContent, newContent);
	const counts = countChangedLines(diffResult.diff);
	return {
		...change,
		absolutePath,
		absoluteMovePath,
		diff: diffResult.diff,
		patch,
		additions: counts.additions,
		deletions: counts.deletions,
		firstChangedLine: diffResult.firstChangedLine,
	};
}

async function readText(absolutePath: string, ops: ApplyPatchOperations): Promise<string> {
	return (await ops.readFile(absolutePath)).toString("utf-8");
}

async function applyAddFile(
	change: AddFileChange,
	cwd: string,
	ops: ApplyPatchOperations,
	signal: AbortSignal | undefined,
): Promise<AppliedPatchFile> {
	const absolutePath = resolvePatchPath(change.path, cwd);
	return withFileMutationQueue(absolutePath, async () => {
		throwIfAborted(signal);
		if (await pathExists(absolutePath, ops)) throw new ApplyPatchError("File already exists", "fileExists", change.path);
		const content = change.lines.join("\n");
		await ops.mkdir(dirname(absolutePath));
		throwIfAborted(signal);
		await ops.writeFile(absolutePath, content);
		throwIfAborted(signal);
		return buildAppliedFile(change, absolutePath, "", content);
	});
}

async function applyDeleteFile(
	change: DeleteFileChange,
	cwd: string,
	ops: ApplyPatchOperations,
	signal: AbortSignal | undefined,
): Promise<AppliedPatchFile> {
	const absolutePath = resolvePatchPath(change.path, cwd);
	return withFileMutationQueue(absolutePath, async () => {
		throwIfAborted(signal);
		const oldRaw = await readText(absolutePath, ops);
		const oldContent = normalizeToLF(stripBom(oldRaw).text);
		throwIfAborted(signal);
		await ops.unlink(absolutePath);
		throwIfAborted(signal);
		return buildAppliedFile(change, absolutePath, oldContent, "");
	});
}

async function applyUpdateFile(
	change: UpdateFileChange,
	cwd: string,
	ops: ApplyPatchOperations,
	signal: AbortSignal | undefined,
): Promise<AppliedPatchFile> {
	const absolutePath = resolvePatchPath(change.path, cwd);
	return withFileMutationQueue(absolutePath, async () => {
		throwIfAborted(signal);
		const oldRaw = await readText(absolutePath, ops);
		const { bom, text } = stripBom(oldRaw);
		const lineEnding = detectLineEnding(text);
		const oldContent = normalizeToLF(text);
		const movePath = change.movePath;
		const absoluteMovePath = movePath ? resolvePatchPath(movePath, cwd) : undefined;

		if (absoluteMovePath && absoluteMovePath !== absolutePath && (await pathExists(absoluteMovePath, ops))) {
			throw new ApplyPatchError("Move target already exists", "fileExists", movePath);
		}

		const newContent = change.hunks.length > 0
			? applyPatchHunks(oldContent, change.hunks, change.path)
			: oldContent;
		if (newContent === oldContent && !movePath) {
			throw new ApplyPatchError("Patch produced no changes", "noChanges", change.path);
		}

		throwIfAborted(signal);
		if (absoluteMovePath) {
			await ops.mkdir(dirname(absoluteMovePath));
			throwIfAborted(signal);
			if (newContent === oldContent) {
				await ops.rename(absolutePath, absoluteMovePath);
			} else {
				await ops.writeFile(absoluteMovePath, bom + restoreLineEndings(newContent, lineEnding));
				await ops.unlink(absolutePath);
			}
		} else {
			await ops.writeFile(absolutePath, bom + restoreLineEndings(newContent, lineEnding));
		}
		throwIfAborted(signal);

		return buildAppliedFile(
			{ action: "update", path: change.path, movePath },
			absolutePath,
			oldContent,
			newContent,
			absoluteMovePath,
		);
	});
}

export async function applyPatch(input: string, options: ApplyPatchOptions): Promise<ApplyPatchResult> {
	const parsed = parseApplyPatch(input);
	const ops = options.operations ?? defaultOperations;
	const files: AppliedPatchFile[] = [];

	for (const change of parsed.changes) {
		throwIfAborted(options.signal);
		if (change.action === "add") files.push(await applyAddFile(change, options.cwd, ops, options.signal));
		else if (change.action === "delete") files.push(await applyDeleteFile(change, options.cwd, ops, options.signal));
		else files.push(await applyUpdateFile(change, options.cwd, ops, options.signal));
	}

	return {
		files,
		diff: files.map((file) => file.diff).filter(Boolean).join("\n"),
		patch: files.map((file) => file.patch).filter(Boolean).join("\n"),
		additions: files.reduce((sum, file) => sum + file.additions, 0),
		deletions: files.reduce((sum, file) => sum + file.deletions, 0),
	};
}
