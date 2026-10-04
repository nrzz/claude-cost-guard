// init / uninstall / status. Everything lives under Claude Code's config folder ($CLAUDE_CONFIG_DIR or ~/.claude):
//   <configDir>/cost-guard/app/     our copy of guard.mjs, bin/, src/ and package.json (the hook runs from here,
//                                   so it keeps working when npx forgets its cache)
//   <configDir>/cost-guard/         the index, budgets.json, state.json, errors.log (made when they are first needed)
//   <configDir>/settings.json       only our own UserPromptSubmit hook entry is touched, after a timestamped backup
// Nothing outside those paths is ever written or deleted.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { entriesOf, fmtAmount, loadBudgets } from "./budgets.mjs";
import { refresh } from "./index.mjs";
import { buildCells, sumCells } from "./usage.mjs";
import {
  ROOT, VERSION, appDir, configDir, dayKeyOf, errorsLog, fmtMoney, fmtTokens, forwardSlashes, guardDir, indexFile, logError,
  projectsDir, settingsFile, stripBom, timestamp, uniquePath, weekStartDay, writeFileAtomic,
} from "./util.mjs";

const EVENT = "UserPromptSubmit";
const consoleIO = { out: (s = "") => process.stdout.write(`${s}\n`), err: (s = "") => process.stderr.write(`${s}\n`) };

function samePath(a, b) {
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return path.resolve(a) === path.resolve(b); }
}

/** The settings.json entry that runs our installed copy. Exec form (no shell), so a path with spaces is safe. */
export const hookEntryFor = (cfg) => ({
  type: "command", command: "node", args: [forwardSlashes(path.join(appDir(cfg), "guard.mjs")), "prompt"], timeout: 10,
});

/** True for a hook that runs a cost-guard copy: recognised by its script path, in either slash style. */
export function isOurHook(h) {
  if (!h || typeof h !== "object") return false;
  const text = [h.command, ...(Array.isArray(h.args) ? h.args : [])].filter((x) => typeof x === "string").join(" ").replace(/\\/g, "/");
  return /\/cost-guard\/app\/guard\.mjs/.test(text);
}

/**
 * Read settings.json without ever modifying it.
 * status: "missing" | "ok" (a plain object; an empty file counts as {}) | "invalid" (not JSON, or hooks in a shape we will not touch)
 */
export function readSettings(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return e && e.code === "ENOENT" ? { status: "missing", data: {}, raw: null } : { status: "invalid", data: null, raw: null };
  }
  const text = stripBom(raw);
  if (!text.trim()) return { status: "ok", data: {}, raw };
  try {
    const data = JSON.parse(text);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const h = data.hooks;
      const hooksOk = h === undefined || (h && typeof h === "object" && !Array.isArray(h) && (h[EVENT] === undefined || Array.isArray(h[EVENT])));
      if (hooksOk) return { status: "ok", data, raw };
    }
  } catch { /* falls through to invalid */ }
  return { status: "invalid", data: null, raw };
}

const writeSettings = (file, data) => writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
function backupSettings(file) {
  const backup = uniquePath(`${file}.bak-cost-guard-${timestamp()}`);
  fs.copyFileSync(file, backup);
  return backup;
}

/** settings with our hook in place: replaced where it already was, dropped where it was repeated, appended when new. */
export function mergeHook(settings, entry) {
  const next = structuredClone(settings);
  if (!next.hooks) next.hooks = {};
  const groups = Array.isArray(next.hooks[EVENT]) ? next.hooks[EVENT] : [];
  let placed = false;
  const out = [];
  for (const g of groups) {
    if (!g || typeof g !== "object" || !Array.isArray(g.hooks)) { out.push(g); continue; }
    const hooks = [];
    for (const h of g.hooks) {
      if (!isOurHook(h)) { hooks.push(h); continue; }
      if (!placed) { hooks.push(entry); placed = true; }
    }
    if (hooks.length || g.hooks.length === 0) out.push({ ...g, hooks });
  }
  if (!placed) out.push({ hooks: [entry] });
  next.hooks[EVENT] = out;
  return { settings: next, changed: JSON.stringify(next) !== JSON.stringify(settings) };
}

/** settings without any hook of ours; a group or the hooks key that this leaves empty is removed too. */
export function removeHook(settings) {
  const next = structuredClone(settings);
  const groups = next.hooks && Array.isArray(next.hooks[EVENT]) ? next.hooks[EVENT] : null;
  if (!groups) return { settings: next, removed: 0 };
  let removed = 0;
  const out = [];
  for (const g of groups) {
    if (!g || typeof g !== "object" || !Array.isArray(g.hooks)) { out.push(g); continue; }
    const hooks = g.hooks.filter((h) => { if (isOurHook(h)) { removed++; return false; } return true; });
    if (hooks.length || g.hooks.length === 0) out.push({ ...g, hooks });
  }
  if (removed) {
    if (out.length) next.hooks[EVENT] = out; else delete next.hooks[EVENT];
    if (!Object.keys(next.hooks).length) delete next.hooks;
  }
  return { settings: next, removed };
}

/**
 * This tool's plugins that settings.json enables (the plugin brings its own copy of the hook): spendcap from any
 * marketplace, or its name until 1.0.1, cost-guard, from this tool's own marketplaces (a cost-guard from elsewhere is
 * somebody else's plugin).
 */
export const enabledPlugins = (data) => Object.entries((data && data.enabledPlugins) || {})
  .filter(([k, v]) => v && (/^spendcap@/.test(k) || /^cost-guard@(claude-cost-guard|claude-code-toolkit)$/.test(k)))
  .map(([k]) => k);

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) copyDir(src, dst);
    else if (e.isFile()) fs.copyFileSync(src, dst);
  }
}
function prune(from, to) { // whatever is in `to` and no longer in `from` (a file an older version had)
  for (const e of fs.readdirSync(to, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (!fs.existsSync(src)) fs.rmSync(dst, { recursive: true, force: true });
    else if (e.isDirectory()) prune(src, dst);
  }
}
function copyApp(cfg) {
  const dest = appDir(cfg);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(ROOT, "guard.mjs"), path.join(dest, "guard.mjs"));
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(dest, "package.json"));
  for (const sub of ["bin", "src"]) { copyDir(path.join(ROOT, sub), path.join(dest, sub)); prune(path.join(ROOT, sub), path.join(dest, sub)); }
}

const snippet = (cfg) => JSON.stringify({ hooks: { [EVENT]: [{ hooks: [hookEntryFor(cfg)] }] } }, null, 2).split("\n").map((l) => `      ${l}`).join("\n");

/** claude-cost-guard init. Returns the exit code: 0 done, 1 settings.json could not be updated. */
export function init(opts = {}, io = consoleIO) {
  const env = opts.env || process.env;
  const cfg = configDir(env);
  if (opts.scope && opts.scope !== "user") { io.err(`Only --scope user is supported (the hook goes into ${settingsFile(cfg)}).`); return 1; }
  const file = settingsFile(cfg);
  const settings = readSettings(file);
  const entry = hookEntryFor(cfg);

  io.out("claude-cost-guard init");
  io.out(`  config folder  ${cfg}`);
  if (samePath(ROOT, appDir(cfg))) {
    io.out("  - running from the installed copy; not copying files onto themselves");
  } else {
    copyApp(cfg);
    io.out(`  copied guard.mjs, bin/ and src/ into ${appDir(cfg)}`);
  }

  let code = 0;
  if (settings.status === "invalid") {
    io.err("");
    io.err(`  settings.json could not be updated: ${file} is not valid JSON (or has a "hooks" value of an unexpected kind), so I left it untouched.`);
    io.err("  Fix the file, or add this by hand under the top-level \"hooks\" key, then run init again:");
    io.err("");
    io.err(snippet(cfg));
    code = 1;
  } else {
    const merged = mergeHook(settings.data, entry);
    if (!merged.changed) {
      io.out(`  settings.json already runs the guard (${EVENT})`);
    } else {
      if (settings.status === "ok" && settings.raw !== null) {
        const backup = backupSettings(file);
        io.out(`  backed up settings.json to ${backup}`);
      }
      fs.mkdirSync(cfg, { recursive: true });
      writeSettings(file, merged.settings);
      io.out(`  settings.json: ${EVENT} hook added (other settings untouched)`);
    }
    const plugins = enabledPlugins(settings.data);
    if (plugins.length) io.out(`  ! the plugin ${plugins[0]} is enabled as well and runs the same hook: use one of the two (uninstall one) or each prompt is checked twice`);
  }

  // The hook is only useful when it can be started: run the installed copy once.
  const probe = spawnSync(process.execPath, [path.join(appDir(cfg), "guard.mjs"), "version"], { encoding: "utf8", timeout: 10000, windowsHide: true, env: { ...env } });
  if (probe.status === 0 && probe.stdout.trim()) io.out(`  checked: the installed guard runs (version ${probe.stdout.trim()})`);
  else io.out(`  ! the installed guard did not start cleanly${probe.error ? `: ${probe.error.message}` : ""}`);

  // Index what is there now, so the first prompt after a budget is set has nothing to catch up on.
  try {
    const { idx, stats } = refresh(cfg, { full: true, budgetMs: 30000, lockWaitMs: 5000 });
    if (stats.missingRoot) io.out(`  no transcripts yet under ${projectsDir(cfg)}; they are read as they appear`);
    else io.out(`  indexed ${Object.keys(idx.requests).length} requests from ${Object.keys(idx.files).length} transcripts${stats.pending ? " (more are read as you work)" : ""}`);
  } catch (e) {
    logError(cfg, e);
    io.out(`  ! indexing failed (${e.message}); it is retried whenever the guard runs`);
  }

  io.out("");
  if (code === 0) {
    io.out("Next, set a budget (dollars at API list prices, or tokens):");
    io.out("  claude-cost-guard budget set --daily 15usd --weekly 80usd");
    io.out("Without npm, from any folder:");
    io.out(`  node "${forwardSlashes(path.join(appDir(cfg), "bin", "claude-cost-guard.mjs"))}" budget show`);
    io.out("Start a new Claude Code session (or run /hooks) so it picks the hook up.");
  }
  return code;
}

/** claude-cost-guard uninstall: take our hook out of settings.json and delete our copy. Returns 0, or 1 when settings.json is unreadable (nothing changes). */
export function uninstall(opts = {}, io = consoleIO) {
  const env = opts.env || process.env;
  const cfg = configDir(env);
  const file = settingsFile(cfg);
  const settings = readSettings(file);
  if (settings.status === "invalid") {
    io.err(`${file} is not valid JSON (or has a "hooks" value of an unexpected kind), so nothing was changed.`);
    io.err(`Remove the ${EVENT} entry that runs cost-guard/app/guard.mjs by hand, then run uninstall again.`);
    return 1;
  }
  io.out("claude-cost-guard uninstall");
  io.out(`  config folder  ${cfg}`);
  let did = 0;
  if (settings.status === "ok") {
    const r = removeHook(settings.data);
    if (r.removed) {
      const backup = backupSettings(file);
      writeSettings(file, r.settings);
      io.out(`  backed up settings.json to ${backup}`);
      io.out(`  removed ${r.removed} ${EVENT} hook${r.removed === 1 ? "" : "s"} from settings.json (other settings untouched)`);
      did++;
    }
  }
  if (fs.existsSync(appDir(cfg))) {
    fs.rmSync(appDir(cfg), { recursive: true, force: true });
    io.out(`  removed ${appDir(cfg)}`);
    did++;
  }
  if (opts.purge && fs.existsSync(guardDir(cfg))) {
    fs.rmSync(guardDir(cfg), { recursive: true, force: true });
    io.out(`  removed ${guardDir(cfg)} (the index, budgets and state)`);
    did++;
  } else if (fs.existsSync(guardDir(cfg))) {
    io.out(`  kept ${guardDir(cfg)} (your budgets and the index); add --purge to delete it too`);
  }
  if (!did) io.out("  nothing to remove: claude-cost-guard is not installed here.");
  const plugins = enabledPlugins(settings.data);
  if (plugins.length) io.out(`  ! the plugin ${plugins[0]} is still enabled; remove it with /plugin uninstall`);
  return 0;
}

const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  if (!ms) return "never";
  if (m < 1) return "just now";
  if (m < 90) return `${m} min ago`;
  return m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

/** claude-cost-guard status: what is installed, the budgets, and where you stand. Returns 0. */
export function status(opts = {}, io = consoleIO) {
  const env = opts.env || process.env;
  const cfg = configDir(env);
  const now = opts.now ?? Date.now();
  const settings = readSettings(settingsFile(cfg));
  io.out(`claude-cost-guard ${VERSION}`);
  io.out(`  config folder  ${cfg}`);
  if (settings.status === "invalid") {
    io.out("  hook           settings.json is not valid JSON, so I cannot tell");
  } else {
    const groups = (settings.data.hooks && settings.data.hooks[EVENT]) || [];
    const ours = groups.flatMap((g) => (g && Array.isArray(g.hooks) ? g.hooks : [])).filter(isOurHook);
    if (ours.length) io.out(`  hook           ${EVENT} runs ${ours[0].args && ours[0].args[0]}${ours.length > 1 ? `  (! ${ours.length} entries: run init to dedupe)` : ""}`);
    else io.out("  hook           not in settings.json (claude-cost-guard init adds it)");
    const plugins = enabledPlugins(settings.data);
    if (plugins.length) io.out(`  plugin         ${plugins.join(", ")} is enabled${ours.length ? "  (! the hook then runs twice; keep one)" : ""}`);
  }
  const budgets = loadBudgets(cfg);
  if (budgets.invalid) io.out("  budgets        budgets.json is not valid JSON: no budget is in force until it is fixed");
  const entries = entriesOf(budgets);
  if (!entries.length) io.out("  budgets        none (claude-cost-guard budget set --daily 15usd)");
  for (const e of entries) {
    const parts = [e.daily && `daily ${fmtAmount(e.daily)}`, e.weekly && `weekly ${fmtAmount(e.weekly)}`].filter(Boolean);
    io.out(`  budget         ${e.label.padEnd(16)} ${parts.join(", ")} (${e.mode})`);
  }
  const { idx, stats } = refresh(cfg, { now, full: true, lockWaitMs: 5000 });
  io.out(`  index          ${Object.keys(idx.requests).length} requests from ${Object.keys(idx.files).length} transcripts, updated ${ago(idx.updatedAt)}${stats.pending ? `, ${stats.pending} transcripts still to read` : ""}`);
  if (fs.existsSync(indexFile(cfg)) || stats.missingRoot === false) {
    const today = dayKeyOf(now);
    const cells = buildCells(idx, { fromDay: weekStartDay(today), toDay: today });
    const d = sumCells(cells.filter((c) => c.day === today));
    const w = sumCells(cells);
    io.out(`  today          ${fmtMoney(d.cost)} · ${fmtTokens(d.fresh)} fresh tokens`);
    io.out(`  this week      ${fmtMoney(w.cost)} · ${fmtTokens(w.fresh)} fresh tokens`);
  }
  let errorLines = 0;
  try { errorLines = fs.readFileSync(errorsLog(cfg), "utf8").split("\n").filter(Boolean).length; } catch { /* no log: no errors */ }
  io.out(`  errors         ${errorLines ? `${errorLines} line${errorLines === 1 ? "" : "s"} in ${errorsLog(cfg)}` : "none"}`);
  return 0;
}
