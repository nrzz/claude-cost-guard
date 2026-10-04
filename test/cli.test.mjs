// The command line: report, today, statusline, budget, help. Run in-process with captured output.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { main } from "../src/cli.mjs";
import { loadBudgets } from "../src/budgets.mjs";
import { refresh } from "../src/index.mjs";
import { ALPHA, BETA, NOW, S1, S2, S3, at, buildFixture, expected, near, readJson, sandbox, uid, usage } from "./helpers.mjs";

async function cli(box, args, { cwd = box.home, now = box.now, stdin } = {}) {
  const out = [];
  const err = [];
  const code = await main(args, { env: box.env, cwd, now, stdin, io: { out: (s = "") => out.push(s), err: (s = "") => err.push(s) } });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
function world(extra) {
  const box = sandbox();
  buildFixture(box);
  if (extra) extra(box);
  return box;
}
const budget = (box, ...args) => cli(box, ["budget", ...args]);
const rowOf = (text, start) => text.split("\n").find((l) => l.startsWith(start));

test("help, version, and unknown commands", async () => {
  const box = sandbox();
  try {
    for (const args of [[], ["help"], ["--help"], ["-h"], ["report", "--help"]]) {
      const r = await cli(box, args);
      assert.equal(r.code, 0, args.join(" "));
      assert.match(r.out, /claude-cost-guard 1\.0\.1: daily and weekly token budgets/);
      assert.match(r.out, /budget set --daily <amount>/);
      assert.match(r.out, /CLAUDE_COST_GUARD_OFF=1/);
    }
    for (const args of [["--version"], ["version"]]) assert.deepEqual(await cli(box, args), { code: 0, out: "1.0.1", err: "" });
    const bad = await cli(box, ["frobnicate"]);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /Unknown command "frobnicate"/);
    assert.match(bad.out, /Look/, "and the help follows");
  } finally { box.cleanup(); }
});

test("report: a table by day with totals, the most expensive sessions, and the notes", async () => {
  const box = world();
  try {
    const r = await cli(box, ["report"]);
    assert.equal(r.code, 0, r.err);
    const lines = r.out.split("\n");
    assert.equal(lines[0], "Claude Code usage 2026-10-01 to 2026-10-07 (7 days), by day");
    const head = lines.findIndex((l) => l.startsWith("Day "));
    assert.match(lines[head], /^Day +Reqs +Input +Output +Cache wr +Cache rd +Fresh +Cost$/);
    const table = lines.slice(head, head + 2 + 7 + 2); // header, rule, seven days, rule, total
    assert.equal(new Set(table.map((l) => l.length)).size, 1, "every line of the table is as wide as the header: aligned");
    assert.match(rowOf(r.out, "2026-10-07"), /^2026-10-07 +4 +1\.65M +360k +700k +13\.1M +2\.71M +\$9\.52$/);
    assert.match(rowOf(r.out, "2026-10-04"), /^2026-10-04 +1 +10k +4k +10k +100k +24k +\$0\.47$/);
    assert.match(rowOf(r.out, "2026-10-02"), /^2026-10-02 +0 +0 +0 +0 +0 +0 +\$0\.00$/, "days without usage are listed");
    assert.match(rowOf(r.out, "Total"), /^Total +7 +1\.68M +376k +760k +13\.7M +2\.82M +\$10\.84$/);
    assert.match(r.out, /Most expensive sessions/);
    assert.match(r.out, /\$6\.72 +1\.17M +alpha +10-07 +Fix login redirect loop \(00000001\)/);
    assert.match(r.out, /\$3\.50 +1\.6M +beta +10-07 +Refactor billing \(00000002\)/);
    assert.match(r.out, /\$0\.61 +46k +alpha +10-05 +\(untitled\) \(00000003\)/);
    assert.match(r.out, /Fresh = input \+ output \+ cache writes\. Cache reads are cheap/);
    assert.match(r.out, /Output includes 20k thinking tokens\./);
    assert.match(r.out, /Subagents account for \$0\.22/);
    assert.match(r.out, /Dollars are API list prices\. On a subscription plan nothing is billed per token/);
  } finally { box.cleanup(); }
});

test("report --by week, project, model and session", async () => {
  const box = world();
  try {
    let r = await cli(box, ["report", "--by", "week", "--days", "14"]);
    assert.match(rowOf(r.out, "2026-W41"), /^2026-W41 10-05\.\.10-11 +6 .* \$10\.37$/);
    assert.match(rowOf(r.out, "2026-W40"), /^2026-W40 09-28\.\.10-04 +1 .* \$0\.47$/);
    assert.match(rowOf(r.out, "2026-W39"), /\$0\.00$/, "an empty week in the range is listed");
    r = await cli(box, ["report", "--by", "project"]);
    const names = r.out.split("\n").filter((l) => /^(alpha|beta) /.test(l)).map((l) => l.split(/\s+/)[0]);
    assert.deepEqual(names, ["alpha", "beta"], "most expensive first");
    assert.match(rowOf(r.out, "alpha"), /^alpha +6 .* \$7\.33$/);
    assert.match(rowOf(r.out, "beta"), /^beta +1 .* \$3\.50$/);
    r = await cli(box, ["report", "--by", "model"]);
    const models = r.out.split("\n").filter((l) => /^(opus|sonnet|haiku|fable)/.test(l)).map((l) => l.split(/\s+/)[0]);
    assert.deepEqual(models, ["opus-5-5", "haiku-4-5-20251001", "sonnet-5-5", "fable-5-1", "opus-4-6"], "by cost, without the claude- prefix");
    assert.match(rowOf(r.out, "opus-5-5"), /\$4\.10$/);
    r = await cli(box, ["report", "--by", "session"]);
    assert.doesNotMatch(r.out, /Most expensive sessions/, "the table is the session list");
    assert.match(rowOf(r.out, "Fix login redirect loop"), /^Fix login redirect loop \(00000001\) +4 .* \$6\.72$/);
    assert.match(rowOf(r.out, "(untitled)"), /\$0\.61$/);
  } finally { box.cleanup(); }
});

test("report --days narrows or widens the window", async () => {
  const box = world();
  try {
    let r = await cli(box, ["report", "--days", "1"]);
    assert.match(r.out.split("\n")[0], /2026-10-07 to 2026-10-07 \(1 day\)/);
    assert.match(rowOf(r.out, "Total"), /^Total +4 .* \$9\.52$/);
    r = await cli(box, ["report", "--days", "3"]);
    assert.match(rowOf(r.out, "Total"), /^Total +6 .* \$10\.37$/);
    r = await cli(box, ["report", "--days", "90"]);
    assert.match(r.out, /Nothing is indexed before 2026-10-04: requests are kept for 35 days/, "a longer window than the index has data for says so");
    assert.equal((await cli(box, ["report", "--days", "30"])).out.includes("Nothing is indexed before"), false);
  } finally { box.cleanup(); }
});

test("report --json is the same numbers as data, with no paths and no text of the conversation", async () => {
  const box = world();
  try {
    const r = await cli(box, ["report", "--json"]);
    assert.equal(r.code, 0);
    const j = JSON.parse(r.out);
    assert.deepEqual(Object.keys(j), ["tool", "version", "range", "by", "units", "rows", "total", "sessions", "notes"]);
    assert.deepEqual(j.range, { from: "2026-10-01", to: "2026-10-07", days: 7 });
    assert.equal(j.by, "day");
    assert.equal(j.rows.length, 7);
    const t = j.total;
    assert.deepEqual([t.requests, t.input, t.output, t.thinking, t.cacheWrite5m, t.cacheWrite1h, t.cacheWrite, t.cacheRead, t.fresh, t.subagentFresh],
      [7, 1680000, 376000, 20000, 608000, 152000, 760000, 13700000, 2816000, 60000]);
    assert.ok(near(t.cost, 10.835, 1e-6));
    assert.ok(near(t.subagentCost, 0.22, 1e-6));
    for (const [day, cost] of Object.entries(expected.byDay)) assert.ok(near(j.rows.find((x) => x.key === day).cost, cost, 1e-6), day);
    assert.deepEqual(j.sessions.map((s) => [s.title, s.project, s.id, s.lastDay]), [
      ["Fix login redirect loop", "alpha", S1, "2026-10-07"], ["Refactor billing", "beta", S2, "2026-10-07"], ["", "alpha", S3, "2026-10-05"],
    ]);
    assert.ok(near(j.sessions[0].cost, 6.72, 1e-6));
    assert.doesNotMatch(r.out, /D:\\\\work|home\/dev|never be printed|reasoning that never|secret\/path|an answer that/, "folder names, never full paths; never conversation text");
    const proj = JSON.parse((await cli(box, ["report", "--json", "--by", "project"])).out);
    assert.deepEqual(proj.rows.map((x) => x.key), ["alpha", "beta"]);
    const wk = JSON.parse((await cli(box, ["report", "--json", "--by", "week", "--days", "14"])).out);
    assert.deepEqual(wk.rows.map((x) => [x.key, x.from, x.to]), [["2026-W39", "2026-09-21", "2026-09-27"], ["2026-W40", "2026-09-28", "2026-10-04"], ["2026-W41", "2026-10-05", "2026-10-11"]]);
    const ses = JSON.parse((await cli(box, ["report", "--json", "--by", "session"])).out);
    assert.equal(ses.rows.length, 3);
    assert.equal(ses.rows[0].id, S1);
  } finally { box.cleanup(); }
});

test("report refuses options it does not understand, and says what is allowed", async () => {
  const box = world();
  try {
    for (const args of [["--by", "colour"], ["--by"], ["--days", "0"], ["--days", "abc"], ["--days", "-3"], ["--days", "4000"], ["--days", "7.5"], ["--days"]]) {
      const r = await cli(box, ["report", ...args]);
      assert.equal(r.code, 1, args.join(" "));
      assert.match(r.err, /--by takes one of day, week, project, model, session|--days takes a whole number from 1 to 3650/, args.join(" "));
      assert.equal(r.out, "");
    }
  } finally { box.cleanup(); }
});

test("report --by session lists the 20 most expensive sessions and sums up the rest", async () => {
  const box = sandbox();
  try {
    for (let k = 0; k < 25; k++) {
      const s = box.session({ cwd: `/w/p${k}`, sid: uid(300 + k) });
      s.req({ ts: at(0, 8), model: "claude-opus-5-5", u: usage({ o: 1000 * (k + 1) }), requestId: `req_s${k}` });
    }
    const r = await cli(box, ["report", "--by", "session"]);
    assert.equal(r.out.split("\n").filter((l) => /\(0000\d{4}\)/.test(l)).length, 20);
    assert.match(r.out, /\(5 more sessions, \$0\.\d\d\)/);
    assert.match(rowOf(r.out, "Total"), /^Total +25 /);
    const j = JSON.parse((await cli(box, ["report", "--by", "session", "--json"])).out);
    assert.equal(j.rows.length, 25, "the JSON has every session");
  } finally { box.cleanup(); }
});

test("report notes models that are not in the price table, and unfinished indexing", async () => {
  const box = sandbox();
  try {
    const s = box.session({ cwd: ALPHA, sid: S1 });
    s.req({ ts: at(0, 8), model: "mystery-model-9", u: usage({ i: 1e6 }), requestId: "req_m" });
    const r = await cli(box, ["report", "--days", "1"]);
    assert.match(r.out, /Not in the price table, so priced like the default model: mystery-model-9\./);
    assert.match(rowOf(r.out, "Total"), /\$5\.00$/, "1M input tokens at the default $5/MTok");
  } finally { box.cleanup(); }
});

test("report on a machine with no transcripts is an empty table, not an error", async () => {
  const box = sandbox();
  try {
    const r = await cli(box, ["report"]);
    assert.equal(r.code, 0);
    assert.match(rowOf(r.out, "Total"), /^Total +0 +0 +0 +0 +0 +0 +\$0\.00$/);
    assert.match(r.out, /No transcripts folder yet at /);
    assert.equal(JSON.parse((await cli(box, ["report", "--json"])).out).total.cost, 0);
  } finally { box.cleanup(); }
});

test("today: cost, tokens, projects, models, and the budgets that count in this folder", async () => {
  const box = world();
  try {
    await budget(box, "set", "--daily", "15usd", "--weekly", "80usd");
    await budget(box, "set", "--daily", "10usd", "--project", ALPHA);
    const r = await cli(box, ["today"], { cwd: ALPHA });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^Today, 2026-10-07$/m);
    assert.match(r.out, /cost +\$9\.52 +\(API list prices\)/);
    assert.match(r.out, /fresh +2\.71M tokens: input 1\.65M · output 360k · cache writes 700k/);
    assert.match(r.out, /cache reads +13\.1M/);
    assert.match(r.out, /requests +4 +\(subagents: \$0\.22\)/);
    assert.match(r.out, /by project +alpha \$6\.02 · beta \$3\.50|by project +beta \$3\.50 · alpha \$6\.02/);
    assert.match(r.out, /by model +haiku-4-5-20251001 \$3\.50 · opus-5-5 \$3\.40 · sonnet-5-5 \$2\.62/);
    assert.match(r.out, /This week \(Monday 2026-10-05 on\): \$10\.37 · 2\.79M fresh tokens/);
    assert.match(r.out, /all projects +today \$9\.52 of \$15 \(63%\) · this week \$10\.37 of \$80 \(13%\) +\[soft\]/);
    assert.match(r.out, /alpha +today \$6\.02 of \$10 \(60%\) +\[soft\]/);
    const elsewhere = await cli(box, ["today"], { cwd: BETA });
    assert.doesNotMatch(elsewhere.out, /alpha +today/, "the alpha budget does not count in beta");
  } finally { box.cleanup(); }
});

test("today shows when new prompts are being blocked", async () => {
  const box = world();
  try {
    await budget(box, "set", "--daily", "9usd", "--hard");
    const r = await cli(box, ["today"]);
    assert.match(r.out, /\(106%\) +\[hard: new prompts are blocked\]/);
  } finally { box.cleanup(); }
});

test("statusline: one compact line", async () => {
  const box = world();
  try {
    refresh(box.cfg, { now: box.now, full: true }); // a status line reads for 100 ms at most, so it is shown a finished index
    assert.equal((await cli(box, ["statusline"], { stdin: "{}" })).out, "today $9.52 · week $10.37", "no budget: plain usage");
    await budget(box, "set", "--daily", "15usd", "--weekly", "80usd");
    assert.equal((await cli(box, ["statusline"], { stdin: "{}" })).out, "today $9.52/$15 · week $10.37/$80");
    await budget(box, "set", "--daily", "5M", "--weekly", "20M");
    assert.equal((await cli(box, ["statusline"], { stdin: "{}" })).out, "today 2.71M/5M · week 2.79M/20M", "tokens");
    await budget(box, "set", "--daily", "15usd", "--weekly", "80usd");
    await budget(box, "set", "--daily", "10usd", "--project", ALPHA);
    const inAlpha = JSON.stringify({ workspace: { current_dir: ALPHA + "\\src" }, session_id: "x" });
    assert.equal((await cli(box, ["statusline"], { stdin: inAlpha })).out, "today $9.52/$15 · week $10.37/$80 · alpha: today $6.02/$10");
    assert.equal((await cli(box, ["statusline"], { stdin: JSON.stringify({ cwd: BETA }) })).out, "today $9.52/$15 · week $10.37/$80", "another folder: no project segment");
    for (const stdin of ["", "garbage", "[]", "null"]) assert.equal((await cli(box, ["statusline"], { stdin })).code, 0, stdin);
  } finally { box.cleanup(); }
});

test("statusline never fails, even with nothing to read", async () => {
  const box = sandbox();
  try {
    const r = await cli(box, ["statusline"], { stdin: "{}" });
    assert.equal(r.code, 0);
    assert.equal(r.out, "today $0.00 · week $0.00");
    assert.equal(r.err, "");
    fs.rmSync(path.join(box.guard, "index.json"));
    fs.mkdirSync(path.join(box.guard, "index.json")); // an index that cannot be read or written
    const broken = await cli(box, ["statusline"], { stdin: "{}" });
    assert.equal(broken.code, 0);
    assert.equal(broken.err, "");
  } finally { box.cleanup(); }
});

test("budget set: dollars or tokens, daily and weekly, and where it is stored", async () => {
  const box = world();
  try {
    const r = await budget(box, "set", "--daily", "15usd", "--weekly", "80usd");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^Budget set for all projects: daily \$15, weekly \$80 \(soft\)\.$/m);
    assert.match(r.out, /all projects +today \$9\.52 of \$15 \(63%\) · this week \$10\.37 of \$80 \(13%\) +\[soft\]/, "and where you stand right now");
    assert.match(r.out, /The guard is not installed in Claude Code yet: run +claude-cost-guard init/);
    assert.deepEqual(readJson(path.join(box.guard, "budgets.json")), { version: 1, global: { daily: { unit: "usd", amount: 15 }, weekly: { unit: "usd", amount: 80 }, mode: "soft" }, projects: [] });
    const t = await budget(box, "set", "--daily", "3M", "--weekly=15m");
    assert.match(t.out, /daily 3M tokens, weekly 15M tokens \(soft\)/);
    assert.deepEqual(loadBudgets(box.cfg).global.daily, { unit: "tokens", amount: 3e6 });
    const hard = await budget(box, "set", "--daily", "$15", "--mode", "hard");
    assert.match(hard.out, /daily \$15, weekly 15M tokens \(hard\)/, "the weekly limit stays; the mode changes");
    assert.equal((await budget(box, "set", "--daily", "20usd", "--soft")).out.includes("(soft)"), true);
    assert.equal((await budget(box, "set", "--weekly", "9usd", "--hard")).out.includes("(hard)"), true);
  } finally { box.cleanup(); }
});

test("budget set for one project: the folder is resolved from where you are", async () => {
  const box = world();
  try {
    const proj = path.join(box.home, "app");
    fs.mkdirSync(path.join(proj, "src"), { recursive: true });
    const r = await cli(box, ["budget", "set", "--daily", "5usd", "--project", "app", "--hard"], { cwd: box.home });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^Budget set for app: daily \$5 \(hard\)\.$/m);
    assert.equal(loadBudgets(box.cfg).projects[0].dir, proj);
    const dot = await cli(box, ["budget", "set", "--weekly", "30usd", "--project", "."], { cwd: path.join(proj, "src") });
    assert.match(dot.out, /Budget set for src: weekly \$30/);
    const missing = await cli(box, ["budget", "set", "--daily", "1usd", "--project", "nowhere"], { cwd: box.home });
    assert.equal(missing.code, 0);
    assert.match(missing.out, /does not exist on this machine/);
    assert.equal(loadBudgets(box.cfg).projects.length, 3);
  } finally { box.cleanup(); }
});

test("budget set says what is wrong with what you typed", async () => {
  const box = world();
  try {
    const cases = [
      [["set"], /Give a limit: --daily <amount> and\/or --weekly/],
      [["set", "--daily", "15"], /"15" is not an amount: dollars or tokens\?.*quote it \('\$15'\) or write 15usd/s],
      [["set", "--daily"], /--daily needs a value, for example --daily 15usd/],
      [["set", "--weekly", "abc"], /"abc" is not an amount/],
      [["set", "--daily", "0usd"], /must be more than 0/],
      [["set", "--daily", "5usd", "--mode", "extreme"], /--mode takes soft or hard, not "extreme"/],
      [["set", "--daily", "5usd", "--project", "x", "--all"], /Use --project <dir> or --all, not both/],
      [["frob"], /Unknown budget command "frob"\. Use set, show, clear or extend\./],
    ];
    for (const [args, re] of cases) {
      const r = await budget(box, ...args);
      assert.equal(r.code, 1, args.join(" "));
      assert.match(r.err, re, args.join(" "));
    }
    assert.equal(fs.existsSync(path.join(box.guard, "budgets.json")), false, "a refused command changes nothing");
  } finally { box.cleanup(); }
});

test("budget show lists every budget with where it stands", async () => {
  const box = world();
  try {
    assert.match((await budget(box, "show")).out, /^No budgets set\. For example: +claude-cost-guard budget set --daily 15usd --weekly 80usd$/);
    assert.match((await budget(box)).out, /^No budgets set/, "show is the default");
    await budget(box, "set", "--daily", "15usd", "--weekly", "80usd");
    await budget(box, "set", "--daily", "5usd", "--project", ALPHA, "--hard");
    const r = await budget(box, "show");
    assert.match(r.out, /^Budgets \(.*budgets\.json\)$/m);
    assert.match(r.out, /all projects +today \$9\.52 of \$15 \(63%\) · this week \$10\.37 of \$80 \(13%\) +\[soft\]/);
    assert.match(r.out, /alpha +today \$6\.02 of \$5 \(120%\) +\[hard\] +D:\\work\\alpha/);
  } finally { box.cleanup(); }
});

test("budget extend raises today's limit and shows it; clear takes budgets away", async () => {
  const box = world();
  try {
    await budget(box, "set", "--daily", "9usd", "--weekly", "80usd", "--hard");
    const r = await budget(box, "extend", "5usd");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^Extended 1 budget by \$5 for today \(until midnight\)\.$/m);
    assert.match(r.out, /today \$9\.52 of \$14 \(68%\) · this week \$10\.37 of \$85 \(12%\) +\[hard, extended \+\$5 today\]/);
    assert.deepEqual(loadBudgets(box.cfg).global.ext, { day: "2026-10-07", usd: 5, tokens: 0 });
    // tomorrow the extension is not there
    const tomorrow = await cli(box, ["budget", "show"], { now: NOW + 864e5 });
    assert.doesNotMatch(tomorrow.out, /extended/);
    const quote = await budget(box, "extend", "$2");
    assert.equal(quote.code, 0, "a quoted $ amount works too");
    assert.match(quote.out, /by \$2 for today/);
    assert.equal((await budget(box, "clear", "--weekly")).out, "Cleared 1 limit.");
    assert.equal(loadBudgets(box.cfg).global.weekly, undefined);
    assert.equal((await budget(box, "clear")).out, "Cleared 1 limit.");
    assert.equal((await budget(box, "clear")).out, "Nothing to clear.");
    assert.equal(loadBudgets(box.cfg).global, null);
  } finally { box.cleanup(); }
});

test("budget extend: errors", async () => {
  const box = world();
  try {
    assert.match((await budget(box, "extend", "5usd")).err, /There is no budget to extend\. Set one with/);
    await budget(box, "set", "--daily", "9usd");
    assert.match((await budget(box, "extend")).err, /How much\? For example: claude-cost-guard budget extend 5usd/);
    const wrong = await budget(box, "extend", "1M");
    assert.equal(wrong.code, 1);
    assert.match(wrong.err, /No budget there is counted in tokens, so 1M tokens cannot be added/);
    assert.match((await budget(box, "extend", "5")).err, /dollars or tokens\?/);
    await budget(box, "set", "--daily", "5usd", "--project", ALPHA);
    assert.deepEqual((await budget(box, "extend", "1usd", "--project", ALPHA)).code, 0);
    const b = loadBudgets(box.cfg);
    assert.equal(b.global.ext, undefined, "only the project budget was extended");
    assert.equal(b.projects[0].ext.usd, 1);
    assert.equal((await budget(box, "extend", "1usd", "--all")).code, 0);
    assert.equal(loadBudgets(box.cfg).global.ext.usd, 1);
  } finally { box.cleanup(); }
});

test("a broken budgets file is reported, not overwritten", async () => {
  const box = world();
  try {
    fs.mkdirSync(box.guard, { recursive: true });
    fs.writeFileSync(path.join(box.guard, "budgets.json"), "{not json");
    const r = await budget(box, "set", "--daily", "5usd");
    assert.equal(r.code, 1);
    assert.match(r.err, /budgets\.json is not valid JSON\. Fix it, or delete it/);
    assert.equal(fs.readFileSync(path.join(box.guard, "budgets.json"), "utf8"), "{not json");
    assert.match((await budget(box, "show")).out, /is not valid JSON, so no budget is in force/);
  } finally { box.cleanup(); }
});

test("setting, extending or clearing a budget counts what it just showed as announced", async () => {
  const box = world();
  try {
    await budget(box, "set", "--daily", "15usd", "--weekly", "80usd");
    assert.deepEqual(readJson(path.join(box.guard, "state.json")), { day: "2026-10-07", marks: { "all|daily": 50 } }, "63% of the day: the 50% line was shown by the command");
    await budget(box, "set", "--daily", "10usd");
    assert.equal(readJson(path.join(box.guard, "state.json")).marks["all|daily"], 80, "95% of $10... the command showed it");
    await budget(box, "clear", "--daily");
    assert.deepEqual(readJson(path.join(box.guard, "state.json")).marks, {}, "a limit that is gone leaves no mark");
  } finally { box.cleanup(); }
});

test("nothing the commands print contains the conversation", async () => {
  const box = world();
  try {
    await budget(box, "set", "--daily", "15usd", "--weekly", "80usd");
    const outputs = [];
    for (const args of [["report"], ["report", "--by", "session"], ["report", "--by", "project"], ["today"], ["statusline"], ["budget", "show"], ["status"]]) {
      const r = await cli(box, args, { stdin: "{}" });
      outputs.push(r.out + r.err);
    }
    const text = outputs.join("\n");
    assert.doesNotMatch(text, /never be printed|reasoning that never|secret\/path|an answer that|SIG/);
    assert.doesNotMatch(text, /D:\\work\\alpha|\/home\/dev\/beta/, "folder names, never the paths the sessions ran in");
  } finally { box.cleanup(); }
});
