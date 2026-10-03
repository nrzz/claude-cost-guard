// Aging out (folding into daily totals), which files a quick run looks at, locking, and time zones.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { F, KEEP_FOLDED_DAYS, RETAIN_DAYS, cutoffSec, loadIndex, refresh } from "../src/index.mjs";
import { buildCells, groupCells, sumCells } from "../src/usage.mjs";
import { addDays, dayKeyOf } from "../src/util.mjs";
import { ALPHA, BETA, CLI, NOW, S1, S2, S3, ageFile, at, near, runCli, sandbox, uid, usage } from "./helpers.mjs";

const DAY = 864e5;
const RANGE = { fromDay: "2025-01-01", toDay: "2027-12-31" };
const all = (idx) => buildCells(idx, RANGE);

// Four requests: 30, 20, 5 and 0 days before NOW, in two projects and two models.
function aged(box) {
  const a = box.session({ cwd: ALPHA, sid: S1 });
  const b = box.session({ cwd: BETA, sid: S2 });
  a.title("Old work");
  a.req({ ts: at(-30, 10), model: "claude-opus-5-5", u: usage({ i: 1000000, o: 100000, cr: 5000000, cw5: 200000 }), requestId: "req_30" }); // 4 + 2 + 1 + 1 = $8.00
  b.req({ ts: at(-20, 10), model: "claude-sonnet-5-5", u: usage({ i: 500000, o: 50000 }), requestId: "req_20" }); // 1 + 0.5 = $1.50
  a.req({ ts: at(-5, 10), model: "claude-opus-5-5", u: usage({ o: 10000 }), requestId: "req_5" }); // $0.20
  a.req({ ts: at(0, 10), model: "claude-opus-5-5", u: usage({ o: 10000 }), requestId: "req_0" }); // $0.20
  return { a, b };
}

test("requests older than the window become daily totals, and nothing is lost on the way", () => {
  const box = sandbox();
  try {
    aged(box);
    const first = refresh(box.cfg, { now: NOW, full: true }).idx;
    assert.equal(Object.keys(first.requests).length, 4);
    const before = sumCells(all(first));
    assert.ok(near(before.cost, 9.9));
    // 10 days later the request from 30 days before NOW is 40 days old: out of the 35 day window
    const later = NOW + 10 * DAY;
    const idx = refresh(box.cfg, { now: later }).idx;
    assert.equal(Object.keys(idx.requests).length, 3, "folded away");
    assert.ok(idx.requests.req_20 && idx.requests.req_5 && idx.requests.req_0);
    const day = dayKeyOf(new Date(2026, 8, 7, 10).getTime()); // 2026-09-07
    assert.equal(day, "2026-09-07");
    assert.deepEqual(idx.folded[day], { "D:\\work\\alpha": { "claude-opus-5-5": [1, 1000000, 100000, 200000, 0, 5000000, 0] } });
    const after = sumCells(all(idx));
    for (const k of ["n", "i", "o", "w5", "w1", "r", "th", "fresh"]) assert.equal(after[k], before[k], k);
    assert.ok(near(after.cost, before.cost), "the same dollars, computed from the stored tokens");
    // the folded day still shows up in reports, by project and by model, but with no session behind it
    const cells = buildCells(idx, { fromDay: "2026-09-01", toDay: "2026-09-10" });
    assert.equal(cells.length, 1);
    assert.equal(cells[0].sid, "");
    assert.equal(groupCells(cells, "project", { idx })[0].label, "alpha");
    assert.equal(groupCells(cells, "session", { idx })[0].label, "(days before the window: no session detail)");
  } finally { box.cleanup(); }
});

test("a folded day is not counted again when its transcript is read again", () => {
  const box = sandbox();
  try {
    const { a } = aged(box);
    refresh(box.cfg, { now: NOW, full: true });
    const later = NOW + 10 * DAY;
    const idx = refresh(box.cfg, { now: later }).idx;
    const folded = JSON.stringify(idx.folded);
    // the transcript is rewritten with a new first line (so it is read again from the start) and a fork copies it
    const lines = fs.readFileSync(a.file, "utf8");
    fs.writeFileSync(a.file, `{"type":"queue-operation","operation":"enqueue"}
${lines}`);
    fs.copyFileSync(a.file, path.join(path.dirname(a.file), `${uid(9)}.jsonl`));
    const r = refresh(box.cfg, { now: later, full: true });
    assert.equal(r.stats.resets, 1, "the rewritten file was read again from the start");
    const again = r.idx;
    assert.equal(JSON.stringify(again.folded), folded, "the 40 day old record is ignored, not folded twice");
    assert.ok(near(sumCells(all(again)).cost, 9.9));
  } finally { box.cleanup(); }
});

test("records older than the window are never indexed at all", () => {
  const box = sandbox();
  try {
    const s = box.session({ cwd: ALPHA, sid: S1 });
    s.req({ ts: at(-50, 10), model: "claude-opus-5-5", u: usage({ i: 1e6 }), requestId: "req_ancient" });
    s.req({ ts: at(-34, 10), model: "claude-opus-5-5", u: usage({ i: 100 }), requestId: "req_edge" }); // the oldest day that is kept
    s.req({ ts: at(-35, 23, 59, 59), model: "claude-opus-5-5", u: usage({ i: 10 }), requestId: "req_just_out" });
    const idx = refresh(box.cfg, { now: NOW, full: true }).idx;
    assert.deepEqual(Object.keys(idx.requests), ["req_edge"]);
    assert.deepEqual(idx.folded, {});
    assert.equal(cutoffSec(NOW), Math.floor(new Date(2026, 8, 3).getTime() / 1000), "local midnight, 34 days before today");
    assert.equal(RETAIN_DAYS, 35);
  } finally { box.cleanup(); }
});

test("daily totals outlive their transcripts and the session list", () => {
  const box = sandbox();
  try {
    const { a, b } = aged(box);
    refresh(box.cfg, { now: NOW, full: true });
    const later = NOW + 10 * DAY;
    refresh(box.cfg, { now: later });
    fs.rmSync(a.file);
    fs.rmSync(b.file);
    const idx = refresh(box.cfg, { now: later, full: true }).idx;
    // req_20 is 30 days old and req_5, req_0 are young: they go with their files; the folded one stays
    assert.equal(Object.keys(idx.requests).length, 1, "a request older than 20 days outlives its transcript");
    const total = sumCells(all(idx));
    assert.ok(near(total.cost, 8 + 1.5), `${total.cost}: the folded 30 day old one and the orphaned 20 day old one`);
  } finally { box.cleanup(); }
});

test("session numbers stay right when old sessions are pruned", () => {
  const box = sandbox();
  try {
    const old = box.session({ cwd: ALPHA, sid: S1 });
    const mid = box.session({ cwd: BETA, sid: S2 });
    const recent = box.session({ cwd: "/work/c", sid: S3 });
    old.req({ ts: at(-33, 9), model: "claude-opus-5-5", u: usage({ i: 100 }), requestId: "req_old" });
    old.title("Old session");
    mid.req({ ts: at(-3, 9), model: "claude-opus-5-5", u: usage({ i: 200 }), requestId: "req_mid" });
    mid.title("Middle");
    recent.req({ ts: at(0, 9), model: "claude-opus-5-5", u: usage({ i: 300 }), requestId: "req_recent" });
    recent.title("Recent");
    refresh(box.cfg, { now: NOW, full: true });
    fs.rmSync(old.file);
    const later = NOW + 20 * DAY; // req_old is 53 days old: folded; its session is unreferenced and old
    const idx = refresh(box.cfg, { now: later, full: true }).idx;
    assert.deepEqual(idx.sessions.map((s) => s.title).sort(), ["Middle", "Recent"], "the old session is gone");
    const rows = groupCells(buildCells(idx, { fromDay: "2026-10-01", toDay: "2026-10-30" }), "session", { idx });
    assert.deepEqual(rows.map((r) => [r.title, r.i]).sort(), [["Middle", 200], ["Recent", 300]], "each request still belongs to its own session");
    assert.equal(idx.requests.req_mid[F.S] !== idx.requests.req_recent[F.S], true);
    // and the index on disk says the same
    const disk = loadIndex(box.cfg);
    assert.deepEqual(disk.sessions.map((s) => s.title).sort(), ["Middle", "Recent"]);
  } finally { box.cleanup(); }
});

test("daily totals older than two years are forgotten", () => {
  const box = sandbox();
  try {
    aged(box);
    refresh(box.cfg, { now: NOW, full: true });
    refresh(box.cfg, { now: NOW + 40 * DAY });
    assert.ok(Object.keys(loadIndex(box.cfg).folded).length > 0);
    const far = NOW + (KEEP_FOLDED_DAYS + 120) * DAY;
    const idx = refresh(box.cfg, { now: far }).idx;
    assert.deepEqual(Object.keys(idx.folded).filter((d) => d < addDays(dayKeyOf(far), -KEEP_FOLDED_DAYS)), []);
    assert.equal(idx.rolledOn, dayKeyOf(far));
  } finally { box.cleanup(); }
});

test("the index stays bounded: a long history becomes a few daily rows", () => {
  const box = sandbox();
  try {
    const s = box.session({ cwd: ALPHA, sid: S1 });
    for (let d = 0; d < 30; d++) for (let k = 0; k < 40; k++) s.req({ ts: at(-d, 8, k), model: k % 2 ? "claude-opus-5-5" : "claude-sonnet-5-5", u: usage({ i: 100 + k, o: 10 }), requestId: `req_${d}_${k}` });
    refresh(box.cfg, { now: NOW, full: true });
    const later = NOW + 90 * DAY; // every request is now older than the window
    const idx = refresh(box.cfg, { now: later }).idx;
    assert.equal(Object.keys(idx.requests).length, 0);
    assert.equal(Object.keys(idx.folded).length, 30, "one entry per day");
    const folded = sumCells(buildCells(idx, RANGE));
    assert.equal(folded.n, 1200);
    assert.ok(fs.statSync(path.join(box.guard, "index.json")).size < 20000, "a few KB, not one entry per request");
  } finally { box.cleanup(); }
});

// ---------------------------------------------------------------------------------------------
// Which files a quick run looks at
// ---------------------------------------------------------------------------------------------

function coldWorld(n) {
  const box = sandbox();
  const sessions = [];
  for (let k = 0; k < n; k++) {
    const s = box.session({ cwd: `/work/p${k}`, sid: uid(100 + k) });
    s.req({ ts: at(-5, 9), model: "claude-opus-5-5", u: usage({ i: 100 }), requestId: `req_c${k}` });
    ageFile(s.file, NOW, 10); // idle for ten days: a cold file
    sessions.push(s);
  }
  refresh(box.cfg, { now: NOW, full: true });
  return { box, sessions };
}
const grow = (s, k, tag = "x") => { s.req({ ts: at(0, 9, k), model: "claude-opus-5-5", u: usage({ i: 1 }), requestId: `req_${tag}${k}` }); };
const inputTokens = (idx) => sumCells(all(idx)).i;

test("a quick run does not touch cold files, a full run does, and so does naming the session being prompted", () => {
  const { box, sessions } = coldWorld(3);
  try {
    grow(sessions[1], 1);
    let r = refresh(box.cfg, { now: NOW, statBudget: 0, coldMin: 0 });
    assert.equal(inputTokens(r.idx), 300, "idle files are not looked at (budget 0)");
    assert.equal(r.stats.checked, 0);
    r = refresh(box.cfg, { now: NOW, statBudget: 0, coldMin: 0, priority: [sessions[1].file] });
    assert.equal(inputTokens(r.idx), 301, "the transcript the hook was given is always looked at");
    grow(sessions[2], 2);
    r = refresh(box.cfg, { now: NOW, full: true });
    assert.equal(inputTokens(r.idx), 302, "a full run looks at everything");
  } finally { box.cleanup(); }
});

test("idle files are checked in rotation: every one is reached within a few quick runs", () => {
  const { box, sessions } = coldWorld(10);
  try {
    sessions.forEach((s, k) => grow(s, k));
    let runs = 0;
    let r;
    do { r = refresh(box.cfg, { now: NOW, statBudget: 3, coldMin: 3 }); runs++; } while (inputTokens(r.idx) < 1010 && runs < 20);
    assert.equal(inputTokens(r.idx), 1010);
    assert.ok(runs <= 4, `${runs} runs for 10 files, 3 at a time`);
  } finally { box.cleanup(); }
});

test("recently changed files are checked every run whatever the budget", () => {
  const box = sandbox();
  try {
    const hot = [0, 1, 2, 3, 4].map((k) => { const s = box.session({ cwd: `/work/h${k}`, sid: uid(200 + k) }); s.req({ ts: at(0, 8), model: "claude-opus-5-5", u: usage({ i: 10 }), requestId: `req_h${k}` }); return s; });
    refresh(box.cfg, { now: NOW, full: true });
    hot.forEach((s, k) => grow(s, k, "g"));
    const r = refresh(box.cfg, { now: NOW, statBudget: 1, coldMin: 0 });
    assert.equal(inputTokens(r.idx), 55, "all five hot files, although the budget says 1");
  } finally { box.cleanup(); }
});

test("a transcript that disappears is noticed in the rotation too", () => {
  const { box, sessions } = coldWorld(4);
  try {
    fs.rmSync(sessions[3].file);
    const r = refresh(box.cfg, { now: NOW, statBudget: 100 });
    assert.equal(r.stats.dropped, 1);
    assert.equal(inputTokens(r.idx), 300);
  } finally { box.cleanup(); }
});

test("a quick run notices new project folders and new subagent files of busy sessions", () => {
  const box = sandbox();
  try {
    const main = box.session({ cwd: ALPHA, sid: S1 });
    main.req({ ts: at(0, 8), model: "claude-opus-5-5", u: usage({ i: 10 }), requestId: "req_main" });
    refresh(box.cfg, { now: NOW, full: true });
    const agent = box.session({ cwd: ALPHA, sid: S1, agent: "late" });
    agent.req({ ts: at(0, 9), model: "claude-opus-5-5", u: usage({ i: 5 }), requestId: "req_agent" });
    const other = box.session({ cwd: "/brand/new", sid: S2 });
    other.req({ ts: at(0, 9), model: "claude-opus-5-5", u: usage({ i: 7 }), requestId: "req_other" });
    const r = refresh(box.cfg, { now: NOW, statBudget: 0, coldMin: 0 });
    assert.equal(inputTokens(r.idx), 22);
  } finally { box.cleanup(); }
});

// ---------------------------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------------------------

test("a run that finds the index locked leaves it alone and reads it as it is", () => {
  const box = sandbox();
  try {
    aged(box);
    refresh(box.cfg, { now: NOW, full: true });
    const lock = path.join(box.guard, "index.lock");
    fs.writeFileSync(lock, "1");
    const s = box.session({ cwd: ALPHA, sid: S1 });
    s.req({ ts: at(0, 11), model: "claude-opus-5-5", u: usage({ i: 77 }), requestId: "req_new" });
    const before = fs.readFileSync(path.join(box.guard, "index.json"), "utf8");
    const r = refresh(box.cfg, { now: NOW });
    assert.equal(r.stats.skipped, true);
    assert.equal(r.idx.requests.req_new, undefined, "not read while somebody else is writing");
    assert.equal(fs.readFileSync(path.join(box.guard, "index.json"), "utf8"), before, "and the file is untouched");
    assert.equal(fs.readFileSync(lock, "utf8"), "1", "the other run's lock is not removed");
    fs.rmSync(lock);
    assert.ok(refresh(box.cfg, { now: NOW }).idx.requests.req_new);
  } finally { box.cleanup(); }
});

test("a failing run still releases the lock", () => {
  const box = sandbox();
  try {
    aged(box);
    assert.throws(() => refresh(box.cfg, { now: NaN }));
    assert.equal(fs.existsSync(path.join(box.guard, "index.lock")), false);
    assert.ok(refresh(box.cfg, { now: NOW, full: true }).stats.locked);
  } finally { box.cleanup(); }
});

test("when the transcripts folder does not exist nothing is dropped and nothing fails", () => {
  const box = sandbox();
  try {
    aged(box);
    const r = refresh(box.cfg, { now: NOW, full: true });
    assert.equal(Object.keys(r.idx.requests).length, 4);
    fs.renameSync(box.projects, `${box.projects}-away`); // a drive that is not mounted right now
    const gone = refresh(box.cfg, { now: NOW, full: true });
    assert.equal(gone.stats.missingRoot, true);
    assert.equal(Object.keys(gone.idx.requests).length, 4, "the index keeps what it knows");
    fs.renameSync(`${box.projects}-away`, box.projects);
    const back = refresh(box.cfg, { now: NOW, full: true });
    assert.equal(back.stats.dropped, 0);
    assert.equal(Object.keys(back.idx.requests).length, 4);
  } finally { box.cleanup(); }
});

// ---------------------------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------------------------

test("a request belongs to the local day of the machine reading it", () => {
  const box = sandbox();
  try {
    const s = box.session({ cwd: ALPHA, sid: S1 });
    const req = (iso, id) => s.req({ ts: iso, model: "claude-opus-5-5", u: usage({ i: 1 }), requestId: id });
    req("2026-10-03T18:15:00.000Z", "req_A");
    req("2026-10-03T18:45:00.000Z", "req_B");
    req("2026-10-04T06:45:00.000Z", "req_C");
    const perDay = (tz) => {
      const r = runCli(box, ["report", "--json", "--days", "2"], { env: { TZ: tz, FAKE_NOW: "2026-10-04T12:00:00.000Z" } });
      assert.equal(r.status, 0, r.out);
      const j = JSON.parse(r.stdout);
      return Object.fromEntries(j.rows.map((x) => [x.key, x.requests]));
    };
    assert.deepEqual(perDay("UTC"), { "2026-10-03": 2, "2026-10-04": 1 });
    assert.deepEqual(perDay("Asia/Kolkata"), { "2026-10-03": 1, "2026-10-04": 2 }, "UTC+5:30: 18:45Z is already after midnight");
    assert.deepEqual(perDay("America/Los_Angeles"), { "2026-10-03": 3, "2026-10-04": 0 }, "UTC-7: all three are still the 3rd");
  } finally { box.cleanup(); }
});

test("work that must not interleave runs under the lock, and runs without it when the lock is taken", () => {
  const box = sandbox();
  try {
    aged(box);
    const lock = path.join(box.guard, "index.lock");
    let held;
    const first = refresh(box.cfg, { now: NOW, full: true, whileLocked: (idx, stats) => { held = fs.existsSync(lock); return { n: Object.keys(idx.requests).length, locked: stats.locked }; } });
    assert.equal(held, true, "the lock is held while the callback runs");
    assert.deepEqual(first.result, { n: 4, locked: true });
    assert.equal(fs.existsSync(lock), false, "and released after");
    fs.writeFileSync(lock, "1");
    const second = refresh(box.cfg, { now: NOW, whileLocked: (idx, stats) => ({ locked: stats.locked, skipped: stats.skipped }) });
    assert.deepEqual(second.result, { locked: false, skipped: true }, "the callback still gets the index as it is on disk");
    assert.equal(fs.existsSync(lock), true);
    fs.rmSync(lock);
    assert.throws(() => refresh(box.cfg, { now: NOW, whileLocked: () => { throw new Error("boom"); } }), /boom/);
    assert.equal(fs.existsSync(lock), false, "a callback that throws still releases the lock");
    assert.match(fs.readFileSync(path.join(box.guard, "errors.log"), "utf8"), /boom/);
  } finally { box.cleanup(); }
});
