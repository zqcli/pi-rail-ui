import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PiRpcProcessTransport } from "../../tools/subagents/rpc-transport";

const bundle = fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/bundle-keep-alive-probe.ts", import.meta.url));

test("bundled CLI: capture the actual warmer through public AgentSession without a provider call", { timeout: 30_000 }, async (t) => {
 const root = join(process.cwd(), ".tmp");
 await mkdir(root, { recursive: true });
 const dir = await mkdtemp(join(root, "ka-bundle-"));
 const output = join(dir, "result.json");
 const log = join(dir, "provider.jsonl");
 const transport = new PiRpcProcessTransport({
  command: process.execPath,
  args: [bundle, "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--offline", "-e", fixture],
  cwd: process.cwd(),
  env: { ...process.env, HOME: join(dir, "home"), PI_CODING_AGENT_DIR: join(dir, "agent"), PI_OFFLINE: "1", KA_PROBE_OUTPUT: output, KA_PROBE_LOG: log },
 });
 t.after(async () => { await transport.stop().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
 await transport.start();
 await transport.request({ type: "prompt", message: "/rail-keep-alive 1" });
 await transport.request({ type: "prompt", message: "/ka-probe" });
 const result = JSON.parse(await readFile(output, "utf8"));
 assert.equal(result.captured, true);
 assert.equal(result.bound, true);
 assert.match(result.status, /KA 1m WAIT.*fresh real request/);
 assert.equal(result.usage, 0);
});

test("bundled CLI local mock provider: refresh retains request hooks and writes usage, not chat", { timeout: 30_000 }, async (t) => {
 const root = join(process.cwd(), ".tmp");
 await mkdir(root, { recursive: true });
 const dir = await mkdtemp(join(root, "ka-mock-"));
 const output = join(dir, "result.json");
 const log = join(dir, "provider.jsonl");
 const transport = new PiRpcProcessTransport({
  command: process.execPath,
  args: [bundle, "--mode", "rpc", "--no-session", "--model", "rail-ka-local/local", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--offline", "-e", fixture],
  cwd: process.cwd(),
  env: { ...process.env, HOME: join(dir, "home"), PI_CODING_AGENT_DIR: join(dir, "agent"), PI_OFFLINE: "1", KA_PROBE_OUTPUT: output, KA_PROBE_LOG: log },
 });
 t.after(async () => { await transport.stop().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
 await transport.start();
 await transport.request({ type: "prompt", message: "/rail-keep-alive 1" });
 const settled = new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => { off(); reject(new Error("local mock agent did not settle")); }, 10_000);
  const off = transport.onEvent((event) => { if (event.type === "agent_settled") { clearTimeout(timeout); off(); resolve(); } });
 });
 await transport.request({ type: "prompt", message: "real prompt (local mock only)" });
 await settled;
 await transport.request({ type: "prompt", message: "/ka-probe" });
 const result = JSON.parse(await readFile(output, "utf8"));
 const requests = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
 assert.equal(result.bound, true);
 assert.equal(result.usage, 1, JSON.stringify({ result, requests: requests.map(({ payload, ...rest }) => rest) }));
 assert.equal(result.assistant, 1);
 assert.equal(requests.length, 2);
 assert.equal(requests[1].maxTokens, 1);
 assert.deepEqual(requests.map(request => [request.hasPayloadHook, request.hasResponseHook, request.hasHeadersHook]), [[true, true, true], [true, true, true]]);
});
