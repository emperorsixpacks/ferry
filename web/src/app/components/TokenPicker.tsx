import { useEffect, useMemo, useState } from "react";
import { Check, MagnifyingGlass } from "@phosphor-icons/react";
import { PAIR_IDS, pairChain, pairCoin, type PairId, type Role } from "@/api";
import { CHAIN_NAMES, amountIn, coinInfo } from "@/format";
import { useLocal } from "../lib/daemon";
import { bestMaker, forPair, ownQuote, quoteOf, type Makers } from "../lib/makers";
import { pairName } from "../lib/pairs";
import { cn } from "../lib/utils";
import { ChainLogo, PairLogo, type ChainMarkId } from "./Logos";
import { Sheet, arrowKeys } from "./ui/sheet";

// "Select a token": every coin Ferry can swap ZEC for, filtered by chain or by a search. A row is
// one pair (USDC on Base, ETH on Arbitrum); pairs this server has no Ferry node for are listed
// dimmed, so people see what exists without being able to pick it.

const FILTERS: { id: "all" | ChainMarkId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "bitcoin", label: "Bitcoin" },
  { id: "litecoin", label: "Litecoin" },
  { id: "ethereum", label: "Ethereum" },
  { id: "base", label: "Base" },
  { id: "arbitrum", label: "Arbitrum" },
  { id: "optimism", label: "Optimism" },
];

const chainMark = (id: PairId): ChainMarkId => (id === "btc" ? "bitcoin" : id === "ltc" ? "litecoin" : pairChain(id)!);
const assetName = (id: PairId) => ({ btc: "Bitcoin", ltc: "Litecoin", usdc: "USD Coin", weth: "Wrapped Ether" })[pairCoin(id)];
const chainName = (id: PairId) => (pairChain(id) ? CHAIN_NAMES[pairChain(id)!] : assetName(id));
// "Bitcoin", "USD Coin · Base", "Wrapped Ether · Arbitrum"
export const tokenSubtitle = (id: PairId) => (pairChain(id) ? `${assetName(id)} · ${chainName(id)}` : assetName(id));

export function TokenPicker({ open, onClose, makers, role }: { open: boolean; onClose: () => void; makers: Makers; role: Role }) {
  const { pairs, pair, choosePair, status } = useLocal();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [query, setQuery] = useState("");
  const phone = typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches;
  // each opening starts from the whole list
  useEffect(() => {
    if (!open) return;
    setFilter("all");
    setQuery("");
  }, [open]);

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

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = PAIR_IDS.filter((id) => filter === "all" || chainMark(id) === filter)
      .filter((id) => {
        if (!q) return true;
        const n = pairName(id);
        return [n.title, n.ticker, n.noun, assetName(id), chainName(id), pairCoin(id) === "weth" ? "eth ether" : ""].some((s) => s.toLowerCase().includes(q));
      })
      .map((id) => ({ id, can: !!pairs.find((p) => p.id === id)?.daemon }));
    // what can be picked first, in the usual order
    return [...list.filter((r) => r.can), ...list.filter((r) => !r.can)];
  }, [filter, query, pairs]);

  const pick = (id: PairId) => {
    choosePair(id);
    onClose();
  };
  const focusRow = rows.find((r) => r.id === pair && r.can)?.id ?? rows.find((r) => r.can)?.id;
  const firstOff = rows.findIndex((r) => !r.can);

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
        {rows.length === 0 ? (
          <p className="px-3 py-10 text-center text-sm text-slate-500">Nothing matches “{query.trim()}”.</p>
        ) : (
          <div role="listbox" aria-label="Tokens" data-token-list onKeyDown={arrowKeys}>
            <div role="group" aria-label="Available">
              {rows.filter((r) => r.can).map((r) => (
                <Row key={r.id} id={r.id} can selected={r.id === pair} rate={rates[r.id]} focus={r.id === focusRow} phone={phone} onPick={pick} />
              ))}
            </div>
            {firstOff >= 0 ? (
              <div role="group" aria-labelledby="tokens-off">
                <p id="tokens-off" className={cn("px-3 pb-1.5 text-xs font-medium text-slate-500", firstOff > 0 ? "pt-4" : "pt-1")}>
                  Not available on this server
                </p>
                {rows.filter((r) => !r.can).map((r) => (
                  <Row key={r.id} id={r.id} can={false} selected={r.id === pair} rate={undefined} focus={false} phone={phone} onPick={pick} />
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </Sheet>
  );
}

function Row({ id, can, selected, rate, focus, phone, onPick }: { id: PairId; can: boolean; selected: boolean; rate: number | undefined; focus: boolean; phone: boolean; onPick: (id: PairId) => void }) {
  const n = pairName(id);
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
      <PairLogo pair={id} size={36} className={can ? undefined : "opacity-40 grayscale"} />
      <span className="min-w-0 flex-1">
        <span className={cn("block font-medium", can ? "text-slate-900" : "text-slate-500")}>{n.ticker}</span>
        <span className="block truncate text-[13px] text-slate-500">{can ? tokenSubtitle(id) : `${chainName(id)} · not available here`}</span>
      </span>
      {can && rate != null ? (
        <span className="shrink-0 text-right">
          <span className="block text-sm text-slate-900 tabular-nums">
            {amountIn(rate, coinInfo(pairCoin(id)))} {n.ticker}
          </span>
          <span className="block text-xs text-slate-500">per ZEC</span>
        </span>
      ) : null}
      {selected ? <Check size={18} weight="bold" className="shrink-0 text-slate-900" aria-hidden /> : <span className="w-[18px] shrink-0" aria-hidden />}
    </button>
  );
}
