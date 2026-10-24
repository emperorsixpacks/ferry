import { useRef, type CSSProperties } from "react";
import { ArrowDown, ArrowRight } from "@phosphor-icons/react";
import { Link } from "@/router";
import { SiteFooter, SiteHeader } from "../components/Layout";
import { Gate } from "../components/landing/Gate";
import { Mark } from "../components/landing/marks";
import { useReveal } from "../components/landing/motion";
import { Networks } from "../components/landing/Networks";
import { Proof } from "../components/landing/Proof";
import { DIRECT_CHAINS, NEAR_ASSETS, NEAR_CHAINS } from "../components/landing/stats";
import { Steps } from "../components/landing/Steps";
import { SwapWidget } from "../components/landing/SwapWidget";
import "../landing.css";

// `/`: the Shield Gate, on the app's own white. Coins drift into a hexagonal gate with Zcash's gold
// core and come out the other side as other coins. Then three proof points, the app's swap card
// quoting live, the networks, how it works in three steps, and one last call to start. Ink, greys
// and white, with Zcash gold only at the gate's core; coins and chains keep their colours inside
// their own marks. Sections rise into place as they scroll in (useReveal).
export function Landing() {
  const root = useRef<HTMLDivElement>(null);
  useReveal(root);
  return (
    <div ref={root} className="lp flex min-h-screen flex-col overflow-x-clip bg-white text-slate-900">
      <SiteHeader landing />
      <main className="flex-1">
        <Hero />
        <ProofSection />
        <TryIt />
        <NetworksSection />
        <How />
        <Closing />
      </main>
      <SiteFooter />
    </div>
  );
}

const delay = (ms: number) => ({ "--lp-delay": `${ms}ms` }) as CSSProperties;
const h2 = "text-[34px] leading-[1.06] font-semibold tracking-[-0.03em] text-slate-900 sm:text-[44px]";
const lede = "mt-4 text-[17px] leading-relaxed text-slate-600";
const primary = "inline-flex h-12 items-center justify-center rounded-full bg-slate-900 px-7 text-[15px] font-semibold text-white transition-colors hover:bg-slate-800";
const secondary =
  "inline-flex h-12 items-center justify-center gap-1.5 rounded-full border border-slate-200 bg-white px-6 text-[15px] font-medium text-slate-700 transition-colors hover:border-slate-300 hover:text-slate-900";

function Hero() {
  const anchor = useRef<HTMLDivElement>(null);
  return (
    <section aria-labelledby="hero-title" className="relative isolate overflow-hidden bg-white">
      <Gate anchor={anchor} />
      <div className="relative mx-auto flex max-w-6xl flex-col px-4 sm:min-h-[max(720px,calc(100svh-105px))] sm:px-6 md:min-h-[max(720px,calc(100svh-64px))]">
        <div className="order-2 mx-auto max-w-3xl pb-10 text-center sm:order-1 sm:pt-14 sm:pb-0 lg:pt-16">
          <h1 id="hero-title" className="text-[42px] leading-[1.03] font-semibold tracking-[-0.035em] text-slate-900 sm:text-6xl lg:text-[72px]">
            Every chain.{" "}
            <br />
            <span className="text-slate-500">One private path.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-[34rem] text-[17px] leading-relaxed text-slate-600 sm:text-lg">
            Swap BTC, ETH, USDC and 200+ more assets through Zcash's shielded pool. No account. Nobody holds your ZEC.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link to="/app" className={primary}>
              Start a swap
            </Link>
            <a href="#how" className={secondary}>
              How it works
              <ArrowDown size={14} weight="bold" aria-hidden />
            </a>
          </div>
          <p className="mt-6 text-sm text-slate-500">
            <span className="font-semibold text-slate-900 tabular-nums">{NEAR_ASSETS}</span> assets · <span className="font-semibold text-slate-900 tabular-nums">{NEAR_CHAINS}</span>{" "}
            chains · ZEC always shielded
          </p>
        </div>
        {/* where the gate stands: above the text on a phone, below it on wider screens */}
        <div ref={anchor} className="order-1 h-[260px] shrink-0 sm:order-2 sm:h-auto sm:min-h-[320px] sm:flex-1" aria-hidden />
      </div>
    </section>
  );
}

function ProofSection() {
  return (
    <section aria-labelledby="proof-title" className="border-t border-slate-100 bg-slate-50/70">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
        <h2 id="proof-title" data-reveal className={h2}>
          Private. Direct. Everywhere.
        </h2>
        <p data-reveal style={delay(80)} className={`${lede} max-w-[36rem]`}>
          Ferry swaps through Zcash's shielded pool, directly with the other side, and reaches most chains you use.
        </p>
        <div className="mt-12">
          <Proof />
        </div>
      </div>
    </section>
  );
}

function TryIt() {
  return (
    <section aria-labelledby="try-title" className="border-t border-slate-100">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-20 sm:px-6 sm:py-28 lg:grid-cols-[minmax(0,1fr)_440px] lg:gap-20">
        <div>
          <h2 id="try-title" data-reveal className={`${h2} max-w-[16ch]`}>
            See your price before you start.
          </h2>
          <p data-reveal style={delay(80)} className={`${lede} max-w-[32rem]`}>
            This is the app's own swap card, quoting 1 ZEC at the best partner's rate right now. Pick another coin to compare, then swap in the app.
          </p>
          <div data-reveal style={delay(160)} className="mt-8">
            <Link to="/app" className={primary}>
              Start a swap
            </Link>
          </div>
        </div>
        <div data-reveal style={delay(120)} className="mx-auto w-full max-w-[440px] rounded-[30px] border border-slate-200 bg-white shadow-[0_24px_64px_-32px_rgba(24,24,27,0.25)]">
          <SwapWidget />
        </div>
      </div>
    </section>
  );
}

function NetworksSection() {
  return (
    <section aria-labelledby="net-title" className="border-t border-slate-100 py-20 sm:py-28">
      <div className="mx-auto grid max-w-6xl items-end gap-10 px-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-16">
        <div>
          <h2 id="net-title" data-reveal className={`${h2} max-w-[20ch]`}>
            Six chains direct. {NEAR_CHAINS - DIRECT_CHAINS} more through NEAR Intents.
          </h2>
          <p data-reveal style={delay(80)} className={`${lede} max-w-[40rem]`}>
            Ferry swaps natively on Bitcoin, Litecoin, Ethereum, Base, Arbitrum and Optimism. NEAR Intents carries the rest, from Solana to XRP: that leg is public and settled by NEAR
            Intents, and your ZEC never goes to NEAR.
          </p>
        </div>
        <dl data-reveal style={delay(160)} className="flex gap-10 sm:gap-12">
          {(
            [
              [NEAR_ASSETS, "assets"],
              [NEAR_CHAINS, "chains"],
              [DIRECT_CHAINS, "direct chains"],
            ] as const
          ).map(([n, label]) => (
            <div key={label} className="flex flex-col">
              <dt className="order-2 mt-1 text-sm text-slate-500">{label}</dt>
              <dd className="order-1 text-[44px] leading-none font-semibold tracking-[-0.04em] text-slate-900 tabular-nums sm:text-[52px]">{n}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div data-reveal style={delay(200)} className="mt-12">
        <Networks />
      </div>
      <p className="mx-auto mt-6 max-w-6xl px-4 text-sm text-slate-500 sm:px-6">Each Ferry server offers some of these; the app lists the ones you can pick.</p>
    </section>
  );
}

function How() {
  return (
    <section id="how" aria-labelledby="how-title" className="scroll-mt-20 border-t border-slate-100 bg-slate-50/70">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
        <h2 id="how-title" data-reveal className={h2}>
          How it works
        </h2>
        <p data-reveal style={delay(80)} className={`${lede} max-w-[32rem]`}>
          Three steps and a few minutes. Ferry runs the swap for you; you can close the page while it finishes.
        </p>
        <div className="mt-12">
          <Steps />
        </div>
        <p data-reveal className="mt-10 text-[15px] text-slate-600">
          Curious what a chain analyst sees?{" "}
          <Link to="/privacy" className="inline-flex items-center gap-1 font-medium text-slate-900 underline decoration-slate-300 underline-offset-4 transition-colors hover:decoration-slate-900">
            Compare Ferry with a bridge and NEAR Intents
            <ArrowRight size={14} weight="bold" aria-hidden />
          </Link>
        </p>
      </div>
    </section>
  );
}

function Closing() {
  return (
    <section aria-labelledby="close-title" className="border-t border-slate-100">
      <div className="mx-auto max-w-3xl px-4 py-24 text-center sm:px-6 sm:py-32">
        <div data-reveal className="relative mx-auto mb-8 flex h-[92px] w-[80px] items-center justify-center" aria-hidden>
          <svg viewBox="0 0 80 92" className="absolute h-[92px] w-[80px] overflow-visible drop-shadow-[0_10px_18px_rgba(24,24,27,0.14)]">
            <path d="M40 2 78 24v44L40 90 2 68V24z" fill="#fff" stroke="#18181b" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
          <Mark id="zec" size={40} className="relative" />
        </div>
        <h2 id="close-title" data-reveal style={delay(80)} className="text-[38px] leading-[1.05] font-semibold tracking-[-0.035em] text-slate-900 sm:text-[52px]">
          Make your first private swap.
        </h2>
        <p data-reveal style={delay(160)} className={`${lede} mx-auto max-w-[30rem]`}>
          No account to make. Pick two coins, and your ZEC stays shielded the whole way.
        </p>
        <div data-reveal style={delay(240)} className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link to="/app" className={primary}>
            Start a swap
          </Link>
          <Link to="/safety" className={secondary}>
            Safety details
          </Link>
        </div>
      </div>
    </section>
  );
}
