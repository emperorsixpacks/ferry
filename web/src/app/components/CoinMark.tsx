import type { PairId } from "@/api";
import { cn } from "../lib/utils";

// A small round mark for a coin, in its usual colour: the pair toggle and the swap card's chips.
const MARKS: Record<PairId | "zec", { glyph: string; className: string }> = {
  zec: { glyph: "Z", className: "bg-[#f4b728] text-slate-900" },
  btc: { glyph: "₿", className: "bg-[#f7931a] text-white" },
  ltc: { glyph: "Ł", className: "bg-[#345d9d] text-white" },
  usdc: { glyph: "$", className: "bg-[#2775ca] text-white" },
};

export function CoinMark({ id, size = 20, className }: { id: PairId | "zec"; size?: number; className?: string }) {
  const m = MARKS[id];
  return (
    <span
      aria-hidden
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-sans font-bold", m.className, className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}
    >
      {m.glyph}
    </span>
  );
}
