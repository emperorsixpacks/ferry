import { useEffect, useState } from "react";
import { getMakers, type Maker } from "@/api";

// The UI server's maker directory (GET /api/makers), polled. The server caches each maker's offer
// for a few seconds, so polling often costs the makers nothing extra.

const POLL_MS = 15_000;

export interface Makers {
  // undefined while loading; null when the server has no maker directory
  list: Maker[] | null | undefined;
  error: string | null;
  // when `list` was fetched (ms), so rate ages can keep counting between polls
  fetchedAt: number;
  now: number;
}

export function useMakers(): Makers {
  const [state, setState] = useState<Omit<Makers, "now">>({ list: undefined, error: null, fetchedAt: 0 });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const list = await getMakers();
        if (alive) setState({ list, error: null, fetchedAt: Date.now() });
      } catch (e) {
        if (alive) setState((s) => ({ ...s, list: s.list ?? [], error: (e as Error).message }));
      }
      if (alive) timer = setTimeout(load, POLL_MS);
    };
    load();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      alive = false;
      clearTimeout(timer);
      clearInterval(tick);
    };
  }, []);

  return { ...state, now };
}

// What the swap form quotes from: one maker's offer.
export interface Quote {
  rate: number;
  min: number;
  max: number;
  fee: number | null;
  // how much ZEC the maker can fill right now, when it says
  liquidity: number | null;
}

export const quoteOf = (m: Maker): Quote | null =>
  m.rate_sat_per_zec != null && m.min_zat != null && m.max_zat != null
    ? { rate: m.rate_sat_per_zec, min: m.min_zat, max: m.max_zat, fee: m.fee_sat, liquidity: m.liquidity_zat }
    : null;

// The pairs this app can swap today.
export const SWAPPABLE = new Set(["ZEC/BTC"]);

// A maker this party can start a swap with: it takes swaps now, trades a pair the form supports,
// and holds the other side.
export const selectable = (m: Maker, role: "Z" | "B") => m.available && SWAPPABLE.has(m.pair) && (m.role == null || m.role !== role);

// "20s ago", "4m ago", "2h ago"
export function ago(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
