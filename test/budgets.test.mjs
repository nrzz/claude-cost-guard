// Budgets: the file, project and global scopes, today-only extensions, and usage against limits.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  applicable, clearBudget, entriesOf, evaluate, extendBudget, isOver, limitKeys, loadBudgets, parseAmount, saveBudgets, setBudget,
} from "../src/budgets.mjs";
import { refresh } from "../src/index.mjs";
import { buildCells } from "../src/usage.mjs";
import { ALPHA, BETA, NOW, buildFixture, expected, near, readJson, sandbox } from "./helpers.mjs";

const TODAY = "2026-10-07";
const usd = (n) => ({ unit: "usd", amount: n });
const tok = (n) => ({ unit: "tokens", amount: n });
const fresh = () => ({ version: 1, global: null, projects: [], invalid: false });

test("a missing budgets file means no budgets; a broken one is flagged, not trusted", () => {
  const box = sandbox();
  try {
    assert.deepEqual(loadBudgets(box.cfg), fresh());
    fs.mkdirSync(box.guard, { recursive: true });
    fs.writeFileSync(path.join(box.guard, "budgets.json"), "{broken");
    const b = loadBudgets(box.cfg);
    assert.equal(b.invalid, true);
    assert.deepEqual(entriesOf(b), []);
    fs.writeFileSync(path.join(box.guard, "budgets.json"), "[1,2]");
    assert.equal(loadBudgets(box.cfg).invalid, true, "valid JSON of the wrong kind");
  } finally { box.cleanup(); }
});

test("budgets round-trip through the file, and junk inside it is dropped", () => {
  const box = sandbox();
  try {
    const b = fresh();
    setBudget(b, { daily: usd(15), weekly: usd(80), mode: "hard" });
    setBudget(b, { dir: ALPHA, daily: tok(3e6) });
    saveBudgets(box.cfg, b);
    assert.deepEqual(readJson(path.join(box.guard, "budgets.json")), {
      version: 1,
      global: { daily: usd(15), weekly: usd(80), mode: "hard" },
      projects: [{ dir: ALPHA, daily: tok(3e6), mode: "soft" }],
    });
    assert.deepEqual(loadBudgets(box.cfg), b);
    fs.writeFileSync(path.join(box.guard, "budgets.json"), JSON.stringify({
      global: { daily: { unit: "usd", amount: -5 }, weekly: { unit: "euros", amount: 5 }, mode: "extreme" },
      projects: [{ dir: "", daily: usd(1) }, { daily: usd(1) }, { dir: "/ok", daily: usd(2), mode: "hard", ext: { day: TODAY, usd: 3, tokens: "x" } }, "nonsense"],
    }));
    const loaded = loadBudgets(box.cfg);
    assert.deepEqual(entriesOf(loaded).map((e) => e.key), ["/ok"], "no valid limit: no budget");
    assert.deepEqual(loaded.projects[0].ext, { day: TODAY, usd: 3, tokens: 0 });
    assert.equal(loaded.projects[0].mode, "hard");
  } finally { box.cleanup(); }
});

test("set: all projects or one project, daily and/or weekly; the mode is kept unless changed", () => {
  const b = fresh();
  setBudget(b, { daily: usd(15) });
  assert.deepEqual(b.global, { daily: usd(15), mode: "soft" });
  setBudget(b, { weekly: usd(80), mode: "hard" });
  assert.deepEqual(b.global, { daily: usd(15), weekly: usd(80), mode: "hard" });
  setBudget(b, { daily: usd(20) });
  assert.deepEqual(b.global, { daily: usd(20), weekly: usd(80), mode: "hard" }, "changing a limit does not reset the mode");
  setBudget(b, { dir: "D:\\work\\alpha", daily: usd(5) });
  setBudget(b, { dir: "d:/work/ALPHA/", weekly: usd(30) });
  assert.equal(b.projects.length, 1, "the same folder in another spelling is the same budget");
  assert.deepEqual(b.projects[0], { dir: "D:\\work\\alpha", daily: usd(5), weekly: usd(30), mode: "soft" });
  setBudget(b, { dir: BETA, daily: tok(1e6) });
  assert.equal(b.projects.length, 2);
});

test("which budgets apply where: all-projects everywhere, a project budget inside its folder", () => {
  const b = fresh();
  setBudget(b, { daily: usd(15) });
  setBudget(b, { dir: ALPHA, daily: usd(5) });
  setBudget(b, { dir: BETA, daily: usd(7) });
  const labels = (cwd) => applicable(b, cwd).map((e) => e.label);
  assert.deepEqual(labels("D:\\work\\alpha"), ["all projects", "alpha"]);
  assert.deepEqual(labels("D:\\work\\alpha\\src\\deep"), ["all projects", "alpha"], "a subfolder belongs to the project");
  assert.deepEqual(labels("d:/work/ALPHA"), ["all projects", "alpha"], "any slash style, any case on Windows paths");
  assert.deepEqual(labels("D:\\work\\alphabet"), ["all projects"], "a folder that only starts with the same letters is another project");
  assert.deepEqual(labels("/home/dev/beta/x"), ["all projects", "beta"]);
  assert.deepEqual(labels(""), ["all projects"], "no folder known: only the all-projects budget");
  assert.deepEqual(labels("/elsewhere"), ["all projects"]);
  const nested = fresh();
  setBudget(nested, { dir: "D:\\work", daily: usd(50) });
  setBudget(nested, { dir: ALPHA, daily: usd(5) });
  assert.deepEqual(applicable(nested, "D:\\work\\alpha").map((e) => e.label), ["work", "alpha"], "nested folders: both count");
});

test("clear: everything, one project, the all-projects budget, or only one period", () => {
  const make = () => {
    const b = fresh();
    setBudget(b, { daily: usd(15), weekly: usd(80) });
    setBudget(b, { dir: ALPHA, daily: usd(5), weekly: usd(30) });
    setBudget(b, { dir: BETA, daily: usd(7) });
    return b;
  };
  let b = make();
  assert.equal(clearBudget(b, {}), 5, "everything");
  assert.deepEqual([b.global, b.projects], [null, []]);
  b = make();
  assert.equal(clearBudget(b, { dir: "d:/work/alpha" }), 2);
  assert.deepEqual(b.projects.map((p) => p.dir), [BETA]);
  assert.ok(b.global);
  b = make();
  assert.equal(clearBudget(b, { all: true }), 2);
  assert.equal(b.global, null);
  assert.equal(b.projects.length, 2, "--all is the all-projects budget, not everything");
  b = make();
  assert.equal(clearBudget(b, { weekly: true }), 2, "only weekly limits, wherever they are");
  assert.deepEqual([b.global.daily, b.global.weekly], [usd(15), undefined]);
  assert.equal(b.projects.length, 2);
  b = make();
  assert.equal(clearBudget(b, { dir: BETA, weekly: true }), 0, "nothing weekly there");
  assert.equal(clearBudget(fresh(), {}), 0);
  assert.deepEqual(limitKeys(entriesOf(make())), ["all|daily", "all|weekly", "d:/work/alpha|daily", "d:/work/alpha|weekly", "/home/dev/beta|daily"]);
});

test("extend: raises the limit for one day, per unit", () => {
  const b = fresh();
  setBudget(b, { daily: usd(15), weekly: usd(80) });
  setBudget(b, { dir: ALPHA, daily: tok(3e6) });
  const keys = extendBudget(b, usd(5), {}, TODAY);
  assert.deepEqual(keys, ["all"], "only budgets counted in dollars");
  const e = entriesOf(b).find((x) => x.key === "all");
  assert.equal(JSON.stringify(e.ext), JSON.stringify({ day: TODAY, usd: 5, tokens: 0 }));
  extendBudget(b, usd(2), {}, TODAY);
  assert.equal(b.global.ext.usd, 7, "extensions add up");
  assert.deepEqual(extendBudget(b, tok(1e6), {}, TODAY), ["d:/work/alpha"]);
  assert.deepEqual(extendBudget(b, usd(1), { dir: ALPHA }, TODAY), [], "that project has no dollar budget");
  assert.deepEqual(extendBudget(b, usd(1), { all: true }, TODAY), ["all"]);
  // another day starts a fresh extension
  extendBudget(b, usd(4), {}, "2026-10-08");
  assert.deepEqual(b.global.ext, { day: "2026-10-08", usd: 4, tokens: 0 });
});

test("an extension counts today and not tomorrow", () => {
  const b = fresh();
  setBudget(b, { daily: usd(15), weekly: usd(80) });
  extendBudget(b, usd(5), {}, TODAY);
  const [e] = entriesOf(b);
  const slots = (day) => evaluate([], [e], day);
  assert.deepEqual(slots(TODAY).map((s) => [s.period, s.base, s.extra, s.limit]), [["daily", 15, 5, 20], ["weekly", 80, 5, 85]]);
  assert.deepEqual(slots("2026-10-08").map((s) => [s.period, s.base, s.extra, s.limit]), [["daily", 15, 0, 15], ["weekly", 80, 0, 80]]);
});

test("usage against limits: global and project budgets, daily and weekly, dollars and tokens", () => {
  const box = sandbox();
  try {
    buildFixture(box);
    const { idx } = refresh(box.cfg, { now: NOW, full: true });
    const cells = buildCells(idx, { fromDay: "2026-10-05", toDay: TODAY });
    const b = fresh();
    setBudget(b, { daily: usd(19.04), weekly: tok(2792000) });
    setBudget(b, { dir: ALPHA, daily: usd(10), weekly: usd(5) });
    setBudget(b, { dir: BETA, daily: tok(3.5e6) });
    const slots = evaluate(cells, entriesOf(b), TODAY);
    const by = Object.fromEntries(slots.map((s) => [s.key, s]));
    assert.ok(near(by["all|daily"].used, expected.today.cost), "all projects, today, dollars");
    assert.ok(near(by["all|daily"].pct, 50), `${by["all|daily"].pct}`);
    assert.equal(by["all|weekly"].used, expected.week.fresh, "all projects, this week, tokens");
    assert.equal(by["all|weekly"].pct, 100);
    assert.ok(near(by["d:/work/alpha|daily"].used, 6.02), "alpha today: 3.40 + 2.40 + 0.22");
    assert.ok(near(by["d:/work/alpha|weekly"].used, 6.87), "alpha this week adds Tuesday's 0.70 and Monday's 0.15");
    assert.equal(by["/home/dev/beta|daily"].used, 1600000, "beta today in tokens");
    assert.ok(near(by["/home/dev/beta|daily"].pct, (1600000 / 3.5e6) * 100));
    assert.equal(by["d:/work/alpha|weekly"].isGlobal, false);
    assert.equal(by["all|daily"].isGlobal, true);
    assert.equal(isOver(by["d:/work/alpha|weekly"]), true, "$6.87 of $5");
    assert.equal(isOver(by["all|daily"]), false);
    assert.equal(isOver(by["all|weekly"]), true, "exactly 100% counts as used");
    assert.equal(slots.length, 5);
  } finally { box.cleanup(); }
});

test("amounts parse the same whether they come from the command line or the file", () => {
  assert.deepEqual(parseAmount("15usd"), usd(15));
  assert.deepEqual(parseAmount("3M"), tok(3e6));
});
