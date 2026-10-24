import { Check } from "@phosphor-icons/react";
import type { Maker, Role } from "@/api";
import { coin, zec } from "@/format";
import { btcText } from "@/swap/shared";
import { cn } from "../lib/utils";
import { ago, capacity, fits, quoteOf, selectable, slotsText, swappable } from "../lib/makers";
import { secondsLeft, type FirmQuote } from "../lib/quotes";
import { arrowKeys } from "./ui/sheet";

// The swap partners this server lists for the coin on screen, in the swap settings: "Best rate"
// (Ferry picks for the amount) or one partner. Partners for the direction on screen come first
// (buying ZEC: the ones who sell it); one that is offline, paused, busy (running as many swaps as it
// takes at once), can't take the amount or only swaps the other way is listed but can't be picked.
// One that can says how many more swaps it takes right now, when it says.

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
  firm = [],
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
  // firm prices for the amount (lib/quotes), shown in place of a partner's indicative rate
  firm?: FirmQuote[];
}) {
  const all = (makers ?? []).filter(swappable);
  // A partner of our own role swaps only the other way (a Z partner only sells ZEC): named in one
  // line under the list, not offered. The ones that don't say (offline) are listed after ours.
  const otherWay = (m: Maker) => m.role != null && m.role === role;
  const mine = [...all.filter((m) => m.role != null && !otherWay(m)), ...all.filter((m) => m.role == null)];
  const others = all.filter(otherWay).map((m) => m.name);
  const none = !mine.some((m) => m.role != null);
  const verb = role === "B" ? "sell" : "buy";
  if (makers === undefined) return <p className="px-5 py-6 text-sm text-slate-500">Looking for partners…</p>;
  if (makers === null) return <p className="px-5 py-4 text-sm text-slate-500">This server has one swap partner, set by whoever runs it.</p>;
  return (
    <div role="radiogroup" aria-label="Swap partner" onKeyDown={arrowKeys} className="space-y-1 px-2">
      <Option active={pick === null} can onClick={() => onPick(null)} title="Best rate" meta={current && pick === null ? `Ferry picks for your amount · now ${current}` : "Ferry picks for your amount"} />
      {none ? (
        <p className="px-3 py-4 text-sm text-slate-500">
          No partners {verb} ZEC for {coin().ticker} on this server yet.
        </p>
      ) : null}
      {mine.map((m) => (
        <PartnerRow key={m.name} m={m} role={role} zat={zat} active={m.name === pick} onPick={onPick} age={m.rate_age_s != null ? m.rate_age_s + (now - fetchedAt) / 1000 : null} firm={firm.find((q) => q.maker === m.name)} now={now} />
      ))}
      {others.length ? (
        <p className="px-3 pt-1 pb-1 text-[13px] text-slate-500">
          {names(others)} only {role === "B" ? "buy" : "sell"} ZEC, so {others.length === 1 ? "it's" : "they're"} not available here.
        </p>
      ) : null}
      {error ? <p className="px-3 text-xs text-rose-700">{error}</p> : null}
    </div>
  );
}

// "Bram", "Bram and Kestrel", "Bram, Kestrel and Heron OTC"
const names = (list: string[]) => (list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`);

function PartnerRow({ m, role, zat, active, onPick, age, firm, now }: { m: Maker; role: Role; zat: number; active: boolean; onPick: (name: string) => void; age: number | null; firm?: FirmQuote; now: number }) {
  const q = quoteOf(m);
  const takes = selectable(m, role);
  const fitsAmount = !q || zat <= 0 || fits(q, zat);
  const can = takes && fitsAmount;
  const shown = firm && can ? firm.rate_sat_per_zec : m.rate_sat_per_zec;
  const rate = shown == null ? null : `${btcText(shown)} ${coin().ticker}`;
  const fixed = m.rate_source === "fixed" || (m.online && m.rate_updated_at == null);
  let meta: string;
  if (!m.online) meta = "Offline";
  else if (m.paused) meta = `Paused${age != null && !fixed ? ` · rate from ${ago(age)}` : ""}`;
  // running as many swaps as it takes at once: it has room again when one of them finishes
  else if (m.busy) meta = "Busy · full for now";
  else if (!m.available) meta = "Not taking swaps";
  else if (!takes) meta = m.role === "Z" ? "Only sells ZEC" : m.role === "B" ? "Only buys ZEC" : "Swaps the same side as you";
  else if (q && !fitsAmount) meta = zat < q.min ? `Takes at least ${zec(q.min)} ZEC` : `Takes up to ${zec(capacity(q))} ZEC right now`;
  else meta = q ? `Takes ${zec(q.min)}–${zec(capacity(q))} ZEC` : "Taking swaps";
  // a firm price covers the amount on screen: its countdown says more than the partner's range
  if (firm && can) meta = `Firm price for ${secondsLeft(firm, now)} s`;
  // how many more swaps it takes right now, when it says: a line of its own, so neither is cut short
  const slots = can ? slotsText(m) : null;
  const sub = slots ? slots.charAt(0).toUpperCase() + slots.slice(1) : null;
  return <Option active={active} can={can} onClick={() => can && onPick(m.name)} title={m.name} rate={rate} meta={meta} sub={sub} dot={m.online && !m.paused && !m.busy ? "bg-emerald-500" : "bg-slate-300"} />;
}

function Option({ active, can, onClick, title, rate, meta, sub, dot }: { active: boolean; can: boolean; onClick: () => void; title: string; rate?: string | null; meta: string; sub?: string | null; dot?: string }) {
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
        {sub ? <span className="block truncate text-[13px] text-slate-500">{sub}</span> : null}
      </span>
      {rate ? <span className={cn("shrink-0 text-sm tabular-nums", can || active ? "text-slate-900" : "text-slate-500")}>{rate}</span> : null}
      {active ? <Check size={16} weight="bold" className="shrink-0 text-slate-900" aria-hidden /> : <span className="w-4 shrink-0" aria-hidden />}
    </button>
  );
}
