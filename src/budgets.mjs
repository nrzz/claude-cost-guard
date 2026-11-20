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

/**
 * Match a model pattern (such as a family "opus" or a full name "claude-opus-5-5") against a model id.
 * Case-insensitive substring match: "opus" matches "claude-opus-5-5" and "claude-3-opus-20240229".
 */
export function modelMatches(pattern, model) {
  if (!pattern) return true;
  const p = String(pattern).trim().toLowerCase();
  const m = String(model || "").toLowerCase();
  return m.includes(p);
}

// ---------------------------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------------------------

// The file is plain JSON that a person may edit by hand. Where what they meant is beyond doubt it is read that way (an
// amount written as the text "6", a mode or unit written "Hard" or "USD"), and every setting that still cannot be read
// is named in `problems` ({at, text}), so that nothing a person wrote is dropped or read as soft without a word:
// budget show lists them, and the hook says so once a day. Keys that start with _ or $ or // are notes for a person.
const PLAIN_NUMBER = /^\s*(?:\d+(?:\.\d+)?|\.\d+)\s*$/;
const NOTE_KEY = /^(?:_|\$|\/\/)/;
const SCOPE_KEYS = ["daily", "weekly", "mode", "ext"];
const TOP_KEYS = ["version", "global", "projects", "models"];
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const shown = (v) => {
  const s = JSON.stringify(v);
  if (s === undefined) return String(v);
  return s.length > 40 ? `${s.slice(0, 37)}...` : s;
};

function readLimit(v, at, problems) {
  if (v === undefined || v === null) return null;
  const off = "so that limit is not in force.";
  if (!isObject(v)) { problems.push({ at, text: `${at} is ${shown(v)}, not an object such as {"unit": "usd", "amount": 15}, ${off}` }); return null; }
  if (v.unit === undefined) { problems.push({ at: `${at}.unit`, text: `${at} has no "unit" ("usd" or "tokens"), ${off}` }); return null; }
  const unit = typeof v.unit === "string" ? v.unit.trim().toLowerCase() : v.unit;
  if (unit !== "usd" && unit !== "tokens") { problems.push({ at: `${at}.unit`, text: `${at}.unit is ${shown(v.unit)}, which is neither "usd" nor "tokens", ${off}` }); return null; }
  if (v.amount === undefined) { problems.push({ at: `${at}.amount`, text: `${at} has no "amount", ${off}` }); return null; }
  const amount = typeof v.amount === "string" && PLAIN_NUMBER.test(v.amount) ? Number(v.amount) : v.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    problems.push({ at: `${at}.amount`, text: `${at}.amount is ${shown(v.amount)}, which is not a number above 0, ${off}` });
    return null;
  }
  return { unit, amount };
}

function normalizeScope(s, at, problems, ownKeys = []) {
  const out = {};
  const daily = readLimit(s.daily, `${at}.daily`, problems);
  const weekly = readLimit(s.weekly, `${at}.weekly`, problems);
  if (daily) out.daily = daily;
  if (weekly) out.weekly = weekly;
  const mode = typeof s.mode === "string" ? s.mode.trim().toLowerCase() : s.mode;
  out.mode = mode === "hard" ? "hard" : "soft";
  if (mode !== "hard" && mode !== "soft" && mode !== undefined && mode !== null) {
    problems.push({ at: `${at}.mode`, text: `${at}.mode is ${shown(s.mode)}, which is neither "hard" nor "soft", so the budget is soft.` });
  }
  if (s.ext && typeof s.ext === "object" && typeof s.ext.day === "string") {
    out.ext = { day: s.ext.day, usd: Math.max(0, Number(s.ext.usd) || 0), tokens: Math.max(0, Number(s.ext.tokens) || 0) };
  }
  for (const k of Object.keys(s)) {
    if (!SCOPE_KEYS.includes(k) && !ownKeys.includes(k) && !NOTE_KEY.test(k)) {
      problems.push({ at: `${at}.${k}`, text: `${at} has ${shown(k)}, a setting cost guard does not read, so it does nothing.` });
    }
  }
  return out;
}

// The entries of a "projects" or "models" list: each must be an object with its own key (`dir`, `model`).
function readList(raw, name, need, problems, take) {
  if (raw === undefined || raw === null) return;
  if (!Array.isArray(raw)) { problems.push({ at: name, text: `${name} is ${shown(raw)}, not a list, so ${need.none}.` }); return; }
  raw.forEach((e, i) => {
    const at = `${name}[${i}]`;
    if (!isObject(e)) { problems.push({ at, text: `${at} is ${shown(e)}, not an object, so it is not in force.` }); return; }
    const s = normalizeScope(e, at, problems, need.keys);
    if (!take(e, s)) problems.push({ at: `${at}.${need.keys[0]}`, text: `${at} has no "${need.keys[0]}" (${need.what}), so it is not in force.` });
  });
}

/**
 * budgets.json as {global, projects, models?, invalid, problems}. A missing file means no budgets; one that is not
 * a JSON object is flagged `invalid`; settings that cannot be read are left out and named in `problems`.
 */
export function loadBudgets(cfg) {
  return loadBudgetsFrom(budgetsFile(cfg));
}

/**
 * One budgets file, read exactly as the installed file is read: BOM stripped, JSON parsed, notes left alone, and
 * every setting that cannot be read as written named in `problems` ({at, text}). A missing file means no budgets;
 * one that is not valid JSON is `invalid`. Nothing is written, and the usage index is not read.
 */
export function loadBudgetsFrom(file) {
  const out = { version: 1, global: null, projects: [], invalid: false, problems: [] };
  let text;
  try { text = stripBom(fs.readFileSync(file, "utf8")); } catch { return out; }
  let raw;
  try { raw = JSON.parse(text); } catch { out.invalid = true; return out; }
  if (!isObject(raw)) { out.invalid = true; return out; }
  const problems = out.problems;
  if (isObject(raw.global)) out.global = normalizeScope(raw.global, "global", problems);
  else if (raw.global !== undefined && raw.global !== null) {
    problems.push({ at: "global", text: `global is ${shown(raw.global)}, not an object, so no budget for all projects is in force.` });
  }
  readList(raw.projects, "projects", { keys: ["dir"], what: "the folder it covers", none: "no project budget is in force" }, problems, (p, s) => {
    if (typeof p.dir !== "string" || !p.dir) return false;
    out.projects.push({ dir: p.dir, ...s });
    return true;
  });
  if (Array.isArray(raw.models)) out.models = [];
  readList(raw.models, "models", { keys: ["model", "dir"], what: "the model family or name it covers", none: "no model budget is in force" }, problems, (m, s) => {
    if (typeof m.model !== "string" || !m.model.trim()) return false;
    out.models.push({ model: m.model.trim(), dir: typeof m.dir === "string" ? m.dir : null, ...s });
    return true;
  });
  for (const k of Object.keys(raw)) {
    if (!TOP_KEYS.includes(k) && !NOTE_KEY.test(k)) problems.push({ at: k, text: `the file has ${shown(k)}, a setting cost guard does not read, so it does nothing.` });
  }
  return out;
}

/**
 * The one line the hook says about a budgets file it cannot read as written, or null when there is nothing to say.
 * `file` is the file's path, as budget show names it.
 */
export function fileNotice(b, file) {
  if (b.invalid) return `Cost guard: ${file} is not valid JSON, so no budget is in force. Fix it, or delete it to start again.`;
  const p = b.problems || [];
  if (!p.length) return null;
  if (p.length === 1) return `Cost guard: in budgets.json, ${p[0].text}`;
  const names = p.slice(0, 3).map((x) => x.at).join(", ") + (p.length > 3 ? ` and ${p.length - 3} more` : "");
  return `Cost guard: budgets.json has ${p.length} settings it cannot read as written (${names}). Run  claude-cost-guard budget show  to see each one.`;
}

export function saveBudgets(cfg, b) {
  const { invalid, problems, ...rest } = b;
  if (rest.models && rest.models.length === 0) delete rest.models;
  writeJsonAtomic(budgetsFile(cfg), rest, 2);
}

/** The budgets as flat entries: {key, label, dir, daily, weekly, mode, ext}. `dir` is null for the one covering all projects. */
export function entriesOf(b) {
  const out = [];
  const pick = (s) => ({ daily: s.daily, weekly: s.weekly, mode: s.mode || "soft", ext: s.ext });
  if (b.global && (b.global.daily || b.global.weekly)) out.push({ key: "all", label: "all projects", dir: null, model: null, ...pick(b.global) });
  for (const p of b.projects || []) if (p.daily || p.weekly) out.push({ key: normPath(p.dir), label: folderName(p.dir), dir: p.dir, model: null, ...pick(p) });
  for (const m of b.models || []) {
    if (m.daily || m.weekly) {
      const scopeLabel = m.dir ? `${folderName(m.dir)} (${m.model})` : m.model;
      const key = m.dir ? `${normPath(m.dir)}|model:${m.model.toLowerCase()}` : `model:${m.model.toLowerCase()}`;
      out.push({ key, label: scopeLabel, dir: m.dir || null, model: m.model, ...pick(m) });
    }
  }
  return out;
}
/** The state keys of every limit of these entries ("all|daily", ...): what the announced thresholds are filed under. */
export const limitKeys = (entries) => entries.flatMap((e) => ["daily", "weekly"].filter((p) => e[p]).map((p) => `${e.key}|${p}`));

/** The budgets that count for a prompt typed in `cwd`: the all-projects one, and any project folder that holds `cwd`. */
export const applicable = (b, cwd) => entriesOf(b).filter((e) => !e.dir || isInside(cwd, e.dir));

export function setBudget(b, { dir, model, daily, weekly, mode }) {
  let target;
  if (model) {
    if (!b.models) b.models = [];
    const key = model.toLowerCase();
    const dirKey = dir ? normPath(dir) : null;
    target = b.models.find((m) => m.model.toLowerCase() === key && (dirKey ? normPath(m.dir) === dirKey : !m.dir));
    if (!target) { target = { model, dir: dir || null }; b.models.push(target); }
  } else if (dir) {
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

function scopeTargets(b, { dir, model, all }) {
  if (model) {
    const mKey = model.toLowerCase();
    const dirKey = dir ? normPath(dir) : null;
    return (b.models || []).filter((m) => m.model.toLowerCase() === mKey && (!dir || normPath(m.dir) === dirKey));
  }
  if (dir) { const key = normPath(dir); return b.projects.filter((p) => normPath(p.dir) === key); }
  if (all) return b.global ? [b.global] : [];
  return [...(b.global ? [b.global] : []), ...(b.projects || []), ...(b.models || [])];
}

/** Remove budgets: everything, the all-projects one (`all`), one project (`dir`); or only the `daily` / `weekly` limits of those. Returns how many limits went. */
export function clearBudget(b, { dir, model, all, daily, weekly }) {
  const targets = scopeTargets(b, { dir, model, all });
  let removed = 0;
  for (const t of targets) {
    const both = !daily && !weekly;
    if ((both || daily) && t.daily) { delete t.daily; removed++; }
    if ((both || weekly) && t.weekly) { delete t.weekly; removed++; }
    if (!t.daily && !t.weekly) delete t.ext;
  }
  b.projects = (b.projects || []).filter((p) => p.daily || p.weekly);
  if (b.models) b.models = b.models.filter((m) => m.daily || m.weekly);
  if (b.global && !b.global.daily && !b.global.weekly) b.global = null;
  return removed;
}

/** Raise the limits of the matching budgets by `amount` for `today` only. Returns the keys of the budgets that were extended. */
export function extendBudget(b, amount, { dir, model, all }, today) {
  const key = amount.unit === "usd" ? "usd" : "tokens";
  const keys = [];
  for (const t of scopeTargets(b, { dir, model, all })) {
    if (![t.daily, t.weekly].some((x) => x && x.unit === amount.unit)) continue;
    const ext = t.ext && t.ext.day === today ? t.ext : { day: today, usd: 0, tokens: 0 };
    ext[key] += amount.amount;
    t.ext = ext;
    if (t.model) {
      keys.push(t.dir ? `${normPath(t.dir)}|model:${t.model.toLowerCase()}` : `model:${t.model.toLowerCase()}`);
    } else {
      keys.push(t.dir ? normPath(t.dir) : "all");
    }
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
    let mine = e.dir ? cells.filter((c) => isInside(c.cwd, e.dir)) : cells;
    if (e.model) mine = mine.filter((c) => modelMatches(e.model, c.model));
    for (const period of ["daily", "weekly"]) {
      const lim = effectiveLimit(e, period, today);
      if (!lim) continue;
      const sum = sumCells(period === "daily" ? mine.filter((c) => c.day === today) : mine);
      const used = lim.unit === "usd" ? sum.cost : sum.fresh;
      slots.push({
        key: `${e.key}|${period}`, scopeKey: e.key, scope: e.label, isGlobal: !e.dir && !e.model, isModel: !!e.model, model: e.model || null, period, unit: lim.unit,
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
