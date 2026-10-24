import { useEffect, useState } from "react";
import { DAEMONS, LOCAL_ROLE, PAIR_IDS, getPairs, getStatus, pairDaemon, pairId, type CoinId, type PairId, type Status } from "@/api";
import { chainOfNetwork } from "@/format";

// The pairs this UI can swap: the main daemon's (whatever coin it runs) and one per extra daemon
// the UI server fronts (GET /api/pairs). Each is probed now and then for its offer, so the pair
// toggle can show which ones are up and at what rate.

const PROBE_MS = 20_000;

export interface Pair {
  id: PairId;
  // the daemon's base path; null: nothing on this server swaps this pair
  daemon: string | null;
  // its last status (offer, network); null while unknown or unreachable
  status: Status | null;
}

export interface Pairs {
  // GET /api/pairs has answered (an older server: no extra pairs)
  ready: boolean;
  extra: PairId[];
  list: Pair[];
}

export const MAIN = DAEMONS[LOCAL_ROLE];
// the pair a daemon's status describes; an EVM daemon on a local chain counts as Base
export function pairOf(s: Status | null): PairId | null {
  if (!s) return null;
  const raw = (s.chains.btc.ticker ?? s.chains.btc.coin ?? "btc").toLowerCase();
  const coin: CoinId = raw === "ltc" || raw === "usdc" || raw === "weth" ? raw : "btc";
  return pairId(coin, chainOfNetwork(s.chains.btc.network));
}

export function usePairs(): Pairs {
  const [extra, setExtra] = useState<PairId[] | null>(null);
  const [probes, setProbes] = useState<Record<string, Status | null>>({});

  useEffect(() => {
    let alive = true;
    getPairs()
      .catch(() => [])
      .then((ids) => alive && setExtra(ids));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!extra) return;
    let alive = true;
    const bases = [MAIN, ...extra.map(pairDaemon)];
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
  }, [extra]);

  const main = probes[MAIN] ?? null;
  const list = PAIR_IDS.map((id): Pair => {
    if (extra?.includes(id)) return { id, daemon: pairDaemon(id), status: probes[pairDaemon(id)] ?? null };
    if (pairOf(main) === id) return { id, daemon: MAIN, status: main };
    return { id, daemon: null, status: null };
  });
  return { ready: extra !== null, extra: extra ?? [], list };
}

// The pair the viewer last picked: ?pair= in the URL, else what this browser remembers.
const KEY = "ferry.pair";
const isPair = (v: string | null): v is PairId => !!v && (PAIR_IDS as string[]).includes(v);

export function storedPair(): PairId | null {
  const q = new URLSearchParams(window.location.search).get("pair");
  if (isPair(q)) return q;
  try {
    const v = window.localStorage.getItem(KEY);
    return isPair(v) ? v : null;
  } catch {
    return null;
  }
}

export function storePair(id: PairId) {
  try {
    window.localStorage.setItem(KEY, id);
  } catch {
    /* private window: the choice lasts this page */
  }
}
