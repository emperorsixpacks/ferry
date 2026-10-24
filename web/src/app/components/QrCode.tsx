import { useEffect, useState } from "react";
import { CircleNotch } from "@phosphor-icons/react";

// A QR code of `text`, drawn as one SVG path: black modules on a white tile with the quiet zone
// scanners need, in both themes (an inverted code scans badly). qrcode-generator (MIT, no
// dependencies, ~20 KB minified, ~8 KB gzipped) is loaded the first time a code is shown, so it
// stays out of the bundle every other page loads. Error correction M: a phone at arm's length.

type Drawn = { n: number; d: string };
const cache = new Map<string, Drawn>();

async function draw(text: string): Promise<Drawn> {
  const hit = cache.get(text);
  if (hit) return hit;
  const { default: qrcode } = await import("qrcode-generator");
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) {
    // a run of dark modules in a row is one rectangle
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      let w = 1;
      while (c + w < n && qr.isDark(r, c + w)) w++;
      d += `M${c} ${r}h${w}v1h-${w}z`;
      c += w - 1;
    }
  }
  const drawn = { n, d };
  cache.set(text, drawn);
  return drawn;
}

export function QrCode({ text, label, size = 208 }: { text: string; label: string; size?: number }) {
  const [drawn, setDrawn] = useState<Drawn | null>(() => cache.get(text) ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    setDrawn(cache.get(text) ?? null);
    draw(text).then(
      (v) => alive && setDrawn(v),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [text]);
  const quiet = 4;
  return (
    <div className="flex shrink-0 items-center justify-center rounded-2xl bg-[#fff] ring-1 ring-slate-200" style={{ width: size, height: size }} data-qr={text}>
      {drawn ? (
        <svg viewBox={`${-quiet} ${-quiet} ${drawn.n + quiet * 2} ${drawn.n + quiet * 2}`} width={size} height={size} role="img" aria-label={label} shapeRendering="crispEdges">
          <path d={drawn.d} fill="#000" />
        </svg>
      ) : failed ? (
        <span className="px-6 text-center text-[13px] text-[#52525b]">Couldn't draw the code. Copy the address below instead.</span>
      ) : (
        <CircleNotch size={22} weight="bold" className="animate-spin text-[#a1a1aa] motion-reduce:animate-none" aria-label="Drawing the code" />
      )}
    </div>
  );
}
