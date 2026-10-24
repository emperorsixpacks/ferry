import { useEffect, useState } from "react";
import { usePoll, useWaited } from "./poll";
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
//
// Each daemon is probed on its own (lib/poll), and nothing waits for all of them: a daemon that
// hangs is only that pair's problem. The page waits FIRST_WAIT_MS at most for the first answers it
// needs (the main daemons, whose pair only their status says), then shows what it has; a daemon
// still silent then is offline until it answers ("Partner offline" in the picker and on the card),
// and is asked again every RETRY_MS, so it comes back by itself.

const PROBE_MS = 20_000;
const RETRY_MS = 5_000;
const FIRST_WAIT_MS = 3_000;

// One side of a pair: the daemon's base path (null: nothing on this server swaps this pair this
// way), its last status (null while unknown or unreachable), and whether it answers: "waiting" for
// its first answer (within FIRST_WAIT_MS), "up", or "down" (it failed, or stayed silent).
export interface Side {
  daemon: string | null;
  status: Status | null;
  state: "waiting" | "up" | "down";
}

// the side's daemon isn't answering
export const isOffline = (s: Side | null | undefined) => !!s?.daemon && s.state === "down";

export interface Pair {
  id: PairId;
  sell: Side;
  buy: Side;
}

export interface Pairs {
  // GET /api/pairs has answered (an older server: its own side of the main pair only)
  ready: boolean;
  // ... and the main daemons have answered, failed, or been waited for long enough: which pairs
  // this server swaps is known (another pair's daemon is known from GET /api/pairs alone)
  probed: boolean;
  info: PairsInfo;
  list: Pair[];
  // whether a daemon (by base path) answers, as its probes say
  state: (daemon: string) => Side["state"];
}

const NONE: PairsInfo = { sell: [], buy: [], main: { sell: false, buy: false }, routes: null, own: false, funds: false };

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
  if (dir === "sell") return id && info.sell.includes(id) ? pairDaemon(id) : info.main.sell !== false ? DAEMONS.Z : null;
  return id && info.buy.includes(id) ? pairBuyDaemon(id) : info.main.buy !== false ? DAEMONS.B : null;
}

// whether anything here swaps this way
export const canSwap = (info: PairsInfo, dir: Direction): boolean =>
  dir === "sell" ? info.main.sell !== false || info.sell.length > 0 : info.main.buy !== false || info.buy.length > 0;

export function usePairs(): Pairs {
  const [info, setInfo] = useState<PairsInfo | null>(null);

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
        ...(info.main.sell !== false ? [DAEMONS.Z] : []),
        ...(info.main.buy !== false ? [DAEMONS.B] : []),
        ...info.sell.map(pairDaemon),
        ...info.buy.map(pairBuyDaemon),
      ]
    : [];
  const key = bases.join(",");
  const probes = usePoll(bases, getStatus, { every: PROBE_MS, retry: RETRY_MS });
  const waited = useWaited(key, FIRST_WAIT_MS);
  const stateOf = (b: string): Side["state"] => (b in probes.errors ? "down" : b in probes.data ? "up" : waited ? "down" : "waiting");
  const statusOf = (b: string): Status | null => (stateOf(b) === "up" ? probes.data[b] : null);

  // which pair a main daemon swaps, and whether an "auto" one is a maker: its last answer, kept while
  // it is down, so its pair stays on the page as offline rather than vanishing
  const mainZ = probes.data[DAEMONS.Z] ?? null;
  const mainB = probes.data[DAEMONS.B] ?? null;
  // "auto": a main daemon is one of the user's own unless its status says it is a maker (the
  // usual demo's B makes offers; the user can't buy ZEC through it)
  const resolve = (v: boolean | "auto", s: Status | null) => (v === "auto" ? s?.offer.maker !== true : v);
  const raw = info ?? NONE;
  const i: PairsInfo = { ...raw, main: { sell: resolve(raw.main.sell, mainZ), buy: resolve(raw.main.buy, mainB) } };
  const side = (id: PairId, own: boolean, base: string, main: boolean, mainBase: string, mainStatus: Status | null): Side => {
    if (own) return { daemon: base, status: statusOf(base), state: stateOf(base) };
    if (main && pairOf(mainStatus) === id) return { daemon: mainBase, status: statusOf(mainBase), state: stateOf(mainBase) };
    return { daemon: null, status: null, state: "down" };
  };
  const list = PAIR_IDS.map(
    (id): Pair => ({
      id,
      sell: side(id, i.sell.includes(id), pairDaemon(id), i.main.sell !== false, DAEMONS.Z, mainZ),
      buy: side(id, i.buy.includes(id), pairBuyDaemon(id), i.main.buy !== false, DAEMONS.B, mainB),
    }),
  );
  // the main daemons say which pairs they swap: the page waits for them (FIRST_WAIT_MS at most); the
  // other pairs' daemons are known from GET /api/pairs and fill in as they answer
  const mains = bases.filter((b) => b === DAEMONS.Z || b === DAEMONS.B);
  return { ready: info !== null, probed: info !== null && mains.every((b) => stateOf(b) !== "waiting"), info: i, list, state: stateOf };
}

// The pairs whose daemon is offline each way, and the ones not heard from yet, for the card's
// first coins (server/paths.mjs defaultPick) and the picker.
export function pairStates(list: Pair[]): { offline: { sell: PairId[]; buy: PairId[] }; waiting: { sell: PairId[]; buy: PairId[] } } {
  const ids = (dir: Direction, state: Side["state"]) => list.filter((p) => p[dir].daemon && p[dir].state === state).map((p) => p.id);
  return { offline: { sell: ids("sell", "down"), buy: ids("buy", "down") }, waiting: { sell: ids("sell", "waiting"), buy: ids("buy", "waiting") } };
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

// The private swap on the card (Sell one coin, Buy another), if the viewer picked one: ?from=&to=
// in the URL, else what this browser remembers. Whether the server can run it is the card's call.
const ROUTE_KEY = "ferry.route";
export function storedRoute(): { from: PairId; to: PairId } | null {
  const params = new URLSearchParams(window.location.search);
  const [from, to] = params.get("from") || params.get("to") ? [params.get("from"), params.get("to")] : (remembered(ROUTE_KEY) ?? "").split(">");
  return isPair(from) && isPair(to) ? { from, to } : null;
}
export const storeRoute = (r: { from: PairId; to: PairId } | null) => remember(ROUTE_KEY, r ? `${r.from}>${r.to}` : "");

// the privacy pause the viewer last chose for a private swap
const PAUSE_KEY = "ferry.pause";
export const storedPause = (): "off" | "standard" | "long" => {
  const v = remembered(PAUSE_KEY);
  return v === "off" || v === "long" ? v : "standard";
};
export const storePause = (p: string) => remember(PAUSE_KEY, p);
