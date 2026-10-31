import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
const cli = join(packageDir, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

function launch(root: string, extension: string, append: string) {
  const child = spawn(process.execPath, [cli, "--mode", "rpc", "--no-session",
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-tools",
    "--extension", extension, "--append-system-prompt", append,
    "--provider", "identity-test", "--model", "fixture"], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: join(root, "pi") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let diagnostics = "";
  let nextId = 0;
  const events = new EventEmitter();
  const pending = new Map<string, (record: any) => void>();
  child.stderr.on("data", (chunk) => { diagnostics += chunk; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (record.type === "response") {
        pending.get(record.id)?.(record);
        pending.delete(record.id);
      } else {
        events.emit(record.type, record);
      }
    }
  });
  function send(command: object) {
    const id = String(++nextId);
    return new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`RPC timed out: ${diagnostics}`)), 15000);
      pending.set(id, (response) => {
        clearTimeout(timeout);
        if (response.success) resolve(response);
        else reject(new Error(response.error));
      });
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }
  return {
    child, events, send,
    async prompt(message: string) {
      const settled = once(events, "agent_settled");
      await send({ type: "prompt", message });
      await settled;
    },
    async close() {
      const closed = once(child, "close");
      child.stdin.end();
      const timeout = setTimeout(() => child.kill("SIGTERM"), 3000);
      await closed;
      clearTimeout(timeout);
    },
  };
}

test("real Pi RPC: bundled identities without ~/Agents, picker, and restart persistence", { timeout: 45000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-identity-rpc-"));
  mkdirSync(join(root, "pi"));
  assert.equal(existsSync(join(root, "Agents")), false);
  const append = join(root, "legacy.md");
  const legacy = readFileSync(join(packageDir, "agents", "Hyperion.md"), "utf8");
  writeFileSync(append, `BB safety: never push main.\n${legacy}`);
  const payloads: any[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    payloads.push(JSON.parse(body));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const base = { id: "local-fixture", object: "chat.completion.chunk", created: 1, model: "fixture" };
    response.write(`data: ${JSON.stringify({ ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const extension = join(root, "fixture.ts");
  writeFileSync(extension, `
import identityExtension from ${JSON.stringify(join(packageDir, "index.ts"))};
export default function(pi) {
  identityExtension(pi);
  pi.registerProvider("identity-test", {
    api: "openai-completions", apiKey: "local-test-only",
    baseUrl: "http://127.0.0.1:${address.port}/v1",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 64 }]
  });
}
`);
  const running: ReturnType<typeof launch>[] = [];
  try {
    const first = launch(root, extension, append);
    running.push(first);
    const commands = await first.send({ type: "get_commands" });
    assert.ok(commands.data.commands.some((command: any) => command.name === "agent"));
    await first.prompt("Hello");
    const system = () => payloads.at(-1).messages
      .filter((message: any) => message.role === "system" || message.role === "developer")
      .map((message: any) => message.content).join("\n");
    assert.equal(payloads.length, 1);
    assert.equal(system().match(/Your name is Hyperion\./g)?.length, 1);
    assert.match(system(), /BB safety: never push main/);
    const changed = await first.send({ type: "prompt", message: "/agent themis" });
    assert.equal(changed.data.disposition, "handled");
    assert.equal(payloads.length, 1, "switching must not call a model");
    await first.prompt("Hello again");
    assert.match(system(), /Your name is Themis\./);
    assert.doesNotMatch(system(), /Hyperion/);
    assert.match(system(), /BB safety: never push main/);
    const messages = await first.send({ type: "get_messages" });
    assert.ok(messages.data.messages.some((message: any) =>
      message.customType === "agent-identity" && message.content.includes("Agent: Themis")));
    const restarted = launch(root, extension, append);
    running.push(restarted);
    await restarted.prompt("New session");
    assert.match(system(), /Your name is Themis\./);
    assert.doesNotMatch(system(), /Hyperion/);
    const picker = once(restarted.events, "extension_ui_request");
    const picked = restarted.send({ type: "prompt", message: "/agent" });
    const [dialog] = await picker;
    assert.equal(dialog.method, "select");
    assert.deepEqual(dialog.options, ["Argus", "Hyperion", "Prometheus", "Themis", "Vulcan"]);
    restarted.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: dialog.id, value: "Hyperion" })}\n`);
    assert.equal((await picked).data.disposition, "handled");
    await restarted.prompt("After picker");
    assert.match(system(), /Your name is Hyperion\./);
    assert.doesNotMatch(system(), /Themis/);
  } finally {
    await Promise.all(running.map((client) => client.close()));
    server.close();
    await once(server, "close");
  }
});
