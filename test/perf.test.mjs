// Speed, on a generated set of about 50 MB of transcripts (set COST_GUARD_PERF_MB to change the size):
// a full index in seconds, then runs that read only what is new in milliseconds. The numbers are printed
// as test diagnostics. The limits asserted are loose enough for a busy CI machine; the measured values are the point.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { refresh } from "../src/index.mjs";
import { saveBudgets } from "../src/budgets.mjs";
import { costOf } from "../src/prices.mjs";
import { buildCells, sumCells } from "../src/usage.mjs";
import { NOW, at, runGuard, sandbox, slugOf, uid } from "./helpers.mjs";

const MB = Number(process.env.COST_GUARD_PERF_MB) || 50;
const note = (t, msg) => (typeof t.diagnostic === "function" ? t.diagnostic(msg) : console.log(msg));

// A small deterministic random source, so every run builds the same files.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const WORDS = "the quick brown fox jumps over a lazy dog while reading files and running tests in the repository then edits code to fix a failing build".split(" ");
function lorem(rand, chars) {
  let out = "";
  while (out.length < chars) out += `${WORDS[Math.floor(rand() * WORDS.length)]} `;
  return out.slice(0, chars);
}
const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001", "claude-opus-4-6", "claude-fable-5-1"];

/**
 * Write transcripts shaped like the real ones until `targetBytes` are on disk: main files and subagent files in
 * several projects, assistant records that repeat a request over 1 to 3 records and carry thinking, text and tool
 * calls, user records with tool results of every size (some mentioning "usage" and "assistant" to look like requests),
 * and titles. Returns the totals the index must come to.
 */
function generate(box, targetBytes, { dense = false } = {}) {
  const rand = rng(42);
  const want = { n: 0, fresh: 0, cost: 0, files: 0, bytes: 0 };
  const seen = new Set();
  const projects = Array.from({ length: 12 }, (_, k) => `/home/dev/proj${k}`);
  const pad = (n) => String(n).padStart(8, "0");
  let reqNo = 0;
  let fileNo = 0;
  while (want.bytes < targetBytes) {
    const cwd = projects[Math.floor(rand() * projects.length)];
    const sid = uid(1000 + fileNo);
    const main = box.session({ cwd, sid });
    const agents = Array.from({ length: Math.floor(rand() * 5) }, (_, a) => box.session({ cwd, sid, agent: `${pad(fileNo)}${a}` }));
    const daysAgo = Math.floor(rand() * 30);
    for (const s of [main, ...agents]) {
      const records = [];
      const turns = s === main ? 40 + Math.floor(rand() * 260) : 5 + Math.floor(rand() * 40);
      for (let turn = 0; turn < turns; turn++) {
        const rid = `req_${pad(++reqNo)}`;
        const model = MODELS[Math.floor(rand() * MODELS.length)];
        const u = { input_tokens: Math.floor(rand() * 3000), output_tokens: 50 + Math.floor(rand() * 4000), cache_read_input_tokens: Math.floor(rand() * 150000), cache_creation_input_tokens: 0 };
        const w5 = Math.floor(rand() * 20000);
        const w1 = rand() < 0.2 ? Math.floor(rand() * 8000) : 0;
        u.cache_creation_input_tokens = w5 + w1;
        u.cache_creation = { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 };
        u.output_tokens_details = { thinking_tokens: Math.floor(u.output_tokens * rand() * 0.6) };
        const ts = at(-daysAgo, 8 + Math.floor((turn * 12) / turns), turn % 60, turn % 60);
        const blocks = 1 + Math.floor(rand() * 3);
        for (let b = 0; b < blocks; b++) {
          records.push(JSON.stringify({
            parentUuid: `${rid}-p${b}`, isSidechain: s !== main, userType: "external", cwd, sessionId: sid, version: "2.1.286", gitBranch: "main",
            type: "assistant", requestId: rid, uuid: `${rid}-u${b}`, timestamp: ts,
            message: {
              id: `msg_${rid.slice(4)}`, type: "message", role: "assistant", model,
              content: [
                { type: "thinking", thinking: lorem(rand, dense ? 60 + Math.floor(rand() * 200) : 600 + Math.floor(rand() * 1800)), signature: lorem(rand, dense ? 120 : 300).replace(/ /g, "A") },
                { type: "text", text: lorem(rand, dense ? 40 + Math.floor(rand() * 200) : 200 + Math.floor(rand() * 1500)) },
                { type: "tool_use", id: `toolu_${rid}`, name: "Bash", input: { command: lorem(rand, 120), description: lorem(rand, 40) } },
              ].slice(b === blocks - 1 ? 1 : 0, b === blocks - 1 ? 3 : 2),
              stop_reason: b === blocks - 1 ? "tool_use" : null, stop_sequence: null, usage: u,
            },
          }));
        }
        if (!seen.has(rid)) {
          seen.add(rid);
          want.n++;
          want.fresh += u.input_tokens + u.output_tokens + w5 + w1;
          want.cost += costOf(model, u.input_tokens, u.output_tokens, w5, w1, u.cache_read_input_tokens);
        }
        // the tool result that follows: mostly small, now and then very large, sometimes mentioning "usage" and "assistant"
        const size = dense ? 80 + Math.floor(rand() * 500) : rand() < 0.04 ? 60000 + Math.floor(rand() * 240000) : 200 + Math.floor(rand() * 6000);
        const mention = rand() < 0.1 ? ' {"usage": {"input_tokens": 1}, "role": "assistant"} ' : "";
        records.push(JSON.stringify({
          parentUuid: `${rid}-u0`, isSidechain: s !== main, type: "user", sessionId: sid, uuid: `${rid}-r`, timestamp: ts,
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${rid}`, content: mention + lorem(rand, size) }] },
          toolUseResult: { stdout: lorem(rand, 80) },
        }));
      }
      if (s === main) records.push(JSON.stringify({ type: "custom-title", customTitle: `Session ${fileNo} about ${lorem(rand, 20).trim()}`, sessionId: sid }));
      const text = records.join("\n") + "\n";
      fs.writeFileSync(s.file, text);
      want.bytes += Buffer.byteLength(text);
      want.files++;
      // as written then: the file's last change was on its last day
      const last = new Date(NOW - daysAgo * 864e5);
      fs.utimesSync(s.file, last, last);
    }
    fileNo++;
  }
  return want;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function scenario(t, { dense }) {
  const box = sandbox();
  try {
    const t0 = performance.now();
    const want = generate(box, MB * 1024 * 1024, { dense });
    note(t, `generated ${(want.bytes / 1048576).toFixed(1)} MB in ${want.files} files, ${want.n} requests (${(performance.now() - t0).toFixed(0)} ms)`);

    // 1. the first full index
    const f0 = performance.now();
    const first = refresh(box.cfg, { now: NOW, full: true });
    const full = performance.now() - f0;
    note(t, `full index: ${full.toFixed(0)} ms (${(want.bytes / 1048576 / (full / 1000)).toFixed(0)} MB/s), ${Object.keys(first.idx.requests).length} requests`);
    assert.ok(full < 8000, `${full.toFixed(0)} ms`);
    assert.equal(first.stats.files, want.files);
    assert.equal(first.stats.bytes, want.bytes, "every byte read exactly once");
    assert.equal(Object.keys(first.idx.requests).length, want.n);
    const cells = buildCells(first.idx, { fromDay: "2026-08-01", toDay: "2026-10-07" });
    const total = sumCells(cells);
    assert.equal(total.n, want.n);
    assert.equal(total.i + total.o + total.w5 + total.w1, want.fresh, "the fresh tokens of the whole set, to the token");
    assert.ok(Math.abs(total.cost - want.cost) < 1e-6 * want.cost, `${total.cost} vs ${want.cost}`);
    const indexBytes = fs.statSync(path.join(box.guard, "index.json")).size;
    note(t, `index.json: ${(indexBytes / 1024).toFixed(0)} KB for ${want.n} requests (${(indexBytes / want.n).toFixed(0)} bytes each)`);
    assert.ok(indexBytes < want.n * 200, "a small fraction of the transcripts");

    // 2. nothing new: a quick run reads nothing and writes nothing
    const before = fs.statSync(path.join(box.guard, "index.json")).mtimeMs;
    const idle = [];
    for (let k = 0; k < 7; k++) { const s0 = performance.now(); const r = refresh(box.cfg, { now: NOW }); idle.push(performance.now() - s0); assert.equal(r.stats.files, 0); }
    assert.equal(fs.statSync(path.join(box.guard, "index.json")).mtimeMs, before, "the index file was not rewritten");
    note(t, `quick run with nothing new: median ${median(idle).toFixed(1)} ms`);

    // 3. a few records arrive in the current session: only they are read
    const current = box.session({ cwd: "/home/dev/proj0", sid: uid(1000) });
    const inc = [];
    for (let k = 0; k < 7; k++) {
      current.req({ ts: at(0, 11, k), model: "claude-opus-5-5", u: { input_tokens: 10, output_tokens: 5 }, requestId: `req_live${k}` });
      const s0 = performance.now();
      const r = refresh(box.cfg, { now: NOW, priority: [current.file] });
      inc.push(performance.now() - s0);
      assert.equal(r.stats.requests, 1);
      assert.ok(r.stats.bytes < 5000, `${r.stats.bytes} bytes`);
    }
    note(t, `incremental run, one new request: median ${median(inc).toFixed(1)} ms (max ${Math.max(...inc).toFixed(1)})`);
    assert.ok(median(inc) < 150, `${median(inc).toFixed(0)} ms`);

    // 4. the whole hook, as a process, with a budget set (this is what a prompt costs)
    saveBudgets(box.cfg, { version: 1, global: { daily: { unit: "usd", amount: 1e9 }, weekly: { unit: "usd", amount: 1e9 }, mode: "soft" }, projects: [] });
    const walls = [];
    for (let k = 0; k < 9; k++) {
      current.req({ ts: at(0, 12, k), model: "claude-opus-5-5", u: { input_tokens: 10, output_tokens: 5 }, requestId: `req_hook${k}` });
      const r = runGuard(box, { hook_event_name: "UserPromptSubmit", cwd: "/home/dev/proj0", transcript_path: current.file, prompt: "x", source: "user" });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, "", "far below any budget: silent");
      walls.push(r.ms);
    }
    note(t, `hook process (node start included), warm index: median ${median(walls).toFixed(0)} ms, max ${Math.max(...walls).toFixed(0)} ms`);
    assert.ok(median(walls) < 1000, `${median(walls).toFixed(0)} ms`);
    const final = refresh(box.cfg, { now: NOW, full: true });
    assert.equal(Object.keys(final.idx.requests).length, want.n + 7 + 9, "and the hook runs lost nothing");
  } finally { box.cleanup(); }
}

test(`about ${MB} MB of transcripts with large tool results: a full index in seconds, then runs that read only what is new in milliseconds`, (t) => scenario(t, { dense: false }));
test(`about ${MB} MB of request-dense transcripts (many small records): the same, with a much larger index`, (t) => scenario(t, { dense: true }));

test("a first hook run on a large history reads what it can within its time budget and finishes over the next runs", (t) => {
  const box = sandbox();
  try {
    const want = generate(box, Math.min(MB, 20) * 1024 * 1024);
    let r = refresh(box.cfg, { now: NOW, budgetMs: 5 });
    note(t, `first run, budget 5 ms: read ${(r.stats.bytes / 1048576).toFixed(1)} of ${(want.bytes / 1048576).toFixed(1)} MB in ${r.stats.ms.toFixed(0)} ms, ${r.stats.pending} files left`);
    assert.equal(r.stats.stopped, true, "20 MB cannot be read in 5 ms");
    assert.ok(r.stats.pending > 0);
    assert.ok(r.stats.bytes >= 1, "but progress is always made");
    assert.ok(r.stats.ms < 400, `the budget is checked between 1 MB chunks: ${r.stats.ms.toFixed(0)} ms`);
    let runs = 1;
    while (r.stats.pending > 0 && runs < 2000) { r = refresh(box.cfg, { now: NOW, budgetMs: 5 }); runs++; }
    note(t, `finished after ${runs} runs`);
    assert.equal(r.stats.pending, 0);
    assert.ok(runs > 5);
    assert.equal(Object.keys(r.idx.requests).length, want.n, "the same requests as one full run");
    const total = sumCells(buildCells(r.idx, { fromDay: "2026-08-01", toDay: "2026-10-07" }));
    assert.equal(total.i + total.o + total.w5 + total.w1, want.fresh);
  } finally { box.cleanup(); }
});
