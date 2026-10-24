import { cn } from "../lib/utils";

// Ferry's mark: an ink tile with a channel of the page's colour across it and a small ink block
// (the ferry) setting out across the channel. Monochrome, so it sits in the neutral UI, and it
// follows the theme: a near-white tile with a dark channel in dark mode.
export function LogoMark({ size = 36, className }: { size?: number; className?: string }) {
  const band = Math.max(4, Math.round(size * 0.34));
  const boat = Math.max(2, Math.round(size * 0.18));
  return (
    <div
      className={cn("relative shrink-0 overflow-hidden bg-slate-900", className)}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.24) }}
      role="img"
      aria-label="Ferry"
    >
      <div className="absolute bg-canvas" style={{ left: 0, right: 0, top: (size - band) / 2, height: band }} />
      <div className="absolute bg-slate-900" style={{ left: Math.round(size * 0.22), top: (size - boat) / 2, width: boat, height: boat, borderRadius: Math.max(1, Math.round(size * 0.06)) }} />
    </div>
  );
}

export function Wordmark({ size = 32 }: { size?: number }) {
  return (
    <span className="flex items-center gap-2.5">
      <LogoMark size={size} />
      <span className="text-[15px] font-semibold tracking-tight text-slate-900">Ferry</span>
    </span>
  );
}
