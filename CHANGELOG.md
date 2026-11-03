# Changelog

All notable changes to Claude cost guard are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

- `budget set --model` and `budget show` suggest the closest model when a name matches nothing in your history: `opuss` gives `Did you mean "opus"?`. It compares the name with each model id and each `-`-separated word of it (words of at least 4 characters) and suggests one only when it is within 2 edits, so `xyz` gets no suggestion and the note reads as before. Nothing else changes: a name that matches prints no note, the hook is untouched, and the exit code stays 0.

## [1.3.0] - 2026-11-03

- `budget show` notes each saved model budget whose name matches no model in your history, with the models it has seen, so a budget saved with a typo before 1.2.0 no longer reads as a working limit at 0%. One note per name, after the budget lines; nothing when the name matches, for budgets with no model, or with no sessions yet. Nothing is changed or deleted, the exit code stays 0, and `budget set` shares the same words through one helper.
- Contributed by [@nightlab-agent](https://github.com/nightlab-agent) in [#8](https://github.com/nrzz/claude-cost-guard/pull/8), for the good first issue [#7](https://github.com/nrzz/claude-cost-guard/issues/7). The pull request's tests ran on Windows, macOS and Linux with Node 18 to 24 before the merge. The issue's second case, a model that dropped out of the 35 days the index keeps, needs no note: the list of models seen only grows, so a budget for a model you once used keeps matching.

## [1.2.0] - 2026-11-03

- `budget set --model <name>` notes when the name matches no model in your history, and lists the models it has seen, so a typo such as `--model opuss` no longer saves a budget that silently never applies. The budget is still saved; with no sessions yet, it says the name could not be checked. A name that matches prints nothing extra, the note comes before the usage line, and the hook is unchanged.
- Contributed by [@nightlab-agent](https://github.com/nightlab-agent) in [#6](https://github.com/nrzz/claude-cost-guard/pull/6), for the good first issue [#5](https://github.com/nrzz/claude-cost-guard/issues/5). The pull request's tests ran on Windows, macOS and Linux with Node 18 to 24 before the merge.

## [1.1.0] - 2026-10-28

- `budget set --daily 10usd --model opus` sets a budget for one model: `--model <name>` is a case-insensitive part of the model id in the transcript (`opus`, `sonnet`, `claude-opus-5-5`), alone or with `--project <dir>`. It sits next to the all-projects and project budgets, all of which apply; the first limit a prompt reaches speaks, and a hard-mode block names the model and suggests `budget extend <amount> --model <name>`. `budget clear` and `budget extend` take `--model` too, and `show`, `today` and `statusline` list the model budgets with the others.
- Contributed by [@yoreva-01](https://github.com/yoreva-01) in [#4](https://github.com/nrzz/claude-cost-guard/pull/4), for the good first issue [#3](https://github.com/nrzz/claude-cost-guard/issues/3).
- README: Spendcap is in Anthropic's plugin directory (published 14 October 2026); the install line from there, `/plugin install spendcap@anthropic-plugin-directory`, verified with Claude Code 2.1.295 in a throwaway config. The toolkit list names claude-chat-ferry, and ends with a line about stars and following.

## [1.0.1] - 2026-10-04

- Renamed the plugin, because Anthropic's plugin directory already has a plugin called cost-guard: it is `spendcap` now. If you installed it as `cost-guard`, uninstall that and install `spendcap`; your budgets are unchanged. `init`, `status` and `uninstall` still recognise the old name from this tool's own marketplaces, and a cost-guard plugin from anywhere else is no longer mistaken for this one.
- An icon for the plugin's listing in Anthropic's plugin directory, the listing's links in `plugin.json`, and a Privacy section in the README.
- README: corrections from an audit of every claim against the code, and Node 18 in CI.

## [1.0.0] - 2026-10-04

- First release: daily and weekly budgets in dollars or fresh tokens, zero-token warnings at 50%, 80% and 100%, hard mode, an incremental index under a time budget, report, today and statusline; a plugin.
- Hard mode never blocks slash commands or `!` shell commands; drive-letter project paths work on macOS and Linux (caught by CI).

[1.3.0]: https://github.com/nrzz/claude-cost-guard/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/nrzz/claude-cost-guard/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/nrzz/claude-cost-guard/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/nrzz/claude-cost-guard/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/nrzz/claude-cost-guard/releases/tag/v1.0.0
