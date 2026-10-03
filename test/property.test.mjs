// Randomized differential test: for many seeded random sets of transcripts, feeding the indexer the bytes in random
// slices (mid-line and mid-character included), with random time budgets and chunk sizes, must give the numbers an
// independent oracle computes from the requests that were generated, and must equal a fresh full scan.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { refresh } from "../src/index.mjs";
import { costOf } from "../src/prices.mjs";
import { buildCells } from "../src/usage.mjs";
import { dayKeyOf } from "../src/util.mjs";
import { NOW, at, sandbox, slugOf, uid } from "./helpers.mjs";

function rng(seed) {
  let s = (seed * 2654435761) >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001", "claude-opus-4-6", "claude-fable-5-1", "claude-opus-5-5-20261001", "unknown-model-7"];
const PRICED_AS = (m) => (m.startsWith("claude-opus-5-5") ? "claude-opus-5-5" : m);

// One random world: the transcript files (as text), and the cells an honest reader must get from them.
function world(seed) {
  const R = rng(seed);
  const pick = (xs) => xs[Math.floor(R() * xs.length)];
  const int = (lo, hi) => lo + Math.floor(R() * (hi - lo + 1));
  const cwds = ["D:\\work\\alpha", "/home/dev/beta", "/srv/gamma app", "C:\\Users\\x\\delta"].slice(0, int(2, 4));
  const files = []; // {rel, text}
  const requests = new Map(); // requestId -> {tok, model, ts, sid, cwd, agent}
  const sessions = [];
  for (let s = 0; s < int(2, 6); s++) sessions.push({ sid: uid(500 + seed * 10 + s), cwd: pick(cwds), title: R() < 0.5 ? `Title ${seed}-${s} ☕ 日本語` : "" });

  const mkUsage = () => {
    const kind = R();
    const o = int(0, 5000);
    if (kind < 0.25) { // iterations: the top level is noise and must be ignored
      const its = Array.from({ length: int(1, 3) }, () => ({ input_tokens: int(0, 900), output_tokens: int(0, 900), cache_read_input_tokens: int(0, 90000), cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: int(0, 5000), ephemeral_1h_input_tokens: int(0, 3000) } }));
      for (const it of its) it.cache_creation_input_tokens = it.cache_creation.ephemeral_5m_input_tokens + it.cache_creation.ephemeral_1h_input_tokens;
      return { raw: { input_tokens: 77777, output_tokens: 77777, cache_read_input_tokens: 77777, cache_creation_input_tokens: 77777, iterations: its }, tok: its.reduce((a, it) => [a[0] + it.input_tokens, a[1] + it.output_tokens, a[2] + it.cache_creation.ephemeral_5m_input_tokens, a[3] + it.cache_creation.ephemeral_1h_input_tokens, a[4] + it.cache_read_input_tokens, 0], [0, 0, 0, 0, 0, 0]) };
    }
    const i = int(0, 3000), cr = int(0, 200000), w5 = int(0, 20000), w1 = R() < 0.3 ? int(0, 9000) : 0;
    const think = R() < 0.3 ? int(0, o) : 0;
    const raw = { input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: w5 + w1 };
    if (think) raw.output_tokens_details = { thinking_tokens: think };
    if (R() < 0.7) { raw.cache_creation = { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 }; return { raw, tok: [i, o, w5, w1, cr, think] }; }
    return { raw, tok: [i, o, w5 + w1, 0, cr, think] }; // no split: all of it counts as a 5 minute write
  };

  let n = 0;
  const lineFor = (rid, q, b, blocks, sid, agent, partial) => {
    const raw = partial && b < blocks - 1 ? { ...q.raw, output_tokens: Math.min(q.raw.output_tokens || 0, b + 1), iterations: undefined } : q.raw;
    // an early streamed record of an iterations request shows less: it carries only the first iteration
    const use = partial && b < blocks - 1 && q.raw.iterations ? { ...q.raw, iterations: q.raw.iterations.slice(0, 1) } : raw;
    return JSON.stringify({ type: "assistant", requestId: rid, sessionId: sid, cwd: q.cwd, isSidechain: agent, timestamp: new Date(Date.parse(q.iso) + b * 1000).toISOString(), uuid: `${rid}-${b}`, message: { id: `msg_${rid}`, model: q.model, role: "assistant", content: [{ type: "text", text: `answer text ${n}` }], usage: use } });
  };
  for (const ses of sessions) {
    const main = [];
    const agentFiles = new Map();
    if (ses.title) { main.push(JSON.stringify({ type: "ai-title", sessionId: ses.sid, aiTitle: ses.title })); }
    for (let k = 0; k < int(3, 25); k++) {
      const agent = R() < 0.2;
      const rid = `req_${seed}_${n++}`;
      const q = { ...mkUsage(), model: pick(MODELS), iso: R() < 0.25 ? at(-int(0, 19), 23, 59, 59 - int(0, 1)) : at(-int(0, 19), int(0, 23), int(0, 59), int(0, 59)), cwd: ses.cwd };
      const synthetic = R() < 0.05;
      const blocks = int(1, 3);
      const target = agent ? (agentFiles.get(k % 2) || agentFiles.set(k % 2, []).get(k % 2)) : main;
      const named = agent && R() < 0.5 ? `agent-${seed}-${k}` : ses.sid;
      for (let b = 0; b < blocks; b++) target.push(lineFor(rid, synthetic ? { ...q, model: "<synthetic>" } : q, b, blocks, named, agent, true));
      if (R() < 0.3) target.push(JSON.stringify({ type: "user", sessionId: ses.sid, message: { role: "user", content: [{ type: "tool_result", content: 'mentions "usage" and assistant' }] } }));
      if (!synthetic && q.tok.slice(0, 5).some((x) => x > 0)) requests.set(rid, { tok: q.tok, model: q.model, iso: q.iso, sid: ses.sid, cwd: ses.cwd, agent: agent ? 1 : 0 });
      ses.last = rid;
    }
    if (R() < 0.5) main.push(JSON.stringify({ type: "custom-title", sessionId: ses.sid, customTitle: `Renamed ${ses.sid.slice(0, 4)} ☕` }));
    files.push({ rel: `${slugOf(ses.cwd)}/${ses.sid}.jsonl`, lines: main, ses });
    for (const [a, lines] of agentFiles) files.push({ rel: `${slugOf(ses.cwd)}/${ses.sid}/subagents/agent-a${a}.jsonl`, lines, ses });
  }
  // a fork: a second main file that repeats some of the first session's records
  if (R() < 0.6 && files.length) {
    const src = files.find((f) => f.rel.endsWith(`${sessions[0].sid}.jsonl`));
    const copied = src.lines.filter((l) => l.includes('"type":"assistant"') && R() < 0.5);
    if (copied.length) files.push({ rel: `${slugOf(sessions[0].cwd)}/${uid(900 + seed)}.jsonl`, lines: copied, ses: sessions[0] });
  }
  return { files: files.map((f) => ({ rel: f.rel, text: f.lines.join("\n") + (R() < 0.8 ? "\n" : "") })), requests, sessions };
}

function oracleCells(w) {
  const m = new Map();
  for (const q of w.requests.values()) {
    const day = dayKeyOf(Date.parse(q.iso));
    const key = [day, q.cwd, q.sid, q.model, q.agent].join("\u0001");
    const c = m.get(key) || { day, cwd: q.cwd, sid: q.sid, model: q.model, agent: q.agent, n: 0, i: 0, o: 0, w5: 0, w1: 0, r: 0, th: 0 };
    c.n++; c.i += q.tok[0]; c.o += q.tok[1]; c.w5 += q.tok[2]; c.w1 += q.tok[3]; c.r += q.tok[4]; c.th += Math.min(q.tok[5], q.tok[1]);
    m.set(key, c);
  }
  return [...m.values()];
}
// the rows as sorted text: the order of rows is the product's business, what they hold is what is checked
const shape = (cells) => cells.map((c) => [c.day, c.cwd, c.sid, c.model, c.agent, c.n, c.i, c.o, c.w5, c.w1, c.r, c.th].join("|")).sort();
const RANGE = { fromDay: "2026-08-01", toDay: "2026-10-07" };

test("random transcripts, fed in random slices, give the oracle's numbers and a full scan's numbers", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const w = world(seed);
    const R = rng(seed + 1000);
    const box = sandbox();
    try {
      // write every file's bytes in random slices, in random order, running the indexer now and then
      const queue = w.files.map((f) => ({ file: path.join(box.projects, ...f.rel.split("/")), buf: Buffer.from(f.text), at: 0 }));
      for (const q of queue) fs.mkdirSync(path.dirname(q.file), { recursive: true });
      let steps = 0;
      while (queue.some((q) => q.at < q.buf.length)) {
        const q = queue[Math.floor(R() * queue.length)];
        if (q.at >= q.buf.length) continue;
        const take = R() < 0.15 ? q.buf.length - q.at : 1 + Math.floor(R() * Math.max(2, q.buf.length / 3));
        const slice = q.buf.subarray(q.at, Math.min(q.buf.length, q.at + take));
        fs.appendFileSync(q.file, slice);
        const t = new Date(NOW + ++steps * 1000);
        fs.utimesSync(q.file, t, t);
        q.at += slice.length;
        if (R() < 0.5) refresh(box.cfg, { now: NOW, budgetMs: R() < 0.5 ? 0 : Infinity, chunk: R() < 0.5 ? 64 + Math.floor(R() * 500) : undefined, full: R() < 0.2 });
      }
      let r = refresh(box.cfg, { now: NOW, full: true });
      for (let guard = 0; r.stats.pending > 0 && guard < 200; guard++) r = refresh(box.cfg, { now: NOW, full: true });
      assert.equal(r.stats.pending, 0, `seed ${seed}`);
      const incremental = buildCells(r.idx, RANGE);

      const other = sandbox();
      try {
        const fresh = buildCells(refresh(other.cfg, { now: NOW, full: true, projectsDir: box.projects }).idx, RANGE);
        assert.deepEqual(shape(incremental), shape(fresh), `seed ${seed}: incremental equals a fresh full scan`);
      } finally { other.cleanup(); }

      const expected = oracleCells(w);
      assert.deepEqual(shape(incremental), shape(expected), `seed ${seed}: equals the oracle`);
      // dollars: every cell's cost is the price table applied to its tokens
      for (const c of incremental) {
        const want = costOf(PRICED_AS(c.model), c.i, c.o, c.w5, c.w1, c.r);
        assert.ok(Math.abs(c.cost - want) < 1e-9, `seed ${seed}: cost of ${c.model}`);
      }
      assert.equal(Object.keys(r.idx.requests).length, w.requests.size, `seed ${seed}: one entry per distinct request`);
    } finally { box.cleanup(); }
  }
});
