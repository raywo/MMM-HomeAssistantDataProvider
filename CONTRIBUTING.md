# Contributing

Thanks for helping. Bug reports, questions and pull requests are welcome
as [issues](https://github.com/raywo/MMM-HomeAssistantDataProvider/issues)
and pull requests on GitHub.

## Reporting a bug

- Name your MagicMirror² and Home Assistant versions.
- Add the lines of the MagicMirror² log that start with
  `MMM-HomeAssistantDataProvider`.
- Never post your token. Replace it, and any address you do not want to
  share, before you paste config or log lines.

## Pull requests

- Open an issue first for anything larger than a small fix, so that we
  can agree on the approach before you write the code.
- Run the checks from [Development](README.md#development) before you
  open the pull request; the workflow runs the same checks.
- Add or change tests in `tests/` for every change of behavior. Test the
  connection against the fake Home Assistant in
  `tests/support/fake-home-assistant.js`, not against a real instance.
- Add an entry to [CHANGELOG.md](CHANGELOG.md).

## Rules that keep the module installable

- Add no dependencies, and no `package-lock.json`. Users install the
  module with `git clone` only, without `npm install`.
- Use Node's built-in APIs, e.g. its `WebSocket`, instead of a package.
- Keep `getDom()` empty: the module has no display of its own.

## The notification contract

Display modules rely on the contract in the
[README](README.md#for-display-authors).

- A change to a notification name or a field is a breaking change and
  raises the major version. Discuss it in an issue first.
- Document every field you add in the README.
- Publish facts only: no levels, thresholds or assessments, no entity
  IDs and no `attributes` object. Those belong to the display.
- Never send the token to the browser or write it to the log.
