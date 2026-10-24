import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { LOCAL_ROLE, pairDaemon, type PairId, type Role, type Status, type SwapView } from "@/api";
import { coin, setCoinFrom } from "@/format";
import { useDaemon, type Daemon } from "@/useDaemon";
import { useBlockTimes, type BlockTimes } from "@/swap/timing";
import { MAIN, storePair, storedPair, usePairs, type Pair } from "./pairs";
import { noteRunning } from "./walletSync";

// One connection to this party's ferryd (fetch + SSE), shared by every page of the app. With a
// daemon per pair behind the UI server, it follows the pair the viewer picked.

interface LocalDaemon extends Daemon {
  role: Role;
  bt: BlockTimes;
  // newest first
  list: SwapView[];
  // the base path of the daemon followed, for calls like startSwap
  daemon: string;
  pairs: Pair[];
  // the pair on screen: the followed daemon's coin, or the one picked while it connects
  pair: PairId;
  choosePair: (id: PairId) => void;
}

const Ctx = createContext<LocalDaemon | null>(null);

export function DaemonProvider({ children }: { children: ReactNode }) {
  const pairs = usePairs();
  const [chosen, setChosen] = useState<PairId | null>(storedPair);
  // a picked pair with its own daemon, else the main one; nothing until the server said which
  // pairs it has, so a remembered pair doesn't connect to the main daemon first
  const daemon = chosen && pairs.extra.includes(chosen) ? pairDaemon(chosen) : MAIN;
  const d = useDaemon(pairs.ready ? daemon : null);
  const bt = useBlockTimes(d.status);
  const list = useMemo(() => {
    const all = Object.values(d.swaps);
    all.sort((x, y) => (y.timeline[0]?.at ?? "").localeCompare(x.timeline[0]?.at ?? ""));
    return all;
  }, [d.swaps]);
  noteRunning(list, d.status);

  const choosePair = (id: PairId) => {
    const p = pairs.list.find((x) => x.id === id);
    if (!p?.daemon) return;
    storePair(id);
    // the page re-renders in the new coin right away, before the daemon's first status
    setCoinFrom(p.status ?? ({ chains: { btc: { coin: id } } } as Partial<Status>));
    setChosen(id);
  };
  const pair: PairId = d.status ? coin().id : (chosen ?? "btc");

  return <Ctx.Provider value={{ ...d, role: LOCAL_ROLE, bt, list, daemon, pairs: pairs.list, pair, choosePair }}>{children}</Ctx.Provider>;
}

export function useLocal(): LocalDaemon {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLocal outside DaemonProvider");
  return v;
}

export type { Status, SwapView };
