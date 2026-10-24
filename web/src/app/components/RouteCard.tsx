import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Clock, GearSix, HandCoins, Hourglass, ShieldCheck } from "@phosphor-icons/react";
import { counterBalance, startRoute, type Pause, type PairId, type Status } from "@/api";
import { amountIn } from "@/format";
import { navigate } from "@/router";
import { useLocal } from "../lib/daemon";
import { useMakers } from "../lib/makers";
import { storePause, storedPause } from "../lib/pairs";
import { type CardProps, type Side } from "../lib/paths";
import { useQuotes } from "../lib/quotes";
import { PAUSE, PAUSES, coinFor, parseUnits, routeQuote, startAmount, tickerOf, unitsText, useRoutes, zecText, type RouteQuote } from "../lib/routes";
import { cn } from "../lib/utils";
import { RouteStrip } from "./RouteStrip";
import { CoinPicker, tokenSubtitle } from "./TokenPicker";
import { Fact, FlipButton, Panel, PathLine, PrivacyLine, Section, SidePill, amountSize } from "./SwapParts";
import { Sheet } from "./ui/sheet";

// The swap card for two Ferry coins: a private swap, the default for any two coins. Sell one coin,
// Buy another, and Ferry runs two swaps through Zcash's shielded pool, coin → shielded ZEC → coin
// (the user's router does). The amount is what you sell, at most: the first swap buys as much ZEC
// as that pays for, rounded down, at its partner's live rate; the second sells it at the best price
// now, and never for less than a little under it, else you keep the ZEC. The path line says it's
// private and how long it takes; a short confirmation says what's different before anything starts.

// what a Bitcoin or Litecoin lock's own fee needs on top of the amount (ferryd's B keeps as much)
const LOCK_FEE_RESERVE = 10_000;

export function RouteCard({ pick, path, ctx, onPick, onFlip, blocked }: CardProps) {
  const from = path.from as PairId;
  const to = path.to as PairId;
  const d = useLocal();
  const routes = useRoutes();
  const makers = useMakers();
  const [amount, setAmount] = useState("");
  const [touched, setTouched] = useState(false);
  const [pause, setPauseState] = useState<Pause>(storedPause);
  const [picker, setPicker] = useState<Side | null>(null);
  const [settings, setSettings] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const setPause = (p: Pause) => {
    setPauseState(p);
    storePause(p);
  };

  // a new coin to sell starts from a fresh amount
  useEffect(() => {
    setTouched(false);
    setFail(null);
  }, [from]);
  useEffect(() => setFail(null), [to]);
  const first = startAmount(makers.list, from, to);
  useEffect(() => {
    if (!touched && first) setAmount(first);
  }, [first, touched]);

  const maxIn = parseUnits(amount, from);
  const valid = Number.isFinite(maxIn) && maxIn > 0;
  // the second swap's firm prices: the best estimate of what it pays (it starts later, so it can't
  // hold one)
  const pre = valid ? routeQuote(makers.list, from, to, maxIn) : null;
  const quotes = useQuotes(to, "Z", pre && "maker1" in pre && pre.zat2 > 0 ? pre.zat2 : 0);
  const got = valid ? routeQuote(makers.list, from, to, maxIn, quotes.list) : null;
  const q: RouteQuote | null = got && "maker1" in got ? got : null;

  const a = coinFor(from);
  const c = coinFor(to);
  // your coin A, from your Ferry node that buys ZEC with it (the one followed, if it's that one)
  const fromStatus: Status | null = (d.dir === "buy" && d.pair === from ? d.status : null) ?? d.pairs.find((p) => p.id === from)?.buy.status ?? null;
  const toStatus: Status | null = (d.dir === "sell" && d.pair === to ? d.status : null) ?? d.pairs.find((p) => p.id === to)?.sell.status ?? null;
  const bal = fromStatus ? counterBalance(fromStatus) : null;
  const evm = a.kind === "evm";

  const problem = (() => {
    if (makers.list === null) return "This server has no partner list, so private swaps aren't available.";
    if (amount.trim() === "") return `Enter how much ${a.ticker} to sell.`;
    if (!valid) return `Enter an amount, like ${first ?? "0.01"}.`;
    if (got && !q) return got.problem;
    if (q?.problem) return q.problem;
    if (bal != null) {
      if (maxIn > bal) return `You only have ${unitsText(bal, from)}.`;
      if (!evm && maxIn + LOCK_FEE_RESERVE > bal) return `Leave about ${unitsText(LOCK_FEE_RESERVE, from)} for the network fee, or use Max.`;
      if (evm && fromStatus?.balances.eth_wei === "0") return "Your Ferry node needs a little ETH to pay for gas.";
    }
    return null;
  })();

  const max = bal == null ? null : Math.max(0, bal - (evm ? 0 : LOCK_FEE_RESERVE));
  const setMax = () => {
    if (max == null) return;
    setTouched(true);
    setAmount(amountIn(max, { ...a, places: a.decimals }));
    input.current?.focus();
  };

  const start = async () => {
    if (!q || problem || blocked || busy) return;
    setBusy(true);
    setFail(null);
    try {
      const v = await startRoute({ from, to, zec_zat: q.zat, maker1: q.maker1.name, maker2: [q.maker2.name], max_in: maxIn, min_out: q.minOut, pause });
      routes.put(v);
      setConfirm(false);
      // refused at once (the first partner said no): nothing moved, so say why here
      if (v.state === "failed" && v.outcome === "not_started") setFail(plain(v.note));
      else navigate(`/app/route/${v.id}`);
    } catch (e) {
      setConfirm(false);
      setFail(plain((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const message = problem ?? blocked ?? fail;
  const out = q ? amountIn(q.out, c) : "0";
  // what 1 of coin A comes to in coin C, through ZEC, at both partners' prices
  const rate = q ? amountIn(Math.round((q.rate2 / q.rate1) * 10 ** a.decimals), c) : null;

  const youHave = (s: Status | null, id: PairId) => {
    const n = s ? counterBalance(s) : null;
    return <span className="truncate tabular-nums">{n == null ? "You have –" : `You have ${unitsText(n, id)}`}</span>;
  };

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Swap</h1>
        <div className="relative">
          <button
            type="button"
            onClick={() => setSettings(true)}
            aria-haspopup="dialog"
            aria-label={`Settings: privacy pause ${PAUSE[pause].label}`}
            className="inline-flex h-9 items-center gap-2 rounded-full border border-slate-200 bg-white pr-2.5 pl-3.5 text-sm text-slate-700 shadow-[0_1px_2px_rgba(24,24,27,0.04)] transition-colors hover:border-slate-300 hover:text-slate-900"
          >
            <span className="text-slate-500">Pause</span>
            <span className="font-medium text-slate-900">{PAUSE[pause].label}</span>
            <GearSix size={16} weight="bold" className="text-slate-500" aria-hidden />
          </button>
          <Sheet anchored open={settings} onClose={() => setSettings(false)} title="Private swap settings">
            <Section title="Privacy pause" note="A random wait between the two swaps, so they're harder to match up.">
              <div role="radiogroup" aria-label="Privacy pause" className="space-y-1 px-2">
                {PAUSES.map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={pause === p}
                    onClick={() => setPause(p)}
                    className={cn("flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors", pause === p ? "bg-slate-100" : "hover:bg-slate-50")}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="font-medium text-slate-900">{PAUSE[p].label}</span>
                        <span className="shrink-0 text-[13px] text-slate-500">{PAUSE[p].window}</span>
                      </span>
                      <span className="mt-0.5 block text-[13px] text-slate-500">{PAUSE[p].note}</span>
                    </span>
                    {pause === p ? <Check size={16} weight="bold" className="shrink-0 text-slate-900" aria-hidden /> : <span className="w-4 shrink-0" aria-hidden />}
                  </button>
                ))}
              </div>
            </Section>
            <Section title="Partners" note="Picked for the best price, and never the same one for both swaps, so no single partner sees both sides.">
              <dl className="space-y-3 px-5 pb-1 text-sm">
                <Fact label="Swap 1" value={q ? `${q.maker1.name} sells you the ZEC` : "–"} />
                <Fact label="Swap 2" value={q ? `${q.maker2.name} buys it` : "–"} />
              </dl>
            </Section>
            <Section title="Details" last>
              <dl className="space-y-3 px-5 text-sm">
                <Fact label="You pay" value={valid ? `At most ${unitsText(maxIn, from)}` : "–"} />
                <Fact label="You get" value={q ? `About ${unitsText(q.out, to)}, and at least ${unitsText(q.minNet, to)}` : "–"} />
                <Fact label="Typical time" value={`${PAUSE[pause].total[0].toUpperCase()}${PAUSE[pause].total.slice(1)}`} />
                <Fact label="If it fails" value={`If swap 1 stops, your ${a.ticker} comes back. If swap 2 can't run, you keep the ZEC, shielded.`} />
                <Fact label="Privacy" value={`No transaction links the ${a.ticker} you sell to the ${c.ticker} you get. Only the amounts and the timing could hint at it, and the pause blurs the timing.`} />
              </dl>
            </Section>
          </Sheet>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!problem && !blocked && q) setConfirm(true);
        }}
      >
        <div className="flex flex-col">
          <Panel
            label="Sell"
            onClick={() => input.current?.focus()}
            pill={<SidePill token={from} side="sell" onOpen={() => setPicker("sell")} />}
            foot={
              <>
                {youHave(fromStatus, from)}
                <button type="button" onClick={setMax} disabled={max == null} className="rounded-full px-2 py-0.5 text-xs font-semibold text-slate-900 transition-colors hover:bg-slate-200/70 disabled:text-slate-400">
                  Max
                </button>
              </>
            }
          >
            <input
              ref={input}
              inputMode="decimal"
              autoComplete="off"
              aria-label={`${a.ticker} to sell`}
              placeholder="0"
              value={amount}
              onChange={(e) => {
                setTouched(true);
                setAmount(e.target.value.replace(",", "."));
              }}
              aria-invalid={!!problem && valid}
              aria-describedby="route-message"
              className={cn("h-12 w-full min-w-0 bg-transparent leading-none font-medium tracking-tight text-slate-900 tabular-nums placeholder:text-slate-300 focus:outline-none focus-visible:outline-none", amountSize(amount))}
            />
          </Panel>
          <FlipButton onFlip={onFlip} title={`Sell ${c.ticker} for ${a.ticker} instead`} />
          <Panel
            label="Buy"
            pill={<SidePill token={to} side="buy" onOpen={() => setPicker("buy")} />}
            foot={
              <>
                <span className="truncate">{tokenSubtitle(to)}</span>
                <span className="shrink-0">{youHave(toStatus, to)}</span>
              </>
            }
          >
            <output aria-live="polite" aria-label={`You get ${c.ticker}`} className={cn("flex h-12 items-center truncate leading-none font-medium tracking-tight tabular-nums", amountSize(out), q ? "text-slate-900" : "text-slate-300")}>
              {out}
            </output>
          </Panel>
        </div>

        <div className="mt-3 space-y-0.5 px-1 text-[13px] text-slate-500">
          {q ? (
            <p>
              <span className="text-slate-700 tabular-nums">
                1 {a.ticker} ≈ {rate} {c.ticker}
              </span>
              <span className="tabular-nums"> · at least {unitsText(q.minNet, to)}</span>
            </p>
          ) : makers.list === undefined ? (
            <p>Finding the best price…</p>
          ) : null}
          <PathLine path={path} time={PAUSE[pause].total} />
        </div>

        <button
          type="submit"
          disabled={!q || !!problem || !!blocked || busy}
          className="mt-3 flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-slate-900 text-base font-semibold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
        >
          {path.button}
        </button>
        <p id="route-message" role={message ? "alert" : undefined} className={cn("mt-3 text-center text-sm", !message ? "sr-only" : message === blocked ? "text-slate-600" : "text-rose-600")}>
          {message ?? ""}
        </p>
      </form>

      <PrivacyLine text={path.privacy} />

      <CoinPicker open={picker !== null} onClose={() => setPicker(null)} side={picker ?? "sell"} pick={pick} ctx={ctx} makers={makers} onPick={(t) => onPick(picker ?? "sell", t)} />
      {q ? <Confirm open={confirm} onClose={() => setConfirm(false)} from={from} to={to} q={q} pause={pause} busy={busy} onStart={start} /> : null}
    </>
  );
}

// What's different about a private swap, on one screen, before anything moves.
function Confirm({ open, onClose, from, to, q, pause, busy, onStart }: { open: boolean; onClose: () => void; from: PairId; to: PairId; q: RouteQuote; pause: Pause; busy: boolean; onStart: () => void }) {
  const a = tickerOf(from);
  const c = tickerOf(to);
  return (
    <Sheet open={open} onClose={onClose} title="Swap privately">
      <div className="px-5 pb-5">
        <RouteStrip from={from} to={to} sell={unitsText(q.maxIn, from)} zec={zecText(q.zat)} get={unitsText(q.out, to)} getNote="about" />

        <ul className="mt-5 space-y-4 text-[15px]">
          <Point icon={<Clock size={18} weight="regular" />} title="It takes longer">
            Two swaps, one after the other: {PAUSE[pause].total} in all. You can close this page.
          </Point>
          <Point icon={<ShieldCheck size={18} weight="regular" />} title="Your coins pass through the shielded pool">
            Your {a} becomes shielded ZEC, then {c}. No transaction links the two; only the amounts and the timing could hint at it.
          </Point>
          <Point icon={<Hourglass size={18} weight="regular" />} title="The waiting is on purpose">
            {pause === "off" ? "You turned the pause off, so the two swaps run back to back. That's faster, but easier to match up." : "A random pause between the two swaps makes them harder to match up."}
          </Point>
          <Point icon={<HandCoins size={18} weight="regular" />} title="Your money is never stuck">
            If the first swap stops, your {a} comes back. If the second can't run at your price, you keep the ZEC and can finish later.
          </Point>
        </ul>

        <p className="mt-5 text-[13px] text-slate-500 tabular-nums">
          You pay at most {unitsText(q.maxIn, from)} and get at least {unitsText(q.minNet, to)}, or keep about {zecText(q.zat)}.
        </p>
        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            onClick={onStart}
            disabled={busy}
            data-autofocus
            className="flex h-12 w-full items-center justify-center rounded-2xl bg-slate-900 text-[15px] font-semibold text-white transition-colors hover:bg-slate-800 disabled:bg-slate-100 disabled:text-slate-400"
          >
            {busy ? "Starting…" : "Start private swap"}
          </button>
          <button type="button" onClick={onClose} className="flex h-11 w-full items-center justify-center rounded-2xl text-[15px] font-medium text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900">
            Not now
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function Point({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block font-medium text-slate-900">{title}</span>
        <span className="mt-0.5 block text-sm text-slate-600">{children}</span>
      </span>
    </li>
  );
}

// The router's and proxy's errors, for people.
function plain(raw: string): string {
  if (/already (in progress|using)/i.test(raw)) return /private swap|route/i.test(raw) ? "Finish the private swap in progress first." : "Finish the swap in progress first.";
  if (/reach|unreachable|timed? ?out|connection refused/i.test(raw)) return "Couldn't reach a partner or your Ferry node. Try again in a moment.";
  if (/api token/i.test(raw)) return "Your Ferry node refused this page. Check how the app was started.";
  return raw.replace(/\bdaemon\b/gi, "Ferry node").replace(/\bmakers?\b/gi, "partner").replace(/\broute\b/gi, "private swap");
}
