import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ROUTER, getRoutes, pairChain, pairCoin, type Maker, type Pause, type PairId, type RouteLeg, type RouteLegs, type RouteView } from "@/api";
import { amountIn, coinInfo, type CoinInfo } from "@/format";
import { bestMaker, capacity, quoteOf } from "./makers";
import type { Tone } from "./progress";
import type { FirmQuote } from "./quotes";
import { useLocal } from "./daemon";

// Private swaps (routes): one coin for another through Zcash's shielded pool, coin A → shielded ZEC
// → coin C, as two swaps the user's router runs one after the other (crates/ferry-route). This file
// holds the page's live list of them (the router's SSE stream, GET /api/routes as a fallback), what
// a route can be quoted at, and the plain words for one.

interface Routes {
  // what the server's router runs; null: no router here, and no route UI anywhere
  legs: RouteLegs | null;
  // newest first, without routes that never started (nothing moved, nothing to show)
  list: RouteView[];
  byId: Record<string, RouteView>;
  // a view the page got itself (a start's or Finish now's answer)
  put: (v: RouteView) => void;
}

const Ctx = createContext<Routes | null>(null);
const POLL_MS = 15_000;

// the later of two views of one route
const newer = (a: RouteView | undefined, b: RouteView) => (!a || b.updated_at >= a.updated_at ? b : a);

export function RoutesProvider({ children }: { children: ReactNode }) {
  const { info } = useLocal();
  const legs = info.routes;
  const [byId, setById] = useState<Record<string, RouteView>>({});
  const put = (v: RouteView) => setById((m) => ({ ...m, [v.id]: newer(m[v.id], v) }));

  useEffect(() => {
    if (!legs) return;
    let alive = true;
    const load = () =>
      getRoutes().then(
        (list) => alive && setById((m) => list.reduce((acc, v) => ({ ...acc, [v.id]: newer(acc[v.id], v) }), m)),
        () => {},
      );
    load();
    // the stream sends every route when it opens, then each change; the poll covers a stream the
    // server refused (too many open tabs) or a router that restarted
    const es = new EventSource(`${ROUTER}/api/events`);
    es.addEventListener("route", (e) => {
      try {
        put(JSON.parse((e as MessageEvent).data) as RouteView);
      } catch {
        /* not a route */
      }
    });
    const id = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      es.close();
      clearInterval(id);
    };
  }, [legs]);

  const value = useMemo(() => {
    const list = Object.values(byId)
      .filter(shown)
      .sort((x, y) => y.created_at - x.created_at || (x.id < y.id ? 1 : -1));
    return { legs, list, byId, put };
  }, [legs, byId]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRoutes(): Routes {
  const v = useContext(Ctx);
  if (!v) throw new Error("useRoutes outside RoutesProvider");
  return v;
}

// ------------------------------------------------------------------------------------------------
// what a route can be

export const assetOf = (id: string) => id.split("-")[0];
// A from-coin the router buys ZEC with, a to-coin it sells ZEC for, and two different assets (USDC to
// USDC would put the same amount on both ends, which links them).
export const canRoute = (legs: RouteLegs | null, from: PairId, to: PairId) => !!legs && legs.from.includes(from) && legs.to.includes(to) && assetOf(from) !== assetOf(to);

// a route that is still moving; holding waits for the person
export const isRunning = (v: RouteView) => v.state === "leg1" || v.state === "settling" || v.state === "pausing" || v.state === "leg2";
// a route that never started moved nothing: it isn't listed
const shown = (v: RouteView) => !(v.state === "failed" && v.outcome === "not_started" && !v.legs[0].swap_id);

// the swap ids of every route's legs, so a list of swaps can leave them out (one route, one row)
export function legSwapIds(list: RouteView[]): Set<string> {
  const ids = new Set<string>();
  for (const v of list) for (const l of v.legs) for (const id of [l.swap_id, ...l.earlier_swaps]) if (id) ids.add(id);
  return ids;
}

// ------------------------------------------------------------------------------------------------
// amounts

// a pair's coin, its chain included: USDC on Base
export const coinFor = (id: PairId | string): CoinInfo => {
  const c = coinInfo(pairCoin(id as PairId));
  return c.kind === "evm" ? { ...c, chain: pairChain(id as PairId) ?? c.chain } : c;
};
export const tickerOf = (id: PairId | string) => coinFor(id).ticker;
// "0.0042 BTC", "41.22 USDC"
export const unitsText = (units: number, id: PairId | string) => `${amountIn(units, coinFor(id))} ${tickerOf(id)}`;
// "0.9994 ZEC", "1.00 ZEC": a route's ZEC is seldom round, so up to 4 places, at least 2
export const zecText = (zat: number) => `${(zat / 1e8).toFixed(4).replace(/0{1,2}$/, "")} ZEC`;

// The sweep's fee allowance and the second swap's lock reserve (ferry-route's defaults): the second
// swap sells this much less ZEC than the first buys.
export const ROUTE_FEE_ZAT = 60_000;
// the first swap starts at once, at the partner's live rate: room for it to tick up this much
export const IN_SLIP = 0.005;
// the second starts 30 minutes or more later: it may pay this much less than today's price, else the
// router holds the ZEC (the spec's 2%)
export const OUT_SLIP = 0.02;

// A maker that swaps `id`: the same coin, and for a token the same chain.
export function makerFor(m: Maker, id: PairId): boolean {
  const c = coinFor(id);
  return m.pair === `ZEC/${c.ticker}` && (c.kind !== "evm" || (m.chain ?? null) === c.chain);
}

export interface RouteQuote {
  maker1: Maker;
  maker2: Maker;
  // partners' rates, counter units per ZEC
  rate1: number;
  rate2: number;
  // ZEC bought by the first swap, sold by the second
  zat: number;
  zat2: number;
  // what the first swap costs at rate1 (never above maxIn)
  pay: number;
  maxIn: number;
  // what the second pays at rate2, less its payout fee, and the least it may pay: the router's
  // min_out (before the fee) and that less the fee
  out: number;
  minOut: number;
  minNet: number;
  firm: boolean;
  problem: string | null;
}

// ZEC the first swap buys for at most `maxIn` of coin A at `rate`: rounded down to 0.001 ZEC (round
// amounts give a partner less to match on), with room for the rate to tick up
export const zatFor = (maxIn: number, rate: number) => (rate > 0 ? Math.floor((maxIn * 1e8) / (rate * (1 + IN_SLIP)) / 100_000) * 100_000 : 0);
// coin A it takes to buy `zat` that way
export const costOf = (zat: number, rate: number) => Math.ceil((zat * rate * (1 + IN_SLIP)) / 1e8);

// The quote for selling `maxIn` of coin A for coin C: the cheapest partner who sells ZEC for A, then
// the best one (another partner) who buys it for C, at their firm price when they gave one. The
// first swap runs at its partner's live rate: a route can't carry a firm price for it.
export function routeQuote(makers: Maker[] | null | undefined, from: PairId, to: PairId, maxIn: number, firm2: FirmQuote[] = []): RouteQuote | { problem: string } | null {
  if (!makers) return null;
  const a = tickerOf(from);
  const c = tickerOf(to);
  const sell = makers.filter((m) => m.available && m.role === "Z" && makerFor(m, from) && quoteOf(m));
  const buy = makers.filter((m) => m.available && m.role === "B" && makerFor(m, to) && quoteOf(m));
  if (!sell.length) return { problem: `No partner is selling ZEC for ${a} right now. Try again in a minute.` };
  let maker1 = bestMaker(sell, 0, "B")!;
  let zat = zatFor(maxIn, quoteOf(maker1)!.rate);
  const better = bestMaker(sell, zat, "B");
  if (better && better.name !== maker1.name) {
    maker1 = better;
    zat = zatFor(maxIn, quoteOf(maker1)!.rate);
  }
  const q1 = quoteOf(maker1)!;
  const others = buy.filter((m) => m.name !== maker1.name);
  if (!others.length) return { problem: `No partner is buying ZEC for ${c} right now. Try again in a minute.` };
  const zat2 = zat - ROUTE_FEE_ZAT;
  // the best firm price for the second swap picks its partner, else the best rate
  const f = firm2.find((q) => others.some((m) => m.name === q.maker));
  const maker2 = (f && others.find((m) => m.name === f.maker)) || bestMaker(others, Math.max(zat2, 0), "Z")!;
  const q2 = quoteOf(maker2)!;
  const rate2 = f ? f.rate_sat_per_zec : q2.rate;
  const fee2 = q2.fee ?? 0;
  const gross = Math.floor((Math.max(zat2, 0) * rate2) / 1e8);
  const minOut = Math.floor((Math.max(zat2, 0) * Math.min(rate2, q2.rate) * (1 - OUT_SLIP)) / 1e8);
  const quote: RouteQuote = {
    maker1,
    maker2,
    rate1: q1.rate,
    rate2,
    zat,
    zat2,
    pay: Math.ceil((zat * q1.rate) / 1e8),
    maxIn,
    out: Math.max(0, gross - fee2),
    minOut,
    minNet: Math.max(0, minOut - fee2),
    firm: !!f,
    problem: null,
  };
  const least = Math.max(q1.min, q2.min + ROUTE_FEE_ZAT, ROUTE_FEE_ZAT + 100_000);
  const most = Math.min(capacity(q1), capacity(q2) + ROUTE_FEE_ZAT);
  if (zat < least) quote.problem = `The smallest private swap here is about ${unitsText(costOf(least, q1.rate), from)}.`;
  else if (zat > most) quote.problem = `The largest private swap right now is about ${unitsText(costOf(most, q1.rate), from)}.`;
  else if (quote.minNet <= 0) quote.problem = `That's too little to get any ${c} after fees.`;
  return quote;
}

// A first amount to show: what about 1 ZEC costs (or the most a partner takes, if less), rounded
// down to two significant digits so it reads like a person typed it.
export function startAmount(makers: Maker[] | null | undefined, from: PairId, to: PairId): string | null {
  if (!makers) return null;
  const sell = makers.filter((m) => m.available && m.role === "Z" && makerFor(m, from) && quoteOf(m));
  const buy = makers.filter((m) => m.available && m.role === "B" && makerFor(m, to) && quoteOf(m));
  const m1 = bestMaker(sell, 0, "B");
  if (!m1 || !buy.length) return null;
  const q1 = quoteOf(m1)!;
  const cap = Math.min(capacity(q1), Math.max(...buy.map((m) => capacity(quoteOf(m)!))) + ROUTE_FEE_ZAT);
  const units = costOf(Math.min(1e8, cap), q1.rate);
  const c = coinFor(from);
  const whole = units / 10 ** c.decimals;
  if (!(whole > 0)) return null;
  const step = 10 ** (Math.floor(Math.log10(whole)) - 1);
  const v = Math.floor(whole / step) * step;
  return v.toFixed(Math.max(0, -Math.floor(Math.log10(step)))).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

// "0.0041" (as typed) → base units of the pair's coin; NaN if it isn't a number
export function parseUnits(text: string, id: PairId): number {
  const t = text.trim();
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return NaN;
  const [w, f = ""] = t.split(".");
  const d = coinFor(id).decimals;
  if (f.length > d) return NaN;
  return Number(w || "0") * 10 ** d + Number((f + "0".repeat(d)).slice(0, d) || "0");
}

// ------------------------------------------------------------------------------------------------
// the privacy pause and how long a route takes

export const PAUSE: Record<Pause, { label: string; window: string; note: string; total: string }> = {
  off: { label: "Off", window: "no wait", note: "Fastest, but the two swaps are easier to link by their timing.", total: "about 30–45 min" },
  standard: { label: "Standard", window: "5–30 min", note: "A random wait of 5 to 30 minutes between the two swaps.", total: "about 35–75 min" },
  long: { label: "Long", window: "1–6 hours", note: "A random wait of 1 to 6 hours. The hardest to link.", total: "about 1½–7 hours" },
};
export const PAUSES: Pause[] = ["off", "standard", "long"];

// ------------------------------------------------------------------------------------------------
// words

export const ROUTE_WORD = (v: RouteView): { label: string; tone: Tone } => {
  if (isRunning(v)) return { label: "In progress", tone: "live" };
  if (v.state === "holding") return { label: "Holding ZEC", tone: "warn" };
  if (v.state === "done") return { label: "Done", tone: "good" };
  if (v.outcome === "punished") return { label: "Expired", tone: "bad" };
  if (v.outcome === "refunded") return { label: "Cancelled", tone: "neutral" };
  return { label: "Didn't start", tone: "neutral" };
};

// the amounts as they stand: what went in (or may), the ZEC between, what came out (or the least)
export function routeAmounts(v: RouteView) {
  const [l1, l2] = v.legs;
  const paid = l1.counter_units != null && l1.swap_id ? l1.counter_units : null;
  const got = v.state === "done" && l2.counter_units != null ? l2.counter_units : null;
  return {
    in: paid != null ? unitsText(paid, v.from) : `up to ${unitsText(v.amounts.in_max, v.from)}`,
    inShort: unitsText(paid ?? v.amounts.in_max, v.from),
    zec: zecText(v.state === "holding" ? v.zec.held_zat : v.amounts.zec_zat),
    out: got != null ? unitsText(got, v.to) : `at least ${unitsText(v.amounts.out_min, v.to)}`,
    outShort: got != null ? unitsText(got, v.to) : tickerOf(v.to),
    got,
  };
}

const stateOf = (l: RouteLeg) => (l.state ?? "").split(/[\s{]/)[0];

// The current step of one of the two swaps, in a sentence.
export function legNote(l: RouteLeg): string {
  const s = stateOf(l);
  const who = l.maker ?? "your partner";
  const t = l.unit.ticker;
  if (l.role === "B") {
    if (["", "Negotiated", "LockBuilt", "CancelSigned", "Locking"].includes(s)) return `Setting up the swap with ${who}.`;
    if (["BtcLocked", "Locked"].includes(s)) return `Your ${t} is locked. Waiting for ${who} to lock the ZEC.`;
    if (["ZecSeen", "RedeemSigSent", "ReadySigning", "ReadySent"].includes(s)) return `The ZEC is locked for you. Waiting for ${who} to collect the ${t}.`;
    if (["BtcRedeemed", "Claimed", "ZecSwept"].includes(s)) return "Moving the ZEC into your shielded wallet.";
    if (["Cancelled", "Refunding"].includes(s)) return `This swap is being called off. Your ${t} comes back.`;
    return "In progress.";
  }
  if (["", "Negotiated", "CancelSigsSent", "CancelSigned"].includes(s)) return `Waiting for ${who} to lock their ${t}. They go first.`;
  if (["BtcLockSeen", "LockSeen"].includes(s)) return "Locking your ZEC for the swap.";
  if (s === "ZecLocked") return `Your ZEC is locked. Waiting for ${who}.`;
  if (["RedeemSigReceived", "ReadyReceived", "Redeeming", "Claiming"].includes(s)) return `Collecting your ${t}.`;
  if (["Cancelled", "Expired", "ZecReclaiming", "ZecLockRefused"].includes(s)) return "This swap is being called off. Your ZEC goes back to your shielded wallet.";
  return "In progress.";
}

// One plain line for a banner or a list row.
export function routeSummary(v: RouteView, now = Date.now()): string {
  const a = tickerOf(v.from);
  const c = tickerOf(v.to);
  switch (v.state) {
    case "leg1":
      return `Swap 1 of 2: buying ZEC with your ${a}`;
    case "settling":
      return `Your ZEC is settling: ${Math.min(v.zec.sweep_confs, v.zec.needed_confs)} of ${v.zec.needed_confs} confirmations`;
    case "pausing":
      return `Private pause: swap 2 starts ${inAbout(v, now)}`;
    case "leg2":
      return `Swap 2 of 2: selling the ZEC for ${c}`;
    case "holding":
      return `You hold ${zecText(v.zec.held_zat)}. Finish the swap or keep it.`;
    case "done":
      return `You received ${routeAmounts(v).outShort}`;
    default:
      return v.outcome === "refunded" ? `Your ${a} is back` : v.outcome === "punished" ? "The deadline passed while your Ferry node was offline" : "Nothing moved";
  }
}

// "in about 12 min", "in less than a minute", "any moment now"
export function inAbout(v: RouteView, now = Date.now()): string {
  const left = v.privacy.not_before == null ? 0 : v.privacy.not_before - now / 1000;
  if (left <= 5) return "any moment now";
  if (left < 60) return "in less than a minute";
  if (left < 5400) return `in about ${Math.round(left / 60)} min`;
  return `in about ${Math.round(left / 360) / 10} hours`;
}
