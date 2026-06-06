import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const CHROME_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

const DEFAULT_HEADERS: Record<string, string> = {
	"User-Agent": CHROME_UA,
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
	"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
};

export function registerWebFetchTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Make an HTTP request using curl. Returns structured { status, headers, body } " +
			"with status code and response headers. Use for fetching web content, calling APIs, " +
			"or accessing any HTTP endpoint. By default emulates a Chrome browser User-Agent. " +
			"Response body previews are truncated to maxBytes; set outputPath to save the full body.",
		promptSnippet: "Make HTTP requests with configurable method, headers, body, proxy, and timeout",

		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
			method: Type.Optional(
				StringEnum(["GET", "POST", "PUT", "PATCH", "DELETE"] as const, {
					default: "GET",
					description: "HTTP method",
				}),
			),
			headers: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: "Additional HTTP headers. Merged with default Chrome browser headers (User-Agent, Accept, Accept-Language).",
				}),
			),
			body: Type.Optional(
				Type.String({ description: "Request body (for POST/PUT/PATCH)" }),
			),
			timeout: Type.Optional(
				Type.Number({ description: "Timeout in seconds, default 30", default: 30 }),
			),
			proxy: Type.Optional(
				Type.String({
					description:
						"Proxy URL. Supports socks5:// socks5h:// http:// https://. e.g. socks5://127.0.0.1:1080",
				}),
			),
			followRedirects: Type.Optional(
				Type.Boolean({
					description: "Whether to follow HTTP redirects. Default: true.",
					default: true,
				}),
			),
			maxRedirects: Type.Optional(
				Type.Number({
					description: "Maximum number of redirects to follow. Default: 10.",
					default: 10,
				}),
			),
			maxBytes: Type.Optional(
				Type.Number({
					description: `Maximum response body preview bytes. Default ${DEFAULT_MAX_BYTES}.`,
					default: DEFAULT_MAX_BYTES,
				}),
			),
			outputPath: Type.Optional(
				Type.String({
					description: "Optional file path to save the complete response body. Relative paths are resolved from cwd.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const url = params.url as string;
			const method = (params.method as string) ?? "GET";
			const userHeaders = (params.headers as Record<string, string> | undefined) ?? {};
			const body = params.body as string | undefined;
			const timeout = (params.timeout as number | undefined) ?? 30;
			const proxy = params.proxy as string | undefined;
			const followRedirects = (params.followRedirects as boolean | undefined) ?? true;
			const maxRedirects = (params.maxRedirects as number | undefined) ?? 10;
			const maxBytes = Math.max(0, Math.floor((params.maxBytes as number | undefined) ?? DEFAULT_MAX_BYTES));
			const outputPath = params.outputPath as string | undefined;

			// Merge: user headers override defaults
			const mergedHeaders: Record<string, string> = {};
			for (const [k, v] of Object.entries(DEFAULT_HEADERS)) {
				const lk = k.toLowerCase();
				mergedHeaders[lk] = v;
			}
			for (const [k, v] of Object.entries(userHeaders)) {
				if (v === undefined || v === null) continue;
				mergedHeaders[k.toLowerCase()] = v;
			}

			const args = ["-s", "-i", "--max-time", String(timeout), "-X", method];

			if (proxy) {
				args.push("--proxy", proxy);
			}

			for (const [k, v] of Object.entries(mergedHeaders)) {
				args.push("-H", `${k}: ${v}`);
			}

			if (followRedirects && maxRedirects > 0) {
				args.push("-L", "--max-redirs", String(maxRedirects));
			}

			args.push(url);

			if (body && method !== "GET") {
				args.push("--data", body);
			}

			const { stdout, stderr } = await runCurl(args, signal);

			if (stderr) {
				throw new Error(`curl error: ${stderr}`);
			}

			const { statusCode, responseHeaders, responseBody, redirectUrls } =
				parseCurlOutput(stdout);

			let savedOutputPath: string | undefined;
			if (outputPath) {
				savedOutputPath = path.isAbsolute(outputPath) ? outputPath : path.resolve(ctx.cwd, outputPath);
				await fs.mkdir(path.dirname(savedOutputPath), { recursive: true });
				await fs.writeFile(savedOutputPath, responseBody, "utf8");
			}

			const truncation = truncateHead(responseBody, { maxBytes });
			let displayBody = truncation.content;

			if (truncation.truncated) {
				displayBody +=
					`\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}.` +
					(savedOutputPath
						? ` Full response body saved to ${savedOutputPath}.]`
						: " Set outputPath to save the complete response body.]");
			}

			const output = JSON.stringify(
				{
					status: statusCode,
					headers: Object.fromEntries(responseHeaders.slice(0, 20)),
					body: displayBody,
					truncated: truncation.truncated,
					...(savedOutputPath ? { outputPath: savedOutputPath } : {}),
					...(redirectUrls.length > 0
						? { redirectCount: redirectUrls.length, redirectUrls }
						: {}),
				},
				null,
				2,
			);

			return {
				content: [{ type: "text" as const, text: output }],
				details: {
					status: statusCode,
					headerCount: responseHeaders.length,
					bodySize: truncation.totalBytes,
					previewBytes: truncation.outputBytes,
					truncated: truncation.truncated,
					...(savedOutputPath ? { outputPath: savedOutputPath } : {}),
					redirectCount: redirectUrls.length,
				},
			};
		},
	});
}

function runCurl(
	args: string[],
	signal: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const proc = spawn("curl", args, { windowsHide: true });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
		proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
		signal.addEventListener("abort", () => proc.kill());
		proc.on("close", (code) => {
			if (code === 0) resolve({ stdout, stderr });
			else reject(new Error(stderr || `curl exited with code ${code}`));
		});
		proc.on("error", reject);
	});
}

interface HttpResponseBlock {
	statusCode: number;
	responseHeaders: [string, string][];
	responseBody: string;
	redirectUrl?: string;
}

function parseCurlOutput(raw: string): {
	statusCode: number;
	responseHeaders: [string, string][];
	responseBody: string;
	redirectUrls: string[];
} {
	const lines = raw.split(/\r?\n/);
	const blocks: HttpResponseBlock[] = [];
	const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

	let i = 0;
	while (i < lines.length) {
		const m = lines[i]?.match(/^HTTP\/(?:\d\.\d|2)\s+(\d+)/);
		if (m && !lines[i]?.includes("Connection established")) {
			const sc = +m[1];
			let hi = i + 1;
			const hdrs: [string, string][] = [];
			let location: string | undefined;
			for (; hi < lines.length; hi++) {
				if (lines[hi] === "" || lines[hi] === "\r") {
					hi++;
					break;
				}
				const ci = lines[hi].indexOf(":");
				if (ci > 0) {
					const key = lines[hi].slice(0, ci).trim();
					const val = lines[hi].slice(ci + 1).trim();
					hdrs.push([key, val]);
					if (key.toLowerCase() === "location") location = val;
				}
			}
			// Scan body until next HTTP status line or EOF
			let bi = hi;
			while (bi < lines.length && !/^HTTP\/(?:\d\.\d|2)\s+\d+/.test(lines[bi] ?? "")) {
				bi++;
			}
			const body = lines.slice(hi, bi).join("\n").trim();
			blocks.push({
				statusCode: sc,
				responseHeaders: hdrs,
				responseBody: body,
				redirectUrl: REDIRECT_CODES.has(sc) ? location : undefined,
			});
			i = bi;
		} else {
			i++;
		}
	}

	if (blocks.length === 0) {
		return { statusCode: 0, responseHeaders: [], responseBody: raw, redirectUrls: [] };
	}

	const last = blocks[blocks.length - 1];
	const redirectUrls = blocks
		.filter((b) => b.redirectUrl)
		.map((b) => b.redirectUrl!);

	return {
		statusCode: last.statusCode,
		responseHeaders: last.responseHeaders,
		responseBody: last.responseBody,
		redirectUrls,
	};
}
