import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Every model-facing instruction text lives in `<repo>/prompts/<file>.md`; see prompts/README.md. */
export type PromptFile = "apply-patch" | "gpt-compaction" | "subagent" | "team";

type Entry = { body: string; source: string };

const DEFAULT_DIR = fileURLToPath(new URL("../prompts/", import.meta.url));
const KEY = /^[a-z0-9_.-]+$/u;
const PLACEHOLDER = /\{\{([A-Za-z0-9_]+)\}\}/gu;
const cache = new Map<PromptFile, Map<string, Entry>>();

const placeholders = (body: string): Set<string> => new Set([...body.matchAll(PLACEHOLDER)].map((match) => match[1]!));
const placeholderNames = (body: string): string => [...placeholders(body)].sort().join(", ");

/** `## key` starts an entry that runs to the next heading; comments are dropped and surrounding blank lines trimmed. */
export function parsePromptFile(text: string, source: string): Map<string, Entry> {
	const stripped = text.replace(/<!--[\s\S]*?-->/gu, "");
	if (stripped.includes("<!--")) throw new Error(`${source}: unterminated <!-- comment`);
	const entries = new Map<string, Entry>();
	let key: string | undefined;
	let lines: string[] = [];
	const flush = (): void => {
		if (key === undefined) return;
		let start = 0;
		let end = lines.length;
		while (start < end && !lines[start]!.trim()) start++;
		while (end > start && !lines[end - 1]!.trim()) end--;
		entries.set(key, { body: lines.slice(start, end).join("\n"), source });
	};
	for (const line of stripped.split(/\r?\n/u)) {
		if (!line.startsWith("## ")) {
			lines.push(line);
			continue;
		}
		flush();
		key = line.slice(3).trim();
		if (!KEY.test(key)) throw new Error(`${source}: invalid prompt key "${key}" (use [a-z0-9_.-]+)`);
		if (entries.has(key)) throw new Error(`${source}: duplicate prompt key "${key}"`);
		entries.set(key, { body: "", source });
		lines = [];
	}
	flush();
	return entries;
}

function load(file: PromptFile): Map<string, Entry> {
	const cached = cache.get(file);
	if (cached) return cached;
	const defaultPath = path.join(DEFAULT_DIR, `${file}.md`);
	const entries = parsePromptFile(fs.readFileSync(defaultPath, "utf8"), defaultPath);
	const overridePath = path.join(getAgentDir(), "rail-prompts", `${file}.md`);
	if (fs.existsSync(overridePath)) {
		for (const [key, override] of parsePromptFile(fs.readFileSync(overridePath, "utf8"), overridePath)) {
			const base = entries.get(key);
			if (!base) throw new Error(`${overridePath}: unknown prompt key "${key}" (${defaultPath} does not define it)`);
			if (placeholderNames(override.body) !== placeholderNames(base.body)) {
				throw new Error(`${overridePath}#${key}: placeholders must match the default (${placeholderNames(base.body) || "none"})`);
			}
			entries.set(key, override);
		}
	}
	cache.set(file, entries);
	return entries;
}

function entry(file: PromptFile, key: string): Entry {
	const found = load(file).get(key);
	if (!found) throw new Error(`${path.join(DEFAULT_DIR, `${file}.md`)}: missing prompt key "${key}"`);
	return found;
}

/** The entry's text with each `{{name}}` replaced; a missing or unused variable is an error. */
export function prompt(file: PromptFile, key: string, vars: Record<string, string> = {}): string {
	const { body, source } = entry(file, key);
	const names = placeholders(body);
	for (const name of names) if (!Object.hasOwn(vars, name)) throw new Error(`${source}#${key}: missing variable "${name}"`);
	for (const name of Object.keys(vars)) if (!names.has(name)) throw new Error(`${source}#${key}: unknown variable "${name}"`);
	return body.replace(PLACEHOLDER, (_match, name: string) => vars[name]!);
}

/** A list entry: every non-blank line is `- item`. */
export function promptList(file: PromptFile, key: string): string[] {
	const { body, source } = entry(file, key);
	if (placeholders(body).size) throw new Error(`${source}#${key}: list entries take no placeholders`);
	const items = body.split("\n").filter((line) => line.trim()).map((line) => {
		if (!line.startsWith("- ")) throw new Error(`${source}#${key}: list line must start with "- ": ${line}`);
		return line.slice(2);
	});
	if (!items.length) throw new Error(`${source}#${key}: list entry is empty`);
	return items;
}

/** Forget loaded files so the next call re-reads them (tests; extension reload re-imports the module anyway). */
export function resetPromptCache(): void {
	cache.clear();
}
