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
- Publish facts only: value, unit, quantity, report time, availability.
  Never a level or an assessment: thresholds belong to the display.
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
- Send an unavailable reading explicitly; do not stay silent.
- Reconnect with backoff and resubscribe; never let a connection error
  escape as an unhandled rejection, it would stop the MagicMirror server.
- A reloaded browser registers the module again; the helper must not open
  a second connection for it.
- No display: `getDom()` returns an empty element.

## Host pitfalls

- MagicMirror replaces `${VAR}` in `config.js` textually; values from
  `.env` arrive as strings ("false" is truthy).
- `SECRET_*` variables reach the browser only as placeholders and are
  restored in payloads to the `node_helper`.
- In Docker, `homeassistant.local` does not resolve.

## Open

- **Open:** notification names and payload fields (see README,
  "Contract").
- **Open:** how late displays get the current state (request
  notification vs. republish on start).
- **Open:** WebSocket client: built-in `WebSocket` or `homeassistant-ws`.
- **Open:** subscription that also delivers unchanged reports
  (`last_reported`).
- **Open:** toolchain. Proposed as in WallberryTheme: Biome for linting,
  `node --test` without dependencies, a GitHub workflow for both.
- **Open:** tests for the message handling against a fake Home Assistant
  WebSocket server.
