import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const config = JSON.parse(process.argv[2]);
const args = process.argv.slice(3);
const sessionPath = args[args.indexOf("--session") + 1];
const prompt = args.at(-1);
const markerPath = join(process.cwd(), "side-effect.txt");
const invocationPath = join(process.cwd(), "invocations.jsonl");
const previous = existsSync(invocationPath)
	? readFileSync(invocationPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))
	: [];
const attempt = previous.length;
appendFileSync(invocationPath, `${JSON.stringify({ args, sessionPath, prompt, pid: process.pid })}\n`);
assert.ok(args.includes("--session"), "continuation needs a private persisted session");
let entries = existsSync(sessionPath)
	? readFileSync(sessionPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))
	: [];
if (!entries.length) {
	assert.equal(attempt, 0, "retry must not create a fresh session");
	assert.match(prompt, /^Task: /u);
	const header = { type: "session", version: 3, id: "private-retry", timestamp: new Date().toISOString(), cwd: process.cwd() };
	appendFileSync(sessionPath, `${JSON.stringify(header)}\n`);
	entries.push(header);
} else {
	assert.doesNotMatch(prompt, /^Task: /u, "original task must not be redispatched");
	assert.match(prompt, /Continue from where you stopped/u);
	assert.match(prompt, /do not repeat completed side effects/u);
	const completed = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult");
	assert.equal(completed?.message.content[0].text, "appended marker once", "completed result must survive continuation");
	assert.equal(readFileSync(markerPath, "utf8"), "once\n", "recorded side effect must not be repeated");
}
write({ type: "agent_start" });
record({ role: "user", content: prompt, timestamp: Date.now() });
if (attempt === 0) {
	record({
		role: "assistant", content: [{ type: "toolCall", id: "append-once", name: "bash", arguments: { command: "append marker" } }],
		usage: usage(2, 1), stopReason: "toolUse", timestamp: Date.now(),
	});
	write({ type: "tool_execution_start", toolCallId: "append-once", toolName: "bash", args: { command: "append marker" } });
	appendFileSync(markerPath, "once\n");
	const result = { content: [{ type: "text", text: "appended marker once" }] };
	write({ type: "tool_execution_end", toolCallId: "append-once", toolName: "bash", result, isError: false });
	record({ role: "toolResult", toolCallId: "append-once", toolName: "bash", ...result, isError: false, timestamp: Date.now() });
}
if (config.stall) await new Promise((resolve) => setTimeout(resolve, 30_000));
const failed = attempt < (config.failures ?? 1);
if (config.protocolError) write({ type: "extension_error", error: `[rail-context-protocol-error] ${config.protocolError}` });
record({
	role: "assistant",
	content: failed ? [] : [{ type: "text", text: "continued with recorded tool result" }],
	usage: failed ? usage(10, 2) : usage(20, 3),
	stopReason: failed ? (config.stopReason ?? "error") : "stop",
	...(failed ? { errorMessage: config.error ?? "503 Service Unavailable" } : {}),
	timestamp: Date.now(),
});
if (config.malformedLine) process.stdout.write("{broken JSON\n");
if (config.malformedAssistant) record({ role: "assistant", content: [null], stopReason: "stop", timestamp: Date.now() });
write({ type: "agent_end", messages: [], willRetry: false });
if (config.nativeRecovery) {
	write({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2, errorMessage: "503 Service Unavailable" });
	record({ role: "assistant", content: [{ type: "text", text: "native recovery done" }], usage: usage(20, 3), stopReason: "stop", timestamp: Date.now() });
	write({ type: "auto_retry_end", success: true, attempt: 1 });
	write({ type: "agent_end", messages: [], willRetry: false });
}
if (!config.noSettled) write({ type: "agent_settled" });
if (config.removeSession) rmSync(sessionPath);
if (config.signalExit) process.kill(process.pid, "SIGTERM");
else process.exitCode = config.exitCode ?? 0;

function usage(input, output) {
	return { input, output, cacheRead: 1, cacheWrite: 0, totalTokens: input + output + 1, cost: { total: input / 100 } };
}
function record(message) {
	const entry = { type: "message", id: `message-${entries.length}`, parentId: entries.at(-1)?.type === "session" ? null : entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), message };
	appendFileSync(sessionPath, `${JSON.stringify(entry)}\n`);
	entries.push(entry);
	write({ type: "message_start", message: { role: message.role, content: [] } });
	write({ type: "message_end", message });
}
function write(event) {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}
