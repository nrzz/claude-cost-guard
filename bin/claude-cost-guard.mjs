#!/usr/bin/env node
// claude-cost-guard: daily and weekly token budgets for Claude Code, from your local transcripts.
// All the work lives in src/cli.mjs; run `claude-cost-guard --help` for the commands.
import { main } from "../src/cli.mjs";

process.stdout.on("error", () => {}); // `| head` closing the pipe is not worth a stack trace
process.exitCode = await main(process.argv.slice(2));
