import type { ReactElement } from "react";
import { TokenLogo } from "../Logos";
import { cn } from "../../lib/utils";

// Every coin the landing draws: Ferry's own (the app's marks) and a few that NEAR Intents reaches
// (Solana, Dogecoin, XRP), as simple marks in their own colours. `HUE` is the colour of each coin's
// trail of light.

export type MarkId = "zec" | "btc" | "ltc" | "usdc" | "eth" | "sol" | "doge" | "xrp";

export const HUE: Record<MarkId, string> = {
  zec: "#F4B728",
  btc: "#F7931A",
  ltc: "#345D9D",
  usdc: "#2775CA",
  eth: "#627EEA",
  sol: "#14F195",
  doge: "#C2A633",
  xrp: "#C9D3E0",
};

export const NAME: Record<MarkId, string> = {
  zec: "Zcash",
  btc: "Bitcoin",
  ltc: "Litecoin",
  usdc: "USDC",
  eth: "Ether",
  sol: "Solana",
  doge: "Dogecoin",
  xrp: "XRP",
};

const EXTRA: Record<"sol" | "doge" | "xrp", ReactElement> = {
  // the three bars of Solana's mark, green to purple (solid fills: a gradient's id would clash
  // between copies of the mark on one page)
  sol: (
    <>
      <circle cx="16" cy="16" r="15.4" fill="#14141F" stroke="#fff" strokeOpacity=".25" strokeWidth="1.2" />
      <path fill="#14F195" d="M10.9 9.4h12.6l-2.4 2.6H8.5z" />
      <path fill="#5FA8E6" d="M8.5 14.7h12.6l2.4 2.6H10.9z" />
      <path fill="#9945FF" d="M10.9 20h12.6l-2.4 2.6H8.5z" />
    </>
  ),
  doge: (
    <>
      <circle cx="16" cy="16" r="16" fill="#C2A633" />
      <path
        fill="#fff"
        d="M12 9h4.6c4.2 0 6.6 2.6 6.6 7s-2.4 7-6.6 7H12v-5.9h-1.8v-2.3H12zm2.6 2.3v3.6h3v2.3h-3v3.5h1.9c2.7 0 4-1.6 4-4.7s-1.3-4.7-4-4.7z"
      />
    </>
  ),
  xrp: (
    <>
      <circle cx="16" cy="16" r="15.4" fill="#23292F" stroke="#fff" strokeOpacity=".25" strokeWidth="1.2" />
      <g fill="#fff">
        <path d="M9 9.2h2.7l3.1 3.1a1.7 1.7 0 0 0 2.4 0l3.1-3.1H23l-4.1 4.1a4 4 0 0 1-5.8 0z" />
        <path d="M9 22.8h2.7l3.1-3.1a1.7 1.7 0 0 1 2.4 0l3.1 3.1H23l-4.1-4.1a4 4 0 0 0-5.8 0z" />
      </g>
    </>
  ),
};

export function Mark({ id, size = 32, className, label }: { id: MarkId; size?: number; className?: string; label?: string }) {
  if (id !== "sol" && id !== "doge" && id !== "xrp") return <TokenLogo id={id} size={size} className={className} label={label} />;
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} className={cn("shrink-0", className)} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {EXTRA[id]}
    </svg>
  );
}
