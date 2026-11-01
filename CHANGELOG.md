# Changelog

All notable changes to this module are documented in this file. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the module uses [Semantic Versioning](https://semver.org/): a change
to the notification contract in the README is a breaking change and
raises the major version.

## Unreleased

### Added

- `CONTRIBUTING.md` with the rules for issues and pull requests.
- A sponsor link on GitHub and a support section in the README.

## 1.0.0 - 2026-10-31

First version.

### Added

- One WebSocket connection to Home Assistant, opened by the `node_helper`
  from the server-side config read with `getServerModuleConfig()`.
- Validation of the options `host`, `token` and `readings`, with one log
  line per wrong option and without the token.
- `HOME_ASSISTANT_READING` for every configured reading: at start, on
  every change in Home Assistant, and as unavailable for an unknown
  entity or after 30 s without connection.
- `HOME_ASSISTANT_READING_REQUEST` for displays that need a reading
  again later.
- `HOME_ASSISTANT_CONNECTION` with the connection state.
- Reconnect with exponential backoff, a ping every 30 s and a 10 s limit
  for the authentication; a rejected token stops the module until
  MagicMirror² restarts.
