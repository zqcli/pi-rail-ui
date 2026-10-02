import { Text } from "@earendil-works/pi-tui";
import {
	defineTool,
	renderDiff,
	type AgentToolResult,
	type ExtensionAPI,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { prompt, promptList } from "../../core/prompts";
import {
	applyPatch,
	type AppliedPatchFile,
	type ApplyPatchFileSummary,
	type ApplyPatchResult,
	resolvePatchPath,
	summarizeApplyPatch,
} from "./core";

const applyPatchSchema = Type.Object({
	input: Type.String({
		description:
			"Patch text using the Codex apply-patch format, not a standard unified diff. Must start with *** Begin Patch and end with *** End Patch. Every content line inside Add File and Update File hunks must include its prefix, including blank lines.",
	}),
});

type ApplyPatchInput = Static<typeof applyPatchSchema>;

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function asInput(args: unknown): ApplyPatchInput {
	if (typeof args === "string") return { input: args };
	if (args && typeof args === "object") {
		const record = args as Record<string, unknown>;
		if (typeof record["input"] === "string") return { input: record["input"] };
		if (typeof record["patch"] === "string") return { input: record["patch"] };
	}
	return { input: "" };
}

function displayPath(path: string, cwd: string): string {
	try {
		const absolutePath = resolvePatchPath(path, cwd);
		const normalizedCwd = resolvePatchPath(".", cwd);
		if (absolutePath === normalizedCwd) return ".";
		if (absolutePath.startsWith(`${normalizedCwd}/`)) return absolutePath.slice(normalizedCwd.length + 1);
		const home = process.env["HOME"];
		if (home && absolutePath.startsWith(`${home}/`)) return `~/${absolutePath.slice(home.length + 1)}`;
		return absolutePath;
	} catch {
		return path;
	}
}

function actionLabel(file: ApplyPatchFileSummary): string {
	if (file.action === "add") return "Add File:";
	if (file.action === "delete") return "Delete File:";
	return file.movePath ? "Move File:" : "Update File:";
}

function actionColor(file: ApplyPatchFileSummary): "success" | "error" | "warning" {
	if (file.action === "add") return "success";
	if (file.action === "delete") return "error";
	return "warning";
}

function formatSummaryFile(file: ApplyPatchFileSummary, theme: Theme, cwd: string): string {
	const label = theme.fg(actionColor(file), actionLabel(file));
	const path = theme.fg("accent", displayPath(file.path, cwd));
	if (file.movePath) return `${label} ${path} -> ${theme.fg("accent", displayPath(file.movePath, cwd))}`;
	return `${label} ${path}`;
}

function formatAppliedFile(file: AppliedPatchFile, theme: Theme, cwd: string): string {
	let line = formatSummaryFile(file, theme, cwd);
	if (file.additions || file.deletions) {
		line += ` ${theme.fg("success", `+${file.additions}`)} ${theme.fg("error", `-${file.deletions}`)}`;
	}
	return line;
}

function formatCall(args: unknown, theme: Theme, cwd: string): string {
	const { input } = asInput(args);
	const summaries = input ? summarizeApplyPatch(input) : [];
	const lineCount = input ? input.split(/\r\n|\r|\n/u).length : 0;
	let text = theme.fg("toolTitle", theme.bold("apply-patch"));
	if (lineCount > 0) text += theme.fg("muted", ` (${plural(lineCount, "line")})`);

	if (summaries.length > 0) {
		const shown = summaries.slice(0, 6).map((file) => formatSummaryFile(file, theme, cwd));
		text += `\n${shown.join("\n")}`;
		if (summaries.length > shown.length) {
			text += `\n${theme.fg("muted", `... ${plural(summaries.length - shown.length, "more file")}`)}`;
		}
	}

	return text;
}

function formatResultSummary(details: ApplyPatchResult, theme: Theme, cwd: string): string {
	const changed = plural(details.files.length, "file");
	let text = `${theme.fg("success", "Done.")} ${changed} changed`;
	if (details.additions || details.deletions) {
		text += ` ${theme.fg("success", `+${details.additions}`)} ${theme.fg("error", `-${details.deletions}`)}`;
	}
	if (details.files.length > 0) {
		text += `\n${details.files.map((file) => formatAppliedFile(file, theme, cwd)).join("\n")}`;
	}
	return text;
}

function formatErrorResult(result: AgentToolResult<ApplyPatchResult>, theme: Theme): string {
	const text = result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	return theme.fg("error", text || "apply-patch failed");
}

function formatResult(
	result: AgentToolResult<ApplyPatchResult>,
	options: ToolRenderResultOptions,
	theme: Theme,
	cwd: string,
	isError: boolean,
): string {
	if (options.isPartial) return theme.fg("warning", "Applying patch...");
	if (isError || !result.details) return formatErrorResult(result, theme);

	let text = formatResultSummary(result.details, theme, cwd);
	if (options.expanded && result.details.diff) {
		text += `\n\n${renderDiff(result.details.diff)}`;
	}
	return text;
}

const applyPatchTool = defineTool<typeof applyPatchSchema, ApplyPatchResult>({
	name: "apply-patch",
	label: "apply-patch",
	description: prompt("apply-patch", "description"),
	promptSnippet: prompt("apply-patch", "prompt_snippet"),
	promptGuidelines: promptList("apply-patch", "prompt_guidelines"),
	parameters: applyPatchSchema,
	executionMode: "sequential",
	prepareArguments: asInput,

	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const details = await applyPatch(params.input, { cwd: ctx.cwd, signal });
		return {
			content: [
				{
					type: "text",
					text: `Done. ${plural(details.files.length, "file")} changed (+${details.additions} -${details.deletions}).`,
				},
			],
			details,
		};
	},

	renderCall(args, theme, context) {
		const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
		component.setText(formatCall(args, theme, context.cwd));
		return component;
	},

	renderResult(result, options, theme, context) {
		const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
		component.setText(formatResult(result, options, theme, context.cwd, context.isError));
		return component;
	},
});

export function installApplyPatchTool(pi: ExtensionAPI): void {
	pi.registerTool(applyPatchTool);
}

export * from "./core";
