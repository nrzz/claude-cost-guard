// Reading usage out of one transcript record.

const num = (x) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);

/**
 * Token counts of one request: [input, output, cacheWrite5m, cacheWrite1h, cacheRead, thinking].
 *
 * When `iterations` is present (a request that ran several model calls) they are summed instead of the
 * top level. Cache writes are split by lifetime; a write the split does not account for counts as a
 * 5-minute write. `output` already includes thinking tokens: `thinking` is the part of it that was thinking.
 */
export function usageTokens(u) {
  const its = Array.isArray(u.iterations) && u.iterations.length ? u.iterations : [u];
  let i = 0, o = 0, w5 = 0, w1 = 0, r = 0, th = 0;
  for (const it of its) {
    if (!it || typeof it !== "object") continue;
    i += num(it.input_tokens);
    o += num(it.output_tokens);
    r += num(it.cache_read_input_tokens);
    const total = num(it.cache_creation_input_tokens);
    const cc = it.cache_creation;
    if (cc && typeof cc === "object" && (cc.ephemeral_5m_input_tokens !== undefined || cc.ephemeral_1h_input_tokens !== undefined)) {
      const a = num(cc.ephemeral_5m_input_tokens);
      const b = num(cc.ephemeral_1h_input_tokens);
      w5 += a + Math.max(0, total - a - b);
      w1 += b;
    } else {
      w5 += total;
    }
    th += num(it.output_tokens_details && it.output_tokens_details.thinking_tokens);
  }
  if (!th) th = num(u.output_tokens_details && u.output_tokens_details.thinking_tokens);
  return [i, o, w5, w1, r, Math.min(th, o)];
}

/** FNV-1a over bytes [start, end) of a buffer: a cheap fingerprint of the start of a file. */
export function fnv1a(buf, start, end) {
  let h = 0x811c9dc5;
  for (let k = start; k < end; k++) h = Math.imul(h ^ buf[k], 0x01000193);
  return h >>> 0;
}
