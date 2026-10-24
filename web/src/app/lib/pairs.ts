import { useEffect, useState } from "react";
import {
  DAEMONS,
  LOCAL_ROLE,
  PAIR_IDS,
  directionOf,
  getPairs,
  getStatus,
  pairBuyDaemon,
  pairChain,
  pairCoin,
  pairDaemon,
  pairId,
  type CoinId,
  type Direction,
  type PairId,
  type PairsInfo,
  type Status,
} from "@/api";
import { CHAIN_NAMES, chainOfNetwork } from "@/format";

// The pairs this UI can swap, each in the directions it can: selling ZEC through one of the
// user's Z daemons, buying it through one of their B daemons. The main Z and B daemons swap
// whatever pair they run; the UI server may front another daemon per pair and direction
// (GET /api/pairs). Each is probed now and then for its status, so the token picker can show
// which pairs are up and at what rate.

const PROBE_MS = 20_000;

// One side of a pair: the daemon's base path (null: nothing on this server swaps this pair this
// way) and its last status (null while unknown or unreachable).
export interface Side {
  daemon: string | null;
  status: Status | null;
}

export interface Pair {
  id: PairId;
  sell: Side;
  buy: Side;
}

export interface Pairs {
  // GET /api/pairs has answered (an older server: its own side of the main pair only)
  ready: boolean;
  info: PairsInfo;
  list: Pair[];
}

const NONE: PairsInfo = { sell: [], buy: [], main: { sell: false, buy: false } };

// the pair a daemon's status describes; an EVM daemon on a local chain counts as Base
export function pairOf(s: Status | null): PairId | null {
  if (!s) return null;
  const raw = (s.chains.btc.ticker ?? s.chains.btc.coin ?? "btc").toLowerCase();
  const coin: CoinId = raw === "ltc" || raw === "usdc" || raw === "weth" ? raw : "btc";
  return pairId(coin, chainOfNetwork(s.chains.btc.network));
}

// The daemon that swaps `id` in direction `dir`: its own one, else the main daemon of that side
// (whatever pair it runs: the page learns which from its status). Null: this direction can't be
// swapped here at all.
export function daemonFor(info: PairsInfo, id: PairId | null, dir: Direction): string | null {
  if (dir === "sell") return id && info.sell.includes(id) ? pairDaemon(id) : info.main.sell ? DAEMONS.Z : null;
  return id && info.buy.includes(id) ? pairBuyDaemon(id) : info.main.buy ? DAEMONS.B : null;
}

// whether anything here swaps this way
export const canSwap = (info: PairsInfo, dir: Direction) => (dir === "sell" ? info.main.sell || info.sell.length > 0 : info.main.buy || info.buy.length > 0);

export function usePairs(): Pairs {
  const [info, setInfo] = useState<PairsInfo | null>(null);
  const [probes, setProbes] = useState<Record<string, Status | null>>({});

  useEffect(() => {
    let alive = true;
    getPairs()
      .catch(() => NONE)
      .then((v) => alive && setInfo(v));
    return () => {
      alive = false;
    };
  }, []);

  const bases = info
    ? [
        ...(info.main.sell ? [DAEMONS.Z] : []),
        ...(info.main.buy ? [DAEMONS.B] : []),
        ...info.sell.map(pairDaemon),
        ...info.buy.map(pairBuyDaemon),
      ]
    : [];
  const key = bases.join(",");
  useEffect(() => {
    if (!bases.length) return;
    let alive = true;
    const probe = async () => {
      const got = await Promise.all(bases.map((b) => getStatus(b).catch(() => null)));
      if (alive) setProbes(Object.fromEntries(bases.map((b, i) => [b, got[i]])));
    };
    probe();
    const id = setInterval(probe, PROBE_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const i = info ?? NONE;
  const mainZ = probes[DAEMONS.Z] ?? null;
  const mainB = probes[DAEMONS.B] ?? null;
  const side = (id: PairId, own: boolean, base: string, main: boolean, mainBase: string, mainStatus: Status | null): Side => {
    if (own) return { daemon: base, status: probes[base] ?? null };
    if (main && pairOf(mainStatus) === id) return { daemon: mainBase, status: mainStatus };
    return { daemon: null, status: null };
  };
  const list = PAIR_IDS.map(
    (id): Pair => ({
      id,
      sell: side(id, i.sell.includes(id), pairDaemon(id), i.main.sell, DAEMONS.Z, mainZ),
      buy: side(id, i.buy.includes(id), pairBuyDaemon(id), i.main.buy, DAEMONS.B, mainB),
    }),
  );
  return { ready: info !== null, info: i, list };
}

// How a pair is named to people. title: the picker row ("Bitcoin · BTC", "USDC on Base",
// "ETH on Base (WETH)"); ticker: what amounts are in; label/sub: the coin button's two lines;
// noun: in a sentence ("Swap ZEC for Bitcoin").
export interface PairName {
  title: string;
  ticker: string;
  label: string;
  sub: string;
  noun: string;
}

export function pairName(id: PairId): PairName {
  const c = pairCoin(id);
  const chain = pairChain(id);
  const on = chain ? CHAIN_NAMES[chain] : "Base";
  if (c === "btc") return { title: "Bitcoin · BTC", ticker: "BTC", label: "BTC", sub: "Bitcoin", noun: "Bitcoin" };
  if (c === "ltc") return { title: "Litecoin · LTC", ticker: "LTC", label: "LTC", sub: "Litecoin", noun: "Litecoin" };
  if (c === "usdc") return { title: `USDC on ${on}`, ticker: "USDC", label: "USDC", sub: `on ${on}`, noun: `USDC on ${on}` };
  return { title: `ETH on ${on} (WETH)`, ticker: "WETH", label: "WETH", sub: `ETH on ${on}`, noun: `ETH on ${on}` };
}

// The pair and direction the viewer last picked: ?pair= / ?dir= in the URL, else what this
// browser remembers.
const KEY = "ferry.pair";
const DIR_KEY = "ferry.direction";
const isPair = (v: string | null): v is PairId => !!v && (PAIR_IDS as string[]).includes(v);
const isDir = (v: string | null): v is Direction => v === "sell" || v === "buy";

function remembered(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private window: the choice lasts this page */
  }
}

export function storedPair(): PairId | null {
  const q = new URLSearchParams(window.location.search).get("pair");
  if (isPair(q)) return q;
  const v = remembered(KEY);
  return isPair(v) ? v : null;
}

export const storePair = (id: PairId) => remember(KEY, id);

// ?dir=buy, ?as=b (the B party's page) or the last flip; else the side the server starts on
export function storedDirection(): Direction {
  const params = new URLSearchParams(window.location.search);
  const q = params.get("dir");
  if (isDir(q)) return q;
  if (params.get("as")) return directionOf(LOCAL_ROLE);
  const v = remembered(DIR_KEY);
  return isDir(v) ? v : directionOf(LOCAL_ROLE);
}

export const storeDirection = (dir: Direction) => remember(DIR_KEY, dir);
