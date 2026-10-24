import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { ArrowRight, Check, Wallet } from "@phosphor-icons/react";
import { cn } from "../../lib/utils";
import { Mark, type MarkId } from "./marks";
import { useOnScreen } from "./motion";

// How it works, in three steps, each with a small slow loop: the coin you pick keeps changing, a
// lock closes between both coins, a coin drops into a wallet and a tick appears. A hairline runs
// through the steps and fills in ink as they scroll past.

const delay = (ms: number) => ({ "--lp-delay": `${ms}ms` }) as CSSProperties;

const STEPS: { title: string; body: string; art: ReactNode }[] = [
  { title: "Pick", body: "Choose what you have and what you want. Ferry finds the best rate from its swap partners.", art: <PickArt /> },
  { title: "Lock", body: "Each side locks its own coins. Nobody else can move them, and a deadline sends them back if anything stalls.", art: <LockArt /> },
  { title: "Receive", body: "The swap releases both sides together, and your coins arrive on the chain you chose.", art: <ReceiveArt /> },
];

export function Steps() {
  const ref = useRef<HTMLOListElement>(null);
  const on = useOnScreen(ref);
  // the line fills from the list's top reaching 60% down the screen to its bottom doing so
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let queued = false;
    const update = () => {
      queued = false;
      const r = el.getBoundingClientRect();
      el.style.setProperty("--lp-fill", String(Math.min(1, Math.max(0, (window.innerHeight * 0.6 - r.top) / r.height))));
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
    <ol ref={ref} className={cn("relative grid gap-5 md:grid-cols-3", !on && "lp-paused")}>
      <span className="pointer-events-none absolute top-[50px] right-[calc(33.333%-46px)] left-[50px] z-10 hidden h-px bg-slate-200 md:block" aria-hidden>
        <span className="lp-progress absolute inset-0 bg-slate-900" />
      </span>
      {STEPS.map((s, i) => (
        <li key={s.title} data-reveal style={delay(i * 140)}>
          <div className="lp-card relative h-full rounded-[28px] border border-slate-200 bg-white p-6 sm:p-7">
            <span className="relative z-20 flex h-11 w-11 items-center justify-center rounded-full bg-slate-900 text-[15px] font-semibold text-white tabular-nums">{i + 1}</span>
            <div className="mt-4 flex h-[92px] items-center justify-center" aria-hidden>
              {s.art}
            </div>
            <h3 className="mt-4 text-xl font-semibold tracking-tight text-slate-900">{s.title}</h3>
            <p className="mt-2 text-[15px] leading-relaxed text-slate-600">{s.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

const PICKS: MarkId[] = ["btc", "eth", "usdc", "sol"];

function PickArt() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-11 items-center gap-2 rounded-full border border-slate-200 bg-white pr-3.5 pl-1.5">
        <span className="lp-pick relative block h-8 w-8">
          {PICKS.map((id) => (
            <span key={id} className="block">
              <Mark id={id} size={32} />
            </span>
          ))}
        </span>
        <span className="text-sm whitespace-nowrap text-slate-600">You have</span>
      </span>
      <ArrowRight size={16} weight="bold" className="text-slate-400" />
      <span className="flex h-11 items-center gap-2 rounded-full border border-slate-200 bg-white pr-3.5 pl-1.5">
        <Mark id="zec" size={32} />
        <span className="text-sm whitespace-nowrap text-slate-600">Shielded</span>
      </span>
    </div>
  );
}

function LockArt() {
  return (
    <div className="flex items-center gap-4">
      <Mark id="btc" size={32} />
      <span className="relative block h-[60px] w-[52px]">
        <svg viewBox="0 0 52 60" className="absolute inset-0 h-full w-full overflow-visible">
          <g className="lp-shackle">
            <path d="M15 28V19a11 11 0 0 1 22 0v9" fill="none" stroke="#18181b" strokeWidth="3.5" strokeLinecap="round" />
          </g>
          <rect x="5" y="26" width="42" height="32" rx="9" fill="#fff" stroke="#18181b" strokeWidth="2" />
          <circle cx="26" cy="40" r="3.5" fill="#18181b" />
          <path d="M26 43v6" stroke="#18181b" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      </span>
      <Mark id="zec" size={32} />
    </div>
  );
}

function ReceiveArt() {
  return (
    <div className="relative flex h-[84px] w-24 items-end justify-center">
      <span className="lp-drop absolute top-0 left-1/2 -ml-4 rounded-full">
        <Mark id="usdc" size={32} />
      </span>
      <span className="flex h-11 w-[72px] items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-500">
        <Wallet size={22} />
      </span>
      <span className="lp-tick absolute -right-1 bottom-6 flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 text-white">
        <Check size={13} weight="bold" />
      </span>
    </div>
  );
}
