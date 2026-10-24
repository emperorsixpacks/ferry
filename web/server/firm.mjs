// When a fresh firm price may stand in for the one a person pressed on. Plain JavaScript, shared: the
// UI servers' quote desk (quotes.mjs claim()) and the swap card (src/app/lib/quotes.ts) use it, and
// quotes.test.mjs tests it.
//
// A maker honours each firm quote once. When the one a person was shown has gone (another start
// took it, or it ran out), a fresh one from the same maker may be used instead, without asking them
// again, only if it is no worse for them: selling ZEC (taker Z) at least the rate they saw, buying it
// (taker B) at most that rate, and covering their amount.

// `rate` is no worse than `shown` for a taker of role `takerRole` ("Z" sells ZEC, "B" buys it).
// Integers or their decimal strings (a WETH rate is above 2^53).
export function noWorse(rate, shown, takerRole) {
  const [r, s] = [BigInt(rate), BigInt(shown)];
  return takerRole === "Z" ? r >= s : r <= s;
}

// Of `list` (firm quotes {maker, quote_id, rate_sat_per_zec, min_zat, max_zat}, best first), a fresh
// one to start `zat` with in place of `pressed`: from the same maker, another quote, covering the
// amount, no worse. null: none, and the person sees the new price before anything starts.
export function standIn(list, pressed, zat, takerRole) {
  return (
    (list ?? []).find(
      (q) => q.maker === pressed.maker && q.quote_id !== pressed.quote_id && q.min_zat <= zat && zat <= q.max_zat && noWorse(q.rate_sat_per_zec, pressed.rate_sat_per_zec, takerRole),
    ) ?? null
  );
}
