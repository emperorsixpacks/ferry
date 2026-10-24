import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { ArrowRight, Check, Wallet } from "@phosphor-icons/react";
import { cn } from "../../lib/utils";
import { Mark, type MarkId } from "./marks";
import { useOnScreen } from "./motion";

// How it works, in three steps, each with a small loop: the coin you pick keeps changing, a lock
// closes on both coins, a coin drops into a wallet with a tick. A line of light runs through the
// steps and fills as they scroll past.

const delay = (ms: number) => ({ "--lp-delay": `${ms}ms` }) as CSSProperties;

const STEPS: { title: string; body: string; art: ReactNode; c1: string; c2: string }[] = [
  {
    title: "Pick",
    body: "Choose what you have and what you want. Ferry finds the best rate from its swap partners.",
    art: <PickArt />,
    c1: "var(--lp-violet)",
    c2: "var(--lp-cyan)",
  },
  {
    title: "Lock",
    body: "Each side locks its own coins. Nobody else can move them, and a deadline sends them back if anything stalls.",
    art: <LockArt />,
    c1: "var(--lp-gold)",
    c2: "var(--lp-violet)",
  },
  {
    title: "Receive",
    body: "The swap releases both sides together, and your coins arrive on the chain you chose.",
    art: <ReceiveArt />,
    c1: "var(--lp-cyan)",
    c2: "var(--lp-magenta)",
  },
];

export function Steps() {
  const ref = useRef<HTMLOListElement>(null);
  const on = useOnScreen(ref);
  // the line's fill: from the list's top reaching the middle of the screen to its bottom doing so
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let queued = false;
    const update = () => {
      queued = false;
      const r = el.getBoundingClientRect();
      const mid = window.innerHeight * 0.6;
      el.style.setProperty("--lp-fill", String(Math.min(1, Math.max(0, (mid - r.top) / r.height))));
    };
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <ol ref={ref} className={cn("relative grid gap-6 md:grid-cols-3 md:gap-5", !on && "lp-paused")}>
      {/* the line through the steps */}
      <span className="pointer-events-none absolute top-[50px] right-[calc(33.333%-46px)] left-[50px] z-10 hidden h-px bg-white/10 md:block" aria-hidden>
        <span className="lp-progress absolute inset-0 bg-gradient-to-r from-[var(--lp-violet)] via-[var(--lp-gold)] to-[var(--lp-cyan)] shadow-[0_0_16px_rgb(244_183_40/0.8)]" />
      </span>
      {STEPS.map((s, i) => (
        <li key={s.title} data-reveal style={delay(i * 160)}>
          <div style={{ "--c1": s.c1, "--c2": s.c2 } as CSSProperties} className="lp-card relative h-full p-6 sm:p-7">
            <span className="relative z-20 flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/20 bg-[var(--lp-night-2)] text-[15px] font-semibold text-white tabular-nums shadow-[0_0_24px_-4px_var(--c1)]">
              {i + 1}
            </span>
            <div className="mt-4 flex h-[96px] items-center justify-center" aria-hidden>
              {s.art}
            </div>
            <h3 className="mt-5 text-2xl font-semibold tracking-tight text-white">{s.title}</h3>
            <p className="mt-2 text-[15px] leading-relaxed text-[var(--lp-muted)]">{s.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

const PICKS: MarkId[] = ["btc", "eth", "usdc", "sol"];

function PickArt() {
  return (
    <div className="flex items-center gap-3">
      <span className="flex h-12 items-center gap-2 rounded-full border border-white/15 bg-white/5 pr-4 pl-1.5">
        <span className="lp-pick relative block h-9 w-9">
          {PICKS.map((id) => (
            <span key={id} className="block">
              <Mark id={id} size={36} />
            </span>
          ))}
        </span>
        <span className="text-sm whitespace-nowrap text-[var(--lp-muted)]">You have</span>
      </span>
      <ArrowRight size={18} weight="bold" className="text-[var(--lp-gold)]" />
      <span className="flex h-12 items-center gap-2 rounded-full border border-[var(--lp-gold)]/40 bg-[var(--lp-gold)]/10 pr-4 pl-1.5">
        <Mark id="zec" size={36} />
        <span className="text-sm whitespace-nowrap text-[var(--lp-gold-hi)]">Shielded</span>
      </span>
    </div>
  );
}

function LockArt() {
  return (
    <div className="flex items-center gap-4">
      <Mark id="btc" size={36} />
      <span className="lp-lockbox relative flex h-16 w-14 items-end justify-center rounded-2xl">
        <svg viewBox="0 0 56 64" className="absolute inset-0 h-full w-full overflow-visible">
          <g className="lp-shackle">
            <path d="M17 30V20a11 11 0 0 1 22 0v10" fill="none" stroke="#FFE7A3" strokeWidth="5" strokeLinecap="round" />
          </g>
          <rect x="6" y="28" width="44" height="34" rx="10" fill="#2a2108" stroke="#F4B728" strokeWidth="2.5" />
          <circle cx="28" cy="43" r="4" fill="#F4B728" />
          <path d="M28 46v7" stroke="#F4B728" strokeWidth="3" strokeLinecap="round" />
        </svg>
      </span>
      <Mark id="zec" size={36} />
    </div>
  );
}

function ReceiveArt() {
  return (
    <div className="relative flex h-20 w-24 items-end justify-center">
      <span className="lp-drop absolute top-0 left-1/2 -ml-[18px] rounded-full shadow-[0_0_24px_rgb(39_117_202/0.7)]">
        <Mark id="usdc" size={36} />
      </span>
      <span className="flex h-12 w-20 items-center justify-center rounded-2xl border border-white/15 bg-white/5 text-[var(--lp-muted)]">
        <Wallet size={24} />
      </span>
      <span className="lp-tick absolute -right-1 bottom-7 flex h-7 w-7 items-center justify-center rounded-full bg-emerald-400 text-[#05210f] shadow-[0_0_20px_rgb(52_211_153/0.8)]">
        <Check size={15} weight="bold" />
      </span>
    </div>
  );
}
