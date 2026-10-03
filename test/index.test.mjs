// The indexer: what it counts, and that reading a little at a time gives the same answer as reading everything.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { F, loadIndex, refresh } from "../src/index.mjs";
import { buildCells, groupCells, sumCells } from "../src/usage.mjs";
import { ALPHA, BETA, NOW, S1, S2, S3, ageFile, at, buildFixture, expected, near, readJson, sandbox, usage } from "./helpers.mjs";

const RANGE = { fromDay: "2026-08-01", toDay: "2026-10-07" };
const build = (box, opts = {}) => refresh(box.cfg, { now: NOW, full: true, ...opts });
const cellsOf = (idx) => buildCells(idx, RANGE);
const totals = (idx) => sumCells(cellsOf(idx));
// Everything that must not depend on how the index was built: the cells without any bookkeeping.
const snapshot = (idx) => JSON.stringify({
  cells: cellsOf(idx).map(({ day, cwd, sid, model, agent, n, i, o, w5, w1, r, th }) => [day, cwd, sid, model, agent, n, i, o, w5, w1, r, th]),
  // sessions that hold no request any more are not part of the answer
  titles: idx.sessions.filter((s, i) => Object.values(idx.requests).some((r) => r[F.S] === i)).map((s) => [s.id, s.title || "", s.ai || "", s.cwd]).sort(),
});
// A fresh index in another config folder, reading the same transcripts: the "full rescan".
function rescan(box, opts = {}) {
  const other = sandbox();
  try { return refresh(other.cfg, { now: NOW, full: true, projectsDir: box.projects, ...opts }).idx; } finally { other.cleanup(); }
}

test("the reference data set adds up to the hand-computed numbers", () => {
  const box = sandbox();
  try {
    buildFixture(box);
    const { idx, stats } = build(box);
    assert.equal(stats.files, 4, "three main files and one subagent file");
    assert.equal(Object.keys(idx.requests).length, expected.requests, "each request once, whatever the number of records");
    const t = totals(idx);
    for (const k of ["n", "i", "o", "w5", "w1", "cw", "r", "th", "fresh", "agentFresh"]) assert.equal(t[k], expected.total[k], k);
    assert.ok(near(t.cost, expected.total.cost), `cost ${t.cost}`);
    assert.ok(near(t.agentCost, expected.total.agentCost), "subagent cost");
    assert.equal(t.fresh, t.i + t.o + t.w5 + t.w1, "fresh = input + output + cache writes, cache reads apart");
  } finally { box.cleanup(); }
});

test("per day, week, project, model and session", () => {
  const box = sandbox();
  try {
    buildFixture(box);
    const { idx } = build(box);
    const cells = cellsOf(idx);
    const check = (by, want) => {
      const rows = groupCells(cells, by, { idx });
      for (const [k, cost] of Object.entries(want)) {
        const row = rows.find((r) => r.key === k);
        assert.ok(row, `${by} ${k}`);
        assert.ok(near(row.cost, cost), `${by} ${k}: ${row.cost} vs ${cost}`);
      }
      assert.equal(rows.filter((r) => r.n).length, Object.keys(want).length, `${by}: no other rows with data`);
    };
    check("day", expected.byDay);
    check("model", expected.byModel);
    check("session", expected.bySession);
    check("project", expected.byProject);
    check("week", expected.byWeek);
    const week = groupCells(cells, "week", { idx }).find((r) => r.key === "2026-W41");
    assert.deepEqual([week.from, week.to], ["2026-10-05", "2026-10-11"]);
    const day = (d) => sumCells(cells.filter((c) => c.day === d));
    assert.equal(day("2026-10-07").fresh, expected.today.fresh);
    assert.equal(day("2026-10-07").r, expected.today.r);
    assert.equal(day("2026-10-04").fresh, 24000, "23:59:59 belongs to the 4th");
    assert.equal(day("2026-10-05").fresh, 22000, "00:00:00 belongs to the 5th");
  } finally { box.cleanup(); }
});

test("a request repeated in several records is counted once, with its final numbers", () => {
  const box = sandbox();
  try {
    const s = box.session({ cwd: ALPHA, sid: S1 });
    // Three records, the first two carrying the usage as it stood while streaming.
    s.req({ ts: at(0), model: "claude-opus-5-5", u: usage({ i: 1000, o: 4000, cr: 7000 }), blocks: 3, partial: true, requestId: "req_streamed" });
    const t = totals(build(box).idx);
    assert.equal(t.n, 1);
    assert.equal(t.o, 4000, "the last record's output, not the first record's");
    assert.equal(t.i, 1000);
    assert.equal(t.r, 7000);
  } finally { box.cleanup(); }
});

test("a request without requestId is deduplicated by message id", () => {
  const box = sandbox();
  try {
    const s = box.session({ cwd: ALPHA, sid: S1 });
    for (let k = 0; k < 3; k++) {
      s.write([{ type: "assistant", sessionId: S1, cwd: ALPHA, timestamp: at(0), message: { id: "msg_same", model: "claude-opus-5-5", content: [], usage: usage({ i: 100, o: 10 }) } }]);
    }
    s.write([{ type: "assistant", sessionId: S1, cwd: ALPHA, timestamp: at(0), message: { id: "msg_other", model: "claude-opus-5-5", content: [], usage: usage({ i: 5, o: 1 }) } }]);
    const t = totals(build(box).idx);
    assert.equal(t.n, 2);
    assert.equal(t.i, 105);
  } finally { box.cleanup(); }
});

test("synthetic models and records without usage count for nothing", () => {
  const box = sandbox();
  try {
    const s = box.session({ cwd: ALPHA, sid: S1 });
    s.req({ ts: at(0), model: "<synthetic>", u: usage({ i: 1e6, o: 1e6 }) });
    s.req({ ts: at(0), model: "claude-opus-5-5", u: usage({}) });
    s.write([{ type: "assistant", sessionId: S1, requestId: "req_x", timestamp: at(0), message: { id: "m", model: "claude-opus-5-5", content: [] } }]);
    s.noise();
    assert.equal(totals(build(box).idx).n, 0);
  } finally { box.cleanup(); }
});

test("iterations are summed instead of the top level", () => {
  const box = sandbox();
  try {
    const s = box.session({ cwd: ALPHA, sid: S1 });
    const it = (i, o, cr, cw5, cw1) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw5 + cw1, cache_creation: { ephemeral_5m_input_tokens: cw5, ephemeral_1h_input_tokens: cw1 } });
    s.req({
      ts: at(0), model: "claude-opus-5-5", requestId: "req_it",
      u: usage({ i: 1, o: 1, cr: 1, iterations: [it(100, 10, 1000, 20, 5), it(200, 30, 2000, 0, 15)] }),
    });
    const t = totals(build(box).idx);
    assert.deepEqual([t.i, t.o, t.r, t.w5, t.w1], [300, 40, 3000, 20, 20]);
  } finally { box.cleanup(); }
});

test("cache writes are split by lifetime; without a split they count as 5-minute writes", () => {
  const box = sandbox();
  try {
    const s = box.session({ cwd: ALPHA, sid: S1 });
    s.req({ ts: at(0), model: "claude-opus-5-5", requestId: "req_split", u: usage({ cw5: 1000, cw1: 2000 }) });
    s.req({ ts: at(0), model: "claude-opus-5-5", requestId: "req_nosplit", u: usage({ cw5: 500, noSplit: true }) });
    const t = totals(build(box).idx);
    assert.deepEqual([t.w5, t.w1], [1500, 2000]);
    assert.ok(near(t.cost, (1500 * 5 + 2000 * 8) / 1e6));
  } finally { box.cleanup(); }
});

test("thinking tokens are part of output and reported on their own", () => {
  const box = sandbox();
  try {
    const s = box.session({ cwd: ALPHA, sid: S1 });
    s.req({ ts: at(0), model: "claude-opus-5-5", u: usage({ o: 1000, think: 600 }) });
    const t = totals(build(box).idx);
    assert.equal(t.o, 1000);
    assert.equal(t.th, 600);
    assert.equal(t.fresh, 1000, "thinking is not counted twice");
  } finally { box.cleanup(); }
});

test("subagent files count, under their parent session", () => {
  const box = sandbox();
  try {
    buildFixture(box);
    const { idx } = build(box);
    const s1 = groupCells(cellsOf(idx), "session", { idx }).find((r) => r.key === S1);
    assert.ok(near(s1.agentCost, 0.22), "the subagent's request is in session 1");
    assert.equal(idx.sessions.length, 3, "no session of its own for the agent file");
  } finally { box.cleanup(); }
});

test("session titles: a custom title beats the generated one; the last custom title wins", () => {
  const box = sandbox();
  try {
    buildFixture(box);
    box.session({ cwd: ALPHA, sid: S1 }).title("Fix login (final)");
    const { idx } = build(box);
    const rows = groupCells(cellsOf(idx), "session", { idx });
    assert.equal(rows.find((r) => r.key === S1).title, "Fix login (final)");
    assert.equal(rows.find((r) => r.key === S2).title, "Refactor billing", "only a generated title: that one");
    assert.equal(rows.find((r) => r.key === S3).title, "", "no title at all");
    assert.equal(rows.find((r) => r.key === S3).label, "(untitled)");
  } finally { box.cleanup(); }
});

test("titles lose control characters, so they are safe to print", () => {
  const box = sandbox();
  try {
    const s = box.session({ cwd: ALPHA, sid: S1 });
    s.req({ ts: at(0), model: "claude-opus-5-5", u: usage({ i: 1 }) });
    s.title("evil \u001b[31mred\u001b[0m\u0007 title\nsecond line");
    const { idx } = build(box);
    const title = idx.sessions[0].title;
    assert.equal(title, "evil [31mred [0m title second line");
    assert.doesNotMatch(title, /[\u0000-\u001f\u007f]/);
  } finally { box.cleanup(); }
});

test("a session counts toward the folder of its first main-thread record; folder names come from either path style", () => {
  const box = sandbox();
  try {
    buildFixture(box);
    const { idx } = build(box);
    const rows = groupCells(cellsOf(idx), "project", { idx });
    assert.deepEqual(rows.map((r) => r.label).sort(), ["alpha", "beta"]);
    const s = box.session({ cwd: "C:\\a\\app", sid: uidOf(7) });
    s.req({ ts: at(0), model: "claude-opus-5-5", u: usage({ i: 1 }) });
    const s2 = box.session({ cwd: "/b/app", sid: uidOf(8) });
    s2.req({ ts: at(0), model: "claude-opus-5-5", u: usage({ i: 1 }) });
    const again = build(box).idx;
    const labels = groupCells(cellsOf(again), "project", { idx: again }).map((r) => r.label).sort();
    assert.deepEqual(labels, ["a/app", "alpha", "b/app", "beta"], "two folders named app are told apart by their parent");
  } finally { box.cleanup(); }
});
const uidOf = (n) => `${String(n).padStart(8, "0")}-bbbb-4bbb-8bbb-000000000000`;

test("the index file holds requests keyed by requestId and files with size, mtime, offset and partial", () => {
  const box = sandbox();
  try {
    buildFixture(box);
    build(box);
    const raw = readJson(path.join(box.guard, "index.json"));
    assert.ok(raw.requests.req_R1 && raw.requests.req_R7, "keyed by requestId");
    assert.equal(raw.requests.req_R1[F.I], 100000);
    for (const f of Object.values(raw.files)) {
      for (const k of ["size", "mtimeMs", "offset", "partial"]) assert.ok(k in f, k);
      assert.equal(f.offset, f.size, "everything read");
      assert.equal(f.partial, 0);
    }
    assert.ok(Object.keys(raw.files).some((k) => k.includes("/subagents/agent-a1.jsonl")), "the subagent file is tracked");
    assert.doesNotMatch(JSON.stringify(raw), /never be printed|reasoning that never|secret\/path/, "no prompt, answer or tool text in the index");
  } finally { box.cleanup(); }
});

test("appending to a transcript gives the same index as reading it whole", () => {
  const box = sandbox();
  try {
    const { s1, s2 } = buildFixture(box);
    build(box); // the index now knows everything up to here
    s1.req({ ts: at(0, 13), model: "claude-opus-5-5", u: usage({ i: 1234, o: 567 }), requestId: "req_late" });
    s2.title("Renamed later");
    const incremental = refresh(box.cfg, { now: NOW }); // quick mode, only what changed
    assert.equal(incremental.stats.requests, 1);
    assert.ok(incremental.stats.bytes < 3000, `read ${incremental.stats.bytes} bytes, not the whole file`);
    assert.equal(snapshot(incremental.idx), snapshot(rescan(box)));
  } finally { box.cleanup(); }
});

test("an unfinished last line is left until it is complete, then counted once", () => {
  const box = sandbox();
  try {
    const s = box.session({ cwd: ALPHA, sid: S1 });
    s.req({ ts: at(0), model: "claude-opus-5-5", u: usage({ i: 100 }), requestId: "req_a" });
    const line = JSON.stringify(s.write([]) && {
      type: "assistant", requestId: "req_b", sessionId: S1, cwd: ALPHA, timestamp: at(0, 13),
      message: { id: "msg_b", model: "claude-opus-5-5", content: [], usage: usage({ i: 20 }) },
    });
    const cut = Math.floor(line.length / 2);
    fs.appendFileSync(s.file, line.slice(0, cut)); // the writer is in the middle of a line
    let r = build(box);
    assert.equal(totals(r.idx).i, 100, "the half line is not counted");
    const entry = Object.values(r.idx.files)[0];
    assert.equal(entry.partial, 1);
    assert.ok(entry.offset < entry.size, "the offset stays at the start of the unfinished line");
    // nothing changed on disk: the next run does not read the file again
    r = refresh(box.cfg, { now: NOW });
    assert.equal(r.stats.files, 0);
    fs.appendFileSync(s.file, line.slice(cut) + "\n");
    r = refresh(box.cfg, { now: NOW });
    assert.equal(totals(r.idx).i, 120);
    assert.equal(Object.values(r.idx.files)[0].partial, 0);
    r = refresh(box.cfg, { now: NOW, full: true });
    assert.equal(totals(r.idx).i, 120, "and not counted twice");
  } finally { box.cleanup(); }
});

test("a complete last record that lacks only its newline is counted", () => {
  const box = sandbox();
  try {
    const s = box.session({ cwd: ALPHA, sid: S1 });
    s.req({ ts: at(0), model: "claude-opus-5-5", u: usage({ i: 100 }), requestId: "req_a", eol: false });
    const r = build(box);
    assert.equal(totals(r.idx).i, 100);
    fs.appendFileSync(s.file, "\n");
    s.req({ ts: at(0), model: "claude-opus-5-5", u: usage({ i: 7 }), requestId: "req_b", eol: false });
    assert.equal(totals(refresh(box.cfg, { now: NOW }).idx).i, 107);
    assert.equal(snapshot(refresh(box.cfg, { now: NOW }).idx), snapshot(rescan(box)));
  } finally { box.cleanup(); }
});

test("a file that shrank is read again from the start", () => {
  const box = sandbox();
  try {
    const s = box.session({ cwd: ALPHA, sid: S1 });
    for (let k = 0; k < 6; k++) s.req({ ts: at(0, 8 + k), model: "claude-opus-5-5", u: usage({ i: 1000 * (k + 1) }), requestId: `req_${k}` });
    build(box);
    const lines = fs.readFileSync(s.file, "utf8").split("\n").filter(Boolean);
    fs.writeFileSync(s.file, lines.slice(0, 2).join("\n") + "\n"); // cut down to the first two requests
    const r = refresh(box.cfg, { now: NOW });
    assert.equal(r.stats.resets, 1);
    assert.equal(totals(r.idx).i, 1000 + 2000, "the four requests that are gone from the file are gone from the index");
    assert.equal(snapshot(r.idx), snapshot(rescan(box)));
  } finally { box.cleanup(); }
});

test("a file rewritten with other content is read again, even when it grew", () => {
  const box = sandbox();
  try {
    const s = box.session({ cwd: ALPHA, sid: S1 });
    s.req({ ts: at(0), model: "claude-opus-5-5", u: usage({ i: 100 }), requestId: "req_old" });
    build(box);
    fs.rmSync(s.file);
    for (let k = 0; k < 4; k++) s.req({ ts: at(0, 8 + k), model: "claude-sonnet-5-5", u: usage({ i: 10 }), requestId: `req_new${k}` });
    const r = refresh(box.cfg, { now: NOW });
    assert.equal(r.stats.resets, 1, "the first bytes changed: not the file that was read before");
    assert.equal(totals(r.idx).i, 40);
    assert.equal(snapshot(r.idx), snapshot(rescan(box)));
  } finally { box.cleanup(); }
});

test("new files are picked up by a quick run", () => {
  const box = sandbox();
  try {
    buildFixture(box);
    build(box);
    const fresh = box.session({ cwd: "/home/dev/gamma", sid: uidOf(9) });
    fresh.req({ ts: at(0, 13), model: "claude-opus-5-5", u: usage({ i: 77 }), requestId: "req_g" });
    const agent = box.session({ cwd: ALPHA, sid: S1, agent: "a2" });
    agent.req({ ts: at(0, 13), model: "claude-opus-5-5", u: usage({ i: 33 }), requestId: "req_g2" });
    const r = refresh(box.cfg, { now: NOW });
    assert.equal(totals(r.idx).n, expected.requests + 2);
    assert.equal(snapshot(r.idx), snapshot(rescan(box)));
  } finally { box.cleanup(); }
});

test("a deleted transcript takes its requests with it", () => {
  const box = sandbox();
  try {
    const { s2 } = buildFixture(box);
    build(box);
    fs.rmSync(s2.file);
    const r = refresh(box.cfg, { now: NOW, full: true });
    assert.equal(r.stats.dropped, 1);
    assert.equal(totals(r.idx).n, expected.requests - 1);
    assert.equal(snapshot(r.idx), snapshot(rescan(box)), "the same as a fresh scan of what is left");
    assert.equal(Object.keys(r.idx.files).length, 3);
  } finally { box.cleanup(); }
});

test("a deleted transcript in a quick run is noticed when its file is looked at", () => {
  const box = sandbox();
  try {
    const { s3 } = buildFixture(box);
    build(box);
    fs.rmSync(s3.file);
    const r = refresh(box.cfg, { now: NOW });
    assert.equal(r.stats.dropped, 1);
    assert.equal(snapshot(r.idx), snapshot(rescan(box)));
  } finally { box.cleanup(); }
});

test("a request held by two transcripts (a forked session) is counted once and survives one of them", () => {
  const box = sandbox();
  try {
    const a = box.session({ cwd: ALPHA, sid: S1 });
    const b = box.session({ cwd: ALPHA, sid: S2 }); // the fork: a copy of the same records
    const rid = a.req({ ts: at(0, 9), model: "claude-opus-5-5", u: usage({ i: 100, o: 10 }), requestId: "req_shared" });
    fs.copyFileSync(a.file, b.file);
    let r = build(box);
    assert.equal(totals(r.idx).n, 1);
    assert.equal(totals(r.idx).i, 100, "not 200");
    assert.deepEqual(r.idx.requests[rid][F.OW].length, 2, "held by both files");
    fs.rmSync(a.file);
    r = refresh(box.cfg, { now: NOW, full: true });
    assert.equal(totals(r.idx).n, 1, "still in the fork");
    assert.equal(snapshot(r.idx), snapshot(rescan(box)));
    fs.rmSync(b.file);
    r = refresh(box.cfg, { now: NOW, full: true });
    assert.equal(totals(r.idx).n, 0, "in neither");
  } finally { box.cleanup(); }
});

test("spending older than 20 days outlives its transcript: Claude Code deletes old transcripts, the money was spent", () => {
  const box = sandbox();
  try {
    const old = box.session({ cwd: ALPHA, sid: S1 });
    old.req({ ts: at(-25, 10), model: "claude-opus-5-5", u: usage({ i: 1000 }), requestId: "req_old" });
    const young = box.session({ cwd: ALPHA, sid: S2 });
    young.req({ ts: at(-10, 10), model: "claude-opus-5-5", u: usage({ i: 100 }), requestId: "req_young" });
    build(box);
    fs.rmSync(old.file);
    fs.rmSync(young.file);
    const r = refresh(box.cfg, { now: NOW, full: true });
    assert.equal(totals(r.idx).i, 1000, "the 25 day old request stays, the 10 day old one goes with its file");
    // and when it is old enough it is folded into a daily total
    const later = refresh(box.cfg, { now: NOW + 20 * 864e5, full: true }).idx;
    assert.equal(Object.keys(later.requests).length, 0);
    const folded = buildCells(later, { fromDay: "2026-08-01", toDay: "2026-11-30" });
    assert.equal(sumCells(folded).i, 1000);
  } finally { box.cleanup(); }
});

test("a small time budget reads part of the files; repeated runs finish with the same index", () => {
  const box = sandbox();
  try {
    buildFixture(box);
    for (let k = 0; k < 8; k++) {
      const s = box.session({ cwd: `/work/p${k}`, sid: uidOf(20 + k) });
      for (let j = 0; j < 5; j++) s.req({ ts: at(-(k % 4), 8 + j), model: "claude-opus-5-5", u: usage({ i: 10 * (j + 1), o: j }), requestId: `req_b${k}_${j}` });
    }
    const whole = rescan(box);
    let r = refresh(box.cfg, { now: NOW, full: true, budgetMs: 0, chunk: 512 });
    assert.equal(r.stats.stopped, true);
    assert.ok(r.stats.pending > 0, "something is left for next time");
    assert.ok(totals(r.idx).n < totals(whole).n, "not everything yet");
    let runs = 1;
    while (r.stats.pending > 0 && runs < 500) { r = refresh(box.cfg, { now: NOW, budgetMs: 0, chunk: 512 }); runs++; }
    assert.equal(r.stats.pending, 0);
    assert.ok(runs > 2, `${runs} runs`);
    assert.equal(snapshot(r.idx), snapshot(whole));
  } finally { box.cleanup(); }
});

test("with a small budget the newest transcripts are read first", () => {
  const box = sandbox();
  try {
    const oldS = box.session({ cwd: "/work/old", sid: uidOf(31) });
    const newS = box.session({ cwd: "/work/new", sid: uidOf(32) });
    oldS.req({ ts: at(-3), model: "claude-opus-5-5", u: usage({ i: 1 }), requestId: "req_o" });
    newS.req({ ts: at(0), model: "claude-opus-5-5", u: usage({ i: 2 }), requestId: "req_n" });
    ageFile(oldS.file, NOW, 3);
    ageFile(newS.file, NOW, 0);
    const r = refresh(box.cfg, { now: NOW, full: true, budgetMs: 0 });
    assert.equal(r.stats.stopped, true);
    assert.ok(r.idx.requests.req_n, "today's file first");
    assert.equal(r.idx.requests.req_o, undefined);
  } finally { box.cleanup(); }
});

test("a transcript far larger than the read chunk is read in pieces", () => {
  const box = sandbox();
  try {
    const s = box.session({ cwd: ALPHA, sid: S1 });
    for (let k = 0; k < 60; k++) s.req({ ts: at(0, 8), model: "claude-opus-5-5", u: usage({ i: k + 1 }), requestId: `req_c${k}`, blocks: 2 });
    const small = refresh(box.cfg, { now: NOW, full: true, chunk: 700 }).idx;
    const t = totals(small);
    assert.equal(t.n, 60);
    assert.equal(t.i, (60 * 61) / 2);
    assert.equal(snapshot(small), snapshot(rescan(box)));
  } finally { box.cleanup(); }
});

test("a single record longer than the chunk, and multi-byte characters across chunk edges", () => {
  const box = sandbox();
  try {
    const s = box.session({ cwd: ALPHA, sid: S1 });
    const big = "x".repeat(5000);
    s.write([{
      type: "assistant", requestId: "req_big", sessionId: S1, cwd: ALPHA, timestamp: at(0),
      message: { id: "msg_big", model: "claude-opus-5-5", content: [{ type: "text", text: big }], usage: usage({ i: 11 }) },
    }]);
    for (let k = 0; k < 20; k++) s.req({ ts: at(0), model: "claude-opus-5-5", u: usage({ i: 1 }), requestId: `req_e${k}`, extra: { note: "日本語 café ☕ ".repeat(7) } });
    s.title("日本語のタイトル ☕");
    for (const chunk of [101, 257, 1000, 4096]) {
      const idx = refresh(box.cfg, { now: NOW, full: true, chunk, projectsDir: s.box.projects, ...{} }).idx;
      assert.equal(totals(idx).i, 11 + 20, `chunk ${chunk}`);
      const other = sandbox();
      try {
        const fresh = refresh(other.cfg, { now: NOW, full: true, chunk, projectsDir: box.projects }).idx;
        assert.equal(fresh.sessions[0].title, "日本語のタイトル ☕", `chunk ${chunk}: the title survives intact`);
        assert.equal(totals(fresh).i, 31);
      } finally { other.cleanup(); }
    }
  } finally { box.cleanup(); }
});

test("tool-result folders and files that are not transcripts are ignored", () => {
  const box = sandbox();
  try {
    buildFixture(box);
    const trDir = path.join(box.projects, "x", S1, "tool-results");
    fs.mkdirSync(trDir, { recursive: true });
    fs.writeFileSync(path.join(trDir, "big.jsonl"), JSON.stringify({ type: "assistant", requestId: "req_trap", sessionId: S1, timestamp: at(0), message: { id: "m", model: "claude-opus-5-5", content: [], usage: usage({ i: 5e9 }) } }) + "\n");
    fs.writeFileSync(path.join(box.projects, "x", "notes.txt"), "not a transcript");
    fs.writeFileSync(path.join(box.projects, "stray.jsonl"), JSON.stringify({ type: "assistant", requestId: "req_stray", sessionId: S1, timestamp: at(0), message: { id: "m2", model: "claude-opus-5-5", content: [], usage: usage({ i: 5 }) } }) + "\n");
    const { idx } = build(box);
    assert.equal(idx.requests.req_trap, undefined);
    assert.equal(idx.requests.req_stray, undefined, "only files inside a project folder");
    assert.equal(totals(idx).n, expected.requests);
  } finally { box.cleanup(); }
});

test("ids that are object keys with special meaning do not break the index", () => {
  const box = sandbox();
  try {
    const s = box.session({ cwd: ALPHA, sid: S1 });
    for (const rid of ["__proto__", "constructor", "toString", "hasOwnProperty", "0"]) {
      s.req({ ts: at(0), model: "claude-opus-5-5", u: usage({ i: 10 }), requestId: rid });
    }
    s.req({ ts: at(0), model: "claude-opus-5-5", u: usage({ i: 10 }), requestId: "constructor" }); // a repeat
    const { idx } = build(box);
    assert.equal(totals(idx).n, 4, "__proto__ is refused, the others count once");
    assert.equal(totals(idx).i, 40);
    assert.equal(Object.getPrototypeOf(idx.requests), Object.prototype);
    assert.equal(snapshot(loadIndex(box.cfg)), snapshot(idx), "and they survive a save and load");
  } finally { box.cleanup(); }
});

test("a corrupt index is rebuilt and the problem is logged", () => {
  const box = sandbox();
  try {
    buildFixture(box);
    build(box);
    fs.writeFileSync(path.join(box.guard, "index.json"), '{"v":1,"files":{');
    const r = refresh(box.cfg, { now: NOW });
    assert.equal(totals(r.idx).n, expected.requests, "read from the transcripts again");
    assert.match(fs.readFileSync(path.join(box.guard, "errors.log"), "utf8"), /index\.json could not be read/);
    fs.writeFileSync(path.join(box.guard, "index.json"), JSON.stringify({ v: 99, files: {} }));
    assert.equal(totals(refresh(box.cfg, { now: NOW }).idx).n, expected.requests, "an index of another version too");
  } finally { box.cleanup(); }
});

test("a subagent file belongs to the session whose folder it sits in, whatever its records call themselves", () => {
  const box = sandbox();
  try {
    const main = box.session({ cwd: ALPHA, sid: S1 });
    main.title("Parent session");
    main.req({ ts: at(0, 9), model: "claude-opus-5-5", u: usage({ i: 100 }), requestId: "req_parent" });
    const agent = box.session({ cwd: "/somewhere/else", sid: S1, agent: "x1" });
    // records that name an agent id as their session, as an unfamiliar Claude Code version might write them
    agent.write([{
      type: "assistant", isSidechain: true, requestId: "req_child", sessionId: "agent-x1", cwd: "/somewhere/else", timestamp: at(0, 10),
      message: { id: "msg_child", model: "claude-opus-5-5", content: [], usage: usage({ i: 50 }) },
    }]);
    const { idx } = build(box);
    assert.deepEqual(idx.sessions.map((s) => s.id), [S1], "one session, not two");
    const rows = groupCells(cellsOf(idx), "session", { idx });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].i, 150);
    assert.equal(rows[0].title, "Parent session");
    assert.equal(idx.sessions[0].cwd, ALPHA, "and its folder is the main thread's, not the subagent's");
  } finally { box.cleanup(); }
});

test("a file edited in place after its first bytes, so that it grew and its lines moved, is read again", () => {
  const box = sandbox();
  try {
    const s = box.session({ cwd: ALPHA, sid: S1 });
    for (let k = 0; k < 5; k++) s.req({ ts: at(0, 8 + k), model: "claude-opus-5-5", u: usage({ i: 100 * (k + 1) }), requestId: `req_e${k}` });
    build(box);
    const lines = fs.readFileSync(s.file, "utf8").split("\n").filter(Boolean);
    // the first record is untouched (so the file still starts the same way); the second grows, which shifts everything after it
    const second = JSON.parse(lines[1]);
    second.padding = "x".repeat(700);
    second.message.usage = usage({ i: 222 });
    const edited = [lines[0], JSON.stringify(second), ...lines.slice(2, 4)];
    fs.writeFileSync(s.file, edited.join("\n") + "\n");
    assert.ok(fs.statSync(s.file).size > JSON.stringify(lines).length * 0.4);
    const r = refresh(box.cfg, { now: NOW });
    assert.equal(r.stats.resets, 1, "the byte before the old offset is not the end of a line any more");
    assert.equal(snapshot(r.idx), snapshot(rescan(box)));
    assert.equal(totals(r.idx).n, 4, "the fifth request is gone from the file, so from the index");
  } finally { box.cleanup(); }
});

test("a last record that lacked its newline, completed later, does not make the file be read again", () => {
  const box = sandbox();
  try {
    const s = box.session({ cwd: ALPHA, sid: S1 });
    s.req({ ts: at(0), model: "claude-opus-5-5", u: usage({ i: 10 }), requestId: "req_a" });
    s.req({ ts: at(0), model: "claude-opus-5-5", u: usage({ i: 20 }), requestId: "req_b", eol: false });
    assert.equal(totals(build(box).idx).i, 30);
    fs.appendFileSync(s.file, "\n");
    let r = refresh(box.cfg, { now: NOW });
    assert.equal(r.stats.resets, 0);
    s.req({ ts: at(0), model: "claude-opus-5-5", u: usage({ i: 5 }), requestId: "req_c" });
    r = refresh(box.cfg, { now: NOW });
    assert.equal(r.stats.resets, 0, "the boundary check understands a record that was read before its newline arrived");
    assert.equal(totals(r.idx).i, 35);
    assert.equal(r.stats.requests, 1, "and only the new record was read");
  } finally { box.cleanup(); }
});
