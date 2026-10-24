import { useRef, type CSSProperties, type ReactNode } from "react";
import { ChainLogo, type ChainMarkId } from "../Logos";
import { cn } from "../../lib/utils";
import { Mark } from "./marks";
import { DIRECT_CHAINS, NEAR_CHAINS } from "./stats";
import { useOnScreen, useReducedMotion } from "./motion";

// The networks: a row of chain tiles gliding past. Ferry's six direct chains first, then a few that
// NEAR Intents reaches, then how many more. Each chain's colour is only in its mark, and as a faint
// ring and tint under the pointer. The row holds still under the pointer and off screen, and wraps
// instead of moving with reduced motion.

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
  ["ethereum", "Ethereum", "#627EEA"],
  ["base", "Base", "#0052FF"],
  ["arbitrum", "Arbitrum", "#12AAFF"],
  ["optimism", "Optimism", "#FF0420"],
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
  const items = (
    <>
      {TILES.map((t) => (
        <li key={t.key}>
          <TileView t={t} />
        </li>
      ))}
      <li>
        <div className="flex h-[76px] items-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-white px-5">
          <span className="text-2xl font-semibold tracking-tight text-slate-900 tabular-nums">+{NEAR_CHAINS - DIRECT_CHAINS - 3}</span>
          <span className="text-[13px] leading-snug text-slate-500">
            more chains
            <br />
            via NEAR Intents
          </span>
        </div>
      </li>
    </>
  );
  if (reduced) return <ul className="mx-auto flex max-w-6xl flex-wrap justify-center gap-3 px-4 sm:px-6">{items}</ul>;
  return (
    <div ref={ref} className={cn("lp-marquee-wrap relative overflow-hidden", !on && "lp-paused")}>
      <div className="lp-marquee py-2">
        <ul className="flex shrink-0 gap-3 pr-3">{items}</ul>
        <ul className="flex shrink-0 gap-3 pr-3" aria-hidden>
          {items}
        </ul>
      </div>
      <div className="pointer-events-none absolute inset-y-0 left-0 w-12 bg-gradient-to-r from-white to-transparent sm:w-32" />
      <div className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-white to-transparent sm:w-32" />
    </div>
  );
}

function TileView({ t }: { t: Tile }) {
  return (
    <div style={{ "--c": t.colour } as CSSProperties} className={cn("lp-chain flex h-[76px] items-center gap-3.5 rounded-2xl border bg-white pr-5 pl-3.5", t.near ? "border-dashed border-slate-300" : "border-slate-200")}>
      {t.mark}
      <span>
        <span className="block text-[15px] font-semibold whitespace-nowrap text-slate-900">{t.name}</span>
        <span className="block text-xs whitespace-nowrap text-slate-500">{t.near ? "via NEAR Intents" : "Direct atomic swaps"}</span>
      </span>
    </div>
  );
}
