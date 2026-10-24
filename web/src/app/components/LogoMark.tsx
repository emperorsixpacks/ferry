// Ferry's mark: an ink tile with a white channel across it and a small ink block (the ferry)
// setting out across the channel. Monochrome, so it sits in the neutral UI.
export function LogoMark({ size = 36, dark = false, className }: { size?: number; dark?: boolean; className?: string }) {
  const band = Math.max(4, Math.round(size * 0.34));
  const boat = Math.max(2, Math.round(size * 0.18));
  const outer = dark ? "#FFFFFF" : "#18181B";
  const channel = dark ? "#18181B" : "#FFFFFF";
  return (
    <div
      className={`relative shrink-0 overflow-hidden ${className ?? ""}`}
      style={{ width: size, height: size, backgroundColor: outer, borderRadius: Math.round(size * 0.24) }}
      role="img"
      aria-label="Ferry"
    >
      <div className="absolute" style={{ left: 0, right: 0, top: (size - band) / 2, height: band, backgroundColor: channel }} />
      <div className="absolute" style={{ left: Math.round(size * 0.22), top: (size - boat) / 2, width: boat, height: boat, backgroundColor: outer, borderRadius: Math.max(1, Math.round(size * 0.06)) }} />
    </div>
  );
}

// `night`: white on a dark background (the landing's header)
export function Wordmark({ size = 32, night = false }: { size?: number; night?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <LogoMark size={size} dark={night} />
      <span className={`text-[15px] font-semibold tracking-tight ${night ? "text-white" : "text-slate-900"}`}>Ferry</span>
    </span>
  );
}
