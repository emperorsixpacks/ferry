import type { ReactNode } from "react";
import type { Maker, Role } from "@/api";
import { zec } from "@/format";
import { btcText } from "@/swap/shared";
import { Label } from "./Layout";
import { StatusBadge } from "./ui/badge";
import { cn } from "../lib/utils";
import { SWAPPABLE, ago, selectable } from "../lib/makers";

// The makers this UI server lists, as SealPad-style bordered rows: pick one and the swap form
// quotes its rate and range.

const COLS = "md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,0.8fr)_5.5rem]";

export function MakerList({
  makers,
  role,
  selected,
  onSelect,
  fetchedAt,
  now,
  error,
}: {
  makers: Maker[];
  role: Role;
  selected: string | null;
  onSelect: (name: string) => void;
  fetchedAt: number;
  now: number;
  error: string | null;
}) {
  const online = makers.filter((m) => m.online).length;
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-4">
        <Label>Maker</Label>
        <Label>
          {online} of {makers.length} online
        </Label>
      </div>
      <div className={cn("hidden gap-4 px-4 pt-1 md:grid", COLS)}>
        <Label>Name</Label>
        <Label>Rate</Label>
        <Label>Updated</Label>
        <Label>Range</Label>
        <Label>Liquidity</Label>
        <Label className="text-right">Status</Label>
      </div>
      <div role="radiogroup" aria-label="Maker" className="space-y-2">
        {makers.map((m) => (
          <MakerRow key={m.name} m={m} role={role} active={m.name === selected} onSelect={onSelect} age={m.rate_age_s != null ? m.rate_age_s + (now - fetchedAt) / 1000 : null} />
        ))}
      </div>
      {error ? <p className="font-mono text-xs text-rose-700">{error}</p> : null}
    </div>
  );
}

function MakerRow({ m, role, active, onSelect, age }: { m: Maker; role: Role; active: boolean; onSelect: (name: string) => void; age: number | null }) {
  const can = selectable(m, role);
  const quote = m.pair.split("/")[1] ?? "BTC";
  const fiat = quote === "USD" || quote === "USDC";
  const rate = m.rate_sat_per_zec == null ? "–" : `${fiat ? (m.rate_sat_per_zec / 1e6).toFixed(2) : btcText(m.rate_sat_per_zec)} ${quote}`;
  const fixed = m.rate_source === "fixed" || (m.online && m.rate_updated_at == null);
  const updated = !m.online ? "–" : fixed ? "Fixed rate" : age != null ? ago(age) : "–";
  const range = m.min_zat != null && m.max_zat != null ? `${zec(m.min_zat)}–${zec(m.max_zat)} ZEC` : "–";
  const liquidity = m.liquidity_zat != null ? `${zec(m.liquidity_zat)} ZEC` : "–";

  let badge: ReactNode;
  if (active) badge = <StatusBadge>Selected</StatusBadge>;
  else if (!m.online) badge = <StatusBadge variant="destructive">Offline</StatusBadge>;
  else if (m.paused) badge = <StatusBadge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">Paused</StatusBadge>;
  else if (!SWAPPABLE.has(m.pair)) badge = <StatusBadge variant="outline">Soon</StatusBadge>;
  else if (!m.available) badge = <StatusBadge variant="outline">Closed</StatusBadge>;
  else badge = <StatusBadge variant="outline" className="border-brand-200 bg-brand-50/40 text-brand-700">Online</StatusBadge>;

  const dot = m.online ? (m.paused ? "bg-amber-400" : "bg-brand-500") : "bg-slate-300";

  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-disabled={!can}
      onClick={() => can && onSelect(m.name)}
      className={cn(
        "grid w-full grid-cols-2 items-center gap-x-4 gap-y-3 border px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-brand-500/20",
        COLS,
        active ? "border-brand-500 bg-brand-50/40 ring-3 ring-brand-500/20" : can ? "border-slate-200 bg-white hover:border-slate-300" : "cursor-not-allowed border-slate-200 bg-slate-50",
      )}
    >
      <span className="col-span-2 flex min-w-0 items-center gap-3 md:col-span-1">
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} aria-hidden />
        <span className="min-w-0">
          <span className={cn("block truncate font-medium", can || active ? "text-slate-900" : "text-slate-500")}>{m.name}</span>
          <span className="block font-mono text-[11px] text-slate-500">{m.pair}</span>
        </span>
        <span className="ml-auto md:hidden">{badge}</span>
      </span>
      <Cell label="Rate" muted={!can && !active}>
        <span className="font-mono">{rate}</span>
      </Cell>
      <Cell label="Updated" muted>
        <span className="font-mono text-xs">{m.paused ? `Stale, ${updated}` : updated}</span>
      </Cell>
      <Cell label="Range" muted={!can && !active}>
        <span className="font-mono">{range}</span>
      </Cell>
      <Cell label="Liquidity" muted={!can && !active}>
        <span className="font-mono">{liquidity}</span>
      </Cell>
      <span className="hidden justify-end md:flex">{badge}</span>
    </button>
  );
}

function Cell({ label, muted, children }: { label: string; muted?: boolean; children: ReactNode }) {
  return (
    <span className="block min-w-0">
      {/* Label's look, as a span: a <p> can't sit inside a <button> */}
      <span className="block font-mono text-[10px] tracking-widest text-slate-500 uppercase md:hidden">{label}</span>
      <span className={cn("mt-1 block truncate md:mt-0", muted ? "text-slate-500" : "text-slate-900")}>{children}</span>
    </span>
  );
}
