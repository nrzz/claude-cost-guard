#!/usr/bin/env node
// claude-cost-guard hook. Claude Code runs `node guard.mjs prompt` before every prompt (UserPromptSubmit) and
// pipes one JSON object to stdin. This prints nothing unless a budget needs a word, and then only
//   {"systemMessage": "..."}              a line for the person: costs no tokens, the model never sees it
//   {"decision":"block","reason":"..."}   hard mode over budget: the prompt is not sent
// It never fails a session: whatever goes wrong, it exits 0 with no output, and notes the problem in
// <configDir>/cost-guard/errors.log. The work is in src/hook.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isatty } from "node:tty";

// Read stdin without touching process.stdin (that would switch a pipe to non-blocking mode).
function readStdin() {
  if (isatty(0)) return "";
  const chunks = [];
  const buf = Buffer.alloc(65536);
  const deadline = Date.now() + 3000;
  for (;;) {
    let n;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if (e && e.code === "EAGAIN" && Date.now() < deadline) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); continue; }
      break; // end of input, closed stdin, anything else: use what there is
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// If even loading src/ fails (a broken copy), the failure is still noted without src/'s help.
function noteFailure(e) {
  try {
    const custom = process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.trim();
    const dir = path.join(path.resolve(custom || path.join(os.homedir(), ".claude")), "cost-guard");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "errors.log");
    if (fs.existsSync(file) && fs.statSync(file).size > 64 * 1024) fs.writeFileSync(file, "");
    fs.appendFileSync(file, `${new Date().toISOString()} ${String((e && e.stack) || e).replace(/\s+/g, " ").slice(0, 600)}\n`);
  } catch { /* nothing more can be done */ }
}

process.stdout.on("error", () => {}); // a closed pipe is not worth a stack trace
try {
  const [command] = process.argv.slice(2);
  if (command === "version" || command === "--version") {
    console.log((await import("./src/util.mjs")).VERSION); // for a person checking an install; Claude Code never passes this
  } else if (command === "prompt") {
    const { runHook } = await import("./src/hook.mjs");
    const { output } = await runHook({ env: process.env, stdin: readStdin() });
    if (output) process.stdout.write(output);
  }
} catch (e) {
  noteFailure(e);
}
process.exitCode = 0;
