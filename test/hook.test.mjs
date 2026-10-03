// The hook: what it says, when, and that it never says anything else or fails a session.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { blockReason, messageLines, plan, runHook, toAsciiJson } from "../src/hook.mjs";
import { loadBudgets, saveBudgets, setBudget, extendBudget } from "../src/budgets.mjs";
import { refresh } from "../src/index.mjs";
import { ALPHA, BETA, NOW, S1, at, buildFixture, ls, readJson, sandbox, usage } from "./helpers.mjs";

const TODAY = "2026-10-07";
const usd = (n) => ({ unit: "usd", amount: n });
const tok = (n) => ({ unit: "tokens", amount: n });
// Today's fresh tokens in the reference data set are 2,710,000 and this week's 2,792,000; today's cost is $9.52.
const DAY_TOKENS = 2710000;

function budgets(box, spec) {
  const b = { version: 1, global: null, projects: [] };
  if (spec.global) setBudget(b, spec.global);
  for (const p of spec.projects || []) setBudget(b, p);
  saveBudgets(box.cfg, b);
  return b;
}
const input = (extra = {}) => ({ hook_event_name: "UserPromptSubmit", session_id: "sess", cwd: ALPHA, prompt: "do the thing", source: "user", ...extra });
async function hook(box, extra, { now = box.now, env = {} } = {}) {
  const stdin = typeof extra === "string" ? extra : JSON.stringify(input(extra));
  return runHook({ env: { ...box.env, ...env }, stdin, now });
}
const say = async (box, extra, opts) => {
  const r = await hook(box, extra, opts);
  return r.output === null ? null : JSON.parse(r.output);
};
const marks = (box) => readJson(path.join(box.guard, "state.json"));
function world(spec) {
  const box = sandbox();
  buildFixture(box);
  refresh(box.cfg, { now: NOW, full: true });
  if (spec) budgets(box, spec);
  return box;
}

test("with no budget the hook does nothing at all: no output, no index, no state", async () => {
  const box = world();
  try {
    fs.rmSync(box.guard, { recursive: true, force: true });
    assert.equal(await say(box), null);
    assert.deepEqual(ls(box.cfg), ["projects"], "nothing was created");
  } finally { box.cleanup(); }
});

test("below 50% the hook is silent; at 50% and 80% and 100% it says one line each", async () => {
  const steps = [
    [5530000, null, "49.0%"],
    [5420000, "Cost guard: today 2.71M of 5.42M tokens (50%)", "50%"],
    [3387500, "Cost guard: today 2.71M of 3.39M tokens (80%)", "80%"],
    [2710000, "Cost guard: today 2.71M of 2.71M tokens (100%)", "100%"],
    [2737000, "Cost guard: today 2.71M of 2.74M tokens (99%)", "99%: only the 80% threshold has been crossed"],
  ];
  for (const [limit, line, label] of steps) {
    const box = world({ global: { daily: tok(limit) } });
    try {
      const r = await say(box);
      if (line === null) assert.equal(r, null, label);
      else assert.deepEqual(r, { systemMessage: line }, label);
    } finally { box.cleanup(); }
  }
});

test("the message looks like the specification's example", async () => {
  const box = world({ global: { daily: usd(15), weekly: usd(80) } });
  try {
    assert.deepEqual(await say(box), { systemMessage: "Cost guard: today $9.52 of $15 (63%) · this week $10.37 of $80" });
    assert.equal(await say(box), null, "said once, then silent");
  } finally { box.cleanup(); }
});

test("each threshold is announced once per limit per day", async () => {
  const box = world({ global: { daily: tok(5420000) } });
  try {
    assert.equal((await say(box)).systemMessage, "Cost guard: today 2.71M of 5.42M tokens (50%)");
    assert.equal(await say(box), null, "not again at the same level");
    assert.equal(await say(box), null);
    assert.deepEqual(marks(box), { day: TODAY, marks: { "all|daily": 50 } });
    // more usage arrives and crosses 80%
    const s = box.session({ cwd: ALPHA, sid: S1 });
    s.req({ ts: at(0, 12, 30), model: "claude-opus-5-5", u: usage({ i: 1700000 }), requestId: "req_more" }); // 4.41M of 5.42M = 81%
    assert.equal((await say(box)).systemMessage, "Cost guard: today 4.41M of 5.42M tokens (81%)");
    assert.equal(await say(box), null);
    s.req({ ts: at(0, 12, 40), model: "claude-opus-5-5", u: usage({ i: 1100000 }), requestId: "req_more2" }); // 5.51M = 101%
    assert.equal((await say(box)).systemMessage, "Cost guard: today 5.51M of 5.42M tokens (102%)");
    assert.equal(await say(box), null, "past 100% there is nothing more to announce in soft mode");
    assert.deepEqual(marks(box).marks, { "all|daily": 100 });
  } finally { box.cleanup(); }
});

test("a jump over several thresholds is one message, and the thresholds below it are used up", async () => {
  const box = world({ global: { daily: tok(3387500) } }); // 80% at once
  try {
    assert.equal((await say(box)).systemMessage, "Cost guard: today 2.71M of 3.39M tokens (80%)");
    assert.equal(await say(box), null);
    assert.equal(marks(box).marks["all|daily"], 80);
  } finally { box.cleanup(); }
});

test("a new day announces again", async () => {
  const box = world({ global: { weekly: tok(5584000) } }); // this week 2.792M = 50%
  try {
    assert.equal((await say(box)).systemMessage, "Cost guard: this week 2.79M of 5.58M tokens (50%)");
    assert.equal(await say(box), null);
    const thursday = box.now + 864e5;
    assert.equal((await say(box, {}, { now: thursday })).systemMessage, "Cost guard: this week 2.79M of 5.58M tokens (50%)", "state is per day");
    assert.equal(await say(box, {}, { now: thursday }), null);
    assert.deepEqual(marks(box), { day: "2026-10-08", marks: { "all|weekly": 50 } });
  } finally { box.cleanup(); }
});

test("a weekly figure that crossed a threshold shows its percentage; the daily one alongside does not", async () => {
  const box = world({ global: { daily: usd(50), weekly: usd(20) } }); // week $10.37 of $20 = 51%, day 19%
  try {
    const r = await say(box);
    assert.equal(r.systemMessage, "Cost guard: today $9.52 of $50 · this week $10.37 of $20 (52%)");
  } finally { box.cleanup(); }
});

test("a budget in tokens and one in dollars are told apart", async () => {
  const box = world({ global: { daily: tok(4e6), weekly: usd(14) } });
  try {
    const r = await say(box);
    assert.equal(r.systemMessage, "Cost guard: today 2.71M of 4M tokens (68%) · this week $10.37 of $14 (74%)");
  } finally { box.cleanup(); }
});

test("a project budget speaks for its project only, and in its own line", async () => {
  const box = world({ global: { daily: usd(100) }, projects: [{ dir: ALPHA, daily: usd(10) }, { dir: BETA, daily: usd(5) }] });
  try {
    // alpha spent $6.02 today of $10 (60%); the global budget is at 9%; beta is not involved in alpha's prompts
    assert.deepEqual(await say(box, { cwd: ALPHA }), { systemMessage: "Cost guard (alpha): today $6.02 of $10 (60%)" });
    assert.equal(await say(box, { cwd: ALPHA }), null);
    // in beta: $3.50 of $5 = 70%
    assert.deepEqual(await say(box, { cwd: BETA + "/sub" }), { systemMessage: "Cost guard (beta): today $3.50 of $5 (70%)" });
    // outside both: only the global budget, at 9%: silent
    assert.equal(await say(box, { cwd: "/elsewhere" }), null);
  } finally { box.cleanup(); }
});

test("two budgets that cross a threshold together give two lines in one message", async () => {
  const box = world({ global: { daily: usd(15) }, projects: [{ dir: ALPHA, daily: usd(10) }] });
  try {
    const r = await say(box, { cwd: ALPHA });
    assert.equal(r.systemMessage, "Cost guard: today $9.52 of $15 (63%)\nCost guard (alpha): today $6.02 of $10 (60%)");
    assert.equal(Object.keys(r).length, 1);
  } finally { box.cleanup(); }
});

test("soft mode warns at 100% and past it, and never blocks", async () => {
  const box = world({ global: { daily: usd(5), mode: "soft" } });
  try {
    const r = await say(box);
    assert.equal(r.systemMessage, "Cost guard: today $9.52 of $5 (190%)");
    assert.equal(r.decision, undefined);
    assert.equal(await say(box), null);
  } finally { box.cleanup(); }
});

test("hard mode blocks a prompt when the budget is used, and says how to go on", async () => {
  const box = world({ global: { daily: usd(9), mode: "hard" } });
  try {
    const r = await say(box);
    assert.deepEqual(r, {
      decision: "block",
      reason: "Cost guard: today's budget of $9 is used ($9.52). Raise it with: claude-cost-guard budget extend 2usd, or set CLAUDE_COST_GUARD_OFF=1.",
    });
    // blocked again on the next prompt, and the next: a block is not announced once, it holds
    assert.equal((await say(box)).decision, "block");
    assert.equal((await say(box)).decision, "block");
    assert.equal(fs.existsSync(path.join(box.guard, "state.json")), false, "blocking leaves no state behind");
  } finally { box.cleanup(); }
});

test("the block text for a $15 budget is the specification's, with an amount no shell can expand", async () => {
  const box = world({ global: { daily: usd(15), mode: "hard" } });
  try {
    const s = box.session({ cwd: ALPHA, sid: S1 });
    s.req({ ts: at(0, 12, 30), model: "claude-opus-5-5", u: usage({ o: 200000 }), requestId: "req_over" }); // +$4.00 -> $13.52... add more
    s.req({ ts: at(0, 12, 31), model: "claude-opus-5-5", u: usage({ o: 100000 }), requestId: "req_over2" }); // +$2.00 -> $15.52
    refresh(box.cfg, { now: NOW });
    const r = await say(box);
    assert.equal(r.reason, "Cost guard: today's budget of $15 is used ($15.52). Raise it with: claude-cost-guard budget extend 5usd, or set CLAUDE_COST_GUARD_OFF=1.");
    assert.doesNotMatch(r.reason, /extend \$/);
  } finally { box.cleanup(); }
});

test("hard mode never blocks slash commands or ! shell commands: they are how you get back under budget", async () => {
  const box = world({ global: { daily: usd(9), mode: "hard" } });
  try {
    assert.equal((await say(box)).decision, "block", "an ordinary prompt is blocked");
    for (const prompt of ["/compact keep the plan", "/clear", "  /model sonnet", "!git status"]) {
      const r = await say(box, { prompt });
      assert.ok(r === null || r.decision === undefined, `${prompt} is not blocked`);
    }
  } finally { box.cleanup(); }
});

test("hard mode blocks at exactly 100% and not below it", async () => {
  let box = world({ global: { daily: tok(DAY_TOKENS), mode: "hard" } });
  try {
    assert.equal((await say(box)).decision, "block", "2.71M of 2.71M");
  } finally { box.cleanup(); }
  box = world({ global: { daily: tok(DAY_TOKENS + 1), mode: "hard" } });
  try {
    const r = await say(box);
    assert.equal(r.decision, undefined, "one token short");
    assert.match(r.systemMessage, /\(99%\)/);
  } finally { box.cleanup(); }
});

test("hard mode below 100% still warns like soft mode", async () => {
  const box = world({ global: { daily: tok(3387500), mode: "hard" } });
  try {
    assert.equal((await say(box)).systemMessage, "Cost guard: today 2.71M of 3.39M tokens (80%)");
  } finally { box.cleanup(); }
});

test("hard mode with a weekly limit blocks for the week", async () => {
  const box = world({ global: { weekly: usd(10), mode: "hard" } });
  try {
    const r = await say(box);
    assert.equal(r.reason, "Cost guard: this week's budget of $10 is used ($10.37). Raise it with: claude-cost-guard budget extend 2usd, or set CLAUDE_COST_GUARD_OFF=1.");
    // next Monday there is a new week
    assert.equal(await say(box, {}, { now: box.now + 5 * 864e5 }), null);
  } finally { box.cleanup(); }
});

test("a hard project budget blocks that project only; the project's name is in the text", async () => {
  const box = world({ global: { daily: usd(100) }, projects: [{ dir: ALPHA, daily: usd(5), mode: "hard" }] });
  try {
    const r = await say(box, { cwd: ALPHA + "\\src" });
    assert.equal(r.reason, "Cost guard: today's budget of $5 for alpha is used ($6.02). Raise it with: claude-cost-guard budget extend 2usd, or set CLAUDE_COST_GUARD_OFF=1.");
    assert.equal(await say(box, { cwd: BETA }), null, "other projects are not blocked");
  } finally { box.cleanup(); }
});

test("the budget in hard mode that is used up wins over soft warnings", async () => {
  const box = world({ global: { daily: usd(15), mode: "soft" }, projects: [{ dir: ALPHA, daily: usd(5), mode: "hard" }] });
  try {
    const r = await say(box, { cwd: ALPHA });
    assert.deepEqual(Object.keys(r).sort(), ["decision", "reason"], "a block, not a warning");
  } finally { box.cleanup(); }
});

test("extending lifts a block for today", async () => {
  const box = world({ global: { daily: usd(9), mode: "hard" } });
  try {
    assert.equal((await say(box)).decision, "block");
    const b = loadBudgets(box.cfg);
    extendBudget(b, usd(5), {}, TODAY);
    saveBudgets(box.cfg, b);
    const r = await say(box);
    assert.equal(r.decision, undefined, "9.52 of 14: through");
    // and tomorrow the limit is back (a new day: nothing spent yet, so just no block)
    assert.equal(await say(box, {}, { now: box.now + 864e5 }), null);
  } finally { box.cleanup(); }
});

test("CLAUDE_COST_GUARD_OFF switches the guard off, even over a hard budget", async () => {
  const box = world({ global: { daily: usd(9), mode: "hard" } });
  try {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) assert.equal(await say(box, {}, { env: { CLAUDE_COST_GUARD_OFF: v } }), null, v);
    assert.equal((await say(box, {}, { env: { CLAUDE_COST_GUARD_OFF: "0" } })).decision, "block", "0 is not off");
    assert.equal((await say(box, {}, { env: { CLAUDE_COST_GUARD_OFF: "" } })).decision, "block");
  } finally { box.cleanup(); }
});

test("prompts that a person did not type are skipped", async () => {
  const box = world({ global: { daily: usd(9), mode: "hard" } });
  try {
    for (const source of ["sdk", "system", "loop_wakeup", "schedule_wakeup", "poll_event", "something-new", null, 5]) {
      assert.equal(await say(box, { source }), null, String(source));
    }
    assert.equal((await say(box, { source: "user" })).decision, "block");
    const noSource = input();
    delete noSource.source;
    assert.equal(JSON.parse((await runHook({ env: box.env, stdin: JSON.stringify(noSource), now: box.now })).output).decision, "block", "no source field: treated as a person's prompt");
    assert.equal(await say(box, { hook_event_name: "Stop" }), null, "another event");
  } finally { box.cleanup(); }
});

test("bad input is ignored", async () => {
  const box = world({ global: { daily: usd(9), mode: "hard" } });
  try {
    for (const stdin of ["not json", "[]", "null", '"text"', "42", "{"]) {
      const r = await hook(box, stdin);
      assert.equal(r.output, null, JSON.stringify(stdin));
    }
    for (const stdin of ["{}", ""]) {
      const r = await hook(box, stdin);
      assert.equal(JSON.parse(r.output).decision, "block", `${JSON.stringify(stdin)} is a prompt without details: still guarded`);
    }
  } finally { box.cleanup(); }
});

test("a failure inside the hook is logged and says nothing", async () => {
  const box = world({ global: { daily: usd(9), mode: "hard" } });
  try {
    fs.rmSync(path.join(box.guard, "index.json"));
    fs.mkdirSync(path.join(box.guard, "index.json")); // an index that cannot be read or written
    const r = await hook(box);
    assert.equal(r.output, null);
    const log = fs.readFileSync(path.join(box.guard, "errors.log"), "utf8");
    assert.match(log, /^\d{4}-\d\d-\d\dT[\d:.]+Z .*\S/m);
  } finally { box.cleanup(); }
});

test("a corrupt budgets file means no budget, not a failure", async () => {
  const box = world();
  try {
    fs.mkdirSync(box.guard, { recursive: true });
    fs.writeFileSync(path.join(box.guard, "budgets.json"), "{oops");
    assert.equal(await say(box), null);
  } finally { box.cleanup(); }
});

test("a corrupt index is rebuilt and the answer is still right", async () => {
  const box = world({ global: { daily: usd(9), mode: "hard" } });
  try {
    fs.writeFileSync(path.join(box.guard, "index.json"), "garbage");
    assert.equal((await say(box)).decision, "block");
    assert.match(fs.readFileSync(path.join(box.guard, "errors.log"), "utf8"), /index\.json could not be read/);
  } finally { box.cleanup(); }
});

test("everything the hook can print is a systemMessage or a block, in plain ASCII JSON", async () => {
  const outputs = [];
  for (const spec of [
    { global: { daily: usd(15), weekly: usd(80) } },
    { global: { daily: usd(9), mode: "hard" } },
    { global: { daily: tok(3387500) }, projects: [{ dir: ALPHA, daily: usd(10) }] },
  ]) {
    const box = world(spec);
    try { outputs.push((await hook(box)).output); } finally { box.cleanup(); }
  }
  for (const out of outputs) {
    assert.ok(out && /^[\x20-\x7e]+$/.test(out), "one line of printable ASCII");
    const o = JSON.parse(out);
    const keys = Object.keys(o).sort().join(",");
    assert.ok(keys === "systemMessage" || keys === "decision,reason", keys);
    assert.ok(out.length < 400, `${out.length} characters`);
  }
  assert.match(outputs[0], /\\u00b7/, "the middle dot is escaped");
  assert.equal(JSON.parse(outputs[0]).systemMessage.includes("·"), true);
  assert.equal(toAsciiJson({ a: "é☕" }), '{"a":"\\u00e9\\u2615"}');
});

test("the hook never reads or prints what was said: no prompt, answer or tool text in what it writes", async () => {
  const box = world({ global: { daily: usd(9), mode: "hard" } });
  try {
    const out = (await hook(box, { prompt: "SECRET-PROMPT-TEXT" })).output;
    assert.doesNotMatch(out, /SECRET|never be printed|reasoning that never|secret\/path/);
    let all = "";
    for (const f of ls(box.guard)) all += fs.readFileSync(path.join(box.guard, f), "utf8");
    assert.doesNotMatch(all, /SECRET-PROMPT|never be printed|reasoning that never|secret\/path|an answer that/);
  } finally { box.cleanup(); }
});

test("while another run holds the lock the hook neither waits long nor loses its guard", async () => {
  const box = world({ global: { daily: usd(9), mode: "hard" } });
  try {
    fs.writeFileSync(path.join(box.guard, "index.lock"), "99999"); // a run in progress elsewhere
    const t0 = performance.now();
    const r = await hook(box);
    const ms = performance.now() - t0;
    assert.ok(ms < 1500, `${ms.toFixed(0)} ms`);
    assert.equal(JSON.parse(r.output).decision, "block", "judged on the index as it is on disk");
    assert.equal(r.stats.skipped, true);
    assert.ok(fs.existsSync(path.join(box.guard, "index.lock")), "somebody else's lock is left alone");
  } finally { box.cleanup(); }
});

test("a lock left behind by a dead run does not stop the hook", async () => {
  const box = world({ global: { daily: usd(9), mode: "hard" } });
  try {
    const lock = path.join(box.guard, "index.lock");
    fs.writeFileSync(lock, "99999");
    const old = new Date(Date.now() - 5 * 60000);
    fs.utimesSync(lock, old, old);
    const r = await hook(box);
    assert.equal(r.stats.skipped, false);
    assert.equal(fs.existsSync(lock), false, "released");
    assert.equal(JSON.parse(r.output).decision, "block");
  } finally { box.cleanup(); }
});

test("the hook reads what was written since the last prompt, found through the transcript path", async () => {
  const box = world({ global: { daily: tok(5e6), mode: "hard" } });
  try {
    assert.equal((await say(box)).systemMessage, "Cost guard: today 2.71M of 5M tokens (54%)", "2.71M of 5M so far");
    const s = box.session({ cwd: ALPHA, sid: S1 });
    s.req({ ts: at(0, 12, 40), model: "claude-opus-5-5", u: usage({ i: 2400000 }), requestId: "req_just_now" });
    const r = await say(box, { transcript_path: s.file });
    assert.equal(r.decision, "block", "5.11M of 5M");
  } finally { box.cleanup(); }
});

test("plan(): the decision is a pure function of usage and what was announced", () => {
  const slot = (over) => ({ key: "all|daily", scopeKey: "all", scope: "all projects", isGlobal: true, period: "daily", unit: "usd", base: 15, extra: 0, limit: 15, used: 0, pct: 0, mode: "soft", ...over });
  assert.deepEqual(plan([slot({ used: 6, pct: 40 })], {}), { message: null, marks: {}, changed: false });
  const p = plan([slot({ used: 7.5, pct: 50 })], {});
  assert.equal(p.message, "Cost guard: today $7.50 of $15 (50%)");
  assert.deepEqual(p.marks, { "all|daily": 50 });
  assert.equal(p.changed, true);
  assert.equal(plan([slot({ used: 7.5, pct: 50 })], { "all|daily": 50 }).message, null);
  assert.equal(plan([slot({ used: 12, pct: 80 })], { "all|daily": 50 }).message, "Cost guard: today $12.00 of $15 (80%)");
  assert.equal(plan([slot({ used: 12, pct: 80 })], { "all|daily": 80 }).message, null);
  const hard = plan([slot({ used: 15, pct: 100, mode: "hard" })], {});
  assert.match(hard.block, /today's budget of \$15 is used \(\$15\.00\)/);
  assert.equal(hard.message, undefined);
  assert.equal(plan([slot({ used: 15, pct: 100, mode: "hard", limit: 20, base: 15, extra: 5 })], {}).block, undefined, "not used up under the extended limit (limit 20)");
  assert.equal(blockReason(slot({ used: 3.2e6, limit: 3e6, base: 3e6, unit: "tokens", pct: 107 })), "Cost guard: today's budget of 3M tokens is used (3.2M). Raise it with: claude-cost-guard budget extend 1M, or set CLAUDE_COST_GUARD_OFF=1.");
  assert.deepEqual(messageLines([slot({ pct: 60, used: 9 })], new Set()), [], "nothing triggered: no line");
});

test("a transcript_path that is missing, outside the transcripts folder, or not a path is ignored", async () => {
  const box = world({ global: { daily: usd(9), mode: "hard" } });
  try {
    const outside = path.join(box.root, "elsewhere.jsonl");
    fs.writeFileSync(outside, JSON.stringify({ type: "assistant", requestId: "req_out", sessionId: S1, timestamp: at(0), message: { id: "m", model: "claude-opus-5-5", content: [], usage: usage({ i: 9e9 }) } }) + "\n");
    for (const transcript_path of [path.join(box.projects, "nope", "missing.jsonl"), outside, "", 5, null, { a: 1 }, "relative/path.jsonl", `${box.projects}/../../escape.jsonl`]) {
      const r = await hook(box, { transcript_path });
      assert.equal(JSON.parse(r.output).decision, "block", String(transcript_path));
    }
    const idx = refresh(box.cfg, { now: NOW, full: true }).idx;
    assert.equal(idx.requests.req_out, undefined, "a file outside the transcripts folder is never read");
    assert.equal(Object.keys(idx.files).length, 4);
  } finally { box.cleanup(); }
});

test("a run that cannot take the lock still blocks, but leaves warnings for the next prompt so they are never said twice", async () => {
  const box = world({ global: { daily: tok(5420000) } }); // exactly 50%
  try {
    const lock = path.join(box.guard, "index.lock");
    fs.writeFileSync(lock, "99999"); // another window is working
    const quiet = await hook(box);
    assert.equal(quiet.output, null, "no warning without the lock");
    assert.equal(fs.existsSync(path.join(box.guard, "state.json")), false, "and nothing recorded");
    fs.rmSync(lock);
    assert.equal(JSON.parse((await hook(box)).output).systemMessage, "Cost guard: today 2.71M of 5.42M tokens (50%)", "said once the lock is free");
    assert.equal((await hook(box)).output, null);
    // a block does not wait for the lock
    budgets(box, { global: { daily: tok(DAY_TOKENS), mode: "hard" } });
    fs.writeFileSync(lock, "99999");
    assert.equal(JSON.parse((await hook(box)).output).decision, "block");
  } finally { box.cleanup(); }
});

test("plan() without the right to announce decides blocks only", () => {
  const slot = (over) => ({ key: "all|daily", scopeKey: "all", scope: "all projects", isGlobal: true, period: "daily", unit: "usd", base: 15, extra: 0, limit: 15, used: 12, pct: 80, mode: "soft", ...over });
  assert.deepEqual(plan([slot()], {}, { announce: false }), { message: null, marks: {}, changed: false });
  assert.match(plan([slot({ mode: "hard", used: 15, pct: 100 })], {}, { announce: false }).block, /budget of \$15 is used/);
});

test("a prompt that arrives while another is deciding cannot announce what the other is about to", async () => {
  const box = world({ global: { daily: tok(5420000) } }); // exactly 50%
  try {
    // The first run is inside its locked section (holding the lock) when the second one starts.
    let second;
    refresh(box.cfg, { now: NOW, lockWaitMs: 0, whileLocked: () => { second = hook(box); return null; } });
    const nested = await second;
    assert.equal(nested.output, null, "the second prompt could not take the lock, so it leaves the announcement to whoever holds it");
    assert.equal(nested.stats.skipped, true);
    // the first prompt's own turn: it announces once, and a third prompt finds it recorded
    assert.equal(JSON.parse((await hook(box)).output).systemMessage, "Cost guard: today 2.71M of 5.42M tokens (50%)");
    assert.equal((await hook(box)).output, null);
  } finally { box.cleanup(); }
});

test("CLAUDE_COST_GUARD_BUDGET_MS sets how long the hook may read, and a bad value is ignored", async () => {
  const box = sandbox();
  try {
    buildFixture(box); // four transcripts, no index yet
    budgets(box, { global: { daily: usd(100) } });
    const tiny = await hook(box, {}, { env: { CLAUDE_COST_GUARD_BUDGET_MS: "0" } });
    assert.equal(tiny.stats.stopped, true, "a budget of 0 ms reads one file and stops");
    assert.ok(tiny.stats.pending > 0);
    for (const bad of ["abc", "-5", "", "  "]) {
      const r = await hook(box, {}, { env: { CLAUDE_COST_GUARD_BUDGET_MS: bad } });
      assert.equal(r.stats.stopped, false, `${JSON.stringify(bad)}: the default 250 ms is plenty for four small files`);
      assert.equal(r.stats.pending, 0);
    }
  } finally { box.cleanup(); }
});

test("the specification's own example line, to the character: today $12.10 of $15 (81%) · this week $48 of $80", async () => {
  const box = sandbox();
  try {
    const s = box.session({ cwd: ALPHA, sid: S1 });
    // opus-5-5 output costs $20 per million: Monday $20.00, Tuesday $15.90, today $12.10 = $48.00 this week
    s.req({ ts: at(-2, 10), model: "claude-opus-5-5", u: usage({ o: 1000000 }), requestId: "req_mon" });
    s.req({ ts: at(-1, 10), model: "claude-opus-5-5", u: usage({ o: 795000 }), requestId: "req_tue" });
    s.req({ ts: at(0, 10), model: "claude-opus-5-5", u: usage({ o: 605000 }), requestId: "req_wed" });
    budgets(box, { global: { daily: usd(15), weekly: usd(80) } });
    // the weekly 50% was announced earlier today, so only the daily 80% is news
    fs.writeFileSync(path.join(box.guard, "state.json"), JSON.stringify({ day: TODAY, marks: { "all|weekly": 50 } }));
    const r = await say(box);
    assert.deepEqual(r, { systemMessage: "Cost guard: today $12.10 of $15 (81%) · this week $48 of $80" });
  } finally { box.cleanup(); }
});
