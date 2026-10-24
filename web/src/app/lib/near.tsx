import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { NearError, getCombos, getNearHop, getNearInfo, getNearJobs, getNearQuote, type ComboJob, type Direction, type NearHop, type NearInfo, type NearJob, type NearQuote, type NearToken, type PairId } from "@/api";
import type { Tone } from "./progress";

// NEAR Intents on the swap card: its assets (GET /api/near/tokens), composed quotes (Ferry's leg ×
// NEAR Intents' leg, POST /api/near/quote) and the NEAR swaps this server runs (GET /api/near/jobs).
// Ferry is the private hop; NEAR Intents is the reach. Ferry never sends ZEC to NEAR Intents: it
// swaps shielded ZEC for a coin it supports, and NEAR Intents carries that coin on (or the other way).

interface Near {
  // undefined while loading; null: this server has no NEAR Intents, and the page shows none of it
  info: NearInfo | null | undefined;
  tokens: NearToken[];
  byId: Record<string, NearToken>;
  // whether a NEAR swap runs here this way
  runs: (dir: Direction) => boolean;
  // newest first
  jobs: NearJob[];
  job: (id: string) => NearJob | undefined;
  put: (j: NearJob) => void;
  // private swaps with NEAR Intents at an end, newest first
  combos: ComboJob[];
  combo: (id: string) => ComboJob | undefined;
  putCombo: (j: ComboJob) => void;
}

const Ctx = createContext<Near | null>(null);

export const isActive = (j: NearJob | ComboJob) => !["done", "refunded", "failed", "expired"].includes(j.state);

export function NearProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<NearInfo | null | undefined>(undefined);
  const [byJob, setByJob] = useState<Record<string, NearJob>>({});
  const [byCombo, setByCombo] = useState<Record<string, ComboJob>>({});
  const put = (j: NearJob) => setByJob((m) => (m[j.id] && m[j.id].updated_at > j.updated_at ? m : { ...m, [j.id]: j }));
  const putCombo = (j: ComboJob) => setByCombo((m) => (m[j.id] && m[j.id].updated_at > j.updated_at ? m : { ...m, [j.id]: j }));

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const v = await getNearInfo().catch(() => null);
      if (!alive) return;
      setInfo((old) => (v ?? (old ? old : null)));
      // the token list changes slowly; the server caches it for 5 minutes
      timer = setTimeout(load, 300_000);
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  const runsAny = !!info && (info.execution.sell || info.execution.buy || !!info.compose?.runs);
  const active = Object.values(byJob).some(isActive) || Object.values(byCombo).some(isActive);
  useEffect(() => {
    if (!runsAny) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const [list, combos] = await Promise.all([getNearJobs().catch(() => null), getCombos().catch(() => null)]);
      if (!alive) return;
      if (list) setByJob(Object.fromEntries(list.map((j) => [j.id, j])));
      if (combos) setByCombo(Object.fromEntries(combos.map((j) => [j.id, j])));
      timer = setTimeout(load, list?.some(isActive) || combos?.some(isActive) ? 2500 : 15_000);
    };
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [runsAny, active]);

  const value = useMemo<Near>(() => {
    const tokens = info?.tokens ?? [];
    const jobs = Object.values(byJob).sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1));
    const combos = Object.values(byCombo).sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1));
    return {
      info,
      tokens,
      byId: Object.fromEntries(tokens.map((t) => [t.assetId, t])),
      runs: (dir) => !!info?.execution[dir],
      jobs,
      job: (id) => byJob[id],
      put,
      combos,
      combo: (id) => byCombo[id],
      putCombo,
    };
  }, [info, byJob, byCombo]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNear(): Near {
  const v = useContext(Ctx);
  if (!v) throw new Error("useNear outside NearProvider");
  return v;
}

// ------------------------------------------------------------------------------------------------
// chains and amounts

// 1Click's chain ids, as people name them
const CHAINS: Record<string, string> = {
  btc: "Bitcoin",
  ltc: "Litecoin",
  eth: "Ethereum",
  base: "Base",
  arb: "Arbitrum",
  op: "Optimism",
  sol: "Solana",
  near: "NEAR",
  bsc: "BNB Chain",
  tron: "Tron",
  xrp: "XRP Ledger",
  doge: "Dogecoin",
  ton: "TON",
  sui: "Sui",
  aptos: "Aptos",
  cardano: "Cardano",
  stellar: "Stellar",
  avax: "Avalanche",
  pol: "Polygon",
  gnosis: "Gnosis",
  bera: "Berachain",
  bch: "Bitcoin Cash",
  dash: "Dash",
  monad: "Monad",
  xlayer: "X Layer",
  scroll: "Scroll",
  hood: "Robinhood Chain",
  plasma: "Plasma",
  starknet: "Starknet",
  aleo: "Aleo",
  hypercore: "Hyperliquid",
  hlevm: "HyperEVM",
  movement: "Movement",
  abs: "Abstract",
  fogo: "Fogo",
  zec: "Zcash",
};
export const chainName = (id: string) => CHAINS[id] ?? id.toUpperCase();
// the swap card's own chain chips, as 1Click names those chains
export const FERRY_CHAIN_IDS: Record<string, string> = { bitcoin: "btc", litecoin: "ltc", ethereum: "eth", base: "base", arbitrum: "arb", optimism: "op" };

// base units → a number of whole tokens, for showing (a big amount rounds, which is fine to show)
export function whole(v: string | null | undefined, decimals: number): number {
  if (!v || !/^\d+$/.test(v)) return 0;
  const s = v.padStart(decimals + 1, "0");
  return Number(`${s.slice(0, s.length - decimals)}.${s.slice(s.length - decimals)}`);
}

// "3.9112", "0.0041235", "12345.67": about five significant digits, never more places than the token has
export function numText(n: number, maxPlaces = 18): string {
  if (!(n > 0) || !Number.isFinite(n)) return "0";
  const places = Math.min(maxPlaces, Math.max(2, 5 - Math.floor(Math.log10(n)) - 1));
  return n.toFixed(places).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}
export const nearAmount = (v: string | null | undefined, decimals: number): string => numText(whole(v, decimals), decimals);
export const nearText = (v: string | null | undefined, t: { symbol: string; decimals: number }) => `${nearAmount(v, t.decimals)} ${t.symbol}`;

// a part of a base-unit amount, rounded down (min_out) or up (max_in), as base units
export function shade(v: string, bps: number, up = false): string {
  const n = BigInt(v);
  const d = 10_000n;
  return (up ? (n * (d + BigInt(bps)) + d - 1n) / d : (n * (d - BigInt(bps))) / d).toString();
}

// "about 35 min", "about 2 hours"
export function aboutTime(s: number): string {
  if (s < 90) return "about a minute";
  if (s < 5400) return `about ${Math.round(s / 300) * 5 || Math.round(s / 60)} min`;
  return `about ${Math.round(s / 3600)} hours`;
}

// ------------------------------------------------------------------------------------------------
// the NEAR asset on the card: ?near=<assetId> in the URL, else what this browser remembers

const KEY = "ferry.near";
export function storedNear(): string | null {
  const q = new URLSearchParams(window.location.search).get("near");
  if (q) return q;
  try {
    return window.localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
}
export function storeNear(asset: string | null) {
  try {
    window.localStorage.setItem(KEY, asset ?? "");
  } catch {
    /* private window: the choice lasts this page */
  }
}

// ------------------------------------------------------------------------------------------------
// quotes

export interface Quoted {
  quote: NearQuote | null;
  error: string | null;
  // the error is about the address typed
  field: string | null;
  loading: boolean;
  refresh: () => void;
}

// The card's quote: `zat` of ZEC sold (or bought) for `asset`, through the best route here, with
// the address checked by NEAR Intents once one is given. Debounced, and kept fresh every 20 s.
export function useNearQuote(dir: Direction, zat: number, asset: string | null, address: string | null = null): Quoted {
  const [got, setGot] = useState<{ key: string; quote: NearQuote | null; error: string | null; field: string | null }>({ key: "", quote: null, error: null, field: null });
  const [nonce, setNonce] = useState(0);
  const key = `${dir}|${zat}|${asset}|${address ?? ""}`;
  useEffect(() => {
    if (!asset || zat <= 0) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const quote = await getNearQuote({ direction: dir, zec_zat: zat, asset, exact: true, ...(address ? { address } : {}) });
        if (alive) setGot({ key, quote, error: null, field: null });
      } catch (e) {
        if (alive) setGot({ key, quote: null, error: (e as Error).message, field: e instanceof NearError ? e.field : null });
      }
      if (alive) timer = setTimeout(load, 20_000);
    };
    timer = setTimeout(load, address ? 500 : 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key, nonce]);
  const mine = got.key === key;
  return { quote: mine ? got.quote : null, error: mine ? got.error : null, field: mine ? got.field : null, loading: !mine && !!asset && zat > 0, refresh: () => setNonce((n) => n + 1) };
}

export interface HopQuoted {
  hop: NearHop | null;
  error: string | null;
  field: string | null;
  loading: boolean;
  refresh: () => void;
}

// NEAR Intents' part of a private swap (POST /api/near/hop): `amount` of coin `pair` into `asset`
// ("out"), or of `asset` into `pair` ("in"). Debounced, kept fresh every 20 s.
export function useHop(side: "in" | "out", pair: PairId | null, asset: string | null, amount: string | null, address: string | null = null): HopQuoted {
  const [got, setGot] = useState<{ key: string; hop: NearHop | null; error: string | null; field: string | null }>({ key: "", hop: null, error: null, field: null });
  const [nonce, setNonce] = useState(0);
  const on = !!pair && !!asset && !!amount && /^[1-9]\d*$/.test(amount);
  const key = `${side}|${pair}|${asset}|${amount}|${address ?? ""}`;
  useEffect(() => {
    if (!on) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const hop = await getNearHop({ side, pair: pair!, asset: asset!, amount: amount!, exact: true, ...(address ? { address } : {}) });
        if (alive) setGot({ key, hop, error: null, field: null });
      } catch (e) {
        if (alive) setGot({ key, hop: null, error: (e as Error).message, field: e instanceof NearError ? e.field : null });
      }
      if (alive) timer = setTimeout(load, 20_000);
    };
    timer = setTimeout(load, address ? 500 : 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);
  const mine = got.key === key;
  return { hop: mine ? got.hop : null, error: mine ? got.error : null, field: mine ? got.field : null, loading: on && !mine, refresh: () => setNonce((n) => n + 1) };
}

// NEAR Intents alone (the opt-out from a private swap): sending `amount` of `from`, for `to`, with
// the person's addresses checked once given. Debounced, kept fresh every 20 s.
export function useDirect(from: string | null, to: string | null, amount: string | null, address: string | null = null, refund: string | null = null): HopQuoted {
  const [got, setGot] = useState<{ key: string; hop: NearHop | null; error: string | null; field: string | null }>({ key: "", hop: null, error: null, field: null });
  const [nonce, setNonce] = useState(0);
  const on = !!from && !!to && !!amount && /^[1-9]\d*$/.test(amount);
  const key = `${from}|${to}|${amount}|${address ?? ""}|${refund ?? ""}`;
  useEffect(() => {
    if (!on) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const hop = await getNearHop({ side: "direct", asset_in: from!, asset_out: to!, amount: amount!, exact: true, ...(address ? { address } : {}), ...(refund ? { refund } : {}) });
        if (alive) setGot({ key, hop, error: null, field: null });
      } catch (e) {
        if (alive) setGot({ key, hop: null, error: (e as Error).message, field: e instanceof NearError ? e.field : null });
      }
      if (alive) timer = setTimeout(load, 20_000);
    };
    timer = setTimeout(load, address || refund ? 500 : 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);
  const mine = got.key === key;
  return { hop: mine ? got.hop : null, error: mine ? got.error : null, field: mine ? got.field : null, loading: on && !mine, refresh: () => setNonce((n) => n + 1) };
}

// A picker row's quote, asked once the row is on screen: a rounded amount, the server's best route,
// at most three at a time, each kept 30 s.
const rows = new Map<string, { at: number; quote: NearQuote | null; error: string | null; pending: Promise<void> | null }>();
const waiting: (() => void)[] = [];
let inFlight = 0;
function slot(): Promise<void> {
  if (inFlight < 3) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise((ok) => waiting.push(ok));
}
function release() {
  const next = waiting.shift();
  if (next) next();
  else inFlight--;
}

export function useRowQuote(dir: Direction, zat: number, asset: string): { ref: (el: HTMLElement | null) => void; quote: NearQuote | null; error: string | null } {
  const key = `${dir}|${zat}|${asset}`;
  const [, render] = useState(0);
  const [seen, setSeen] = useState(false);
  const observer = useRef<IntersectionObserver | null>(null);
  const ref = (el: HTMLElement | null) => {
    observer.current?.disconnect();
    if (!el || typeof IntersectionObserver === "undefined") return;
    observer.current = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setSeen(true);
        observer.current?.disconnect();
      }
    });
    observer.current.observe(el);
  };
  useEffect(() => () => observer.current?.disconnect(), []);
  useEffect(() => {
    if (!seen || zat <= 0) return;
    const c = rows.get(key);
    if (c && (c.pending || Date.now() - c.at < 30_000)) {
      c.pending?.then(() => render((n) => n + 1));
      return;
    }
    const entry = { at: Date.now(), quote: null as NearQuote | null, error: null as string | null, pending: null as Promise<void> | null };
    entry.pending = slot()
      .then(() => getNearQuote({ direction: dir, zec_zat: zat, asset }))
      .then(
        (q) => void (entry.quote = q),
        (e) => void (entry.error = (e as Error).message),
      )
      .finally(() => {
        release();
        entry.pending = null;
        entry.at = Date.now();
        render((n) => n + 1);
      });
    rows.set(key, entry);
  }, [seen, key, zat, dir, asset]);
  const c = rows.get(key);
  return { ref, quote: c && !c.pending ? c.quote : null, error: c && !c.pending ? c.error : null };
}

// ------------------------------------------------------------------------------------------------
// a NEAR swap in plain words

export function nearWord(j: NearJob): { label: string; tone: Tone } {
  if (isActive(j)) return j.state === "holding" ? { label: "Holding coins", tone: "warn" } : j.state === "deposit" ? { label: "Waiting for you", tone: "live" } : { label: "In progress", tone: "live" };
  if (j.state === "done") return { label: "Done", tone: "good" };
  if (j.state === "expired") return { label: "Didn't start", tone: "neutral" };
  if (j.outcome === "punished") return { label: "Expired", tone: "bad" };
  return { label: j.state === "refunded" ? "Refunded" : "Cancelled", tone: "neutral" };
}

const zecText = (zat: number) => `${(zat / 1e8).toFixed(4).replace(/0{1,2}$/, "")} ZEC`;
export const jobZec = (j: NearJob) => zecText(j.ferry.zec_zat ?? j.zec_zat);

// what the person gets, as it stands: delivered, or promised at least
export function jobOut(j: NearJob): string {
  if (j.kind === "sell") {
    const got = j.state === "done" ? j.near.details?.amount_out : null;
    return got ? nearText(got, j.asset) : `${nearText(j.near.min_amount_out, j.asset)}`;
  }
  return jobZec(j);
}
export const jobIn = (j: NearJob) => (j.kind === "sell" ? jobZec(j) : nearText(j.near.amount_in, j.asset));

// One line for a banner or a list row.
export function nearSummary(j: NearJob): string {
  const a = j.asset.symbol;
  const c = j.via_asset.symbol;
  switch (j.state) {
    case "deposit":
      return `Send ${nearText(j.near.amount_in, j.asset)} to start`;
    case "near":
      return j.kind === "sell" ? `NEAR Intents is sending your ${a}` : `NEAR Intents is swapping your ${a} for ${c}`;
    case "funding":
      return `Your ${c} arrived. Buying ZEC next`;
    case "ferry":
      return j.kind === "sell" ? `Ferry is selling your ZEC for ${c}` : `Ferry is buying your ZEC with ${c}`;
    case "holding":
      return `Your ${c} is in your Ferry node. Buy ZEC now, or keep it`;
    case "done":
      return j.kind === "sell" ? `You received ${jobOut(j)}` : `You received ${jobZec(j)}, shielded`;
    case "refunded":
      return j.kind === "sell" ? `NEAR Intents refunded the ${c} to your Ferry node` : `NEAR Intents refunded your ${a}`;
    case "expired":
      return "No deposit arrived. Nothing moved";
    default:
      return j.outcome === "punished" ? "The deadline passed while your Ferry node was offline" : "Your ZEC is back in your shielded wallet";
  }
}

// ------------------------------------------------------------------------------------------------
// a private swap with NEAR Intents at an end, in plain words

const TICKERS: Record<string, string> = { btc: "BTC", ltc: "LTC", usdc: "USDC", weth: "WETH" };
const pairTicker = (p: string | null) => (p ? (TICKERS[p.split("-")[0]] ?? p.toUpperCase()) : "");
// what goes in and what comes out, by name: the NEAR asset at a NEAR end, else the Ferry coin
export const comboIn = (j: ComboJob) => j.asset_in?.symbol ?? pairTicker(j.from);
export const comboOut = (j: ComboJob) => j.asset_out?.symbol ?? pairTicker(j.to);
// the Ferry coins NEAR Intents hands over (near-only has none: its ends)
export const comboMidIn = (j: ComboJob) => j.via_in?.symbol ?? (j.kind === "near-only" ? comboOut(j) : pairTicker(j.from));
export const comboMidOut = (j: ComboJob) => j.via_out?.symbol ?? (j.kind === "near-only" ? comboOut(j) : pairTicker(j.to));
// the opt-out: NEAR Intents alone, public
export const isAlone = (j: ComboJob) => j.kind === "near-only";

export function comboWord(j: ComboJob): { label: string; tone: Tone } {
  if (j.state === "holding") return { label: j.route.id ? "Holding ZEC" : "Holding coins", tone: "warn" };
  if (j.state === "deposit") return { label: "Waiting for you", tone: "live" };
  if (isActive(j)) return { label: "In progress", tone: "live" };
  if (j.state === "done") return { label: "Done", tone: "good" };
  if (j.state === "refunded") return { label: "Refunded", tone: "neutral" };
  if (j.outcome === "punished") return { label: "Expired", tone: "bad" };
  if (j.outcome === "route_refunded") return { label: "Cancelled", tone: "neutral" };
  return { label: "Didn't start", tone: "neutral" };
}

// what the person gets, as it stands: delivered, or promised at least
export function comboGot(j: ComboJob): string | null {
  const part = j.back ?? (isAlone(j) ? j.front : null);
  if (part) {
    const got = j.state === "done" ? part.details?.amount_out : null;
    return got && j.asset_out ? nearText(got, j.asset_out) : null;
  }
  return j.state === "done" && j.route.out != null ? `${numText(whole(String(j.route.out), j.via_out?.decimals ?? decimalsOf(j.to)))} ${pairTicker(j.to)}` : null;
}
const decimalsOf = (p: string | null) => (p?.startsWith("usdc") ? 6 : p?.startsWith("weth") ? 18 : 8);

export function comboSummary(j: ComboJob): string {
  const a = comboIn(j);
  const c = comboOut(j);
  switch (j.state) {
    case "deposit":
      return j.front && j.asset_in ? `Send ${nearText(j.front.amount_in, j.asset_in)} to start` : "Waiting for your deposit";
    case "near_in":
      return isAlone(j) ? `NEAR Intents is swapping your ${a} for ${c}` : `NEAR Intents is swapping your ${a} for ${comboMidIn(j)}`;
    case "funding":
      return `Your ${comboMidIn(j)} arrived. Starting the private swap`;
    case "route":
      return j.route.state === "leg1" ? `Swap 1 of 2: buying shielded ZEC with ${comboMidIn(j)}` : j.route.state === "leg2" ? `Swap 2 of 2: selling the ZEC for ${comboMidOut(j)}` : "Your ZEC rests, shielded, between the two swaps";
    case "holding":
      return j.route.id ? "You hold shielded ZEC. Finish the swap, or keep it" : `Your ${comboMidIn(j)} is in your Ferry node. Swap now, or keep it`;
    case "near_out":
      return `NEAR Intents is sending your ${c}`;
    case "done":
      return `You received ${comboGot(j) ?? c}`;
    case "refunded":
      return j.back && (j.back.status === "REFUNDED" || j.back.status === "FAILED") ? `NEAR Intents refunded the ${comboMidOut(j)} to your Ferry node` : `NEAR Intents refunded your ${a}`;
    case "expired":
      return "No deposit arrived. Nothing moved";
    default:
      return j.outcome === "route_refunded" ? `Your ${comboMidIn(j)} is back in your Ferry node` : j.outcome === "punished" ? "The deadline passed while your Ferry node was offline" : "The private swap didn't start. Nothing moved";
  }
}
