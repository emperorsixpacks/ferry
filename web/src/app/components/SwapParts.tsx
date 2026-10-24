import type { ReactNode } from "react";
import { CaretDown } from "@phosphor-icons/react";
import { cn } from "../lib/utils";

// The swap card's parts, shared by the ZEC swap and the private (coin to coin) one on /app: a Sell or
// Buy panel, a coin pill, the settings sheet's sections and facts.

export function Panel({ label, pill, foot, onClick, children }: { label: string; pill: ReactNode; foot: ReactNode; onClick?: () => void; children: ReactNode }) {
  return (
    <div
      onClick={(e) => {
        if (onClick && !(e.target as HTMLElement).closest("button")) onClick();
      }}
      className={cn(
        "rounded-3xl border border-slate-200/70 bg-slate-50 px-5 pt-4 pb-4 transition-colors",
        onClick && "has-[input:focus]:border-slate-300 has-[input:focus]:bg-white",
      )}
    >
      <p className="text-xs font-medium tracking-wider text-slate-500 uppercase">{label}</p>
      <div className="mt-3 flex items-center gap-3">
        <div className="min-w-0 flex-1">{children}</div>
        {pill}
      </div>
      <div className="mt-3 flex min-h-6 items-center justify-between gap-3 text-[13px] text-slate-500">{foot}</div>
    </div>
  );
}

// A coin on a panel: a button that opens a picker (with a caret), or a plain label.
export function CoinPill({ logo, label, title, onClick, ariaLabel }: { logo: ReactNode; label: string; title?: string; onClick?: () => void; ariaLabel?: string }) {
  const look = "inline-flex h-10 shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-white pl-1.5 shadow-[0_1px_2px_rgba(24,24,27,0.06)]";
  if (!onClick)
    return (
      <span className={cn(look, "pr-3.5")} title={title}>
        {logo}
        <span className="text-[15px] font-semibold text-slate-900">{label}</span>
      </span>
    );
  return (
    <button type="button" onClick={onClick} aria-haspopup="dialog" aria-label={ariaLabel} title={title} className={cn(look, "pr-3 transition-colors hover:border-slate-300 hover:bg-slate-50")}>
      {logo}
      <span className="text-[15px] font-semibold text-slate-900">{label}</span>
      <CaretDown size={14} weight="bold" className="text-slate-500" aria-hidden />
    </button>
  );
}

export function Section({ title, note, last, children }: { title: string; note?: string; last?: boolean; children: ReactNode }) {
  return (
    <section className={cn("pt-1", last ? "pb-5" : "border-b border-slate-100 pb-3")}>
      <h3 className="px-5 text-xs font-medium tracking-wider text-slate-500 uppercase">{title}</h3>
      {note ? <p className="mt-1 px-5 text-[13px] text-slate-500">{note}</p> : null}
      <div className="mt-2">{children}</div>
    </section>
  );
}

export function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex gap-4">
      <dt className="w-28 shrink-0 text-slate-500">{label}</dt>
      <dd className="min-w-0 text-slate-900">{value}</dd>
    </div>
  );
}

export const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Big amounts step down as they get longer, so 0.0041035 fits beside the coin pill on a phone.
export function amountSize(text: string): string {
  const n = text.length;
  if (n <= 6) return "text-[36px] sm:text-[40px]";
  if (n <= 9) return "text-[30px] sm:text-[38px]";
  if (n <= 12) return "text-[25px] sm:text-[32px]";
  return "text-[21px] sm:text-[27px]";
}
