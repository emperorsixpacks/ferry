import { useRef, type CSSProperties, type ReactNode } from "react";
import { ArrowDown, ArrowRight } from "@phosphor-icons/react";
import { Link } from "@/router";
import { FaqList } from "../components/FaqList";
import { SiteHeader } from "../components/Layout";
import { ChainLogo, type ChainMarkId } from "../components/Logos";
import { BTC, CoinMark, LTC, eth, usdc } from "../components/landing/coins";
import { Crossing } from "../components/landing/Crossing";
import { FirmDemo, QuoteDemo, RouteDemo, SafetyDemo } from "../components/landing/Demos";
import { useReveal } from "../components/landing/motion";
import { Orbit } from "../components/landing/Orbit";
import { Submerged } from "../components/landing/Submerged";
import { LANDING_FAQ } from "../lib/faq";
import { useMakers } from "../lib/makers";
import { cn } from "../lib/utils";
import "../landing.css";

// `/`: the crossing. A light page whose one dark thing is Zcash's shielded pool: coins sink into it
// on the left and come out on the right as other coins. Then Ferry in four facts, four things it
// does (each with a small live demo built from the app's parts), the chains around shielded ZEC,
// five answers, and the name itself half under the surface. Headings and paragraphs sharpen from
// a blur as they scroll in (useReveal).
export function Landing() {
  const root = useRef<HTMLDivElement>(null);
  useReveal(root);
  return (
    <div ref={root} className="flex min-h-screen flex-col bg-white text-slate-900">
      <SiteHeader />
      <main className="flex-1">
        <Hero />
        <Facts />
        <How />
        <Chains />
        <Questions />
        <Closing />
      </main>
      <Submerged />
    </div>
  );
}

const delay = (ms: number) => ({ "--lp-delay": `${ms}ms` }) as CSSProperties;

function Hero() {
  return (
    <section aria-labelledby="hero-title" className="overflow-hidden">
      <div className="mx-auto max-w-6xl px-4 pt-12 text-center sm:px-6 sm:pt-16 lg:pt-20">
        <h1 id="hero-title" data-reveal className="mx-auto max-w-[15ch] text-[42px] leading-[1.02] font-semibold tracking-[-0.035em] text-slate-900 sm:text-6xl lg:text-[72px]">
          Swap across chains, privately.
        </h1>
        <p data-reveal style={delay(150)} className="mx-auto mt-6 max-w-[37rem] text-[17px] leading-relaxed text-slate-600 sm:text-lg">
          Swap shielded ZEC with Bitcoin, Litecoin, USDC or ETH, or go from one of them to another through Zcash's shielded pool. No account. No bridge. Nobody holds your coins.
        </p>
        <div data-reveal style={delay(300)} className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link to="/app" className="inline-flex h-12 items-center justify-center rounded-full bg-slate-900 px-7 text-[15px] font-semibold text-white transition-colors hover:bg-slate-800">
            Start a swap
          </Link>
          <a
            href="#how"
            className="inline-flex h-12 items-center justify-center gap-1.5 rounded-full border border-slate-200 bg-white px-6 text-[15px] font-medium text-slate-700 transition-[color,border-color,box-shadow] hover:border-accent-300 hover:text-slate-900 hover:shadow-[0_0_0_4px_var(--color-accent-100)]"
          >
            See how it works
            <ArrowDown size={14} weight="bold" aria-hidden />
          </a>
        </div>
      </div>
      <Crossing className="mt-12 sm:mt-14" />
    </section>
  );
}

// --- four facts, only ones the code holds to --------------------------------------------------------
const COIN_MARKS = [BTC, LTC, usdc("ethereum"), eth("ethereum")].map((c) => ({ ...c, chain: undefined }));
const CHAIN_MARKS: ChainMarkId[] = ["bitcoin", "litecoin", "ethereum", "base", "arbitrum", "optimism"];

const FACTS: { n: string; unit: string; body: string; marks?: ReactNode }[] = [
  {
    n: "4",
    unit: "coins",
    body: "Bitcoin, Litecoin, USDC and ETH, each for shielded ZEC.",
    marks: COIN_MARKS.map((c) => (
      <span key={c.ticker} className="inline-flex rounded-full bg-white p-[2px]">
        <CoinMark coin={c} size={22} />
      </span>
    )),
  },
  {
    n: "6",
    unit: "chains",
    body: "Bitcoin, Litecoin, Ethereum, Base, Arbitrum and Optimism.",
    marks: CHAIN_MARKS.map((c) => (
      <span key={c} className="inline-flex rounded-full bg-white p-[2px]">
        <ChainLogo id={c} size={22} />
      </span>
    )),
  },
  { n: "0", unit: "custodians", body: "No exchange, bridge or server ever holds your coins." },
  { n: "0", unit: "ZEC amounts on chain", body: "Your ZEC never leaves the shielded pool." },
];

function Facts() {
  return (
    <section aria-label="Ferry in numbers" className="mx-auto max-w-6xl px-4 pt-14 sm:px-6 sm:pt-20">
      <dl className="lp-edge grid grid-cols-2 rounded-[28px] lg:grid-cols-4">
        {FACTS.map((f, i) => (
          <div
            key={f.unit}
            className={cn("flex flex-col border-slate-100 p-5 sm:p-7", i % 2 === 1 && "border-l", i >= 2 && "border-t lg:border-t-0", i === 2 && "lg:border-l")}
          >
            <dt className="order-2 mt-1 text-[15px] font-medium text-slate-900">{f.unit}</dt>
            <dd data-reveal style={delay(i * 120)} className="order-1 text-[44px] leading-none font-semibold tracking-[-0.04em] text-slate-900 tabular-nums sm:text-[56px]">
              {f.n}
            </dd>
            <dd className="order-3 mt-2 text-sm leading-relaxed text-slate-500">{f.body}</dd>
            {f.marks ? (
              <dd className="order-4 mt-4 flex -space-x-1.5" aria-hidden>
                {f.marks}
              </dd>
            ) : null}
          </div>
        ))}
      </dl>
    </section>
  );
}

// --- four things Ferry does, each with a demo -------------------------------------------------------
function How() {
  const makers = useMakers();
  return (
    <section id="how" aria-labelledby="how-title" className="scroll-mt-20">
      <div className="mx-auto max-w-6xl px-4 pt-24 pb-10 sm:px-6 sm:pt-32">
        <h2 id="how-title" data-reveal className="text-[34px] leading-tight font-semibold tracking-[-0.03em] text-slate-900 sm:text-5xl">
          How it works
        </h2>
        <Feature title="Choose two coins. Ferry does the rest." demo={<QuoteDemo makers={makers} />}>
          <p>
            Pick what you have, what you want and how much. Ferry asks its swap partners, takes the best rate for your amount, and runs the swap for you. Each side locks its own
            coins and the swap releases both together.
          </p>
          <p>You can close the page while it finishes. Your Ferry node does the rest.</p>
        </Feature>
        <Feature title="From one coin to another, through the shielded pool." demo={<RouteDemo />} flip>
          <p>
            To go from Bitcoin to USDC, Ferry runs two swaps with shielded ZEC in between, and waits a random pause before the second. No transaction links the coin you sell to the coin
            you get.
          </p>
          <p>
            The two swaps themselves are public, so their amounts and timing could still hint that they belong together. The pause blurs the timing.
          </p>
        </Feature>
        <Feature title="A price that holds still." demo={<FirmDemo makers={makers} />}>
          <p>
            Before you swap, partners send a signed price. It stays firm for the seconds shown, and a swap started in that time gets exactly that rate.
          </p>
          <p>To give a price, partners are told a size range, never your exact amount.</p>
        </Feature>
        <Feature title="If anything goes wrong, your coins come back." demo={<SafetyDemo />} flip>
          <p>
            Every swap has a deadline, signed before anything is locked. If your partner stops halfway, the swap is called off when the deadline passes and your coins return on their
            own. Nobody can end up with both sides.
          </p>
          <p>Keep your Ferry node running until the swap is done, or let a watchtower keep the deadlines for you.</p>
          <p>
            <Link to="/safety" className="inline-flex items-center gap-1.5 rounded font-medium text-accent-700 underline-offset-4 hover:underline">
              Safety details and known limits
              <ArrowRight size={14} weight="bold" aria-hidden />
            </Link>
          </p>
        </Feature>
      </div>
    </section>
  );
}

function Feature({ title, children, demo, flip }: { title: string; children: ReactNode; demo: ReactNode; flip?: boolean }) {
  return (
    <div data-feature className="grid items-center gap-10 py-14 sm:py-20 lg:grid-cols-2 lg:gap-20">
      <div className={cn(flip && "lg:order-last")}>
        <h3 data-reveal className="max-w-[20ch] text-[28px] leading-[1.12] font-semibold tracking-[-0.025em] text-slate-900 sm:text-[36px]">
          {title}
        </h3>
        <div data-reveal style={delay(120)} className="mt-5 max-w-[34rem] space-y-4 text-[17px] leading-relaxed text-slate-600">
          {children}
        </div>
      </div>
      <div className={cn("flex justify-center", flip ? "lg:justify-start" : "lg:justify-end")}>{demo}</div>
    </div>
  );
}

// --- the chains --------------------------------------------------------------------------------------
function Chains() {
  return (
    <section aria-labelledby="chains-title" className="overflow-x-clip border-t border-slate-100 bg-slate-50/70">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
        <Orbit>
          <div>
            <h2 id="chains-title" data-reveal className="max-w-[16ch] text-[34px] leading-tight font-semibold tracking-[-0.03em] text-slate-900 sm:text-5xl">
              Six chains around one shielded middle.
            </h2>
            <p data-reveal style={delay(120)} className="mt-5 max-w-[34rem] text-[17px] leading-relaxed text-slate-600">
              Bitcoin and Litecoin, and USDC or ETH on Ethereum, Base, Arbitrum and Optimism. Every swap goes through shielded ZEC. Each Ferry server offers some of these; the app
              lists the ones you can pick.
            </p>
          </div>
        </Orbit>
      </div>
    </section>
  );
}

function Questions() {
  return (
    <section aria-labelledby="faq-title" className="border-t border-slate-100">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:px-6 sm:py-28 lg:grid-cols-[1fr_1.6fr]">
        <div>
          <h2 id="faq-title" data-reveal className="text-[34px] leading-tight font-semibold tracking-[-0.03em] text-slate-900 sm:text-5xl">
            Questions
          </h2>
          <p data-reveal style={delay(120)} className="mt-4 text-[17px] text-slate-600">
            The short answers. There are more in Help.
          </p>
          <Link to="/help" className="mt-5 inline-flex items-center gap-1.5 rounded font-medium text-accent-700 underline-offset-4 hover:underline">
            All questions
            <ArrowRight size={14} weight="bold" aria-hidden />
          </Link>
        </div>
        <FaqList items={LANDING_FAQ} />
      </div>
    </section>
  );
}

function Closing() {
  return (
    <section aria-labelledby="closing-title" className="border-t border-slate-100">
      <div className="mx-auto flex max-w-6xl flex-col items-center px-4 pt-20 pb-6 text-center sm:px-6 sm:pt-28">
        <h2 id="closing-title" data-reveal className="text-[34px] leading-tight font-semibold tracking-[-0.03em] text-slate-900 sm:text-5xl">
          Ready when you are.
        </h2>
        <p data-reveal style={delay(120)} className="mt-4 max-w-[30rem] text-[17px] text-slate-600">
          No account to make. Pick your coins and press swap.
        </p>
        <Link
          to="/app"
          data-reveal
          style={delay(240)}
          className="mt-8 inline-flex h-12 items-center justify-center rounded-full bg-slate-900 px-7 text-[15px] font-semibold text-white transition-colors hover:bg-slate-800"
        >
          Start a swap
        </Link>
      </div>
    </section>
  );
}
