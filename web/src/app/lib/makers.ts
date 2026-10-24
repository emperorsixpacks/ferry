import { useEffect, useState } from "react";
import { getMakers, pairChain, pairCoin, type Maker, type PairId, type Role, type Status } from "@/api";
import { coin, coinInfo } from "@/format";

// The UI server's maker directory (GET /api/makers), polled. The server caches each maker's offer
// for a few seconds, so polling often costs the makers nothing extra.

const POLL_MS = 15_000;

export interface Makers {
  // undefined while loading; null when the server has no maker directory
  list: Maker[] | null | undefined;
  error: string | null;
  // when `list` was fetched (ms), so rate ages can keep counting between polls
  fetchedAt: number;
  now: number;
}

export function useMakers(): Makers {
  const [state, setState] = useState<Omit<Makers, "now">>({ list: undefined, error: null, fetchedAt: 0 });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const list = await getMakers();
        if (alive) setState({ list, error: null, fetchedAt: Date.now() });
      } catch (e) {
        if (alive) setState((s) => ({ ...s, list: s.list ?? [], error: (e as Error).message }));
      }
      if (alive) timer = setTimeout(load, POLL_MS);
    };
    load();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      clearTimeout(timer);
      clearInterval(tick);
    };
  }, []);

  return { ...state, now };
}

// What the swap form quotes from: one maker's offer.
export interface Quote {
  rate: number;
  min: number;
  max: number;
  fee: number | null;
  // how much ZEC the maker can fill right now, when it says
  liquidity: number | null;
}

export const quoteOf = (m: Maker): Quote | null =>
  m.rate_sat_per_zec != null && m.min_zat != null && m.max_zat != null
    ? { rate: m.rate_sat_per_zec, min: m.min_zat, max: m.max_zat, fee: m.fee_sat, liquidity: m.liquidity_zat }
    : null;

// A maker for the pair on screen: the same coin, and for a token the same chain (a USDC maker on
// Base can't fill a swap whose daemon is on Arbitrum).
export const swappable = (m: Maker) => m.pair === `ZEC/${coin().ticker}` && (coin().kind !== "evm" || (m.chain ?? null) === coin().chain);

// A maker this party can start a swap with: it takes swaps now, trades a pair the form supports,
// and holds the other side.
export const selectable = (m: Maker, role: "Z" | "B") => m.available && swappable(m) && (m.role == null || m.role !== role);

// The daemon's own offer, for a server without a maker directory only: a taker's status.offer is
// ferryd's default maker offer, a placeholder, so with a directory the rate comes from a maker.
export const ownQuote = (s: Status): Quote => ({
  rate: s.offer.rate_sat_per_zec,
  min: s.offer.min_zat,
  max: s.offer.max_zat,
  fee: s.offer.fee_sat ?? null,
  liquidity: null,
});

// The live quote for the pair on screen at `zat` (0: no amount yet): the partner to swap with and
// its offer. `pick` is a partner the viewer chose; it is kept while it can fill the amount.
export function liveQuote(makers: Makers, status: Status | null, role: Role, zat: number, pick: string | null = null) {
  if (makers.list === null) return { maker: null, quote: status ? ownQuote(status) : null, usable: [] as Maker[], skipped: null };
  const usable = makers.list?.filter((m) => selectable(m, role)) ?? [];
  const chosen = pick ? (usable.find((m) => m.name === pick) ?? null) : null;
  const cq = chosen && quoteOf(chosen);
  const best = bestMaker(usable, zat, role);
  const bestFits = !!best && zat > 0 && fits(quoteOf(best)!, zat);
  // the chosen partner stays while it can fill the amount, or while nobody else can either
  const keep = !!chosen && !!cq && (zat <= 0 || fits(cq, zat) || !bestFits);
  const maker = keep ? chosen : best;
  // the chosen partner can't take this amount, so another one quotes it
  const skipped = chosen && !keep && maker && maker.name !== chosen.name ? chosen : null;
  return { maker, quote: maker ? quoteOf(maker) : null, usable, skipped };
}

// A maker for any pair: the one on screen as `swappable` says, another by its id.
export function forPair(m: Maker, id: PairId, onScreen: PairId): boolean {
  if (id === onScreen) return swappable(m);
  const c = coinInfo(pairCoin(id));
  return m.pair === `ZEC/${c.ticker}` && (c.kind !== "evm" || (m.chain ?? null) === pairChain(id));
}

// The most ZEC a maker takes in one swap right now: its range's top, or less if its balance is lower.
export const capacity = (q: Quote) => Math.min(q.max, q.liquidity ?? Infinity);
export const fits = (q: Quote, zat: number) => zat >= q.min && zat <= capacity(q);

// The counter coin for `zat` at a quote, as this party sees it: Z receives the locked amount less
// the fee of the transaction that pays it out; B pays the locked amount.
export function counterFor(q: Quote, zat: number, role: Role): number {
  const gross = Math.round((zat / 1e8) * q.rate);
  return role === "Z" ? Math.max(0, gross - (q.fee ?? 0)) : gross;
}

// The partner to quote: of the makers given (already filtered to ones that take swaps), those
// that can fill `zat` if any can, and of those the best for this party (Z gets the most, B pays
// the least). No amount yet: the best rate for 1 ZEC.
export function bestMaker(list: Maker[], zat: number, role: Role): Maker | null {
  const priced = list.filter((m) => quoteOf(m));
  const amount = zat > 0 ? zat : 1e8;
  const fitting = priced.filter((m) => fits(quoteOf(m)!, amount));
  const pool = fitting.length ? fitting : priced;
  let best: Maker | null = null;
  let bestValue = 0;
  for (const m of pool) {
    const v = counterFor(quoteOf(m)!, amount, role);
    if (!best || (role === "Z" ? v > bestValue : v < bestValue)) {
      best = m;
      bestValue = v;
    }
  }
  return best;
}

// "20s ago", "4m ago", "2h ago"
export function ago(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
