// Ferry's mark, in the spirit of SealPad's "Cipher Block": an obsidian square, a white channel
// across it, and an orange block setting out across the channel.
export function LogoMark({ size = 36, dark = false, className }: { size?: number; dark?: boolean; className?: string }) {
  const band = Math.round(size * 0.22);
  const boat = Math.round(size * 0.28);
  const outer = dark ? "#FFFFFF" : "#181818";
  const channel = dark ? "#181818" : "#FFFFFF";
  return (
    <div className={`relative shrink-0 ${className ?? ""}`} style={{ width: size, height: size, backgroundColor: outer, borderRadius: "0.69px" }} role="img" aria-label="Ferry">
      <div className="absolute" style={{ left: 0, right: 0, top: (size - band) / 2, height: band, backgroundColor: channel }} />
      <div className="absolute bg-brand-500" style={{ left: Math.round(size * 0.2), top: (size - boat) / 2, width: boat, height: boat, borderRadius: "0.69px" }} />
    </div>
  );
}

export function Wordmark({ size = 32 }: { size?: number }) {
  return (
    <span className="flex items-center gap-2.5">
      <LogoMark size={size} />
      <span className="text-sm font-bold tracking-wider text-slate-900">FERRY</span>
    </span>
  );
}
