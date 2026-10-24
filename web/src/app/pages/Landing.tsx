import { useState, type ReactNode } from "react";
import { ArrowCounterClockwise, ArrowDown, ArrowRight, CaretDown, EyeSlash, HandCoins } from "@phosphor-icons/react";
import { Link } from "@/router";
import { coin } from "@/format";
import { btcText } from "@/swap/shared";
import { FaqList } from "../components/FaqList";
import { SiteFooter, SiteHeader } from "../components/Layout";
import { PairLogo, TokenLogo } from "../components/Logos";
import { TokenPicker } from "../components/TokenPicker";
import { useLocal } from "../lib/daemon";
import { LANDING_FAQ } from "../lib/faq";
import { counterFor, liveQuote, useMakers } from "../lib/makers";
import { pairName } from "../lib/pairs";

// `/`: what Ferry does in one line, a live quote with the one button that matters, three
// promises, three steps and five answers. The depth lives in Help, /how-it-works and /safety.
export function Landing() {
  return (
    <div className="flex min-h-screen flex-col bg-white text-slate-900">
      <SiteHeader />
      <main className="flex-1">
        <Hero />
        <Promises />
        <Steps />
        <Questions />
      </main>
      <SiteFooter />
    </div>
  );
}

function Hero() {
  const { role } = useLocal();
  const z = role === "Z";
  return (
    <section className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 px-4 pt-14 pb-20 sm:px-6 md:pt-20 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:gap-14 lg:pt-24 lg:pb-28">
      <div>
        <div className="inline-flex items-center gap-2.5 rounded-full border border-slate-200 bg-white py-1 pr-3.5 pl-1.5 text-[13px] text-slate-600">
          <span className="flex -space-x-1.5" aria-hidden>
            {(["btc", "ltc", "usdc", "eth"] as const).map((t) => (
              <span key={t} className="rounded-full bg-white p-px">
                <TokenLogo id={t} size={20} />
              </span>
            ))}
          </span>
          Bitcoin, Litecoin, USDC and ETH
        </div>
        <h1 className="mt-7 text-[44px] leading-[1.04] font-semibold tracking-[-0.03em] text-slate-900 sm:text-6xl lg:text-[64px]">
          {z ? "Swap shielded ZEC." : "Buy shielded ZEC."}
          <br />
          <span className="text-slate-500">Privately.</span>
        </h1>
        <p className="mt-6 max-w-[34rem] text-lg leading-relaxed text-slate-600">
          {z ? "Sell it for Bitcoin, Litecoin, USDC or ETH, or buy it with them." : "Pay with Bitcoin, Litecoin, USDC or ETH, and get shielded ZEC."} No account. No bridge. Nobody holds your coins.
        </p>
        <a href="#how" className="mt-7 inline-flex items-center gap-1.5 rounded text-[15px] font-medium text-slate-700 transition-colors hover:text-slate-900">
          See how it works
          <ArrowDown size={14} weight="bold" aria-hidden />
        </a>
      </div>
      <QuoteCard />
    </section>
  );
}

// 1 ZEC at the best partner's rate for the coin on screen; the coin can be changed right here.
function QuoteCard() {
  const d = useLocal();
  const makers = useMakers();
  const [picker, setPicker] = useState(false);
  const { maker, quote } = liveQuote(makers, d.status, d.role, 1e8);
  const online = d.connected || !!d.status;
  const out = quote ? counterFor(quote, 1e8, d.role) : 0;
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
    <div className="w-full rounded-[28px] border border-slate-200 bg-white p-2 shadow-[0_24px_64px_-32px_rgba(24,24,27,0.22)] lg:justify-self-end lg:max-w-[440px]">
      <div className="flex flex-col">
        {z ? zecSide : coinSide}
        <div className="relative z-10 -my-[18px] flex justify-center" aria-hidden>
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl border-4 border-white bg-slate-100 text-slate-700">
            <ArrowDown size={16} weight="bold" />
          </span>
        </div>
        {z ? coinSide : zecSide}
      </div>
      <p className="px-3 pt-3 pb-1 text-[13px] text-slate-500" aria-live="polite">
        {!online
          ? "Can't reach your Ferry node right now."
          : quote
            ? `1 ZEC = ${btcText(quote.rate)} ${coin().ticker}${maker ? ` · best rate, from ${maker.name}` : ""}`
            : makers.list === undefined
              ? "Finding the best rate…"
              : "No partner is taking swaps for this coin right now."}
      </p>
      <Link to="/app" className="mt-2 flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-slate-900 text-base font-semibold text-white transition-colors hover:bg-slate-800">
        Start a swap
        <ArrowRight size={16} weight="bold" aria-hidden />
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
        <span className="min-w-0 flex-1 truncate text-[28px] leading-tight font-medium tracking-tight tabular-nums sm:text-[34px]">{children}</span>
        {pill}
      </div>
    </div>
  );
}

const promises = [
  {
    icon: <EyeSlash size={22} weight="regular" />,
    title: "Private",
    body: "Your ZEC stays shielded the whole time. Nothing on either chain links the two sides of the swap.",
  },
  {
    icon: <HandCoins size={22} weight="regular" />,
    title: "Nobody holds your coins",
    body: "Each side locks its own coins, and the swap releases them together. There is no exchange or bridge in the middle.",
  },
  {
    icon: <ArrowCounterClockwise size={22} weight="regular" />,
    title: "Safe if anything goes wrong",
    body: "If the other side disappears, a deadline sends your coins back to you automatically.",
  },
];

function Promises() {
  return (
    <section className="border-t border-slate-100 bg-slate-50/60">
      <div className="mx-auto grid max-w-6xl gap-5 px-4 py-14 sm:py-20 sm:px-6 md:grid-cols-3 lg:py-24">
        {promises.map((p) => (
          <div key={p.title} className="rounded-3xl border border-slate-200/80 bg-white p-6 sm:p-7">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-100 text-slate-800" aria-hidden>
              {p.icon}
            </span>
            <h2 className="mt-5 text-lg font-semibold tracking-tight text-slate-900">{p.title}</h2>
            <p className="mt-2 leading-relaxed text-slate-600">{p.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Steps() {
  const { role } = useLocal();
  const steps =
    role === "Z"
      ? [
          { title: "Choose what you want", body: "Type how much ZEC to sell and pick Bitcoin, Litecoin, USDC or ETH." },
          { title: "Confirm", body: "Press Sell ZEC. Ferry finds the best rate, and both sides lock their coins." },
          { title: "Receive", body: "Your coins arrive in a few minutes. If anything stalls, your ZEC comes back." },
        ]
      : [
          { title: "Choose what you pay with", body: "Type how much ZEC to buy and pick Bitcoin, Litecoin, USDC or ETH to pay." },
          { title: "Confirm", body: "Press Buy ZEC. Ferry finds the best rate; you lock your coins first, then your partner locks the ZEC." },
          { title: "Receive", body: "Shielded ZEC arrives in a few minutes. If anything stalls, your coins come back." },
        ];
  return (
    <section id="how" className="scroll-mt-20 border-t border-slate-100">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:py-20 sm:px-6 lg:py-24">
        <h2 className="text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">How it works</h2>
        <ol className="mt-10 grid gap-8 md:grid-cols-3 md:gap-10">
          {steps.map((s, i) => (
            <li key={s.title}>
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-900 text-sm font-semibold text-white tabular-nums" aria-hidden>
                {i + 1}
              </span>
              <h3 className="mt-5 text-lg font-semibold tracking-tight text-slate-900">{s.title}</h3>
              <p className="mt-2 leading-relaxed text-slate-600">{s.body}</p>
            </li>
          ))}
        </ol>
        <Link to="/how-it-works" className="mt-10 inline-flex items-center gap-1.5 rounded font-medium text-accent-700 underline-offset-4 hover:underline">
          The full explanation
          <ArrowRight size={14} weight="bold" aria-hidden />
        </Link>
      </div>
    </section>
  );
}

function Questions() {
  return (
    <section className="border-t border-slate-100 bg-slate-50/60">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:py-20 sm:px-6 lg:grid-cols-[1fr_1.6fr] lg:py-24">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">Questions</h2>
          <p className="mt-3 text-slate-600">The short answers. There are more in Help.</p>
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
