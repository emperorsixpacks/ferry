import { useRef, useState, type ReactNode } from "react";
import { ArrowDown, CaretDown, Eye, FlagPennant, ShieldCheck, Wallet } from "@phosphor-icons/react";
import { Link } from "@/router";
import { coin } from "@/format";
import { btcText } from "@/swap/shared";
import { useLocal } from "../../lib/daemon";
import { bestMaker, counterFor, quoteOf, selectable, type Makers } from "../../lib/makers";
import { pairName } from "../../lib/pairs";
import { secondsLeft, useQuotes } from "../../lib/quotes";
import { cn } from "../../lib/utils";
import { PairLogo, TokenLogo } from "../Logos";
import { ScrambleText } from "../ScrambleText";
import { TokenPicker } from "../TokenPicker";
import { BTC, CoinMark, usdc } from "./coins";
import { useOnScreen, useReducedMotion } from "./motion";

// The landing's four small demos, built from the app's own parts: a live quote from the best
// partner, a private swap crossing the pool, a firm price counting down, and the deadline that
// brings coins home. Each loop pauses off screen; reduced motion shows each one still.

const card = "rounded-[28px] border border-slate-200 bg-white shadow-[0_24px_64px_-36px_rgba(24,24,27,0.28)]";

// The partner with the best rate for 1 ZEC on the coin on screen, from the server's partner list
// (GET /api/makers), never the local node's own offer.
function useBest(makers: Makers) {
  const { role } = useLocal();
  const usable = makers.list ? makers.list.filter((m) => selectable(m, role)) : [];
  const maker = bestMaker(usable, 1e8, role);
  const quote = maker ? quoteOf(maker) : null;
  return { maker, quote, role };
}

function rateLine(makers: Makers, best: ReturnType<typeof useBest>): string {
  if (makers.list === undefined) return "Finding the best rate…";
  if (makers.list === null) return "This server lists no swap partners yet.";
  if (!best.quote || !best.maker) return "No partner is taking swaps for this coin right now.";
  return `1 ZEC = ${btcText(best.quote.rate)} ${coin().ticker} · best rate, from ${best.maker.name}`;
}

// --- 1. one step: the swap card's two boxes, quoting 1 ZEC live ------------------------------------
export function QuoteDemo({ makers }: { makers: Makers }) {
  const d = useLocal();
  const [picker, setPicker] = useState(false);
  const best = useBest(makers);
  const out = best.quote ? counterFor(best.quote, 1e8, d.role) : 0;
  const name = pairName(d.pair);
  const z = d.role === "Z";
  const zecSide = (
    <QuotePanel label={z ? "You sell" : "You get"} pill={<ZecPill />}>
      <span className="text-slate-900">1</span>
    </QuotePanel>
  );
  const coinSide = (
    <QuotePanel
      label={z ? "You get" : "You pay"}
      pill={
        <button
          type="button"
          onClick={() => setPicker(true)}
          aria-haspopup="dialog"
          aria-label={`${name.noun}. Choose another coin`}
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-white pr-3 pl-1.5 shadow-[0_1px_2px_rgba(24,24,27,0.06)] transition-colors hover:border-slate-300 hover:bg-slate-50"
        >
          <PairLogo pair={d.pair} size={28} />
          <span className="text-[15px] font-semibold text-slate-900">{name.label}</span>
          <CaretDown size={14} weight="bold" className="text-slate-500" aria-hidden />
        </button>
      }
    >
      <span className={out ? "text-slate-900" : "text-slate-300"}>{out ? `≈ ${btcText(out)}` : "–"}</span>
    </QuotePanel>
  );
  return (
    <div className={cn(card, "w-full max-w-[440px] p-2")}>
      <div className="flex flex-col">
        {z ? zecSide : coinSide}
        <div className="relative z-10 -my-[18px] flex justify-center" aria-hidden>
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl border-4 border-white bg-slate-100 text-slate-700">
            <ArrowDown size={16} weight="bold" />
          </span>
        </div>
        {z ? coinSide : zecSide}
      </div>
      <p className="min-h-10 px-3 pt-3 pb-1 text-[13px] text-slate-500" aria-live="polite">
        {rateLine(makers, best)}
      </p>
      <Link to="/app" className="mt-1 flex h-14 w-full items-center justify-center rounded-2xl bg-slate-900 text-base font-semibold text-white transition-colors hover:bg-slate-800">
        {z ? "Sell ZEC" : "Buy ZEC"} in the app
      </Link>
      <TokenPicker open={picker} onClose={() => setPicker(false)} makers={makers} role={d.role} />
    </div>
  );
}

function ZecPill() {
  return (
    <span className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-white pr-3.5 pl-1.5 shadow-[0_1px_2px_rgba(24,24,27,0.06)]">
      <TokenLogo id="zec" size={28} />
      <span className="text-[15px] font-semibold text-slate-900">ZEC</span>
    </span>
  );
}

function QuotePanel({ label, pill, children }: { label: string; pill: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-3xl bg-slate-50 px-5 py-4">
      <p className="text-xs font-medium tracking-wider text-slate-500 uppercase">{label}</p>
      <div className="mt-2 flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-[28px] leading-tight font-medium tracking-tight tabular-nums sm:text-[32px]">{children}</span>
        {pill}
      </div>
    </div>
  );
}

// --- 2. a private swap: two public swaps with the pool between them -------------------------------
export function RouteDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const running = useOnScreen(ref) && !reduced;
  return (
    <div
      ref={ref}
      role="img"
      aria-label="A private swap from Bitcoin to USDC. Swap 1, 0.042 BTC for shielded ZEC, is public, at 14:02. Then the ZEC waits in the shielded pool, hidden, for a random pause. Swap 2, the ZEC for 4,170 USDC, is public, at 14:31."
      className={cn(card, "w-full max-w-[460px] p-3 sm:p-4", !running && "lp-paused")}
    >
      <div aria-hidden className="flex flex-col gap-2">
        <Leg coin={<CoinMark coin={BTC} size={32} />} amount="0.042 BTC" title="Swap 1 · BTC for ZEC" time="14:02" glow="lp-route-a" />
        <Wire dot="lp-route-dot1" />
        <div className="lp-pool relative overflow-hidden rounded-[22px] px-4 py-4">
          <div className="lp-lattice" />
          <div className="lp-glow" />
          <div className="relative flex items-center gap-3">
            <TokenLogo id="zec" size={32} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-accent-100">Shielded ZEC</p>
              <p className="font-data text-[13px] text-accent-300">{running ? <ScrambleText text="00.000000" mode="live" speed={110} chars="░▒▓█#%01" /> : "▓░█▒.░#▓▒░"}</p>
            </div>
            <PauseRing />
          </div>
          <p className="relative mt-3 text-[13px] text-accent-300">Hidden. Then a random pause, 5 to 30 minutes.</p>
        </div>
        <Wire dot="lp-route-dot2" />
        <Leg coin={<CoinMark coin={usdc("base")} size={32} />} amount="4,170 USDC" title="Swap 2 · ZEC for USDC" time="14:31" glow="lp-route-c" />
      </div>
    </div>
  );
}

function Leg({ coin, amount, title, time, glow }: { coin: ReactNode; amount: string; title: string; time: string; glow: string }) {
  return (
    <div className={cn("lp-loop flex items-center gap-3 rounded-[22px] border border-slate-200 bg-slate-50 px-4 py-3", glow)}>
      {coin}
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold text-slate-900 tabular-nums">{amount}</p>
        <p className="text-[13px] text-slate-500">{title}</p>
      </div>
      <div className="text-right">
        <p className="text-[13px] font-medium text-slate-700 tabular-nums">{time}</p>
        <p className="text-xs text-slate-500">public</p>
      </div>
    </div>
  );
}

function Wire({ dot }: { dot: string }) {
  return (
    <div className="relative mx-auto h-5 w-px bg-slate-200">
      <span className={cn("lp-loop absolute -left-[3px] h-[7px] w-[7px] rounded-full bg-accent-500", dot)} />
    </div>
  );
}

function PauseRing() {
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" className="shrink-0 -rotate-90">
      <circle cx="18" cy="18" r="14" fill="none" stroke="#aab1d6" strokeOpacity=".2" strokeWidth="3" />
      <circle className="lp-loop lp-route-pause" cx="18" cy="18" r="14" fill="none" stroke="#aab1d6" strokeWidth="3" strokeLinecap="round" pathLength="100" strokeDasharray="100" />
    </svg>
  );
}

// --- 3. a firm price, signed, counting down --------------------------------------------------------
export function FirmDemo({ makers }: { makers: Makers }) {
  const d = useLocal();
  const ref = useRef<HTMLDivElement>(null);
  // ask for firm prices only while the card is (nearly) on screen
  const near = useOnScreen(ref, "200px 0px");
  const quotes = useQuotes(d.pair, d.role, near && Array.isArray(makers.list) ? 1e8 : 0);
  const best = useBest(makers);
  const firm = quotes.list[0] ?? null;
  const left = firm ? secondsLeft(firm, quotes.now) : 0;
  // the countdown's full circle: the most this price had left when first seen
  const total = useRef<{ id: string; s: number }>({ id: "", s: 1 });
  if (firm && total.current.id !== firm.quote_id) total.current = { id: firm.quote_id, s: Math.max(left, 1) };
  const rate = firm ? firm.rate_sat_per_zec : best.quote?.rate;
  const from = firm ? firm.maker : best.maker?.name;
  const ticker = coin().ticker;
  return (
    <div ref={ref} className={cn(card, "w-full max-w-[440px] p-5 sm:p-6")}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[15px] font-semibold text-slate-900">{firm ? "Firm price" : "Everyday rate"}</p>
          <p className="mt-1 flex min-h-5 items-center gap-1.5 text-[13px] text-slate-600">
            {firm ? (
              <>
                <ShieldCheck size={16} weight="fill" className="shrink-0 text-accent-500" aria-hidden />
                Signed by {from}, checked
              </>
            ) : from ? (
              `From ${from}`
            ) : (
              rateLine(makers, best)
            )}
          </p>
        </div>
        <Countdown left={firm ? left : 0} total={total.current.s} on={!!firm} />
      </div>
      <p className="mt-4 rounded-3xl bg-slate-50 px-5 py-4 text-[24px] leading-tight font-medium tracking-tight whitespace-nowrap text-slate-900 tabular-nums sm:text-[28px]">
        {rate != null ? (
          <>
            1 ZEC = {btcText(rate)} <span className="text-slate-500">{ticker}</span>
          </>
        ) : (
          <span className="text-slate-300">–</span>
        )}
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2 text-[13px]">
        <div className="rounded-2xl border border-slate-100 px-4 py-3">
          <p className="text-slate-500">Partners are told</p>
          <p className="mt-0.5 font-medium text-slate-900">0.5 to 1 ZEC</p>
        </div>
        <div className="rounded-2xl border border-slate-100 px-4 py-3">
          <p className="text-slate-500">Your swap gets</p>
          <p className="mt-0.5 font-medium text-slate-900">Exactly this rate</p>
        </div>
      </div>
    </div>
  );
}

function Countdown({ left, total, on }: { left: number; total: number; on: boolean }) {
  const r = 26;
  const frac = on ? Math.max(0, Math.min(1, left / total)) : 0;
  return (
    <div className="relative h-16 w-16 shrink-0" role="timer" aria-label={on ? `Firm for ${left} more seconds` : "No firm price"}>
      <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90" aria-hidden>
        <circle cx="32" cy="32" r={r} fill="none" stroke="#f1f1f3" strokeWidth="5" />
        <circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke="#5f69a8"
          strokeWidth="5"
          strokeLinecap="round"
          pathLength="100"
          strokeDasharray="100"
          strokeDashoffset={100 - frac * 100}
          className="transition-[stroke-dashoffset] duration-1000 ease-linear motion-reduce:transition-none"
        />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center leading-none" aria-hidden>
        <span className="text-[17px] font-semibold text-slate-900 tabular-nums">{on ? left : "–"}</span>
        <span className="mt-0.5 text-[10px] text-slate-500">sec</span>
      </span>
    </div>
  );
}

// --- 4. the safety net: a deadline brings your coins back ------------------------------------------
const STEPS = ["You lock your coins.", "Your partner stops answering.", "The deadline passes.", "Your coins come back to you."];

export function SafetyDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const running = useOnScreen(ref) && !reduced;
  return (
    <div ref={ref} className={cn(card, "w-full max-w-[460px] p-5 sm:p-6", !running && "lp-paused")}>
      {reduced ? (
        <ol className="space-y-3">
          {STEPS.map((s, i) => (
            <li key={s} className="flex items-center gap-3 text-[15px] text-slate-700">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[13px] font-semibold text-slate-700 tabular-nums">{i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
      ) : (
        <div role="img" aria-label={`A swap that stops halfway: ${STEPS.join(" ")}`}>
          <div aria-hidden className="relative h-[92px]">
            {/* you, the lock in the middle, your partner */}
            <span className="absolute top-3 left-0 flex w-14 flex-col items-center gap-1.5">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-slate-700">
                <Wallet size={20} />
              </span>
              <span className="text-xs text-slate-500">You</span>
            </span>
            <span className="absolute top-3 left-1/2 flex w-16 -translate-x-1/2 flex-col items-center gap-1.5">
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-dashed border-slate-300" />
              <span className="text-xs text-slate-500">Locked</span>
            </span>
            <span className="lp-loop lp-safe-partner absolute top-3 right-0 flex w-14 flex-col items-center gap-1.5">
              <span className="relative flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-700">
                K
                <span className="lp-loop lp-safe-dot absolute right-0 bottom-0 h-3 w-3 rounded-full border-2 border-white" />
              </span>
              <span className="text-xs text-slate-500">Partner</span>
            </span>
            {/* your coin: out to the lock, then home */}
            <span className="lp-loop lp-safe-coin absolute top-[20px] left-[14px]">
              <TokenLogo id="btc" size={28} />
            </span>
          </div>
          {/* the clock to the deadline */}
          <div className="mt-7">
            <div className="relative h-2 rounded-full bg-slate-100">
              <span className="lp-loop lp-safe-bar absolute inset-y-0 left-0 w-full origin-left rounded-full bg-slate-400" />
              <span className="lp-loop lp-safe-flag absolute -top-[22px] -right-[3px] text-slate-400">
                <FlagPennant size={18} weight="fill" />
              </span>
            </div>
            <div className="mt-1.5 flex justify-between text-xs text-slate-500">
              <span>Swap starts</span>
              <span>Deadline</span>
            </div>
          </div>
          <div className="relative mt-4 h-6 text-[15px] font-medium text-slate-900">
            {STEPS.map((s, i) => (
              <span key={s} className={cn("lp-loop absolute inset-0", `lp-safe-say${i + 1}`)}>
                {s}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="mt-5 flex items-start gap-3 rounded-2xl bg-slate-50 px-4 py-3 text-[13px] leading-relaxed text-slate-600">
        <Eye size={20} className="mt-0.5 shrink-0 text-slate-700" aria-hidden />
        <span>Away from your computer? A watchtower can keep the deadlines for you.</span>
      </div>
    </div>
  );
}
