import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parsePromptFile, prompt, promptList, resetPromptCache } from "../../core/prompts";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const parsed = (text: string) => Object.fromEntries([...parsePromptFile(text, "t.md")].map(([key, entry]) => [key, entry.body]));

test("parsePromptFile: headings, trimmed blank lines, exact inner text, comments, preamble", () => {
	const text = "preamble <!-- multi\nline --> ignored\n\n## a.b-1_x\n\n\n  first line\n\nsecond <!-- gone --> line\t\n\n\n## list\n<!-- c -->\n- one\n- two\n## empty\n";
	assert.deepEqual(parsed(text), { "a.b-1_x": "  first line\n\nsecond  line\t", list: "- one\n- two", empty: "" });
	assert.deepEqual(parsed("## k\r\nline 1\r\nline 2\r\n"), { k: "line 1\nline 2" });
	assert.throws(() => parsed("## Bad Key\nx"), /t\.md: invalid prompt key "Bad Key"/u);
	assert.throws(() => parsed("## a\nx\n## a\ny"), /t\.md: duplicate prompt key "a"/u);
	assert.throws(() => parsed("## a\nx <!-- open"), /unterminated/u);
});

test("prompt / promptList read the shipped files; placeholders are strict", () => {
	resetPromptCache();
	assert.equal(prompt("subagent", "roster_target", { target: "rev" }), "- The user named @agent/rev; you must call subagent with target=\"rev\" and must not substitute another session.");
	assert.equal(prompt("subagent", "roster_target", { target: "$&{{target}}" }), "- The user named @agent/$&{{target}}; you must call subagent with target=\"$&{{target}}\" and must not substitute another session.");
	assert.throws(() => prompt("subagent", "roster_target"), /subagent\.md#roster_target: missing variable "target"/u);
	assert.throws(() => prompt("subagent", "roster_target", { target: "a", extra: "b" }), /unknown variable "extra"/u);
	assert.throws(() => prompt("subagent", "prompt_snippet", { extra: "b" }), /unknown variable "extra"/u);
	assert.throws(() => prompt("subagent", "nope"), /subagent\.md: missing prompt key "nope"/u);
	assert.equal(promptList("apply-patch", "prompt_guidelines").length, 8);
	assert.throws(() => promptList("subagent", "prompt_snippet"), /list line must start with "- "/u);
	assert.throws(() => promptList("subagent", "roster_target"), /list entries take no placeholders/u);
});

test("override: replaces single keys, rejects unknown keys and placeholder changes, honours PI_CODING_AGENT_DIR", (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "rail-prompts-"));
	const previous = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previous;
		resetPromptCache();
		rmSync(agentDir, { recursive: true, force: true });
	});
	const overridePath = join(agentDir, "rail-prompts", "subagent.md");
	const override = (text: string) => {
		mkdirSync(dirname(overridePath), { recursive: true });
		writeFileSync(overridePath, text);
		resetPromptCache();
	};
	const original = prompt("subagent", "prompt_snippet");
	const roster = prompt("subagent", "roster_follow_up");

	override("## prompt_snippet\n\nMine {{ignored}}\n");
	assert.throws(() => prompt("subagent", "prompt_snippet"), /rail-prompts.subagent\.md#prompt_snippet: placeholders must match the default \(none\)/u);
	override("## roster_target\n\nTarget only.\n");
	assert.throws(() => prompt("subagent", "roster_target", { target: "a" }), /roster_target: placeholders must match the default \(target\)/u);
	override("## not_a_key\n\nx\n");
	assert.throws(() => prompt("subagent", "prompt_snippet"), /rail-prompts.subagent\.md: unknown prompt key "not_a_key"/u);

	override("<!-- mine -->\n## prompt_snippet\n\nCustom snippet\n\n## roster_target\n\nGo to {{target}}\n");
	assert.equal(prompt("subagent", "prompt_snippet"), "Custom snippet");
	assert.equal(prompt("subagent", "roster_target", { target: "x" }), "Go to x");
	assert.equal(prompt("subagent", "roster_follow_up"), roster, "keys the override does not define keep the default");

	rmSync(overridePath);
	assert.equal(prompt("subagent", "prompt_snippet"), "Custom snippet", "loaded once per process until the cache is reset");
	resetPromptCache();
	assert.equal(prompt("subagent", "prompt_snippet"), original);
});

test("every key in prompts/*.md is used by code and every used key exists", () => {
	const defined = new Set<string>();
	for (const file of readdirSync(join(repo, "prompts")).filter((name) => name.endsWith(".md") && name !== "README.md")) {
		for (const key of parsePromptFile(readFileSync(join(repo, "prompts", file), "utf8"), file).keys()) defined.add(`${file.slice(0, -3)}#${key}`);
	}
	const used = new Set<string>();
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name === "tests" || entry.name.startsWith(".")) continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name.endsWith(".ts") && !path.endsWith(join("core", "prompts.ts"))) {
				const source = readFileSync(path, "utf8");
				const calls = [...source.matchAll(/(?<![.\w])prompt(?:List)?\(/gu)];
				const literal = [...source.matchAll(/(?<![.\w])prompt(?:List)?\("([a-z-]+)", "([a-z0-9_.-]+)"/gu)];
				assert.equal(literal.length, calls.length, `${path}: prompt()/promptList() calls must use literal file and key`);
				for (const [, file, key] of literal) used.add(`${file}#${key}`);
			}
		}
	};
	walk(repo);
	assert.deepEqual([...used].filter((name) => !defined.has(name)), [], "used but not defined");
	assert.deepEqual([...defined].filter((name) => !used.has(name)), [], "defined but unused");
});
