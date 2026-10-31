import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IdentityStore } from "./store.ts";
import type { Identity } from "./store.ts";

export function registerIdentity(pi: ExtensionAPI, store: IdentityStore): void {
  let active: Identity | undefined;
  const feedback = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error") => {
    ctx.ui.notify(text, level);
    // BB ignores fire-and-forget Pi notifications/status; keep feedback visible there too.
    pi.sendMessage({ customType: "agent-identity", content: text, display: true },
      { triggerTurn: false });
  };

  pi.on("session_start", (_event, ctx) => {
    // Read once per session/runtime, not per prompt: other running agents stay put.
    active = undefined;
    try {
      active = store.load();
    } catch (error) {
      feedback(ctx, `Identity could not load: ${String(error)}. Use /agent <name> to repair it.`, "error");
    }
    // Clear a footer label left by the earlier version when extensions reload.
    ctx.ui.setStatus("agent-identity", undefined);
  });

  pi.on("before_agent_start", (event) => {
    if (!active) throw new Error("Agent identity unavailable. Select one with /agent <name>.");
    const options = event.systemPromptOptions;
    options.appendSystemPrompt = store.stripLegacyIdentity(options.appendSystemPrompt);
    // One owned section is replaced, preserving Pi, BB, safety, skills, and project context.
    options.sections.agent_identity = active.content;
  });

  pi.registerCommand("agent", {
    description: "Choose the global agent identity for this session and future Pi sessions",
    getArgumentCompletions(prefix) {
      return store.list()
        .filter((name) => name.toLowerCase().startsWith(prefix.toLowerCase()))
        .map((name) => ({ value: name, label: name }));
    },
    async handler(args, ctx) {
      if (!ctx.isIdle()) {
        feedback(ctx, "Let the current turn finish before switching agents.", "warning");
        return;
      }
      try {
        let name = args.trim();
        if (!name) {
          if (!ctx.hasUI) {
            feedback(ctx, "Use /agent <name> to choose a global identity.", "info");
            return;
          }
          const choice = await ctx.ui.select(
            `Agent identity (current: ${active?.name ?? "unavailable"})`, store.list(),
          );
          if (!choice) return;
          name = choice;
        }
        // A picker can remain open while another input starts a run.
        if (!ctx.isIdle()) {
          feedback(ctx, "Let the current turn finish before switching agents.", "warning");
          return;
        }
        const next = store.resolve(name);
        store.save(next);
        active = next;
        feedback(ctx,
          `Agent: ${next.name}. Active here and saved globally for future Pi sessions. ` +
          "Other running sessions are unchanged. Existing conversation history remains.", "info");
      } catch (error) {
        feedback(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}

export default function identityExtension(pi: ExtensionAPI): void {
  registerIdentity(pi, new IdentityStore(
    fileURLToPath(new URL("./agents/", import.meta.url)),
    join(homedir(), ".config", "agents", "pi-identity.json"),
  ));
}
