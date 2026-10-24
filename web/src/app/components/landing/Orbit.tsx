import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChainLogo, TokenLogo, type ChainMarkId } from "../Logos";
import { cn } from "../../lib/utils";
import { BTC, CoinMark, LTC, eth, usdc, type Coin } from "./coins";
import { useOnScreen, useReducedMotion } from "./motion";

// The chains, as an orbit around shielded ZEC: every swap goes through it. The ring turns slowly
// and one chain at a time lifts, with its name; the panel beside it says what you can swap there,
// what the chain sees and how long it takes. The chains are tabs: arrow keys move between them,
// and hovering or focusing holds the ring still. Reduced motion: a still ring, no auto-advance.

interface Chain {
  id: ChainMarkId;
  name: string;
  coins: Coin[];
  sees: string;
  time: string;
}

const PAYMENT = "An ordinary payment from one wallet to another.";
const CONTRACT = "A call to Ferry's swap contract.";
const EVM = "Under 10 minutes";

const CHAINS: Chain[] = [
  { id: "bitcoin", name: "Bitcoin", coins: [BTC], sees: PAYMENT, time: "About half an hour" },
  { id: "ethereum", name: "Ethereum", coins: [usdc("ethereum"), eth("ethereum")], sees: CONTRACT, time: EVM },
  { id: "base", name: "Base", coins: [usdc("base"), eth("base")], sees: CONTRACT, time: EVM },
  { id: "litecoin", name: "Litecoin", coins: [LTC], sees: PAYMENT, time: "Around 15 minutes" },
  { id: "arbitrum", name: "Arbitrum", coins: [usdc("arbitrum"), eth("arbitrum")], sees: CONTRACT, time: EVM },
  { id: "optimism", name: "Optimism", coins: [usdc("optimism"), eth("optimism")], sees: CONTRACT, time: EVM },
];

const ADVANCE_MS = 3200;

export function Orbit({ children }: { children?: ReactNode }) {
  const reduced = useReducedMotion();
  const wrap = useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(wrap);
  const [active, setActive] = useState(0);
  const [hold, setHold] = useState(false);
  // once someone picks a chain, the ring stops choosing for them
  const [touched, setTouched] = useState(false);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();

  useEffect(() => {
    if (reduced || !onScreen || hold || touched) return;
    const t = setInterval(() => setActive((a) => (a + 1) % CHAINS.length), ADVANCE_MS);
    return () => clearInterval(t);
  }, [reduced, onScreen, hold, touched]);

  const pick = (i: number, focus = false) => {
    const n = (i + CHAINS.length) % CHAINS.length;
    setActive(n);
    setTouched(true);
    if (focus) tabs.current[n]?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    const keys: Record<string, number> = { ArrowRight: active + 1, ArrowDown: active + 1, ArrowLeft: active - 1, ArrowUp: active - 1, Home: 0, End: CHAINS.length - 1 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    pick(keys[e.key], true);
  };

  const c = CHAINS[active];
  return (
    <div
      ref={wrap}
      className={cn("grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-16", (!onScreen || hold) && "lp-orbit-hold")}
      onMouseEnter={() => setHold(true)}
      onMouseLeave={() => setHold(false)}
      onFocus={() => setHold(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHold(false);
      }}
    >
      <div className="contents lg:block">
        {children}
        <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${active}`} className="order-last rounded-[28px] border border-slate-200 bg-white p-6 sm:p-7 lg:order-none lg:mt-10">
          <div className="flex items-center gap-3">
            <ChainLogo id={c.id} size={36} />
            <h3 className="text-2xl font-semibold tracking-tight text-slate-900">{c.name}</h3>
          </div>
          <dl className="mt-6 grid gap-5 text-[15px] sm:grid-cols-3 sm:gap-6">
            <div>
              <dt className="text-[13px] text-slate-500">Swap ZEC for</dt>
              <dd className="mt-1.5 flex items-center gap-2 font-medium text-slate-900">
                <span className="flex -space-x-1.5">
                  {c.coins.map((k) => (
                    <span key={k.ticker} className="rounded-full bg-white p-px">
                      {/* the chain is the panel's title, so no chain badges here */}
                      <CoinMark coin={{ ...k, chain: undefined }} size={22} />
                    </span>
                  ))}
                </span>
                {c.coins.map((k) => k.ticker).join(" or ")}
              </dd>
            </div>
            <div>
              <dt className="text-[13px] text-slate-500">What the chain sees</dt>
              <dd className="mt-1.5 text-slate-900">{c.sees}</dd>
            </div>
            <div>
              <dt className="text-[13px] text-slate-500">How long</dt>
              <dd className="mt-1.5 text-slate-900">{c.time} on the main network</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className={cn("relative mx-auto aspect-square w-[min(100%,340px)] sm:w-[420px] lg:w-[360px] xl:w-[420px]", !onScreen && "lp-paused")}>
        {/* the ring and its spokes turn; the shielded centre stays */}
        <div className="lp-orbit absolute inset-0">
          <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full" aria-hidden>
            <circle cx="50" cy="50" r="41" fill="none" stroke="#e4e4e7" strokeWidth=".3" strokeDasharray=".6 1.6" />
            {CHAINS.map((ch, i) => {
              const a = ((i * 360) / CHAINS.length - 90) * (Math.PI / 180);
              return (
                <line
                  key={ch.id}
                  x1={50 + 17 * Math.cos(a)}
                  y1={50 + 17 * Math.sin(a)}
                  x2={50 + 34 * Math.cos(a)}
                  y2={50 + 34 * Math.sin(a)}
                  stroke={i === active ? "#8089bf" : "#e4e4e7"}
                  strokeWidth={i === active ? ".5" : ".35"}
                  className="transition-[stroke] duration-500"
                />
              );
            })}
          </svg>
          <div role="tablist" aria-label="Chains" aria-orientation="horizontal" onKeyDown={onKey}>
            {CHAINS.map((ch, i) => {
              const a = ((i * 360) / CHAINS.length - 90) * (Math.PI / 180);
              const on = i === active;
              return (
                <div key={ch.id} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${50 + 41 * Math.cos(a)}%`, top: `${50 + 41 * Math.sin(a)}%` }}>
                  <div className="lp-orbit-upright relative">
                    <button
                      ref={(el) => void (tabs.current[i] = el)}
                      id={`${id}-tab-${i}`}
                      type="button"
                      role="tab"
                      aria-selected={on}
                      aria-controls={`${id}-panel`}
                      tabIndex={on ? 0 : -1}
                      onClick={() => pick(i)}
                      onMouseEnter={() => pick(i)}
                      className={cn(
                        "flex h-14 w-14 items-center justify-center rounded-full border bg-white transition-[transform,box-shadow,border-color] duration-500 ease-out motion-reduce:transition-none sm:h-16 sm:w-16",
                        on
                          ? "scale-[1.18] border-accent-300 shadow-[0_0_0_5px_var(--color-accent-100),0_16px_32px_-14px_rgba(24,24,27,0.35)]"
                          : "border-slate-200 shadow-[0_8px_20px_-14px_rgba(24,24,27,0.3)] hover:border-slate-300",
                      )}
                    >
                      <ChainLogo id={ch.id} size={30} label={ch.name} />
                    </button>
                    <span
                      className={cn(
                        "pointer-events-none absolute top-full left-1/2 mt-3 -translate-x-1/2 rounded-full border border-slate-200 bg-white px-2.5 py-0.5 text-[13px] font-medium whitespace-nowrap text-slate-900 shadow-[0_4px_12px_-8px_rgba(24,24,27,0.3)] transition-opacity duration-300",
                        on ? "opacity-100" : "opacity-0",
                      )}
                      aria-hidden
                    >
                      {ch.name}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {/* the centre: a drop of the shielded pool */}
        <div className="lp-pool absolute top-1/2 left-1/2 flex h-[34%] w-[34%] -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center overflow-hidden rounded-full shadow-[0_0_0_8px_rgba(95,105,168,0.08),0_24px_48px_-20px_rgba(14,16,36,0.6)]">
          <div className="lp-lattice" />
          <div className="lp-glow" />
          <TokenLogo id="zec" size={40} className="relative" />
          <span className="relative mt-2 text-[12px] font-medium text-accent-100 sm:text-[13px]">Shielded ZEC</span>
        </div>
      </div>
    </div>
  );
}
