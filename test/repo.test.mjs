// The repository itself: package, plugin, marketplace, CI, README, and the house rules of the family
// (zero dependencies, Node 18 and up, nothing for the model to read, no emojis).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, readJson } from "./helpers.mjs";

const file = (...p) => path.join(ROOT, ...p);
const text = (...p) => fs.readFileSync(file(...p), "utf8");
const pkg = readJson(file("package.json"));
const sources = [file("guard.mjs"), ...["bin", "src"].flatMap((d) => fs.readdirSync(file(d)).filter((f) => f.endsWith(".mjs")).map((f) => file(d, f)))];

test("package.json carries what the family's packages carry", () => {
  assert.equal(pkg.name, "claude-cost-guard");
  assert.equal(pkg.version, "1.0.0");
  assert.equal(pkg.type, "module");
  assert.match(pkg.description, /budget/i);
  assert.deepEqual(pkg.bin, { "claude-cost-guard": "bin/claude-cost-guard.mjs" });
  assert.deepEqual(pkg.engines, { node: ">=18" });
  assert.deepEqual(pkg.scripts, { test: "node --test" }, "npm test takes no arguments");
  assert.equal(pkg.repository, "github:nrzz/claude-cost-guard");
  assert.equal(pkg.homepage, "https://github.com/nrzz/claude-cost-guard#readme");
  assert.equal(pkg.bugs, "https://github.com/nrzz/claude-cost-guard/issues");
  assert.equal(pkg.author, "Naresh Prabu");
  assert.equal(pkg.license, "MIT");
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.includes("claude-code"));
  assert.equal(pkg.dependencies, undefined, "zero dependencies");
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.optionalDependencies, undefined);
  for (const entry of pkg.files) assert.ok(fs.existsSync(file(entry)), `files: ${entry} exists`);
  for (const needed of ["guard.mjs", "bin", "src", "hooks", ".claude-plugin", "README.md", "LICENSE"]) assert.ok(pkg.files.includes(needed), `files includes ${needed}`);
  assert.ok(fs.existsSync(file(pkg.bin["claude-cost-guard"])));
  assert.match(text("bin", "claude-cost-guard.mjs"), /^#!\/usr\/bin\/env node\n/, "a shebang, so the bin works");
  assert.match(text("guard.mjs"), /^#!\/usr\/bin\/env node\n/);
});

test("the plugin manifest, the marketplace and the hook are the ones the plugin system expects", () => {
  const plugin = readJson(file(".claude-plugin", "plugin.json"));
  assert.equal(plugin.name, "cost-guard");
  assert.equal(plugin.version, pkg.version, "one version");
  assert.deepEqual(plugin.author, { name: "Naresh Prabu" });
  assert.equal(plugin.license, "MIT");
  assert.equal(plugin.homepage, "https://github.com/nrzz/claude-cost-guard");
  assert.ok(plugin.description.length > 20);

  const market = readJson(file(".claude-plugin", "marketplace.json"));
  assert.equal(market.$schema, "https://anthropic.com/claude-code/marketplace.schema.json");
  assert.equal(market.name, "claude-cost-guard");
  assert.deepEqual(market.owner, { name: "Naresh Prabu" });
  assert.equal(market.plugins.length, 1);
  const [entry] = market.plugins;
  assert.equal(entry.name, "cost-guard");
  assert.deepEqual(entry.author, { name: "Naresh Prabu" });
  assert.equal(entry.category, "productivity");
  assert.equal(entry.source, "./");
  assert.equal(entry.homepage, "https://github.com/nrzz/claude-cost-guard");
  assert.ok(entry.description && market.description);

  assert.deepEqual(readJson(file("hooks", "hooks.json")), {
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/guard.mjs", "prompt"], timeout: 10 }] }] },
  });
  assert.ok(fs.existsSync(file("guard.mjs")), "the script the hook runs is at the plugin root");
});

test("nothing is put in front of the model: no skills, no commands, no agents, no MCP servers, one hook", () => {
  for (const dir of ["skills", "commands", "agents", "output-styles"]) assert.equal(fs.existsSync(file(dir)), false, dir);
  assert.equal(fs.existsSync(file(".mcp.json")), false);
  assert.equal(fs.existsSync(file("CLAUDE.md")), false);
  const hooks = readJson(file("hooks", "hooks.json")).hooks;
  assert.deepEqual(Object.keys(hooks), ["UserPromptSubmit"], "no other event: no SessionStart context, no tool hooks");
  // and if a skill is ever added, it must be user-only with a short description
  const dir = file("skills");
  if (fs.existsSync(dir)) {
    for (const s of fs.readdirSync(dir)) {
      const md = fs.readFileSync(path.join(dir, s, "SKILL.md"), "utf8");
      assert.match(md, /^disable-model-invocation: true$/m, s);
      assert.ok(/^description: (.*)$/m.exec(md)[1].length < 60, `${s}: description under 60 characters`);
    }
  }
  // the hook's output goes to stdout only through one write of the line the hook module returned
  const guard = text("guard.mjs");
  assert.equal((guard.match(/process\.stdout\.write/g) || []).length, 1);
  assert.equal((guard.match(/console\.log/g) || []).length, 1, "and the one console.log is the version, for a person");
});

test("zero dependencies: only Node's own modules and our own files are imported", () => {
  for (const f of sources) {
    const code = fs.readFileSync(f, "utf8");
    for (const m of code.matchAll(/(?:^|\n)\s*import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = m[1] || m[2];
      assert.ok(spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../"), `${path.relative(ROOT, f)} imports ${spec}`);
    }
    assert.doesNotMatch(code, /\brequire\(/, path.relative(ROOT, f));
  }
});

test("the code stays within Node 18: no newer APIs", () => {
  const newer = [
    /\.toSorted\(/, /\.toReversed\(/, /\.toSpliced\(/, /\bObject\.groupBy\b/, /\bMap\.groupBy\b/, /import\.meta\.dirname/, /import\.meta\.filename/,
    /\bPromise\.withResolvers\b/, /\bArray\.fromAsync\b/, /\.isWellFormed\(/, /\bfs\.globSync\b/, /\bglobSync\(/, /recursive:\s*true\s*}\s*\)\s*\.\s*(?:map|filter)/,
    /\bprocess\.getBuiltinModule\b/, /\bnode:sqlite\b/, /\bnode:sea\b/, /\.union\(/, /\.intersection\(/, /\bwithResolvers\b/, /\bURL\.canParse\b/, /\bstyleText\b/, /\bparseEnv\b/,
  ];
  for (const f of sources) {
    const code = fs.readFileSync(f, "utf8");
    for (const re of newer) assert.doesNotMatch(code, re, `${path.relative(ROOT, f)} uses ${re}`);
  }
});

test("LICENSE is the family's MIT text", () => {
  const license = text("LICENSE");
  assert.match(license, /^MIT License\n\nCopyright \(c\) 2026 Naresh Prabu\n/);
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
});

test("repository files: .gitignore, .gitattributes and the CI workflow", () => {
  assert.equal(text(".gitattributes"), "* text=auto eol=lf\n");
  assert.equal(text(".gitignore"), "node_modules/\n*.log\n.DS_Store\n");
  const ci = text(".github", "workflows", "test.yml");
  assert.match(ci, /^name: test$/m);
  assert.match(ci, /os: \[ubuntu-latest, windows-latest, macos-latest\]/);
  assert.match(ci, /node: \[20, 22, 24\]/);
  assert.match(ci, /- run: npm test/);
  assert.match(ci, /actions\/checkout@v4/);
  assert.match(ci, /actions\/setup-node@v4/);
});

test("the README has the family's sections in the family's order", () => {
  const readme = text("README.md");
  const headings = readme.split("\n").filter((l) => /^#{1,2} /.test(l));
  assert.deepEqual(headings, [
    "# Claude Code cost guard", "## What it costs in tokens", "## Install", "## Use", "## Budgets", "## How it counts", "## How it works",
    "## What was verified, and how", "## Files", "## Contributing", "## Part of the Claude Code toolkit", "## License",
  ]);
  assert.match(readme.split("\n")[2], /^\[!\[test\]\(https:\/\/github\.com\/nrzz\/claude-cost-guard\/actions\/workflows\/test\.yml\/badge\.svg\)\]\(https:\/\/github\.com\/nrzz\/claude-cost-guard\/actions\/workflows\/test\.yml\)( \S.*)?$/, "the CI badge leads the badge line, right under the title");
  // a two-sentence intro
  const intro = readme.split("\n")[4];
  assert.equal(intro.split(/(?<=[.!?])\s+(?=[A-Z])/).length, 2, intro);
  // the token table says 0
  const tokens = readme.slice(readme.indexOf("## What it costs in tokens"), readme.indexOf("## Install"));
  const rows = tokens.split("\n").filter((l) => /^\| /.test(l) && !/^\| ---/.test(l) && !/^\| Part/.test(l));
  assert.ok(rows.length >= 4);
  for (const row of rows) assert.match(row, /\| 0 \|/, row);
  for (const needle of ["npx -y github:nrzz/claude-cost-guard init", "/plugin marketplace add nrzz/claude-cost-guard", "/plugin install cost-guard@claude-cost-guard"]) assert.ok(readme.includes(needle), needle);
  assert.doesNotMatch(readme, /\{\{|\}\}|TODO|FIXME/, "no placeholder left");
  assert.doesNotMatch(readme, /\p{Extended_Pictographic}/u, "no emojis");
  assert.ok(readme.trimEnd().endsWith("MIT"));
});

test("the README's claims are the code's: the test count, the defaults, the commands", () => {
  const readme = text("README.md");
  // every `test(` in the suite is one test
  const count = fs.readdirSync(file("test")).filter((f) => f.endsWith(".test.mjs")).reduce((n, f) => n + (text("test", f).match(/^test\(/gm) || []).length, 0);
  const claimed = Number(/\*\*(\d+) automated tests\*\*/.exec(readme)[1]);
  assert.equal(claimed, count, `README says ${claimed} automated tests, the suite has ${count}`);
  // commands and options mentioned are real
  const help = text("src", "cli.mjs");
  for (const word of ["report", "today", "statusline", "budget", "init", "uninstall", "status", "--days", "--by", "--json", "--project", "--all", "--mode", "--purge", "--scope"]) assert.ok(help.includes(word), word);
  assert.match(readme, /250 ms/);
  assert.match(text("src", "hook.mjs"), /DEFAULT_BUDGET_MS = 250/);
  assert.match(readme, /35 days/);
  assert.match(text("src", "index.mjs"), /RETAIN_DAYS = 35/);
  assert.match(readme, /20 days/);
  assert.match(text("src", "index.mjs"), /ORPHAN_KEEP_DAYS = 20/);
  assert.match(readme, /kept under 64 KB/);
  assert.match(text("src", "util.mjs"), /64 \* 1024/);
  for (const env of ["CLAUDE_CONFIG_DIR", "CLAUDE_COST_GUARD_OFF", "CLAUDE_COST_GUARD_BUDGET_MS"]) {
    assert.ok(readme.includes(env), env);
    assert.ok(sources.some((f) => fs.readFileSync(f, "utf8").includes(env)), `${env} is used by the code`);
  }
});

test("the price table is dated and explains what the dollars mean", () => {
  const prices = text("src", "prices.mjs");
  assert.match(prices, /API list prices on 2026-10-01; subscription plans are not billed per token, so on a plan the dollars\s*\/\/ are a yardstick for how fast limits fill/);
});

test("the test process itself is fenced off from the real Claude config", () => {
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  assert.ok(path.resolve(cfg).startsWith(fs.realpathSync(os.tmpdir())), cfg);
  assert.equal(fs.statSync(cfg).isFile(), true, "a file, so using it as a folder fails");
  assert.ok(process.env.HOME.startsWith(fs.realpathSync(os.tmpdir())));
  assert.ok(process.env.USERPROFILE.startsWith(fs.realpathSync(os.tmpdir())));
});

test("no invisible, byte-order-mark or bidirectional control characters hide in the repository's text files", () => {
  const bad = (cp) => cp === 0xfeff || cp === 0xfffe || cp === 0xffff || cp === 0x7f || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x2028 && cp <= 0x202e)
    || (cp >= 0x2060 && cp <= 0x2064) || (cp >= 0x2066 && cp <= 0x2069) || (cp < 32 && cp !== 9 && cp !== 10 && cp !== 13);
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|cjs|js|json|md|yml|txt)$/.test(e.name) || ["LICENSE", ".gitignore", ".gitattributes"].includes(e.name)) {
        const lines = fs.readFileSync(p, "utf8").split("\n");
        lines.forEach((line, i) => { for (const ch of line) if (bad(ch.codePointAt(0))) found.push(`${path.relative(ROOT, p)}:${i + 1} U+${ch.codePointAt(0).toString(16).toUpperCase()}`); });
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(found, []);
});
