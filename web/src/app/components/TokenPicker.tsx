import { useEffect, useMemo, useState } from "react";
import { Check, MagnifyingGlass } from "@phosphor-icons/react";
import { PAIR_IDS, pairChain, pairCoin, type Direction, type PairId, type Role } from "@/api";
import { CHAIN_NAMES, amountIn, coinInfo } from "@/format";
import { useLocal } from "../lib/daemon";
import { bestMaker, forPair, ownQuote, quoteOf, type Makers } from "../lib/makers";
import { pairName } from "../lib/pairs";
import { canRoute, tickerOf, useRoutes } from "../lib/routes";
import { cn } from "../lib/utils";
import { ChainLogo, PairLogo, TokenLogo, type ChainMarkId } from "./Logos";
import { Sheet, arrowKeys } from "./ui/sheet";

// "Select a token": every coin Ferry can swap ZEC for, filtered by chain or by a search. A row is
// one pair (USDC on Base, ETH on Arbitrum); pairs this server has no Ferry node for in the
// direction on screen are listed dimmed ("only for selling ZEC here", "not available here"), so
// people see what exists without being able to pick it.
//
// With a router (private swaps), the ZEC side of the card opens a picker too: shielded ZEC on top,
// then the coins that can go through it to (or come from) the coin on the other side.

const FILTERS: { id: "all" | ChainMarkId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "bitcoin", label: "Bitcoin" },
  { id: "litecoin", label: "Litecoin" },
  { id: "ethereum", label: "Ethereum" },
  { id: "base", label: "Base" },
  { id: "arbitrum", label: "Arbitrum" },
  { id: "optimism", label: "Optimism" },
];

// a coin on the card: shielded ZEC or a pair
export type Token = "zec" | PairId;

const chainMark = (id: PairId): ChainMarkId => (id === "btc" ? "bitcoin" : id === "ltc" ? "litecoin" : pairChain(id)!);
const assetName = (id: PairId) => ({ btc: "Bitcoin", ltc: "Litecoin", usdc: "USD Coin", weth: "Wrapped Ether" })[pairCoin(id)];
const chainName = (id: PairId) => (pairChain(id) ? CHAIN_NAMES[pairChain(id)!] : assetName(id));
// "Bitcoin", "USD Coin · Base", "Wrapped Ether · Arbitrum"
export const tokenSubtitle = (id: PairId) => (pairChain(id) ? `${assetName(id)} · ${chainName(id)}` : assetName(id));

// One row of the sheet. `sub` replaces the coin's subtitle; `off` says why it can't be picked.
export interface TokenRow {
  id: Token;
  can: boolean;
  sub?: string;
  off?: string;
  rate?: number;
}

function matches(id: Token, q: string): boolean {
  if (id === "zec") return ["zec", "zcash", "shielded"].some((s) => s.includes(q) || q.includes(s));
  const n = pairName(id);
  return [n.title, n.ticker, n.noun, assetName(id), chainName(id), pairCoin(id) === "weth" ? "eth ether" : ""].some((s) => s.toLowerCase().includes(q));
}

export function TokenSheet({ open, onClose, rows, selected, onPick, label = "Tokens" }: { open: boolean; onClose: () => void; rows: TokenRow[]; selected: Token; onPick: (id: Token) => void; label?: string }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [query, setQuery] = useState("");
  const phone = typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches;
  // each opening starts from the whole list
  useEffect(() => {
    if (!open) return;
    setFilter("all");
    setQuery("");
  }, [open]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = rows.filter((r) => (filter === "all" || (r.id !== "zec" && chainMark(r.id) === filter)) && (!q || matches(r.id, q)));
    // what can be picked first, in the order given
    return [...list.filter((r) => r.can), ...list.filter((r) => !r.can)];
  }, [rows, filter, query]);

  const pick = (id: Token) => {
    onPick(id);
    onClose();
  };
  const focusRow = shown.find((r) => r.id === selected && r.can)?.id ?? shown.find((r) => r.can)?.id;
  const firstOff = shown.findIndex((r) => !r.can);

  return (
    <Sheet open={open} onClose={onClose} title="Select a token">
      <div className="px-5 pb-3">
        <label className="flex h-11 items-center gap-2.5 rounded-2xl border border-slate-200 bg-slate-50 px-3.5 transition-colors focus-within:border-slate-300 focus-within:bg-white">
          <MagnifyingGlass size={16} className="shrink-0 text-slate-500" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                document.querySelector<HTMLElement>('[data-token-list] [data-option]:not([aria-disabled="true"])')?.focus();
              }
            }}
            placeholder="Search by name or chain"
            aria-label="Search by name or chain"
            autoComplete="off"
            data-autofocus={phone ? undefined : true}
            className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-slate-900 placeholder:text-slate-500 focus:outline-none focus-visible:outline-none"
          />
        </label>
        <div role="group" aria-label="Filter by chain" className="mt-3 flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[13px] transition-colors",
                filter === f.id ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
              )}
            >
              {f.id !== "all" ? <ChainLogo id={f.id} size={16} /> : null}
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <div className="border-t border-slate-100 px-2 pt-2 pb-4">
        {shown.length === 0 ? (
          <p className="px-3 py-10 text-center text-sm text-slate-500">Nothing matches “{query.trim()}”.</p>
        ) : (
          <div role="listbox" aria-label={label} data-token-list onKeyDown={arrowKeys}>
            <div role="group" aria-label="Available">
              {shown
                .filter((r) => r.can)
                .map((r) => (
                  <Row key={r.id} row={r} selected={r.id === selected} focus={r.id === focusRow} phone={phone} onPick={pick} />
                ))}
            </div>
            {firstOff >= 0 ? (
              <div role="group" aria-labelledby="tokens-off">
                <p id="tokens-off" className={cn("px-3 pb-1.5 text-xs font-medium text-slate-500", firstOff > 0 ? "pt-4" : "pt-1")}>
                  Not available here
                </p>
                {shown
                  .filter((r) => !r.can)
                  .map((r) => (
                    <Row key={r.id} row={r} selected={r.id === selected} focus={false} phone={phone} onPick={pick} />
                  ))}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </Sheet>
  );
}

function Row({ row, selected, focus, phone, onPick }: { row: TokenRow; selected: boolean; focus: boolean; phone: boolean; onPick: (id: Token) => void }) {
  const { id, can, rate } = row;
  const zec = id === "zec";
  const ticker = zec ? "ZEC" : pairName(id).ticker;
  const sub = row.sub ?? (zec ? "Zcash · shielded" : tokenSubtitle(id));
  const off = row.off ?? "not available here";
  return (
    <button
      type="button"
      role="option"
      data-option
      aria-selected={selected}
      aria-disabled={!can}
      tabIndex={focus ? 0 : -1}
      data-autofocus={phone && focus ? true : undefined}
      onClick={() => can && onPick(id)}
      className={cn("flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors", selected ? "bg-slate-100" : can ? "hover:bg-slate-50" : "cursor-not-allowed")}
    >
      {zec ? <TokenLogo id="zec" size={36} className={can ? undefined : "opacity-40 grayscale"} /> : <PairLogo pair={id} size={36} className={can ? undefined : "opacity-40 grayscale"} />}
      <span className="min-w-0 flex-1">
        <span className={cn("block font-medium", can ? "text-slate-900" : "text-slate-500")}>{ticker}</span>
        <span className="block truncate text-[13px] text-slate-500">{can ? sub : `${zec ? "Zcash" : chainName(id)} · ${off}`}</span>
      </span>
      {can && rate != null && !zec ? (
        <span className="shrink-0 text-right">
          <span className="block text-sm text-slate-900 tabular-nums">
            {amountIn(rate, coinInfo(pairCoin(id)))} {ticker}
          </span>
          <span className="block text-xs text-slate-500">per ZEC</span>
        </span>
      ) : null}
      {selected ? <Check size={18} weight="bold" className="shrink-0 text-slate-900" aria-hidden /> : <span className="w-[18px] shrink-0" aria-hidden />}
    </button>
  );
}

// The coin side of a ZEC swap: the pairs, those with a Ferry node for the direction on screen first.
export function TokenPicker({ open, onClose, makers, role }: { open: boolean; onClose: () => void; makers: Makers; role: Role }) {
  const { pairs, pair, choosePair, status, dir } = useLocal();

  // each pair's best rate for 1 ZEC, from the partners that take swaps now
  const rates = useMemo(() => {
    const out: Partial<Record<PairId, number>> = {};
    for (const id of PAIR_IDS) {
      if (makers.list === null) {
        if (id === pair && status) out[id] = ownQuote(status).rate;
        continue;
      }
      const usable = (makers.list ?? []).filter((m) => m.available && (m.role == null || m.role !== role) && forPair(m, id, pair));
      const best = bestMaker(usable, 1e8, role);
      if (best) out[id] = quoteOf(best)!.rate;
    }
    return out;
  }, [makers.list, pair, role, status]);

  const rows = useMemo(
    () =>
      PAIR_IDS.map((id): TokenRow => {
        const p = pairs.find((x) => x.id === id);
        const can = !!p?.[dir].daemon;
        const otherWay = !!p?.[dir === "sell" ? "buy" : "sell"].daemon;
        return { id, can, rate: can ? rates[id] : undefined, off: otherWay ? `only for ${dir === "buy" ? "selling" : "buying"} ZEC here` : "not available here" };
      }),
    [pairs, dir, rates],
  );

  return <TokenSheet open={open} onClose={onClose} rows={rows} selected={pair} onPick={(id) => id !== "zec" && choosePair(id)} />;
}

// One side of a private swap, or the ZEC side of a ZEC swap when the server has a router: shielded
// ZEC on top (a plain ZEC swap with the coin on the other side, if this server does that one), then
// every coin that can go through ZEC to (selling) or come from (buying) the coin on the other side.
export function RoutePicker({
  open,
  onClose,
  side,
  current,
  other,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  // the panel it opened from: "sell" (Sell) or "buy" (Buy)
  side: Direction;
  current: Token;
  // the coin on the other panel
  other: PairId;
  onPick: (id: Token) => void;
}) {
  const { pairs } = useLocal();
  const { legs } = useRoutes();
  const rows = useMemo(() => {
    // ZEC here makes a plain swap: sell ZEC for `other` (this is Sell) or buy it with `other`
    const p = pairs.find((x) => x.id === other);
    const direct = !!p?.[side === "sell" ? "sell" : "buy"].daemon;
    const zec: TokenRow = { id: "zec", can: direct, sub: "Zcash · shielded", off: `not with ${tickerOf(other)} here` };
    const coins = PAIR_IDS.map((id): TokenRow => {
      const ok = side === "sell" ? canRoute(legs, id, other) : canRoute(legs, other, id);
      if (ok) return { id, can: true, sub: `${tokenSubtitle(id)} · privately, through ZEC` };
      const ends = side === "sell" ? legs?.from.includes(id) : legs?.to.includes(id);
      const off = id === other ? `already what you ${side === "sell" ? "get" : "sell"}` : ends && pairCoin(id) === pairCoin(other) ? `the same coin as you ${side === "sell" ? "get" : "sell"}` : `not with ${tickerOf(other)} here`;
      return { id, can: false, off };
    });
    return [zec, ...coins];
  }, [pairs, legs, side, other]);
  return <TokenSheet open={open} onClose={onClose} rows={rows} selected={current} onPick={onPick} />;
}
