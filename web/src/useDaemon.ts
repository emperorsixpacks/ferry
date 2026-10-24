import { useEffect, useState } from "react";
import { DAEMONS, getStatus, getSwaps, type Role, type Status, type SwapView } from "./api";

export interface Daemon {
  connected: boolean;
  status: Status | null;
  swaps: Record<string, SwapView>;
}

// Follows one ferryd: an initial fetch, then the SSE stream. EventSource reconnects on its own,
// and every reconnect refetches so nothing is missed while the daemon was away.
export function useDaemon(role: Role): Daemon {
  const [state, setState] = useState<Daemon>({ connected: false, status: null, swaps: {} });

  useEffect(() => {
    let alive = true;
    const es = new EventSource(DAEMONS[role] + "/api/events");

    const refresh = async () => {
      try {
        const [status, list] = await Promise.all([getStatus(role), getSwaps(role)]);
        if (!alive) return;
        setState((s) => ({ ...s, status, swaps: { ...s.swaps, ...Object.fromEntries(list.map((x) => [x.id, x])) } }));
      } catch {
        /* the stream's error handler marks the daemon offline */
      }
    };

    es.onopen = () => {
      setState((s) => ({ ...s, connected: true }));
      refresh();
    };
    es.onerror = () => setState((s) => ({ ...s, connected: false }));
    es.addEventListener("status", (e) => {
      const status = JSON.parse((e as MessageEvent).data) as Status;
      setState((s) => ({ ...s, status }));
    });
    es.addEventListener("swap", (e) => {
      const swap = JSON.parse((e as MessageEvent).data) as SwapView;
      setState((s) => ({ ...s, swaps: { ...s.swaps, [swap.id]: swap } }));
    });

    return () => {
      alive = false;
      es.close();
    };
  }, [role]);

  return state;
}

// The swap to show: the most recently started one either daemon knows about.
export function currentSwapId(z: Daemon, b: Daemon): string | null {
  const started = (s: SwapView) => s.timeline[0]?.at ?? "";
  const all = [...Object.values(z.swaps), ...Object.values(b.swaps)];
  all.sort((x, y) => started(x).localeCompare(started(y)));
  return all.at(-1)?.id ?? null;
}
