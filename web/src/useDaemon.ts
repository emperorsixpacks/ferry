import { useEffect, useState } from "react";
import { DAEMONS, getStatus, getSwaps, type Role, type Status, type SwapView } from "./api";
import { setCoinFrom } from "./format";

export interface Daemon {
  connected: boolean;
  // why the daemon is unreachable, in the daemon's or proxy's words (e.g. a rejected API token)
  error: string | null;
  status: Status | null;
  swaps: Record<string, SwapView>;
}

const RETRY_MS = 2000;

// Follows one ferryd: a fetch, then the SSE stream. EventSource only retries network errors and
// gives up for good on an HTTP error (a 401, or the proxy's 502 while the daemon restarts), so the
// stream is reopened by hand. Every (re)connect refetches so nothing is missed while it was away.
export function useDaemon(role: Role): Daemon {
  const [state, setState] = useState<Daemon>({ connected: false, error: null, status: null, swaps: {} });

  useEffect(() => {
    let alive = true;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const refresh = async () => {
      try {
        const [status, list] = await Promise.all([getStatus(role), getSwaps(role)]);
        if (!alive) return;
        setCoinFrom(status);
        setState((s) => ({ ...s, error: null, status, swaps: { ...s.swaps, ...Object.fromEntries(list.map((x) => [x.id, x])) } }));
      } catch (e) {
        if (alive) setState((s) => ({ ...s, connected: false, error: (e as Error).message }));
      }
    };

    const open = () => {
      es = new EventSource(DAEMONS[role] + "/api/events");
      es.onopen = () => {
        setState((s) => ({ ...s, connected: true }));
        refresh();
      };
      es.onerror = () => {
        setState((s) => ({ ...s, connected: false }));
        if (es?.readyState === EventSource.CLOSED) {
          es.close();
          refresh(); // records the reason, e.g. the daemon's 401 message
          retry = setTimeout(() => alive && open(), RETRY_MS);
        }
      };
      es.addEventListener("status", (e) => {
        const status = JSON.parse((e as MessageEvent).data) as Status;
        setCoinFrom(status);
        setState((s) => ({ ...s, status }));
      });
      es.addEventListener("swap", (e) => {
        const swap = JSON.parse((e as MessageEvent).data) as SwapView;
        setState((s) => ({ ...s, swaps: { ...s.swaps, [swap.id]: swap } }));
      });
    };
    open();

    return () => {
      alive = false;
      clearTimeout(retry);
      es?.close();
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
