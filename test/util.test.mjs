// Pure helpers: local days and ISO weeks, number formatting, amounts, prices, usage parsing, paths, locks, files.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { amountArg, fmtAmount, fmtLimit, levelOf, niceStep, parseAmount } from "../src/budgets.mjs";
import { usageTokens } from "../src/parse.mjs";
import { FALLBACK_PRICE, PRICE, costOf, isKnownModel, priceFor } from "../src/prices.mjs";
import {
  UserError, addDays, clean, daysBetween, dayKeyOf, ellipsis, fmtInt, fmtMoney, fmtMoneyShort, fmtTokens, folderName, isInside, isoWeekKey,
  isoWeekStart, logError, normPath, parseArgs, readJson, releaseLock, startOfDayMs, stripBom, takeLock, weekStartDay, writeFileAtomic, writeJsonAtomic,
} from "../src/util.mjs";
import { near, sandbox } from "./helpers.mjs";

test("days: a local calendar date, in either direction", () => {
  assert.equal(dayKeyOf(new Date(2026, 9, 4, 0, 0, 0).getTime()), "2026-10-04");
  assert.equal(dayKeyOf(new Date(2026, 9, 4, 23, 59, 59).getTime()), "2026-10-04");
  assert.equal(dayKeyOf(new Date(2026, 9, 5, 0, 0, 0).getTime()), "2026-10-05");
  assert.equal(startOfDayMs("2026-10-04"), new Date(2026, 9, 4).getTime());
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addDays("2028-03-01", -1), "2028-02-29", "leap year");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-10-07", -34), "2026-09-03");
  assert.equal(daysBetween("2026-10-01", "2026-10-07"), 6);
  assert.equal(daysBetween("2026-10-07", "2026-10-01"), -6);
  assert.throws(() => addDays("2026-1-4", 1), UserError);
});

test("ISO weeks: Monday starts, week 1 holds January 4th, years can have 53 weeks", () => {
  const cases = {
    "2026-01-01": "2026-W01", "2025-12-29": "2026-W01", "2026-01-04": "2026-W01", "2026-01-05": "2026-W02",
    "2026-10-04": "2026-W40", "2026-10-05": "2026-W41", "2026-10-11": "2026-W41", "2026-10-12": "2026-W42",
    "2026-12-31": "2026-W53", "2027-01-01": "2026-W53", "2027-01-03": "2026-W53", "2027-01-04": "2027-W01",
    "2021-01-03": "2020-W53", "2024-12-30": "2025-W01", "2020-12-31": "2020-W53", "2023-01-01": "2022-W52",
  };
  for (const [day, week] of Object.entries(cases)) assert.equal(isoWeekKey(day), week, day);
  assert.equal(weekStartDay("2026-10-07"), "2026-10-05");
  assert.equal(weekStartDay("2026-10-05"), "2026-10-05", "a Monday is its own week start");
  assert.equal(weekStartDay("2026-10-11"), "2026-10-05", "so is the Sunday that ends the week");
  assert.equal(weekStartDay("2027-01-01"), "2026-12-28");
  assert.equal(isoWeekStart("2026-W41"), "2026-10-05");
  assert.equal(isoWeekStart("2026-W01"), "2025-12-29");
  assert.equal(isoWeekStart("2020-W53"), "2020-12-28");
  for (const day of Object.keys(cases)) assert.equal(isoWeekKey(isoWeekStart(isoWeekKey(day))), isoWeekKey(day), `round trip ${day}`);
});

test("the local day follows the time zone", () => {
  const code = `
    import { dayKeyOf, weekStartDay } from ${JSON.stringify(new URL("../src/util.mjs", import.meta.url).href)};
    const at = (d, h, m) => Date.UTC(2026, 9, d, h, m, 0);
    console.log(JSON.stringify([dayKeyOf(at(3, 18, 45)), dayKeyOf(at(3, 19, 0)), dayKeyOf(at(3, 5, 0)), weekStartDay(dayKeyOf(at(4, 19, 0)))]));`;
  const run = (tz) => JSON.parse(spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, TZ: tz }, encoding: "utf8" }).stdout);
  // the 3rd at 18:45, 19:00 and 05:00 UTC, and the Monday of the week of the 4th (a Sunday in UTC) at 19:00 UTC
  assert.deepEqual(run("UTC"), ["2026-10-03", "2026-10-03", "2026-10-03", "2026-09-28"]);
  assert.deepEqual(run("Asia/Kolkata"), ["2026-10-04", "2026-10-04", "2026-10-03", "2026-10-05"], "UTC+5:30: 18:45Z is already the 4th, and 19:00Z on the 4th is Monday the 5th, a new week");
  assert.deepEqual(run("America/Los_Angeles"), ["2026-10-03", "2026-10-03", "2026-10-02", "2026-09-28"], "UTC-7: 05:00Z is still the 2nd");
  assert.deepEqual(run("Asia/Kathmandu"), ["2026-10-04", "2026-10-04", "2026-10-03", "2026-10-05"], "UTC+5:45");
});

test("token and money formatting", () => {
  const tokens = [[0, "0"], [950, "950"], [1000, "1k"], [1234, "1.2k"], [12345, "12.3k"], [99999, "100k"], [123456, "123k"], [999499, "999k"], [999999, "1M"], [1e6, "1M"], [1500000, "1.5M"],
    [2345678, "2.35M"], [13100000, "13.1M"], [1e9, "1B"], [1234567890, "1.23B"], [-1500, "-1.5k"]];
  for (const [n, s] of tokens) assert.equal(fmtTokens(n), s, String(n));
  assert.equal(fmtMoney(0), "$0.00");
  assert.equal(fmtMoney(3.4), "$3.40");
  assert.equal(fmtMoney(1234.5), "$1,234.50");
  assert.equal(fmtMoney(1234567.891), "$1,234,567.89");
  assert.equal(fmtMoney(-2.5), "-$2.50");
  assert.equal(fmtMoneyShort(4.2), "$4.20");
  assert.equal(fmtMoneyShort(12.1), "$12.10");
  assert.equal(fmtMoneyShort(19.994), "$19.99");
  assert.equal(fmtMoneyShort(48), "$48");
  assert.equal(fmtMoneyShort(48.6), "$49");
  assert.equal(fmtMoneyShort(1234.4), "$1,234");
  assert.equal(fmtInt(1234567), "1,234,567");
  assert.equal(ellipsis("abcdefghij", 8), "abcde...");
  assert.equal(ellipsis("abc", 8), "abc");
});

test("amounts: dollars and tokens in the forms people type", () => {
  const good = {
    "$15": { unit: "usd", amount: 15 }, "15usd": { unit: "usd", amount: 15 }, "15USD": { unit: "usd", amount: 15 }, "15 usd": { unit: "usd", amount: 15 },
    "$15.50": { unit: "usd", amount: 15.5 }, "15.5usd": { unit: "usd", amount: 15.5 }, "$1,500": { unit: "usd", amount: 1500 }, "$ 15": { unit: "usd", amount: 15 },
    "15 dollars": { unit: "usd", amount: 15 }, "$.5": { unit: "usd", amount: 0.5 }, " $15 ": { unit: "usd", amount: 15 },
    "3M": { unit: "tokens", amount: 3e6 }, "3m": { unit: "tokens", amount: 3e6 }, "500k": { unit: "tokens", amount: 5e5 }, "500K": { unit: "tokens", amount: 5e5 },
    "1.5M": { unit: "tokens", amount: 1.5e6 }, "3M tokens": { unit: "tokens", amount: 3e6 }, "500k tok": { unit: "tokens", amount: 5e5 },
    "2000000 tokens": { unit: "tokens", amount: 2e6 }, "2B": { unit: "tokens", amount: 2e9 }, "1,500k": { unit: "tokens", amount: 1.5e6 }, "750 tokens": { unit: "tokens", amount: 750 },
  };
  for (const [text, want] of Object.entries(good)) assert.deepEqual(parseAmount(text), want, JSON.stringify(text));
  for (const text of ["", "  ", "15", "abc", "0usd", "$0", "0k", "-5usd", "5 apples", "usd", "$", "1e3usd", "15kusd", "k", "$15 per day", "99999999999999usd"]) {
    assert.throws(() => parseAmount(text), UserError, JSON.stringify(text));
  }
  assert.throws(() => parseAmount("15"), /dollars or tokens/, "a bare number could be either");
  assert.throws(() => parseAmount("5"), /quote it|15usd/, "and the error explains the shell problem with $15");
});

test("amounts are shown in a form that parses back, and without a $ that shells expand", () => {
  assert.equal(fmtLimit("usd", 15), "$15");
  assert.equal(fmtLimit("usd", 15.5), "$15.50");
  assert.equal(fmtLimit("usd", 1500), "$1,500");
  assert.equal(fmtLimit("tokens", 3e6), "3M");
  assert.equal(fmtAmount({ unit: "tokens", amount: 5e5 }), "500k tokens");
  assert.equal(fmtAmount({ unit: "usd", amount: 5 }), "$5");
  for (const [unit, amount] of [["usd", 5], ["usd", 2.5], ["usd", 0.2], ["tokens", 1e6], ["tokens", 500000], ["tokens", 1.5e6]]) {
    const arg = amountArg(unit, amount);
    assert.doesNotMatch(arg, /\$/);
    assert.deepEqual(parseAmount(arg), { unit, amount }, arg);
  }
  const steps = [[5, 5], [16.67, 20], [26.7, 20], [9 / 3, 2], [0.33, 0.2], [1e6, 1e6], [833333, 1e6], [1.2e6, 1e6], [40, 50], [100 / 3, 20], [0, 1]];
  for (const [x, want] of steps) assert.ok(near(niceStep(x), want, 1e-9), `${x} -> ${niceStep(x)}`);
});

test("levels: 50, 80 and 100 percent, with a hair of tolerance", () => {
  const levels = [[0, 0], [49.99, 0], [50, 50], [50.0000000001, 50], [49.9999999999, 50], [79.9, 50], [80, 80], [99.99, 80], [100, 100], [250, 100]];
  for (const [pct, want] of levels) assert.equal(levelOf(pct), want, String(pct));
});

test("prices: exact, by prefix (the longest wins), and a fallback", () => {
  assert.deepEqual(priceFor("claude-opus-5-5"), [4, 20, 0.2, 5, 8]);
  assert.deepEqual(priceFor("claude-opus-5-5-20261001"), [4, 20, 0.2, 5, 8], "not claude-opus-5");
  assert.deepEqual(priceFor("claude-opus-5"), [5, 25, 0.5, 6.25, 10]);
  assert.deepEqual(priceFor("claude-haiku-4-5-20251001"), [1, 5, 0.1, 1.25, 2]);
  assert.deepEqual(priceFor("claude-fable-5-1"), [10, 50, 0.25, 12.5, 20]);
  assert.deepEqual(priceFor("claude-fable-5-2"), [10, 50, 1, 12.5, 20], "an unknown newer fable: the fable-5 row");
  assert.deepEqual(priceFor("claude-sonnet-5-5[1m]"), [2, 10, 0.2, 2.5, 4]);
  assert.deepEqual(priceFor("gpt-whatever"), FALLBACK_PRICE);
  assert.deepEqual(priceFor(undefined), FALLBACK_PRICE);
  assert.equal(isKnownModel("claude-opus-4-8"), true);
  assert.equal(isKnownModel("something-else"), false);
  assert.equal(Object.keys(PRICE).length, 11);
  for (const row of Object.values(PRICE)) {
    assert.equal(row.length, 5);
    assert.ok(row[2] < row[0] && row[0] < row[3] && row[3] < row[4], "read < input < 5m write < 1h write");
  }
});

test("cost: input, output, cache reads and both kinds of cache write, per MTok", () => {
  assert.ok(near(costOf("claude-opus-5-5", 1e6, 0, 0, 0, 0), 4));
  assert.ok(near(costOf("claude-opus-5-5", 0, 1e6, 0, 0, 0), 20));
  assert.ok(near(costOf("claude-opus-5-5", 0, 0, 1e6, 0, 0), 5));
  assert.ok(near(costOf("claude-opus-5-5", 0, 0, 0, 1e6, 0), 8));
  assert.ok(near(costOf("claude-opus-5-5", 0, 0, 0, 0, 1e6), 0.2));
  assert.ok(near(costOf("claude-opus-5-5", 100000, 50000, 200000, 100000, 1000000), 3.4), "the first request of the reference data set");
  assert.ok(near(costOf("claude-fable-5-1", 10000, 4000, 8000, 2000, 100000), 0.465));
});

test("usage: the fields of a usage object, with iterations, cache lifetimes and thinking", () => {
  assert.deepEqual(usageTokens({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }), [10, 20, 40, 0, 30, 0]);
  assert.deepEqual(usageTokens({ input_tokens: 10, cache_creation_input_tokens: 40, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 30 } }), [10, 0, 10, 30, 0, 0]);
  assert.deepEqual(usageTokens({ cache_creation_input_tokens: 50, cache_creation: { ephemeral_1h_input_tokens: 20 } }), [0, 0, 30, 20, 0, 0], "a split that gives only the 1h part: the rest is 5m");
  assert.deepEqual(usageTokens({ cache_creation_input_tokens: 40, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 10 } }), [0, 0, 30, 10, 0, 0], "an unexplained part counts as 5m");
  assert.deepEqual(usageTokens({ output_tokens: 100, output_tokens_details: { thinking_tokens: 60 } }), [0, 100, 0, 0, 0, 60]);
  assert.deepEqual(usageTokens({ output_tokens: 10, output_tokens_details: { thinking_tokens: 60 } }), [0, 10, 0, 0, 0, 10], "thinking can never exceed output");
  assert.deepEqual(usageTokens({ input_tokens: 1, iterations: [{ input_tokens: 5, output_tokens: 6 }, { input_tokens: 7, output_tokens: 8, output_tokens_details: { thinking_tokens: 2 } }] }), [12, 14, 0, 0, 0, 2]);
  assert.deepEqual(usageTokens({ input_tokens: 9, iterations: [] }), [9, 0, 0, 0, 0, 0], "an empty iterations list is ignored");
  assert.deepEqual(usageTokens({ input_tokens: -5, output_tokens: "7", cache_read_input_tokens: NaN, cache_creation_input_tokens: null }), [0, 0, 0, 0, 0, 0], "junk is zero");
  assert.deepEqual(usageTokens({ input_tokens: 12.9 }), [12, 0, 0, 0, 0, 0]);
});

test("paths: folder names and 'inside' in either slash style", () => {
  assert.equal(folderName("D:\\Projects\\kite-vault"), "kite-vault");
  assert.equal(folderName("/home/dev/beta/"), "beta");
  assert.equal(folderName("C:\\"), "C:");
  assert.equal(folderName("/"), "/");
  assert.equal(folderName(""), "(unknown)");
  assert.equal(normPath("D:\\Projects\\App\\"), "d:/projects/app");
  assert.equal(isInside("D:\\Projects\\app\\src", "D:\\Projects\\app"), true);
  assert.equal(isInside("D:\\Projects\\app", "D:\\Projects\\app"), true);
  assert.equal(isInside("d:/projects/APP/src", "D:\\Projects\\app\\"), true, "Windows paths ignore case and slash style");
  assert.equal(isInside("D:\\Projects\\application", "D:\\Projects\\app"), false, "a folder with a similar name is not inside");
  assert.equal(isInside("D:\\Projects", "D:\\Projects\\app"), false, "the parent is not inside");
  assert.equal(isInside("/home/dev/beta/x", "/home/dev/beta"), true);
  assert.equal(isInside("/anything", "/"), true);
  assert.equal(isInside("", "/x"), false);
});

test("text from transcripts is made safe to print", () => {
  assert.equal(clean("a\u001b[31mb\u0007\nc\u2028d"), "a [31mb c d");
  assert.equal(clean("x".repeat(500), 10), "xxxxxxxxxx");
  assert.equal(clean(undefined), "");
  assert.equal(stripBom("\ufeffabc"), "abc");
  assert.equal(stripBom("abc"), "abc");
});

test("option parsing", () => {
  const a = parseArgs(["set", "--daily", "15usd", "--weekly=80usd", "--json", "--project", ".", "-h", "--days", "7", "extra"], ["json"]);
  assert.deepEqual(a, { _: ["set", "extra"], daily: "15usd", weekly: "80usd", json: true, project: ".", help: true, days: "7" });
  assert.equal(parseArgs(["--daily"]).daily, true, "a flag without a value");
  assert.equal(parseArgs(["--daily", "--weekly", "1usd"]).daily, true);
  assert.deepEqual(parseArgs(["extend", "-5usd"])._, ["extend", "-5usd"]);
  assert.deepEqual(parseArgs(["--", "--x"])._, ["--x"]);
});

test("files: atomic writes, tolerant reads, and a log that stays small", () => {
  const box = sandbox();
  try {
    const f = path.join(box.root, "a", "b.json");
    writeJsonAtomic(f, { a: 1 }, 2);
    assert.equal(fs.readFileSync(f, "utf8"), '{\n  "a": 1\n}\n');
    writeJsonAtomic(f, { a: 2 });
    assert.equal(fs.readFileSync(f, "utf8"), '{"a":2}');
    assert.deepEqual(fs.readdirSync(path.dirname(f)), ["b.json"], "no temp file left behind");
    writeFileAtomic(f, "\ufeff" + JSON.stringify({ bom: true }));
    assert.deepEqual(readJson(f), { bom: true });
    fs.writeFileSync(f, "{not json");
    assert.equal(readJson(f, "fallback"), "fallback");
    assert.equal(readJson(path.join(box.root, "missing.json")), null);
    for (let k = 0; k < 2000; k++) logError(box.cfg, `problem number ${k} ${"x".repeat(80)}`);
    const log = path.join(box.guard, "errors.log");
    assert.ok(fs.statSync(log).size < 80 * 1024, `${fs.statSync(log).size} bytes`);
    const lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
    assert.match(lines[lines.length - 1], /problem number 1999/, "the newest line is kept");
    assert.match(lines[0], /^\d{4}-\d\d-\d\dT/, "and every line starts with a time");
    logError(box.cfg, new Error("with a stack"));
    assert.match(fs.readFileSync(log, "utf8"), /with a stack/);
  } finally { box.cleanup(); }
});

test("locks: exclusive, released, and a dead one is taken over", () => {
  const box = sandbox();
  try {
    const lock = path.join(box.root, "x.lock");
    assert.equal(takeLock(lock), true);
    assert.equal(takeLock(lock), false, "held");
    const t0 = Date.now();
    assert.equal(takeLock(lock, { waitMs: 60 }), false, "still held after waiting");
    assert.ok(Date.now() - t0 >= 50, "it did wait");
    releaseLock(lock);
    assert.equal(takeLock(lock), true, "free again");
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(lock, old, old);
    assert.equal(takeLock(lock, { staleMs: 60000 }), true, "a lock nobody touched for 10 minutes belongs to a dead run");
    releaseLock(lock);
    releaseLock(lock); // releasing what is not held is fine
  } finally { box.cleanup(); }
});

test("local days hold up across daylight saving changes and unusual offsets (the quarter-hour day cache agrees with direct computation)", () => {
  const code = `
    import { makeDayOf } from ${JSON.stringify(new URL("../src/index.mjs", import.meta.url).href)};
    import { addDays, dayKeyOf, daysBetween, startOfDayMs, weekStartDay } from ${JSON.stringify(new URL("../src/util.mjs", import.meta.url).href)};
    const dayOf = makeDayOf();
    const sec = (y, m, d) => Date.UTC(y, m - 1, d) / 1000;
    let checked = 0;
    const bad = [];
    // every 7 minutes (never lined up with a cache bucket) across the spring and autumn changes of both hemispheres
    for (const [from, to] of [[sec(2026, 3, 1), sec(2026, 4, 15)], [sec(2026, 9, 20), sec(2026, 11, 15)]]) {
      for (let t = from; t < to; t += 7 * 60) { checked++; if (dayOf(t) !== dayKeyOf(t * 1000)) bad.push(t); }
    }
    // the calendar: every day follows the one before, every week starts on a Monday, and midnight belongs to its own day
    const calendar = [];
    let d = "2026-02-25";
    for (let k = 0; k < 280; k++) {
      const next = addDays(d, 1);
      if (daysBetween(d, next) !== 1) calendar.push(["step", d, next]);
      const ws = weekStartDay(d);
      const dow = new Date(Date.UTC(...ws.split("-").map((x, i) => (i === 1 ? Number(x) - 1 : Number(x))))).getUTCDay();
      if (dow !== 1 || daysBetween(ws, d) < 0 || daysBetween(ws, d) > 6) calendar.push(["week", d, ws]);
      if (dayKeyOf(startOfDayMs(d)) !== d) calendar.push(["midnight", d]);
      d = next;
    }
    console.log(JSON.stringify({ checked, bad: bad.slice(0, 3), calendar: calendar.slice(0, 3), last: d }));`;
  for (const tz of ["UTC", "America/Los_Angeles", "Europe/London", "Australia/Lord_Howe", "Asia/Kathmandu", "Pacific/Chatham", "America/Sao_Paulo", "Asia/Kolkata", "Pacific/Auckland", "Africa/Cairo"]) {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, TZ: tz }, encoding: "utf8" });
    assert.equal(r.status, 0, `${tz}: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.ok(out.checked > 15000, tz);
    assert.deepEqual(out.bad, [], `${tz}: instants whose cached day differs`);
    assert.deepEqual(out.calendar, [], `${tz}: calendar problems`);
    assert.equal(out.last, "2026-12-02", tz);
  }
});

test("temp files that a killed run left behind are cleaned up, fresh ones are not", async () => {
  const { cleanTmp } = await import("../src/util.mjs");
  const box = sandbox();
  try {
    fs.mkdirSync(box.guard, { recursive: true });
    const stale = path.join(box.guard, "index.json.123-abc.tmp");
    const fresh = path.join(box.guard, "budgets.json.456-def.tmp");
    const other = path.join(box.guard, "notes.txt");
    for (const f of [stale, fresh, other]) fs.writeFileSync(f, "x");
    const old = new Date(Date.now() - 3600e3);
    fs.utimesSync(stale, old, old);
    fs.utimesSync(other, old, old);
    cleanTmp(box.guard);
    assert.deepEqual(fs.readdirSync(box.guard).sort(), ["budgets.json.456-def.tmp", "notes.txt"]);
    cleanTmp(path.join(box.root, "missing")); // no folder: no error
  } finally { box.cleanup(); }
});

test("displayed percentages are rounded, but never show a threshold that has not been reached", async () => {
  const { displayPct } = await import("../src/budgets.mjs");
  const cases = [[0, 0], [12.96, 13], [12.4, 12], [49.7, 49], [49.99, 49], [50, 50], [50.4, 50], [63.47, 63], [79.5, 79], [79.6, 79], [79.99, 79], [80, 80], [80.67, 81],
    [99.4, 99], [99.6, 99], [99.99, 99], [100, 100], [100.4, 100], [105.78, 106], [149.5, 150], [1000, 1000]];
  for (const [pct, want] of cases) assert.equal(displayPct(pct), want, String(pct));
  assert.equal(displayPct(79.9999999999), 80, "a hair of float error counts as reached, like levelOf");
});
