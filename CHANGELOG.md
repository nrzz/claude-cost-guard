# Changelog

All notable changes to Claude cost guard are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [1.0.1] - 2026-10-04

- Renamed the plugin, because Anthropic's plugin directory already has a plugin called cost-guard: it is `spendcap` now. If you installed it as `cost-guard`, uninstall that and install `spendcap`; your budgets are unchanged. `init`, `status` and `uninstall` still recognise the old name from this tool's own marketplaces, and a cost-guard plugin from anywhere else is no longer mistaken for this one.
- An icon for the plugin's listing in Anthropic's plugin directory, the listing's links in `plugin.json`, and a Privacy section in the README.
- README: corrections from an audit of every claim against the code, and Node 18 in CI.

## [1.0.0] - 2026-10-04

- First release: daily and weekly budgets in dollars or fresh tokens, zero-token warnings at 50%, 80% and 100%, hard mode, an incremental index under a time budget, report, today and statusline; a plugin.
- Hard mode never blocks slash commands or `!` shell commands; drive-letter project paths work on macOS and Linux (caught by CI).

[1.0.1]: https://github.com/nrzz/claude-cost-guard/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/nrzz/claude-cost-guard/releases/tag/v1.0.0
