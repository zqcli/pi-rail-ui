import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { spawn } from "node:child_process";

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
			"or accessing any HTTP endpoint. By default emulates a Chrome browser User-Agent.",
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
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const url = params.url as string;
			const method = (params.method as string) ?? "GET";
			const userHeaders = (params.headers as Record<string, string> | undefined) ?? {};
			const body = params.body as string | undefined;
			const timeout = (params.timeout as number | undefined) ?? 30;
			const proxy = params.proxy as string | undefined;

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

			args.push(url);

			if (body && method !== "GET") {
				args.push("--data", body);
			}

			const { stdout, stderr } = await runCurl(args, signal);

			if (stderr) {
				throw new Error(`curl error: ${stderr}`);
			}

			const { statusCode, responseHeaders, responseBody } = parseCurlOutput(stdout);

			const truncation = truncateHead(responseBody, { maxBytes: DEFAULT_MAX_BYTES });
			let displayBody = truncation.content;

			if (truncation.truncated) {
				displayBody +=
					`\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}. ` +
					`Use the read tool with offset/limit to inspect the remaining content if saved to a file.]`;
			}

			const output = JSON.stringify(
				{
					status: statusCode,
					headers: Object.fromEntries(responseHeaders.slice(0, 20)),
					body: displayBody,
					truncated: truncation.truncated,
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
					truncated: truncation.truncated,
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

function parseCurlOutput(raw: string): {
	statusCode: number;
	responseHeaders: [string, string][];
	responseBody: string;
} {
	const lines = raw.split(/\r?\n/);
	let statusCode = 0;

	// Find the real HTTP status line. Skip proxy CONNECT tunnel lines
	// like "HTTP/1.1 200 Connection established" that precede the actual response.
	let start = 0;
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i]?.match(/^HTTP\/(?:\d\.\d|2)\s+(\d+)/);
		if (m) {
			statusCode = +m[1];
			start = i;
			// If this is a proxy CONNECT response, look for the next status line
			if (lines[i]?.includes("Connection established")) {
				continue;
			}
			break;
		}
	}

	const responseHeaders: [string, string][] = [];
	let i = start + 1;
	for (; i < lines.length; i++) {
		if (lines[i] === "" || lines[i] === "\r") {
			i++;
			break;
		}
		const ci = lines[i].indexOf(":");
		if (ci > 0) {
			responseHeaders.push([lines[i].slice(0, ci).trim(), lines[i].slice(ci + 1).trim()]);
		}
	}

	return { statusCode, responseHeaders, responseBody: lines.slice(i).join("\n").trim() };
}
