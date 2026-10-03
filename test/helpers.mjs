// Shared test helpers: a throwaway Claude config folder and a generator of synthetic transcripts.
// Every test runs against folders under the OS temp directory, reached through CLAUDE_CONFIG_DIR (and a
// throwaway HOME). Nothing here reads or writes the real ~/.claude, and no real transcript is ever used.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const GUARD = path.join(ROOT, "guard.mjs");
export const FAKE_TIME = path.join(ROOT, "test", "fake-time.cjs");
export const CLI = path.join(ROOT, "bin", "claude-cost-guard.mjs");
const TMP = fs.realpathSync(os.tmpdir());

// Safety net: a test that forgets to pass its sandbox must still never reach the real ~/.claude. This process's
// own CLAUDE_CONFIG_DIR is a *file* in a temp folder, so anything that tries to use it as a folder fails loudly,
// and HOME and USERPROFILE point at that temp folder as well.
const SAFE = fs.realpathSync(fs.mkdtempSync(path.join(TMP, "cg-safe-")));
fs.writeFileSync(path.join(SAFE, "config-that-must-stay-empty"), "a file on purpose: a test that writes here forgot its sandbox\n");
process.env.CLAUDE_CONFIG_DIR = path.join(SAFE, "config-that-must-stay-empty");
process.env.HOME = SAFE;
process.env.USERPROFILE = SAFE;
process.on("exit", () => { try { fs.rmSync(SAFE, { recursive: true, force: true }); } catch { /* temp folder: the OS cleans up */ } });

/** Wednesday 7 October 2026, noon local time: the "now" of the in-process tests. */
export const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime();
/** An ISO timestamp for local time on the day `dayOffset` days from 7 October 2026. */
export const at = (dayOffset, h = 12, m = 0, s = 0) => new Date(2026, 9, 7 + dayOffset, h, m, s).toISOString();

/** A throwaway world: a config folder, a home folder, and an environment that points at them. */
export function sandbox({ now = NOW, cfgName = "c" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(TMP, "cg-")));
  const cfg = path.join(root, cfgName);
  const home = path.join(root, "h");
  fs.mkdirSync(cfg);
  fs.mkdirSync(home);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg, HOME: home, USERPROFILE: home, NO_COLOR: "1" };
  for (const k of ["CLAUDE_COST_GUARD_OFF", "CLAUDE_COST_GUARD_BUDGET_MS", "FORCE_COLOR", "CLAUDE_CODE_SESSION_ID"]) delete env[k];
  const box = {
    root, cfg, home, env, now, tick: 0,
    projects: path.join(cfg, "projects"),
    guard: path.join(cfg, "cost-guard"),
    path: (...p) => path.join(cfg, ...p),
    cleanup() { fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }); },
  };
  box.session = (opts) => new Session(box, opts);
  return box;
}

/** Claude Code's folder name for a working directory: every non-alphanumeric character becomes "-". */
export function slugOf(cwd) {
  const s = String(cwd).replace(/[^a-zA-Z0-9]/g, "-");
  if (s.length <= 200) return s;
  let h = 0;
  for (let i = 0; i < cwd.length; i++) h = ((h << 5) - h + cwd.charCodeAt(i)) | 0;
  return `${s.slice(0, 200)}-${Math.abs(h).toString(36)}`;
}

let counter = 0;
const next = () => String(++counter).padStart(6, "0");
export const uid = (n) => `${String(n).padStart(8, "0")}-aaaa-4aaa-8aaa-000000000000`;

/** The usage object of a request. cw5 and cw1 are cache writes by lifetime; `noSplit` leaves out the split. */
export function usage({ i = 0, o = 0, cr = 0, cw5 = 0, cw1 = 0, think, iterations, noSplit = false } = {}) {
  const u = { input_tokens: i, cache_creation_input_tokens: cw5 + cw1, cache_read_input_tokens: cr, output_tokens: o };
  if (!noSplit) u.cache_creation = { ephemeral_5m_input_tokens: cw5, ephemeral_1h_input_tokens: cw1 };
  if (think !== undefined) u.output_tokens_details = { thinking_tokens: think };
  if (iterations) u.iterations = iterations;
  u.service_tier = "standard";
  return u;
}

const BLOCKS = [
  { type: "thinking", thinking: "reasoning that never leaves the transcript", signature: "SIG" },
  { type: "text", text: "an answer that must never be printed by this tool" },
  { type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "/secret/path.txt" } },
];

/** One transcript record per content block of a request: they all repeat the requestId, message id and usage. */
export function assistantRecords({ requestId, messageId, ts, model = "claude-opus-5-5", sid, cwd, u, agent = false, blocks = 1, partial = false, extra = {} }) {
  const out = [];
  for (let b = 0; b < blocks; b++) {
    const last = b === blocks - 1;
    // A streamed request's early records can carry the usage as it stood then: output not final yet.
    const use = partial && !last ? { ...u, output_tokens: Math.min(u.output_tokens || 0, b + 1) } : u;
    out.push({
      parentUuid: null, isSidechain: agent, userType: "external", cwd, sessionId: sid, version: "2.1.286",
      type: "assistant", requestId, uuid: `${requestId}-u${b}`, timestamp: ts,
      message: { id: messageId || `msg_${requestId.slice(4)}`, type: "message", role: "assistant", model, content: [BLOCKS[b % BLOCKS.length]], stop_reason: last ? "end_turn" : null, stop_sequence: null, usage: use },
      ...extra,
    });
  }
  return out;
}

/** A transcript file being written: a main session, or (with `agent`) a subagent of that session. */
export class Session {
  constructor(box, { cwd = "D:\\work\\alpha", sid = uid(1), agent = null, slug } = {}) {
    this.box = box;
    this.cwd = cwd;
    this.sid = sid;
    this.agent = agent;
    const dir = path.join(box.projects, slug || slugOf(cwd));
    this.file = agent ? path.join(dir, sid, "subagents", `agent-${agent}.jsonl`) : path.join(dir, `${sid}.jsonl`);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
  }
  /** Append records as JSON lines (the last line ends with a newline unless eol is false). */
  write(records, { eol = true } = {}) {
    const text = records.map((r) => JSON.stringify(r)).join("\n") + (eol ? "\n" : "");
    fs.appendFileSync(this.file, text);
    return this.stamp();
  }
  /** Set the file's modification time to the sandbox's simulated clock (generated files must look as if written "now"). */
  stamp() {
    const t = new Date(this.box.now + ++this.box.tick * 1000);
    fs.utimesSync(this.file, t, t);
    return this;
  }
  /** Append one request. Returns its requestId. */
  req({ ts, model, u, blocks = 1, partial = false, requestId, messageId, eol = true, extra }) {
    const rid = requestId || `req_${next()}`;
    this.write(assistantRecords({ requestId: rid, messageId, ts, model, sid: this.sid, cwd: this.cwd, u, agent: !!this.agent, blocks, partial, extra }), { eol });
    return rid;
  }
  title(custom, ai) {
    const recs = [];
    if (ai !== undefined) recs.push({ type: "ai-title", sessionId: this.sid, aiTitle: ai });
    if (custom !== undefined) recs.push({ type: "custom-title", customTitle: custom, sessionId: this.sid });
    return this.write(recs);
  }
  /** Records that carry no usage, as Claude Code writes them between the assistant records. */
  noise(ts = at(0)) {
    return this.write([
      { type: "user", sessionId: this.sid, cwd: this.cwd, timestamp: ts, message: { role: "user", content: "a prompt that must never be printed by this tool" } },
      { type: "user", sessionId: this.sid, timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: 'tool output that mentions "usage" and assistant but is not a request' }] } },
      { type: "attachment", sessionId: this.sid, timestamp: ts, attachment: { type: "hook_additional_context", content: ["x"] } },
      { type: "system", subtype: "informational", sessionId: this.sid, timestamp: ts, content: "x" },
      { type: "queue-operation", operation: "enqueue", timestamp: ts, sessionId: this.sid },
      { type: "file-history-snapshot", messageId: "m", snapshot: {}, isSnapshotUpdate: false },
      { type: "last-prompt", lastPrompt: "x", sessionId: this.sid },
    ]);
  }
}

/**
 * The reference data set, with its numbers worked out by hand (see `expected`).
 * Prices per MTok [input, output, cache read, cache write 5m, cache write 1h]:
 *   opus-5-5 [4, 20, 0.2, 5, 8]  sonnet-5-5 [2, 10, 0.2, 2.5, 4]  haiku-4-5 [1, 5, 0.1, 1.25, 2]
 *   fable-5-1 [10, 50, 0.25, 12.5, 20]  opus-4-6 [5, 25, 0.5, 6.25, 10]
 *
 *   R1 S1 Wed 10:00  opus-5-5    in 100k  out 50k (think 20k)  read 1M    write 200k+100k  (3 records, streamed)  $3.40  fresh 450k
 *   R2 S1 Wed 11:00  sonnet-5-5  in 500k  out 100k             read 2M                                     $2.40  fresh 600k
 *   R7 S1 Wed 10:30  sonnet-5-5  in 50k   out 10k              read 100k   (a subagent file)                $0.22  fresh 60k
 *   R3 S2 Wed 12:00  haiku-4-5   in 1M    out 200k             read 10M    write 400k      (2 records)     $3.50  fresh 1.6M
 *   R4 S1 Tue 09:00  opus-5-5                out 10k           read 500k   write 50k (1h)                  $0.70  fresh 60k
 *   R6 S3 Mon 00:00  opus-4-6    in 20k   out 2k                                                           $0.15  fresh 22k
 *   R5 S3 Sun 23:59:59 fable-5-1 in 10k   out 4k               read 100k   write 8k+2k                     $0.465 fresh 24k
 * S1 and S3 work in D:\work\alpha, S2 in /home/dev/beta. Wednesday is the 7th (NOW); Sunday the 4th is the week before.
 * A <synthetic> record, an assistant record without usage and every other record type are in there too.
 */
export const S1 = uid(1);
export const S2 = uid(2);
export const S3 = uid(3);
export const ALPHA = "D:\\work\\alpha";
export const BETA = "/home/dev/beta";

export function buildFixture(box) {
  const s1 = box.session({ cwd: ALPHA, sid: S1 });
  const s1agent = box.session({ cwd: ALPHA, sid: S1, agent: "a1" });
  const s2 = box.session({ cwd: BETA, sid: S2 });
  const s3 = box.session({ cwd: ALPHA, sid: S3 });
  s1.noise(at(0, 9));
  s1.title("Fix login redirect loop", "Login bug");
  s2.title(undefined, "Refactor billing");
  s1.req({ ts: at(0, 9, 0), model: "<synthetic>", u: usage({ i: 9e9, o: 9e9 }) });
  s1.write([{ type: "assistant", sessionId: S1, requestId: "req_nousage", timestamp: at(0, 9), message: { id: "msg_nu", model: "claude-opus-5-5", content: [{ type: "text", text: "x" }] } }]);
  s1.req({ ts: at(0, 10, 0), model: "claude-opus-5-5", u: usage({ i: 100000, o: 50000, think: 20000, cr: 1000000, cw5: 200000, cw1: 100000 }), blocks: 3, partial: true, requestId: "req_R1" });
  s1.req({ ts: at(0, 11, 0), model: "claude-sonnet-5-5", u: usage({ i: 500000, o: 100000, cr: 2000000 }), requestId: "req_R2" });
  s1agent.req({ ts: at(0, 10, 30), model: "claude-sonnet-5-5", u: usage({ i: 50000, o: 10000, cr: 100000 }), requestId: "req_R7" });
  s2.req({ ts: at(0, 12, 0), model: "claude-haiku-4-5-20251001", u: usage({ i: 1000000, o: 200000, cr: 10000000, cw5: 400000 }), blocks: 2, requestId: "req_R3" });
  s1.req({ ts: at(-1, 9, 0), model: "claude-opus-5-5", u: usage({ o: 10000, cr: 500000, cw1: 50000 }), requestId: "req_R4" });
  s3.req({ ts: at(-2, 0, 0, 0), model: "claude-opus-4-6", u: usage({ i: 20000, o: 2000 }), requestId: "req_R6" });
  s3.req({ ts: at(-3, 23, 59, 59), model: "claude-fable-5-1", u: usage({ i: 10000, o: 4000, cr: 100000, cw5: 8000, cw1: 2000 }), requestId: "req_R5" });
  return { s1, s1agent, s2, s3 };
}

export const expected = {
  requests: 7,
  total: { n: 7, i: 1680000, o: 376000, w5: 608000, w1: 152000, cw: 760000, r: 13700000, th: 20000, fresh: 2816000, cost: 10.835, agentCost: 0.22, agentFresh: 60000 },
  today: { n: 4, i: 1650000, o: 360000, w5: 600000, w1: 100000, r: 13100000, fresh: 2710000, cost: 9.52 },
  week: { n: 6, fresh: 2792000, cost: 10.37 },
  byDay: { "2026-10-04": 0.465, "2026-10-05": 0.15, "2026-10-06": 0.7, "2026-10-07": 9.52 },
  byModel: { "claude-opus-5-5": 4.1, "claude-sonnet-5-5": 2.62, "claude-haiku-4-5-20251001": 3.5, "claude-fable-5-1": 0.465, "claude-opus-4-6": 0.15 },
  bySession: { [S1]: 6.72, [S2]: 3.5, [S3]: 0.615 },
  byProject: { [ALPHA]: 7.335, [BETA]: 3.5 },
  byWeek: { "2026-W41": 10.37, "2026-W40": 0.465 },
};

/** Equal within rounding error of a sum of dollar amounts. */
export const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ---------------------------------------------------------------------------------------------
// Running the tool as Claude Code (or a person) would
// ---------------------------------------------------------------------------------------------

function childEnv(box, extra = {}) {
  const env = { ...box.env, ...extra };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  if (!env.CLAUDE_CONFIG_DIR || !path.resolve(env.CLAUDE_CONFIG_DIR).startsWith(TMP)) throw new Error("refusing to run outside a temp config folder");
  return env;
}
/**
 * Run a script as a child process in the sandbox. The child's clock is the sandbox's simulated one
 * (box.now) unless `real` is set, which runs it exactly as Claude Code would, on the real clock.
 */
export function run(box, script, args, { input, env, cwd, timeout = 120000, real = false } = {}) {
  const t0 = performance.now();
  const clock = real ? [] : ["-r", FAKE_TIME];
  const fake = real ? {} : { FAKE_NOW: new Date(box.now).toISOString() };
  const r = spawnSync(process.execPath, [...clock, script, ...args], { env: childEnv(box, { ...fake, ...env }), input, cwd, encoding: "utf8", timeout, windowsHide: true });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", out: (r.stdout || "") + (r.stderr || ""), ms: performance.now() - t0 };
}
/** The hook, with the JSON Claude Code would send on stdin. */
export const runGuard = (box, input, opts = {}) => run(box, opts.script || GUARD, ["prompt"], { ...opts, input: typeof input === "string" ? input : JSON.stringify(input) });
export const runCli = (box, args, opts = {}) => run(box, opts.script || CLI, args, opts);

export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
export const ls = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return []; } };
/** A date-time `days` days before `ms`, as an mtime. */
export const ageFile = (file, ms, days) => { const t = new Date(ms - days * 864e5); fs.utimesSync(file, t, t); };
