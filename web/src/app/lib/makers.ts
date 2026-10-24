import { useEffect, useState } from "react";
import { counterBalance, getMakers, pairChain, pairCoin, type Maker, type PairId, type Role, type Status } from "@/api";
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

// What the app says when a node, or every partner, runs as many swaps as it takes at once (ferryd's
// 409 "busy"). A partner has room again when one of its swaps finishes, so the only time worth
// giving is a swap's own, `about` (typicalText: the table in server/paths.mjs that the card shows);
// without it, no time at all. The UI server says the timeless one.
export function busyText(about: string | null | undefined): string {
  return about ? `Every partner is busy right now. A swap takes ${about}, so one usually has room again within that.` : BUSY_TEXT;
}
export const BUSY_TEXT = "Every partner is busy right now. Try again once one of their swaps finishes.";
export const isBusyText = (s: string | null | undefined) => !!s && s.startsWith("Every partner is busy right now.");

// A partner that swaps this way but is full right now (it takes more once a swap of its finishes).
export const busyFor = (m: Maker, role: "Z" | "B") => !!m.busy && swappable(m) && (m.role == null || m.role !== role);

// What a ZEC lock needs on top of its amount (ferry-zec's SEND_FEE_RESERVE), and a Bitcoin or
// Litecoin lock (ferryd's B keeps as much for the lock's own fee): ferryd's admission adds the same.
export const ZEC_FEE_RESERVE = 50_000;
export const LOCK_FEE_RESERVE = 10_000;

// Whether the node you swap through takes a swap of `zat` ZEC now, by its own status (ferryd's
// capacity and free funds, docs/API.md "Several swaps at once"): "yes" with a free slot and free
// funds for the amount and its fee (selling ZEC: free shielded ZEC, which ferryd already counts
// with the notes its locks may take; buying it: the free coin, `gross` in its base units), "busy"
// with no free slot or the funds held by its swaps in progress, "short" when its wallet doesn't
// hold that much at all (the card says so), null when it doesn't say (an older ferryd) or there is
// no amount.
export function nodeRoom(status: Status | null, role: Role, zat: number, gross: number, evm: boolean): "yes" | "busy" | "short" | null {
  if (!status?.capacity || !status.free || zat <= 0) return null;
  if (status.capacity.free_slots === 0) return "busy";
  const z = role === "Z";
  const need = z ? zat + ZEC_FEE_RESERVE : gross + (evm ? 0 : LOCK_FEE_RESERVE);
  const free = z ? status.free.zec_shielded_zat : counterBalance({ ...status, balances: status.free });
  if (free >= need) return "yes";
  const have = z ? status.balances.zec_shielded_zat : counterBalance(status);
  return have >= need && status.capacity.live > 0 ? "busy" : "short";
}

// One small line on whether this swap can start now, saying only what both sides of it say: the
// partner (its offer: online, making offers, a free slot, and free funds that cover the amount) and
// the node you swap through (nodeRoom). "Partner online · can take your swap now" when both can;
// "Partner busy · usually free again within about 20–40 min" when either is full or its funds are
// held by swaps in progress (`about`: typicalText, a swap's own time; without it no time is given);
// "Partner offline", "Partner paused"; plain "Partner online" when it can't be said for sure (no
// amount yet, an amount the partner can't fill now, an older ferryd). null: no partner to speak of.
export function availability(m: Maker | null | undefined, about?: string | null, take?: { status: Status | null; role: Role; zat: number; gross: number; evm: boolean; offline?: boolean }): string | null {
  if (take?.offline) return "Partner offline";
  if (!m) return null;
  if (!m.online) return "Partner offline";
  const node = take ? nodeRoom(take.status, take.role, take.zat, take.gross, take.evm) : null;
  if (m.busy || node === "busy") return about ? `Partner busy · usually free again within ${about}` : "Partner busy · free again when a swap finishes";
  if (m.paused || !m.available) return "Partner paused";
  const q = quoteOf(m);
  // the partner's own figures: a free slot, and free funds (its liquidity, which ferryd counts with
  // the notes its locks may take) covering this amount
  const partner = !!q && m.free_slots != null && m.free_slots > 0 && m.liquidity_zat != null && !!take && fits(q, take.zat);
  return partner && node === "yes" ? "Partner online · can take your swap now" : "Partner online";
}

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

// Every partner listed for pair `id` this way (`role`: the side you take) is offline; false when none
// is listed, or the list isn't in yet.
export function partnersOffline(makers: Makers | undefined, id: PairId, onScreen: PairId, role: Role): boolean {
  const listed = (makers?.list ?? []).filter((m) => (m.role == null || m.role !== role) && forPair(m, id, onScreen));
  return listed.length > 0 && listed.every((m) => !m.online);
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
