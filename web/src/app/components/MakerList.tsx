import type { ReactNode } from "react";
import type { Maker, Role } from "@/api";
import { coin, zec } from "@/format";
import { btcText } from "@/swap/shared";
import { Label } from "./Layout";
import { StatusBadge } from "./ui/badge";
import { cn } from "../lib/utils";
import { ago, selectable, swappable } from "../lib/makers";

// The makers this UI server lists for the pair on screen, as a side panel next to the swap card:
// pick one and the card quotes its rate and range. Two lines a maker, so it fits half the page.

export function MakerList({
  makers,
  role,
  selected,
  onSelect,
  fetchedAt,
  now,
  error,
}: {
  makers: Maker[] | null | undefined;
  role: Role;
  selected: string | null;
  onSelect: (name: string) => void;
  fetchedAt: number;
  now: number;
  error: string | null;
}) {
  const mine = (makers ?? []).filter((m) => swappable(m.pair));
  const online = mine.filter((m) => m.online).length;
  return (
    // beside the swap card (lg) the panel takes the card's height, not its own, and scrolls
    <section aria-labelledby="makers-title" className="flex min-w-0 flex-col border border-slate-200 bg-white lg:[contain:size]">
      <div className="flex items-baseline justify-between gap-4 border-b border-slate-100 px-5 py-4">
        <h2 id="makers-title" className="font-mono text-[11px] tracking-[0.16em] text-slate-900 uppercase">
          Makers · ZEC ⇄ {coin().ticker}
        </h2>
        <Label>{makers === undefined ? "Loading" : `${online} of ${mine.length} online`}</Label>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {makers === undefined ? null : mine.length === 0 ? (
          <p className="px-2 py-10 text-center text-sm text-slate-500">No makers swap ZEC for {coin().ticker} on this server yet.</p>
        ) : (
          <div role="radiogroup" aria-label="Maker" className="space-y-2">
            {mine.map((m) => (
              <MakerRow key={m.name} m={m} role={role} active={m.name === selected} onSelect={onSelect} age={m.rate_age_s != null ? m.rate_age_s + (now - fetchedAt) / 1000 : null} />
            ))}
          </div>
        )}
        {error ? <p className="px-2 font-mono text-xs text-rose-700">{error}</p> : null}
      </div>
      <p className="border-t border-slate-100 px-5 py-3 text-xs leading-relaxed text-slate-500">
        You choose who you swap with. Each maker sets its own rate and size; none of them can take your coins.
      </p>
    </section>
  );
}

function MakerRow({ m, role, active, onSelect, age }: { m: Maker; role: Role; active: boolean; onSelect: (name: string) => void; age: number | null }) {
  const can = selectable(m, role);
  const rate = m.rate_sat_per_zec == null ? "–" : `${btcText(m.rate_sat_per_zec)} ${coin().ticker}`;
  const fixed = m.rate_source === "fixed" || (m.online && m.rate_updated_at == null);
  const updated = fixed ? "Fixed rate" : age != null ? `Updated ${ago(age)}` : null;
  const range = m.min_zat != null && m.max_zat != null ? `${zec(m.min_zat)}–${zec(m.max_zat)} ZEC` : null;
  const liquidity = m.liquidity_zat != null ? `${zec(m.liquidity_zat)} ZEC free` : null;

  let badge: ReactNode;
  if (active) badge = <StatusBadge>Selected</StatusBadge>;
  else if (!m.online) badge = <StatusBadge variant="destructive">Offline</StatusBadge>;
  else if (m.paused) badge = <StatusBadge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">Paused</StatusBadge>;
  else if (!m.available) badge = <StatusBadge variant="outline">Closed</StatusBadge>;
  else badge = null;

  const dot = m.online ? (m.paused ? "bg-amber-400" : "bg-brand-500") : "bg-slate-300";
  const meta = m.online ? [m.paused && updated ? `Stale, ${updated.toLowerCase()}` : updated, range, liquidity].filter(Boolean) : ["Not answering"];

  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-disabled={!can}
      onClick={() => can && onSelect(m.name)}
      className={cn(
        "block w-full border px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-brand-500/20",
        active ? "border-brand-500 bg-brand-50/40 ring-3 ring-brand-500/20" : can ? "border-slate-200 bg-white hover:border-slate-300" : "cursor-not-allowed border-slate-200 bg-slate-50",
      )}
    >
      <span className="flex items-center gap-3">
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} aria-hidden />
        <span className={cn("min-w-0 flex-1 truncate font-medium", can || active ? "text-slate-900" : "text-slate-500")}>{m.name}</span>
        <span className={cn("font-mono text-sm", can || active ? "text-slate-900" : "text-slate-400")}>{rate}</span>
        {badge}
      </span>
      <span className="mt-1 block truncate pl-4.5 font-mono text-[11px] text-slate-500">{meta.join(" · ")}</span>
    </button>
  );
}
