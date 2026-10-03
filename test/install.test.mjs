// init, uninstall and status: what they write, what they leave alone, and that undoing is exact.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hookEntryFor, init, isOurHook, mergeHook, readSettings, removeHook, status, uninstall } from "../src/install.mjs";
import { ALPHA, S1, at, buildFixture, ls, readJson, runCli, runGuard, sandbox, usage } from "./helpers.mjs";

function io() {
  const out = [];
  const err = [];
  return { out: (s = "") => out.push(s), err: (s = "") => err.push(s), get text() { return out.join("\n"); }, get errText() { return err.join("\n"); } };
}
const doInit = (box, opts = {}) => { const o = io(); const code = init({ env: box.env, ...opts }, o); return { code, text: o.text, err: o.errText }; };
const doUninstall = (box, opts = {}) => { const o = io(); const code = uninstall({ env: box.env, ...opts }, o); return { code, text: o.text, err: o.errText }; };
const doStatus = (box) => { const o = io(); const code = status({ env: box.env }, o); return { code, text: o.text }; };
const settingsPath = (box) => box.path("settings.json");
const backups = (box) => ls(box.cfg).filter((f) => /^settings\.json\.bak-cost-guard-\d{8}-\d{6}(-\d+)?$/.test(f));
const entry = (box) => hookEntryFor(box.cfg);

const MINE = { type: "command", command: "echo mine" };
const ORIGINAL = {
  model: "opus",
  permissions: { allow: ["Bash(npm test)", "Read(~/notes/**)"], deny: ["Bash(rm -rf *)"], defaultMode: "acceptEdits" },
  env: { FOO: "bar", UNICODE: "café ☕ 日本語" },
  hooks: {
    PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "echo done" }] }],
    UserPromptSubmit: [{ hooks: [MINE] }],
  },
  enabledPlugins: { "a@b": true },
  cleanupPeriodDays: 30,
};

test("the hook entry is exec form: node, the script and 'prompt', forward slashes, a timeout", () => {
  const box = sandbox();
  try {
    const e = entry(box);
    assert.deepEqual(Object.keys(e), ["type", "command", "args", "timeout"]);
    assert.equal(e.type, "command");
    assert.equal(e.command, "node");
    assert.equal(e.timeout, 10);
    assert.equal(e.args.length, 2);
    assert.equal(e.args[1], "prompt");
    assert.doesNotMatch(e.args[0], /\\/);
    assert.equal(e.args[0], path.join(box.cfg, "cost-guard", "app", "guard.mjs").replace(/\\/g, "/"));
  } finally { box.cleanup(); }
});

test("our hook is recognised by its script path, in any spelling, and nothing else is", () => {
  const forms = [
    { type: "command", command: "node", args: ["C:/Users/me/.claude/cost-guard/app/guard.mjs", "prompt"] },
    { type: "command", command: "node", args: ["C:\\Users\\me\\.claude\\cost-guard\\app\\guard.mjs", "prompt"] },
    { type: "command", command: 'node "/home/me/.claude/cost-guard/app/guard.mjs" prompt' },
    { type: "command", command: "node", args: ["/tmp/x/cost-guard/app/guard.mjs"] },
  ];
  for (const f of forms) assert.equal(isOurHook(f), true, JSON.stringify(f));
  const others = [
    MINE, { type: "command", command: "echo cost-guard" }, { type: "command", command: "node", args: ["/other/guard.mjs", "prompt"] },
    { type: "command", command: "node", args: ["/x/cost-guard/guard.mjs"] }, { type: "command", command: "node", args: ["/x/cost-guard/app/other.mjs"] },
    null, "text", 5, {}, { args: "not an array" },
  ];
  for (const o of others) assert.equal(isOurHook(o), false, JSON.stringify(o));
});

test("init into an empty config folder", () => {
  const box = sandbox();
  try {
    const r = doInit(box);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(readJson(settingsPath(box)), { hooks: { UserPromptSubmit: [{ hooks: [entry(box)] }] } });
    assert.equal(fs.readFileSync(settingsPath(box), "utf8"), `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [entry(box)] }] } }, null, 2)}\n`, "two-space JSON and a final newline");
    assert.deepEqual(backups(box), [], "nothing existed to back up");
    const app = path.join(box.cfg, "cost-guard", "app");
    for (const f of ["guard.mjs", "package.json", "bin/claude-cost-guard.mjs", "src/cli.mjs", "src/hook.mjs", "src/index.mjs", "src/budgets.mjs", "src/usage.mjs", "src/util.mjs", "src/prices.mjs", "src/parse.mjs", "src/install.mjs", "src/report.mjs"]) {
      assert.ok(fs.existsSync(path.join(app, f)), f);
    }
    assert.ok(fs.existsSync(entry(box).args[0]), "the command points at a real file");
    assert.match(r.text, /copied guard\.mjs, bin\/ and src\/ into /);
    assert.match(r.text, /settings\.json: UserPromptSubmit hook added \(other settings untouched\)/);
    assert.match(r.text, /checked: the installed guard runs \(version 1\.0\.0\)/);
    assert.match(r.text, /no transcripts yet under|indexed \d+ requests from \d+ transcripts/);
    assert.match(r.text, /claude-cost-guard budget set --daily 15usd --weekly 80usd/);
    // nothing escaped the config folder
    assert.deepEqual(ls(box.root), ["c", "h"]);
    assert.deepEqual(ls(box.home), [], "HOME is untouched");
    assert.deepEqual(ls(box.cfg).filter((f) => f !== "cost-guard" && f !== "settings.json"), []);
  } finally { box.cleanup(); }
});

test("init keeps every other setting, backs settings.json up first, and puts our hook after the others", () => {
  const box = sandbox();
  try {
    const original = `${JSON.stringify(ORIGINAL, null, 4)}\n`;
    fs.writeFileSync(settingsPath(box), original);
    const r = doInit(box);
    assert.equal(r.code, 0, r.err);
    const settings = readJson(settingsPath(box));
    assert.deepEqual({ ...settings, hooks: undefined }, { ...ORIGINAL, hooks: undefined }, "everything but hooks is as it was");
    assert.deepEqual(Object.keys(settings), Object.keys(ORIGINAL), "key order kept");
    assert.deepEqual(settings.hooks.PostToolUse, ORIGINAL.hooks.PostToolUse);
    assert.deepEqual(settings.hooks.UserPromptSubmit, [{ hooks: [MINE] }, { hooks: [entry(box)] }], "the existing hook first, ours after it");
    assert.equal(fs.readFileSync(settingsPath(box), "utf8"), `${JSON.stringify(settings, null, 2)}\n`);
    const [backup, ...rest] = backups(box);
    assert.equal(rest.length, 0, "exactly one backup");
    assert.equal(fs.readFileSync(box.path(backup), "utf8"), original, "the backup is the original, byte for byte");
    assert.match(r.text, new RegExp(`backed up settings\\.json to .*${backup.replace(/\./g, "\\.")}`));
  } finally { box.cleanup(); }
});

test("init twice changes nothing the second time: one entry, no second backup", () => {
  const box = sandbox();
  try {
    fs.writeFileSync(settingsPath(box), JSON.stringify(ORIGINAL));
    doInit(box);
    const after1 = fs.readFileSync(settingsPath(box), "utf8");
    const r = doInit(box);
    assert.equal(r.code, 0);
    assert.match(r.text, /settings\.json already runs the guard \(UserPromptSubmit\)/);
    assert.equal(fs.readFileSync(settingsPath(box), "utf8"), after1);
    assert.equal(backups(box).length, 1);
    const ours = readJson(settingsPath(box)).hooks.UserPromptSubmit.flatMap((g) => g.hooks).filter(isOurHook);
    assert.equal(ours.length, 1);
  } finally { box.cleanup(); }
});

test("init collapses copies of our hook into one, in the place of the first, and renews a stale one", () => {
  const box = sandbox();
  try {
    const stale = { type: "command", command: "node", args: [`${box.cfg}\\cost-guard\\app\\guard.mjs`, "prompt"], timeout: 3 };
    const copy = { type: "command", command: `node "${box.cfg}/cost-guard/app/guard.mjs" prompt` };
    const seed = { hooks: { UserPromptSubmit: [{ hooks: [MINE, stale] }, { hooks: [copy] }, { hooks: [{ type: "command", command: "echo last" }] }] } };
    fs.writeFileSync(settingsPath(box), JSON.stringify(seed));
    const r = doInit(box);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(readJson(settingsPath(box)).hooks.UserPromptSubmit, [
      { hooks: [MINE, entry(box)] },
      { hooks: [{ type: "command", command: "echo last" }] },
    ], "the stale entry was replaced where it stood, the repeat in its own group is gone with the group");
    assert.equal(backups(box).length, 1);
    assert.equal(doStatus(box).text.includes("entries"), false, "and status sees one entry");
  } finally { box.cleanup(); }
});

test("init leaves a settings.json that is not valid JSON untouched, prints what to add, and exits 1", () => {
  const box = sandbox();
  try {
    const broken = '{ "model": "opus", // a comment\n  "hooks": ';
    fs.writeFileSync(settingsPath(box), broken);
    const r = doInit(box);
    assert.equal(r.code, 1);
    assert.equal(fs.readFileSync(settingsPath(box), "utf8"), broken, "untouched");
    assert.deepEqual(backups(box), [], "nothing to back up when nothing changes");
    assert.match(r.err, /is not valid JSON/);
    assert.match(r.err, /"UserPromptSubmit"/);
    assert.ok(r.err.includes(entry(box).args[0]), "the snippet names the script");
    const snippet = r.err.slice(r.err.indexOf("{"));
    const parsed = JSON.parse(snippet);
    assert.deepEqual(parsed.hooks.UserPromptSubmit[0].hooks[0], entry(box), "the snippet is the exact entry");
    assert.ok(fs.existsSync(entry(box).args[0]), "the copy is there, so pasting the snippet works");
    assert.doesNotMatch(r.text, /Next, set a budget/);
    fs.writeFileSync(settingsPath(box), "{}");
    assert.equal(doInit(box).code, 0, "once the file is fixed, init goes through");
  } finally { box.cleanup(); }
});

test("a settings.json whose hooks have an unexpected shape is left alone like invalid JSON", () => {
  const box = sandbox();
  try {
    for (const seed of [{ hooks: [] }, { hooks: "text" }, { hooks: { UserPromptSubmit: { not: "an array" } } }, []]) {
      const text = JSON.stringify(seed);
      fs.writeFileSync(settingsPath(box), text);
      const r = doInit(box);
      assert.equal(r.code, 1, text);
      assert.equal(fs.readFileSync(settingsPath(box), "utf8"), text, text);
      assert.equal(readSettings(settingsPath(box)).status, "invalid");
    }
    assert.equal(readSettings(settingsPath(box)).status, "invalid");
    fs.writeFileSync(settingsPath(box), "");
    assert.equal(readSettings(settingsPath(box)).status, "ok", "an empty file is an empty object");
    assert.equal(readSettings(path.join(box.cfg, "missing.json")).status, "missing");
    fs.writeFileSync(settingsPath(box), "\ufeff{}");
    assert.equal(readSettings(settingsPath(box)).status, "ok", "a byte order mark is fine");
  } finally { box.cleanup(); }
});

test("uninstall puts settings.json back exactly as it was", () => {
  const box = sandbox();
  try {
    fs.writeFileSync(settingsPath(box), JSON.stringify(ORIGINAL, null, 2) + "\n");
    doInit(box);
    assert.notEqual(JSON.stringify(readJson(settingsPath(box))), JSON.stringify(ORIGINAL));
    const r = doUninstall(box);
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.readFileSync(settingsPath(box), "utf8"), JSON.stringify(ORIGINAL, null, 2) + "\n", "same bytes: same keys, same order, same hooks");
    assert.equal(backups(box).length, 2, "one backup from init, one from uninstall");
    assert.match(r.text, /removed 1 UserPromptSubmit hook from settings\.json \(other settings untouched\)/);
    assert.match(r.text, /removed .*cost-guard.app/);
    assert.equal(fs.existsSync(path.join(box.cfg, "cost-guard", "app")), false);
  } finally { box.cleanup(); }
});

test("uninstall removes the containers it emptied, and from a fresh install leaves an empty settings object", () => {
  const box = sandbox();
  try {
    doInit(box);
    doUninstall(box);
    assert.deepEqual(readJson(settingsPath(box)), {});
    fs.writeFileSync(settingsPath(box), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [MINE] }] } }));
    doInit(box);
    doUninstall(box);
    assert.deepEqual(readJson(settingsPath(box)), { hooks: { PostToolUse: [{ hooks: [MINE] }] } }, "only the UserPromptSubmit key we added is gone");
  } finally { box.cleanup(); }
});

test("uninstall touches nothing but our own entry: look-alikes stay", () => {
  const box = sandbox();
  try {
    const keep = [
      { type: "command", command: "echo cost-guard" },
      { type: "command", command: "node", args: ["/elsewhere/guard.mjs", "prompt"] },
      { type: "command", command: "node", args: ["/x/cost-guard/app/other.mjs"] },
    ];
    fs.writeFileSync(settingsPath(box), JSON.stringify({ hooks: { UserPromptSubmit: [{ matcher: "*", hooks: [...keep, entry(box)] }] } }));
    const r = doUninstall(box);
    assert.equal(r.code, 0);
    assert.deepEqual(readJson(settingsPath(box)), { hooks: { UserPromptSubmit: [{ matcher: "*", hooks: keep }] } });
  } finally { box.cleanup(); }
});

test("uninstall keeps your budgets and the index unless asked, and --purge removes them", () => {
  const box = sandbox();
  try {
    buildFixture(box);
    doInit(box);
    fs.writeFileSync(path.join(box.guard, "budgets.json"), JSON.stringify({ version: 1, global: { daily: { unit: "usd", amount: 5 } } }));
    const r = doUninstall(box);
    assert.match(r.text, /kept .*cost-guard \(your budgets and the index\); add --purge to delete it too/);
    assert.deepEqual(ls(box.guard), ["budgets.json", "index.json"]);
    const p = doUninstall(box, { purge: true });
    assert.match(p.text, /removed .*cost-guard \(the index, budgets and state\)/);
    assert.equal(fs.existsSync(box.guard), false);
    assert.ok(fs.existsSync(box.projects), "transcripts are never touched");
    assert.equal(ls(box.projects).length > 0, true);
  } finally { box.cleanup(); }
});

test("uninstall when nothing is installed says so and changes nothing", () => {
  const box = sandbox();
  try {
    const r = doUninstall(box);
    assert.equal(r.code, 0);
    assert.match(r.text, /nothing to remove: claude-cost-guard is not installed here\./);
    assert.deepEqual(ls(box.cfg), []);
    fs.writeFileSync(settingsPath(box), JSON.stringify(ORIGINAL));
    const again = doUninstall(box);
    assert.match(again.text, /nothing to remove/);
    assert.deepEqual(backups(box), [], "no backup when nothing changes");
    assert.equal(fs.readFileSync(settingsPath(box), "utf8"), JSON.stringify(ORIGINAL));
  } finally { box.cleanup(); }
});

test("uninstall with an unreadable settings.json changes nothing and says why", () => {
  const box = sandbox();
  try {
    doInit(box);
    fs.writeFileSync(settingsPath(box), "{ nope");
    const r = doUninstall(box);
    assert.equal(r.code, 1);
    assert.match(r.err, /is not valid JSON.*nothing was changed/s);
    assert.equal(fs.readFileSync(settingsPath(box), "utf8"), "{ nope");
    assert.ok(fs.existsSync(path.join(box.cfg, "cost-guard", "app")), "the copy stays: the hook may still point at it");
  } finally { box.cleanup(); }
});

test("two changes in the same second keep both backups", () => {
  const box = sandbox();
  try {
    fs.writeFileSync(settingsPath(box), JSON.stringify({ a: 1 }));
    doInit(box);
    doUninstall(box);
    doInit(box);
    doUninstall(box);
    const names = backups(box);
    assert.equal(names.length, 4);
    assert.equal(new Set(names).size, 4);
    assert.deepEqual(readJson(settingsPath(box)), { a: 1 });
  } finally { box.cleanup(); }
});

test("the plugin and init together would run the hook twice: init, status and uninstall say so", () => {
  const box = sandbox();
  try {
    fs.writeFileSync(settingsPath(box), JSON.stringify({ enabledPlugins: { "cost-guard@claude-cost-guard": true, "other@x": true } }));
    const r = doInit(box);
    assert.match(r.text, /! the plugin cost-guard@claude-cost-guard is enabled as well and runs the same hook/);
    const s = doStatus(box);
    assert.match(s.text, /plugin +cost-guard@claude-cost-guard is enabled +\(! the hook then runs twice; keep one\)/);
    const u = doUninstall(box);
    assert.match(u.text, /! the plugin cost-guard@claude-cost-guard is still enabled; remove it with \/plugin uninstall/);
    assert.deepEqual(readJson(settingsPath(box)).enabledPlugins, { "cost-guard@claude-cost-guard": true, "other@x": true }, "the plugin setting is not ours to change");
    fs.writeFileSync(settingsPath(box), JSON.stringify({ enabledPlugins: { "cost-guard@claude-cost-guard": false } }));
    assert.doesNotMatch(doStatus(box).text, /plugin/);
  } finally { box.cleanup(); }
});

test("only --scope user is supported", () => {
  const box = sandbox();
  try {
    const r = doInit(box, { scope: "project" });
    assert.equal(r.code, 1);
    assert.match(r.err, /Only --scope user is supported/);
    assert.deepEqual(ls(box.cfg), [], "nothing was written");
    assert.equal(doInit(box, { scope: "user" }).code, 0);
  } finally { box.cleanup(); }
});

test("status: what is installed, the budgets, the index and today", () => {
  const box = sandbox();
  try {
    buildFixture(box);
    const before = doStatus(box).text;
    assert.match(before, /^claude-cost-guard 1\.0\.0$/m);
    assert.match(before, /hook +not in settings\.json \(claude-cost-guard init adds it\)/);
    assert.match(before, /budgets +none \(claude-cost-guard budget set --daily 15usd\)/);
    assert.match(before, /errors +none/);
    doInit(box);
    fs.mkdirSync(box.guard, { recursive: true });
    fs.writeFileSync(path.join(box.guard, "budgets.json"), JSON.stringify({ version: 1, global: { daily: { unit: "usd", amount: 15 }, weekly: { unit: "tokens", amount: 5e6 }, mode: "hard" }, projects: [{ dir: ALPHA, daily: { unit: "usd", amount: 5 } }] }));
    const s = doStatus(box).text;
    assert.match(s, /hook +UserPromptSubmit runs .*cost-guard\/app\/guard\.mjs/);
    assert.match(s, /budget +all projects +daily \$15, weekly 5M tokens \(hard\)/);
    assert.match(s, /budget +alpha +daily \$5 \(soft\)/);
    assert.match(s, /index +\d+ requests from \d+ transcripts, updated just now/);
    assert.match(s, /today +\$[\d.]+ · [\d.]+[kM]? fresh tokens/);
    fs.mkdirSync(box.guard, { recursive: true });
    fs.writeFileSync(path.join(box.guard, "errors.log"), "2026-10-07T10:00:00.000Z one\n2026-10-07T10:01:00.000Z two\n");
    assert.match(doStatus(box).text, /errors +2 lines in .*errors\.log/);
    fs.writeFileSync(settingsPath(box), "{bad");
    assert.match(doStatus(box).text, /hook +settings\.json is not valid JSON, so I cannot tell/);
    fs.writeFileSync(path.join(box.guard, "budgets.json"), "{bad");
    assert.match(doStatus(box).text, /budgets +budgets\.json is not valid JSON: no budget is in force until it is fixed/);
  } finally { box.cleanup(); }
});

test("mergeHook and removeHook do not change what they are given", () => {
  const box = sandbox();
  try {
    const seed = JSON.parse(JSON.stringify(ORIGINAL));
    const frozen = JSON.stringify(seed);
    const merged = mergeHook(seed, entry(box));
    assert.equal(JSON.stringify(seed), frozen);
    assert.equal(merged.changed, true);
    assert.equal(mergeHook(merged.settings, entry(box)).changed, false, "merging twice is a no-op");
    const mergedFrozen = JSON.stringify(merged.settings);
    const removed = removeHook(merged.settings);
    assert.equal(JSON.stringify(merged.settings), mergedFrozen);
    assert.equal(removed.removed, 1);
    assert.equal(JSON.stringify(removed.settings), frozen);
    assert.equal(removeHook(seed).removed, 0);
    assert.deepEqual(mergeHook({}, entry(box)).settings, { hooks: { UserPromptSubmit: [{ hooks: [entry(box)] }] } });
  } finally { box.cleanup(); }
});

test("through the command line: init, then the installed hook, then uninstall", () => {
  const box = sandbox();
  try {
    buildFixture(box);
    let r = runCli(box, ["init"]);
    assert.equal(r.status, 0, r.out);
    r = runCli(box, ["budget", "set", "--daily", "9usd", "--hard"]);
    assert.equal(r.status, 0, r.out);
    // the settings.json entry, run the way Claude Code runs it: command + args, JSON on stdin
    const e = readJson(settingsPath(box)).hooks.UserPromptSubmit[0].hooks[0];
    assert.equal(e.command, "node");
    const hook = runGuard(box, { hook_event_name: "UserPromptSubmit", cwd: ALPHA, prompt: "hi", source: "user" }, { script: e.args[0] });
    assert.equal(hook.status, 0);
    assert.deepEqual(JSON.parse(hook.stdout), { decision: "block", reason: "Cost guard: today's budget of $9 is used ($9.52). Raise it with: claude-cost-guard budget extend 2usd, or set CLAUDE_COST_GUARD_OFF=1." });
    assert.equal(hook.stderr, "");
    // the installed copy is a working command line too
    const installedCli = path.join(box.cfg, "cost-guard", "app", "bin", "claude-cost-guard.mjs");
    assert.match(runCli(box, ["budget", "show"], { script: installedCli }).stdout, /all projects +today \$9\.52 of \$9 \(106%\) +\[hard\]/);
    const again = runCli(box, ["init"], { script: installedCli });
    assert.equal(again.status, 0, again.out);
    assert.match(again.stdout, /running from the installed copy; not copying files onto themselves/);
    r = runCli(box, ["uninstall"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(fs.existsSync(path.join(box.cfg, "cost-guard", "app")), false, "the copy is gone");
    assert.deepEqual(readJson(settingsPath(box)), {}, "and so is the hook entry");
  } finally { box.cleanup(); }
});
