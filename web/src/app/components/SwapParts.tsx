import { Fragment, type ReactNode } from "react";
import { ArrowDown, ArrowRight, ArrowsDownUp, CaretDown, Check, ShieldCheck } from "@phosphor-icons/react";
import type { PairId } from "@/api";
import { Link } from "@/router";
import { useNear } from "../lib/near";
import { ZEC, isNear, tickerOf, type OptOut, type Path, type Step, type Token } from "../lib/paths";
import { cn } from "../lib/utils";
import { NearMark, NearTokenLogo, PairLogo, TokenLogo } from "./Logos";

// The swap card's parts, shared by every path on /app (a ZEC swap, a private coin-to-coin one, NEAR
// Intents at an end): a Sell or Buy panel, a coin pill, the arrow between them, the path line under
// the amounts, the privacy line under the card, the settings sheet's sections and facts.

export function Panel({ label, pill, foot, onClick, children }: { label: string; pill: ReactNode; foot: ReactNode; onClick?: () => void; children: ReactNode }) {
  return (
    <div
      onClick={(e) => {
        if (onClick && !(e.target as HTMLElement).closest("button, a")) onClick();
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

// "You have 4.99 ZEC · Add funds": what the node holds of a panel's coin; on the person's own node,
// with a way to add more (`add`: the coin's key on /wallet).
export function YouHave({ text, add }: { text: string | null; add?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate tabular-nums">{text == null ? "You have –" : `You have ${text}`}</span>
      {add ? (
        <>
          <span aria-hidden>·</span>
          <Link to={`/wallet?add=${add}`} className="shrink-0 rounded font-medium text-slate-700 underline-offset-4 transition-colors hover:text-slate-900 hover:underline" data-add-funds>
            Add funds
          </Link>
        </>
      ) : null}
    </span>
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

// Any coin's mark: shielded ZEC, a Ferry pair, a NEAR Intents asset.
export function CoinMark({ token, size = 28 }: { token: Token; size?: number }) {
  const near = useNear();
  if (token === ZEC) return <TokenLogo id="zec" size={size} />;
  if (isNear(token)) {
    const t = near.byId[token.slice(5)];
    return t ? <NearTokenLogo symbol={t.symbol} chain={t.blockchain} size={size} /> : <NearMark size={size} />;
  }
  return <PairLogo pair={token as PairId} size={size} />;
}

// The pill for a side of the card: opens the one coin picker. "You sell BTC. Choose another coin".
export function SidePill({ token, side, onOpen, name }: { token: Token; side: "sell" | "buy"; onOpen: () => void; name?: string }) {
  const near = useNear();
  const label = isNear(token) ? (near.byId[token.slice(5)]?.symbol ?? "…") : tickerOf(token);
  const what = name ?? (token === ZEC ? "shielded ZEC" : label);
  return <CoinPill logo={<CoinMark token={token} />} label={label} onClick={onOpen} ariaLabel={`${side === "sell" ? "You sell" : "You get"} ${what}. Choose another coin`} />;
}

// The arrow between the panels: it swaps the two sides, whatever they are. Its thick border is the
// page's colour, cutting it out of the two panels.
export function FlipButton({ onFlip, title }: { onFlip: () => void; title: string }) {
  return (
    <div className="relative z-10 -my-[18px] flex justify-center">
      <button
        type="button"
        onClick={onFlip}
        aria-label="Switch direction"
        title={title}
        className="group flex h-10 w-10 items-center justify-center rounded-2xl border-4 border-canvas bg-slate-100 text-slate-700 transition-colors hover:bg-slate-200 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900"
      >
        <ArrowDown size={16} weight="bold" className="group-hover:hidden group-focus-visible:hidden" aria-hidden />
        <ArrowsDownUp size={16} weight="bold" className="hidden group-hover:block group-focus-visible:block" aria-hidden />
      </button>
    </div>
  );
}

// "about 2 min", "about a minute": a swap's typical time from its seconds
export function minutesText(seconds: number): string {
  if (seconds < 90) return "about a minute";
  const m = Math.round(seconds / 60);
  return m < 90 ? `about ${m} min` : `about ${Math.round(m / 30) / 2} hours`;
}

// The path under the amounts: who runs each part and the coin handed between them, then "private"
// for a route through shielded ZEC, and the time. "Ferry → shielded ZEC → Ferry · private · about
// 35–75 min", "Ferry → BTC → NEAR Intents · about 35 min". `via` fills the coins a quote picked.
export function PathLine({ path, via = [], time, className }: { path: Path; via?: (string | null | undefined)[]; time?: string; className?: string }) {
  const near = path.kind.includes("near");
  // the coins handed over (not the ZEC between two Ferry swaps), in order: the quote's, else the guess
  let k = 0;
  const steps = path.steps.map((s: Step): Step => {
    if (s.by || s.coin === ZEC) return s;
    const v = via[k++];
    return v ? { coin: v as Token } : s;
  });
  const items = steps
    .map((s, i) => {
      if (s.by === "ferry") return <span key={i}>Ferry</span>;
      if (s.by === "near")
        return (
          <span key={i} className="inline-flex items-center gap-1">
            <NearMark size={14} />
            NEAR Intents
          </span>
        );
      if (!s.coin) return null;
      return (
        <span key={i} className="inline-flex items-center gap-1">
          <CoinMark token={s.coin} size={14} />
          {s.coin === ZEC ? "shielded ZEC" : tickerOf(s.coin)}
        </span>
      );
    })
    .filter(Boolean);
  const tags = [path.kind === "sell" || path.kind === "buy" ? "one swap" : null, path.private ? "private" : path.kind === "near-only" ? "public" : null, path.available === false ? "not available here" : (time ?? path.time) || null].filter(Boolean);
  return (
    <p className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-0.5", className)} data-path-line {...(near ? { "data-near-route": true } : {})}>
      {/* the spaces read in its text (a flex row doesn't draw them) */}
      {items.map((it, i) => (
        <Fragment key={i}>
          {i > 0 ? (
            <>
              {" "}
              <ArrowRight size={11} weight="bold" aria-label="then" />{" "}
            </>
          ) : null}
          {it}
        </Fragment>
      ))}
      {tags.length ? (
        <>
          {" "}
          <span>· {tags.join(" · ")}</span>
        </>
      ) : null}
    </p>
  );
}

// The honest line under the card: what this path keeps private, and what it doesn't.
export function PrivacyLine({ text }: { text: string }) {
  return (
    <p className="mt-6 flex items-start justify-center gap-2 text-center text-[13px] text-slate-500" data-privacy-line>
      <ShieldCheck size={16} weight="regular" className="mt-px shrink-0" aria-hidden />
      <span>{text}</span>
    </p>
  );
}

// The settings sheet's choice for two coins: private, through shielded ZEC (the default), or the
// opt-out, NEAR Intents alone, with its cost said plainly. Remembered for these two coins.
export function RouteChoice({ optOut }: { optOut: OptOut }) {
  if (!optOut.available) return null;
  const options = [
    { on: false, label: "Private, through shielded ZEC", note: "The default. No transaction links what you sold to what you got." },
    { on: true, label: "Faster, but public: via NEAR Intents only", note: "Anyone can link what you sold to what you got, and you trust NEAR Intents for all of it." },
  ];
  return (
    <Section title="Route" note="Ferry swaps privately by default: the coins pass through Zcash's shielded pool.">
      <div role="radiogroup" aria-label="Route" className="space-y-1 px-2">
        {options.map((o) => (
          <button
            key={o.label}
            type="button"
            role="radio"
            aria-checked={optOut.on === o.on}
            onClick={() => optOut.set(o.on)}
            className={cn("flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors", optOut.on === o.on ? "bg-slate-100" : "hover:bg-slate-50")}
          >
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-slate-900">{o.label}</span>
              <span className="mt-0.5 block text-[13px] text-slate-500">{o.note}</span>
            </span>
            {optOut.on === o.on ? <Check size={16} weight="bold" className="shrink-0 text-slate-900" aria-hidden /> : <span className="w-4 shrink-0" aria-hidden />}
          </button>
        ))}
      </div>
    </Section>
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
