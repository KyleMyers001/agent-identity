# Agent Identity

A personal Pi extension for BB and terminal Pi. One persistent global identity,
with no project or session overrides. Requires Pi 1.4+ and Node 24+.

## Use

- `/agent` opens the identity picker in Pi or BB.
- `/agent themis` or `/agent hyperion` switches directly, case-insensitively.
- Terminal argument completion lists the available identities.

Bundled identities live in [`agents/`](agents/): **Argus, Hyperion, Prometheus,
Themis, and Vulcan**. The extension resolves them relative to its own module;
`~/Agents` is not required. Edit or add a Markdown file in `agents/`, then select
it with `/agent` (or restart Pi to refresh an already-active identity).

A successful switch updates the current session's next run and atomically saves
only the selected name in `~/.config/agents/pi-identity.json`. New/restarted Pi
sessions load that selection in any project. Hyperion is the default when no
selection has been saved. Other running sessions keep their identity. Reloading
extensions or replacing/resuming a session adopts the current global selection.
Switching requires an idle agent. No persistent footer label is displayed.

The active file occupies one `agent_identity` prompt section. Switching replaces
that section rather than accumulating personas. Pi, BB, safety, project, and
skill instructions remain intact. Exact known identity text appended by old
`hy`/`themis` aliases or cached BB launch arguments is stripped from the addendum,
so the global selection wins over those legacy flags. Use `/agent`, not an alias,
to choose an identity.

Conversation history is not erased; use a fresh thread for clean separation.
Malformed state and missing/empty identity files are reported, not silently
replaced with a different persona. `/agent <name>` can repair the selection.
Switch feedback is recorded as a visible custom message because BB ignores Pi's
fire-and-forget status and notification methods.

## Install locally

Clone this repository to a permanent directory, then use Pi's package installer:

```sh
git clone https://github.com/KyleMyers001/agent-identity.git ~/Development/agent-identity
pi install ~/Development/agent-identity
```

Alternatively, link the checkout into Pi's user extensions directory, only when
that target does not already exist:

```sh
ln -s "$HOME/Development/agent-identity" \
  "$HOME/.pi/agent/extensions/agent-identity"
```

Choose **one** install method to avoid loading the extension twice. Start a fresh
Pi session or run `/reload` in terminal Pi. BB may need its cached provider
runtime recreated; restart BB if a fresh thread lacks `/agent`.

No BB plugin is required. Clear any old global/project `BB_PI_BRIDGE_ARGS`
identity overrides separately; installation does not alter BB configuration.
The exact-content legacy filter handles still-cached launch arguments during
this transition. Existing selection state stays outside the checkout, so changing
the extension's location does not reset the selected identity.

## Voice and privacy

The identities contain personality instructions and, for Hyperion and Themis,
references to optional **machine-local** voice configuration. They do not contain
voice IDs, credentials, or the voice helpers themselves. Speech still requires
explicit activation through the referenced skills. Do not commit voice config,
credentials, Pi authentication, or selection/runtime files to this repository.

## Verify

```sh
npm ci --ignore-scripts
npm run verify
```

Tests cover persistence, single-section prompt replacement, legacy deduplication,
independent running sessions, cancellation, busy/error paths, footer suppression,
and completions. A real-Pi RPC test runs with an isolated home directory and no
`~/Agents`, using the bundled identities and only a loopback fake model endpoint.
It verifies command discovery, picker requests, restart persistence, and the
actual system prompt. It does not read personal credentials or contact an
external model service.

The SDK is a development/peer dependency only; runtime code uses Node built-ins.
This repository is a source backup; it does not back up machine-local selection,
BB settings, voice configuration, or credentials. Nothing is published to npm.
