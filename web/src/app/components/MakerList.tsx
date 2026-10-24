import { Check } from "@phosphor-icons/react";
import type { Maker, Role } from "@/api";
import { coin, zec } from "@/format";
import { btcText } from "@/swap/shared";
import { cn } from "../lib/utils";
import { ago, capacity, fits, quoteOf, selectable, swappable } from "../lib/makers";
import { arrowKeys } from "./ui/sheet";

// The swap partners this server lists for the coin on screen, in the swap settings: "Best rate"
// (Ferry picks for the amount) or one partner. A partner that is offline, paused or can't take
// the amount is listed but can't be picked.

export function PartnerList({
  makers,
  role,
  zat,
  pick,
  current,
  onPick,
  fetchedAt,
  now,
  error,
}: {
  makers: Maker[] | null | undefined;
  role: Role;
  // the amount on the form (0: none yet)
  zat: number;
  // the partner the viewer chose; null: best rate
  pick: string | null;
  // the partner quoting now
  current: string | null;
  onPick: (name: string | null) => void;
  fetchedAt: number;
  now: number;
  error: string | null;
}) {
  const mine = (makers ?? []).filter(swappable);
  if (makers === undefined) return <p className="px-5 py-6 text-sm text-slate-500">Looking for partners…</p>;
  if (makers === null) return <p className="px-5 py-4 text-sm text-slate-500">This server has one swap partner, set by whoever runs it.</p>;
  return (
    <div role="radiogroup" aria-label="Swap partner" onKeyDown={arrowKeys} className="space-y-1 px-2">
      <Option active={pick === null} can onClick={() => onPick(null)} title="Best rate" meta={current && pick === null ? `Ferry picks for your amount · now ${current}` : "Ferry picks for your amount"} />
      {mine.length === 0 ? (
        <p className="px-3 py-4 text-sm text-slate-500">No partners swap ZEC for {coin().ticker} on this server yet.</p>
      ) : (
        mine.map((m) => <PartnerRow key={m.name} m={m} role={role} zat={zat} active={m.name === pick} onPick={onPick} age={m.rate_age_s != null ? m.rate_age_s + (now - fetchedAt) / 1000 : null} />)
      )}
      {error ? <p className="px-3 text-xs text-rose-700">{error}</p> : null}
    </div>
  );
}

function PartnerRow({ m, role, zat, active, onPick, age }: { m: Maker; role: Role; zat: number; active: boolean; onPick: (name: string) => void; age: number | null }) {
  const q = quoteOf(m);
  const takes = selectable(m, role);
  const fitsAmount = !q || zat <= 0 || fits(q, zat);
  const can = takes && fitsAmount;
  const rate = m.rate_sat_per_zec == null ? null : `${btcText(m.rate_sat_per_zec)} ${coin().ticker}`;
  const fixed = m.rate_source === "fixed" || (m.online && m.rate_updated_at == null);
  let meta: string;
  if (!m.online) meta = "Offline";
  else if (m.paused) meta = `Paused${age != null && !fixed ? ` · rate from ${ago(age)}` : ""}`;
  else if (!m.available) meta = "Not taking swaps";
  else if (!takes) meta = "Swaps the same side as you";
  else if (q && !fitsAmount) meta = zat < q.min ? `Takes at least ${zec(q.min)} ZEC` : `Takes up to ${zec(capacity(q))} ZEC right now`;
  else meta = q ? `Takes ${zec(q.min)}–${zec(capacity(q))} ZEC` : "Taking swaps";
  return <Option active={active} can={can} onClick={() => can && onPick(m.name)} title={m.name} rate={rate} meta={meta} dot={m.online && !m.paused ? "bg-emerald-500" : "bg-slate-300"} />;
}

function Option({ active, can, onClick, title, rate, meta, dot }: { active: boolean; can: boolean; onClick: () => void; title: string; rate?: string | null; meta: string; dot?: string }) {
  return (
    <button
      type="button"
      role="radio"
      data-option
      aria-checked={active}
      aria-disabled={!can}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className={cn("flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors", active ? "bg-slate-100" : can ? "hover:bg-slate-50" : "cursor-not-allowed")}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          {dot ? <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} aria-hidden /> : null}
          <span className={cn("truncate font-medium", can || active ? "text-slate-900" : "text-slate-500")}>{title}</span>
        </span>
        <span className="mt-0.5 block truncate text-[13px] text-slate-500">{meta}</span>
      </span>
      {rate ? <span className={cn("shrink-0 text-sm tabular-nums", can || active ? "text-slate-900" : "text-slate-500")}>{rate}</span> : null}
      {active ? <Check size={16} weight="bold" className="shrink-0 text-slate-900" aria-hidden /> : <span className="w-4 shrink-0" aria-hidden />}
    </button>
  );
}
