import { useRef, type CSSProperties, type ReactNode } from "react";
import { Lock } from "@phosphor-icons/react";
import { cn } from "../../lib/utils";
import { ScrambleText } from "../ScrambleText";
import { Mark, type MarkId } from "./marks";
import { useOnScreen, useReducedMotion } from "./motion";

// Three proof points as big glowing cards, each with a small looping picture: a shield drawing
// itself round ciphertext (private), two coins trading places over a lock (no middleman), and coins
// circling shielded ZEC (any chain). The loops pause off screen. Facts as THREAT-MODEL.md and the
// NEAR Intents integration state them: the ZEC side is always shielded; a NEAR leg is public.

const delay = (ms: number) => ({ "--lp-delay": `${ms}ms` }) as CSSProperties;

export function Proof() {
  const ref = useRef<HTMLDivElement>(null);
  const on = useOnScreen(ref);
  const reduced = useReducedMotion();
  const live = on && !reduced;
  return (
    <div ref={ref} className={cn("grid gap-5 md:grid-cols-3", !on && "lp-paused")}>
      <Card
        i={0}
        c1="var(--lp-gold)"
        c2="var(--lp-violet)"
        title="Private"
        art={<ShieldArt live={live} />}
        body="Your ZEC never leaves Zcash's shielded pool, and no transaction links what you sell to what you get. The amounts and timing on the other chains are still public."
      />
      <Card
        i={1}
        c1="var(--lp-cyan)"
        c2="var(--lp-violet)"
        title="No middleman"
        art={<SwapArt />}
        body="Ferry's swaps are atomic: each side locks its own coins, and the swap releases both together. If anything fails, a deadline sends your coins back."
      />
      <Card
        i={2}
        c1="var(--lp-magenta)"
        c2="var(--lp-cyan)"
        title="Any chain"
        art={<OrbitArt />}
        body="Bitcoin, Litecoin, ETH and USDC swap directly across six chains. 200+ more assets on 37 chains come through NEAR Intents, which settles that leg in public. Your ZEC never goes to NEAR."
      />
    </div>
  );
}

function Card({ i, c1, c2, title, art, body }: { i: number; c1: string; c2: string; title: string; art: ReactNode; body: string }) {
  return (
    <div data-parallax={[0.04, 0.08, 0.04][i]}>
      <div data-reveal style={delay(i * 140)} className="h-full">
        <article style={{ "--c1": c1, "--c2": c2 } as CSSProperties} className="lp-card flex h-full flex-col p-7 sm:p-8">
          <div className="flex h-[132px] items-center justify-center" aria-hidden>
            {art}
          </div>
          <h3 className="mt-6 text-2xl font-semibold tracking-tight text-white">{title}</h3>
          <p className="mt-3 text-[15px] leading-relaxed text-[var(--lp-muted)]">{body}</p>
        </article>
      </div>
    </div>
  );
}

// a shield outline that draws itself, with ciphertext changing inside
function ShieldArt({ live }: { live: boolean }) {
  return (
    <div className="relative h-[124px] w-[112px]">
      <svg viewBox="0 0 112 124" className="absolute inset-0 h-full w-full overflow-visible">
        <defs>
          <linearGradient id="lp-shield" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#FFE7A3" />
            <stop offset="1" stopColor="#8B5CF6" />
          </linearGradient>
        </defs>
        <path d="M56 4 104 22v38c0 30-21 50-48 60C29 110 8 90 8 60V22z" fill="rgb(244 183 40 / 0.07)" stroke="rgb(255 231 163 / 0.18)" strokeWidth="2" />
        <path
          d="M56 4 104 22v38c0 30-21 50-48 60C29 110 8 90 8 60V22z"
          fill="none"
          stroke="url(#lp-shield)"
          strokeWidth="3"
          strokeLinejoin="round"
          pathLength="100"
          className="lp-shield-draw"
          style={{ filter: "drop-shadow(0 0 8px rgb(244 183 40 / 0.7))" }}
        />
      </svg>
      <div className="absolute inset-x-0 top-[38px] flex flex-col items-center font-data text-[13px] leading-tight text-[var(--lp-gold-hi)]">
        {["a9f3", "71c0", "e4d2"].map((t, j) => (
          <span key={t} className={j === 1 ? "opacity-100" : "opacity-60"}>
            {live ? <ScrambleText text={t} mode="live" speed={110 + j * 30} chars="0123456789abcdef░▒" /> : t}
          </span>
        ))}
      </div>
    </div>
  );
}

// two coins trading places over a lock
function SwapArt() {
  return (
    <div className="relative h-[100px] w-[210px]">
      <div className="absolute inset-x-6 top-1/2 h-px bg-gradient-to-r from-transparent via-[var(--lp-cyan)]/60 to-transparent" />
      <span className="lp-lock-pulse absolute top-1/2 left-1/2 -mt-6 -ml-6 flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--lp-cyan)]/50 bg-[#0b1b33] text-[var(--lp-cyan)]">
        <Lock size={22} weight="bold" />
      </span>
      <span className="lp-swap-a rounded-full shadow-[0_0_24px_rgb(247_147_26/0.6)]">
        <Mark id="btc" size={36} />
      </span>
      <span className="lp-swap-b rounded-full shadow-[0_0_24px_rgb(244_183_40/0.6)]">
        <Mark id="zec" size={36} />
      </span>
    </div>
  );
}

// coins circling shielded ZEC
const AROUND: MarkId[] = ["btc", "eth", "usdc", "ltc", "sol", "xrp"];
function OrbitArt() {
  return (
    <div className="relative h-[128px] w-[128px]">
      <div className="absolute inset-[14px] rounded-full border border-dashed border-white/15" />
      <div className="lp-spin absolute inset-0">
        {AROUND.map((id, j) => {
          const a = (j / AROUND.length) * Math.PI * 2;
          return (
            <span key={id} className="absolute -mt-[14px] -ml-[14px]" style={{ left: `${50 + 39 * Math.cos(a)}%`, top: `${50 + 39 * Math.sin(a)}%` }}>
              <span className="lp-spin-rev block rounded-full">
                <Mark id={id} size={28} />
              </span>
            </span>
          );
        })}
      </div>
      <span className="absolute top-1/2 left-1/2 -mt-[22px] -ml-[22px] rounded-full shadow-[0_0_40px_6px_rgb(244_183_40/0.45)]">
        <Mark id="zec" size={44} />
      </span>
    </div>
  );
}
