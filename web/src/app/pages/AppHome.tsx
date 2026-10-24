import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowRight, CaretDown, GearSix, ShieldCheck } from "@phosphor-icons/react";
import { counterBalance, pairChain, startSwap, type Role, type Status, type SwapView } from "@/api";
import { CHAIN_NAMES, amountIn, coin, zec } from "@/format";
import { Link, navigate } from "@/router";
import { btcText } from "@/swap/shared";
import { roughDuration, typicalSeconds } from "@/swap/timing";
import { Layout } from "../components/Layout";
import { PairLogo, TokenLogo } from "../components/Logos";
import { PartnerList } from "../components/MakerList";
import { TokenPicker, tokenSubtitle } from "../components/TokenPicker";
import { Sheet } from "../components/ui/sheet";
import { cn } from "../lib/utils";
import { useLocal } from "../lib/daemon";
import { capacity, counterFor, liveQuote, quoteOf, useMakers, type Makers, type Quote } from "../lib/makers";
import { pairName } from "../lib/pairs";
import { plainSummary } from "../lib/progress";
import { secondsLeft, useQuotes, withFirm } from "../lib/quotes";

// /app: one swap card. Sell (shielded ZEC) on top, Buy (the coin picked from "Select a token")
// below, the rate from the best partner, and one Swap button. The partner and the details are
// behind the settings pill above the card.

// what the ZEC lock's network fee needs on top of the amount (ferry-zec's SEND_FEE_RESERVE)
const ZEC_FEE_RESERVE = 50_000;

export function AppHome() {
  const d = useLocal();
  const live = d.list.find((s) => !s.outcome);
  return (
    <Layout>
      <div className="mx-auto w-full max-w-[480px]">
        {live ? <LiveBanner swap={live} status={d.status} /> : null}
        <SwapCard status={d.status} busySwap={live} />
      </div>
    </Layout>
  );
}

function LiveBanner({ swap, status }: { swap: SwapView; status: Status | null }) {
  return (
    <Link
      to={`/app/swap/${swap.id}`}
      className="mb-5 flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm transition-colors hover:border-slate-300 hover:bg-white"
    >
      <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-slate-400 opacity-60 motion-reduce:animate-none" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-slate-900" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="font-medium text-slate-900">You have a swap in progress</span>
        <span className="block truncate text-slate-500">{plainSummary(swap, status)}</span>
      </span>
      <span className="inline-flex shrink-0 items-center gap-1 font-medium text-slate-900">
        View <ArrowRight size={14} weight="bold" aria-hidden />
      </span>
    </Link>
  );
}

function SwapCard({ status, busySwap }: { status: Status | null; busySwap?: SwapView }) {
  const { role, bt, daemon, pair } = useLocal();
  const makers = useMakers();
  const [pick, setPick] = useState<string | null>(null);
  const [amount, setAmount] = useState("1.00");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [settings, setSettings] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setFail(null);
    setPick(null);
  }, [pair]);

  const zat = Math.round(Number(amount) * 1e8);
  const valid = amount.trim() !== "" && Number.isFinite(zat) && zat > 0;
  // a firm price (lib/quotes) when a partner gives one, else the partners' indicative rates
  const quotes = useQuotes(pair, role, valid ? zat : 0);
  const { maker, quote, usable, skipped, firm } = withFirm(liveQuote(makers, status, role, valid ? zat : 0, pick), quotes.list, makers.list, pick);

  // a host can cap swaps below the default amount (the public demo does): start at the cap
  const cap = makers.list === null ? quote?.max : usable.length ? Math.max(...usable.map((m) => (quoteOf(m) ? capacity(quoteOf(m)!) : 0))) : undefined;
  useEffect(() => {
    if (!touched && cap != null && cap > 0 && cap < 1e8) setAmount(zec(cap));
  }, [cap, touched]);

  const out = quote && valid ? counterFor(quote, zat, role) : 0;
  const ticker = coin().ticker;
  const name = pairName(pair);
  const zecBal = status?.balances.zec_shielded_zat ?? null;
  const coinBal = status ? counterBalance(status) : null;

  const problem = problemOf({ amount, valid, zat, role, makers, quote, maker, usable, status, gross: quote && valid ? Math.round((zat / 1e8) * quote.rate) : 0 });
  const blocked = busySwap ? "Finish the swap in progress first." : null;

  // the most this party can swap: its balance (less the lock's fee for ZEC), within what a partner takes
  const most = (() => {
    const partnerMax = cap ?? Infinity;
    if (role === "Z") return zecBal == null ? null : Math.max(0, Math.min(zecBal - ZEC_FEE_RESERVE, partnerMax));
    return coinBal == null || !quote ? null : Math.max(0, Math.min(Math.floor((coinBal * 1e8) / quote.rate), partnerMax));
  })();
  const setMax = () => {
    if (most == null) return;
    setTouched(true);
    // 4.9995, or 5.00 for a round amount
    const [whole, frac = ""] = (most / 1e8).toFixed(8).replace(/0+$/, "").split(".");
    setAmount(`${whole}.${frac.padEnd(2, "0")}`);
    input.current?.focus();
  };

  const submit = async () => {
    if (problem || blocked || busy || !quote) return;
    setBusy(true);
    setFail(null);
    try {
      const { id } = await startSwap(zat, daemon, maker?.name, firm?.quote_id);
      navigate(`/app/swap/${id}`);
    } catch (e) {
      const msg = (e as Error).message;
      if (/firm (quote|price)/i.test(msg)) quotes.refresh();
      setFail(plainError(msg));
    } finally {
      setBusy(false);
    }
  };

  const message = problem ?? blocked ?? fail;
  const evm = coin().kind === "evm";
  // this Ferry node only ever sells (or, holding the other coin, only buys) shielded ZEC
  const zecTip = role === "Z" ? "Ferry sells your shielded ZEC" : "Ferry buys shielded ZEC for you";
  const zecPanel = (
    <Panel
      label={role === "Z" ? "Sell" : "Buy"}
      onClick={() => input.current?.focus()}
      pill={
        <span className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-white pr-3.5 pl-1.5 shadow-[0_1px_2px_rgba(24,24,27,0.06)]" title={zecTip}>
          <TokenLogo id="zec" size={28} />
          <span className="text-[15px] font-semibold text-slate-900">ZEC</span>
        </span>
      }
      foot={
        <>
          <span className="tabular-nums">{zecBal == null ? "Balance –" : `Balance ${zec(zecBal)} ZEC`}</span>
          {role === "Z" ? (
            <button type="button" onClick={setMax} disabled={most == null} className="rounded-full px-2 py-0.5 text-xs font-semibold text-slate-900 transition-colors hover:bg-slate-200/70 disabled:text-slate-400">
              Max
            </button>
          ) : null}
        </>
      }
    >
      <input
        ref={input}
        inputMode="decimal"
        autoComplete="off"
        aria-label={role === "Z" ? "ZEC to sell" : "ZEC to buy"}
        placeholder="0"
        value={amount}
        onChange={(e) => {
          setTouched(true);
          setAmount(e.target.value.replace(",", "."));
        }}
        aria-invalid={!!problem && valid}
        aria-describedby="swap-message"
        className={cn(
          "h-12 w-full min-w-0 bg-transparent leading-none font-medium tracking-tight text-slate-900 tabular-nums placeholder:text-slate-300 focus:outline-none focus-visible:outline-none",
          amountSize(amount),
        )}
      />
    </Panel>
  );
  const coinPanel = (
    <Panel
      label={role === "Z" ? "Buy" : "Pay with"}
      pill={
        <button
          type="button"
          onClick={() => setPicker(true)}
          aria-haspopup="dialog"
          aria-label={`${role === "Z" ? "You get" : "You pay with"} ${name.noun}. Choose another coin`}
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-white pr-3 pl-1.5 shadow-[0_1px_2px_rgba(24,24,27,0.06)] transition-colors hover:border-slate-300 hover:bg-slate-50"
        >
          <PairLogo pair={pair} size={28} />
          <span className="text-[15px] font-semibold text-slate-900">{name.label}</span>
          <CaretDown size={14} weight="bold" className="text-slate-500" aria-hidden />
        </button>
      }
      foot={
        <>
          <span className="truncate">{tokenSubtitle(pair)}</span>
          <span className="shrink-0 tabular-nums">{coinBal == null ? null : `Balance ${btcText(coinBal)} ${ticker}`}</span>
        </>
      }
    >
      <output
        aria-live="polite"
        aria-label={role === "Z" ? `You get ${ticker}` : `You pay ${ticker}`}
        className={cn("flex h-12 items-center truncate leading-none font-medium tracking-tight tabular-nums", amountSize(out ? btcText(out) : "0"), out ? "text-slate-900" : "text-slate-300")}
      >
        {out ? btcText(out) : "0"}
      </output>
    </Panel>
  );

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{role === "Z" ? "Swap" : "Buy ZEC"}</h1>
        <div className="relative">
          <button
            type="button"
            onClick={() => setSettings(true)}
            aria-haspopup="dialog"
            aria-label={`Settings: partner ${maker?.name ?? "none"}${pick ? "" : " (best rate)"}`}
            className="inline-flex h-9 items-center gap-2 rounded-full border border-slate-200 bg-white pr-2.5 pl-3.5 text-sm text-slate-700 shadow-[0_1px_2px_rgba(24,24,27,0.04)] transition-colors hover:border-slate-300 hover:text-slate-900"
          >
            {pick ? null : <span className="text-slate-500">Auto</span>}
            <span className="max-w-[9rem] truncate font-medium text-slate-900">{maker?.name ?? (makers.list === null ? "Partner" : "No partner")}</span>
            <GearSix size={16} weight="bold" className="text-slate-500" aria-hidden />
          </button>
          <Sheet anchored open={settings} onClose={() => setSettings(false)} title="Swap settings">
            <Section title="Swap partner" note="Each partner sets its own rate. None of them can take your coins.">
              <PartnerList makers={makers.list} role={role} zat={valid ? zat : 0} pick={pick} current={maker?.name ?? null} onPick={setPick} fetchedAt={makers.fetchedAt} now={makers.now} error={makers.error} firm={quotes.list} />
            </Section>
            <Section title="Details" last>
              <dl className="space-y-3 px-5 text-sm">
                <Fact label="Network fee" value={evm ? `A little ETH for gas on ${CHAIN_NAMES[pairChain(pair) ?? "base"]}` : quote?.fee != null ? `${amountIn(quote.fee, coin())} ${ticker}${role === "Z" ? ", taken from what you get" : ""}` : "–"} />
                <Fact label="Typical time" value={status ? capital(roughDuration(typicalSeconds(status, bt))) : "–"} />
                <Fact label="If it fails" value={`Your ${role === "Z" ? "ZEC" : ticker} comes back automatically after the deadline.`} />
                <Fact label="Privacy" value="Your ZEC stays shielded, and nothing on either chain links the two sides." />
              </dl>
            </Section>
          </Sheet>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex flex-col">
          {zecPanel}
          <div className="relative z-10 -my-[18px] flex justify-center" aria-hidden title={zecTip}>
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl border-4 border-white bg-slate-100 text-slate-700">
              <ArrowDown size={16} weight="bold" />
            </span>
          </div>
          {coinPanel}
        </div>

        <div className="mt-3 min-h-5 px-1 text-[13px] text-slate-500">
          {quote ? (
            <p>
              <span className="text-slate-700 tabular-nums">
                1 ZEC = {btcText(quote.rate)} {ticker}
              </span>
              {firm ? <span className="tabular-nums"> · firm for {secondsLeft(firm, quotes.now)} s</span> : null}
              {maker ? ` · from ${maker.name}` : null}
            </p>
          ) : makers.list === undefined ? (
            <p>Finding the best rate…</p>
          ) : null}
          {skipped && quote && maker ? (
            <p className="mt-0.5">
              {skipped.name} can fill up to {zec(capacity(quoteOf(skipped)!))} ZEC right now, so {maker.name} takes this one.
            </p>
          ) : null}
        </div>

        <button
          type="submit"
          disabled={!status || !quote || !!problem || !!blocked || busy}
          className="mt-3 flex h-14 w-full items-center justify-center rounded-2xl bg-slate-900 text-base font-semibold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
        >
          {busy ? "Starting…" : "Swap"}
        </button>
        <p id="swap-message" role={message ? "alert" : undefined} className={cn("mt-3 text-center text-sm", !message ? "sr-only" : message === blocked ? "text-slate-600" : "text-rose-600")}>
          {message ?? ""}
        </p>
      </form>

      <p className="mt-6 flex items-start justify-center gap-2 text-center text-[13px] text-slate-500">
        <ShieldCheck size={16} weight="regular" className="mt-px shrink-0" aria-hidden />
        <span>Your ZEC stays shielded. If the swap stops, your coins come back.</span>
      </p>

      <TokenPicker open={picker} onClose={() => setPicker(false)} makers={makers} role={role} />
    </>
  );
}

// One plain sentence for what stops the swap, or null.
function problemOf({
  amount,
  valid,
  zat,
  role,
  makers,
  quote,
  maker,
  usable,
  status,
  gross,
}: {
  amount: string;
  valid: boolean;
  zat: number;
  role: Role;
  makers: Makers;
  quote: Quote | null;
  maker: { name: string } | null;
  usable: unknown[];
  status: Status | null;
  gross: number;
}): string | null {
  if (amount.trim() === "") return "Enter how much ZEC.";
  if (!valid) return "Enter an amount, like 1.00.";
  if (makers.list && !usable.length) return `No partner is taking ${coin().ticker} swaps right now. Try again in a minute.`;
  if (role === "Z" && status) {
    const bal = status.balances.zec_shielded_zat;
    if (zat > bal) return `That's more than your ${zec(bal)} ZEC.`;
    if (zat > bal - ZEC_FEE_RESERVE) return "Leave 0.0005 ZEC for the network fee, or use Max.";
  }
  if (role === "B" && status && gross > counterBalance(status)) return `That costs more than your ${btcText(counterBalance(status))} ${coin().ticker}.`;
  if (quote) {
    if (zat < quote.min) return `The smallest swap${maker ? ` with ${maker.name}` : ""} is ${zec(quote.min)} ZEC.`;
    if (zat > capacity(quote)) return `The largest swap right now is ${zec(capacity(quote))} ZEC.`;
  }
  return null;
}

// The daemon's and proxy's errors, for people: the details stay in the developer view.
function plainError(raw: string): string {
  if (/already in progress/i.test(raw)) return "Finish the swap in progress first.";
  if (/api token/i.test(raw)) return "Your Ferry node refused this page. Check how the app was started.";
  if (/reach the daemon|unreachable|connection refused|timed? ?out/i.test(raw)) return "Couldn't reach your partner or your Ferry node. Try again in a moment.";
  if (/not making offers|paused/i.test(raw)) return "That partner just stopped taking swaps. Try again, or pick another one in settings.";
  if (/unknown maker/i.test(raw)) return "That partner isn't listed here any more. Pick another one in settings.";
  if (/firm (quote|price)/i.test(raw)) return "That firm price ran out before the swap started. Press Swap again for a fresh one.";
  if (/does not have enough shielded/i.test(raw)) return "You don't have enough shielded ZEC for this amount.";
  if (/does not have enough|not enough liquidity|liquidity/i.test(raw)) return "Your partner can't cover this amount right now. Try a smaller one.";
  return raw.replace(/\bdaemon\b/gi, "Ferry node").replace(/\bmaker\b/gi, "partner");
}

function Panel({ label, pill, foot, onClick, children }: { label: string; pill: ReactNode; foot: ReactNode; onClick?: () => void; children: ReactNode }) {
  return (
    <div
      onClick={(e) => {
        if (onClick && !(e.target as HTMLElement).closest("button")) onClick();
      }}
      className={cn(
        "rounded-3xl border border-slate-200/70 bg-slate-50 px-5 pt-4 pb-4 transition-colors",
        onClick && "has-[input:focus]:border-slate-300 has-[input:focus]:bg-white",
      )}
    >
      <p className="text-xs font-medium tracking-wider text-slate-500 uppercase">{label}</p>
      <div className="mt-3 flex items-center gap-3">
        <div className="min-w-0 flex-1">{children}</div>
        {pill}
      </div>
      <div className="mt-3 flex min-h-6 items-center justify-between gap-3 text-[13px] text-slate-500">{foot}</div>
    </div>
  );
}

function Section({ title, note, last, children }: { title: string; note?: string; last?: boolean; children: ReactNode }) {
  return (
    <section className={cn("pt-1", last ? "pb-5" : "border-b border-slate-100 pb-3")}>
      <h3 className="px-5 text-xs font-medium tracking-wider text-slate-500 uppercase">{title}</h3>
      {note ? <p className="mt-1 px-5 text-[13px] text-slate-500">{note}</p> : null}
      <div className="mt-2">{children}</div>
    </section>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Big amounts step down as they get longer, so 0.0041035 fits beside the coin pill on a phone.
function amountSize(text: string): string {
  const n = text.length;
  if (n <= 6) return "text-[36px] sm:text-[40px]";
  if (n <= 9) return "text-[30px] sm:text-[38px]";
  if (n <= 12) return "text-[25px] sm:text-[32px]";
  return "text-[21px] sm:text-[27px]";
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-4">
      <dt className="w-28 shrink-0 text-slate-500">{label}</dt>
      <dd className="min-w-0 text-slate-900">{value}</dd>
    </div>
  );
}
