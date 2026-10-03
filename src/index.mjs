// The index: an incremental scan of every transcript under <configDir>/projects (main and subagent files)
// into <configDir>/cost-guard/index.json.
//
//   files     per transcript: {id, size, mtimeMs, offset, partial, headLen, head}. `offset` is how far the
//             complete lines have been read; `partial` marks an unfinished last line. A later run reads only
//             the bytes after `offset`. A file that shrank, or whose first bytes changed, is read again from 0.
//   requests  per request, keyed by requestId (else message.id): one request is counted once however many
//             records repeat it, and its numbers only grow (a streamed request's last record is the final one).
//             Each remembers which transcripts hold it, so a deleted or rewritten transcript takes its
//             requests with it, and the index matches a fresh scan of what is on disk.
//             Requests older than RETAIN_DAYS are summed into `folded` daily totals and dropped.
//   sessions  id, folder (cwd of its first main-thread record), titles.
//
// Reading is bounded by a time budget (the hook uses 250 ms): a run reads what it can, newest files first,
// remembers where it stopped and continues next time.
import fs from "node:fs";
import path from "node:path";
import { fnv1a, usageTokens } from "./parse.mjs";
import {
  addDays, clean, cleanTmp, dayKeyOf, indexFile, lockFile, logError, projectsDir as projectsDirOf, releaseLock,
  startOfDayMs, takeLock, touchLock, writeJsonAtomic,
} from "./util.mjs";

export const SCHEMA = 1;
export const RETAIN_DAYS = 35; // individual requests are kept this many days (today and 34 before)
export const KEEP_FOLDED_DAYS = 730; // daily totals older than this are forgotten
export const ORPHAN_KEEP_DAYS = 20; // see dropFiles
export const HOT_MS = 48 * 3600 * 1000; // a file touched this recently is checked on every run
export const STAT_BUDGET = 400; // files looked at per quick run; the idle ones are checked in rotation
export const COLD_MIN = 50; // idle files looked at per quick run however many files are active
export const CHUNK = 1 << 20; // bytes read at a time
const MAX_LINE = 256 << 20;
const HEAD = 256; // bytes of a file's start that are fingerprinted
const MAX_DEPTH = 6;
const SKIP_DIRS = new Set(["tool-results", "node_modules", ".git"]);
const EXPECTED_IO = new Set(["ENOENT", "EBUSY", "EPERM", "EACCES", "EMFILE", "ENFILE", "EIO", "EAGAIN"]);

/** A request is stored as an array: [ts, session, model, input, output, cacheWrite5m, cacheWrite1h, cacheRead, thinking, agent, owners]. */
export const F = { TS: 0, S: 1, M: 2, I: 3, O: 4, W5: 5, W1: 6, R: 7, TH: 8, A: 9, OW: 10 };

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function newIndex() {
  return { v: SCHEMA, files: {}, requests: {}, sessions: [], models: [], folded: {}, dirs: {}, cursor: 0, nextFileId: 1, rolledOn: "", updatedAt: 0 };
}

// Lookups and flags that live only in memory: not enumerable, so they are never written to disk.
function hydrate(idx) {
  const hidden = (k, v) => Object.defineProperty(idx, k, { value: v, enumerable: false, writable: true, configurable: true });
  hidden("_sess", new Map(idx.sessions.map((s, i) => [s.id, i])));
  hidden("_models", new Map(idx.models.map((m, i) => [m, i])));
  hidden("dirty", false);
  return idx;
}

export function loadIndex(cfg) {
  let text;
  try { text = fs.readFileSync(indexFile(cfg), "utf8"); } catch { return hydrate(newIndex()); }
  try {
    const o = JSON.parse(text);
    if (o && o.v === SCHEMA && o.files && o.requests && o.folded && o.dirs && Array.isArray(o.sessions) && Array.isArray(o.models)) return hydrate(o);
  } catch { /* falls through */ }
  logError(cfg, "index.json could not be read and is being rebuilt from the transcripts");
  return hydrate(newIndex());
}

export function saveIndex(cfg, idx) {
  idx.updatedAt = Date.now();
  writeJsonAtomic(indexFile(cfg), idx);
  cleanTmp(path.dirname(indexFile(cfg)));
  idx.dirty = false;
}

// ---------------------------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------------------------

/** Seconds since the epoch of local midnight at the start of the oldest day whose requests are kept. */
export const cutoffSec = (nowMs) => Math.floor(startOfDayMs(addDays(dayKeyOf(nowMs), -(RETAIN_DAYS - 1))) / 1000);

/**
 * seconds -> local "YYYY-MM-DD", cached per quarter hour. Every time zone offset is a whole number of
 * quarter hours, so a quarter hour never spans local midnight. Create one per run: a cache must not
 * outlive a change of time zone.
 */
export function makeDayOf() {
  const cache = new Map();
  return (sec) => {
    const bucket = Math.floor(sec / 900);
    let day = cache.get(bucket);
    if (day === undefined) { day = dayKeyOf(sec * 1000); cache.set(bucket, day); }
    return day;
  };
}

// ---------------------------------------------------------------------------------------------
// Sessions, models and requests
// ---------------------------------------------------------------------------------------------

// `seenSec` dates a new session: the time of its first usage record, or the time it was read when a title came first.
function sessionIx(idx, sid, seenSec) {
  let i = idx._sess.get(sid);
  if (i === undefined) {
    i = idx.sessions.push({ id: sid, cwd: "", seen: seenSec }) - 1;
    idx._sess.set(sid, i);
    idx.dirty = true;
  }
  return i;
}
function modelIx(idx, name) {
  let i = idx._models.get(name);
  if (i === undefined) { i = idx.models.push(name) - 1; idx._models.set(name, i); idx.dirty = true; }
  return i;
}

function addOwner(r, id) {
  const ow = r[F.OW];
  if (ow === id) return false;
  if (typeof ow === "number") { r[F.OW] = ow === 0 ? id : [ow, id]; return true; }
  if (ow.includes(id)) return false;
  ow.push(id);
  return true;
}

// Insert a request, or merge a repeat of it. Every merge is order-independent (max, min, or a fixed
// tie-break), so reading files in any order, in one run or many, ends in the same index.
function upsert(idx, rid, ts, sIx, mIx, tok, agent, fileId) {
  const reqs = idx.requests;
  const cur = has(reqs, rid) ? reqs[rid] : undefined;
  if (cur === undefined) {
    reqs[rid] = [ts, sIx, mIx, tok[0], tok[1], tok[2], tok[3], tok[4], tok[5], agent, fileId];
    idx.dirty = true;
    return 1;
  }
  let changed = false;
  for (let k = 0; k < 6; k++) if (tok[k] > cur[F.I + k]) { cur[F.I + k] = tok[k]; changed = true; }
  if (ts < cur[F.TS]) { cur[F.TS] = ts; changed = true; }
  if (sIx !== cur[F.S] && idx.sessions[sIx].id < idx.sessions[cur[F.S]].id) { cur[F.S] = sIx; changed = true; }
  if (agent && !cur[F.A]) { cur[F.A] = 1; changed = true; }
  if (addOwner(cur, fileId)) changed = true;
  if (changed) idx.dirty = true;
  return 0;
}

/**
 * Forget what the transcripts in `ids` contributed. A request that no transcript holds any more is
 * dropped, so the index equals a fresh scan, unless it is older than ORPHAN_KEEP_DAYS: Claude Code
 * deletes transcripts after about 30 days, and that spending is history to keep, not a mistake to forget.
 */
export function dropFiles(idx, ids, nowMs) {
  const keepAfter = Math.floor(nowMs / 1000) - ORPHAN_KEEP_DAYS * 86400;
  const reqs = idx.requests;
  for (const rid of Object.keys(reqs)) {
    const r = reqs[rid];
    const ow = r[F.OW];
    if (typeof ow === "number") {
      if (ow === 0 || !ids.has(ow)) continue;
      r[F.OW] = 0;
    } else {
      const left = ow.filter((x) => !ids.has(x));
      if (left.length === ow.length) continue;
      r[F.OW] = left.length === 0 ? 0 : left.length === 1 ? left[0] : left;
    }
    if (r[F.OW] === 0 && r[F.TS] >= keepAfter) delete reqs[rid];
  }
  idx.dirty = true;
}

// ---------------------------------------------------------------------------------------------
// Reading records
// ---------------------------------------------------------------------------------------------

// A subagent file belongs to the session whose folder it sits in, whatever its records call themselves.
const sidOf = (o, c) => (!c.agent && typeof o.sessionId === "string" && o.sessionId ? o.sessionId.slice(0, 80) : c.fileSid);

function ingestAssistant(idx, o, c) {
  const m = o.message;
  if (!m || typeof m !== "object") return 0;
  const u = m.usage;
  if (!u || typeof u !== "object") return 0;
  const model = m.model;
  if (typeof model !== "string" || !model || model.charCodeAt(0) === 60) return 0; // "<synthetic>" and friends
  const rid = o.requestId || m.id || o.uuid;
  if (typeof rid !== "string" || !rid || rid === "__proto__") return 0;
  const tok = usageTokens(u);
  if (tok[0] + tok[1] + tok[2] + tok[3] + tok[4] === 0) return 0;
  let ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
  ts = Number.isFinite(ts) ? Math.floor(ts / 1000) : c.fallbackTs;
  if (ts < c.cutoffSec) return 0; // older than the window: already folded, or never counted
  const sIx = sessionIx(idx, sidOf(o, c), ts);
  const s = idx.sessions[sIx];
  if (ts > s.seen) s.seen = ts;
  if (typeof o.cwd === "string" && o.cwd && (!s.cwd || (!c.agent && !s.cm))) {
    // A session counts toward the folder its first main-thread record names; a subagent file only fills in until then.
    const cwd = clean(o.cwd, 300);
    if (s.cwd !== cwd || (!c.agent && !s.cm)) { s.cwd = cwd; if (!c.agent) s.cm = 1; idx.dirty = true; }
  }
  const agent = c.agent || o.isSidechain === true ? 1 : 0;
  return upsert(idx, rid, ts, sIx, modelIx(idx, model), tok, agent, c.fileId);
}

function ingestRecord(idx, o, c) {
  if (o.type === "assistant") return ingestAssistant(idx, o, c);
  if (o.type === "custom-title" || o.type === "ai-title") {
    const custom = o.type === "custom-title";
    const raw = custom ? o.customTitle : o.aiTitle;
    if (typeof raw !== "string") return 0;
    const s = idx.sessions[sessionIx(idx, sidOf(o, c), c.nowSec)];
    const key = custom ? "title" : "ai";
    const t = clean(raw, 160);
    if (s[key] !== t) { s[key] = t; idx.dirty = true; }
  }
  return 0;
}

// Only lines that can matter are parsed: an assistant record carries "usage"; titles carry their own key.
function ingestText(idx, text, c) {
  let added = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const usage = line.includes('"usage"') && line.includes("assistant");
    if (!usage && !line.includes('"customTitle"') && !line.includes('"aiTitle"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; } // a complete line that is not JSON is skipped for good
    if (o && typeof o === "object") added += ingestRecord(idx, o, c);
  }
  return added;
}

function readFull(fd, buf, position) {
  let got = 0;
  while (got < buf.length) {
    const n = fs.readSync(fd, buf, got, buf.length - got, position + got);
    if (n === 0) break;
    got += n;
  }
  return got;
}
// True when the byte before `offset` ends a line, which it does in a file that has only been appended to
// (or when the last record read had no newline, which the entry remembers in `nn`).
function endsLine(fd, entry) {
  const b = Buffer.allocUnsafe(1);
  try {
    if (fs.readSync(fd, b, 0, 1, entry.offset - 1) !== 1) return false;
  } catch { return false; }
  return b[0] === 10 || (entry.nn === 1 && b[0] === 125);
}
function headMatches(fd, entry) {
  const buf = Buffer.allocUnsafe(entry.headLen);
  let n;
  try { n = readFull(fd, buf, 0); } catch { return false; }
  return n === entry.headLen && fnv1a(buf, 0, n) === entry.head;
}

const isAgentRel = (rel) => rel.includes("/subagents/");
const isMainRel = (rel) => /^[^/]+\/[^/]+\.jsonl$/.test(rel);
function fileSid(rel) {
  const parts = rel.split("/");
  if (isAgentRel(rel)) return parts[parts.indexOf("subagents") - 1];
  return parts[parts.length - 1].replace(/\.jsonl$/, "");
}

// Read the new bytes of one transcript. Returns true when the time budget ended the read before the end of the file.
function ingestFile(idx, job, o, stats, clock) {
  const { rel, abs, entry } = job;
  let fd;
  try { fd = fs.openSync(abs, "r"); } catch { stats.errors++; return false; }
  try {
    const st = fs.fstatSync(fd);
    const size = st.size;
    if (entry.offset > size || (entry.offset > 0 && !endsLine(fd, entry)) || (entry.headLen > 0 && !headMatches(fd, entry))) {
      // Shrunk, edited in place or replaced: what it gave before is forgotten, then the whole file is read again.
      dropFiles(idx, new Set([entry.id]), o.now);
      Object.assign(entry, { size: 0, offset: 0, partial: 0, headLen: 0, head: 0, nn: 0 });
      stats.resets++;
    }
    const c = {
      fileId: entry.id, agent: isAgentRel(rel), fileSid: fileSid(rel), cutoffSec: o.cutoff,
      nowSec: Math.floor(o.now / 1000), fallbackTs: Math.floor(st.mtimeMs / 1000),
    };
    let chunk = o.chunk;
    let consumed = entry.offset;
    let partial = 0;
    let noNewline = 0;
    let stopped = false;
    while (consumed < size) {
      const buf = Buffer.allocUnsafe(Math.min(chunk, size - consumed));
      const n = readFull(fd, buf, consumed);
      if (n === 0) break; // the file shrank while it was read; the next run notices
      const atEnd = consumed + n >= size;
      if (consumed === 0 && !entry.headLen) { entry.headLen = Math.min(HEAD, n); entry.head = fnv1a(buf, 0, entry.headLen); }
      const nl = buf.lastIndexOf(10, n - 1);
      if (nl < 0 && !atEnd) { // one line longer than the chunk: read it whole
        if (chunk >= MAX_LINE) { partial = 1; break; }
        chunk = Math.min(chunk * 2, MAX_LINE);
        continue;
      }
      const useLen = nl + 1;
      if (useLen > 0) {
        let text = buf.toString("utf8", 0, useLen);
        if (consumed === 0 && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        stats.requests += ingestText(idx, text, c);
        consumed += useLen;
        stats.bytes += useLen;
      }
      if (atEnd) {
        if (n > useLen) { // text after the last newline: a record that lacks only its newline counts, an unfinished one waits
          const tail = buf.toString("utf8", useLen, n);
          if (!tail.trim()) { consumed += n - useLen; break; }
          let rec = null;
          try { rec = JSON.parse(tail); } catch { /* unfinished: its remaining bytes arrive later */ }
          if (rec && typeof rec === "object") { stats.requests += ingestRecord(idx, rec, c); consumed += n - useLen; stats.bytes += n - useLen; noNewline = 1; }
          else partial = 1;
        }
        break;
      }
      if (o.onChunk) o.onChunk();
      if (clock.exceeded()) { stopped = true; break; }
    }
    entry.offset = consumed;
    entry.size = size;
    entry.mtimeMs = st.mtimeMs;
    entry.partial = partial;
    if (noNewline) entry.nn = 1; else delete entry.nn;
    idx.dirty = true;
    stats.files++;
    return stopped;
  } catch (e) {
    // Locked, vanished or unreadable right now: the entry is unchanged and the next run tries again.
    // Anything else is a bug worth a line in errors.log.
    stats.errors++;
    if (o.onError && !EXPECTED_IO.has(e && e.code)) o.onError(e);
    return false;
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

// ---------------------------------------------------------------------------------------------
// Finding transcripts
// ---------------------------------------------------------------------------------------------

function walkJsonl(dir, prefix, depth, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name)) walkJsonl(path.join(dir, e.name), `${prefix}${e.name}/`, depth + 1, out);
    } else if (e.isFile() && e.name.endsWith(".jsonl")) {
      out.push(prefix + e.name);
    }
  }
}
const statQuiet = (p) => { try { return fs.statSync(p); } catch { return null; } };
const newEntry = (idx) => ({ id: idx.nextFileId++, size: 0, mtimeMs: 0, offset: 0, partial: 0, headLen: 0, head: 0 });
/** A file that has never been read, or whose read stopped early. */
const isPending = (e) => e.mtimeMs === 0 || (e.offset < e.size && !e.partial);
const isHot = (e, nowMs) => isPending(e) || nowMs - e.mtimeMs < HOT_MS;
const unchanged = (e, st) => st.size === e.size && st.mtimeMs === e.mtimeMs && !isPending(e);

function relUnder(root, p) {
  const r = path.relative(root, path.resolve(p));
  if (!r || r.startsWith("..") || path.isAbsolute(r)) return null;
  return r.split(path.sep).join("/");
}

// Which transcripts to look at on this run.
function discover(idx, root, rootEntries, o) {
  const want = new Set();
  const addNew = (rels) => {
    for (const rel of rels) {
      if (!has(idx.files, rel)) { idx.files[rel] = newEntry(idx); idx.dirty = true; }
      want.add(rel);
    }
  };
  const projectDirs = rootEntries.filter((e) => e.isDirectory() && e.name !== "__proto__");

  if (o.full) { // every folder, every file
    for (const e of projectDirs) {
      const found = [];
      walkJsonl(path.join(root, e.name), `${e.name}/`, 1, found);
      addNew(found);
      const st = statQuiet(path.join(root, e.name));
      if (st && idx.dirs[e.name] !== st.mtimeMs) { idx.dirs[e.name] = st.mtimeMs; idx.dirty = true; }
    }
    for (const rel of Object.keys(idx.files)) want.add(rel); // tracked files that were not listed are checked, and dropped if gone
    idx.cursor = 0;
    return { want, priority: new Set() };
  }

  // Quick: a project folder whose own time changed has a new (or removed) session file.
  for (const e of projectDirs) {
    const st = statQuiet(path.join(root, e.name));
    if (!st || idx.dirs[e.name] === st.mtimeMs) continue;
    const found = [];
    walkJsonl(path.join(root, e.name), `${e.name}/`, 1, found);
    addNew(found);
    idx.dirs[e.name] = st.mtimeMs;
    idx.dirty = true;
  }
  // Quick: every file touched lately or unfinished, then a rotating slice of the rest.
  const hot = [];
  const cold = [];
  for (const rel of Object.keys(idx.files)) (isHot(idx.files[rel], o.now) ? hot : cold).push(rel);
  for (const rel of hot) want.add(rel);
  const room = Math.max(o.coldMin ?? COLD_MIN, (o.statBudget ?? STAT_BUDGET) - hot.length);
  if (cold.length && room > 0) {
    const start = idx.cursor < cold.length ? idx.cursor : 0;
    const slice = cold.slice(start, start + room);
    for (const rel of slice) want.add(rel);
    // The position is saved with whatever else changes; a run that changes nothing writes nothing.
    idx.cursor = start + slice.length >= cold.length ? 0 : start + slice.length;
  }
  // Quick: the transcript a hook was told about is always looked at, even a long idle session that was just resumed.
  const priority = new Set();
  const mains = new Set(hot.filter(isMainRel));
  for (const p of o.priority || []) {
    if (typeof p !== "string" || !p.endsWith(".jsonl")) continue;
    const rel = relUnder(root, p);
    if (!rel || rel.startsWith("__proto__")) continue;
    if (!has(idx.files, rel) && !fs.existsSync(path.resolve(p))) continue;
    addNew([rel]);
    priority.add(rel);
    if (isMainRel(rel)) mains.add(rel);
  }
  // Quick: subagent transcripts of the sessions in use (their folder gains files without any other sign).
  for (const rel of mains) {
    const [proj, file] = rel.split("/");
    const sid = file.replace(/\.jsonl$/, "");
    const found = [];
    walkJsonl(path.join(root, proj, sid, "subagents"), `${proj}/${sid}/subagents/`, 3, found);
    addNew(found);
  }
  return { want, priority };
}

// ---------------------------------------------------------------------------------------------
// Folding old days
// ---------------------------------------------------------------------------------------------

const safeKey = (k) => (k === "__proto__" ? "__proto_" : k);

function fold(idx, r, day) {
  const s = idx.sessions[r[F.S]];
  const byDay = has(idx.folded, day) ? idx.folded[day] : (idx.folded[day] = {});
  const cwd = safeKey(s ? s.cwd : "");
  const byCwd = has(byDay, cwd) ? byDay[cwd] : (byDay[cwd] = {});
  const model = safeKey(idx.models[r[F.M]] + (r[F.A] ? "|a" : ""));
  const row = has(byCwd, model) ? byCwd[model] : (byCwd[model] = [0, 0, 0, 0, 0, 0, 0]);
  row[0] += 1;
  row[1] += r[F.I]; row[2] += r[F.O]; row[3] += r[F.W5]; row[4] += r[F.W1]; row[5] += r[F.R]; row[6] += r[F.TH];
}

/** Once a local day: requests older than the window become daily totals; forgotten sessions are pruned. */
export function rollover(idx, nowMs) {
  const today = dayKeyOf(nowMs);
  if (idx.rolledOn === today) return;
  const cutoff = cutoffSec(nowMs);
  const dayOf = makeDayOf();
  const reqs = idx.requests;
  for (const rid of Object.keys(reqs)) {
    const r = reqs[rid];
    if (r[F.TS] >= cutoff) continue;
    fold(idx, r, dayOf(r[F.TS]));
    delete reqs[rid];
  }
  const keepFrom = addDays(today, -KEEP_FOLDED_DAYS);
  for (const d of Object.keys(idx.folded)) if (d < keepFrom) delete idx.folded[d];
  pruneSessions(idx, cutoff);
  idx.rolledOn = today;
  idx.dirty = true;
}

function pruneSessions(idx, cutoff) {
  const used = new Set();
  for (const rid of Object.keys(idx.requests)) used.add(idx.requests[rid][F.S]);
  const keep = [];
  const remap = new Map();
  idx.sessions.forEach((s, i) => { if (used.has(i) || s.seen >= cutoff) { remap.set(i, keep.length); keep.push(s); } });
  if (keep.length === idx.sessions.length) return;
  for (const rid of Object.keys(idx.requests)) idx.requests[rid][F.S] = remap.get(idx.requests[rid][F.S]);
  idx.sessions = keep;
  idx._sess = new Map(keep.map((s, i) => [s.id, i]));
}

// ---------------------------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------------------------

/**
 * Bring the index up to date with the transcripts.
 * @param opts.projectsDir  folder of transcripts
 * @param opts.now          ms; the clock for "today", hot and old (tests pass one)
 * @param opts.budgetMs     stop reading after this long (at least one chunk is always read)
 * @param opts.full         look at every folder and file instead of the recent ones plus a rotating slice
 * @param opts.statBudget   files a quick run looks at (recent ones always, idle ones to fill the budget)
 * @param opts.coldMin      idle files a quick run looks at even when recent ones use up the budget
 * @param opts.priority     absolute transcript paths to look at first (the session being prompted)
 */
export function updateIndex(idx, opts) {
  const o = {
    now: Date.now(), budgetMs: Infinity, full: false, priority: [], statBudget: STAT_BUDGET, chunk: CHUNK, ...opts,
  };
  const t0 = performance.now();
  const stats = { files: 0, bytes: 0, requests: 0, checked: 0, dropped: 0, resets: 0, errors: 0, stopped: false, pending: 0, missingRoot: false, ms: 0 };
  const clock = { exceeded: () => performance.now() - t0 > o.budgetMs };
  o.cutoff = cutoffSec(o.now);
  rollover(idx, o.now);

  const root = o.projectsDir;
  let rootEntries;
  try { rootEntries = fs.readdirSync(root, { withFileTypes: true }); } catch { stats.missingRoot = true; return stats; }

  const { want, priority } = discover(idx, root, rootEntries, o);
  const jobs = [];
  const gone = new Set();
  for (const rel of want) {
    const abs = path.join(root, ...rel.split("/"));
    let st;
    try { st = fs.statSync(abs); } catch (e) {
      if (e.code === "ENOENT" || e.code === "ENOTDIR") gone.add(rel);
      continue;
    }
    if (!st.isFile()) continue;
    const entry = idx.files[rel];
    stats.checked++;
    if (!unchanged(entry, st)) jobs.push({ rel, abs, st, entry });
  }
  if (gone.size) {
    const ids = new Set();
    for (const rel of gone) { ids.add(idx.files[rel].id); delete idx.files[rel]; }
    dropFiles(idx, ids, o.now);
    stats.dropped = gone.size;
  }
  // The session being prompted first, then the newest files: a short budget covers today before old days.
  jobs.sort((a, b) => (priority.has(b.rel) - priority.has(a.rel)) || (b.st.mtimeMs - a.st.mtimeMs));
  for (let k = 0; k < jobs.length; k++) {
    if (ingestFile(idx, jobs[k], o, stats, clock)) { stats.stopped = true; break; }
    if (clock.exceeded() && k < jobs.length - 1) { stats.stopped = true; break; }
  }
  for (const rel of Object.keys(idx.files)) if (isPending(idx.files[rel])) stats.pending++;
  stats.ms = performance.now() - t0;
  return stats;
}

/**
 * Load the index, bring it up to date under the lock, save it. When another run holds the lock the
 * index is returned as it is on disk (`stats.skipped`), which is at most one run behind.
 */
export function refresh(cfg, opts = {}) {
  const lock = lockFile(cfg);
  const locked = takeLock(lock, { waitMs: opts.lockWaitMs ?? 0 });
  const idx = loadIndex(cfg);
  let stats = { locked, skipped: !locked };
  let result;
  try {
    if (locked) {
      stats = { locked, skipped: false, ...updateIndex(idx, { ...opts, projectsDir: opts.projectsDir || projectsDirOf(cfg), onChunk: () => touchLock(lock), onError: (e) => logError(cfg, e) }) };
      if (idx.dirty) saveIndex(cfg, idx);
    }
    // Work that must not interleave with another run (the hook's read-modify-write of what it announced) runs here.
    if (opts.whileLocked) result = opts.whileLocked(idx, stats);
  } catch (e) {
    logError(cfg, e);
    throw e;
  } finally {
    if (locked) releaseLock(lock);
  }
  return { idx, stats, result };
}
