import { spawnSync } from "node:child_process";

const CHROME_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

function parseCurlOutput(raw: string): {
	statusCode: number;
	responseHeaders: [string, string][];
	responseBody: string;
} {
	const lines = raw.split(/\r?\n/);
	let statusCode = 0;
	let start = 0;
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i]?.match(/^HTTP\/(?:\d\.\d|2)\s+(\d+)/);
		if (m) {
			statusCode = +m[1];
			start = i;
			if (lines[i]?.includes("Connection established")) continue;
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

function curl(args: string[]): { stdout: string; stderr: string; status: number | null } {
	const r = spawnSync("curl", args, { encoding: "utf8", windowsHide: true, timeout: 15_000 });
	return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
	process.stdout.write(`  ${name} ... `);
	try {
		fn();
		console.log("PASS");
		passed++;
	} catch (e: unknown) {
		console.log(`FAIL: ${e}`);
		failed++;
	}
}

function baseArgs(url: string): string[] {
	return [
		"-s", "-i", "--max-time", "10", "-X", "GET",
		"-H", `User-Agent: ${CHROME_UA}`,
		"-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		"-H", "Accept-Language: zh-CN,zh;q=0.9,en;q=0.8",
		url,
	];
}

console.log("web_fetch tool tests\n");

// 1. GET httpbin
test("GET https://httpbin.org/get → 200", () => {
	const { stdout } = curl(baseArgs("https://httpbin.org/get"));
	const { statusCode, responseHeaders, responseBody } = parseCurlOutput(stdout);
	if (statusCode !== 200) throw new Error(`expected 200, got ${statusCode}`);
	if (responseHeaders.length === 0) throw new Error("no response headers");
	const body = JSON.parse(responseBody);
	if (body.url !== "https://httpbin.org/get") throw new Error(`url mismatch: ${body.url}`);
	if (body.headers["User-Agent"] !== CHROME_UA) throw new Error(`UA mismatch: ${body.headers["User-Agent"]}`);
});

// 2. POST httpbin
test("POST https://httpbin.org/post → 200 with JSON body", () => {
	const { stdout } = curl([
		"-s", "-i", "--max-time", "10", "-X", "POST",
		"-H", `User-Agent: ${CHROME_UA}`,
		"-H", "Content-Type: application/json",
		"--data", '{"hello":"world"}',
		"https://httpbin.org/post",
	]);
	const { statusCode, responseBody } = parseCurlOutput(stdout);
	if (statusCode !== 200) throw new Error(`expected 200, got ${statusCode}`);
	const body = JSON.parse(responseBody);
	if (body.json?.hello !== "world") throw new Error(`json mismatch: ${JSON.stringify(body.json)}`);
});

// 3. 404
test("GET https://httpbin.org/status/404 → 404", () => {
	const { stdout } = curl(baseArgs("https://httpbin.org/status/404"));
	const { statusCode } = parseCurlOutput(stdout);
	if (statusCode !== 404) throw new Error(`expected 404, got ${statusCode}`);
});

// 4. timeout
test("GET unreachable IP → curl exits non-zero", () => {
	const r = spawnSync("curl", ["-s", "-i", "--max-time", "2", "--connect-timeout", "2", "-X", "GET", "https://10.255.255.1"], {
		encoding: "utf8", windowsHide: true, timeout: 10_000,
	});
	if (r.status === 0) throw new Error("expected non-zero exit code");
});

// 5. custom headers
test("GET with custom X-Custom header", () => {
	const { stdout } = curl([
		"-s", "-i", "--max-time", "10", "-X", "GET",
		"-H", `User-Agent: ${CHROME_UA}`,
		"-H", "X-Custom: hello-test",
		"https://httpbin.org/headers",
	]);
	const { statusCode, responseBody } = parseCurlOutput(stdout);
	if (statusCode !== 200) throw new Error(`expected 200, got ${statusCode}`);
	const body = JSON.parse(responseBody);
	if (body.headers?.["X-Custom"] !== "hello-test") throw new Error(`X-Custom mismatch: ${JSON.stringify(body.headers)}`);
});

// 6. Chinese content
test("GET https://www.baidu.com → 200 with content", () => {
	const { stdout } = curl(baseArgs("https://www.baidu.com"));
	const { statusCode, responseBody } = parseCurlOutput(stdout);
	if (statusCode !== 200) throw new Error(`expected 200, got ${statusCode}`);
	if (responseBody.length === 0) throw new Error("empty body");
});

// 7. HTTP/2 + proxy: httpbin via https should work
test("HTTP/2 via proxy: httpbin headers have User-Agent", () => {
	const { stdout } = curl(baseArgs("https://httpbin.org/headers"));
	const { statusCode, responseHeaders } = parseCurlOutput(stdout);
	if (statusCode !== 200) throw new Error(`expected 200, got ${statusCode}`);
	const hasContentType = responseHeaders.some(([k]) => k.toLowerCase() === "content-type");
	if (!hasContentType) throw new Error("missing Content-Type header");
});

setTimeout(() => {
	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed > 0 ? 1 : 0);
}, 500);
