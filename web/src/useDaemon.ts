import { useEffect, useState } from "react";
import { daemonUrl, getStatus, getSwaps, type Status, type SwapView } from "./api";
import { setCoinFrom } from "./format";

export interface Daemon {
  connected: boolean;
  // why the daemon is unreachable, in the daemon's or proxy's words (e.g. a rejected API token)
  error: string | null;
  status: Status | null;
  swaps: Record<string, SwapView>;
}

const RETRY_MS = 2000;
const EMPTY: Daemon = { connected: false, error: null, status: null, swaps: {} };

// Follows one ferryd: a fetch, then the SSE stream. EventSource only retries network errors and
// gives up for good on an HTTP error (a 401, or the proxy's 502 while the daemon restarts), so the
// stream is reopened by hand. Every (re)connect refetches so nothing is missed while it was away.
// `daemon` is the base path (DAEMONS[role], pairDaemon(id)); null waits. A new one starts clean,
// or from `seed`, a status of it seen elsewhere (the pair probes), so switching daemons doesn't
// flash "not connected".
export function useDaemon(daemon: string | null, seed: Status | null = null): Daemon {
  const [state, setState] = useState<Daemon>(EMPTY);

  useEffect(() => {
    setState(seed ? { ...EMPTY, status: seed } : EMPTY);
    if (seed) setCoinFrom(seed);
    if (!daemon) return;
    const base = daemon;
    let alive = true;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // one refresh at a time, and its two reads one after the other: a daemon that hangs (the UI server
    // answers for it after 10 s) never has more than one of them waiting
    let refreshing = false;

    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const status = await getStatus(base);
        const list = await getSwaps(base);
        if (!alive) return;
        setCoinFrom(status);
        setState((s) => ({ ...s, error: null, status, swaps: { ...s.swaps, ...Object.fromEntries(list.map((x) => [x.id, x])) } }));
      } catch (e) {
        if (alive) setState((s) => ({ ...s, connected: false, error: (e as Error).message }));
      } finally {
        refreshing = false;
      }
    };

    const open = () => {
      es = new EventSource(daemonUrl(base, "/api/events"));
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
    // the seed only matters when the daemon changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [daemon]);

  return state;
}

// The swap to show: the most recently started one either daemon knows about.
export function currentSwapId(z: Daemon, b: Daemon): string | null {
  const started = (s: SwapView) => s.timeline[0]?.at ?? "";
  const all = [...Object.values(z.swaps), ...Object.values(b.swaps)];
  all.sort((x, y) => started(x).localeCompare(started(y)));
  return all.at(-1)?.id ?? null;
}
