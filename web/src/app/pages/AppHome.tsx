import { useEffect, useRef, useState, type RefObject } from "react";
import { ArrowRight, ArrowsLeftRight, GearSix } from "@phosphor-icons/react";
import { counterBalance, pairChain, startSwap, type PairId, type Role, type RouteView, type Status, type SwapView } from "@/api";
import { CHAIN_NAMES, amountIn, coin, zec } from "@/format";
import { Link, navigate } from "@/router";
import { btcText } from "@/swap/shared";
import { typicalText } from "@/swap/timing";
import { ComboCard } from "../components/ComboCard";
import { Layout } from "../components/Layout";
import { PartnerList } from "../components/MakerList";
import { NearCard } from "../components/NearCard";
import { NearOnlyCard } from "../components/NearOnlyCard";
import { OffCard } from "../components/OffCard";
import { RouteCard } from "../components/RouteCard";
import { ReceiveTo } from "../components/ReceiveTo";
import { Fact, FlipButton, Panel, PathLine, PrivacyLine, Section, SidePill, YouHave, amountSize, capital } from "../components/SwapParts";
import { CoinPicker, tokenSubtitle } from "../components/TokenPicker";
import { Sheet } from "../components/ui/sheet";
import { cn } from "../lib/utils";
import { useLocal } from "../lib/daemon";
import { BUSY_TEXT, availability, busyFor, capacity, counterFor, liveQuote, quoteOf, useMakers, type Makers, type Quote } from "../lib/makers";
import { comboSummary, isActive as nearActive, nearSummary, useNear } from "../lib/near";
import { pairName } from "../lib/pairs";
import { following, nearAssetOf, usePathCtx, useSelection, type CardProps, type Side } from "../lib/paths";
import { plainSummary } from "../lib/progress";
import { receiveFor, useReceive } from "../lib/receive";
import { secondsLeft, useQuotes, withFirm } from "../lib/quotes";
import { isRunning, legSwapIds, routeSummary, useRoutes } from "../lib/routes";
import { useActivityRows } from "./Activity";

// /app: one swap card for any two coins. Sell defaults to shielded ZEC and Buy to the first coin
// this server sells it for; both pills open the same picker (shielded ZEC, Ferry's coins, then more
// via NEAR Intents), and the arrow swaps the two sides, whatever they are. server/paths.mjs says
// which way the two coins go, and the card follows it:
//   ZEC ↔ a Ferry coin        one Ferry swap (SwapCard below): the amount is the ZEC, either way
//   ZEC ↔ a NEAR asset        Ferry, then NEAR Intents, or the other way (NearCard)
//   coin ↔ coin               a private swap through shielded ZEC (RouteCard), the default for any
//                             two coins: Ferry's promise is a cross-chain swap that leaves no trail
//   NEAR Intents at an end    a private swap with NEAR Intents before it, after it or both (ComboCard)
//   opted out, for two coins  NEAR Intents alone, public (NearOnlyCard): chosen in the settings sheet
//                             only, remembered for those two coins, never the default
// What this server can't run stays on the card, looking the same, with one sentence on why
// (OffCard). Under the amounts, the path line says who runs each part and how long it takes; under
// the card, one honest line says what stays private. Beside the card (below it on a phone), "Recent
// activity": the latest swaps of every kind, each opening its progress page.

// what the ZEC lock's network fee needs on top of the amount (ferry-zec's SEND_FEE_RESERVE)
const ZEC_FEE_RESERVE = 50_000;
// what a Bitcoin or Litecoin lock's own fee needs on top of the amount (ferryd's B keeps as much)
const LOCK_FEE_RESERVE = 10_000;
// when a swap started (its first timeline entry), for newest first
const startedAt = (s: SwapView) => Date.parse(s.timeline[0]?.at ?? "") || 0;

export function AppHome() {
  const d = useLocal();
  const routes = useRoutes();
  const near = useNear();
  const ctx = usePathCtx();
  const sel = useSelection(ctx);
  // a private swap's two swaps are the private swap's: its banner, not theirs; a NEAR swap's Ferry
  // swap likewise, and a private swap with NEAR Intents at an end holds its route
  const comboRoutes = new Set(near.combos.map((c) => c.route.id).filter(Boolean));
  const legs = legSwapIds(routes.list);
  for (const j of near.jobs) for (const id of [j.ferry.swap_id, ...j.ferry.earlier]) if (id) legs.add(id);
  for (const c of near.combos) for (const id of c.route.swaps) legs.add(id);
  // swaps run side by side (each node takes as many at once as its funds and --max-swaps allow), so
  // a swap in progress never holds the card back; newest first
  const lives = d.list.filter((s) => !s.outcome && s.state !== "Aborted" && !s.route && !legs.has(s.id)).sort((a, b) => startedAt(b) - startedAt(a));
  const live = lives[0];
  const moving = routes.list.find((v) => isRunning(v) && !comboRoutes.has(v.id));
  const holding = routes.list.find((v) => v.state === "holding" && !comboRoutes.has(v.id));
  const nearLive = near.jobs.find(nearActive);
  const comboLive = near.combos.find(nearActive);
  // private swaps run one at a time, and while one moves, the ZEC it bought waits on the node that
  // sells it: no direct sell there until it's done (server/prod.mjs says the same)
  const routing = !!moving || comboLive?.state === "route";
  const sellingOn = [moving?.to, comboLive?.state === "route" ? comboLive.to : null].filter(Boolean);

  const { pick, path } = sel;
  const column = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const panelHeight = useAlignedHeight(column, panel);
  let card = null;
  if (pick && path) {
    const twoSwaps = path.kind === "route" || path.kind === "route-near" || path.kind === "near-route" || path.kind === "near-near";
    const blocked =
      twoSwaps && routing
        ? "Finish your private swap first."
        : path.kind === "sell" && path.pair && sellingOn.includes(path.pair)
          ? `A private swap is selling ZEC for ${pairName(path.pair as PairId).label} right now. Try again when it finishes.`
          : null;
    const props: CardProps = { pick, path, ctx, onPick: sel.pickSide, onFlip: sel.flip, blocked, optOut: sel.optOut };
    if (!path.available) card = <OffCard {...props} />;
    else if (path.kind === "near-only") card = <NearOnlyCard key={`${pick.sell}>${pick.buy}`} {...props} />;
    else if ((path.kind === "sell" || path.kind === "buy") && following(path, d)) card = <SwapCard key={`${path.kind}|${path.pair}`} {...props} status={d.status} />;
    else if ((path.kind === "near-sell" || path.kind === "near-buy") && following(path, d)) card = <NearCard key={path.kind} {...props} asset={nearAssetOf(path.kind === "near-sell" ? pick.buy : pick.sell)!} />;
    else if (path.kind === "route") card = <RouteCard {...props} />;
    else if (path.kind === "route-near" || path.kind === "near-route" || path.kind === "near-near") card = <ComboCard key={path.kind} {...props} />;
    else card = <OffCard {...props} />;
  }
  // the swap card on the left (at its own width), "Recent activity" on the right; on phones the panel
  // goes below the card. The banner for a swap in progress shows on phones only: on a wide screen
  // the panel already lists it first, with its live status, right beside the card.
  return (
    <Layout>
      <div className="mx-auto flex w-full max-w-[480px] flex-col gap-8 lg:max-w-[960px] lg:flex-row lg:items-start lg:gap-10">
        <div ref={column} className="w-full min-w-0 lg:w-[480px] lg:shrink-0">
          <div className="lg:hidden">
            {moving ? (
              <RouteBanner route={moving} />
            ) : lives.length > 1 ? (
              <Banner to="/app/activity" title={`You have ${lives.length} swaps in progress`} line={`Newest: ${plainSummary(lives[0], d.status)}`} pulse />
            ) : live ? (
              <LiveBanner swap={live} status={d.status} />
            ) : comboLive ? (
              <Banner to={`/app/combo/${comboLive.id}`} title={comboLive.state === "deposit" ? "A swap is waiting for your deposit" : comboLive.state === "holding" ? "Your private swap is waiting for you" : "You have a private swap in progress"} line={comboSummary(comboLive)} pulse={comboLive.state !== "holding"} />
            ) : nearLive ? (
              <Banner to={`/app/near/${nearLive.id}`} title={nearLive.state === "deposit" ? "A swap is waiting for your deposit" : nearLive.state === "holding" ? "Your NEAR Intents swap is waiting for you" : "You have a swap in progress"} line={nearSummary(nearLive)} pulse={nearLive.state !== "holding"} />
            ) : holding ? (
              <RouteBanner route={holding} />
            ) : null}
          </div>
          {card ?? <OffCard loading />}
        </div>
        <aside className="w-full min-w-0 lg:flex-1 lg:pt-12">
          <RecentActivity sectionRef={panel} height={panelHeight} />
        </aside>
      </div>
    </Layout>
  );
}

// On a wide screen the panel ends level with the card's main button: its height, from the panel's
// top to that button's bottom, kept as the card changes (null: the panel's own height, on a phone).
function useAlignedHeight(column: RefObject<HTMLElement>, panel: RefObject<HTMLElement>): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const el = column.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const wide = window.matchMedia("(min-width: 1024px)");
    const measure = () => {
      const button = el.querySelector("form button[type=submit]");
      const top = panel.current?.getBoundingClientRect().top;
      if (!wide.matches || !button || top == null) return setHeight(null);
      const h = Math.round(button.getBoundingClientRect().bottom - top);
      setHeight(h > 160 ? h : null);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    wide.addEventListener("change", measure);
    measure();
    return () => {
      ro.disconnect();
      wide.removeEventListener("change", measure);
    };
  }, [column, panel]);
  return height;
}

// "Recent activity": the latest few of the person's swaps, every kind, each row opening its
// progress page; the rest on /app/activity. Swaps still in progress come first (several can run at
// once, and an older one that is still moving must not drop below finished ones), each kind newest
// first. Beside the card, at the card's height (its list scrolls).
function RecentActivity({ sectionRef, height }: { sectionRef: RefObject<HTMLElement>; height: number | null }) {
  const rows = useActivityRows();
  const shown = [...rows.filter((r) => r.live), ...rows.filter((r) => !r.live)].slice(0, 7);
  return (
    <section
      ref={sectionRef}
      aria-labelledby="recent-title"
      style={height ? { height } : undefined}
      className="flex flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(24,24,27,0.04)]"
      data-recent
    >
      <div className="flex shrink-0 items-center justify-between gap-3 px-5 pt-4 pb-3">
        <h2 id="recent-title" className="text-[15px] font-semibold tracking-tight text-slate-900">
          Recent activity
        </h2>
        <Link to="/app/activity" className="inline-flex items-center gap-1 rounded text-sm font-medium text-slate-600 transition-colors hover:text-slate-900">
          View all
          <ArrowRight size={12} weight="bold" aria-hidden />
        </Link>
      </div>
      {shown.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center border-t border-slate-100 px-6 pt-8 pb-10 text-center">
          <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-100 text-slate-500">
            <ArrowsLeftRight size={18} weight="bold" aria-hidden />
          </span>
          <p className="mt-3 text-sm font-medium text-slate-900">Your swaps will show up here</p>
          <p className="mt-1 text-[13px] text-slate-500">Each one opens its progress, step by step.</p>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto overscroll-contain border-t border-slate-100" data-recent-list>
          {shown.map((r) => (
            <li key={r.key}>{r.row}</li>
          ))}
        </ul>
      )}
    </section>
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

// ZEC for a Ferry coin, or the other way: one swap. Selling ZEC, shielded ZEC on top and the coin
// below; buying it, the coin on top. The amount is always the ZEC: what you sell, or what you want.
// Swaps are denominated in ZEC end to end (the partner's limits, its liquidity, the amount locked),
// so the number typed is exactly what moves, and the coin side is worked out the way the partner
// works it out. The rate comes from the best partner for the direction; the partner and details
// are behind the settings pill above the card.
function SwapCard({ status, blocked: elsewhere, pick, path, ctx, onPick, onFlip }: CardProps & { status: Status | null }) {
  const { role, dir, daemon, pair, info } = useLocal();
  const buying = dir === "buy";
  // where what you get goes: your Ferry node, or your own wallet (on your own node)
  const receive = receiveFor(buying ? "zec" : pair, status, info.own);
  const receiveTo = useReceive(receive?.key ?? null);
  const makers = useMakers();
  const [partner, setPartner] = useState<string | null>(null);
  const [amount, setAmount] = useState("1.00");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const [picker, setPicker] = useState<Side | null>(null);
  const [settings, setSettings] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // a partner picked for one coin or direction doesn't carry over to another
  useEffect(() => {
    setFail(null);
    setPartner(null);
  }, [pair, dir]);

  const zat = Math.round(Number(amount) * 1e8);
  const valid = amount.trim() !== "" && Number.isFinite(zat) && zat > 0;
  // a firm price (lib/quotes) when a partner gives one, else the partners' indicative rates
  const quotes = useQuotes(pair, role, valid ? zat : 0);
  const { maker, quote, usable, skipped, firm } = withFirm(liveQuote(makers, status, role, valid ? zat : 0, partner), quotes.list, makers.list, partner);

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
  // the partner picked in settings went busy or offline: say so, as the quote moves to another
  const picked = partner ? (makers.list?.find((m) => m.name === partner) ?? null) : null;
  const pickedOut = picked && !picked.available && maker && maker.name !== picked.name ? picked : null;

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
      const { id } = await startSwap(zat, daemon, maker?.name, firm?.quote_id, receiveTo ? (buying ? { sweep_to: receiveTo } : { payout_to: receiveTo }) : undefined);
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
  // nothing wrong with the swap itself: it just has to wait (said calmly, not as an error)
  const calm = message === blocked || message === BUSY_TEXT;
  const maxButton = (
    <button type="button" onClick={setMax} disabled={most == null} className="rounded-full px-2 py-0.5 text-xs font-semibold text-slate-900 transition-colors hover:bg-slate-200/70 disabled:text-slate-400">
      Max
    </button>
  );
  const youHave = (text: string | null, add?: string, need?: bigint | null) => <YouHave text={text} add={info.own ? add : undefined} need={need} />;
  // buying with a token the node is short of: by how much (base units), for Add funds to start from
  const short = buying && evm && valid && coinBal != null && gross > coinBal ? BigInt(Math.ceil(gross - coinBal)) : null;
  const zecSide: Side = buying ? "buy" : "sell";

  const zecPanel = (
    <Panel
      key="zec"
      label={buying ? "Buy" : "Sell"}
      onClick={() => input.current?.focus()}
      pill={<SidePill token="zec" side={zecSide} onOpen={() => setPicker(zecSide)} />}
      foot={
        buying ? (
          <>
            <span className="truncate">Arrives shielded</span>
            <span className="shrink-0">{youHave(zecBal == null ? null : `${zec(zecBal)} ZEC`)}</span>
          </>
        ) : (
          <>
            {youHave(zecBal == null ? null : `${zec(zecBal)} ZEC`, "zec")}
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
          "h-12 w-full min-w-0 bg-transparent leading-none font-medium tracking-tight text-slate-900 tabular-nums placeholder:text-slate-300 dark:placeholder:text-slate-400 focus:outline-none focus-visible:outline-none",
          amountSize(amount),
        )}
      />
    </Panel>
  );
  const coinSide: Side = buying ? "sell" : "buy";
  const coinPanel = (
    <Panel
      key="coin"
      label={buying ? "Sell" : "Buy"}
      pill={<SidePill token={pair} side={coinSide} onOpen={() => setPicker(coinSide)} name={name.noun} />}
      foot={
        buying ? (
          <>
            {youHave(coinBal == null ? null : `${btcText(coinBal)} ${ticker}`, pair, short)}
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
        className={cn("flex h-12 items-center truncate leading-none font-medium tracking-tight tabular-nums", amountSize(out ? btcText(out) : "0"), out ? "text-slate-900" : "text-slate-300 dark:text-slate-400")}
      >
        {out ? btcText(out) : "0"}
      </output>
    </Panel>
  );
  const flip = <FlipButton key="flip" onFlip={onFlip} title={buying ? `Sell ZEC for ${ticker} instead` : `Buy ZEC with ${ticker} instead`} />;

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Swap</h1>
        <div className="relative">
          <button
            type="button"
            onClick={() => setSettings(true)}
            aria-haspopup="dialog"
            aria-label={`Settings: partner ${maker?.name ?? "none"}${partner ? "" : " (best rate)"}`}
            className="inline-flex h-9 items-center gap-2 rounded-full border border-slate-200 bg-white pr-2.5 pl-3.5 text-sm text-slate-700 shadow-[0_1px_2px_rgba(24,24,27,0.04)] transition-colors hover:border-slate-300 hover:text-slate-900"
          >
            {partner ? null : <span className="text-slate-500">Auto</span>}
            <span className="max-w-[9rem] truncate font-medium text-slate-900">{maker?.name ?? (makers.list === null ? "Partner" : "No partner")}</span>
            <GearSix size={16} weight="bold" className="text-slate-500" aria-hidden />
          </button>
          <Sheet anchored open={settings} onClose={() => setSettings(false)} title="Swap settings">
            <Section title="Swap partner" note={buying ? "Partners who sell ZEC. Each sets its own rate, and none of them can take your coins." : "Partners who buy ZEC. Each sets its own rate, and none of them can take your coins."}>
              <PartnerList makers={makers.list} role={role} zat={valid ? zat : 0} pick={partner} current={maker?.name ?? null} onPick={setPartner} fetchedAt={makers.fetchedAt} now={makers.now} error={makers.error} firm={quotes.list} />
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
                <Fact label="Typical time" value={capital(typicalText(status, pair) ?? "–")} />
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
        <ReceiveTo coin={receive} />

        <div className="mt-3 min-h-5 space-y-0.5 px-1 text-[13px] text-slate-500">
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
          {/* is the partner taking swaps now, and how many more */}
          {quote && maker ? <p data-availability>{availability(maker)}</p> : null}
          {skipped && quote && maker ? (
            <p>
              {skipped.name} can fill up to {zec(capacity(quoteOf(skipped)!))} ZEC right now, so {maker.name} takes this one.
            </p>
          ) : null}
          {pickedOut && quote && maker ? (
            <p>
              {pickedOut.name} is {pickedOut.busy ? "busy right now" : !pickedOut.online ? "offline" : "not taking swaps"}, so {maker.name} takes this one.
            </p>
          ) : null}
          <PathLine path={path} time={typicalText(status, pair) ?? undefined} />
        </div>

        <button
          type="submit"
          disabled={!status || !quote || !daemon || !!problem || !!blocked || busy}
          className="mt-3 flex h-14 w-full items-center justify-center rounded-2xl bg-slate-900 text-base font-semibold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
        >
          {busy ? "Starting…" : path.button}
        </button>
        <p id="swap-message" role={message ? "alert" : undefined} className={cn("mt-3 text-center text-sm", !message ? "sr-only" : calm ? "text-slate-600" : "text-rose-600")}>
          {message ?? ""}
        </p>
      </form>

      <PrivacyLine text={path.privacy} />

      <CoinPicker open={picker !== null} onClose={() => setPicker(null)} side={picker ?? "sell"} pick={pick} ctx={ctx} makers={makers} zat={valid ? zat : 1e8} onPick={(t) => onPick(picker ?? "sell", t)} />
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
  // this node runs as many swaps as it takes at once (ferryd --max-swaps), or every partner for this
  // way does: there is room again once a swap finishes
  if (status?.capacity && status.capacity.free_slots === 0) return BUSY_TEXT;
  if (makers.list && !usable.length && makers.list.some((m) => busyFor(m, role))) return BUSY_TEXT;
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
  // the node or its partner runs as many swaps as it takes at once (ferryd's 409 "busy"; an older
  // ferryd's "already in progress" is the same thing: it ran one at a time)
  if (/^busy\b|every partner is busy|already in progress/i.test(raw) || /maker refused: busy/i.test(raw)) return BUSY_TEXT;
  // a send out of the node and a swap start never run together
  if (/withdraw/i.test(raw)) return "Your node is sending coins out. Try again in a moment.";
  // your own wallet's address, refused by your node or by the partner
  if (/payout_to.*(feature|can't pay)/i.test(raw)) return "That partner can't pay to your own wallet. Pick another partner in settings, or receive to your Ferry node.";
  if (/^(payout_to|sweep_to)\b/i.test(raw)) return `Your Ferry node refused your wallet's address: ${raw.replace(/^(payout_to|sweep_to):\s*/i, "")}. Check it under Receive to.`;
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
