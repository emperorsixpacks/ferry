import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowRight, ArrowsDownUp, GearSix, ShieldCheck } from "@phosphor-icons/react";
import { counterBalance, pairChain, startSwap, type PairId, type Role, type RouteLegs, type RouteView, type Status, type SwapView } from "@/api";
import { CHAIN_NAMES, amountIn, coin, zec } from "@/format";
import { Link, navigate } from "@/router";
import { btcText } from "@/swap/shared";
import { roughDuration, typicalSeconds } from "@/swap/timing";
import { Layout } from "../components/Layout";
import { PairLogo, TokenLogo } from "../components/Logos";
import { PartnerList } from "../components/MakerList";
import { NearCard } from "../components/NearCard";
import { RouteCard } from "../components/RouteCard";
import { CoinPill, Fact, Panel, Section, amountSize, capital } from "../components/SwapParts";
import { RoutePicker, TokenPicker, tokenSubtitle, type Token } from "../components/TokenPicker";
import { Sheet } from "../components/ui/sheet";
import { cn } from "../lib/utils";
import { useLocal } from "../lib/daemon";
import { capacity, counterFor, liveQuote, quoteOf, useMakers, type Makers, type Quote } from "../lib/makers";
import { isActive as nearActive, nearSummary, storeNear, storedNear, useNear } from "../lib/near";
import { pairName, storeRoute, storedRoute } from "../lib/pairs";
import { plainSummary } from "../lib/progress";
import { secondsLeft, useQuotes, withFirm } from "../lib/quotes";
import { canRoute, isRunning, legSwapIds, routeSummary, useRoutes } from "../lib/routes";

// /app: one swap card, either way round. Selling ZEC: Sell (shielded ZEC) on top, Buy (the coin
// picked from "Select a token") below. Buying ZEC: the arrow between them flips the card, so the
// coin is sold on top and ZEC bought below. The amount is always the ZEC: what you sell, or what
// you want. Swaps are denominated in ZEC end to end (the partner's limits, its liquidity, the
// amount locked), so the number typed is exactly what moves, with no rounding, and the coin side is
// worked out the way the partner works it out. The rate comes from the best partner for the
// direction, and the partner and details are behind the settings pill above the card.
//
// With a router on the server (private swaps), both sides can be a coin: the ZEC pill opens a picker
// too, with shielded ZEC on top and the coins that can go through it below. Picking one turns the
// card into a private swap (RouteCard), coin → shielded ZEC → coin; picking ZEC again turns it back.
// Without a router none of this shows: the ZEC pill stays a plain label.
//
// With NEAR Intents on the server, the coin picker also lists its assets ("More via NEAR Intents").
// Picking one turns the card into a NEAR swap (NearCard): Ferry swaps the ZEC for a coin it supports
// and NEAR Intents carries it on, or the other way round; picking one of Ferry's coins turns it back.

// what the ZEC lock's network fee needs on top of the amount (ferry-zec's SEND_FEE_RESERVE)
const ZEC_FEE_RESERVE = 50_000;
// what a Bitcoin or Litecoin lock's own fee needs on top of the amount (ferryd's B keeps as much)
const LOCK_FEE_RESERVE = 10_000;

type Route = { from: PairId; to: PairId };

// The private swap on the card, if any: the viewer's pick, while the server can run it.
function useRouteChoice(legs: RouteLegs | null): [Route | null, (r: Route | null) => void] {
  const [choice, setChoice] = useState<Route | null>(storedRoute);
  const set = (r: Route | null) => {
    setChoice(r);
    storeRoute(r);
  };
  return [choice && canRoute(legs, choice.from, choice.to) ? choice : null, set];
}

// The NEAR Intents asset on the card, if any: the viewer's pick, while the server lists it.
function useNearChoice(): [string | null, (asset: string | null) => void] {
  const near = useNear();
  const [choice, setChoice] = useState<string | null>(storedNear);
  const set = (a: string | null) => {
    setChoice(a);
    storeNear(a);
  };
  // while the list loads, keep the pick; once it's there, only what it lists
  const ok = !!choice && (near.info === undefined || (!!near.info && !!near.byId[choice]));
  return [ok ? choice : null, set];
}

export function AppHome() {
  const d = useLocal();
  const routes = useRoutes();
  const near = useNear();
  const [route, setRouteChoice] = useRouteChoice(routes.legs);
  const [nearAsset, setNearAsset] = useNearChoice();
  // one kind of card at a time: a private swap, a NEAR swap, or a plain one
  const setRoute = (r: Route | null) => {
    setRouteChoice(r);
    if (r) setNearAsset(null);
  };
  const setNear = (a: string | null) => {
    setNearAsset(a);
    if (a) setRouteChoice(null);
  };
  // a private swap's two swaps are the private swap's: its banner, not theirs; a NEAR swap's Ferry
  // swap likewise
  const legs = legSwapIds(routes.list);
  for (const j of near.jobs) for (const id of [j.ferry.swap_id, ...j.ferry.earlier]) if (id) legs.add(id);
  const live = d.list.find((s) => !s.outcome && !s.route && !legs.has(s.id));
  const moving = routes.list.find(isRunning);
  const holding = routes.list.find((v) => v.state === "holding");
  const nearLive = near.jobs.find(nearActive);
  const blocked = moving ? "Finish your private swap first." : live ? "Finish the swap in progress first." : null;
  return (
    <Layout>
      <div className="mx-auto w-full max-w-[480px]">
        {moving ? (
          <RouteBanner route={moving} />
        ) : live ? (
          <LiveBanner swap={live} status={d.status} />
        ) : nearLive ? (
          <Banner to={`/app/near/${nearLive.id}`} title={nearLive.state === "deposit" ? "A swap is waiting for your deposit" : nearLive.state === "holding" ? "Your NEAR Intents swap is waiting for you" : "You have a swap in progress"} line={nearSummary(nearLive)} pulse={nearLive.state !== "holding"} />
        ) : holding ? (
          <RouteBanner route={holding} />
        ) : null}
        {route ? (
          <RouteCard from={route.from} to={route.to} onChange={setRoute} blocked={blocked} />
        ) : nearAsset ? (
          <NearCard asset={nearAsset} onChange={setNear} blocked={blocked} />
        ) : (
          <SwapCard status={d.status} blocked={blocked} onRoute={routes.legs ? setRoute : null} onNear={near.info?.available ? setNear : null} />
        )}
      </div>
    </Layout>
  );
}

function Banner({ to, title, line, pulse }: { to: string; title: string; line: string; pulse: boolean }) {
  return (
    <Link to={to} className="mb-5 flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm transition-colors hover:border-slate-300 hover:bg-white">
      <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
        {pulse ? <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-slate-400 opacity-60 motion-reduce:animate-none" /> : null}
        <span className={cn("relative inline-flex h-2 w-2 rounded-full", pulse ? "bg-slate-900" : "bg-slate-400")} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="font-medium text-slate-900">{title}</span>
        <span className="block truncate text-slate-500">{line}</span>
      </span>
      <span className="inline-flex shrink-0 items-center gap-1 font-medium text-slate-900">
        View <ArrowRight size={14} weight="bold" aria-hidden />
      </span>
    </Link>
  );
}

const LiveBanner = ({ swap, status }: { swap: SwapView; status: Status | null }) => <Banner to={`/app/swap/${swap.id}`} title="You have a swap in progress" line={plainSummary(swap, status)} pulse />;

function RouteBanner({ route }: { route: RouteView }) {
  // the pause counts down
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, []);
  const running = isRunning(route);
  return <Banner to={`/app/route/${route.id}`} title={running ? "You have a private swap in progress" : "Your private swap is waiting for you"} line={routeSummary(route)} pulse={running} />;
}

function SwapCard({ status, blocked: elsewhere, onRoute, onNear }: { status: Status | null; blocked: string | null; onRoute: ((r: Route) => void) | null; onNear: ((asset: string) => void) | null }) {
  const { role, dir, bt, daemon, pair, canFlip, chooseDirection } = useLocal();
  const buying = dir === "buy";
  const makers = useMakers();
  const [pick, setPick] = useState<string | null>(null);
  const [amount, setAmount] = useState("1.00");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  // the ZEC pill's picker, with a router: another coin there makes a private swap
  const [zecPicker, setZecPicker] = useState(false);
  const [settings, setSettings] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // a partner picked for one coin or direction doesn't carry over to another
  useEffect(() => {
    setFail(null);
    setPick(null);
  }, [pair, dir]);

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

  // the coin side: what Z gets (less the payout's fee), or what B pays
  const out = quote && valid ? counterFor(quote, zat, role) : 0;
  const gross = quote && valid ? Math.round((zat / 1e8) * quote.rate) : 0;
  const ticker = coin().ticker;
  const name = pairName(pair);
  const evm = coin().kind === "evm";
  const zecBal = status?.balances.zec_shielded_zat ?? null;
  const coinBal = status ? counterBalance(status) : null;

  const problem = problemOf({ amount, valid, zat, role, makers, quote, maker, usable, status, gross, evm });
  const blocked = elsewhere;

  // the most ZEC this party can swap: its ZEC (less the lock's fee) when selling, what its coin
  // buys (less the lock's fee) when buying, within what a partner takes
  const most = (() => {
    const partnerMax = cap ?? Infinity;
    if (!buying) return zecBal == null ? null : Math.max(0, Math.min(zecBal - ZEC_FEE_RESERVE, partnerMax));
    if (coinBal == null || !quote) return null;
    const spendable = Math.max(0, coinBal - (evm ? 0 : LOCK_FEE_RESERVE));
    return Math.max(0, Math.min(Math.floor((spendable * 1e8) / quote.rate), partnerMax));
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
    if (problem || blocked || busy || !quote || !daemon) return;
    setBusy(true);
    setFail(null);
    try {
      const { id } = await startSwap(zat, daemon, maker?.name, firm?.quote_id);
      navigate(`/app/swap/${id}`);
    } catch (e) {
      const msg = (e as Error).message;
      if (/firm (quote|price)/i.test(msg)) quotes.refresh();
      setFail(plainError(msg, buying));
    } finally {
      setBusy(false);
    }
  };

  const message = problem ?? blocked ?? fail;
  const maxButton = (
    <button type="button" onClick={setMax} disabled={most == null} className="rounded-full px-2 py-0.5 text-xs font-semibold text-slate-900 transition-colors hover:bg-slate-200/70 disabled:text-slate-400">
      Max
    </button>
  );
  const youHave = (text: string | null) => <span className="truncate tabular-nums">{text == null ? "You have –" : `You have ${text}`}</span>;

  const zecPanel = (
    <Panel
      key="zec"
      label={buying ? "Buy" : "Sell"}
      onClick={() => input.current?.focus()}
      pill={
        <CoinPill
          logo={<TokenLogo id="zec" size={28} />}
          label="ZEC"
          title={buying ? "Arrives shielded" : "Your shielded ZEC"}
          onClick={onRoute ? () => setZecPicker(true) : undefined}
          ariaLabel={`${buying ? "You get" : "You sell"} shielded ZEC. Swap another coin privately instead`}
        />
      }
      foot={
        buying ? (
          <>
            <span className="truncate">Arrives shielded</span>
            <span className="shrink-0">{youHave(zecBal == null ? null : `${zec(zecBal)} ZEC`)}</span>
          </>
        ) : (
          <>
            {youHave(zecBal == null ? null : `${zec(zecBal)} ZEC`)}
            {maxButton}
          </>
        )
      }
    >
      <input
        ref={input}
        inputMode="decimal"
        autoComplete="off"
        aria-label={buying ? "ZEC to buy" : "ZEC to sell"}
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
      key="coin"
      label={buying ? "Sell" : "Buy"}
      pill={<CoinPill logo={<PairLogo pair={pair} size={28} />} label={name.label} onClick={() => setPicker(true)} ariaLabel={`${buying ? "You pay with" : "You get"} ${name.noun}. Choose another coin`} />}
      foot={
        buying ? (
          <>
            {youHave(coinBal == null ? null : `${btcText(coinBal)} ${ticker}`)}
            {maxButton}
          </>
        ) : (
          <>
            <span className="truncate">{tokenSubtitle(pair)}</span>
            <span className="shrink-0">{youHave(coinBal == null ? null : `${btcText(coinBal)} ${ticker}`)}</span>
          </>
        )
      }
    >
      <output
        aria-live="polite"
        aria-label={buying ? `You pay ${ticker}` : `You get ${ticker}`}
        className={cn("flex h-12 items-center truncate leading-none font-medium tracking-tight tabular-nums", amountSize(out ? btcText(out) : "0"), out ? "text-slate-900" : "text-slate-300")}
      >
        {out ? btcText(out) : "0"}
      </output>
    </Panel>
  );
  const flip = (
    <div key="flip" className="relative z-10 -my-[18px] flex justify-center">
      <button
        type="button"
        onClick={() => chooseDirection(buying ? "sell" : "buy")}
        disabled={!canFlip}
        aria-label="Switch direction"
        title={canFlip ? (buying ? "Sell ZEC instead" : "Buy ZEC instead") : `${buying ? "Selling" : "Buying"} ZEC isn't available here`}
        className="group flex h-10 w-10 items-center justify-center rounded-2xl border-4 border-white bg-slate-100 text-slate-700 transition-colors hover:bg-slate-200 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:text-slate-400 disabled:hover:bg-slate-100"
      >
        <ArrowDown size={16} weight="bold" className="group-hover:hidden group-focus-visible:hidden group-disabled:block" aria-hidden />
        <ArrowsDownUp size={16} weight="bold" className="hidden group-hover:block group-focus-visible:block group-disabled:hidden" aria-hidden />
      </button>
    </div>
  );

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Swap</h1>
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
            <Section title="Swap partner" note={buying ? "Partners who sell ZEC. Each sets its own rate, and none of them can take your coins." : "Partners who buy ZEC. Each sets its own rate, and none of them can take your coins."}>
              <PartnerList makers={makers.list} role={role} zat={valid ? zat : 0} pick={pick} current={maker?.name ?? null} onPick={setPick} fetchedAt={makers.fetchedAt} now={makers.now} error={makers.error} firm={quotes.list} />
            </Section>
            <Section title="Details" last>
              <dl className="space-y-3 px-5 text-sm">
                <Fact
                  label="Network fee"
                  value={
                    evm
                      ? `A little ETH for gas on ${CHAIN_NAMES[pairChain(pair) ?? "base"]}`
                      : buying
                        ? `Your wallet's usual fee to lock the ${ticker}`
                        : quote?.fee != null
                          ? `${amountIn(quote.fee, coin())} ${ticker}, taken from what you get`
                          : "–"
                  }
                />
                <Fact label="Typical time" value={status ? capital(roughDuration(typicalSeconds(status, bt))) : "–"} />
                <Fact label="If it fails" value={`Your ${buying ? ticker : "ZEC"} comes back automatically after the deadline.`} />
                <Fact label="Privacy" value={`Your ZEC ${buying ? "arrives" : "stays"} shielded, and nothing on either chain links the two sides.`} />
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
        <div className="flex flex-col">{buying ? [coinPanel, flip, zecPanel] : [zecPanel, flip, coinPanel]}</div>

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
          disabled={!status || !quote || !daemon || !!problem || !!blocked || busy}
          className="mt-3 flex h-14 w-full items-center justify-center rounded-2xl bg-slate-900 text-base font-semibold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
        >
          {busy ? "Starting…" : buying ? "Buy ZEC" : "Sell ZEC"}
        </button>
        <p id="swap-message" role={message ? "alert" : undefined} className={cn("mt-3 text-center text-sm", !message ? "sr-only" : message === blocked ? "text-slate-600" : "text-rose-600")}>
          {message ?? ""}
        </p>
      </form>

      <p className="mt-6 flex items-start justify-center gap-2 text-center text-[13px] text-slate-500">
        <ShieldCheck size={16} weight="regular" className="mt-px shrink-0" aria-hidden />
        <span>{buying ? `Your ZEC arrives shielded. If the swap stops, your ${ticker} comes back.` : "Your ZEC stays shielded. If the swap stops, your coins come back."}</span>
      </p>

      <TokenPicker open={picker} onClose={() => setPicker(false)} makers={makers} role={role} zat={valid ? zat : 1e8} onNear={onNear ?? undefined} />
      {onRoute ? (
        <RoutePicker
          open={zecPicker}
          onClose={() => setZecPicker(false)}
          side={buying ? "buy" : "sell"}
          current="zec"
          other={pair}
          onPick={(id: Token) => {
            if (id !== "zec") onRoute(buying ? { from: pair, to: id } : { from: id, to: pair });
          }}
        />
      ) : null}
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
  evm,
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
  evm: boolean;
}): string | null {
  const t = coin().ticker;
  const buying = role === "B";
  if (amount.trim() === "") return buying ? "Enter how much ZEC you want." : "Enter how much ZEC to sell.";
  if (!valid) return "Enter an amount, like 1.00.";
  if (makers.list && !usable.length) return `No partner is ${buying ? "selling" : "buying"} ZEC for ${t} right now. Try again in a minute.`;
  if (!buying && status) {
    const bal = status.balances.zec_shielded_zat;
    if (zat > bal) return `You only have ${zec(bal)} ZEC.`;
    if (zat > bal - ZEC_FEE_RESERVE) return "Leave 0.0005 ZEC for the network fee, or use Max.";
  }
  if (buying && status) {
    const bal = counterBalance(status);
    if (gross > bal) return `You have ${btcText(bal)} ${t}, and this costs ${btcText(gross)} ${t}.`;
    if (!evm && gross + LOCK_FEE_RESERVE > bal) return `Leave about ${btcText(LOCK_FEE_RESERVE)} ${t} for the network fee, or use Max.`;
    if (evm && status.balances.eth_wei === "0") return "Your Ferry node needs a little ETH to pay for gas.";
  }
  if (quote) {
    if (zat < quote.min) return `The smallest swap${maker ? ` with ${maker.name}` : ""} is ${zec(quote.min)} ZEC.`;
    if (zat > capacity(quote)) return `The largest swap right now is ${zec(capacity(quote))} ZEC.`;
  }
  return null;
}

// The daemon's and proxy's errors, for people: the details stay in the developer view. A refusal
// from the partner ("The maker refused: ...") is about their funds, anything else about ours.
function plainError(raw: string, buying: boolean): string {
  const refused = /maker refused/i.test(raw);
  if (/already in progress/i.test(raw)) return "Finish the swap in progress first.";
  if (/api token/i.test(raw)) return "Your Ferry node refused this page. Check how the app was started.";
  if (/reach the daemon|unreachable|connection refused|timed? ?out/i.test(raw)) return "Couldn't reach your partner or your Ferry node. Try again in a moment.";
  if (/not making offers|paused/i.test(raw)) return "That partner just stopped taking swaps. Try again, or pick another one in settings.";
  if (/unknown maker/i.test(raw)) return "That partner isn't listed here any more. Pick another one in settings.";
  if (/firm (quote|price)/i.test(raw)) return `That firm price ran out before the swap started. Press ${buying ? "Buy" : "Sell"} ZEC again for a fresh one.`;
  if (/also has role/i.test(raw)) return buying ? "That partner only buys ZEC. Pick one that sells it in settings." : "That partner only sells ZEC. Pick one that buys it in settings.";
  if (refused && /does not have enough|liquidity/i.test(raw)) return "Your partner can't cover this amount right now. Try a smaller one.";
  if (/does not have enough shielded/i.test(raw)) return "You don't have enough shielded ZEC for this amount.";
  if (/no ETH for gas/i.test(raw)) return "Your Ferry node needs a little ETH to pay for gas.";
  if (/does not have enough/i.test(raw)) return buying ? `You don't have enough ${coin().ticker} for this amount and the network fee.` : "Your partner can't cover this amount right now. Try a smaller one.";
  if (/liquidity/i.test(raw)) return "Your partner can't cover this amount right now. Try a smaller one.";
  return raw.replace(/\bdaemon\b/gi, "Ferry node").replace(/\bmaker\b/gi, "partner");
}
