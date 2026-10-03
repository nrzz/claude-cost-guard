// What a request costs, in dollars at API list prices.
// API list prices on 2026-10-01; subscription plans are not billed per token, so on a plan the dollars
// are a yardstick for how fast limits fill.
// $/MTok: [input, output, cacheRead, cacheWrite5m, cacheWrite1h]
export const PRICE = {
  "claude-fable-5-1": [10, 50, 0.25, 12.5, 20],
  "claude-fable-5": [10, 50, 1, 12.5, 20],
  "claude-opus-5-5": [4, 20, 0.2, 5, 8],
  "claude-opus-5": [5, 25, 0.5, 6.25, 10],
  "claude-opus-4-8": [5, 25, 0.5, 6.25, 10],
  "claude-opus-4-7": [5, 25, 0.5, 6.25, 10],
  "claude-opus-4-6": [5, 25, 0.5, 6.25, 10],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5, 4],
  "claude-sonnet-5": [2, 10, 0.2, 2.5, 4],
  "claude-sonnet-4-6": [3, 15, 0.3, 3.75, 6],
  "claude-haiku-4-5": [1, 5, 0.1, 1.25, 2],
};
/** What a model that is not in the table is priced at. */
export const FALLBACK_PRICE = [5, 25, 0.5, 6.25, 10];

// Longest prefix first, so "claude-opus-5-5-2026xxxx" finds claude-opus-5-5 and not claude-opus-5.
const KEYS = Object.keys(PRICE).sort((a, b) => b.length - a.length);
const memo = new Map();

function lookup(model) {
  const m = String(model || "");
  if (memo.has(m)) return memo.get(m);
  const key = Object.hasOwn(PRICE, m) ? m : KEYS.find((k) => m.startsWith(k));
  const hit = key ? { price: PRICE[key], known: true } : { price: FALLBACK_PRICE, known: false };
  memo.set(m, hit);
  return hit;
}
export const priceFor = (model) => lookup(model).price;
/** False when the model is priced at the fallback rate. */
export const isKnownModel = (model) => lookup(model).known;

/** Dollars for token counts: input, output, cache write (5 minute), cache write (1 hour), cache read. */
export function costOf(model, i, o, w5, w1, r) {
  const [pi, po, pr, pw5, pw1] = priceFor(model);
  return (i * pi + o * po + r * pr + w5 * pw5 + w1 * pw1) / 1e6;
}
