# CLAUDE.md

## What this is

A MagicMirror² module without display (`MMM-HomeAssistantDataProvider`).
Its `node_helper` holds one WebSocket connection to Home Assistant; the
browser side publishes entity states as notifications for display modules
such as MMM-RingGauge. Users clone it into `MagicMirror/modules/`.

The design and the open questions are in `README.md`. Resolve an open
question there before implementing the part it concerns.

## Rules

- This module owns the notification contract. Document every field in
  the README; a change to the contract is a breaking change for displays.
- Publish facts only, as the README's contract lists them. Never a level
  or an assessment: thresholds belong to the display.
- Never publish an entity ID or the whole `attributes` object: either
  couples displays to Home Assistant.
- Publish readings under the configured neutral names, never require a
  display to know entity IDs.
- Read host, port, TLS, token and the readings only from the
  server-side config with `getServerModuleConfig()`, never from a socket
  message. MagicMirror restores `SECRET_*` placeholders in every socket
  message, so a host from the browser lets anyone who can open the mirror
  send the token to their own server.
- Treat every socket message from the browser as untrusted. It may at most
  ask for the current state, optionally by a reading name that the
  server-side config lists; never by entity ID, or anyone could read
  arbitrary Home Assistant states.
- One instance per mirror: `getServerModuleConfig()` finds only the first
  instance of a module.
- Keep the token in the `node_helper`; never send it back to the
  browser or log it.
- Use the report time from Home Assistant (`last_reported`), not the
  time of receipt: displays decide staleness from it.
- Send an unavailable reading explicitly; do not stay silent. A
  connection lost for longer than the grace period makes every reading
  unavailable; do not rely on displays checking staleness.
- Reconnect with backoff and resubscribe; never let a connection error
  escape as an unhandled rejection, it would stop the MagicMirror server.
- A reloaded browser registers the module again; the helper must not open
  a second connection for it.
- No display: `getDom()` returns an empty element.
- Requires MagicMirror 2.38: `getServerModuleConfig()` does not exist
  before. If it is missing, log an error and stay idle; never fall back to
  the config from the browser.

## Build, lint, test

No bundler and no dependencies: MagicMirror loads the files as they are,
and users install by `git clone` only.

- Use Node's built-in `WebSocket`; do not add a WebSocket package.
- Syntax check: `git ls-files '*.js' | xargs -n1 node --check`
- Lint: `pnpm dlx @biomejs/biome@2.6.3 ci .` – Biome runs standalone and
  needs no entry in `package.json`. Keep its version the same in the
  `$schema` of `biome.json`, in the workflow and here.
- Tests: `node --test "tests/**/*.test.js"`. Do not add Vitest, Jest or
  ESLint: they need dependencies and a lockfile.
- Test the connection handling against a fake Home Assistant WebSocket
  server in the test, not against a real instance.
- Keep the workflow on the action and Node versions the MagicMirror²
  module list checks (`actions/checkout@v7`, `actions/setup-node@v7`,
  Node 22).

## Host pitfalls

- MagicMirror replaces `${VAR}` in `config.js` textually: unquoted, a
  value keeps its type; quoted, it is a string ("false" is truthy). Do
  not convert strings; a quoted boolean or number is a user error.
- `SECRET_*` variables reach the browser only as placeholders and are
  restored in payloads to the `node_helper`.
- In Docker, `homeassistant.local` does not resolve.

## Open

- **Open:** subscription that also delivers unchanged reports
  (`last_reported`); see README, "Connection".
