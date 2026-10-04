# Claude Code cost guard

[![test](https://github.com/nrzz/claude-cost-guard/actions/workflows/test.yml/badge.svg)](https://github.com/nrzz/claude-cost-guard/actions/workflows/test.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![node >= 18](https://img.shields.io/badge/node-%3E%3D18-339933.svg) ![dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen.svg) [![part of the Claude Code toolkit](https://img.shields.io/badge/Claude%20Code-toolkit-d97757.svg)](https://github.com/nrzz/claude-code-toolkit)

Daily and weekly budgets for Claude Code, counted from the transcripts on your machine: a warning line at 50%, 80% and 100%, and an optional hard stop that holds new prompts once the budget is used. Everything stays local, and none of it costs a token.

## What it costs in tokens

Nothing. Every part runs outside the model:

| Part | Tokens | |
| --- | --- | --- |
| The hook that checks your budget before each prompt | 0 | A separate process. It prints nothing below 50%. Above that it prints one `systemMessage` line, which is shown to you and never sent to the model |
| A prompt that hard mode stops | 0 | The prompt is not sent, so the model never sees it |
| Reading and indexing your transcripts | 0 | Local files, no model involved |
| Skills, MCP servers, `CLAUDE.md` or any other context | 0 | None are added. The whole plugin is one hook |
| `claude-cost-guard ...` in a terminal | 0 | |

## Install

With npm (Node 18 or newer), from any folder:

```bash
npx -y github:nrzz/claude-cost-guard init
npx -y github:nrzz/claude-cost-guard budget set --daily 15usd --weekly 80usd
```

`init` copies the guard to `~/.claude/cost-guard/app/`, adds one `UserPromptSubmit` hook to `~/.claude/settings.json` (after a timestamped backup, and only that one entry), and indexes the transcripts you already have. Start a new Claude Code session so it picks the hook up. From then on `node ~/.claude/cost-guard/app/bin/claude-cost-guard.mjs <command>` runs the command line without npx. The hook is started as `node`, so Node 18 or newer has to be on the `PATH` that Claude Code runs with. If you keep Claude Code's config somewhere else, set `CLAUDE_CONFIG_DIR`; everything follows it.

As a Claude Code plugin, in Claude Code:

```text
/plugin marketplace add nrzz/claude-cost-guard
/plugin install cost-guard@claude-cost-guard
```

The plugin brings the hook only. Set budgets with the `npx` command above, which works the same whichever way the hook was installed. Use one route, not both: with both, every prompt is checked twice (`claude-cost-guard status` warns when it sees that).

To remove it: `claude-cost-guard uninstall` takes out exactly the hook entry and the copy that `init` added and keeps your budgets and index (`--purge` deletes those too), and `/plugin uninstall cost-guard@claude-cost-guard` removes the plugin.

## Use

```text
claude-cost-guard today                    cost and tokens today, by project and model, against your budgets
claude-cost-guard report [--days 7] [--by day|week|project|model|session] [--json]
claude-cost-guard statusline               one line for a status line
claude-cost-guard budget set|show|clear|extend ...
claude-cost-guard status                   what is installed, and where you stand
claude-cost-guard init | uninstall
```

Example output, from the made-up transcripts the tests use:

```text
$ claude-cost-guard report
Claude Code usage 2026-10-01 to 2026-10-07 (7 days), by day

Day         Reqs  Input  Output  Cache wr  Cache rd  Fresh    Cost
----------  ----  -----  ------  --------  --------  -----  ------
2026-10-01     0      0       0         0         0      0   $0.00
2026-10-02     0      0       0         0         0      0   $0.00
2026-10-03     0      0       0         0         0      0   $0.00
2026-10-04     1    10k      4k       10k      100k    24k   $0.47
2026-10-05     1    20k      2k         0         0    22k   $0.15
2026-10-06     1      0     10k       50k      500k    60k   $0.70
2026-10-07     4  1.65M    360k      700k     13.1M  2.71M   $9.52
----------  ----  -----  ------  --------  --------  -----  ------
Total          7  1.68M    376k      760k     13.7M  2.82M  $10.84

Most expensive sessions
   Cost  Fresh  Project  Last   Session
  -----  -----  -------  -----  ----------------------------------
  $6.72  1.17M  alpha    10-07  Fix login redirect loop (00000001)
  $3.50   1.6M  beta     10-07  Refactor billing (00000002)
  $0.61    46k  alpha    10-05  (untitled) (00000003)

Fresh = input + output + cache writes. Cache reads are cheap and listed apart.
Output includes 20k thinking tokens.
Subagents account for $0.22 of the cost.
Dollars are API list prices. On a subscription plan nothing is billed per token: read them as how fast limits fill.

$ claude-cost-guard statusline
today $9.52/$15 · week $10.37/$80
```

`report --by session` lists the 20 most expensive sessions with their titles, and `--json` prints the same numbers as data: only numbers, model ids, the folder names of projects (never a project's full path) and session titles, never a prompt or an answer.

What the hook shows in Claude Code, under your prompt:

```text
Cost guard: today $12.10 of $15 (81%) · this week $48 of $80
```

And in hard mode, once a budget is used, the prompt is not sent and you see this instead:

```text
Cost guard: today's budget of $15 is used ($15.40). Raise it with: claude-cost-guard budget extend 5usd, or set CLAUDE_COST_GUARD_OFF=1.
```

To show the budget in your status line, make `statusLine` in `settings.json` run `node "<config>/cost-guard/app/bin/claude-cost-guard.mjs" statusline`, or call that from a status line script you already have and append what it prints. Claude Code pipes its JSON to the command, and the folder in it picks the project budget that applies.

## Budgets

```bash
claude-cost-guard budget set --daily 15usd --weekly 80usd          # all projects, soft mode
claude-cost-guard budget set --daily 3M                            # tokens instead of dollars
claude-cost-guard budget set --daily 5usd --project . --mode hard  # one project (this folder and anything inside it)
claude-cost-guard budget extend 5usd                               # raise today's limits by $5, until midnight
claude-cost-guard budget show
claude-cost-guard budget clear [--project <dir> | --all] [--daily] [--weekly]
```

- **Amounts.** `15usd` or `'$15'` for dollars at API list prices, `3M` or `500k` for tokens. A bare `$15` is expanded by bash, zsh and PowerShell before the tool sees it, so quote it or write `15usd`; a bare number is refused because it could be either. The tokens are fresh tokens (see below).
- **Scope.** `--all` (the default) covers every project. `--project <dir>` covers sessions that ran in that folder or inside it. Both can exist at once, and a prompt is checked against every budget that applies to the folder it is typed in.
- **Soft mode** (the default) warns. Each of 50%, 80% and 100% is announced once per limit per day, as one line, and nothing is said below 50%. A day starts at local midnight and a week on Monday.
- **Hard mode** (`--mode hard`) warns the same way and, once a budget is used (100% or more), stops every new prompt with the message above until the day ends, the week rolls over, or you raise the limit. Slash commands (`/compact`, `/clear`, `/model` and the rest) and `!` shell commands still run, because they are how you get back under a budget. Prompts that a person did not type (scheduled and loop wakeups, SDK and system prompts) are never stopped and trigger no warning, although what they spend is counted like any other usage.
- **Extending** adds the amount to every limit of the same kind, daily and weekly, for today only, so a binding weekly cap does not keep a prompt blocked after you asked for more. Tomorrow the limits are back. `--project` or `--all` limits it to one budget.
- **Switching it off** for one Claude Code session: start it with `CLAUDE_COST_GUARD_OFF=1`.
- **What a budget file looks like.** `~/.claude/cost-guard/budgets.json`, plain JSON you can read and edit.

## How it counts

- **Where the numbers come from.** The transcripts under `~/.claude/projects`: the main session files and the subagent files, which cost money too and are counted under their parent session. Nothing is sent anywhere. The transcripts have to be read to find the usage records, but the tool keeps and prints only numbers, ids, model names, folders and session titles, never what was said.
- **One request, once.** Claude Code writes a record per content block, so a single request appears several times. A request is counted once (by `requestId`, else the message id), and its largest numbers win, because the early records of a streamed request carry usage that is not final yet. When a request lists `iterations`, those are summed instead of the top level.
- **Fresh tokens** are input + output + cache writes. Cache reads are cheap, so they are reported apart and do not count toward a token budget. Thinking tokens are part of output (`report` says how many there were).
- **Dollars** are API list prices (`src/prices.mjs`, prices on 2026-10-01, with cache writes priced by their lifetime: 5 minutes or 1 hour). A model that is not in the table is priced like the default one and `report` names it. Subscription plans are not billed per token, so on a plan the dollars are a yardstick for how fast limits fill, not a bill. Surcharges that depend on how a request was made (a faster or priority tier, long-context pricing) are not modelled.
- **Days and weeks** follow your local time zone: a request belongs to the local day it happened on, a week runs Monday to Sunday, and weeks in `report` are ISO weeks.
- **Projects** are the folder a session started in, shown by name. Two folders with the same name are told apart by their parent.
- **Titles** are the name you gave a session with `/rename`, else the one Claude Code generated.
- **What it does not see.** Other machines, claude.ai chats, and API use outside Claude Code. It also counts what is in the transcripts when you press enter, so the answer you are about to get is counted at your next prompt.
- **Old and deleted transcripts.** Individual requests are kept for 35 days. Older days stay as daily totals for two years, so `report --days 90` works once the tool has been running that long; it starts from the transcripts that exist when it first runs. When a transcript is deleted, what it held leaves the index too, so the index always matches what is on disk, except that spending older than 20 days stays (Claude Code removes old transcripts itself, after 30 days by default, and that money was spent).

## How it works

- `init` writes three things: a copy of the guard in `~/.claude/cost-guard/app/` (so the hook keeps working when npx forgets its cache), one hook entry in `settings.json`, and the index. The entry runs `node <that copy>/guard.mjs prompt` with no shell, so a path with spaces is fine.
- The hook gets the prompt's JSON on stdin, reads only the new bytes of the transcripts (below), adds up today and this week, compares them with the budgets that apply and prints at most one JSON line (one message line in it for each budget that crossed a threshold). With no budget for the folder it does nothing at all. It never throws and never blocks a session because of its own problem: any failure ends with exit code 0 and no output, and the reason goes to `~/.claude/cost-guard/errors.log`, which is kept under 64 KB.
- The index (`~/.claude/cost-guard/index.json`) remembers, for each transcript, its size, modification time and how far it has been read. Later runs read only what was appended, wait for a half-written last line, and read a file again from the start when it shrank or its first bytes changed. Requests are stored by id with the files that hold them, so a deleted or rewritten transcript takes its requests out and a forked session's copied history is counted once.
- A run has a time budget (250 ms in the hook, `CLAUDE_COST_GUARD_BUDGET_MS` changes it). It reads the newest files first, remembers where it stopped and continues on the next prompt, so a first run over a large history does not hold a prompt up. Files touched in the last two days are checked every run, and the rest in rotation, so a run does not stat thousands of old files.
- A lock keeps two runs from writing the index at once. The decision about what to announce is made under that lock, so two Claude Code windows prompting at the same moment announce a threshold once. A run that cannot get the lock within a moment judges from the index as it is: it still enforces a hard stop, and leaves warnings for the next prompt.
- What was announced today is in `~/.claude/cost-guard/state.json`. Setting, extending or clearing a budget counts what the command just showed you as announced.

## What was verified, and how

Checked on 2026-10-04 on Windows 11 with Node 24 and the transcript format of Claude Code 2.1.286, with synthetic transcripts only (the build never read a real one):

- **184 automated tests** (`npm test`, which also lists the two helper files under `test/`, so its summary shows two more). Hand-computed numbers: a reference data set of seven requests across five models, two projects, three sessions, a subagent file and a local midnight, with the dollars worked out by hand from the price table, per day, week, project, model and session. Counting: requests repeated across records and streamed with partial usage, `iterations`, 5-minute and 1-hour cache writes, thinking tokens, synthetic models. Incremental indexing gives the same totals as a full rescan after appends, a half-written last line, a truncated or rewritten file, new files, deleted files, forked copies and a time budget that stops partway. The hook is checked at 49%, 50%, 80% and 100%, once per day, in hard mode, with automated prompts, slash and `!` commands (never stopped), hostile input, a corrupt index, a held lock and two simultaneous prompts. Also: amounts, budget scopes and extensions, local days and weeks in ten time zones across daylight-saving changes and unusual offsets, `init` and `uninstall` as an exact round trip with backups, and `report`, `today` and `statusline` output.
- **A randomized check.** Thirty seeded random sets of transcripts (repeated and partial records, `iterations`, forks, subagents, requests that straddle midnight) are fed to the indexer in random byte-sized slices, mid-line and mid-character included, with random time budgets and chunk sizes. The result has to equal both an independent oracle and a fresh full scan. Breaking the merging, timestamp or subagent rules on purpose makes it fail.
- **The hook as Claude Code runs it.** Tests start it as a separate process with the `command` and `args` from `settings.json` (also from a config folder with spaces in its name), JSON on stdin, and check exit code 0, an empty stderr, and that stdout is empty or one line holding only a `systemMessage` or a block.
- **Speed**, on generated transcripts of about 50 MB, measured on this machine over six sessions of the speed test (nothing else running). With large tool results (44 files, 3,300 requests) a full index takes 0.17 to 0.25 s; with many small records (222 files, 17,000 requests), 0.35 to 0.55 s. A run with nothing new takes 5 to 8 ms (19 to 30 ms on the larger set), and a run that reads one new request 7 to 11 ms (29 to 45 ms). The whole hook as a process, Node's own start-up included, takes about 75 to 110 ms on the first set and about 110 to 145 ms on the second (medians of nine runs), against a target of about 150 ms. The tests assert only loose limits so that a slow CI machine does not fail them; the figures above are what they print.
- **The plugin.** `claude plugin validate .claude-plugin/plugin.json` and `claude plugin validate .` (the marketplace) both pass with Claude Code 2.1.286 and 2.1.289, and on 2026-10-04 the plugin installed from GitHub with `/plugin marketplace add nrzz/claude-cost-guard` and `/plugin install cost-guard@claude-cost-guard`. That command checks the manifests; it does not read `hooks/hooks.json`, whose shape comes from the documented hook format and is checked by a test.
- **Nothing outside the config folder.** Every test ran against a temporary config folder and a temporary home, and one test checks that a full run of every command leaves nothing else behind.

Not verified: a live Claude Code session. The build did not run one, so the hook has not been seen firing inside the application; the [toolkit's end-to-end test](https://github.com/nrzz/claude-code-toolkit#tested-together) runs it the way Claude Code does, on Windows, macOS and Linux. CI runs every test on Windows, macOS and Linux with Node 20, 22 and 24 and on Linux with Node 18, all green; its first run caught a path bug that Windows alone could not show (a drive-letter project path read as relative on macOS and Linux), fixed since. After your first `init`, set a low budget with `--mode hard`, send a prompt, and the stop message confirms the hook end to end.

## Files

| Path | What it is |
| --- | --- |
| `guard.mjs` | The hook: reads the prompt's JSON on stdin, prints nothing or one line |
| `src/` | The index, the aggregation, the budgets, the hook logic, the reports, the installer and the command line (Node 18+, no dependencies) |
| `bin/claude-cost-guard.mjs` | The command line |
| `hooks/hooks.json` | The plugin's hook: `UserPromptSubmit`, `node ${CLAUDE_PLUGIN_ROOT}/guard.mjs prompt` |
| `.claude-plugin/` | The plugin manifest and the marketplace that lists `cost-guard` |
| `test/` | `npm test`: tests, a generator of synthetic transcripts, and a 50 MB speed test |

After `init`, `~/.claude/cost-guard/` holds `app/` (the copy the hook runs) and `index.json` (token counts, ids, session titles and the folders sessions ran in; no prompt, answer or tool output). `budgets.json` appears when you set a budget, `state.json` once a threshold has been announced or a budget changed, and `errors.log` only if something went wrong.

Related: [claude-code-handover](https://github.com/nrzz/claude-code-handover) keeps your sessions short with a handover file, [claude-code-team-sync](https://github.com/nrzz/claude-code-team-sync) shares sessions and context with your coworkers, and [claude-code-glow](https://github.com/nrzz/claude-code-glow) themes the interface and shows token tips in the status line.

## Contributing

Issues and pull requests are welcome: start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [good first issues](https://github.com/nrzz/claude-cost-guard/issues?q=is%3Aopen+label%3A%22good+first+issue%22). Questions go to [Discussions](https://github.com/nrzz/claude-cost-guard/discussions); security reports go through [SECURITY.md](SECURITY.md).

## Part of the Claude Code toolkit

Small, dependency-free tools that make Claude Code cheaper, safer and easier to share, all in the [Claude Code toolkit](https://github.com/nrzz/claude-code-toolkit):

- [claude-code-handover](https://github.com/nrzz/claude-code-handover): short sessions with a handover file every new session loads by itself
- [claude-code-team-sync](https://github.com/nrzz/claude-code-team-sync): share sessions, notes and team context with coworkers
- [claude-code-glow](https://github.com/nrzz/claude-code-glow): themes for the whole interface, a status line and a live HUD
- [claude-code-guardrails](https://github.com/nrzz/claude-code-guardrails): safety presets that stop risky commands and edits
- [claude-code-notify](https://github.com/nrzz/claude-code-notify): a ping when Claude needs you or finishes
- [claude-md-doctor](https://github.com/nrzz/claude-md-doctor): what your CLAUDE.md costs every session, and how to slim it
- [claude-code-starter-kits](https://github.com/nrzz/claude-code-starter-kits): a lean, safe .claude/ for your stack in one command
- [claude-session-replay](https://github.com/nrzz/claude-session-replay): search past sessions and export one as an HTML replay

Set up any of them, or all of them, from one page: `npx -y github:nrzz/claude-code-toolkit` opens it with the recommended tools switched on.

## License

MIT
