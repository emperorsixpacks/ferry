import { useEffect, useState, type ReactNode } from "react";
import { ArrowDown, ArrowRight, ShieldCheck } from "@phosphor-icons/react";
import { EVM_CHAINS, counterBalance, pairChain, pairCoin, pairId, startSwap, type CoinId, type Maker, type PairId, type Status, type SwapView } from "@/api";
import { CHAIN_NAMES, amountIn, coin, coinInfo, zec } from "@/format";
import { Link, navigate } from "@/router";
import { btcText } from "@/swap/shared";
import { phaseOf } from "@/swap/steps";
import { roughDuration, typicalSeconds } from "@/swap/timing";
import { Detail, Label, Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { StatusBadge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { CoinMark } from "../components/CoinMark";
import { MakerList } from "../components/MakerList";
import { cn } from "../lib/utils";
import { useLocal } from "../lib/daemon";
import { quoteOf, selectable, useMakers, type Makers, type Quote } from "../lib/makers";
import { STATUS, amounts, direction, summary } from "../lib/swaps";

// /app: pick the coin, then a swap card (what you send, what you receive) beside the makers you
// can swap with, and this party's swaps below.
export function AppHome() {
  const d = useLocal();
  const live = d.list.find((s) => !s.outcome);
  const makers = useMakers();
  const [pick, setPick] = useState<string | null>(null);
  // the picked maker while it takes swaps, else the first one that does
  const usable = makers.list?.filter((m) => selectable(m, d.role)) ?? [];
  const maker = usable.find((m) => m.name === pick) ?? usable[0] ?? null;

  return (
    <Layout>
      <div className="space-y-12">
        <div className="flex flex-col items-center text-center">
          <p className="font-mono text-xs tracking-widest text-brand-600 uppercase">Shielded atomic swaps</p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 md:text-4xl">{d.role === "Z" ? "Swap shielded ZEC" : "Buy shielded ZEC"}</h1>
          <p className="mt-2 text-slate-600">No bridge. No custodian. Your ZEC never leaves the shielded pool.</p>
          <PairToggle />
        </div>

        {live ? (
          <Link
            to={`/app/swap/${live.id}`}
            className="flex items-center justify-between gap-4 border border-brand-200 bg-brand-50/50 px-5 py-3 text-sm text-slate-900 transition-colors hover:border-brand-300"
          >
            <span>
              <span className="font-semibold">A swap is in progress.</span> <span className="text-slate-600">{summary(live, d.status)}</span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-brand-600">
              Open it <ArrowRight size={14} weight="bold" />
            </span>
          </Link>
        ) : null}

        <div className="grid grid-cols-1 items-stretch gap-6 lg:grid-cols-2">
          <SwapCard status={d.status} makers={makers} maker={maker} busySwap={live} />
          <MakerList makers={makers.list} role={d.role} selected={maker?.name ?? null} onSelect={setPick} fetchedAt={makers.fetchedAt} now={makers.now} error={makers.error} />
        </div>

        <div className="space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-xl font-semibold tracking-tight text-slate-900">My swaps</h2>
            <Label>
              ZEC ⇄ {coin().ticker} · {d.list.length} total
            </Label>
          </div>
          {d.list.length === 0 ? (
            <Card>
              <CardContent className="py-16 text-center text-slate-500">
                <ShieldCheck size={28} weight="duotone" className="mx-auto mb-3 text-brand-500" />
                <p>No {coin().ticker} swaps yet. Your first one shows up here.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4">
              {d.list.map((s) => (
                <SwapRow key={s.id} swap={s} status={d.status} />
              ))}
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}

// What the ZEC is swapped for: the coin, and for a token (USDC, WETH) the chain it's on. A pair
// without a daemon on this server can't be picked.
const COINS: CoinId[] = ["btc", "ltc", "usdc", "weth"];

function PairToggle() {
  const { pairs, pair, choosePair } = useLocal();
  const has = (id: PairId) => !!pairs.find((p) => p.id === id)?.daemon;
  const active = pairCoin(pair);
  const evm = active === "usdc" || active === "weth";
  // a token keeps the chain on screen when it can, else its first chain with a daemon
  const pickCoin = (c: CoinId) => {
    if (c === "btc" || c === "ltc") return choosePair(c);
    const same = pairId(c, pairChain(pair));
    choosePair(has(same) ? same : (EVM_CHAINS.map((ch) => pairId(c, ch)).find(has) ?? same));
  };
  return (
    <div className="mt-8 flex w-full flex-col items-center gap-3">
      <Segments label="What you swap ZEC for">
        {COINS.map((c) => {
          const info = coinInfo(c);
          const can = c === "btc" || c === "ltc" ? has(c) : EVM_CHAINS.some((ch) => has(pairId(c, ch)));
          return (
            <Segment key={c} active={c === active} can={can} title={can ? info.asset : `This server has no ${info.ticker} daemon`} onClick={() => pickCoin(c)}>
              <CoinMark id={c} size={18} className={can || c === active ? undefined : "opacity-40"} />
              <span className="font-mono text-xs tracking-[0.14em] uppercase">{info.ticker}</span>
            </Segment>
          );
        })}
      </Segments>
      {evm ? (
        <div className="flex items-center gap-3">
          <Label>On</Label>
          <Segments label={`Chain for ${coinInfo(active).ticker}`} small>
            {EVM_CHAINS.map((ch) => {
              const id = pairId(active, ch);
              return (
                <Segment key={ch} small active={id === pair} can={has(id)} title={has(id) ? CHAIN_NAMES[ch] : `This server has no ${coinInfo(active).ticker} daemon on ${CHAIN_NAMES[ch]}`} onClick={() => choosePair(id)}>
                  <span className="text-xs">{CHAIN_NAMES[ch]}</span>
                </Segment>
              );
            })}
          </Segments>
        </div>
      ) : null}
    </div>
  );
}

function Segments({ label, small, children }: { label: string; small?: boolean; children: ReactNode }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex max-w-full overflow-x-auto border border-slate-200 bg-white", small ? "p-0.5" : "p-1")}>
      {children}
    </div>
  );
}

function Segment({ active, can, small, title, onClick, children }: { active: boolean; can: boolean; small?: boolean; title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={!can}
      title={title}
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center gap-2 transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-brand-500/30 sm:gap-2.5",
        small ? "px-3 py-1.5" : "px-3 py-2 sm:px-5",
        active ? "bg-slate-900 text-white" : can ? "text-slate-700 hover:bg-slate-50" : "cursor-not-allowed text-slate-300",
      )}
    >
      {children}
    </button>
  );
}

function SwapCard({ status, makers, maker, busySwap }: { status: Status | null; makers: Makers; maker: Maker | null; busySwap?: SwapView }) {
  const { role, bt, daemon, pair } = useLocal();
  // with a maker directory the quote is the chosen maker's offer; an older server without one
  // leaves the daemon's own offer
  const offer: Quote | null = makers.list
    ? maker && quoteOf(maker)
    : makers.list === null && status
      ? { rate: status.offer.rate_sat_per_zec, min: status.offer.min_zat, max: status.offer.max_zat, fee: status.offer.fee_sat ?? null, liquidity: null }
      : null;
  const [amount, setAmount] = useState("1.00");
  const [touched, setTouched] = useState(false);
  // a host can cap swaps below the default amount (the public demo does): start at the cap
  useEffect(() => {
    const max = offer?.max;
    if (!touched && max != null && max < 1e8) setAmount(zec(max));
  }, [offer?.max, touched]);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  useEffect(() => setFail(null), [pair]);
  const zat = Math.round(Number(amount) * 1e8);
  const valid = amount.trim() !== "" && Number.isFinite(zat) && zat > 0;
  const gross = offer && valid ? Math.round((zat / 1e8) * offer.rate) : 0;
  // Z receives the locked amount less the fee of the transaction that pays it out
  const btcSide = btcText(role === "Z" ? Math.max(0, gross - (offer?.fee ?? 0)) : gross);
  const evm = coin().kind === "evm";

  let problem: string | null = null;
  if (amount.trim() === "") problem = "Enter how much ZEC.";
  else if (!valid) problem = "Enter an amount, like 1.00.";
  else if (makers.list && !maker) problem = `No maker is taking ${coin().ticker} swaps right now.`;
  else if (offer) {
    if (zat < offer.min) problem = `The smallest swap is ${zec(offer.min)} ZEC.`;
    else if (zat > offer.max) problem = `The largest swap is ${zec(offer.max)} ZEC.`;
    else if (offer.liquidity != null && zat > offer.liquidity) problem = `${maker?.name ?? "The maker"} can fill up to ${zec(offer.liquidity)} ZEC right now.`;
    else if (role === "Z" && status && zat > status.balances.zec_shielded_zat) problem = `You have ${zec(status.balances.zec_shielded_zat)} shielded ZEC.`;
    else if (role === "B" && status && gross > counterBalance(status)) problem = `You have ${btcText(counterBalance(status))} ${coin().ticker}.`;
  }
  const blocked = busySwap ? "Finish the swap in progress first." : null;

  const submit = async () => {
    if (problem || blocked || busy || !offer) return;
    setBusy(true);
    setFail(null);
    try {
      const { id } = await startSwap(zat, daemon, maker?.name);
      navigate(`/app/swap/${id}`);
    } catch (e) {
      setFail((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const zecBalance = status ? `${zec(status.balances.zec_shielded_zat)} ZEC` : "–";
  const coinBalance = status ? `${amountIn(counterBalance(status), coin())} ${coin().ticker}` : "–";

  return (
    <form
      className="flex min-w-0 flex-col border border-slate-200 bg-white p-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Panel
        label={role === "Z" ? "You send" : "You receive"}
        side={`Balance ${zecBalance}`}
        chip={<Chip id="zec" ticker="ZEC" />}
        note={role === "Z" ? "From your shielded balance. Nothing about it shows on chain." : "Into your shielded wallet. Nothing about it shows on chain."}
        editable
      >
        <input
          inputMode="decimal"
          autoComplete="off"
          aria-label={role === "Z" ? "ZEC to send" : "ZEC to receive"}
          value={amount}
          onChange={(e) => {
            setTouched(true);
            setAmount(e.target.value);
          }}
          aria-invalid={!!problem}
          className="w-full min-w-0 bg-transparent font-mono text-4xl font-medium tracking-tight text-slate-900 outline-none"
        />
      </Panel>

      <div className="relative z-10 -my-3.5 flex justify-center" aria-hidden>
        <span className="flex h-9 w-9 items-center justify-center border border-slate-200 bg-white text-slate-500">
          <ArrowDown size={16} weight="bold" />
        </span>
      </div>

      <Panel
        label={role === "Z" ? "You receive" : "You pay"}
        side={`Balance ${coinBalance}`}
        chip={<Chip id={pairCoin(pair)} ticker={coin().ticker} />}
        note={evm ? `On ${coin().name}, in the open, like any token transfer.` : `On ${coin().name}, in the open, like any ${coin().name} payment.`}
      >
        <span className={cn("block truncate font-mono text-4xl font-medium tracking-tight", valid && offer ? "text-slate-900" : "text-slate-300")}>{valid && offer ? btcSide : "0"}</span>
      </Panel>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-2 pt-4 pb-3 font-mono text-xs text-slate-600">
        <span>{offer ? `1 ZEC = ${btcText(offer.rate)} ${coin().ticker}` : "No rate yet"}</span>
        <span className="text-slate-500">{maker ? `via ${maker.name}` : null}</span>
      </div>

      <Button type="submit" size="none" className="h-13 w-full text-base" disabled={!status || !offer || !!problem || !!blocked || busy}>
        {busy ? "Starting…" : `Swap for ${coin().ticker}`}
      </Button>

      {problem || fail || blocked ? (
        <p className="mt-3 border border-rose-100 bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
          {problem ?? fail ?? blocked}
        </p>
      ) : null}

      <dl className="mt-3 grid grid-cols-3 gap-3 border-t border-slate-100 px-2 pt-4 pb-1">
        <Fact label="Network fee" value={evm ? "Gas, in ETH" : offer?.fee != null ? `${offer.fee.toLocaleString("en-US")} ${coin().unit}` : "–"} />
        <Fact label="Takes" value={status ? capital(roughDuration(typicalSeconds(status, bt))) : "–"} />
        <Fact label="If it fails" value="Coins come back" />
      </dl>
    </form>
  );
}

// One side of the swap: what it is, how much, the coin, and a line on where it goes.
function Panel({ label, side, chip, note, editable, children }: { label: string; side: string; chip: ReactNode; note: string; editable?: boolean; children: ReactNode }) {
  return (
    <label
      className={cn(
        "block border bg-slate-50 px-5 pt-4 pb-4",
        editable ? "border-slate-200 focus-within:border-brand-500 focus-within:bg-white focus-within:ring-3 focus-within:ring-brand-500/20" : "border-slate-200",
      )}
    >
      <span className="flex items-baseline justify-between gap-4">
        <Label>{label}</Label>
        <span className="font-mono text-[11px] text-slate-500">{side}</span>
      </span>
      <span className="mt-3 flex items-center gap-4">
        <span className="min-w-0 flex-1">{children}</span>
        {chip}
      </span>
      <span className="mt-3 block text-xs text-slate-500">{note}</span>
    </label>
  );
}

function Chip({ id, ticker }: { id: CoinId | "zec"; ticker: string }) {
  return (
    <span className="inline-flex h-10 shrink-0 items-center gap-2 border border-slate-200 bg-white pr-3.5 pl-2.5">
      <CoinMark id={id} size={22} />
      <span className="font-mono text-sm font-medium tracking-wider text-slate-900">{ticker}</span>
    </span>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[10px] tracking-widest text-slate-500 uppercase">{label}</dt>
      <dd className="mt-1 text-sm text-slate-900">{value}</dd>
    </div>
  );
}

function SwapRow({ swap, status }: { swap: SwapView; status: Status | null }) {
  const phase = phaseOf(swap);
  const st = STATUS[phase];
  const a = amounts(swap, status);
  const started = swap.timeline[0]?.at;
  const settled = phase === "done" || phase === "settled";
  return (
    <Link to={`/app/swap/${swap.id}`} className="group block">
      <Card className="transition-all hover:shadow-sm hover:ring-brand-300">
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="inline-flex items-center gap-2 text-base font-semibold text-slate-900">
            <span>Swap</span>
            <span className="font-mono text-xs text-slate-500">{`${swap.id.slice(0, 6)}...${swap.id.slice(-4)}`}</span>
          </CardTitle>
          <StatusBadge variant={st.tone}>{st.label}</StatusBadge>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
            <Detail label="Type" value={direction(swap.role)} />
            <Detail label={swap.role === "Z" ? "You send" : "You pay"} value={<span className="font-mono">{swap.role === "Z" ? a.zec : a.btc}</span>} />
            <Detail label={swap.role === "Z" ? "You receive" : "You receive"} value={<span className="font-mono">{swap.role === "Z" ? a.btc : a.zec}</span>} />
            <Detail label="Started" value={<span className="font-mono">{started ? new Date(started).toLocaleString() : "–"}</span>} />
          </div>
          <p className={`mt-3 ${settled ? "text-sm font-medium text-brand-600" : "font-mono text-xs text-slate-500"}`}>{summary(swap, status)}</p>
        </CardContent>
      </Card>
    </Link>
  );
}
