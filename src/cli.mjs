// The command line: report, today, statusline, budget, init, uninstall, status.
// `main(argv, ctx)` returns the exit code and prints through ctx.io, so tests can call it in-process.
import fs from "node:fs";
import path from "node:path";
import {
  applicable, clearBudget, entriesOf, evaluate, extendBudget, fmtAmount, limitKeys, loadBudgets, parseAmount, saveBudgets, setBudget,
} from "./budgets.mjs";
import { syncMarks } from "./hook.mjs";
import { RETAIN_DAYS, refresh } from "./index.mjs";
import { init, status, uninstall, readSettings, isOurHook, enabledPlugins } from "./install.mjs";
import { jsonRow, jsonTotals, reportText, slotText, statuslineText, todayText } from "./report.mjs";
import { buildCells, groupCells, rangeFor, sumCells, unpricedModels } from "./usage.mjs";
import {
  UserError, VERSION, budgetsFile, configDir, dayKeyOf, fmtMoney, fmtTokens, logError, normPath, parseArgs, projectsDir, readStdinSync,
  settingsFile, weekStartDay,
} from "./util.mjs";

const BOOLEAN_FLAGS = ["json", "all", "help", "version", "purge", "hard", "soft", "daily-only", "weekly-only"];
const BY = ["day", "week", "project", "model", "session"];
const SESSION_ROWS = 20;

const HELP = `claude-cost-guard ${VERSION}: daily and weekly token budgets for Claude Code, from your local transcripts.

Set up
  claude-cost-guard init [--scope user]    add the guard hook to <config>/settings.json (backup first)
  claude-cost-guard uninstall [--purge]    remove exactly what init added (--purge also deletes budgets and index)
  claude-cost-guard status                 what is installed, the budgets, where you stand

Budgets (dollars at API list prices, or fresh tokens: input + output + cache writes)
  claude-cost-guard budget set --daily <amount> [--weekly <amount>] [--project <dir> | --all] [--mode soft|hard]
  claude-cost-guard budget show
  claude-cost-guard budget clear [--project <dir> | --all] [--daily] [--weekly]
  claude-cost-guard budget extend <amount> [--project <dir> | --all]     raises today's limits; gone at midnight
  amounts: 15usd or '$15' (quote it: shells expand $15), 3M or 500k tokens
  soft (default) warns at 50%, 80% and 100%; hard also blocks new prompts at 100%

Look
  claude-cost-guard today
  claude-cost-guard report [--days 7] [--by day|week|project|model|session] [--json]
  claude-cost-guard statusline             one line for a status line: today $4.20/$15 · week $31/$80

Environment: CLAUDE_CONFIG_DIR (Claude Code's config folder), CLAUDE_COST_GUARD_OFF=1 (switch the hook off for a session),
CLAUDE_COST_GUARD_BUDGET_MS (how long the hook may read transcripts per prompt, default 250).
https://github.com/nrzz/claude-cost-guard`;

const consoleIO = { out: (s = "") => process.stdout.write(`${s}\n`), err: (s = "") => process.stderr.write(`${s}\n`) };

function stringArg(name, v, example) {
  if (typeof v !== "string") throw new UserError(`${name} needs a value${example ? `, for example ${name} ${example}` : ""}.`);
  return v;
}
function parseDays(v) {
  if (v === undefined) return 7;
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 3650) throw new UserError(`--days takes a whole number from 1 to 3650, not "${v}".`);
  return n;
}
// A drive-letter or UNC path is absolute on every system (budgets.json may be shared between machines);
// path.resolve on macOS and Linux would treat "D:\work" as a relative name.
const isAbsoluteAnywhere = (p) => path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p);
const projectDir = (v, cwd) => {
  const p = stringArg("--project", v, ".");
  return isAbsoluteAnywhere(p) ? p : path.resolve(cwd, p);
};
const scopeKeyOf = (dir) => (dir ? normPath(dir) : "all");

// Bring the index up to date (no time limit) and return it, with a note when someone else held the lock.
function catchUp(ctx, extra = {}) {
  const cfg = configDir(ctx.env);
  const { idx, stats } = refresh(cfg, { now: ctx.now, full: true, lockWaitMs: 15000, ...extra });
  const notes = [];
  if (stats.skipped) notes.push("Another run was updating the index; these numbers may be a moment behind.");
  if (stats.missingRoot) notes.push(`No transcripts folder yet at ${projectsDir(cfg)}.`);
  return { cfg, idx, stats, notes };
}

function weekCells(idx, now) {
  const today = dayKeyOf(now);
  const weekStart = weekStartDay(today);
  return { today, weekStart, cells: buildCells(idx, { fromDay: weekStart, toDay: today }) };
}

// ---------------------------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------------------------

function cmdReport(args, ctx) {
  const by = args.by === undefined ? "day" : args.by;
  if (!BY.includes(by)) throw new UserError(`--by takes one of ${BY.join(", ")}, not "${args.by}".`);
  const days = parseDays(args.days);
  const { idx, stats, notes } = catchUp(ctx);
  const today = dayKeyOf(ctx.now);
  const range = rangeFor(today, days);
  const cells = buildCells(idx, range);
  const total = sumCells(cells);
  const rows = groupCells(cells, by, { idx, ...range });
  const sessionRows = by === "session" ? rows : groupCells(cells, "session", { idx });
  const top = sessionRows.filter((r) => r.key).slice(0, 5);

  if (total.th) notes.push(`Output includes ${fmtTokens(total.th)} thinking tokens.`);
  if (total.agentCost) notes.push(`Subagents account for ${fmtMoney(total.agentCost)} of the cost.`);
  const unpriced = unpricedModels(cells);
  if (unpriced.length) notes.push(`Not in the price table, so priced like the default model: ${unpriced.join(", ")}.`);
  const firstDay = firstIndexedDay(idx);
  if (days > RETAIN_DAYS && (!firstDay || range.fromDay < firstDay)) {
    notes.push(`Nothing is indexed before ${firstDay || "today"}: requests are kept for ${RETAIN_DAYS} days and older days only as daily totals, from when this tool first saw them.`);
  }
  if (stats.pending) notes.push(`${stats.pending} transcripts are still being read; run this again for the full picture.`);
  notes.push("Dollars are API list prices. On a subscription plan nothing is billed per token: read them as how fast limits fill.");

  if (args.json) {
    ctx.io.out(JSON.stringify({
      tool: "claude-cost-guard", version: VERSION, range: { from: range.fromDay, to: range.toDay, days }, by,
      units: { cost: "usd at API list prices", fresh: "input + output + cache writes (tokens)" },
      rows: rows.map((r) => jsonRow(by, r)),
      total: jsonTotals(total),
      sessions: top.map((r) => jsonRow("session", r)),
      notes,
    }, null, 2));
    return 0;
  }
  const shown = by === "session" ? rows.slice(0, SESSION_ROWS) : rows;
  const rest = by === "session" ? rows.slice(SESSION_ROWS) : [];
  ctx.io.out(reportText({
    by, range, rows: shown, total, sessions: top, notes,
    moreSessions: rest.length ? { count: rest.length, cost: rest.reduce((a, r) => a + r.cost, 0) } : null,
  }));
  return 0;
}

function firstIndexedDay(idx) {
  const days = Object.keys(idx.folded);
  let first = days.length ? days.reduce((m, d) => (d < m ? d : m)) : "";
  let min = Infinity;
  for (const rid of Object.keys(idx.requests)) if (idx.requests[rid][0] < min) min = idx.requests[rid][0];
  if (Number.isFinite(min)) { const d = dayKeyOf(min * 1000); if (!first || d < first) first = d; }
  return first;
}

// ---------------------------------------------------------------------------------------------
// today and statusline
// ---------------------------------------------------------------------------------------------

function cmdToday(args, ctx) {
  const { cfg, idx, notes } = catchUp(ctx);
  const { today, weekStart, cells } = weekCells(idx, ctx.now);
  const todayCells = cells.filter((c) => c.day === today);
  const entries = applicable(loadBudgets(cfg), ctx.cwd);
  ctx.io.out(todayText({
    today, weekStart,
    day: sumCells(todayCells), week: sumCells(cells),
    byProject: groupCells(todayCells, "project", { idx }),
    byModel: groupCells(todayCells, "model", { idx }),
    slots: evaluate(cells, entries, today),
  }));
  for (const n of notes) ctx.io.out(n);
  return 0;
}

function cmdStatusline(args, ctx) {
  // Never fails, never waits: a status line runs often, and an empty line is better than an error.
  try {
    const cfg = configDir(ctx.env);
    let input = {};
    try { input = JSON.parse(ctx.stdin !== undefined ? ctx.stdin : readStdinSync() || "{}") || {}; } catch { input = {}; }
    const cwd = (input.workspace && input.workspace.current_dir) || input.cwd || ctx.cwd;
    const { idx } = refresh(cfg, { now: ctx.now, budgetMs: 100, lockWaitMs: 0, priority: [input.transcript_path] });
    const { today, cells } = weekCells(idx, ctx.now);
    const entries = applicable(loadBudgets(cfg), cwd);
    ctx.io.out(statuslineText({ slots: evaluate(cells, entries, today), day: sumCells(cells.filter((c) => c.day === today)), week: sumCells(cells) }));
  } catch (e) {
    logError(configDir(ctx.env), e);
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// budget
// ---------------------------------------------------------------------------------------------

function hookHint(cfg) {
  const s = readSettings(settingsFile(cfg));
  if (s.status === "invalid") return null;
  const groups = (s.data.hooks && s.data.hooks.UserPromptSubmit) || [];
  const installed = groups.some((g) => g && Array.isArray(g.hooks) && g.hooks.some(isOurHook));
  return installed || enabledPlugins(s.data).length ? null : "The guard is not installed in Claude Code yet: run  claude-cost-guard init  (or install the plugin) and it will speak up there.";
}

function cmdBudget(args, ctx) {
  const sub = args._[0] || "show";
  const cfg = configDir(ctx.env);
  const today = dayKeyOf(ctx.now);
  const b = loadBudgets(cfg);
  if (b.invalid && sub !== "show") throw new UserError(`${budgetsFile(cfg)} is not valid JSON. Fix it, or delete it to start again.`);
  if (args.all && args.project !== undefined) throw new UserError("Use --project <dir> or --all, not both.");
  const dir = args.project === undefined ? null : projectDir(args.project, ctx.cwd);

  if (sub === "set") {
    const daily = args.daily === undefined ? null : parseAmount(stringArg("--daily", args.daily, "15usd"));
    const weekly = args.weekly === undefined ? null : parseAmount(stringArg("--weekly", args.weekly, "80usd"));
    if (!daily && !weekly) throw new UserError("Give a limit: --daily <amount> and/or --weekly <amount>, for example: budget set --daily 15usd --weekly 80usd");
    let mode = args.mode === undefined ? undefined : stringArg("--mode", args.mode, "hard");
    if (args.hard) mode = "hard";
    if (args.soft) mode = "soft";
    if (mode !== undefined && mode !== "soft" && mode !== "hard") throw new UserError(`--mode takes soft or hard, not "${mode}".`);
    const target = setBudget(b, { dir, daily, weekly, mode });
    saveBudgets(cfg, b);
    const label = dir ? path.basename(dir) || dir : "all projects";
    ctx.io.out(`Budget set for ${label}: ${[target.daily && `daily ${fmtAmount(target.daily)}`, target.weekly && `weekly ${fmtAmount(target.weekly)}`].filter(Boolean).join(", ")} (${target.mode}).`);
    if (dir && !fs.existsSync(dir)) ctx.io.out(`Note: ${dir} does not exist on this machine (the budget applies to sessions that ran there).`);
    showUsage(ctx, cfg, b, [scopeKeyOf(dir)]); // also leaves the index warm for the first prompt
    const hint = hookHint(cfg);
    if (hint) ctx.io.out(hint);
    return 0;
  }

  if (sub === "show") {
    if (b.invalid) ctx.io.out(`${budgetsFile(cfg)} is not valid JSON, so no budget is in force. Fix it, or delete it to start again.`);
    const entries = entriesOf(b);
    if (!entries.length) {
      ctx.io.out("No budgets set. For example:  claude-cost-guard budget set --daily 15usd --weekly 80usd");
      return 0;
    }
    ctx.io.out(`Budgets (${budgetsFile(cfg)})`);
    showUsage(ctx, cfg, b, null, { track: false });
    return 0;
  }

  if (sub === "clear") {
    const n = clearBudget(b, { dir, all: !!args.all, daily: !!args.daily, weekly: !!args.weekly });
    if (!n) { ctx.io.out("Nothing to clear."); return 0; }
    saveBudgets(cfg, b);
    syncMarks(cfg, today, [], limitKeys(entriesOf(b))); // forgets the announcements of limits that are gone
    ctx.io.out(`Cleared ${n} limit${n === 1 ? "" : "s"}.`);
    return 0;
  }

  if (sub === "extend") {
    if (args._[1] === undefined) throw new UserError("How much? For example: claude-cost-guard budget extend 5usd   (or 1M tokens)");
    const amount = parseAmount(args._[1]);
    const keys = extendBudget(b, amount, { dir, all: !!args.all }, today);
    if (!keys.length) {
      throw new UserError(entriesOf(b).length
        ? `No budget there is counted in ${amount.unit === "usd" ? "dollars" : "tokens"}, so ${fmtAmount(amount)} cannot be added. Give the amount in the budget's own unit.`
        : "There is no budget to extend. Set one with: claude-cost-guard budget set --daily 15usd");
    }
    saveBudgets(cfg, b);
    ctx.io.out(`Extended ${keys.length} budget${keys.length === 1 ? "" : "s"} by ${fmtAmount(amount)} for today (until midnight).`);
    showUsage(ctx, cfg, b, keys);
    return 0;
  }

  throw new UserError(`Unknown budget command "${sub}". Use set, show, clear or extend.`);
}

// One line per budget: its limits (with today's extension) and how full they are. `only` limits it to some budget keys
// (null: all). Unless told not to, the thresholds already reached count as announced from now on (see syncMarks).
function showUsage(ctx, cfg, b, only, { track = true } = {}) {
  const { idx, notes } = catchUp(ctx);
  const { today, cells } = weekCells(idx, ctx.now);
  const all = evaluate(cells, entriesOf(b), today);
  const entries = entriesOf(b).filter((e) => !only || only.includes(e.key));
  const slots = all.filter((s) => entries.some((e) => e.key === s.scopeKey));
  if (track) syncMarks(cfg, today, slots, all.map((s) => s.key));
  for (const e of entries) {
    const mine = slots.filter((s) => s.scopeKey === e.key);
    const ext = e.ext && e.ext.day === today ? [e.ext.usd && `+${fmtAmount({ unit: "usd", amount: e.ext.usd })}`, e.ext.tokens && `+${fmtAmount({ unit: "tokens", amount: e.ext.tokens })}`].filter(Boolean).join(" ") : "";
    ctx.io.out(`  ${e.label.padEnd(16)} ${mine.map(slotText).join(" · ")}  [${e.mode}${ext ? `, extended ${ext} today` : ""}]${e.dir ? `  ${e.dir}` : ""}`);
  }
  for (const n of notes) ctx.io.out(n);
}

// ---------------------------------------------------------------------------------------------

const COMMANDS = {
  report: cmdReport,
  today: cmdToday,
  statusline: cmdStatusline,
  budget: cmdBudget,
  init: (args, ctx) => init({ env: ctx.env, scope: args.scope }, ctx.io),
  uninstall: (args, ctx) => uninstall({ env: ctx.env, purge: !!args.purge }, ctx.io),
  status: (args, ctx) => status({ env: ctx.env, now: ctx.now }, ctx.io),
};

export async function main(argv, { env = process.env, cwd = process.cwd(), io = consoleIO, now = Date.now(), stdin } = {}) {
  const [name, ...rest] = argv;
  const args = parseArgs(rest, BOOLEAN_FLAGS);
  if (!name || name === "help" || name === "--help" || name === "-h") { io.out(HELP); return 0; }
  if (name === "--version" || name === "version" || name === "-v") { io.out(VERSION); return 0; }
  const command = COMMANDS[name];
  if (!command) { io.err(`Unknown command "${name}".\n`); io.out(HELP); return 1; }
  if (args.help) { io.out(HELP); return 0; }
  try {
    return (await command(args, { env, cwd, io, now, stdin })) ?? 0;
  } catch (e) {
    if (e instanceof UserError) { io.err(e.message); return 1; }
    io.err(`claude-cost-guard: ${(e && e.stack) || e}`);
    return 2;
  }
}
