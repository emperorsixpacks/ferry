import { useEffect, useRef, type CSSProperties } from "react";
import { ArrowDown, ArrowUpRight } from "@phosphor-icons/react";
import { Link } from "@/router";
import { FOOTER_LINKS, REPO_URL, SiteHeader } from "../components/Layout";
import { Wordmark } from "../components/LogoMark";
import { Gate } from "../components/landing/Gate";
import { Mark } from "../components/landing/marks";
import { useParallax, useReveal } from "../components/landing/motion";
import { Networks } from "../components/landing/Networks";
import { Proof } from "../components/landing/Proof";
import { DIRECT_CHAINS, NEAR_ASSETS, NEAR_CHAINS } from "../components/landing/stats";
import { Steps } from "../components/landing/Steps";
import { SwapWidget } from "../components/landing/SwapWidget";
import "../landing.css";

// `/`: the Shield Gate. A night page: coins stream into a glowing Zcash gate on trails of their own
// colours and come out the other side as other coins. Then three proof points, the app's own swap
// card quoting live, the networks, how it works in three steps, and one last call to start.
// Sections rise into place as they scroll in (useReveal) and a few glows drift with the scroll
// (useParallax). The app (/app) keeps its own light look.
export function Landing() {
  const root = useRef<HTMLDivElement>(null);
  useReveal(root);
  useParallax(root);
  // the page behind the page is night too (index.html sets it on a first load of `/`); the app's
  // pages get their own back when you leave
  useEffect(() => {
    const html = document.documentElement;
    html.style.background = "#070921";
    return () => void (html.style.background = "");
  }, []);
  return (
    <div ref={root} className="lp flex min-h-screen flex-col overflow-x-clip">
      <SiteHeader night />
      <main className="flex-1">
        <Hero />
        <ProofSection />
        <TryIt />
        <NetworksSection />
        <How />
        <Closing />
      </main>
      <Footer />
    </div>
  );
}

const delay = (ms: number) => ({ "--lp-delay": `${ms}ms` }) as CSSProperties;

function Hero() {
  const anchor = useRef<HTMLDivElement>(null);
  return (
    <section aria-labelledby="hero-title" className="lp-hero relative isolate overflow-hidden">
      <div className="lp-grid absolute inset-0" aria-hidden />
      <Gate anchor={anchor} />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-[var(--lp-night)]" aria-hidden />
      <div className="relative mx-auto flex min-h-[max(720px,calc(100svh-105px))] max-w-6xl flex-col px-4 sm:px-6 md:min-h-[max(760px,calc(100svh-64px))]">
        <div className="lp-scrim order-2 mx-auto max-w-3xl pb-10 text-center sm:order-1 sm:pt-14 sm:pb-0 lg:pt-16">
          <h1 id="hero-title" className="lp-glow-text text-[42px] leading-[1.02] font-semibold tracking-[-0.04em] text-white sm:text-6xl lg:text-[78px]">
            Every chain.{" "}
            <br />
            <span className="lp-gold-text">One private path.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-[34rem] text-[17px] leading-relaxed text-[var(--lp-muted)] sm:text-lg">
            Swap BTC, ETH, USDC and 200+ more assets through Zcash's shielded pool. No account. Nobody holds your ZEC.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link to="/app" className="lp-cta inline-flex h-13 items-center justify-center rounded-full px-8 text-base font-semibold">
              Start a swap
            </Link>
            <a href="#how" className="lp-ghost inline-flex h-13 items-center justify-center gap-2 rounded-full px-7 text-base font-medium">
              How it works
              <ArrowDown size={15} weight="bold" aria-hidden />
            </a>
          </div>
          <p className="mt-6 inline-flex items-center gap-2.5 text-sm text-[var(--lp-quiet)]">
            <span className="lp-live h-2 w-2 rounded-full bg-emerald-400" aria-hidden />
            <span>
              <span className="font-semibold text-white">{NEAR_ASSETS}</span> assets · <span className="font-semibold text-white">{NEAR_CHAINS}</span> chains · ZEC always
              shielded
            </span>
          </p>
        </div>
        {/* where the gate stands: above the text on a phone, below it on wider screens */}
        <div ref={anchor} className="order-1 h-[270px] shrink-0 sm:order-2 sm:h-auto sm:min-h-[340px] sm:flex-1" aria-hidden />
      </div>
    </section>
  );
}

function ProofSection() {
  return (
    <section aria-labelledby="proof-title" className="relative py-24 sm:py-32">
      <div className="lp-blob -top-20 left-[-10%] h-[420px] w-[420px] bg-[var(--lp-violet)]" data-parallax="0.15" aria-hidden />
      <div className="lp-blob top-1/3 right-[-12%] h-[380px] w-[380px] bg-[var(--lp-gold)] opacity-25" data-parallax="-0.1" aria-hidden />
      <div className="relative mx-auto max-w-6xl px-4 sm:px-6">
        <h2 id="proof-title" data-reveal className="max-w-[18ch] text-[36px] leading-[1.05] font-semibold tracking-[-0.035em] text-white sm:text-5xl lg:text-[56px]">
          Private. Direct. Everywhere.
        </h2>
        <p data-reveal style={delay(100)} className="mt-5 max-w-[36rem] text-[17px] leading-relaxed text-[var(--lp-muted)]">
          Ferry swaps through Zcash's shielded pool, directly with the other side, and reaches most chains you use.
        </p>
        <div className="mt-12 sm:mt-16">
          <Proof />
        </div>
      </div>
    </section>
  );
}

function TryIt() {
  return (
    <section aria-labelledby="try-title" className="relative py-24 sm:py-32">
      <div className="lp-blob top-10 left-1/2 h-[520px] w-[520px] -translate-x-1/2 bg-[var(--lp-magenta)] opacity-20" data-parallax="0.12" aria-hidden />
      <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_440px] lg:gap-20">
        <div>
          <h2 id="try-title" data-reveal className="max-w-[16ch] text-[36px] leading-[1.05] font-semibold tracking-[-0.035em] text-white sm:text-5xl">
            See your price before you start.
          </h2>
          <p data-reveal style={delay(100)} className="mt-5 max-w-[32rem] text-[17px] leading-relaxed text-[var(--lp-muted)]">
            This is the app's own swap card, quoting 1 ZEC at the best partner's rate right now. Pick another coin to compare, then swap in the app.
          </p>
          <div data-reveal style={delay(200)} className="mt-8">
            <Link to="/app" className="lp-cta inline-flex h-13 items-center justify-center rounded-full px-8 text-base font-semibold">
              Start a swap
            </Link>
          </div>
        </div>
        <div data-reveal style={delay(150)} className="mx-auto w-full max-w-[440px]">
          <div className="lp-frame">
            <SwapWidget />
          </div>
        </div>
      </div>
    </section>
  );
}

function NetworksSection() {
  return (
    <section aria-labelledby="net-title" className="relative py-24 sm:py-32">
      <div className="lp-blob top-0 right-[-6%] h-[360px] w-[360px] bg-[var(--lp-cyan)] opacity-20" data-parallax="-0.12" aria-hidden />
      <div className="relative mx-auto grid max-w-6xl items-end gap-10 px-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-16">
        <div>
          <h2 id="net-title" data-reveal className="max-w-[20ch] text-[36px] leading-[1.05] font-semibold tracking-[-0.035em] text-white sm:text-5xl">
            Six chains direct. {NEAR_CHAINS - DIRECT_CHAINS} more through NEAR Intents.
          </h2>
          <p data-reveal style={delay(100)} className="mt-5 max-w-[40rem] text-[17px] leading-relaxed text-[var(--lp-muted)]">
            Ferry swaps natively on Bitcoin, Litecoin, Ethereum, Base, Arbitrum and Optimism. NEAR Intents carries the rest, from Solana to XRP: that leg is public and settled by
            NEAR Intents, and your ZEC never goes to NEAR.
          </p>
        </div>
        <dl data-reveal style={delay(200)} className="flex gap-10 sm:gap-14">
          {(
            [
              [NEAR_ASSETS, "assets", "var(--lp-gold)"],
              [NEAR_CHAINS, "chains", "var(--lp-cyan)"],
              [DIRECT_CHAINS, "direct chains", "var(--lp-magenta)"],
            ] as const
          ).map(([n, label, c]) => (
            <div key={label} className="flex flex-col">
              <dt className="order-2 mt-1 text-sm text-[var(--lp-muted)]">{label}</dt>
              <dd className="order-1 text-5xl font-semibold tracking-[-0.04em] text-white tabular-nums sm:text-6xl" style={{ textShadow: `0 0 36px ${c}` }}>
                {n}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <div data-reveal style={delay(200)} className="mt-12 sm:mt-14">
        <Networks />
      </div>
      <p className="mx-auto mt-8 max-w-6xl px-4 text-sm text-[var(--lp-quiet)] sm:px-6">Each Ferry server offers some of these; the app lists the ones you can pick.</p>
    </section>
  );
}

function How() {
  return (
    <section id="how" aria-labelledby="how-title" className="relative scroll-mt-20 py-24 sm:py-32">
      <div className="lp-blob bottom-0 left-[-8%] h-[380px] w-[380px] bg-[var(--lp-cyan)] opacity-20" data-parallax="0.1" aria-hidden />
      <div className="relative mx-auto max-w-6xl px-4 sm:px-6">
        <h2 id="how-title" data-reveal className="text-[36px] leading-[1.05] font-semibold tracking-[-0.035em] text-white sm:text-5xl">
          How it works
        </h2>
        <p data-reveal style={delay(100)} className="mt-5 max-w-[32rem] text-[17px] leading-relaxed text-[var(--lp-muted)]">
          Three steps and a few minutes. Ferry runs the swap for you; you can close the page while it finishes.
        </p>
        <div className="mt-12 sm:mt-16">
          <Steps />
        </div>
      </div>
    </section>
  );
}

function Closing() {
  return (
    <section aria-labelledby="close-title" className="relative py-28 text-center sm:py-36">
      <div className="lp-grid absolute inset-0 opacity-70" aria-hidden />
      <div className="absolute top-1/2 left-1/2 h-[560px] w-[560px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(244_183_40/0.28),rgb(139_92_246/0.16)_55%,transparent)]" aria-hidden />
      <div className="relative mx-auto max-w-3xl px-4 sm:px-6">
        <div data-reveal className="mx-auto mb-10 flex h-[132px] w-[132px] items-center justify-center" aria-hidden>
          <div className="lp-breathe relative flex h-[116px] w-[100px] items-center justify-center">
            <span className="lp-hex absolute inset-0 bg-gradient-to-b from-[var(--lp-gold-hi)] via-[var(--lp-gold)] to-[var(--lp-violet)]" />
            <span className="lp-hex absolute inset-[3px] bg-[#120f2a]" />
            <span className="lp-hex absolute inset-[3px] bg-[radial-gradient(closest-side,rgb(244_183_40/0.55),transparent)]" />
            <span className="relative rounded-full shadow-[0_0_40px_8px_rgb(244_183_40/0.5)]">
              <Mark id="zec" size={52} />
            </span>
          </div>
        </div>
        <h2 id="close-title" data-reveal style={delay(100)} className="lp-glow-text text-[40px] leading-[1.04] font-semibold tracking-[-0.04em] text-white sm:text-6xl">
          Make your first private swap.
        </h2>
        <p data-reveal style={delay(200)} className="mx-auto mt-5 max-w-[30rem] text-[17px] leading-relaxed text-[var(--lp-muted)]">
          No account to make. Pick two coins, and your ZEC stays shielded the whole way.
        </p>
        <div data-reveal style={delay(300)} className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link to="/app" className="lp-cta inline-flex h-14 items-center justify-center rounded-full px-10 text-lg font-semibold">
            Start a swap
          </Link>
          <Link to="/safety" className="lp-ghost inline-flex h-14 items-center justify-center rounded-full px-8 text-base font-medium">
            Safety details
          </Link>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-white/10">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:px-6 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <Wordmark size={22} night />
          <span className="text-sm text-[var(--lp-quiet)]">Private swaps through Zcash's shielded pool.</span>
        </div>
        <nav aria-label="More" className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-[var(--lp-muted)]">
          {FOOTER_LINKS.map(([label, to]) => (
            <Link key={to} to={to} className="rounded transition-colors hover:text-white">
              {label}
            </Link>
          ))}
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded transition-colors hover:text-white">
            Open source
            <ArrowUpRight size={12} weight="bold" aria-hidden />
          </a>
        </nav>
      </div>
    </footer>
  );
}
