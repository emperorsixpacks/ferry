import { useEffect, useRef } from "react";
import { ArrowUpRight } from "@phosphor-icons/react";
import { Link } from "@/router";
import { FOOTER_LINKS, REPO_URL } from "../Layout";
import { LogoMark } from "../LogoMark";
import { cn } from "../../lib/utils";
import { useOnScreen, useReducedMotion } from "./motion";

// The landing's footer: the name itself crossing. A giant "Ferry" floats half under the surface of
// the shielded pool: above the waterline it is ink on the page; below it, the letters are made of
// ciphertext that keeps changing, frosted and faintly outlined. The footer's links sit in the pool
// beneath it. The glyphs change only while the footer is on screen; reduced motion keeps them
// still and the word doesn't bob.

// viewBox 1000 x 400: baseline at 300, the waterline at 200 (the middle of the lower-case letters)
const W = 1000;
const H = 400;
const WATER = 200;
const ROWS = 15;
// 13px glyphs of the mono face are about 7.8 units wide: enough to cross the whole word
const COLS = 132;
const GLYPHS = "01#%&@$<>/\\=+*:;░▒";

const noise = () => {
  let s = "";
  for (let i = 0; i < COLS; i++) s += GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
  return s;
};

export function Submerged() {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const running = useOnScreen(ref) && !reduced;
  const rows = useRef<(SVGTextElement | null)[]>([]);

  useEffect(() => {
    rows.current.forEach((r) => r && (r.textContent = noise()));
    if (!running) return;
    // a few rows at a time, about eight times a second
    const id = setInterval(() => {
      for (let k = 0; k < 4; k++) {
        const r = rows.current[Math.floor(Math.random() * ROWS)];
        if (r) r.textContent = noise();
      }
    }, 120);
    return () => clearInterval(id);
  }, [running]);

  const word = { x: W / 2, y: 300, textAnchor: "middle", fontSize: 380, fontWeight: 700, style: { fontFamily: "var(--font-sans)", letterSpacing: "-0.045em" } } as const;

  return (
    <footer ref={ref} className={cn("relative overflow-hidden", !running && "lp-paused")}>
      <div className="relative">
        {/* the pool, from the waterline down */}
        <div className="lp-pool absolute inset-x-0 bottom-0" style={{ top: `calc(1.5rem + (100% - 1.5rem) * ${WATER / H})` }} aria-hidden>
          <div className="lp-lattice" />
          <div className="lp-glow" />
          <div className="lp-sheen" />
        </div>
        <div className="relative mx-auto max-w-[1200px] px-4 pt-6 sm:px-6">
          <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label="Ferry">
            <defs>
              <clipPath id="lp-above">
                <rect x="-50" y="-50" width={W + 100} height={WATER + 50} />
              </clipPath>
              <clipPath id="lp-below">
                <rect x="-50" y={WATER} width={W + 100} height={H} />
              </clipPath>
              <pattern id="lp-cipher" patternUnits="userSpaceOnUse" x="0" y={WATER - 8} width={W} height={ROWS * 14}>
                {Array.from({ length: ROWS }, (_, i) => (
                  <text
                    key={i}
                    ref={(el) => void (rows.current[i] = el)}
                    x={i % 2 ? -6 : 0}
                    y={14 * i + 12}
                    fontSize="13"
                    style={{ fontFamily: "var(--font-mono)" }}
                    fill="#c3c8e6"
                    fillOpacity={0.45 + 0.4 * Math.abs(Math.sin(i * 1.7))}
                  />
                ))}
              </pattern>
              <filter id="lp-frost" x="-5%" y="-5%" width="110%" height="110%">
                <feGaussianBlur stdDeviation="0.6" />
              </filter>
              <filter id="lp-halo" x="-10%" y="-20%" width="120%" height="140%">
                <feGaussianBlur stdDeviation="14" />
              </filter>
            </defs>
            <g clipPath="url(#lp-above)">
              <g className="lp-bob">
                <text {...word} fill="#18181b">
                  Ferry
                </text>
              </g>
            </g>
            <g clipPath="url(#lp-below)" aria-hidden>
              <g className="lp-bob">
                {/* a soft light under the surface where the letters are, then the letters in ciphertext */}
                <text {...word} fill="#5f69a8" fillOpacity=".35" filter="url(#lp-halo)">
                  Ferry
                </text>
                <g transform="translate(3 0)">
                  <text {...word} fill="#aab1d6" fillOpacity=".09">
                    Ferry
                  </text>
                  <text {...word} fill="url(#lp-cipher)" filter="url(#lp-frost)">
                    Ferry
                  </text>
                  <text {...word} fill="none" stroke="#aab1d6" strokeOpacity=".28" strokeWidth="1.2">
                    Ferry
                  </text>
                </g>
              </g>
            </g>
          </svg>
        </div>
      </div>

      <div className="relative bg-pool-950">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 pt-6 pb-10 sm:px-6 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <LogoMark size={22} dark />
            <span className="text-sm text-accent-300">Private swaps for shielded ZEC.</span>
          </div>
          <nav aria-label="More" className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-accent-200">
            {FOOTER_LINKS.map(([label, to]) => (
              <Link key={to} to={to} className="rounded transition-colors hover:text-white focus-visible:outline-accent-300">
                {label}
              </Link>
            ))}
            <a href={REPO_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded transition-colors hover:text-white focus-visible:outline-accent-300">
              Open source
              <ArrowUpRight size={12} weight="bold" aria-hidden />
            </a>
          </nav>
        </div>
      </div>
    </footer>
  );
}
