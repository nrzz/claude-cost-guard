// Shared helpers: where things live, JSON files, locks, the error log, local dates and number formatting.
// Node built-ins only. Nothing here reads or writes outside the Claude config folder it is given.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";

export class UserError extends Error {}

/** The folder this package runs from: the repo, or the installed copy under <configDir>/cost-guard/app. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version || "1.0.0"; } catch { return "1.0.0"; }
})();

// ---------------------------------------------------------------------------------------------
// Where things live. Everything honors CLAUDE_CONFIG_DIR the way Claude Code does (default ~/.claude).
// ---------------------------------------------------------------------------------------------

export function configDir(env = process.env) {
  const custom = env.CLAUDE_CONFIG_DIR && String(env.CLAUDE_CONFIG_DIR).trim();
  return path.resolve(custom || path.join(os.homedir(), ".claude"));
}
export const guardDir = (cfg) => path.join(cfg, "cost-guard");
export const appDir = (cfg) => path.join(guardDir(cfg), "app");
export const projectsDir = (cfg) => path.join(cfg, "projects");
export const indexFile = (cfg) => path.join(guardDir(cfg), "index.json");
export const budgetsFile = (cfg) => path.join(guardDir(cfg), "budgets.json");
export const stateFile = (cfg) => path.join(guardDir(cfg), "state.json");
export const errorsLog = (cfg) => path.join(guardDir(cfg), "errors.log");
export const lockFile = (cfg) => path.join(guardDir(cfg), "index.lock");
export const settingsFile = (cfg) => path.join(cfg, "settings.json");

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

/** Text without a leading byte order mark. */
export const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** Parsed JSON, or `fallback` when the file is missing or is not valid JSON. */
export function readJson(file, fallback = null) {
  try { return JSON.parse(stripBom(fs.readFileSync(file, "utf8"))); } catch { return fallback; }
}

/**
 * Write through a temp file and rename, so a reader never sees half a file. Falls back to a direct
 * write where rename-over-existing is refused (Windows, destination held open by another process).
 */
export function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}-${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    fs.writeFileSync(file, data);
  }
}
/** Remove temp files (*.tmp) in `dir` that a killed run left behind: older than ten minutes. */
export function cleanTmp(dir, olderThanMs = 10 * 60 * 1000) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".tmp")) continue;
      const p = path.join(dir, name);
      try { if (Date.now() - fs.statSync(p).mtimeMs > olderThanMs) fs.rmSync(p, { force: true }); } catch { /* gone already */ }
    }
  } catch { /* no folder: nothing to clean */ }
}
export function writeJsonAtomic(file, value, space = 0) {
  writeFileAtomic(file, JSON.stringify(value, null, space) + (space ? "\n" : ""));
}

/** All of stdin as text, or "" when it is a terminal. Reads without switching a pipe to non-blocking mode. */
export function readStdinSync() {
  if (isatty(0)) return "";
  const chunks = [];
  const buf = Buffer.alloc(65536);
  const deadline = Date.now() + 3000;
  for (;;) {
    let n;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if (e && e.code === "EAGAIN" && Date.now() < deadline) { sleepSync(10); continue; }
      break;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return stripBom(Buffer.concat(chunks).toString("utf8"));
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

/**
 * A lock file that is created exclusively. A lock older than `staleMs` was left by a run that died
 * and is taken over. With `waitMs` it polls for that long before giving up.
 */
export function takeLock(file, { staleMs = 60000, waitMs = 0 } = {}) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { return false; }
  const deadline = Date.now() + waitMs;
  for (let attempt = 0; attempt < 1000; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx" });
      return true;
    } catch (e) {
      // EPERM and EACCES: Windows reports a lock file that is being deleted this way.
      if (e.code !== "EEXIST" && e.code !== "EPERM" && e.code !== "EACCES") return false;
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > staleMs) { fs.rmSync(file, { force: true }); continue; }
      } catch { /* gone in the meantime: try again */ }
      if (Date.now() >= deadline) return false;
      sleepSync(10);
    }
  }
  return false;
}
export function touchLock(file) {
  try { const t = new Date(); fs.utimesSync(file, t, t); } catch { /* the lock is only advisory */ }
}
export function releaseLock(file) {
  try { fs.rmSync(file, { force: true }); } catch { /* nothing to do */ }
}

/** Append one line to <configDir>/cost-guard/errors.log, which is kept under 64 KB. Never throws. */
export function logError(cfg, message) {
  try {
    const file = errorsLog(cfg);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* first line */ }
    if (size > 64 * 1024) {
      const keep = fs.readFileSync(file, "utf8").slice(-16 * 1024);
      fs.writeFileSync(file, keep.slice(keep.indexOf("\n") + 1));
    }
    const text = String((message && message.stack) || message || "").replace(/\s+/g, " ").slice(0, 600);
    fs.appendFileSync(file, `${new Date().toISOString()} ${text}\n`);
  } catch { /* logging must never fail the work it describes */ }
}

const two = (n) => String(n).padStart(2, "0");
/** 20261003-201530 (local time), used in backup file names. */
export function timestamp(d = new Date()) {
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}
/** A path that does not exist yet: `base`, else `base-1`, `base-2` ... */
export function uniquePath(base) {
  if (!fs.existsSync(base)) return base;
  for (let i = 1; i < 1000; i++) if (!fs.existsSync(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now()}`;
}
export const forwardSlashes = (p) => String(p).replace(/\\/g, "/");

// ---------------------------------------------------------------------------------------------
// Local days and ISO weeks. A "day" is a local calendar date as "YYYY-MM-DD".
// ---------------------------------------------------------------------------------------------

export const dayKeyOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
};
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function parseDay(key) {
  const m = DAY_RE.exec(String(key));
  if (!m) throw new UserError(`"${key}" is not a date like 2026-10-04.`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
/** Local midnight at the start of a day, in ms. */
export const startOfDayMs = (key) => { const [y, m, d] = parseDay(key); return new Date(y, m - 1, d).getTime(); };
/** The day `n` days from `key` (negative for earlier). Computed at noon so daylight saving never skips a date. */
export const addDays = (key, n) => { const [y, m, d] = parseDay(key); return dayKeyOf(new Date(y, m - 1, d + n, 12).getTime()); };
export const daysBetween = (a, b) => {
  const [y1, m1, d1] = parseDay(a);
  const [y2, m2, d2] = parseDay(b);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 864e5);
};
/** The Monday of the ISO week that contains `key`. */
export function weekStartDay(key) {
  const [y, m, d] = parseDay(key);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday = 0
  return addDays(key, -dow);
}
/** ISO 8601 week as "2026-W41": weeks start on Monday and week 1 is the one holding January 4th. */
export function isoWeekKey(key) {
  const [y, m, d] = parseDay(key);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7)); // the Thursday of this week
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return `${date.getUTCFullYear()}-W${two(Math.ceil(((date.getTime() - yearStart) / 864e5 + 1) / 7))}`;
}

/** The Monday that starts an ISO week given as "2026-W41". */
export function isoWeekStart(weekKey) {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(weekKey));
  if (!m) throw new UserError(`"${weekKey}" is not a week like 2026-W41.`);
  const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4));
  const monday = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 864e5 + (Number(m[2]) - 1) * 7 * 864e5;
  const d = new Date(monday);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
}

// ---------------------------------------------------------------------------------------------
// Text and numbers
// ---------------------------------------------------------------------------------------------

/** Text from a transcript, made safe to print: control characters (terminal escapes) become spaces. */
// (Built from char codes: a line or paragraph separator written into source code would end the line.)
const ch = (...codes) => String.fromCharCode(...codes);
const CONTROL = new RegExp(`[${ch(0)}-${ch(0x1f)}${ch(0x7f)}-${ch(0x9f)}${ch(0x2028, 0x2029)}]+`, "g");
export const clean = (s, max = 120) => String(s ?? "").replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** The last folder of a path, in either spelling. */
export function folderName(cwd) {
  const parts = String(cwd || "").split(/[\\/]+/).filter(Boolean);
  if (parts.length) return parts[parts.length - 1];
  return cwd ? String(cwd) : "(unknown)";
}

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";
/** A path in one comparable spelling: forward slashes, no trailing slash, lower case where paths ignore case. */
export function normPath(p) {
  let s = String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (CASE_INSENSITIVE || /^[a-z]:/i.test(s) || s.startsWith("//")) s = s.toLowerCase();
  return s || "/";
}
/** True when `child` is `dir` or a folder inside it. Both are compared in normalized form. */
export function isInside(child, dir) {
  if (!child || !dir) return false;
  const a = normPath(child);
  const b = normPath(dir);
  if (a === b) return true;
  return a.startsWith(b.endsWith("/") ? b : `${b}/`);
}

const trimZeros = (x, digits) => {
  const s = x.toFixed(digits);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
};
/** 950, 12.3k, 123k, 1.5M, 2.35M, 1.2B */
export function fmtTokens(n) {
  const v = Math.round(Math.abs(Number(n) || 0));
  const sign = n < 0 ? "-" : "";
  if (v < 1000) return sign + v;
  if (v < 999500) return sign + trimZeros(v / 1e3, v < 100000 ? 1 : 0) + "k";
  if (v < 999.5e6) return sign + trimZeros(v / 1e6, 2) + "M";
  return sign + trimZeros(v / 1e9, 2) + "B";
}
const group3 = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** $1,234.56: always two decimals, for tables. */
export function fmtMoney(n) {
  const v = Math.abs(Number(n) || 0);
  const [whole, cents] = v.toFixed(2).split(".");
  return `${n < 0 ? "-" : ""}$${group3(whole)}.${cents}`;
}
/** $4.20 under $20, whole dollars from there ($48, $1,234): for one-line messages. */
export function fmtMoneyShort(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) < 20) return fmtMoney(v);
  return `${v < 0 ? "-" : ""}$${group3(String(Math.round(Math.abs(v))))}`;
}
export const fmtInt = (n) => group3(String(Math.round(Number(n) || 0)));
export const padL = (s, w) => String(s).padStart(w);
export const padR = (s, w) => String(s).padEnd(w);
/** Shortens to `max` characters with "..." (ASCII, so it prints the same everywhere). */
export const ellipsis = (s, max) => (String(s).length > max ? `${String(s).slice(0, Math.max(0, max - 3))}...` : String(s));

/** Minimal option parser: --key value, --key=value, boolean flags listed in `booleans`, positionals in `_`. */
export function parseArgs(argv, booleans = []) {
  const bool = new Set(booleans);
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { args._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) args[key] = a.slice(eq + 1);
      else if (bool.has(key)) args[key] = true;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) args[key] = argv[++i];
      else args[key] = true;
    } else if (a === "-h") args.help = true;
    else args._.push(a);
  }
  return args;
}
