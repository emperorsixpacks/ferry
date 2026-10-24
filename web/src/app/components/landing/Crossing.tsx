import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { TokenLogo } from "../Logos";
import { ScrambleText } from "../ScrambleText";
import { cn } from "../../lib/utils";
import { BTC, CoinMark, LTC, eth, usdc, type Coin } from "./coins";
import { useOnScreen, useReducedMotion } from "./motion";

// The landing's hero: the crossing. A light shore above, the shielded pool (the page's one dark
// band) below. A coin drifts in on the left, sinks through the surface, crosses the pool as
// shielded ZEC with its amount scrambled into noise, and surfaces on the right as another coin.
//
// Each traveller is drawn twice, once in the sky layer (as the coin) and once in the pool layer
// (as shielded ZEC). Each layer clips at the waterline, so a coin turns into ZEC exactly where it
// passes through the surface. Positions are written straight to the DOM from one
// requestAnimationFrame loop that runs only while the scene is on screen and the tab is visible.
// With reduced motion the same scene is a still diagram: the coin on the left, the ZEC in the
// pool, the coin on the right, joined by the path.

interface Trip {
  from: Coin;
  to: Coin;
  send: string;
  get: string;
}

// Example amounts at rough market ratios; the scene says they are examples.
const TRIPS: Trip[] = [
  { from: BTC, to: usdc("base"), send: "0.042", get: "4,170" },
  { from: LTC, to: eth("arbitrum"), send: "12.5", get: "0.30" },
  { from: usdc("optimism"), to: BTC, send: "2,500", get: "0.0248" },
  { from: eth("ethereum"), to: LTC, send: "0.80", get: "32.6" },
  { from: BTC, to: eth("base"), send: "0.015", get: "0.38" },
  { from: LTC, to: usdc("arbitrum"), send: "20", get: "1,880" },
];

// seconds for one coin to cross; two cross at once, half a crossing apart
const PERIOD = 12;
const NOISE = "░▒▓█#%&@01";
// the still diagram: the first trip at three points
const STILL = [0.15, 0.5, 0.85];
const TWO = [0, 0];

const smooth = (t: number) => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};
// how deep a traveller is at u (0: on the surface lane, 1: deep in the pool)
const depth = (u: number) => (u < 0.5 ? smooth((u - 0.25) / 0.16) : 1 - smooth((u - 0.59) / 0.16));
// fade in on the left shore, out on the right
const fade = (u: number) => Math.min(1, u / 0.07, (1 - u) / 0.07);

interface Geometry {
  width: number;
  sky: number;
  pool: number;
  x0: number;
  x1: number;
  lane: number;
  deep: number;
}

const at = (g: Geometry, u: number) => ({ x: g.x0 + u * (g.x1 - g.x0), y: g.lane + depth(u) * (g.deep - g.lane) });

function measure(scene: HTMLElement, sky: HTMLElement): Geometry {
  const width = scene.clientWidth;
  const skyH = sky.offsetHeight;
  const poolH = scene.offsetHeight - skyH;
  const narrow = width < 640;
  const track = Math.min(width, 1200);
  const left = (width - track) / 2;
  const half = narrow ? 68 : 84;
  return {
    width,
    sky: skyH,
    pool: poolH,
    x0: left + half + 6,
    x1: left + track - half - 6,
    lane: skyH - (narrow ? 34 : 42),
    deep: skyH + poolH * (narrow ? 0.4 : 0.42),
  };
}

type Side = "from" | "to";
interface Shown {
  trip: number;
  side: Side;
}

export function Crossing({ className }: { className?: string }) {
  const reduced = useReducedMotion();
  const scene = useRef<HTMLDivElement>(null);
  const skyRef = useRef<HTMLDivElement>(null);
  const running = useOnScreen(scene) && !reduced;
  const [geo, setGeo] = useState<Geometry | null>(null);

  // the still diagram's three points, or the two travellers
  const us = reduced ? STILL : TWO;
  const [shown, setShown] = useState<Shown[]>(() => us.map(() => ({ trip: 0, side: "from" })));
  const skyEls = useRef<(HTMLDivElement | null)[]>([]);
  const poolEls = useRef<(HTMLDivElement | null)[]>([]);
  const ripples = useRef<(HTMLSpanElement | null)[]>([]);
  const lastY = useRef<number[]>([]);
  // the scene's own clock (s): it stops while the scene is off screen. It starts with the first
  // coin on the left shore and the second one surfacing on the right.
  const clock = useRef(PERIOD * 0.17);

  useLayoutEffect(() => {
    const el = scene.current;
    const sky = skyRef.current;
    if (!el || !sky) return;
    const on = () => setGeo(measure(el, sky));
    on();
    const ro = new ResizeObserver(on);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const place = useCallback(() => {
    if (!geo) return;
    const next: Shown[] = [];
    (reduced ? STILL : TWO).forEach((fixed, i) => {
      let u: number;
      let trip: number;
      if (reduced) {
        u = fixed;
        trip = 0;
      } else {
        const s = clock.current + (i * PERIOD) / 2;
        u = (s % PERIOD) / PERIOD;
        // trips in the order the coins set out: the second traveller started half a crossing early
        trip = 2 * Math.floor(s / PERIOD) - i;
      }
      next.push({ trip: ((trip % TRIPS.length) + TRIPS.length) % TRIPS.length, side: u < 0.5 ? "from" : "to" });
      const { x, y } = at(geo, u);
      const o = reduced ? 1 : fade(u);
      const sky = skyEls.current[i];
      const pool = poolEls.current[i];
      if (sky) {
        sky.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
        sky.style.opacity = String(o);
      }
      if (pool) {
        pool.style.transform = `translate3d(${x}px, ${y - geo.sky}px, 0) translate(-50%, -50%)`;
        pool.style.opacity = String(o);
      }
      // a ripple where the coin goes through the surface
      const prev = lastY.current[i];
      lastY.current[i] = y;
      const ripple = ripples.current[i];
      if (!reduced && ripple && prev !== undefined && prev < geo.sky !== y < geo.sky && Math.abs(prev - y) < 40) {
        ripple.style.left = `${x}px`;
        ripple.classList.remove("lp-ripple-go");
        void ripple.offsetWidth;
        ripple.classList.add("lp-ripple-go");
      }
    });
    setShown((cur) => (cur.length === next.length && cur.every((c, i) => c.trip === next[i].trip && c.side === next[i].side) ? cur : next));
  }, [geo, reduced]);

  // place once whenever the geometry changes (and for the still diagram)
  useLayoutEffect(place, [place]);

  useEffect(() => {
    if (!running) return;
    let last = performance.now();
    let id = requestAnimationFrame(function frame(now) {
      clock.current += Math.min(now - last, 100) / 1000;
      last = now;
      place();
      id = requestAnimationFrame(frame);
    });
    return () => cancelAnimationFrame(id);
  }, [running, place]);

  const path = geo ? pathFor(geo) : "";
  const trip0 = TRIPS[0];

  return (
    <div
      ref={scene}
      role="img"
      aria-label={`Illustration: ${trip0.send} ${trip0.from.ticker} drifts in on the left, sinks into Zcash's shielded pool, crosses it as shielded ZEC with its amount hidden, and comes out on the right as about ${trip0.get} ${trip0.to.ticker}.`}
      className={cn("relative w-full select-none", !running && "lp-paused", className)}
    >
      {/* the shore */}
      <div ref={skyRef} className="relative h-[112px] overflow-hidden sm:h-[136px]" aria-hidden>
        {geo ? (
          <>
            <span className="absolute -translate-x-1/2 text-[13px] text-slate-500" style={{ left: geo.x0, top: geo.lane - 48 }}>
              You send
            </span>
            <span className="absolute -translate-x-1/2 text-[13px] text-slate-500" style={{ left: geo.x1, top: geo.lane - 48 }}>
              You get
            </span>
          </>
        ) : null}
        {geo ? (
          <svg className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
            <path d={path} fill="none" stroke="#d4d4d8" strokeWidth="1.5" strokeDasharray="2 7" strokeLinecap="round" />
          </svg>
        ) : null}
        {us.map((_, i) => {
          const s = shown[i] ?? { trip: 0, side: "from" as Side };
          const t = TRIPS[s.trip];
          return (
            <div key={i} ref={(el) => void (skyEls.current[i] = el)} className="absolute top-0 left-0 will-change-transform" style={{ opacity: 0 }}>
              {s.side === "from" ? (
                <CoinChip coin={t.from} amount={t.send} />
              ) : (
                <CoinChip coin={t.to} amount={t.get} settle={!reduced} key={`to-${s.trip}`} />
              )}
            </div>
          );
        })}
      </div>

      {/* the shielded pool */}
      <div className="lp-pool relative h-[184px] overflow-hidden sm:h-[216px]" aria-hidden>
        <div className="lp-lattice" />
        <div className="lp-glow" />
        <div className="lp-sheen" />
        {geo ? (
          <svg className="absolute inset-x-0 w-full overflow-visible" style={{ top: -geo.sky, height: geo.sky + geo.pool }} aria-hidden>
            <path d={path} fill="none" stroke="#8089bf" strokeOpacity=".45" strokeWidth="1.5" strokeDasharray="2 7" strokeLinecap="round" />
          </svg>
        ) : null}
        {us.map((_, i) => (
          <div key={i} ref={(el) => void (poolEls.current[i] = el)} className="absolute top-0 left-0 will-change-transform" style={{ opacity: 0 }}>
            <ZecChip live={running} />
          </div>
        ))}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 mx-auto flex max-w-[1200px] items-end justify-between gap-6 px-4 pb-4 sm:px-6 sm:pb-6">
          <p className="max-w-[17rem] text-[13px] leading-snug sm:max-w-none">
            <span className="block font-medium text-accent-100">Zcash's shielded pool</span>
            <span className="block text-accent-300">Amounts, senders and receivers are encrypted here.</span>
          </p>
          <span className="shrink-0 text-xs text-accent-400">Example amounts</span>
        </div>
      </div>

      {/* ripples sit on the waterline, over both layers */}
      {us.map((_, i) => (
        <span key={i} ref={(el) => void (ripples.current[i] = el)} className="lp-ripple" style={{ top: geo?.sky ?? 0 }} aria-hidden />
      ))}
    </div>
  );
}

// the travellers' path, sampled
function pathFor(g: Geometry) {
  const pts: string[] = [];
  for (let k = 0; k <= 60; k++) {
    const u = 0.06 + (k / 60) * 0.88;
    const { x, y } = at(g, u);
    pts.push(`${k ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return pts.join(" ");
}

function CoinChip({ coin, amount, settle }: { coin: Coin; amount: string; settle?: boolean }) {
  return (
    <span className="flex h-10 items-center gap-2 rounded-full border border-slate-200 bg-white py-1 pr-3.5 pl-1 whitespace-nowrap shadow-[0_10px_28px_-14px_rgba(24,24,27,0.35)] sm:h-11 sm:pr-4 sm:pl-1.5">
      <CoinMark coin={coin} size={28} className="sm:hidden" />
      <CoinMark coin={coin} size={30} className="hidden sm:inline-flex" />
      <span className="text-sm font-semibold text-slate-900 tabular-nums sm:text-[15px]">
        {settle
          ? // the digits settle out of noise as it surfaces; the separators stay put
            amount.split(/([.,])/).map((part, i) => (/^[.,]?$/.test(part) ? part : <ScrambleText key={i} text={part} mode="settle" delay={1500} duration={900} chars="0123456789" />))
          : amount}
      </span>
      <span className="text-sm text-slate-500 sm:text-[15px]">{coin.ticker}</span>
    </span>
  );
}

function ZecChip({ live }: { live: boolean }) {
  return (
    <span className="flex h-10 items-center gap-2 rounded-full border border-accent-300/20 bg-white/[0.06] py-1 pr-3.5 pl-1 whitespace-nowrap shadow-[0_0_36px_-6px_rgba(128,137,191,0.5)] sm:h-11 sm:pr-4 sm:pl-1.5">
      <TokenLogo id="zec" size={28} className="sm:hidden" />
      <TokenLogo id="zec" size={30} className="hidden sm:block" />
      <span className="font-data inline-block w-[6ch] overflow-hidden text-[13px] text-accent-100 sm:text-sm">
        {live ? <ScrambleText text="000000" mode="live" speed={90} chars={NOISE} /> : "▓░█▒#░"}
      </span>
      <span className="text-sm text-accent-300 sm:text-[15px]">ZEC</span>
    </span>
  );
}
