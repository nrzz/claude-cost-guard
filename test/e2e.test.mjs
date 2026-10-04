// End to end: the hook and the command line as separate processes, the way Claude Code and a person run them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { saveBudgets } from "../src/budgets.mjs";
import { refresh } from "../src/index.mjs";
import { ALPHA, CLI, FAKE_TIME, GUARD, NOW, S1, at, buildFixture, readJson, run, runCli, runGuard, sandbox, usage } from "./helpers.mjs";

const prompt = (extra = {}) => ({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: ALPHA, prompt: "hello", source: "user", ...extra });
const budgets = (box, global) => saveBudgets(box.cfg, { version: 1, global, projects: [] });
const usd = (n) => ({ unit: "usd", amount: n });
const tok = (n) => ({ unit: "tokens", amount: n });

// A hook started the way Claude Code starts it (no shell: command and args), but without waiting.
// `real` runs it on the real clock, which anything involving lock files needs: their modification times are real.
function startHook(box, input, { script = GUARD, real = false } = {}) {
  return new Promise((resolve) => {
    const clock = real ? [] : ["-r", FAKE_TIME];
    const env = real ? box.env : { ...box.env, FAKE_NOW: new Date(box.now).toISOString() };
    const child = spawn(process.execPath, [...clock, script, "prompt"], { env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test("the hook, as Claude Code runs it: exit 0, nothing on stderr, and below the first threshold nothing at all", () => {
  const box = sandbox();
  try {
    buildFixture(box);
    budgets(box, { daily: usd(100), weekly: usd(500), mode: "hard" });
    const r = runGuard(box, prompt());
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "", "9.52 of 100: nothing to say, and so nothing printed");
    assert.equal(r.stderr, "");
  } finally { box.cleanup(); }
});

test("a warning is one line of JSON with a systemMessage and nothing else", () => {
  const box = sandbox();
  try {
    buildFixture(box);
    budgets(box, { daily: usd(15), weekly: usd(80) });
    const r = runGuard(box, prompt());
    assert.equal(r.status, 0);
    assert.equal(r.stderr, "");
    assert.deepEqual(JSON.parse(r.stdout), { systemMessage: "Cost guard: today $9.52 of $15 (63%) · this week $10.37 of $80" });
    assert.equal(r.stdout.includes("\n"), false, "no trailing newline, no second line");
    assert.equal(runGuard(box, prompt()).stdout, "", "and only once");
  } finally { box.cleanup(); }
});

test("a block is one line of JSON, and automated prompts and CLAUDE_COST_GUARD_OFF go through", () => {
  const box = sandbox();
  try {
    buildFixture(box);
    budgets(box, { daily: usd(9), mode: "hard" });
    const blocked = runGuard(box, prompt());
    assert.equal(blocked.status, 0, "a block is JSON on stdout, not a failing exit code");
    assert.deepEqual(JSON.parse(blocked.stdout), {
      decision: "block",
      reason: "Cost guard: today's budget of $9 is used ($9.52). Raise it with: claude-cost-guard budget extend 2usd, or set CLAUDE_COST_GUARD_OFF=1.",
    });
    assert.equal(runGuard(box, prompt({ source: "sdk" })).stdout, "");
    assert.equal(runGuard(box, prompt({ source: "loop_wakeup" })).stdout, "");
    assert.equal(runGuard(box, prompt(), { env: { CLAUDE_COST_GUARD_OFF: "1" } }).stdout, "", "switched off for this session");
    assert.equal(runGuard(box, prompt()).stdout, blocked.stdout, "and still on in the next one");
  } finally { box.cleanup(); }
});

test("hostile or empty input never makes the hook fail or talk", () => {
  const box = sandbox();
  try {
    buildFixture(box);
    budgets(box, { daily: usd(100) });
    const inputs = ["", "{", "null", "[]", "42", '"x"', "\u0000\u0001\u0002", String.fromCharCode(0xfeff) + "{}", '{"cwd": 5, "source": "user", "transcript_path": {"a": 1}}', `{"cwd": ${JSON.stringify("x".repeat(100000))}}`, "{}".repeat(1000)];
    for (const stdin of inputs) {
      const r = runGuard(box, stdin);
      assert.equal(r.status, 0, JSON.stringify(stdin.slice(0, 30)));
      assert.equal(r.stdout, "", JSON.stringify(stdin.slice(0, 30)));
      assert.equal(r.stderr, "");
    }
    // no stdin at all (closed immediately)
    const r = spawnSync(process.execPath, [GUARD, "prompt"], { env: box.env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", windowsHide: true });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  } finally { box.cleanup(); }
});

test("guard.mjs with no or unknown arguments does nothing; 'version' says the version", () => {
  const box = sandbox();
  try {
    for (const args of [[], ["frob"], ["PROMPT"], ["--help"]]) {
      const r = run(box, GUARD, args, { input: "{}" });
      assert.equal(r.status, 0, args.join(" "));
      assert.equal(r.out, "", args.join(" "));
    }
    assert.equal(run(box, GUARD, ["version"]).stdout.trim(), "1.0.1");
    assert.equal(run(box, GUARD, ["--version"]).stdout.trim(), "1.0.1");
  } finally { box.cleanup(); }
});

test("a broken copy of the guard still never fails a prompt, and leaves a note", () => {
  const box = sandbox();
  try {
    const broken = path.join(box.root, "broken");
    fs.mkdirSync(broken);
    fs.copyFileSync(GUARD, path.join(broken, "guard.mjs")); // no src/ next to it
    const r = run(box, path.join(broken, "guard.mjs"), ["prompt"], { input: JSON.stringify(prompt()) });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
    const log = fs.readFileSync(path.join(box.guard, "errors.log"), "utf8");
    assert.match(log, /^\d{4}-\d\d-\d\dT[\d:.]+Z .*(Cannot find module|ERR_MODULE_NOT_FOUND)/);
    // a syntax error in a module is the same
    fs.mkdirSync(path.join(broken, "src"));
    fs.writeFileSync(path.join(broken, "src", "hook.mjs"), "export const x = ;");
    const s = run(box, path.join(broken, "guard.mjs"), ["prompt"], { input: JSON.stringify(prompt()) });
    assert.equal(s.status, 0);
    assert.equal(s.stdout, "");
  } finally { box.cleanup(); }
});

test("two windows prompting at the same moment announce a threshold once", async () => {
  const box = sandbox({ now: Date.now() });
  try {
    // real time, real clock: a request a minute ago and a budget of exactly twice that
    const s = box.session({ cwd: ALPHA, sid: S1 });
    s.req({ ts: new Date(Date.now() - 60000).toISOString(), model: "claude-opus-5-5", u: usage({ i: 1000000 }), requestId: "req_now" });
    budgets(box, { daily: tok(2000000) }); // exactly 50%
    for (let round = 0; round < 3; round++) {
      fs.rmSync(path.join(box.guard, "state.json"), { force: true });
      const results = await Promise.all(Array.from({ length: 6 }, () => startHook(box, prompt(), { real: true })));
      for (const r of results) { assert.equal(r.status, 0); assert.equal(r.stderr, ""); }
      const spoke = results.filter((r) => r.stdout !== "");
      assert.equal(spoke.length, 1, `round ${round}: ${spoke.length} of 6 announced it`);
      assert.deepEqual(JSON.parse(spoke[0].stdout), { systemMessage: "Cost guard: today 1M of 2M tokens (50%)" });
      assert.deepEqual(readJson(path.join(box.guard, "state.json")).marks, { "all|daily": 50 });
    }
  } finally { box.cleanup(); }
});

test("the settings.json entry works as Claude Code starts it, even in a config folder with spaces", () => {
  const box = sandbox({ cfgName: "my claude config" });
  try {
    buildFixture(box);
    assert.equal(runCli(box, ["init"]).status, 0);
    assert.equal(runCli(box, ["budget", "set", "--daily", "9usd", "--mode", "hard"]).status, 0);
    const e = readJson(path.join(box.cfg, "settings.json")).hooks.UserPromptSubmit[0].hooks[0];
    assert.match(e.args[0], / /, "the path really has a space in it");
    // exec form: the command and its arguments, no shell
    const r = spawnSync(process.execPath, ["-r", FAKE_TIME, ...e.args], { env: { ...box.env, FAKE_NOW: new Date(box.now).toISOString() }, input: JSON.stringify(prompt()), encoding: "utf8", windowsHide: true });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).decision, "block");
    assert.equal(r.stderr, "");
  } finally { box.cleanup(); }
});

test("a day in the life: warnings as usage grows, a block, an extension, and a new day", () => {
  const box = sandbox();
  try {
    const s = box.session({ cwd: ALPHA, sid: S1 });
    s.title("Daily work");
    budgets(box, { daily: usd(10), weekly: usd(30), mode: "hard" });
    const say = () => { const r = runGuard(box, prompt({ transcript_path: s.file })); assert.equal(r.status, 0); return r.stdout ? JSON.parse(r.stdout) : null; };
    const spend = (hour, outputTokens, id) => s.req({ ts: at(0, hour), model: "claude-opus-5-5", u: usage({ o: outputTokens }), requestId: id }); // 20 dollars per million output tokens

    assert.equal(say(), null, "nothing yet");
    spend(9, 100000, "r1"); // $2
    assert.equal(say(), null, "20% of the day, 7% of the week");
    spend(10, 150000, "r2"); // $5 in all: 50%
    assert.deepEqual(say(), { systemMessage: "Cost guard: today $5.00 of $10 (50%) · this week $5.00 of $30" });
    assert.equal(say(), null);
    spend(11, 150000, "r3"); // $8: 80%
    assert.deepEqual(say(), { systemMessage: "Cost guard: today $8.00 of $10 (80%) · this week $8.00 of $30" });
    spend(12, 100000, "r4"); // $10: used
    const blocked = say();
    assert.equal(blocked.decision, "block");
    assert.match(blocked.reason, /^Cost guard: today's budget of \$10 is used \(\$10\.00\)\. Raise it with: claude-cost-guard budget extend 2usd,/);
    assert.equal(say().decision, "block", "again and again until something changes");

    assert.match(runCli(box, ["budget", "extend", "3usd"]).stdout, /Extended 1 budget by \$3 for today/);
    assert.equal(say(), null, "$10 of $13: 77%: through, and the 50% line is not repeated");
    spend(13, 40000, "r5"); // $10.80: 83% of the extended $13 (an extension lifts the weekly limit by the same $3)
    assert.deepEqual(say(), { systemMessage: "Cost guard: today $10.80 of $13 (83%) · this week $10.80 of $33" });
    spend(14, 120000, "r6"); // $13.20: over the extended limit
    assert.equal(say().decision, "block");

    box.now += 864e5; // tomorrow, Thursday: a new day, the extension is gone, nothing spent yet
    assert.equal(say(), null);
    s.req({ ts: at(1, 9), model: "claude-opus-5-5", u: usage({ o: 130000 }), requestId: "r7" }); // $2.60 today, $15.80 this week (52.67%)
    assert.deepEqual(say(), { systemMessage: "Cost guard: today $2.60 of $10 · this week $15.80 of $30 (53%)" });
    assert.match(runCli(box, ["report", "--days", "2"]).stdout, /Total +\d+ .* \$15\.80$/m);
  } finally { box.cleanup(); }
});

test("the command line as a process: output goes to stdout, errors to stderr with exit code 1", () => {
  const box = sandbox();
  try {
    buildFixture(box);
    const ok = runCli(box, ["report", "--days", "3"]);
    assert.equal(ok.status, 0);
    assert.equal(ok.stderr, "");
    assert.match(ok.stdout, /Claude Code usage 2026-10-05 to 2026-10-07 \(3 days\), by day/);
    const bad = runCli(box, ["budget", "set", "--daily", "15"]);
    assert.equal(bad.status, 1);
    assert.equal(bad.stdout, "");
    assert.match(bad.stderr, /"15" is not an amount/);
    const unknown = runCli(box, ["nope"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown command "nope"/);
    const sl = runCli(box, ["statusline"], { input: "{}" });
    assert.equal(sl.status, 0);
    assert.equal(sl.stdout, "today $9.52 · week $10.37\n");
    assert.equal(run(box, CLI, ["--version"]).stdout, "1.0.1\n");
  } finally { box.cleanup(); }
});

test("nothing a run does reaches outside the config folder", () => {
  const box = sandbox();
  try {
    buildFixture(box);
    runCli(box, ["init"]);
    runCli(box, ["budget", "set", "--daily", "9usd", "--hard"]);
    runGuard(box, prompt());
    runCli(box, ["report"]);
    runCli(box, ["today"]);
    runCli(box, ["status"]);
    runCli(box, ["uninstall", "--purge"]);
    assert.deepEqual(fs.readdirSync(box.root).sort(), ["c", "h"], "only the config folder and the home folder exist");
    assert.deepEqual(fs.readdirSync(box.home), [], "HOME was never written to");
    assert.deepEqual(fs.readdirSync(box.cfg).filter((f) => !f.startsWith("settings.json")).sort(), ["projects"], "and in the config folder only the transcripts (never modified) and settings.json with its backups remain");
    assert.equal(fs.readdirSync(box.projects).length > 0, true);
  } finally { box.cleanup(); }
});
