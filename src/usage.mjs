// Turning the index into numbers.
//
// A cell is the unit everything is built from: one local day x one session x one model x main thread or
// subagent. Totals and groups are sums of cells taken in a fixed (sorted) order and tokens are integers,
// so the same index always gives the same numbers, down to the last digit of the dollars.
//
// Units: dollars at API list prices, and "fresh tokens" = input + output + cache writes. Cache reads are
// reported apart because they are cheap. Output includes thinking tokens (`th` is the part that was thinking).
import { F, makeDayOf } from "./index.mjs";
import { costOf, isKnownModel } from "./prices.mjs";
import { addDays, folderName, isoWeekKey, isoWeekStart, startOfDayMs } from "./util.mjs";

const blank = () => ({ n: 0, i: 0, o: 0, w5: 0, w1: 0, r: 0, th: 0 });

/** Cells for the local days fromDay..toDay (inclusive), sorted. */
export function buildCells(idx, { fromDay, toDay }) {
  const fromSec = Math.floor(startOfDayMs(fromDay) / 1000);
  const toSec = Math.floor(startOfDayMs(addDays(toDay, 1)) / 1000);
  const dayOf = makeDayOf();
  const acc = new Map();
  const reqs = idx.requests;
  for (const rid of Object.keys(reqs)) {
    const r = reqs[rid];
    const ts = r[F.TS];
    if (ts < fromSec || ts >= toSec) continue;
    const day = dayOf(ts);
    const key = `${day}|${r[F.S]}|${r[F.M]}|${r[F.A]}`;
    let c = acc.get(key);
    if (!c) {
      const s = idx.sessions[r[F.S]];
      c = { day, cwd: s ? s.cwd : "", sid: s ? s.id : "", model: idx.models[r[F.M]], agent: r[F.A], ...blank() };
      acc.set(key, c);
    }
    c.n++;
    c.i += r[F.I]; c.o += r[F.O]; c.w5 += r[F.W5]; c.w1 += r[F.W1]; c.r += r[F.R]; c.th += r[F.TH];
  }
  for (const day of Object.keys(idx.folded)) { // days older than the window: daily totals, no session detail
    if (day < fromDay || day > toDay) continue;
    const byCwd = idx.folded[day];
    for (const cwd of Object.keys(byCwd)) {
      for (const mk of Object.keys(byCwd[cwd])) {
        const row = byCwd[cwd][mk];
        const agent = mk.endsWith("|a") ? 1 : 0;
        const c = { day, cwd, sid: "", model: agent ? mk.slice(0, -2) : mk, agent, n: row[0], i: row[1], o: row[2], w5: row[3], w1: row[4], r: row[5], th: row[6] };
        acc.set(`${day}|f|${cwd}|${mk}`, c);
      }
    }
  }
  const cells = [...acc.values()];
  for (const c of cells) c.cost = costOf(c.model, c.i, c.o, c.w5, c.w1, c.r);
  cells.sort((a, b) => cmp(a.day, b.day) || cmp(a.cwd, b.cwd) || cmp(a.sid, b.sid) || cmp(a.model, b.model) || a.agent - b.agent);
  return cells;
}
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Add cells up. `fresh` = input + output + cache writes; `cost` is in dollars; `agent*` is the subagent part. */
export function sumCells(cells) {
  const t = { ...blank(), cost: 0, agentCost: 0, agentFresh: 0 };
  for (const c of cells) {
    t.n += c.n; t.i += c.i; t.o += c.o; t.w5 += c.w5; t.w1 += c.w1; t.r += c.r; t.th += c.th;
    t.cost += c.cost;
    if (c.agent) { t.agentCost += c.cost; t.agentFresh += c.i + c.o + c.w5 + c.w1; }
  }
  t.cw = t.w5 + t.w1;
  t.fresh = t.i + t.o + t.cw;
  return t;
}

export const modelLabel = (m) => String(m).replace(/^claude-/, "");

/** The folder a cell belongs to, as a name; folders that share a name get their parent folder too. */
export function projectLabels(cwds) {
  const byName = new Map();
  for (const cwd of cwds) {
    const n = folderName(cwd);
    if (!byName.has(n)) byName.set(n, new Set());
    byName.get(n).add(cwd);
  }
  const out = new Map();
  for (const [name, set] of byName) {
    for (const cwd of set) {
      if (set.size === 1) { out.set(cwd, name); continue; }
      const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
      out.set(cwd, parts.length > 1 ? `${parts[parts.length - 2]}/${name}` : name);
    }
  }
  return out;
}

export function sessionInfo(idx, sid) {
  const i = idx._sess.get(sid);
  const s = i === undefined ? null : idx.sessions[i];
  return { title: (s && (s.title || s.ai)) || "", cwd: (s && s.cwd) || "" };
}

/**
 * Cells grouped by day, week, project, model or session. Rows come with their sums; days and weeks
 * are listed in order and include the empty ones, the other groupings are most expensive first.
 */
export function groupCells(cells, by, { idx, fromDay, toDay } = {}) {
  const groups = new Map();
  const keyOf = { day: (c) => c.day, week: (c) => isoWeekKey(c.day), project: (c) => c.cwd, model: (c) => c.model, session: (c) => c.sid }[by];
  if (!keyOf) throw new Error(`Cannot group by ${by}`);
  for (const c of cells) {
    const k = keyOf(c);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  if (fromDay && toDay && (by === "day" || by === "week")) { // empty days and weeks stay in the list
    for (let d = fromDay; d <= toDay; d = addDays(d, 1)) { const k = by === "day" ? d : isoWeekKey(d); if (!groups.has(k)) groups.set(k, []); }
  }
  const labels = by === "project" ? projectLabels([...groups.keys()]) : null;
  const rows = [...groups].map(([key, cs]) => {
    const row = { key, ...sumCells(cs) };
    if (by === "project") row.label = labels.get(key);
    else if (by === "model") row.label = modelLabel(key);
    else if (by === "week") { row.label = key; row.from = isoWeekStart(key); row.to = addDays(row.from, 6); }
    else if (by === "session") {
      const info = idx ? sessionInfo(idx, key) : { title: "", cwd: "" };
      row.label = key ? info.title || "(untitled)" : "(days before the window: no session detail)";
      row.title = info.title;
      row.project = folderName(info.cwd);
      row.firstDay = cs.reduce((m, c) => (c.day < m ? c.day : m), "9999-12-31");
      row.lastDay = cs.reduce((m, c) => (c.day > m ? c.day : m), "0000-01-01");
    } else row.label = key;
    return row;
  });
  if (by === "day" || by === "week") rows.sort((a, b) => cmp(a.key, b.key));
  else rows.sort((a, b) => b.cost - a.cost || cmp(a.key, b.key));
  return rows;
}

/** Models in these cells that are not in the price table (they are priced at the fallback rate). */
export function unpricedModels(cells) {
  return [...new Set(cells.filter((c) => !isKnownModel(c.model)).map((c) => c.model))].sort();
}

/** The first and last day a report covers: the last `days` days up to and including `today`. */
export function rangeFor(today, days) {
  return { fromDay: addDays(today, -(days - 1)), toDay: today, days };
}
