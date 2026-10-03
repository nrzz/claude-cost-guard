// `report`, `today` and `statusline`: turning cells and budgets into text and JSON.
// Only numbers, model ids, folder names and session titles are ever printed: never a prompt, an answer or a tool result.
import { displayPct, fmtLimit, isOver } from "./budgets.mjs";
import { ellipsis, fmtInt, fmtMoney, fmtMoneyShort, fmtTokens, padL, padR } from "./util.mjs";

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/** An aligned text table: header, rule, rows, and an optional total row under a second rule. */
export function renderTable({ headers, aligns, rows, total }) {
  const all = [headers, ...rows, ...(total ? [total] : [])];
  const widths = headers.map((_, c) => Math.max(...all.map((r) => String(r[c]).length)));
  const line = (r) => r.map((cell, c) => (aligns[c] === "l" ? padR(cell, widths[c]) : padL(cell, widths[c]))).join("  ").trimEnd();
  const rule = widths.map((w) => "-".repeat(w)).join("  ");
  const out = [line(headers), rule, ...rows.map(line)];
  if (total) out.push(rule, line(total));
  return out;
}

const NUM_HEADERS = ["Reqs", "Input", "Output", "Cache wr", "Cache rd", "Fresh", "Cost"];
const numCells = (s) => [fmtInt(s.n), fmtTokens(s.i), fmtTokens(s.o), fmtTokens(s.cw), fmtTokens(s.r), fmtTokens(s.fresh), fmtMoney(s.cost)];

const FIRST_HEADER = { day: "Day", week: "Week", project: "Project", model: "Model", session: "Session" };
function rowLabel(by, r) {
  if (by === "week") return `${r.key} ${r.from.slice(5)}..${r.to.slice(5)}`;
  if (by === "session") return r.key ? `${ellipsis(r.label, 34)} (${r.key.slice(0, 8)})` : r.label;
  return ellipsis(r.label, 32);
}

/** The totals of a row as plain JSON numbers. */
export function jsonTotals(s) {
  return {
    requests: s.n, input: s.i, output: s.o, thinking: s.th, cacheWrite5m: s.w5, cacheWrite1h: s.w1, cacheWrite: s.cw, cacheRead: s.r,
    fresh: s.fresh, cost: round6(s.cost), subagentCost: round6(s.agentCost), subagentFresh: s.agentFresh,
  };
}
export function jsonRow(by, r) {
  const base = { key: by === "project" ? r.label : r.key, label: r.label };
  if (by === "week") Object.assign(base, { from: r.from, to: r.to });
  if (by === "session") Object.assign(base, { id: r.key, title: r.title, project: r.project, firstDay: r.firstDay, lastDay: r.lastDay });
  return { ...base, ...jsonTotals(r) };
}

/** The `report` text. `sessions` are the most expensive sessions (shown under every grouping but session). */
export function reportText({ by, range, rows, total, sessions, notes, moreSessions }) {
  const out = [];
  out.push(`Claude Code usage ${range.fromDay} to ${range.toDay} (${range.days} day${range.days === 1 ? "" : "s"}), by ${by}`);
  out.push("");
  const body = rows.map((r) => [rowLabel(by, r), ...numCells(r)]);
  out.push(...renderTable({
    headers: [FIRST_HEADER[by], ...NUM_HEADERS],
    aligns: ["l", "r", "r", "r", "r", "r", "r", "r"],
    rows: body,
    total: ["Total", ...numCells(total)],
  }));
  if (moreSessions) out.push(`(${moreSessions.count} more sessions, ${fmtMoney(moreSessions.cost)})`);
  if (by !== "session" && sessions.length) {
    out.push("", "Most expensive sessions");
    out.push(...renderTable({
      headers: ["Cost", "Fresh", "Project", "Last", "Session"],
      aligns: ["r", "r", "l", "l", "l"],
      rows: sessions.map((r) => [fmtMoney(r.cost), fmtTokens(r.fresh), ellipsis(r.project, 20), r.lastDay.slice(5), `${ellipsis(r.label, 40)} (${r.key.slice(0, 8)})`]),
    }).map((l) => `  ${l}`));
  }
  out.push("");
  out.push("Fresh = input + output + cache writes. Cache reads are cheap and listed apart.");
  for (const n of notes) out.push(n);
  return out.join("\n");
}

/** "today $12.10 of $15 (81%)" without a threshold flag, for `today` and `budget show`. */
export function slotText(s) {
  const used = s.unit === "usd" ? fmtMoneyShort(s.used) : fmtTokens(s.used);
  const word = s.period === "daily" ? "today" : "this week";
  return `${word} ${used} of ${fmtLimit(s.unit, s.limit)}${s.unit === "tokens" ? " tokens" : ""} (${displayPct(s.pct)}%)`;
}

/** The `today` text. */
export function todayText({ today, weekStart, day, week, byProject, byModel, slots }) {
  const out = [`Today, ${today}`];
  out.push(`  cost         ${fmtMoney(day.cost)}   (API list prices)`);
  out.push(`  fresh        ${fmtTokens(day.fresh)} tokens: input ${fmtTokens(day.i)} · output ${fmtTokens(day.o)} · cache writes ${fmtTokens(day.cw)}`);
  out.push(`  cache reads  ${fmtTokens(day.r)}`);
  out.push(`  requests     ${fmtInt(day.n)}${day.agentCost ? `   (subagents: ${fmtMoney(day.agentCost)})` : ""}`);
  if (byProject.length) out.push(`  by project   ${byProject.map((r) => `${r.label} ${fmtMoney(r.cost)}`).join(" · ")}`);
  if (byModel.length) out.push(`  by model     ${byModel.map((r) => `${r.label} ${fmtMoney(r.cost)}`).join(" · ")}`);
  out.push(`This week (Monday ${weekStart} on): ${fmtMoney(week.cost)} · ${fmtTokens(week.fresh)} fresh tokens`);
  const scopes = new Map();
  for (const s of slots) { if (!scopes.has(s.scopeKey)) scopes.set(s.scopeKey, []); scopes.get(s.scopeKey).push(s); }
  if (scopes.size) {
    out.push("Budgets here:");
    for (const group of scopes.values()) {
      const over = group.some((s) => s.mode === "hard" && isOver(s));
      out.push(`  ${group[0].scope.padEnd(16)} ${group.map(slotText).join(" · ")}  [${group[0].mode}${over ? ": new prompts are blocked" : ""}]`);
    }
  }
  return out.join("\n");
}

/** The `statusline` text: `today $4.20/$15 · week $31/$80`; plain usage when no budget applies. */
export function statuslineText({ slots, day, week }) {
  const one = (s) => {
    const used = s.unit === "usd" ? fmtMoneyShort(s.used) : fmtTokens(s.used);
    return `${s.period === "daily" ? "today" : "week"} ${used}/${fmtLimit(s.unit, s.limit)}`;
  };
  if (!slots.length) return `today ${fmtMoneyShort(day.cost)} · week ${fmtMoneyShort(week.cost)}`;
  const scopes = new Map();
  for (const s of slots) { if (!scopes.has(s.scopeKey)) scopes.set(s.scopeKey, []); scopes.get(s.scopeKey).push(s); }
  return [...scopes.values()].map((g) => `${g[0].isGlobal ? "" : `${g[0].scope}: `}${g.map(one).join(" · ")}`).join(" · ");
}

