// Budgets: parsing amounts, the budgets.json file, which budgets apply where, and how full they are.
//
// A budget has a daily and/or weekly limit in dollars (API list prices) or in fresh tokens (input + output +
// cache writes), a mode (soft: warn; hard: block new prompts at 100%) and an optional extension that is good
// for one day. One budget covers all projects; others cover a project folder and everything inside it.
import fs from "node:fs";
import { sumCells } from "./usage.mjs";
import { budgetsFile, fmtMoney, fmtTokens, folderName, isInside, normPath, stripBom, UserError, writeJsonAtomic } from "./util.mjs";

export const THRESHOLDS = [50, 80, 100];
const NUM = String.raw`(\d[\d,]*(?:\.\d+)?|\.\d+)`;
const USD_RE = new RegExp(`^(?:\\$\\s*${NUM}|${NUM}\\s*(?:usd|dollars?))$`, "i");
const TOKENS_RE = new RegExp(`^${NUM}\\s*([kmb])?\\s*(?:tok|toks|token|tokens)?$`, "i");

/**
 * "$15", "15usd", "$15.50" -> {unit: "usd", amount}; "3M", "500k", "1.5M", "3M tokens" -> {unit: "tokens", amount}.
 * A bare number is refused: it could be either.
 */
export function parseAmount(text) {
  const raw = String(text ?? "").trim();
  const bad = (why) => new UserError(
    `"${raw}" is not an amount${why ? `: ${why}` : ""}. Write dollars as $15 or 15usd and tokens as 3M or 500k.\n`
    + "  A bare $15 is expanded by bash, zsh and PowerShell before this tool sees it, so quote it ('$15') or write 15usd.");
  if (!raw) throw bad("it is empty");
  let amount;
  let unit;
  let m = USD_RE.exec(raw);
  if (m) {
    unit = "usd";
    amount = Number((m[1] ?? m[2]).replace(/,/g, ""));
  } else if ((m = TOKENS_RE.exec(raw)) && (m[2] || /tok/i.test(raw))) {
    unit = "tokens";
    const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase()] || 1;
    amount = Math.round(Number(m[1].replace(/,/g, "")) * mult);
  } else {
    throw bad(/^[\d.,]+$/.test(raw) ? "dollars or tokens?" : "");
  }
  if (!Number.isFinite(amount) || amount <= 0) throw bad("it must be more than 0");
  if (amount > 1e12) throw bad("that is too large");
  return { unit, amount };
}

const wholeNumber = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** $15, $15.50, 3M: a limit. */
export function fmtLimit(unit, amount) {
  if (unit === "tokens") return fmtTokens(amount);
  return Number.isInteger(amount) ? `$${wholeNumber(amount)}` : fmtMoney(amount);
}
/** $15, 3M tokens: an amount on its own. */
export const fmtAmount = (a) => (a.unit === "tokens" ? `${fmtTokens(a.amount)} tokens` : fmtLimit("usd", a.amount));

/** An amount in the form parseAmount reads back and no shell expands: 5usd, 1M. */
export function amountArg(unit, amount) {
  return unit === "tokens" ? fmtTokens(amount) : `${Number(amount.toFixed(2))}usd`;
}
/** About a third of a limit, rounded to a 1, 2 or 5 step: what to suggest as an extension. */
export function niceStep(x) {
  if (!(x > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  const m = x / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

// ---------------------------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------------------------

const validAmount = (a) => a && typeof a === "object" && (a.unit === "usd" || a.unit === "tokens") && Number.isFinite(a.amount) && a.amount > 0
  ? { unit: a.unit, amount: a.amount } : null;
function normalizeScope(s) {
  if (!s || typeof s !== "object") return null;
  const out = {};
  const daily = validAmount(s.daily);
  const weekly = validAmount(s.weekly);
  if (daily) out.daily = daily;
  if (weekly) out.weekly = weekly;
  out.mode = s.mode === "hard" ? "hard" : "soft";
  if (s.ext && typeof s.ext === "object" && typeof s.ext.day === "string") {
    out.ext = { day: s.ext.day, usd: Math.max(0, Number(s.ext.usd) || 0), tokens: Math.max(0, Number(s.ext.tokens) || 0) };
  }
  return out;
}

/** budgets.json as {global, projects, invalid}. A missing file means no budgets; an unreadable one is flagged. */
export function loadBudgets(cfg) {
  const out = { version: 1, global: null, projects: [], invalid: false };
  let text;
  try { text = stripBom(fs.readFileSync(budgetsFile(cfg), "utf8")); } catch { return out; }
  let raw;
  try { raw = JSON.parse(text); } catch { out.invalid = true; return out; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { out.invalid = true; return out; }
  out.global = normalizeScope(raw.global);
  for (const p of Array.isArray(raw.projects) ? raw.projects : []) {
    const s = normalizeScope(p);
    if (s && typeof p.dir === "string" && p.dir) out.projects.push({ dir: p.dir, ...s });
  }
  return out;
}
export function saveBudgets(cfg, b) {
  const { invalid, ...rest } = b;
  writeJsonAtomic(budgetsFile(cfg), rest, 2);
}

/** The budgets as flat entries: {key, label, dir, daily, weekly, mode, ext}. `dir` is null for the one covering all projects. */
export function entriesOf(b) {
  const out = [];
  const pick = (s) => ({ daily: s.daily, weekly: s.weekly, mode: s.mode || "soft", ext: s.ext });
  if (b.global && (b.global.daily || b.global.weekly)) out.push({ key: "all", label: "all projects", dir: null, ...pick(b.global) });
  for (const p of b.projects) if (p.daily || p.weekly) out.push({ key: normPath(p.dir), label: folderName(p.dir), dir: p.dir, ...pick(p) });
  return out;
}
/** The state keys of every limit of these entries ("all|daily", ...): what the announced thresholds are filed under. */
export const limitKeys = (entries) => entries.flatMap((e) => ["daily", "weekly"].filter((p) => e[p]).map((p) => `${e.key}|${p}`));

/** The budgets that count for a prompt typed in `cwd`: the all-projects one, and any project folder that holds `cwd`. */
export const applicable = (b, cwd) => entriesOf(b).filter((e) => !e.dir || isInside(cwd, e.dir));

export function setBudget(b, { dir, daily, weekly, mode }) {
  let target;
  if (dir) {
    const key = normPath(dir);
    target = b.projects.find((p) => normPath(p.dir) === key);
    if (!target) { target = { dir }; b.projects.push(target); }
  } else {
    target = b.global || (b.global = {});
  }
  if (daily) target.daily = daily;
  if (weekly) target.weekly = weekly;
  target.mode = mode || target.mode || "soft";
  return target;
}

function scopeTargets(b, { dir, all }) {
  if (dir) { const key = normPath(dir); return b.projects.filter((p) => normPath(p.dir) === key); }
  if (all) return b.global ? [b.global] : [];
  return [...(b.global ? [b.global] : []), ...b.projects];
}

/** Remove budgets: everything, the all-projects one (`all`), one project (`dir`); or only the `daily` / `weekly` limits of those. Returns how many limits went. */
export function clearBudget(b, { dir, all, daily, weekly }) {
  const targets = scopeTargets(b, { dir, all });
  let removed = 0;
  for (const t of targets) {
    const both = !daily && !weekly;
    if ((both || daily) && t.daily) { delete t.daily; removed++; }
    if ((both || weekly) && t.weekly) { delete t.weekly; removed++; }
    if (!t.daily && !t.weekly) delete t.ext;
  }
  b.projects = b.projects.filter((p) => p.daily || p.weekly);
  if (b.global && !b.global.daily && !b.global.weekly) b.global = null;
  return removed;
}

/** Raise the limits of the matching budgets by `amount` for `today` only. Returns the keys of the budgets that were extended. */
export function extendBudget(b, amount, { dir, all }, today) {
  const key = amount.unit === "usd" ? "usd" : "tokens";
  const keys = [];
  for (const t of scopeTargets(b, { dir, all })) {
    if (![t.daily, t.weekly].some((x) => x && x.unit === amount.unit)) continue;
    const ext = t.ext && t.ext.day === today ? t.ext : { day: today, usd: 0, tokens: 0 };
    ext[key] += amount.amount;
    t.ext = ext;
    keys.push(t.dir ? normPath(t.dir) : "all");
  }
  return keys;
}

// ---------------------------------------------------------------------------------------------
// How full
// ---------------------------------------------------------------------------------------------

/** A limit with today's extension added. */
export function effectiveLimit(entry, period, today) {
  const b = entry[period];
  if (!b) return null;
  const e = entry.ext && entry.ext.day === today ? entry.ext : null;
  const extra = e ? (b.unit === "usd" ? e.usd : e.tokens) || 0 : 0;
  return { unit: b.unit, base: b.amount, extra, limit: b.amount + extra };
}

/**
 * Usage against every limit of the given entries. `cells` must cover this week up to today; the daily
 * figure takes today's cells, the weekly one all of them, and a project budget only the cells of its folder.
 */
export function evaluate(cells, entries, today) {
  const slots = [];
  for (const e of entries) {
    const mine = e.dir ? cells.filter((c) => isInside(c.cwd, e.dir)) : cells;
    for (const period of ["daily", "weekly"]) {
      const lim = effectiveLimit(e, period, today);
      if (!lim) continue;
      const sum = sumCells(period === "daily" ? mine.filter((c) => c.day === today) : mine);
      const used = lim.unit === "usd" ? sum.cost : sum.fresh;
      slots.push({
        key: `${e.key}|${period}`, scopeKey: e.key, scope: e.label, isGlobal: !e.dir, period, unit: lim.unit,
        base: lim.base, extra: lim.extra, limit: lim.limit, used, pct: (used / lim.limit) * 100, mode: e.mode,
      });
    }
  }
  return slots;
}

/** The highest of 50, 80 and 100 that a percentage has reached (0 below 50). */
export function levelOf(pct) {
  let level = 0;
  for (const t of THRESHOLDS) if (pct + 1e-9 >= t) level = t;
  return level;
}
/**
 * A percentage for display: rounded (12.10 of 15 is 81%), but never showing a threshold that has not been
 * reached, so 99.6% reads 99% and a budget is only "100%" once it is used.
 */
export function displayPct(pct) {
  const r = Math.round(pct + 1e-9);
  for (const t of THRESHOLDS) if (r >= t && pct + 1e-9 < t) return t - 1;
  return r;
}
/** True when a limit is used up (a hair of rounding error is forgiven). */
export const isOver = (slot) => slot.used + 1e-9 >= slot.limit;
