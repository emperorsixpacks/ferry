import { useRef, type CSSProperties, type ReactNode } from "react";
import { ChainLogo, type ChainMarkId } from "../Logos";
import { cn } from "../../lib/utils";
import { Mark } from "./marks";
import { NEAR_CHAINS } from "./stats";
import { useOnScreen, useReducedMotion } from "./motion";

// The networks: a wide strip of chain marks gliding past, each lighting up in its own colour under
// the pointer. Ferry's six direct chains first, then a few NEAR Intents reaches, then how many more.
// It holds still under the pointer, off screen, and with reduced motion (then it wraps instead).

interface Tile {
  key: string;
  name: string;
  mark: ReactNode;
  colour: string;
  near?: boolean;
}

const DIRECT: [ChainMarkId, string, string][] = [
  ["bitcoin", "Bitcoin", "#F7931A"],
  ["litecoin", "Litecoin", "#5B86D1"],
  ["ethereum", "Ethereum", "#627EEA"],
  ["base", "Base", "#0052FF"],
  ["arbitrum", "Arbitrum", "#12AAFF"],
  ["optimism", "Optimism", "#FF0420"],
];

const TILES: Tile[] = [
  ...DIRECT.map(([id, name, colour]) => ({ key: id, name, colour, mark: <ChainLogo id={id} size={40} /> })),
  { key: "sol", name: "Solana", colour: "#14F195", near: true, mark: <Mark id="sol" size={40} /> },
  { key: "doge", name: "Dogecoin", colour: "#C2A633", near: true, mark: <Mark id="doge" size={40} /> },
  { key: "xrp", name: "XRP Ledger", colour: "#C9D3E0", near: true, mark: <Mark id="xrp" size={40} /> },
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
        <div className="flex h-[88px] items-center gap-3 rounded-3xl border border-dashed border-white/20 px-6 text-white">
          <span className="text-3xl font-semibold tracking-tight text-[var(--lp-cyan)]">+{NEAR_CHAINS - DIRECT.length - 3}</span>
          <span className="text-sm leading-snug text-[var(--lp-muted)]">
            more chains
            <br />
            via NEAR Intents
          </span>
        </div>
      </li>
    </>
  );
  const row = (copy: boolean) => (
    <ul className="flex shrink-0 gap-4 pr-4" aria-hidden={copy || undefined}>
      {items}
    </ul>
  );
  if (reduced) return <ul className="mx-auto flex max-w-6xl flex-wrap justify-center gap-4 px-4 sm:px-6">{items}</ul>;
  return (
    <div ref={ref} className={cn("lp-marquee-wrap relative overflow-hidden", !on && "lp-paused")}>
      <div className="lp-marquee py-3">
        {row(false)}
        {row(true)}
      </div>
      <div className="pointer-events-none absolute inset-y-0 left-0 w-16 bg-gradient-to-r from-[var(--lp-night)] to-transparent sm:w-40" />
      <div className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-[var(--lp-night)] to-transparent sm:w-40" />
    </div>
  );
}

function TileView({ t }: { t: Tile }) {
  return (
    <div
      style={{ "--c": t.colour } as CSSProperties}
      className={cn("lp-chain flex h-[88px] items-center gap-4 rounded-3xl border bg-white/[0.04] pr-6 pl-4", t.near ? "border-dashed border-white/20" : "border-white/12")}
    >
      <span className="rounded-full shadow-[0_0_30px_-4px_var(--c)]">{t.mark}</span>
      <span>
        <span className="block text-[17px] font-semibold whitespace-nowrap text-white">{t.name}</span>
        <span className={cn("block text-xs whitespace-nowrap", t.near ? "text-[var(--lp-cyan)]" : "text-[var(--lp-gold-hi)]")}>{t.near ? "via NEAR Intents" : "Direct atomic swaps"}</span>
      </span>
    </div>
  );
}
