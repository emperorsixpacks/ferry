import { useEffect, useState } from "react";
import type { Maker, PairId, Role } from "@/api";
import { quoteOf, type Quote } from "./makers";

// Firm prices (POST /api/quotes). The UI server rounds the amount up to a bucket (0.1, 0.25, 0.5,
// 1, 2.5 ZEC...), asks its partners directly, checks each answer's signature and returns the ones
// that cover the amount, best first. A firm price holds for its partner's few seconds; a swap
// started with it gets exactly that rate. Without one, the swap card shows the partners' indicative
// rates as before.

export interface FirmQuote {
  maker: string;
  index: number;
  quote_id: string;
  rate_sat_per_zec: number;
  min_zat: number;
  max_zat: number;
  // when it stops being good, by this browser's clock (ms)
  until: number;
}

// wait this long after the amount last changed before asking
const DEBOUNCE_MS = 400;
// ask again when the best price has this little left (the server hands out ones with 20 s or more)
const REFRESH_LEFT_MS = 15_000;
// shown, and used to start a swap, while at least this is left
const USABLE_MS = 6_000;
// with no firm price, ask again this often
const IDLE_MS = 20_000;

// null: this server has no firm prices (an older one)
export async function getQuotes(pair: PairId, role: Role, zat: number): Promise<FirmQuote[] | null> {
  const res = await fetch("/api/quotes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pair, direction: role === "Z" ? "sell" : "buy", zec_zat: zat }),
  });
  if (res.status === 404 || res.status === 405) return null;
  const data = (await res.json().catch(() => null)) as { quotes?: (Omit<FirmQuote, "until"> & { expires_in_ms: number })[]; error?: string } | null;
  if (!res.ok || !Array.isArray(data?.quotes)) throw new Error(data?.error ?? "Can't get firm prices");
  const at = Date.now();
  return data.quotes.map(({ expires_in_ms, ...q }) => ({ ...q, until: at + expires_in_ms }));
}

export interface Quotes {
  // good for the amount on screen, best first
  list: FirmQuote[];
  // a 1 s clock while there are any, for "firm for 28 s"
  now: number;
  // ask again now (a swap start found the price gone)
  refresh: () => void;
}

// Firm prices for `zat` of ZEC (0: none yet) on `pair`, sold (Z) or bought (B), kept fresh.
export function useQuotes(pair: PairId, role: Role, zat: number): Quotes {
  const key = `${pair}|${role}|${zat}`;
  const [got, setGot] = useState<{ key: string; list: FirmQuote[] }>({ key: "", list: [] });
  const [now, setNow] = useState(() => Date.now());
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (zat <= 0) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      let list: FirmQuote[] | null = [];
      try {
        list = await getQuotes(pair, role, zat);
      } catch {
        list = [];
      }
      if (!alive) return;
      setNow(Date.now());
      setGot({ key, list: list ?? [] });
      // an older server: indicative rates only
      if (list === null) return;
      const best = list[0];
      timer = setTimeout(load, best ? Math.max(1000, best.until - Date.now() - REFRESH_LEFT_MS) : IDLE_MS);
    };
    timer = setTimeout(load, DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [pair, role, zat, key, nonce]);

  const any = got.key === key && got.list.length > 0;
  useEffect(() => {
    if (!any) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [any]);

  const list = got.key === key ? got.list.filter((q) => q.until - now >= USABLE_MS) : [];
  return { list, now, refresh: () => setNonce((n) => n + 1) };
}

// whole seconds a firm price has left
export const secondsLeft = (q: FirmQuote, now: number) => Math.max(0, Math.floor((q.until - now) / 1000));

// The price to show and start with: a firm one when there is one (with no partner picked, the best
// of all; with one picked, that partner's), else the indicative offer `live` came up with. Only from
// a partner that takes swaps now: one that went busy (it runs as many as it takes at once), paused or
// offline since it quoted can't honour its price.
export function withFirm<T extends { maker: Maker | null; quote: Quote | null }>(
  live: T,
  all: FirmQuote[],
  makers: Maker[] | null | undefined,
  pick: string | null,
): T & { firm: FirmQuote | null } {
  const firm = all.filter((q) => makers?.some((m) => m.name === q.maker && m.available) ?? true);
  const own = live.maker ? firm.find((q) => q.maker === live.maker!.name) : undefined;
  const chosen = pick ? own : (firm[0] ?? own);
  const maker = chosen ? (makers?.find((m) => m.name === chosen.maker) ?? null) : null;
  const base = maker ? quoteOf(maker) : null;
  if (!chosen || !maker || !base) return { ...live, firm: null };
  return { ...live, maker, quote: { ...base, rate: chosen.rate_sat_per_zec }, firm: chosen };
}
