import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { IdentityStore } from "../store.ts";
import { registerIdentity } from "../index.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-identity-test-"));
  const agentsDir = join(root, "agents");
  const stateFile = join(root, "config", "identity.json");
  mkdirSync(agentsDir);
  writeFileSync(join(agentsDir, "Hyperion.md"), "# Hyperion\nYou are Hyperion.\n");
  writeFileSync(join(agentsDir, "Themis.md"), "# Themis\nYou are Themis.\n");
  const store = new IdentityStore(agentsDir, stateFile);
  return { root, agentsDir, stateFile, store };
}

function harness(store: IdentityStore) {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const notices: string[] = [];
  const messages: any[] = [];
  const statuses: Array<[string, string | undefined]> = [];
  const pi = {
    on: (name: string, fn: Function) => handlers.set(name, fn),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    sendMessage: (message: any) => messages.push(message),
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    isIdle: () => true,
    ui: {
      notify: (message: string) => notices.push(message),
      select: async (_title: string, _options: string[]) => undefined as string | undefined,
      setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
    },
  };
  registerIdentity(pi, store);
  const start = () => handlers.get("session_start")!({}, ctx);
  const command = (args: string) => commands.get("agent").handler(args, ctx);
  const prompt = (appendSystemPrompt = "", sections: Record<string, string> = {}) => {
    const event = { systemPromptOptions: { appendSystemPrompt, sections } };
    handlers.get("before_agent_start")!(event, ctx);
    return event.systemPromptOptions;
  };
  return { ctx, handlers, commands, notices, messages, statuses, start, command, prompt };
}

test("missing state defaults to Hyperion; names are case-insensitive", () => {
  const { store } = fixture();
  assert.equal(store.load().name, "Hyperion");
  assert.deepEqual(store.list(), ["Hyperion", "Themis"]);
  assert.equal(store.resolve("tHeMiS").name, "Themis");
});

test("startup clears the old footer label and switching never displays an identity status", async () => {
  const app = harness(fixture().store);
  app.start();
  await app.command("themis");
  assert.deepEqual(app.statuses, [["agent-identity", undefined]]);
  assert.match(app.messages.at(-1).content, /Agent: Themis/);
});

test("selection persists across store instances with private file permissions", () => {
  const { agentsDir, stateFile, store } = fixture();
  store.save(store.resolve("themis"));
  assert.equal(new IdentityStore(agentsDir, stateFile).load().name, "Themis");
  assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), { agent: "Themis" });
  assert.equal(statSync(stateFile).mode & 0o777, 0o600);
});

test("invalid names, traversal, empty files, and corrupt state are explicit errors", () => {
  const { agentsDir, stateFile, store } = fixture();
  for (const name of ["missing", "../Themis", "/tmp/Themis", "themis extra"]) {
    assert.throws(() => store.resolve(name));
  }
  writeFileSync(join(agentsDir, "Empty.md"), " \n");
  assert.throws(() => store.resolve("empty"), /empty/i);
  mkdirSync(join(stateFile, ".."));
  for (const value of ["{", "null", '{"agent":3}', '{"agent":"missing"}']) {
    writeFileSync(stateFile, value);
    assert.throws(() => store.load());
  }
});

test("switch replaces the identity section without changing unrelated instructions", async () => {
  const { store } = fixture();
  const app = harness(store);
  app.start();
  const sections = { safety: "Never push main.", agent_identity: "old identity" };
  assert.match(app.prompt("BB instructions", sections).sections.agent_identity, /Hyperion/);
  await app.command("themis");
  const next = app.prompt("BB instructions", sections);
  assert.equal(next.appendSystemPrompt, "BB instructions");
  assert.equal(next.sections.safety, "Never push main.");
  assert.match(next.sections.agent_identity, /Themis/);
  assert.doesNotMatch(next.sections.agent_identity, /Hyperion|old identity/);
  assert.match(app.messages.at(-1).content, /Themis/);
});

test("future sessions use global selection; other running sessions stay unchanged", async () => {
  const { store } = fixture();
  const a = harness(store);
  const b = harness(store);
  a.start();
  b.start();
  await a.command("themis");
  assert.match(a.prompt().sections.agent_identity, /Themis/);
  assert.match(b.prompt().sections.agent_identity, /Hyperion/);
  const future = harness(store);
  future.start();
  assert.match(future.prompt().sections.agent_identity, /Themis/);
  // Reload/session replacement intentionally adopts the latest global selection.
  b.start();
  assert.match(b.prompt().sections.agent_identity, /Themis/);
});

test("picker selects an agent; cancellation leaves selection and state alone", async () => {
  const { store } = fixture();
  const app = harness(store);
  app.start();
  await app.command("");
  assert.equal(store.load().name, "Hyperion");
  app.ctx.ui.select = async (_title, options) => {
    assert.deepEqual(options, ["Hyperion", "Themis"]);
    return "Themis";
  };
  await app.command("");
  assert.equal(store.load().name, "Themis");
});

test("busy, invalid, and non-UI commands do not change state", async () => {
  const { store } = fixture();
  const app = harness(store);
  app.start();
  await app.command("missing");
  assert.equal(store.load().name, "Hyperion");
  assert.match(app.notices.at(-1)!, /unknown/i);
  app.ctx.isIdle = () => false;
  await app.command("themis");
  assert.equal(store.load().name, "Hyperion");
  assert.match(app.notices.at(-1)!, /idle|finish/i);
  app.ctx.isIdle = () => true;
  app.ctx.hasUI = false;
  await app.command("");
  assert.equal(store.load().name, "Hyperion");
  assert.match(app.notices.at(-1)!, /agent <name>/i);
});

test("failed persistence keeps the current session identity intact", async () => {
  const { stateFile, store } = fixture();
  const app = harness(store);
  app.start();
  writeFileSync(join(stateFile, ".."), "not a directory");
  await app.command("themis");
  assert.match(app.prompt().sections.agent_identity, /Hyperion/);
  assert.doesNotMatch(app.messages.at(-1).content, /saved globally/);
  assert.ok(app.notices.length > 0);
});

test("legacy alias/BB injection is removed while surrounding instructions survive", async () => {
  const { store } = fixture();
  const app = harness(store);
  app.start();
  await app.command("themis");
  const legacy = "Before\n# Hyperion\nYou are Hyperion.\nAfter";
  const result = app.prompt(legacy);
  assert.equal(result.appendSystemPrompt, "Before\n\nAfter");
  assert.match(result.sections.agent_identity, /Themis/);
  assert.doesNotMatch(result.appendSystemPrompt, /Hyperion/);
  assert.equal(app.prompt(result.appendSystemPrompt, result.sections).sections.agent_identity,
    result.sections.agent_identity);
});

test("corrupt startup state is visible in BB and repairable with /agent", async () => {
  const { stateFile, store } = fixture();
  mkdirSync(join(stateFile, ".."));
  writeFileSync(stateFile, "{");
  const app = harness(store);
  app.start();
  assert.match(app.messages.at(-1).content, /could not load/);
  assert.throws(() => app.prompt(), /unavailable/);
  await app.command("themis");
  assert.match(app.prompt().sections.agent_identity, /Themis/);
});

test("a run starting while the picker is open prevents a mid-turn switch", async () => {
  const { store } = fixture();
  const app = harness(store);
  app.start();
  app.ctx.ui.select = async () => {
    app.ctx.isIdle = () => false;
    return "Themis";
  };
  await app.command("");
  assert.equal(store.load().name, "Hyperion");
  assert.match(app.messages.at(-1).content, /finish/);
});

test("argument completion lists matching identities", () => {
  const app = harness(fixture().store);
  const options = app.commands.get("agent").getArgumentCompletions("th");
  assert.deepEqual(options, [{ value: "Themis", label: "Themis" }]);
});
