import type { ReactNode } from "react";
import { ArrowRight } from "@phosphor-icons/react";
import type { PairId } from "@/api";
import { cn } from "../lib/utils";
import { PairLogo, TokenLogo } from "./Logos";

// A private swap's three amounts in a row, each stacked so a phone fits them: what you sell, the
// shielded ZEC between, what you get.

export function RouteStrip({ from, to, sell, zec, get, getNote, faded, className }: { from: PairId | string; to: PairId | string; sell: string; zec: string; get: string; getNote?: string; faded?: boolean; className?: string }) {
  return (
    <div className={cn("grid grid-cols-[1fr_auto_1fr_auto_1fr] items-start gap-1 rounded-2xl bg-slate-50 px-2 py-3 text-center tabular-nums", className)}>
      <Amount logo={<PairLogo pair={from as PairId} size={22} />} value={sell} />
      <ArrowRight size={14} weight="bold" className="mt-1 text-slate-400" aria-label="for" />
      <Amount logo={<TokenLogo id="zec" size={22} />} value={zec} note="shielded" />
      <ArrowRight size={14} weight="bold" className="mt-1 text-slate-400" aria-label="then" />
      <Amount logo={<PairLogo pair={to as PairId} size={22} />} value={get} note={getNote} faded={faded} />
    </div>
  );
}

// "0.0041 BTC" as 0.0041 over "BTC" (and a note: "BTC · at least")
function Amount({ logo, value, note, faded }: { logo: ReactNode; value: string; note?: string; faded?: boolean }) {
  const [n, ticker] = value.split(" ");
  return (
    <span className={cn("flex min-w-0 flex-col items-center gap-1", faded && "opacity-50")}>
      {logo}
      <span className="max-w-full truncate text-[13px] font-medium text-slate-900 sm:text-sm">{n}</span>
      <span className="text-xs text-slate-500">{note ? `${ticker} · ${note}` : ticker}</span>
    </span>
  );
}
