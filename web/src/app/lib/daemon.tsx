import { createContext, useContext, useMemo, type ReactNode } from "react";
import { LOCAL_ROLE, type Role, type Status, type SwapView } from "@/api";
import { useDaemon, type Daemon } from "@/useDaemon";
import { useBlockTimes, type BlockTimes } from "@/swap/timing";
import { noteRunning } from "./walletSync";

// One connection to this party's ferryd (fetch + SSE), shared by every page of the app.

interface LocalDaemon extends Daemon {
  role: Role;
  bt: BlockTimes;
  // newest first
  list: SwapView[];
}

const Ctx = createContext<LocalDaemon | null>(null);

export function DaemonProvider({ children }: { children: ReactNode }) {
  const d = useDaemon(LOCAL_ROLE);
  const bt = useBlockTimes(d.status);
  const list = useMemo(() => {
    const all = Object.values(d.swaps);
    all.sort((x, y) => (y.timeline[0]?.at ?? "").localeCompare(x.timeline[0]?.at ?? ""));
    return all;
  }, [d.swaps]);
  noteRunning(list, d.status);
  return <Ctx.Provider value={{ ...d, role: LOCAL_ROLE, bt, list }}>{children}</Ctx.Provider>;
}

export function useLocal(): LocalDaemon {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLocal outside DaemonProvider");
  return v;
}

export type { Status, SwapView };
