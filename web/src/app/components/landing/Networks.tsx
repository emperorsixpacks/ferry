import { useRef, type CSSProperties, type ReactNode } from "react";
import { ChainLogo, type ChainMarkId } from "../Logos";
import { cn } from "../../lib/utils";
import { Mark } from "./marks";
import { useOnScreen, useReducedMotion } from "./motion";

// The networks: a row of chain tiles gliding past. Ferry's three direct chains first (the ones the
// installer and the demo offer; ferryd's Ethereum, Arbitrum and Optimism settings have never run,
// docs/WHAT-IS-REAL.md), then a few that NEAR Intents reaches on mainnet, then "more", with no count:
// NEAR Intents' list changes, and Ferry has not run it with real funds. Each chain's colour is only
// in its mark, and as a faint ring and tint under the pointer. The row holds still under the pointer
// and off screen, and wraps instead of moving with reduced motion. The tiles go round twice per
// half of the marquee, so even a wide screen never sees the end of the row.

interface Tile {
  key: string;
  name: string;
  mark: ReactNode;
  colour: string;
  near?: boolean;
}

const DIRECT: [ChainMarkId, string, string][] = [
  ["bitcoin", "Bitcoin", "#F7931A"],
  ["litecoin", "Litecoin", "#345D9D"],
  ["base", "Base", "#0052FF"],
];

const TILES: Tile[] = [
  ...DIRECT.map(([id, name, colour]) => ({ key: id, name, colour, mark: <ChainLogo id={id} size={36} /> })),
  { key: "sol", name: "Solana", colour: "#14F195", near: true, mark: <Mark id="sol" size={36} /> },
  { key: "doge", name: "Dogecoin", colour: "#C2A633", near: true, mark: <Mark id="doge" size={36} /> },
  { key: "xrp", name: "XRP Ledger", colour: "#23292F", near: true, mark: <Mark id="xrp" size={36} /> },
];

export function Networks() {
  const ref = useRef<HTMLDivElement>(null);
  const on = useOnScreen(ref);
  const reduced = useReducedMotion();
  // `again`: a repeat for the marquee, hidden from screen readers
  const items = (again = false) => (
    <>
      {TILES.map((t) => (
        <li key={t.key} aria-hidden={again || undefined}>
          <TileView t={t} />
        </li>
      ))}
      <li aria-hidden={again || undefined}>
        <div className="flex h-[76px] items-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-white px-5">
          <span className="text-2xl font-semibold tracking-tight text-slate-900">More</span>
          <span className="text-[13px] leading-snug text-slate-500">
            chains via NEAR Intents,
            <br />
            on mainnet
          </span>
        </div>
      </li>
    </>
  );
  if (reduced) return <ul className="mx-auto flex max-w-6xl flex-wrap justify-center gap-3 px-4 sm:px-6">{items()}</ul>;
  return (
    <div ref={ref} className={cn("lp-marquee-wrap relative overflow-hidden", !on && "lp-paused")}>
      {/* each half holds the tiles twice, so a longer loop keeps them moving as calmly as before */}
      <div className="lp-marquee py-2" style={{ animationDuration: "100s" }}>
        <ul className="flex shrink-0 gap-3 pr-3">
          {items()}
          {items(true)}
        </ul>
        <ul className="flex shrink-0 gap-3 pr-3" aria-hidden>
          {items(true)}
          {items(true)}
        </ul>
      </div>
      <div className="pointer-events-none absolute inset-y-0 left-0 w-12 bg-gradient-to-r from-canvas to-transparent sm:w-32" />
      <div className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-canvas to-transparent sm:w-32" />
    </div>
  );
}

function TileView({ t }: { t: Tile }) {
  return (
    <div style={{ "--c": t.colour } as CSSProperties} className={cn("lp-chain flex h-[76px] items-center gap-3.5 rounded-2xl border bg-white pr-5 pl-3.5", t.near ? "border-dashed border-slate-300" : "border-slate-200")}>
      {t.mark}
      <span>
        <span className="block text-[15px] font-semibold whitespace-nowrap text-slate-900">{t.name}</span>
        <span className="block text-xs whitespace-nowrap text-slate-500">{t.near ? "NEAR Intents, on mainnet" : "Direct atomic swaps"}</span>
      </span>
    </div>
  );
}
