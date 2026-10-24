import { useRef, type CSSProperties } from "react";
import { ArrowDown, ArrowRight, ArrowUpRight } from "@phosphor-icons/react";
import { Link } from "@/router";
import { REPO_URL, SiteFooter, SiteHeader } from "../components/Layout";
import { Gate } from "../components/landing/Gate";
import { Mark } from "../components/landing/marks";
import { useReveal } from "../components/landing/motion";
import { Networks } from "../components/landing/Networks";
import { Proof } from "../components/landing/Proof";
import { Steps } from "../components/landing/Steps";
import { SwapWidget } from "../components/landing/SwapWidget";
import "../landing.css";

// `/`: the Shield Gate, on the app's own white. Coins drift into a hexagonal gate with Zcash's gold
// core and come out the other side as other coins. Then three proof points, the app's swap card
// quoting, the networks, how it works in three steps, and one last call to start. Ink, greys
// and white, with Zcash gold only at the gate's core; coins and chains keep their colours inside
// their own marks. Sections rise into place as they scroll in (useReveal).
//
// Every claim here must match docs/WHAT-IS-REAL.md. Ferry's own chains are Bitcoin, Litecoin and
// Base: ferryd's Ethereum, Arbitrum and Optimism settings have never run, and neither the installer
// nor the demo offers them. NEAR Intents is mainnet only, prices only on the demo, and has not run
// with real funds. Nothing has run on mainnet. No counts of NEAR Intents' assets: they drift.
export function Landing() {
  const root = useRef<HTMLDivElement>(null);
  useReveal(root);
  return (
    <div ref={root} className="lp flex min-h-screen flex-col overflow-x-clip bg-canvas text-slate-900">
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
    <section aria-labelledby="hero-title" className="relative isolate overflow-hidden bg-canvas">
      <Gate anchor={anchor} />
      <div className="relative mx-auto flex max-w-6xl flex-col px-4 sm:min-h-[max(720px,calc(100svh-105px))] sm:px-6 md:min-h-[max(720px,calc(100svh-64px))]">
        <div className="order-2 mx-auto max-w-3xl pb-10 text-center sm:order-1 sm:pt-14 sm:pb-0 lg:pt-16">
          <h1 id="hero-title" className="text-[42px] leading-[1.03] font-semibold tracking-[-0.035em] text-slate-900 sm:text-6xl lg:text-[72px]">
            Other chains.{" "}
            <br />
            <span className="text-slate-500">One private path.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-[34rem] text-[17px] leading-relaxed text-slate-600 sm:text-lg">
            Swap shielded ZEC for bitcoin, litecoin, or ETH and USDC on Base, either way round. No account. Nobody holds your ZEC.
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
            <span className="font-semibold text-slate-900">BTC · LTC · ETH · USDC</span> on Bitcoin, Litecoin and Base · more via NEAR Intents, on mainnet
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
    <section aria-labelledby="proof-title" className="border-t border-slate-100 bg-slate-50/70 dark:bg-white/40">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
        <h2 id="proof-title" data-reveal className={h2}>
          Private. Direct. Cross-chain.
        </h2>
        <p data-reveal style={delay(80)} className={`${lede} max-w-[36rem]`}>
          Ferry swaps through Zcash's shielded pool, directly with the other side, on Bitcoin, Litecoin and Base.
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
            This is the app's own swap card, quoting 1 ZEC at the best rate this server's partners offer. On test networks that is a fixed demo rate, not a
            market price. Pick another coin to compare, then swap in the app.
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
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <h2 id="net-title" data-reveal className={`${h2} max-w-[22ch]`}>
          Three chains direct. More through NEAR Intents.
        </h2>
        <p data-reveal style={delay(80)} className={`${lede} max-w-[42rem]`}>
          Ferry swaps directly on Bitcoin, Litecoin and Base. On mainnet, NEAR Intents can carry the other coin on to more chains, from Solana to XRP: that leg is
          public and settled by NEAR Intents, and your ZEC never goes to NEAR. The public demo shows NEAR Intents' prices only.
        </p>
      </div>
      <div data-reveal style={delay(160)} className="mt-12">
        <Networks />
      </div>
      <p className="mx-auto mt-6 max-w-6xl px-4 text-sm leading-relaxed text-slate-500 sm:px-6">
        So far Ferry has run on test networks only: nothing has run on mainnet, NEAR Intents included, and Bitcoin and Litecoin stay on test networks for now.
        Each Ferry server offers some of these; the app lists the ones you can pick.{" "}
        <a
          href={`${REPO_URL}/blob/master/docs/WHAT-IS-REAL.md`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 font-medium text-slate-700 underline decoration-slate-300 underline-offset-4 transition-colors hover:text-slate-900 hover:decoration-slate-900"
        >
          What has run, and where
          <ArrowUpRight size={12} weight="bold" aria-hidden />
        </a>
      </p>
    </section>
  );
}

function How() {
  return (
    <section id="how" aria-labelledby="how-title" className="scroll-mt-20 border-t border-slate-100 bg-slate-50/70 dark:bg-white/40">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
        <h2 id="how-title" data-reveal className={h2}>
          How it works
        </h2>
        <p data-reveal style={delay(80)} className={`${lede} max-w-[32rem]`}>
          Three steps, then minutes of waiting while both chains confirm. Ferry runs the swap for you; you can close the page while it finishes.
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
            <path d="M40 2 78 24v44L40 90 2 68V24z" className="fill-white stroke-slate-900" strokeWidth="1.5" strokeLinejoin="round" />
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
