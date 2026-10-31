import { randomUUID } from "node:crypto";
import {
  mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface Identity {
  name: string;
  content: string;
}

/** The state contains only a name; identity instructions stay in their source files. */
export class IdentityStore {
  readonly agentsDir: string;
  readonly stateFile: string;

  constructor(agentsDir: string, stateFile: string) {
    this.agentsDir = agentsDir;
    this.stateFile = stateFile;
  }

  list(): string[] {
    return readdirSync(this.agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[A-Za-z0-9][A-Za-z0-9_-]*\.md$/.test(entry.name))
      .map((entry) => entry.name.slice(0, -3))
      .sort((a, b) => a.localeCompare(b));
  }

  resolve(input: string): Identity {
    const name = this.list().find((name) => name.toLowerCase() === input.toLowerCase());
    if (!name) throw new Error(`Unknown agent "${input}". Available: ${this.list().join(", ")}.`);
    const content = readFileSync(join(this.agentsDir, `${name}.md`), "utf8").trim();
    if (!content) throw new Error(`Agent ${name} has an empty identity file.`);
    return { name, content };
  }

  load(): Identity {
    let text: string;
    try {
      text = readFileSync(this.stateFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.resolve("Hyperion");
      throw error;
    }
    const state: unknown = JSON.parse(text);
    if (!state || typeof state !== "object" || !("agent" in state) || typeof state.agent !== "string") {
      throw new Error(`Invalid identity selection in ${this.stateFile}. Use /agent <name> to repair it.`);
    }
    return this.resolve(state.agent);
  }

  save(identity: Identity): void {
    mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    // Concurrent Pi processes can safely publish a complete selection; last rename wins.
    const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ agent: identity.name }, null, 2)}\n`, {
      encoding: "utf8", mode: 0o600, flag: "wx",
    });
    renameSync(temporary, this.stateFile);
  }

  stripLegacyIdentity(appendSystemPrompt: string): string {
    let prompt = appendSystemPrompt;
    // hy/themis aliases and cached BB runtimes may still append an identity.
    // Remove only exact known file contents, never unrelated BB/project instructions.
    for (const name of this.list()) {
      const content = readFileSync(join(this.agentsDir, `${name}.md`), "utf8").trim();
      if (content) prompt = prompt.replaceAll(content, "");
    }
    return prompt;
  }
}
