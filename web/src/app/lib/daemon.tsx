import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getSwaps, isMine, pairChain, pairCoin, roleOf, type Direction, type PairId, type PairsInfo, type Role, type Status, type SwapView } from "@/api";
import { setChainHint, setCoinFrom } from "@/format";
import { useDaemon, type Daemon } from "@/useDaemon";
import { useBlockTimes, type BlockTimes } from "@/swap/timing";
import { canSwap, daemonFor, pairOf, storeDirection, storePair, storedDirection, storedPair, usePairs, type Pair } from "./pairs";
import { noteRunning } from "./walletSync";

// One connection to the person's ferryd for the pair and direction on screen (fetch + SSE),
// shared by every page of the app: their Z daemon while they sell ZEC, their B daemon while they
// buy it. The other direction's daemon for the same pair is polled, so a swap running there still
// shows (and blocks a second one) after a flip.

interface LocalDaemon extends Daemon {
  // the side the followed daemon swaps: Z sells ZEC, B buys it
  role: Role;
  dir: Direction;
  bt: BlockTimes;
  // the person's own swaps on this pair, both directions, newest first (not the ones a daemon of
  // theirs made as a maker)
  list: SwapView[];
  // the base path of the daemon followed, for calls like startSwap; null: nothing swaps this way
  daemon: string | null;
  pairs: Pair[];
  info: PairsInfo;
  // the server said which daemons it has, and each was asked which pair it swaps
  known: boolean;
  // the pair on screen: the followed daemon's coin, or the one picked while it connects
  pair: PairId;
  choosePair: (id: PairId, on?: Direction) => void;
  chooseDirection: (dir: Direction) => void;
  // whether anything here swaps the other way
  canFlip: boolean;
}

const Ctx = createContext<LocalDaemon | null>(null);
const POLL_MS = 10_000;
const flip = (d: Direction): Direction => (d === "sell" ? "buy" : "sell");

// The swaps of a daemon this page doesn't follow, polled.
function usePolledSwaps(base: string | null): SwapView[] {
  const [list, setList] = useState<SwapView[]>([]);
  useEffect(() => {
    setList([]);
    if (!base) return;
    let alive = true;
    const load = () => getSwaps(base).then((l) => alive && setList(l), () => {});
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [base]);
  return list;
}

export function DaemonProvider({ children }: { children: ReactNode }) {
  const pairs = usePairs();
  const [chosen, setChosen] = useState<PairId | null>(storedPair);
  const [wanted, setWanted] = useState<Direction>(storedDirection);
  // a direction nothing here swaps gives way to the other one
  const dir = pairs.ready && !canSwap(pairs.info, wanted) && canSwap(pairs.info, flip(wanted)) ? flip(wanted) : wanted;
  // a picked pair with its own daemon this way, else the main one; nothing until the server said
  // which daemons it has, so a remembered pair doesn't connect to the main daemon first
  const own = chosen && (dir === "sell" ? pairs.info.sell : pairs.info.buy).includes(chosen) ? chosen : null;
  const daemon = pairs.ready ? daemonFor(pairs.info, chosen, dir) : null;
  // a pair's own daemon on a local chain stands in for the pair's chain (the main one: Base)
  setChainHint(own ? pairChain(own) : null);
  const seed = pairs.list.find((p) => p[dir].daemon === daemon)?.[dir].status ?? null;
  const d = useDaemon(daemon, seed);
  const bt = useBlockTimes(d.status);
  const pair: PairId = own ?? pairOf(d.status) ?? chosen ?? "btc";
  const otherDaemon = pairs.list.find((p) => p.id === pair)?.[flip(dir)].daemon ?? null;
  const others = usePolledSwaps(otherDaemon === daemon ? null : otherDaemon);

  // by id, the followed daemon's (live) view first; the list keeps the person's own swaps. When
  // both of a swap's sides are daemons here (a node trading between its own Z and B, or a demo whose
  // Z is also the maker visitors buy from), each holds the same id: the person's own side (the
  // taker's) wins, so a page never shows the maker's copy of their swap.
  const swaps = useMemo(() => {
    const byId: Record<string, SwapView> = Object.fromEntries(others.map((s) => [s.id, s]));
    for (const [id, s] of Object.entries(d.swaps)) if (!byId[id] || isMine(s) || !isMine(byId[id])) byId[id] = s;
    return byId;
  }, [others, d.swaps]);
  const list = useMemo(() => {
    const byId = new Map<string, SwapView>();
    for (const s of [...Object.values(d.swaps), ...others]) if (isMine(s) && !byId.has(s.id)) byId.set(s.id, s);
    const all = [...byId.values()];
    all.sort((x, y) => (y.timeline[0]?.at ?? "").localeCompare(x.timeline[0]?.at ?? ""));
    return all;
  }, [d.swaps, others]);
  noteRunning(Object.values(d.swaps), d.status);

  // `on`: the direction it's picked for (Activity opens a swap of the other side)
  const choosePair = (id: PairId, on: Direction = dir) => {
    const p = pairs.list.find((x) => x.id === id);
    if (!p?.[on].daemon) return;
    storePair(id);
    // the page re-renders in the new coin right away, before the daemon's first status
    setChainHint((on === "sell" ? pairs.info.sell : pairs.info.buy).includes(id) ? pairChain(id) : null);
    setCoinFrom(p[on].status ?? { chains: { btc: { coin: pairCoin(id) } } });
    setChosen(id);
  };
  // The pair stays when it can be swapped the new way too; otherwise the page shows the pair of
  // that side's main daemon, and the pick comes back with the next flip.
  const chooseDirection = (next: Direction) => {
    if (pairs.ready && !canSwap(pairs.info, next)) return;
    storeDirection(next);
    setWanted(next);
  };

  const value: LocalDaemon = {
    ...d,
    swaps,
    role: roleOf(dir),
    dir,
    bt,
    list,
    daemon,
    pairs: pairs.list,
    info: pairs.info,
    known: pairs.probed,
    pair,
    choosePair,
    chooseDirection,
    canFlip: pairs.ready && canSwap(pairs.info, flip(dir)),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLocal(): LocalDaemon {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLocal outside DaemonProvider");
  return v;
}

export type { Status, SwapView };
