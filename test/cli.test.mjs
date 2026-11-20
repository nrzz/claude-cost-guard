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

test("budget clear refuses --dialy without clearing either limit", async () => {
  const box = sandbox();
  try {
    assert.equal((await budget(box, "set", "--daily", "15usd", "--weekly", "80usd", "--hard")).code, 0);
    const before = fs.readFileSync(path.join(box.guard, "budgets.json"), "utf8");
    const r = await budget(box, "clear", "--dialy");
    assert.deepEqual(r, { code: 1, out: "", err: 'Unknown flag "--dialy" for "budget clear". Did you mean "--daily"?' });
    assert.equal(fs.readFileSync(path.join(box.guard, "budgets.json"), "utf8"), before);
    const good = await budget(box, "clear", "--daily");
    assert.equal(good.code, 0, good.err);
    assert.equal(loadBudgets(box.cfg).global.daily, undefined);
    assert.equal(loadBudgets(box.cfg).global.weekly.amount, 80);
  } finally { box.cleanup(); }
});

test("budget set refuses --mdoe without saving a soft budget", async () => {
  const box = sandbox();
  try {
    const r = await budget(box, "set", "--daily", "15usd", "--mdoe", "hard");
    assert.deepEqual(r, { code: 1, out: "", err: 'Unknown flag "--mdoe" for "budget set". Did you mean "--mode"?' });
    assert.equal(fs.existsSync(box.guard), false, "no budget, index or state was written");
    const good = await budget(box, "set", "--daily", "15usd", "--mode", "hard");
    assert.equal(good.code, 0, good.err);
    assert.equal(loadBudgets(box.cfg).global.mode, "hard");
  } finally { box.cleanup(); }
});

test("report refuses --dyas instead of silently showing seven days", async () => {
  const box = sandbox();
  try {
    const r = await cli(box, ["report", "--dyas", "30"]);
    assert.deepEqual(r, { code: 1, out: "", err: 'Unknown flag "--dyas" for "report". Did you mean "--days"?' });
    assert.equal(fs.existsSync(box.guard), false, "the index was not refreshed");
    const good = await cli(box, ["report", "--days", "30", "--json"]);
    assert.equal(good.code, 0, good.err);
    assert.equal(JSON.parse(good.out).range.days, 30);
  } finally { box.cleanup(); }
});

test("budget clear refuses a word, with or without dashes, without clearing either limit", async () => {
  const box = sandbox();
  try {
    assert.equal((await budget(box, "set", "--daily", "15usd", "--weekly", "80usd", "--hard")).code, 0);
    const before = fs.readFileSync(path.join(box.guard, "budgets.json"), "utf8");
    for (const [words, word, hint] of [
      [["daily"], "daily", "--daily"], [["weekly"], "weekly", "--weekly"], [["-1"], "-1", null], [["-"], "-", null],
      [["--", "-daily"], "-daily", "--daily"], [["--daily", "weekly"], "weekly", "--weekly"],
    ]) {
      const r = await budget(box, "clear", ...words);
      assert.deepEqual(r, { code: 1, out: "", err: `Unexpected word "${word}" for "budget clear".${hint ? ` Did you mean "${hint}"?` : ""}` }, words.join(" "));
      assert.equal(fs.readFileSync(path.join(box.guard, "budgets.json"), "utf8"), before, words.join(" "));
    }
  } finally { box.cleanup(); }
});

test("budget set refuses a trailing hard without saving a soft budget", async () => {
  const box = sandbox();
  try {
    const r = await budget(box, "set", "--daily", "15usd", "hard");
    assert.deepEqual(r, { code: 1, out: "", err: 'Unexpected word "hard" for "budget set". Did you mean "--hard"?' });
    assert.equal(fs.existsSync(box.guard), false, "no budget, index or state was written");
    assert.equal((await budget(box, "set", "--daily", "15usd", "--hard")).code, 0);
    const before = fs.readFileSync(path.join(box.guard, "budgets.json"), "utf8");
    const soft = await budget(box, "set", "--daily", "20usd", "soft");
    assert.deepEqual(soft, { code: 1, out: "", err: 'Unexpected word "soft" for "budget set". Did you mean "--soft"?' });
    assert.equal(fs.readFileSync(path.join(box.guard, "budgets.json"), "utf8"), before);
    assert.equal(loadBudgets(box.cfg).global.mode, "hard");
  } finally { box.cleanup(); }
});

test("report refuses a bare number instead of silently showing seven days", async () => {
  const box = sandbox();
  try {
    const r = await cli(box, ["report", "30"]);
    assert.deepEqual(r, { code: 1, out: "", err: 'Unexpected word "30" for "report".' });
    assert.equal(fs.existsSync(box.guard), false, "the index was not refreshed");
  } finally { box.cleanup(); }
});

test("budget extend takes one amount and refuses a second", async () => {
  const box = sandbox();
  try {
    assert.equal((await budget(box, "set", "--daily", "15usd", "--hard")).code, 0);
    const before = fs.readFileSync(path.join(box.guard, "budgets.json"), "utf8");
    const r = await budget(box, "extend", "5usd", "3usd");
    assert.deepEqual(r, { code: 1, out: "", err: 'Unexpected word "3usd" for "budget extend". It takes one amount.' });
    assert.equal(fs.readFileSync(path.join(box.guard, "budgets.json"), "utf8"), before);
    const unit = await budget(box, "extend", "1M", "tokens");
    assert.deepEqual(unit, { code: 1, out: "", err: 'Unexpected word "tokens" for "budget extend". Write the amount as one word, such as 1M or 5usd.' });
    assert.equal(fs.readFileSync(path.join(box.guard, "budgets.json"), "utf8"), before);
    const good = await budget(box, "extend", "5usd");
    assert.equal(good.code, 0, good.err);
    assert.equal(loadBudgets(box.cfg).global.ext.usd, 5);
  } finally { box.cleanup(); }
});

async function checkFlags(command, cases = [[]]) {
  const box = sandbox();
  try {
    for (const flags of cases) {
      const fl = typeof flags === "function" ? flags(box) : flags;
      assert.equal((await budget(box, "set", "--daily", "15usd", "--model", "opus", "--project", ".")).code, 0);
      const r = await cli(box, [...command, ...fl], { stdin: "{}" });
      assert.equal(r.code, 0, `${command.join(" ")} ${fl.join(" ")}: ${r.err}`);
      assert.equal(r.err, "");
    }
    for (const flag of ["--help", "-h"]) {
      const r = await cli(box, [...command, flag]);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /Set up/);
    }
    const name = command[0] === "budget" && command.length === 1 ? "budget show" : command.join(" ");
    const word = await cli(box, [...command, ...(command[1] === "extend" ? ["5usd"] : []), "frobnicate"], { stdin: "{}" });
    if (command.length > 1 || command[0] !== "budget") assert.deepEqual(word, { code: 1, out: "", err: `Unexpected word "frobnicate" for "${name}".${command[1] === "extend" ? " It takes one amount." : ""}` });
    const bad = await cli(box, [...command, "--frobnicate"], { stdin: "{}" });
    assert.equal(bad.code, 1);
    assert.equal(bad.out, "");
    assert.equal(bad.err, `Unknown flag "--frobnicate" for "${command[0] === "budget" && command.length === 1 ? "budget show" : command.join(" ")}".`);
  } finally { box.cleanup(); }
}

test("init accepts its documented flags", () => checkFlags(["init"], [["--scope", "user"]]));
test("uninstall accepts its documented flags", () => checkFlags(["uninstall"], [[], ["--purge"]]));
test("status accepts its documented flags", () => checkFlags(["status"]));
test("today accepts its documented flags", () => checkFlags(["today"]));
test("statusline accepts its documented flags", () => checkFlags(["statusline"]));
test("report accepts its documented flags", () => checkFlags(["report"], [
  ["--days", "30", "--by", "week", "--json"], ["--days=1", "--by=model", "--json=true"],
]));
test("budget defaults to show and accepts help", () => checkFlags(["budget"]));
test("budget show accepts help and its existing scope flags", () => checkFlags(["budget", "show"], [
  [], ["--all"], ["--project", ".", "--model", "opus"],
]));
test("budget check accepts only its documented --json and --file flags", () => checkFlags(["budget", "check"], [
  [], ["--json"], ["--json=true"], (box) => ["--file", path.join(box.guard, "budgets.json")],
]));
test("budget set accepts its documented flags and mode aliases", () => checkFlags(["budget", "set"], [
  ["--daily", "15usd", "--weekly", "80usd", "--all", "--model", "opus", "--mode", "hard"],
  ["--daily=15usd", "--weekly=80usd", "--project=.", "--model=opus", "--soft"],
  ["--daily", "15usd", "--hard"],
]));
test("budget clear accepts its documented flags", () => checkFlags(["budget", "clear"], [
  ["--all", "--model", "opus", "--daily", "--weekly"], ["--project", ".", "--model", "opus", "--weekly"],
]));
test("budget extend accepts its documented flags", () => checkFlags(["budget", "extend"], [
  ["5usd", "--all", "--model", "opus"], ["5usd", "--project", ".", "--model", "opus"],
]));

test("flag validation respects command scopes, equals, -- and flags before a budget subcommand", async () => {
  const box = sandbox();
  try {
    for (const [argv, flag, command, suggestion] of [
      [["budget", "set", "--daily=20usd", "--wekly=100usd"], "wekly", "budget set", "weekly"],
      [["budget", "--hard", "clear"], "hard", "budget clear", null],
      [["budget", "clear", "--mode", "hard"], "mode", "budget clear", "model"],
      [["budget", "show", "--daily", "5usd"], "daily", "budget show", null],
      [["budget", "check", "--flie"], "flie", "budget check", "file"],
      [["status", "--jsno"], "jsno", "status", null],
      [["today", "--json"], "json", "today", null],
      [["report", "--daxs=30"], "daxs", "report", "days"],
      [["report", "--daysxxx=30"], "daysxxx", "report", null],
      [["report", "--_", "extra"], "_", "report", "by"],
      [["report", "--__proto__=bad"], "__proto__", "report", null],
    ]) {
      const r = await cli(box, argv);
      assert.deepEqual(r, { code: 1, out: "", err: `Unknown flag "--${flag}" for "${command}".${suggestion ? ` Did you mean "--${suggestion}"?` : ""}` }, argv.join(" "));
    }
    assert.equal(fs.existsSync(box.guard), false);
    const afterDashes = await cli(box, ["report", "--days=30", "--json", "--", "--dyas", "30"]);
    assert.deepEqual(afterDashes, { code: 1, out: "", err: 'Unexpected word "--dyas" for "report".' }, "after --, a flag is a word");
    const flagAfterDashes = await cli(box, ["report", "--", "--json"]);
    assert.deepEqual(flagAfterDashes, { code: 1, out: "", err: 'Unexpected word "--json" for "report". Put it before "--".' });
    const beforeSub = await budget(box, "--hard", "set", "--daily", "15usd");
    assert.equal(beforeSub.code, 0, beforeSub.err);
    assert.equal(loadBudgets(box.cfg).global.mode, "hard");
  } finally { box.cleanup(); }
});

test("every flag listed in HELP is accepted by its command's flag list", async () => {
  const box = sandbox();
  try {
    const help = await cli(box, ["--help"]);
    assert.equal(help.code, 0, help.err);
    const lines = help.out.split("\n").filter((line) => line.startsWith("  claude-cost-guard "));
    assert.ok(lines.length > 0, "HELP lists commands");
    let checked = 0;
    for (const line of lines) {
      const match = /^  claude-cost-guard (budget [a-z]+|[a-z]+)\b/.exec(line);
      assert.ok(match, line);
      const command = match[1].split(" ");
      // An absent list must fail too: validation otherwise skips that command entirely.
      const bad = await cli(box, [...command, "--frobnicate"]);
      assert.deepEqual(bad, { code: 1, out: "", err: `Unknown flag "--frobnicate" for "${match[1]}".` });
      for (const flag of new Set(line.match(/--[a-z][a-z-]*/g) || [])) {
        const r = await cli(box, [...command, flag, "--help"]);
        assert.deepEqual(r, help, `${match[1]} ${flag} is listed in HELP`);
        checked++;
      }
    }
    assert.ok(checked > 0, "HELP lists flags");
    assert.equal(fs.existsSync(box.guard), false, "checking HELP does not run the commands");
  } finally { box.cleanup(); }
});

test("help, version, and unknown commands", async () => {
  const box = sandbox();
  try {
    for (const args of [[], ["help"], ["--help"], ["-h"], ["report", "--help"]]) {
      const r = await cli(box, args);
      assert.equal(r.code, 0, args.join(" "));
      assert.match(r.out, /claude-cost-guard 1\.5\.2: daily and weekly token budgets/);
      assert.match(r.out, /budget set --daily <amount>/);
      assert.match(r.out, /CLAUDE_COST_GUARD_OFF=1/);
    }
    for (const args of [["--version"], ["version"], ["-v"]]) assert.deepEqual(await cli(box, args), { code: 0, out: "1.5.2", err: "" });
    const help = await cli(box, ["help"]);
    for (const command of ["help", "--help", "-h"]) {
      for (const flag of ["--help", "-h"]) assert.deepEqual(await cli(box, [command, flag]), help, `${command} ${flag}`);
    }
    for (const flag of ["--version", "-v"]) {
      assert.deepEqual(await cli(box, ["today", flag]), { code: 1, out: "", err: `Unknown flag "${flag}" for "today".` });
    }
    for (const command of ["help", "--help", "-h", "version", "--version", "-v"]) {
      const r = await cli(box, [command, "--frobnicate"]);
      assert.equal(r.code, 1);
      assert.equal(r.out, "");
      assert.match(r.err, /Unknown flag "--frobnicate" for "(?:help|version)"\./);
    }
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
      [["frob"], /Unknown budget command "frob"\. Use set, show, clear, extend or check\./],
    ];
    for (const [args, re] of cases) {
      const r = await budget(box, ...args);
      assert.equal(r.code, 1, args.join(" "));
      assert.match(r.err, re, args.join(" "));
    }
    assert.equal(fs.existsSync(path.join(box.guard, "budgets.json")), false, "a refused command changes nothing");
  } finally { box.cleanup(); }
});

test("budget check accepts a clean file and reports its budget count", async () => {
  const box = sandbox();
  try {
    fs.mkdirSync(box.guard, { recursive: true });
    fs.writeFileSync(path.join(box.guard, "budgets.json"), JSON.stringify({
      version: 1,
      global: { daily: { unit: "usd", amount: 15 }, mode: "soft" },
      projects: [{ dir: "/work/app", weekly: { unit: "tokens", amount: 500000 }, mode: "hard" }],
    }));
    const text = await budget(box, "check");
    assert.equal(text.code, 0, text.err);
    assert.equal(text.out, "budgets.json: every setting is read as written (2 budgets).");
    const json = await budget(box, "check", "--json");
    assert.equal(json.code, 0, json.err);
    assert.deepEqual(JSON.parse(json.out), {
      ok: true,
      file: path.join(box.guard, "budgets.json"),
      invalid: false,
      problems: [],
      budgets: 2,
    });
  } finally { box.cleanup(); }
});

test("budget check uses singular grammar for one budget", async () => {
  const box = sandbox();
  try {
    fs.mkdirSync(box.guard, { recursive: true });
    fs.writeFileSync(path.join(box.guard, "budgets.json"), JSON.stringify({
      version: 1,
      global: { daily: { unit: "usd", amount: 15 }, mode: "soft" },
    }));
    const text = await budget(box, "check");
    assert.equal(text.code, 0, text.err);
    assert.equal(text.out, "budgets.json: every setting is read as written (1 budget).");
  } finally { box.cleanup(); }
});

test("budget check reports unreadable settings in order and exits 1", async () => {
  const box = sandbox();
  try {
    fs.mkdirSync(box.guard, { recursive: true });
    fs.writeFileSync(path.join(box.guard, "budgets.json"), JSON.stringify({
      version: 1,
      global: { daily: { unit: "usd", amount: 15 }, mode: "block", dialy: 10 },
    }));
    const text = await budget(box, "check");
    assert.equal(text.code, 1);
    assert.deepEqual(text.out.split("\n"), [
      "budgets.json: 2 settings cannot be read as written.",
      '  global.mode is "block", which is neither "hard" nor "soft", so the budget is soft.',
      '  global has "dialy", a setting cost guard does not read, so it does nothing.',
    ]);
    const json = await budget(box, "check", "--json");
    assert.equal(json.code, 1);
    assert.deepEqual(JSON.parse(json.out), {
      ok: false,
      file: path.join(box.guard, "budgets.json"),
      invalid: false,
      problems: [
        { at: "global.mode", text: 'global.mode is "block", which is neither "hard" nor "soft", so the budget is soft.' },
        { at: "global.dialy", text: 'global has "dialy", a setting cost guard does not read, so it does nothing.' },
      ],
      budgets: 1,
    });
  } finally { box.cleanup(); }
});

test("budget check rejects a file that is not JSON", async () => {
  const box = sandbox();
  try {
    fs.mkdirSync(box.guard, { recursive: true });
    fs.writeFileSync(path.join(box.guard, "budgets.json"), "{not json");
    const text = await budget(box, "check");
    assert.equal(text.code, 1);
    assert.equal(text.out, `${path.join(box.guard, "budgets.json")} is not valid JSON, so no budget is in force. Fix it, or delete it to start again.`);
    const json = await budget(box, "check", "--json");
    assert.equal(json.code, 1);
    assert.deepEqual(JSON.parse(json.out), {
      ok: false,
      file: path.join(box.guard, "budgets.json"),
      invalid: true,
      problems: [],
      budgets: 0,
    });
  } finally { box.cleanup(); }
});

test("budget check treats a missing file as no budgets", async () => {
  const box = sandbox();
  try {
    const text = await budget(box, "check");
    assert.deepEqual(text, { code: 0, out: "No budgets set.", err: "" });
    const json = await budget(box, "check", "--json");
    assert.equal(json.code, 0, json.err);
    assert.deepEqual(JSON.parse(json.out), {
      ok: true,
      file: path.join(box.guard, "budgets.json"),
      invalid: false,
      problems: [],
      budgets: 0,
    });
  } finally { box.cleanup(); }
});

test("budget check --file reads the named file instead of the installed one", async () => {
  const box = sandbox();
  try {
    fs.mkdirSync(box.guard, { recursive: true });
    fs.writeFileSync(path.join(box.guard, "budgets.json"), JSON.stringify({ version: 1, global: { mode: "block" } }));
    const other = path.join(box.root, "dotfiles", "claude");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "budgets.json"), JSON.stringify({
      version: 1,
      global: { daily: { unit: "usd", amount: 15 }, mode: "soft" },
    }));
    const file = path.join(other, "budgets.json");
    const text = await budget(box, "check", "--file", file);
    assert.equal(text.code, 0, text.err);
    assert.equal(text.out, "budgets.json: every setting is read as written (1 budget).");
    const json = await budget(box, "check", "--file", file, "--json");
    assert.equal(json.code, 0, json.err);
    assert.deepEqual(JSON.parse(json.out), {
      ok: true,
      file,
      invalid: false,
      problems: [],
      budgets: 1,
    });
  } finally { box.cleanup(); }
});

test("budget check --file reports a problem in the named file and exits 1", async () => {
  const box = sandbox();
  try {
    const other = path.join(box.root, "dotfiles", "claude");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "budgets.json"), JSON.stringify({
      version: 1,
      global: { daily: { unit: "usd", amount: 15 }, mode: "block" },
    }));
    const file = path.join(other, "budgets.json");
    const text = await budget(box, "check", "--file", file);
    assert.equal(text.code, 1);
    assert.deepEqual(text.out.split("\n"), [
      "budgets.json: 1 setting cannot be read as written.",
      '  global.mode is "block", which is neither "hard" nor "soft", so the budget is soft.',
    ]);
    const json = await budget(box, "check", "--file", file, "--json");
    assert.equal(json.code, 1);
    assert.deepEqual(JSON.parse(json.out), {
      ok: false,
      file,
      invalid: false,
      problems: [{ at: "global.mode", text: 'global.mode is "block", which is neither "hard" nor "soft", so the budget is soft.' }],
      budgets: 1,
    });
  } finally { box.cleanup(); }
});

test("budget check --file takes a relative path from the current folder", async () => {
  const box = sandbox();
  try {
    const other = path.join(box.home, "dotfiles", "claude");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "budgets.json"), JSON.stringify({ version: 1 }));
    const text = await budget(box, "check", "--file", "dotfiles/claude/budgets.json");
    assert.equal(text.code, 0, text.err);
    assert.equal(text.out, "budgets.json: every setting is read as written (0 budgets).");
  } finally { box.cleanup(); }
});

test("budget check --file refuses a path that does not exist", async () => {
  const box = sandbox();
  try {
    const missing = path.join(box.root, "dotfiles", "claude", "budgets.json");
    const text = await budget(box, "check", "--file", missing);
    assert.equal(text.code, 1);
    assert.equal(text.out, "");
    assert.equal(text.err, `${missing}: no such file.`);
    const json = await budget(box, "check", "--file", missing, "--json");
    assert.equal(json.code, 1);
    assert.equal(json.out, "");
    assert.equal(json.err, `${missing}: no such file.`);
  } finally { box.cleanup(); }
});

test("budget check --file needs a value", async () => {
  const box = sandbox();
  try {
    const r = await budget(box, "check", "--file");
    assert.equal(r.code, 1);
    assert.equal(r.out, "");
    assert.equal(r.err, "--file needs a value, for example --file dotfiles/claude/budgets.json.");
  } finally { box.cleanup(); }
});

test("--file works with budget check only", async () => {
  const box = sandbox();
  try {
    for (const sub of ["set", "show", "clear", "extend"]) {
      const r = await budget(box, sub, "--file", "x");
      assert.equal(r.code, 1, sub);
      assert.equal(r.out, "", sub);
      assert.equal(r.err, "--file works with budget check only.", sub);
    }
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

test("budget set, show, extend, and clear with --model", async () => {
  const box = world();
  try {
    const r = await budget(box, "set", "--daily", "10usd", "--model", "opus");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^Budget set for opus: daily \$10 \(soft\)\.$/m);
    assert.match(r.out, /opus +today \$3\.40 of \$10 \(34%\) +\[soft\]/);

    const show = await budget(box, "show");
    assert.match(show.out, /opus +today \$3\.40 of \$10 \(34%\) +\[soft\]/);

    const ext = await budget(box, "extend", "5usd", "--model", "opus");
    assert.equal(ext.code, 0, ext.err);
    assert.match(ext.out, /Extended 1 budget by \$5 for today/);

    const clr = await budget(box, "clear", "--model", "opus");
    assert.equal(clr.code, 0, clr.err);
    assert.match(clr.out, /Cleared 1 limit\./);
  } finally { box.cleanup(); }
});

test("budget set --model notes a name that matches no model in the history, and still saves it", async () => {
  const box = world();
  try {
    const r = await budget(box, "set", "--daily", "10usd", "--model", "opuss");
    assert.equal(r.code, 0, r.err);
    const lines = r.out.split("\n");
    assert.equal(lines[0], "Budget set for opuss: daily $10 (soft).");
    assert.match(lines[1], /^Note: no model in your history contains "opuss" \(models seen: [^)]+\)\. Did you mean "opus"\? The budget is saved and counts a model once one matches\.$/);
    for (const m of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001", "claude-opus-4-6", "claude-fable-5-1"]) assert.ok(lines[1].includes(m), m);
    assert.match(lines[2], /^ {2}opuss +today \$0(?:\.00)? of \$10 \(0%\) +\[soft\]/);
    assert.ok(loadBudgets(box.cfg).models.some((m) => m.model === "opuss" && m.daily), "saved");
  } finally { box.cleanup(); }
});

test("budget set --model and budget show suggest the nearest model word for a typo", async () => {
  const box = world();
  try {
    for (const [typo, word] of [["opuss", "opus"], ["sonet", "sonnet"], ["haiko", "haiku"]]) {
      const r = await budget(box, "set", "--daily", "10usd", "--model", typo);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, new RegExp(`\\(models seen: [^)]+\\)\\. Did you mean "${word}"\\? The budget is saved and counts a model once one matches\\.`), typo);
    }
    const shown = await budget(box, "show");
    assert.equal(shown.code, 0, shown.err);
    assert.match(shown.out, /contains "opuss" \(models seen: [^)]+\)\. Did you mean "opus"\? That budget counts nothing until one matches\./);
    assert.match(shown.out, /contains "sonet" .* Did you mean "sonnet"\?/);
  } finally { box.cleanup(); }
});

test("budget set --model suggests a whole model id when that is the close one", async () => {
  const box = world();
  try {
    const r = await budget(box, "set", "--daily", "10usd", "--model", "claude-opus-5-5-");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Did you mean "claude-opus-5-5"\?/);
  } finally { box.cleanup(); }
});

test("budget set --model suggests nothing when no name is close", async () => {
  const box = world();
  try {
    for (const name of ["xyz", "gpt"]) {
      const r = await budget(box, "set", "--daily", "10usd", "--model", name);
      assert.equal(r.code, 0, r.err);
      assert.doesNotMatch(r.out, /Did you mean/, name);
      assert.match(r.out, /\(models seen: [^)]+\)\. The budget is saved and counts a model once one matches\./, name);
    }
  } finally { box.cleanup(); }
});

test("budget set --model says nothing extra when the name matches a model", async () => {
  const box = world();
  try {
    for (const name of ["opus", "OPUS", "claude-sonnet-5-5"]) {
      const r = await budget(box, "set", "--daily", "10usd", "--model", name);
      assert.equal(r.code, 0, r.err);
      assert.doesNotMatch(r.out, /Note:/, name);
    }
  } finally { box.cleanup(); }
});

test("budget set --model on a machine with no sessions yet says the name could not be checked", async () => {
  const box = sandbox();
  try {
    const r = await budget(box, "set", "--daily", "10usd", "--model", "opus");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^Note: no sessions found yet, so the name could not be checked\. The budget is saved and counts a model once one matches\.$/m);
    assert.doesNotMatch(r.out, /models seen/);
  } finally { box.cleanup(); }
});

test("budget show notes a model budget that matches no model in the history", async () => {
  const box = world();
  try {
    await budget(box, "set", "--daily", "10usd", "--model", "opuss");
    const r = await budget(box, "show");
    assert.equal(r.code, 0, r.err);
    const lines = r.out.split("\n").filter(Boolean);
    assert.match(lines[0], /^Budgets \(/);
    assert.match(lines[1], /^ {2}opuss +today \$0(?:\.00)? of \$10 \(0%\) +\[soft\]/);
    const notes = lines.filter((l) => l.startsWith("Note: no model"));
    assert.equal(notes.length, 1, r.out);
    assert.match(notes[0], /^Note: no model in your history contains "opuss" \(models seen: [^)]+\)\. Did you mean "opus"\? That budget counts nothing until one matches\.$/);
    assert.ok(lines.indexOf(notes[0]) > 1, "after the budget lines");
    assert.ok(loadBudgets(box.cfg).models.some((m) => m.model === "opuss" && m.daily), "left as saved");
  } finally { box.cleanup(); }
});

test("budget show says nothing extra for a model budget that matches, or a budget with no model", async () => {
  const box = world();
  try {
    await budget(box, "set", "--daily", "15usd");
    await budget(box, "set", "--daily", "10usd", "--model", "opus");
    const r = await budget(box, "show");
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /no model in your history/);
  } finally { box.cleanup(); }
});

test("budget show notes only the model budget that matches nothing, once", async () => {
  const box = world();
  try {
    await budget(box, "set", "--daily", "10usd", "--model", "opus");
    await budget(box, "set", "--daily", "10usd", "--model", "opuss");
    const r = await budget(box, "show");
    assert.equal(r.code, 0, r.err);
    const notes = r.out.split("\n").filter((l) => l.startsWith("Note: no model"));
    assert.equal(notes.length, 1, r.out);
    assert.ok(notes[0].includes('"opuss"'), notes[0]);
  } finally { box.cleanup(); }
});

test("budget show notes an unmatched name once when two budgets share it", async () => {
  const box = world();
  try {
    await budget(box, "set", "--daily", "10usd", "--model", "opuss");
    await budget(box, "set", "--daily", "5usd", "--model", "OPUSS", "--project", box.home);
    const r = await budget(box, "show");
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.split("\n").filter((l) => l.startsWith("Note: no model")).length, 1, r.out);
  } finally { box.cleanup(); }
});

test("budget show on a machine with no sessions yet notes nothing about model names", async () => {
  const box = sandbox();
  try {
    await budget(box, "set", "--daily", "10usd", "--model", "opuss");
    const r = await budget(box, "show");
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /no model in your history|no sessions found yet/);
  } finally { box.cleanup(); }
});

test("today and statusline display per-model budget when active", async () => {
  const box = world();
  try {
    await budget(box, "set", "--daily", "10usd", "--model", "opus");
    const today = await cli(box, ["today"]);
    assert.equal(today.code, 0, today.err);
    assert.match(today.out, /Budgets here:/);
    assert.match(today.out, /opus +today \$3\.40 of \$10 \(34%\) +\[soft\]/);

    const stat = await cli(box, ["statusline"], { stdin: "{}" });
    assert.equal(stat.code, 0, stat.err);
    assert.match(stat.out, /opus: today \$3\.40\/\$10/);
  } finally { box.cleanup(); }
});

test("a one-dash word is refused, not taken as a word that clears both limits", async () => {
  const box = sandbox();
  try {
    assert.equal((await budget(box, "set", "--daily", "15usd", "--weekly", "80usd", "--hard")).code, 0);
    const before = fs.readFileSync(path.join(box.guard, "budgets.json"), "utf8");
    for (const [argv, flag, command] of [
      [["budget", "clear", "-daily"], "-daily", "budget clear"],
      [["budget", "set", "--daily", "20usd", "-mode", "soft"], "-mode", "budget set"],
      [["budget", "clear", "---daily"], "---daily", "budget clear"],
    ]) {
      const r = await cli(box, argv);
      assert.deepEqual(r, { code: 1, out: "", err: `Unknown flag "${flag}" for "${command}". Did you mean "--${flag.replace(/^-+/, "")}"?` }, argv.join(" "));
    }
    assert.equal(fs.readFileSync(path.join(box.guard, "budgets.json"), "utf8"), before);
    const extend = await budget(box, "extend", "5usd");
    assert.equal(extend.code, 0, extend.err);
  } finally { box.cleanup(); }
});
