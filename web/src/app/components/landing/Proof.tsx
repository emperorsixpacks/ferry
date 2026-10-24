import { useRef, type CSSProperties, type ReactNode } from "react";
import { Lock } from "@phosphor-icons/react";
import { cn } from "../../lib/utils";
import { ScrambleText } from "../ScrambleText";
import { Mark, type MarkId } from "./marks";
import { useOnScreen, useReducedMotion } from "./motion";

// Three proof points as white cards with hairline borders, each with a small, slow loop in ink: a
// shield outlining itself round ciphertext (private), two coins trading places over a lock (no
// middleman), coins circling shielded ZEC (any chain). The loops pause off screen. Facts as
// THREAT-MODEL.md and the NEAR Intents integration state them: the ZEC side is always shielded; a
// NEAR leg is public.

const delay = (ms: number) => ({ "--lp-delay": `${ms}ms` }) as CSSProperties;

export function Proof() {
  const ref = useRef<HTMLDivElement>(null);
  const on = useOnScreen(ref);
  const reduced = useReducedMotion();
  return (
    <div ref={ref} className={cn("grid gap-5 md:grid-cols-3", !on && "lp-paused")}>
      <Card
        i={0}
        title="Private"
        art={<ShieldArt live={on && !reduced} />}
        body="Your ZEC never leaves Zcash's shielded pool, and no transaction links what you sell to what you get. The amounts and timing on the other chains are still public."
      />
      <Card
        i={1}
        title="No middleman"
        art={<SwapArt />}
        body="Ferry's swaps are atomic: each side locks its own coins, and the swap releases both together. If anything fails, a deadline sends your coins back."
      />
      <Card
        i={2}
        title="Any chain"
        art={<OrbitArt />}
        body="Bitcoin, Litecoin, ETH and USDC swap directly across six chains. 200+ more assets on 37 chains come through NEAR Intents, which settles that leg in public. Your ZEC never goes to NEAR."
      />
    </div>
  );
}

function Card({ i, title, art, body }: { i: number; title: string; art: ReactNode; body: string }) {
  return (
    <div data-reveal style={delay(i * 120)} className="h-full">
      <article className="lp-card flex h-full flex-col rounded-[28px] border border-slate-200 bg-white p-7 sm:p-8">
        <div className="flex h-[124px] items-center justify-center" aria-hidden>
          {art}
        </div>
        <h3 className="mt-6 text-xl font-semibold tracking-tight text-slate-900">{title}</h3>
        <p className="mt-2 text-[15px] leading-relaxed text-slate-600">{body}</p>
      </article>
    </div>
  );
}

// a shield outlining itself, with ciphertext changing slowly inside
function ShieldArt({ live }: { live: boolean }) {
  const shield = "M48 4 88 19v32c0 26-18 43-40 52C26 94 8 77 8 51V19z";
  return (
    <div className="relative h-[110px] w-[96px]">
      <svg viewBox="0 0 96 110" className="absolute inset-0 h-full w-full overflow-visible">
        <path d={shield} className="fill-[#fafafa] stroke-slate-200 dark:fill-slate-50" strokeWidth="1.5" strokeLinejoin="round" />
        <path d={shield} fill="none" strokeWidth="1.75" strokeLinejoin="round" pathLength="100" className="lp-shield-draw stroke-slate-900" />
      </svg>
      <div className="font-data absolute inset-x-0 top-[34px] flex flex-col items-center text-[12px] leading-tight text-slate-500">
        {["a9f3", "71c0", "e4d2"].map((t, j) => (
          <span key={t}>{live ? <ScrambleText text={t} mode="live" speed={260 + j * 90} chars="0123456789abcdef" /> : t}</span>
        ))}
      </div>
    </div>
  );
}

// two coins trading places over a lock
function SwapArt() {
  return (
    <div className="relative h-[96px] w-[200px]">
      <div className="absolute inset-x-6 top-1/2 h-px bg-slate-200" />
      <span className="lp-lock absolute top-1/2 left-1/2 -mt-[22px] -ml-[22px] flex h-11 w-11 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-[0_6px_16px_-8px_rgba(24,24,27,0.25)]">
        <Lock size={20} weight="bold" />
      </span>
      <span className="lp-swap-a rounded-full shadow-[0_4px_12px_-4px_rgba(24,24,27,0.3)]">
        <Mark id="btc" size={34} />
      </span>
      <span className="lp-swap-b rounded-full shadow-[0_4px_12px_-4px_rgba(24,24,27,0.3)]">
        <Mark id="zec" size={34} />
      </span>
    </div>
  );
}

// coins circling shielded ZEC
const AROUND: MarkId[] = ["btc", "eth", "usdc", "ltc", "sol", "xrp"];
function OrbitArt() {
  return (
    <div className="relative h-[120px] w-[120px]">
      <div className="absolute inset-[13px] rounded-full border border-slate-200" />
      <div className="lp-spin absolute inset-0">
        {AROUND.map((id, j) => {
          const a = (j / AROUND.length) * Math.PI * 2;
          return (
            <span key={id} className="absolute -mt-[13px] -ml-[13px]" style={{ left: `${50 + 39 * Math.cos(a)}%`, top: `${50 + 39 * Math.sin(a)}%` }}>
              <span className="lp-spin-rev block rounded-full bg-white">
                <Mark id={id} size={26} />
              </span>
            </span>
          );
        })}
      </div>
      <span className="absolute top-1/2 left-1/2 -mt-[20px] -ml-[20px] rounded-full shadow-[0_6px_16px_-6px_rgba(24,24,27,0.35)]">
        <Mark id="zec" size={40} />
      </span>
    </div>
  );
}
