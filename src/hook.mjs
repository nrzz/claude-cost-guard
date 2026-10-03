// The UserPromptSubmit hook.
//
// It says nothing unless there is something to say, and then only one of two things, both free of tokens:
//   {"systemMessage": "..."}                a line shown to the person, never to the model
//   {"decision":"block","reason":"..."}     the prompt is not sent, so the model never sees it (hard mode only)
// Prompts that are not typed by a person (source is not "user") are skipped, and a hook never fails a
// session: any problem ends with no output (it goes to <configDir>/cost-guard/errors.log).
import { amountArg, applicable, displayPct, evaluate, fmtLimit, isOver, levelOf, loadBudgets, niceStep } from "./budgets.mjs";
import { refresh } from "./index.mjs";
import { buildCells } from "./usage.mjs";
import { configDir, dayKeyOf, fmtMoney, fmtMoneyShort, fmtTokens, logError, readJson, stateFile, weekStartDay, writeJsonAtomic } from "./util.mjs";

export const DEFAULT_BUDGET_MS = 250;

/** JSON with every non-ASCII character escaped: valid JSON that survives any console code page. */
const ch = (code) => String.fromCharCode(code);
const NON_ASCII = new RegExp(`[${ch(0x7f)}-${ch(0xffff)}]`, "g"); // built from char codes: an invisible character in source is a trap
export const toAsciiJson = (obj) => JSON.stringify(obj).replace(NON_ASCII, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

export const isOff = (env) => /^(1|true|yes|on)$/i.test(String(env.CLAUDE_COST_GUARD_OFF || "").trim());

function envNumber(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// "today $12.10 of $15 (81%)": the percentage only on a limit that just crossed a threshold.
function describePeriod(slot, withPct) {
  const used = slot.unit === "usd" ? fmtMoneyShort(slot.used) : fmtTokens(slot.used);
  const word = slot.period === "daily" ? "today" : "this week";
  const pct = withPct ? ` (${displayPct(slot.pct)}%)` : "";
  return `${word} ${used} of ${fmtLimit(slot.unit, slot.limit)}${slot.unit === "tokens" ? " tokens" : ""}${pct}`;
}

/** One line per budget that crossed a threshold: "Cost guard: today $12.10 of $15 (81%) · this week $48 of $80". */
export function messageLines(slots, triggered) {
  const byScope = new Map();
  for (const s of slots) {
    if (!byScope.has(s.scopeKey)) byScope.set(s.scopeKey, []);
    byScope.get(s.scopeKey).push(s);
  }
  const lines = [];
  for (const group of byScope.values()) {
    if (!group.some((s) => triggered.has(s.key))) continue;
    const head = group[0].isGlobal ? "Cost guard" : `Cost guard (${group[0].scope})`;
    lines.push(`${head}: ${group.map((s) => describePeriod(s, triggered.has(s.key))).join(" · ")}`);
  }
  return lines;
}

/** Shown in place of a blocked prompt. The command it suggests has no $ in it: a shell would expand `$5` to nothing. */
export function blockReason(slot) {
  const when = slot.period === "daily" ? "today's" : "this week's";
  const forProject = slot.isGlobal ? "" : ` for ${slot.scope}`;
  const used = slot.unit === "usd" ? fmtMoney(slot.used) : fmtTokens(slot.used);
  const limit = `${fmtLimit(slot.unit, slot.limit)}${slot.unit === "tokens" ? " tokens" : ""}`;
  const extend = amountArg(slot.unit, niceStep(slot.base / 3));
  return `Cost guard: ${when} budget of ${limit}${forProject} is used (${used}). Raise it with: claude-cost-guard budget extend ${extend}, or set CLAUDE_COST_GUARD_OFF=1.`;
}

/**
 * What to do, given every limit's usage and the thresholds already announced today (`marks`).
 * Returns {block} or {message, marks, changed}. A budget in hard mode at 100% blocks every prompt;
 * otherwise each threshold (50, 80, 100) is announced once per limit per day. With `announce` false (a run
 * that could not take the lock, so cannot record what it says) only blocks are decided: a warning waits for
 * the next prompt rather than risk being said twice.
 */
export function plan(slots, marks, { announce = true } = {}) {
  const over = slots.filter((s) => s.mode === "hard" && isOver(s)).sort((a, b) => Number(a.isGlobal) - Number(b.isGlobal));
  if (over.length) return { block: blockReason(over[0]), marks, changed: false };
  if (!announce) return { message: null, marks, changed: false };
  const next = { ...marks };
  const triggered = new Set();
  for (const s of slots) {
    const level = levelOf(s.pct);
    if (level > (Number(marks[s.key]) || 0)) { triggered.add(s.key); next[s.key] = level; }
  }
  if (!triggered.size) return { message: null, marks, changed: false };
  return { message: messageLines(slots, triggered).join("\n"), marks: next, changed: true };
}

/**
 * After a budget changed (set, extended, cleared): count the thresholds that `slots` have already reached
 * as announced, so the person is not told again what the command just showed, and forget marks of limits
 * that no longer exist (`liveKeys` lists the ones that do).
 */
export function syncMarks(cfg, today, slots, liveKeys) {
  const s = readJson(stateFile(cfg), null);
  const old = s && s.day === today && s.marks && typeof s.marks === "object" && !Array.isArray(s.marks) ? s.marks : {};
  const marks = {};
  for (const [k, v] of Object.entries(old)) if (liveKeys.includes(k)) marks[k] = v;
  for (const slot of slots) {
    const level = levelOf(slot.pct);
    if (level) marks[slot.key] = level; else delete marks[slot.key];
  }
  writeJsonAtomic(stateFile(cfg), { day: today, marks }, 2);
}

const loadMarks = (cfg, today) => {
  const s = readJson(stateFile(cfg), null);
  return s && s.day === today && s.marks && typeof s.marks === "object" && !Array.isArray(s.marks) ? s.marks : {};
};

/**
 * Run the hook for one prompt. `stdin` is the JSON Claude Code sends. Returns {output} where output is the
 * single line to print, or null for silence.
 */
export async function runHook({ env = process.env, stdin = "", now = Date.now() } = {}) {
  const result = { output: null };
  if (isOff(env)) return result;
  let input;
  try { input = JSON.parse(stdin || "{}"); } catch { return result; }
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  if (input.source !== undefined && input.source !== "user") return result; // automated prompts are not the person's spending decisions
  if (input.hook_event_name !== undefined && input.hook_event_name !== "UserPromptSubmit") return result;
  // Slash commands (/compact, /clear, /model, ...) and ! shell commands are never blocked: they are how a
  // person gets back under a budget, and most of them never reach the model.
  const mayBlock = !/^\s*[/!]/.test(typeof input.prompt === "string" ? input.prompt : "");

  const cfg = configDir(env);
  try {
    const entries = applicable(loadBudgets(cfg), typeof input.cwd === "string" ? input.cwd : "");
    if (!entries.length) return result; // no budget here: no work at all
    const today = dayKeyOf(now);
    // Deciding what to announce and recording it happen under the same lock as reading the transcripts, so two
    // prompts sent at the same moment (two windows) cannot both announce the same threshold.
    const { stats, result: decided } = refresh(cfg, {
      now, budgetMs: envNumber(env, "CLAUDE_COST_GUARD_BUDGET_MS", DEFAULT_BUDGET_MS), priority: [input.transcript_path], lockWaitMs: 120,
      whileLocked: (idx, stats) => {
        const slots = evaluate(buildCells(idx, { fromDay: weekStartDay(today), toDay: today }), entries, today);
        const p = plan(slots, loadMarks(cfg, today), { announce: stats.locked });
        if (p.changed) writeJsonAtomic(stateFile(cfg), { day: today, marks: p.marks }, 2);
        return { slots, p };
      },
    });
    const { slots, p } = decided;
    if (p.block && mayBlock) result.output = toAsciiJson({ decision: "block", reason: p.block });
    else if (p.message) result.output = toAsciiJson({ systemMessage: p.message });
    result.slots = slots;
    result.stats = stats;
  } catch (e) {
    logError(cfg, e);
    result.output = null;
  }
  return result;
}
