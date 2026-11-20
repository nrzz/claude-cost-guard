# Changelog

All notable changes to Claude cost guard are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

- `budget check --file <path>` checks a `budgets.json` before it is installed — for example the one in a dotfiles repository — instead of the installed file: the same problems in the same order, printed one per line after the count line, and the same exit codes (0 when every setting reads as written, 1 when there is a problem or the file is not valid JSON). `--json` prints `{ ok, file, invalid, problems, budgets }` with `file` set to that path. A missing file is refused (`<path>: no such file.`), `--file` without a value is refused like any other flag missing its value, and `--file` with any budget command other than `check` is refused (`--file works with budget check only.`). Nothing is written and the installed file is not read.
- Contributed by [@danishkumar26](https://github.com/danishkumar26) in [#20](https://github.com/nrzz/claude-cost-guard/pull/20), for the good first issue [#16](https://github.com/nrzz/claude-cost-guard/issues/16).

## [1.5.2] - 2026-11-19

- Each command takes only the words it documents: `budget extend` its one amount, every other command no word after its name or its `budget` subcommand. Any other word stops it with exit code 1 before anything is read or written, naming the word and the command, and suggesting the flag when the word is one of the command's flags without its dashes. `budget clear daily`, `budget clear -1`, `budget clear -` and `budget clear -- -daily` no longer clear both limits, `budget clear --daily weekly` no longer clears the daily limit alone, `budget set --daily 15usd hard` no longer saves a soft budget, `report 30` no longer reports 7 days, and `budget extend 5usd 3usd` no longer drops the second amount. A flag after `--` is a word now, so it stops the command too, and so does a word after `help` or `--help` (`help budget`). `budget extend 1M tokens` is refused as well, with a hint to write the amount as one word.
- Contributed by [@nightlab-agent](https://github.com/nightlab-agent) in [#19](https://github.com/nrzz/claude-cost-guard/pull/19), for the bug [#18](https://github.com/nrzz/claude-cost-guard/issues/18) that nightlab-agent found while fixing #15.

## [1.5.1] - 2026-11-19

- Each command takes only its own flags. Any other flag, a typo or a flag of another command, stops it with exit code 1 before anything is read or written, naming the flag and the command and suggesting the nearest allowed flag within 2 edits. `budget clear --dialy` and `budget clear -daily` no longer clear both limits, `budget set --daily 15usd --mdoe hard` no longer saves a soft budget, and `report --dyas 30` no longer reports 7 days. This includes `help`, `version` and `statusline`. `--help`, `-h`, `--version`, `-v` and `--name=value` work as before; `--version` after a command, and `--help` beside a flag the command does not take, now name the flag instead.
- Contributed by [@nightlab-agent](https://github.com/nightlab-agent) in [#17](https://github.com/nrzz/claude-cost-guard/pull/17), for the bug [#15](https://github.com/nrzz/claude-cost-guard/issues/15) that nightlab-agent reported.

## [1.5.0] - 2026-11-19

- `budget check` reads `budgets.json` the way the hook does, names each setting that cannot be read as written under a count line, and exits 1 when there is one or the file is not valid JSON, 0 when every setting reads. A missing file is not a mistake (exit 0). `--json` prints `{ ok, file, invalid, problems, budgets }` (`file` is the full path, `budgets` the number in force) with the same exit codes, so a script or a dotfiles repository can check the file before using it. Nothing is written, the usage index is not read, and the hook is untouched.
- Contributed by [@Aaqibhafeezkhan](https://github.com/Aaqibhafeezkhan) in [#14](https://github.com/nrzz/claude-cost-guard/pull/14), for the good first issue [#12](https://github.com/nrzz/claude-cost-guard/issues/12).

## [1.4.0] - 2026-11-19

- `budget set --model` and `budget show` suggest the closest model when a name matches nothing in your history: `opuss` gives `Did you mean "opus"?`. It compares the name with each model id and each `-`-separated word of it (words of at least 4 characters) and suggests one only when it is within 2 edits, so `xyz` gets no suggestion and the note reads as before. Nothing else changes: a name that matches prints no note, the hook is untouched, and the exit code stays 0.
- Contributed by [@matheussilvano](https://github.com/matheussilvano) in [#10](https://github.com/nrzz/claude-cost-guard/pull/10), for the good first issue [#9](https://github.com/nrzz/claude-cost-guard/issues/9). The pull request's tests ran on Windows, macOS and Linux with Node 18 to 24 before the merge.
- A hand-edited `budgets.json` is read as you meant it where that is beyond doubt: an amount written as text (`"6"`), a mode or unit in capitals (`"Hard"`, `"USD"`). Before, either edit turned a hard stop off without a word: the limit was dropped, or the budget was read as soft.
- Every setting that still cannot be read is named, with what follows from it (a limit not in force, a budget read as soft, a key cost guard does not read, such as `"dialy"`, a project with no folder): `budget show` lists each one; the hook says so once a day in a line shown to you, never to the model, with the day's warnings or on its own when no budget is left in force (a block is still said alone, and the note waits for the next prompt); `budget set`, `clear` and `extend` say the file was saved without them. The hook now also says once a day when the file is not valid JSON, which before it never did. Keys that start with `_`, `$` or `//` are notes and are left alone.
- Reported by [@nightlab-agent](https://github.com/nightlab-agent) in [#11](https://github.com/nrzz/claude-cost-guard/issues/11), with the exact commands and the lines at fault.

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

[1.5.2]: https://github.com/nrzz/claude-cost-guard/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/nrzz/claude-cost-guard/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/nrzz/claude-cost-guard/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/nrzz/claude-cost-guard/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/nrzz/claude-cost-guard/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/nrzz/claude-cost-guard/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/nrzz/claude-cost-guard/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/nrzz/claude-cost-guard/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/nrzz/claude-cost-guard/releases/tag/v1.0.0
