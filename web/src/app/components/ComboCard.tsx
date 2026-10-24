import { useEffect, useRef, useState } from "react";
import { Check, CircleNotch, Clock, Eye, GearSix, HandCoins, Info, ShieldCheck } from "@phosphor-icons/react";
import { NearError, counterBalance, startCombo, type NearHop, type NearToken, type PairId, type Pause, type Status } from "@/api";
import { amountIn } from "@/format";
import { navigate } from "@/router";
import { useLocal } from "../lib/daemon";
import { useMakers } from "../lib/makers";
import { chainName, nearText, numText, shade, useHop, useNear, whole } from "../lib/near";
import { storePause, storedPause } from "../lib/pairs";
import { NEAR_MIN, ROUTE_MIN, aboutText, nearAssetOf, type CardProps, type Side } from "../lib/paths";
import { nearKey, receiveFor, shortAddress, storeReceive, storedReceive, useReceive } from "../lib/receive";
import { PAUSE, PAUSES, coinFor, parseUnits, routeQuote, startAmount, tickerOf, unitsText, zecText, type RouteQuote } from "../lib/routes";
import { cn } from "../lib/utils";
import { Line, Point } from "./NearCard";
import { NearMark } from "./Logos";
import { ReceiveNext, ReceiveTo } from "./ReceiveTo";
import { Fact, FlipButton, Panel, PathLine, PrivacyLine, RouteChoice, Section, SidePill, amountSize } from "./SwapParts";
import { CoinPicker, tokenSubtitle } from "./TokenPicker";
import { Sheet } from "./ui/sheet";

// The swap card for a private swap with NEAR Intents at an end: coin A → shielded ZEC → coin C, two
// Ferry swaps, with NEAR Intents carrying C on to any of its assets (route-near), bringing an asset
// in as A (near-route), or both (near-near). The amount is what you sell: coin A from your own
// Ferry node, or an asset you send to NEAR Intents' deposit address from your own wallet. Each part
// is priced in turn (NEAR Intents' dry quote, then both Ferry partners, then NEAR Intents again),
// and the card shows what comes out at about today's prices and at least. The ZEC between the two
// Ferry swaps stays shielded; the NEAR parts are public, and the card says so.

// what a Bitcoin or Litecoin lock's own fee needs on top of the amount (ferryd's B keeps as much)
const LOCK_FEE_RESERVE = 10_000;
// the room between the quote shown and what the person agrees to: the real quote comes a moment later
const ROOM_BPS = 50;

// "1.5" in a token's units → base units, as a decimal string; null if it isn't an amount
export function toUnits(text: string, decimals: number): string | null {
  const t = text.trim();
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return null;
  const [w, f = ""] = t.split(".");
  if (f.length > decimals) return null;
  const n = BigInt((w || "0") + f.padEnd(decimals, "0"));
  return n > 0n ? n.toString() : null;
}
// what about $100 of a token is, rounded to two digits: a first amount that reads like a person typed it
export function firstAmount(t: NearToken | null): string {
  if (!t?.price) return "";
  const v = 100 / t.price;
  const step = 10 ** (Math.floor(Math.log10(v)) - 1);
  const r = Math.floor(v / step) * step;
  return r.toFixed(Math.max(0, -Math.floor(Math.log10(step)))).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}
const scaled = (v: string, num: number, den: number) => (den > 0 ? ((BigInt(v) * BigInt(Math.round(num))) / BigInt(Math.round(den))).toString() : v);

export function ComboCard({ pick, path, ctx, onPick, onFlip, blocked, optOut }: CardProps) {
  const d = useLocal();
  const near = useNear();
  const makers = useMakers();
  const kind = path.kind as "route-near" | "near-route" | "near-near";
  const front = kind !== "route-near";
  const back = kind !== "near-route";
  const [A, C] = (path.via as [string, string][])[0] as [PairId, PairId];
  const assetIn = front ? (near.byId[nearAssetOf(pick.sell)!] ?? null) : null;
  const assetOut = back ? (near.byId[nearAssetOf(pick.buy)!] ?? null) : null;
  const [amount, setAmount] = useState("");
  const [touched, setTouched] = useState(false);
  const [pause, setPauseState] = useState<Pause>(storedPause);
  const [picker, setPicker] = useState<Side | null>(null);
  const [settings, setSettings] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const setPause = (p: Pause) => {
    setPauseState(p);
    storePause(p);
  };

  // a first amount: about 1 ZEC's worth of coin A, or about $100 of the asset sent
  const first = front ? firstAmount(assetIn) : startAmount(makers.list, A, C);
  useEffect(() => setTouched(false), [pick.sell]);
  useEffect(() => {
    if (!touched && first) setAmount(first);
  }, [first, touched]);

  // what you sell, in base units
  const units = front ? (assetIn ? toUnits(amount, assetIn.decimals) : null) : (() => {
    const n = parseUnits(amount, A);
    return Number.isFinite(n) && n > 0 ? String(n) : null;
  })();
  // NEAR Intents first: what sending that delivers of coin A into your node
  const hopIn = useHop("in", front ? A : null, assetIn?.assetId ?? null, units);
  const reserve = coinFor(A).kind === "evm" ? 0 : LOCK_FEE_RESERVE;
  const maxIn = front ? (hopIn.hop ? Number(hopIn.hop.min_amount_out) - reserve : 0) : units ? Number(units) : 0;
  // the two Ferry swaps through shielded ZEC
  const got = maxIn > 0 ? routeQuote(makers.list, A, C, maxIn) : null;
  const q: RouteQuote | null = got && "maker1" in got ? got : null;
  // NEAR Intents last: what the least swap 2 pays comes to
  const hopOut = useHop("out", back ? C : null, assetOut?.assetId ?? null, q && q.minNet > 0 ? String(q.minNet) : null);

  // what comes out: about (at today's prices) and at least
  const outAbout = back ? (hopOut.hop && q ? scaled(hopOut.hop.amount_out, q.out, q.minNet) : null) : q ? String(q.out) : null;
  const outLeast = back ? (hopOut.hop ? shade(hopOut.hop.min_amount_out, ROOM_BPS) : null) : q ? String(q.minNet) : null;
  const outText = (v: string | null) => (!v ? "0" : back && assetOut ? nearText(v, assetOut).split(" ")[0] : amountIn(Number(v), coinFor(C)));
  const outName = back ? (assetOut?.symbol ?? "…") : tickerOf(C);
  const inName = front ? (assetIn?.symbol ?? "…") : tickerOf(A);

  const fromStatus: Status | null = d.pairs.find((p) => p.id === A)?.buy.status ?? null;
  const bal = !front && fromStatus ? counterBalance(fromStatus) : null;
  const problem = (() => {
    if (makers.list === null) return "This server has no partner list, so private swaps aren't available.";
    if (amount.trim() === "") return `Enter how much ${inName} to sell.`;
    if (!units) return "Enter an amount, like 0.5.";
    if (front && hopIn.error) return hopIn.error;
    if (got && !q) return got.problem;
    if (q?.problem) return q.problem;
    if (back && hopOut.error) return hopOut.error;
    if (bal != null && maxIn + reserve > bal) return maxIn > bal ? `You only have ${unitsText(bal, A)}.` : `Leave about ${unitsText(reserve, A)} for the network fee.`;
    return null;
  })();
  const loading = !problem && (hopIn.loading || hopOut.loading || (front && !hopIn.hop) || !q || (back && !hopOut.hop));
  const runs = path.runs;
  // ending on a Ferry coin (near-route): where it goes, your Ferry node or your own wallet (swap 2's
  // payout_to, on your own node)
  const toStatus: Status | null = d.pairs.find((p) => p.id === C)?.sell.status ?? null;
  const receive = !back && runs ? receiveFor(C, toStatus, d.info.own) : null;
  const receiveTo = useReceive(receive?.key ?? null);
  const message = problem ?? blocked;
  const minutes: [number, number] = [ROUTE_MIN[pause][0] + (front ? NEAR_MIN : 0) + (back ? NEAR_MIN : 0), ROUTE_MIN[pause][1] + (front ? NEAR_MIN : 0) + (back ? NEAR_MIN : 0)];
  const inWhole = Number(amount);
  const rate = outAbout && inWhole > 0 ? whole(outAbout, back ? (assetOut?.decimals ?? 0) : coinFor(C).decimals) / inWhole : null;

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
            {optOut ? <RouteChoice optOut={optOut} /> : null}
            <Section title="Privacy pause" note="A random wait between the two Ferry swaps, so they're harder to match up.">
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
            <Section title="The parts" note="The two Ferry swaps are atomic and private, with a different partner each. NEAR Intents' part is public, and you trust it for that part.">
              <dl className="space-y-3 px-5 pb-1 text-sm">
                {front ? <Fact label="NEAR Intents" value={`Swaps your ${inName} for ${tickerOf(A)} and sends it to your Ferry node`} /> : null}
                <Fact label="Swap 1" value={q ? `${q.maker1.name} sells you shielded ZEC for ${tickerOf(A)}` : "–"} />
                <Fact label="Swap 2" value={q ? `${q.maker2.name} buys it for ${tickerOf(C)}${back ? ", paid straight to NEAR Intents" : ""}` : "–"} />
                {back ? <Fact label="NEAR Intents" value={`Swaps the ${tickerOf(C)} for ${outName} and sends it to your address`} /> : null}
              </dl>
            </Section>
            <Section title="Details" last>
              <dl className="space-y-3 px-5 text-sm">
                <Fact label="Typical time" value={aboutText(minutes).replace(/^a/, "A")} />
                <Fact
                  label="If it fails"
                  value={`${front ? `If NEAR Intents can't fill its part, it refunds your ${inName}. ` : ""}If swap 1 stops, your ${tickerOf(A)} comes back${front ? " to your Ferry node" : ""}. If swap 2 can't run, you keep the ZEC, shielded.${back ? ` If NEAR Intents can't fill the last part, it refunds the ${tickerOf(C)} to your Ferry node.` : ""}`}
                />
                <Fact label="Privacy" value={path.privacy} />
              </dl>
            </Section>
          </Sheet>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (runs && !problem && !blocked && !loading && q) setConfirm(true);
        }}
      >
        <div className="flex flex-col">
          <Panel
            label="Sell"
            onClick={() => input.current?.focus()}
            pill={<SidePill token={pick.sell} side="sell" onOpen={() => setPicker("sell")} name={front && assetIn ? `${assetIn.symbol} on ${chainName(assetIn.blockchain)}, via NEAR Intents` : undefined} />}
            foot={
              front && assetIn ? (
                <span className="flex min-w-0 items-center gap-1.5 truncate">
                  {chainName(assetIn.blockchain)}
                  <span aria-hidden>·</span>
                  <NearMark size={12} />
                  from your own wallet
                </span>
              ) : (
                <span className="truncate tabular-nums">{bal == null ? "You have –" : `You have ${unitsText(bal, A)}`}</span>
              )
            }
          >
            <input
              ref={input}
              inputMode="decimal"
              autoComplete="off"
              aria-label={`${inName} to sell`}
              placeholder="0"
              value={amount}
              onChange={(e) => {
                setTouched(true);
                setAmount(e.target.value.replace(",", "."));
              }}
              aria-invalid={!!problem && !!units}
              aria-describedby="combo-message"
              className={cn("h-12 w-full min-w-0 bg-transparent leading-none font-medium tracking-tight text-slate-900 tabular-nums placeholder:text-slate-300 focus:outline-none focus-visible:outline-none", amountSize(amount))}
            />
          </Panel>
          <FlipButton onFlip={onFlip} title={`Sell ${outName} for ${inName} instead`} />
          <Panel
            label="Buy"
            pill={<SidePill token={pick.buy} side="buy" onOpen={() => setPicker("buy")} name={back && assetOut ? `${assetOut.symbol} on ${chainName(assetOut.blockchain)}, via NEAR Intents` : undefined} />}
            foot={
              back && assetOut ? (
                <span className="flex min-w-0 items-center gap-1.5 truncate">
                  {chainName(assetOut.blockchain)}
                  <span aria-hidden>·</span>
                  <NearMark size={12} />
                  via NEAR Intents
                </span>
              ) : (
                <span className="truncate">{tokenSubtitle(C)}</span>
              )
            }
          >
            <output aria-live="polite" aria-label={`You get ${outName}`} className={cn("flex h-12 items-center truncate leading-none font-medium tracking-tight tabular-nums", amountSize(outText(outAbout)), outAbout ? "text-slate-900" : "text-slate-300")}>
              {outAbout ? `≈${outText(outAbout)}` : "0"}
            </output>
          </Panel>
        </div>
        {back ? runs && d.info.own ? <ReceiveNext symbol={outName} /> : null : <ReceiveTo coin={receive} />}

        <div className="mt-3 min-h-5 space-y-0.5 px-1 text-[13px] text-slate-500">
          {outAbout && rate != null ? (
            <p>
              <span className="text-slate-700 tabular-nums">
                1 {inName} ≈ {numText(rate)} {outName}
              </span>
              {outLeast ? <span className="tabular-nums"> · at least {outText(outLeast)} {outName}</span> : null}
            </p>
          ) : loading && units ? (
            <p>Finding the best price…</p>
          ) : null}
          <PathLine path={path} via={front ? [A, ...(back ? [C] : [])] : [C]} time={aboutText(minutes)} />
        </div>

        {runs ? null : (
          <p className="mt-3 flex items-start gap-2 rounded-2xl bg-slate-50 px-4 py-3 text-[13px] text-slate-600" data-near-off>
            <Info size={16} className="mt-px shrink-0 text-slate-500" aria-hidden />
            <span>{path.reason}</span>
          </p>
        )}

        <button
          type="submit"
          disabled={!runs || !q || loading || !!problem || !!blocked}
          className="mt-3 flex h-14 w-full items-center justify-center rounded-2xl bg-slate-900 text-base font-semibold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
        >
          {runs ? path.button : "Swap on your own node"}
        </button>
        <p id="combo-message" role={message ? "alert" : undefined} className={cn("mt-3 text-center text-sm", !message ? "sr-only" : message === blocked ? "text-slate-600" : "text-rose-600")}>
          {message ?? ""}
        </p>
      </form>

      <PrivacyLine text={path.privacy} />

      <CoinPicker open={picker !== null} onClose={() => setPicker(null)} side={picker ?? "sell"} pick={pick} ctx={ctx} makers={makers} onPick={(t) => onPick(picker ?? "sell", t)} />
      {confirm && q && units ? (
        <ComboConfirm
          onClose={() => setConfirm(false)}
          kind={kind}
          A={A}
          C={C}
          assetIn={assetIn}
          assetOut={assetOut}
          units={units}
          maxIn={maxIn}
          q={q}
          hopIn={hopIn.hop}
          pause={pause}
          minutes={minutes}
          outName={outName}
          outAbout={outAbout}
          payoutTo={receiveTo}
        />
      ) : null}
    </>
  );
}

// The addresses NEAR Intents needs (where the last asset goes; where a refund of the first goes),
// each checked by NEAR Intents as it's typed, then the amounts and what's different, on one sheet.
function ComboConfirm({
  onClose,
  kind,
  A,
  C,
  assetIn,
  assetOut,
  units,
  maxIn,
  q,
  hopIn,
  pause,
  minutes,
  outName,
  outAbout,
  payoutTo,
}: {
  onClose: () => void;
  kind: "route-near" | "near-route" | "near-near";
  A: PairId;
  C: PairId;
  assetIn: NearToken | null;
  assetOut: NearToken | null;
  units: string;
  maxIn: number;
  q: RouteQuote;
  hopIn: NearHop | null;
  pause: Pause;
  minutes: [number, number];
  outName: string;
  outAbout: string | null;
  // near-route: the person's own wallet for coin C (null: their Ferry node)
  payoutTo: string | null;
}) {
  const near = useNear();
  const front = kind !== "route-near";
  const back = kind !== "near-route";
  // the addresses last used on these chains, offered again
  const [address, setAddress] = useState(() => (assetOut ? (storedReceive(nearKey(assetOut.blockchain)) ?? "") : ""));
  const [refund, setRefund] = useState(() => (assetIn ? (storedReceive(nearKey(assetIn.blockchain)) ?? "") : ""));
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const dest = address.trim();
  const ref = refund.trim();
  // NEAR Intents checks each address in a quote that names it
  const outChecked = useHop("out", back ? C : null, assetOut?.assetId ?? null, back && dest.length >= 8 ? String(q.minNet) : null, dest.length >= 8 ? dest : null);
  const inChecked = useHop("in", front ? A : null, assetIn?.assetId ?? null, front && ref.length >= 8 ? units : null, ref.length >= 8 ? ref : null);
  useEffect(() => setFail(null), [dest, ref]);
  const outOk = !back || (outChecked.hop?.address === "ok" && !outChecked.error);
  const inOk = !front || (inChecked.hop?.address === "ok" && !inChecked.error);
  const minAssetOut = back && outChecked.hop ? shade(outChecked.hop.min_amount_out, ROOM_BPS) : null;
  const minMid = front ? shade((inChecked.hop ?? hopIn)?.min_amount_out ?? "0", ROOM_BPS) : null;

  const field = (value: string, checked: { hop: NearHop | null; error: string | null; field: string | null; loading: boolean }, t: NearToken, purpose: "dest" | "refund") => {
    const sym = t.symbol;
    const chain = chainName(t.blockchain);
    const s: { tone: "idle" | "checking" | "ok" | "bad"; text: string } =
      value.length === 0
        ? { tone: "idle", text: purpose === "dest" ? `NEAR Intents sends the ${sym} here, on ${chain}.` : `If NEAR Intents can't complete, it sends your ${sym} back here.` }
        : value.length < 8
          ? { tone: "bad", text: "That's too short for an address." }
          : checked.loading
            ? { tone: "checking", text: "Checking with NEAR Intents…" }
            : checked.error
              ? { tone: "bad", text: checked.error }
              : checked.hop?.address === "ok"
                ? { tone: "ok", text: `NEAR Intents accepts this ${chain} address.` }
                : { tone: "checking", text: "Checking with NEAR Intents…" };
    return s;
  };
  const destState = back && assetOut ? field(dest, outChecked, assetOut, "dest") : null;
  const refundState = front && assetIn ? field(ref, inChecked, assetIn, "refund") : null;

  const start = async () => {
    if (!outOk || !inOk || busy) return;
    setBusy(true);
    setFail(null);
    try {
      const job = await startCombo({
        kind,
        route: { from: A, to: C, zec_zat: q.zat, min_out: q.minOut, pause, ...(front ? {} : { maker1: q.maker1.name, maker2: [q.maker2.name], max_in: maxIn }) },
        ...(front ? { asset_in: assetIn!.assetId, amount_in: units, refund_address: ref, min_mid: minMid! } : {}),
        ...(back ? { asset_out: assetOut!.assetId, address: dest, min_asset_out: minAssetOut! } : payoutTo ? { payout_to: payoutTo } : {}),
      });
      if (back && assetOut) storeReceive(nearKey(assetOut.blockchain), dest);
      if (front && assetIn) storeReceive(nearKey(assetIn.blockchain), ref);
      near.putCombo(job);
      onClose();
      navigate(`/app/combo/${job.id}`);
    } catch (e) {
      const err = e as NearError;
      if (err.code === "price_moved") {
        outChecked.refresh();
        inChecked.refresh();
      }
      setFail(err.message.replace(/\bdaemon\b/gi, "Ferry node").replace(/\bmaker\b/gi, "partner"));
    } finally {
      setBusy(false);
    }
  };

  const input = (label: string, value: string, set: (v: string) => void, state: { tone: string; text: string }, id: string, autofocus: boolean, placeholder: string) => (
    <div className="mt-4 first:mt-0">
      <label className="block">
        <span className="text-[13px] font-medium text-slate-700">{label}</span>
        <input
          value={value}
          onChange={(e) => set(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          data-autofocus={autofocus || undefined}
          aria-invalid={state.tone === "bad"}
          aria-describedby={id}
          placeholder={placeholder}
          className={cn(
            "mt-1.5 h-12 w-full rounded-2xl border bg-slate-50 px-3.5 font-mono text-[13px] text-slate-900 placeholder:font-sans placeholder:text-slate-400 focus:bg-white focus:outline-none",
            state.tone === "bad" ? "border-rose-300" : state.tone === "ok" ? "border-emerald-300" : "border-slate-200 focus:border-slate-300",
          )}
        />
      </label>
      <p id={id} role={state.tone === "bad" ? "alert" : undefined} className={cn("mt-1.5 flex items-center gap-1.5 text-[13px]", state.tone === "bad" ? "text-rose-600" : state.tone === "ok" ? "text-emerald-700" : "text-slate-500")}>
        {state.tone === "ok" ? <Check size={14} weight="bold" aria-hidden /> : state.tone === "checking" ? <CircleNotch size={14} weight="bold" className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
        {state.text}
      </p>
    </div>
  );
  const placeholderFor = (t: NearToken | null) => (t?.blockchain === "sol" ? "e.g. 7dKb…Qk5i" : t?.blockchain === "near" ? "e.g. alice.near" : "Paste an address");

  return (
    <Sheet open onClose={onClose} title={back ? `Where should the ${outName} go?` : "Where should a refund go?"}>
      <div className="px-5 pb-5">
        {back && assetOut && destState ? input(`Receive to: your ${assetOut.symbol} address on ${chainName(assetOut.blockchain)}`, address, setAddress, destState, "combo-dest-note", true, placeholderFor(assetOut)) : null}
        {front && assetIn && refundState ? input(`Your ${assetIn.symbol} address on ${chainName(assetIn.blockchain)}, for a refund`, refund, setRefund, refundState, "combo-refund-note", !back, placeholderFor(assetIn)) : null}

        <dl className="mt-5 space-y-2.5 rounded-2xl bg-slate-50 px-4 py-3.5 text-sm tabular-nums">
          {front && assetIn ? <Line label="You send" value={nearText(units, assetIn)} strong /> : <Line label="You pay at most" value={unitsText(maxIn, A)} strong />}
          <Line label="Through" value={`${tickerOf(A)} → ${zecText(q.zat)} → ${tickerOf(C)}`} />
          {back ? (
            <>
              <Line label="You get at least" value={minAssetOut && assetOut ? nearText(minAssetOut, assetOut) : "–"} strong />
              <Line label="About" value={outAbout && assetOut ? nearText(outAbout, assetOut) : "–"} />
            </>
          ) : (
            <>
              <Line label="You get at least" value={unitsText(q.minNet, C)} strong />
              <Line label="About" value={unitsText(q.out, C)} />
              <Line label="Receive to" value={payoutTo ? `Your wallet ${shortAddress(payoutTo)}` : "Your Ferry node"} />
            </>
          )}
          <Line label="Takes" value={aboutText(minutes)} />
        </dl>

        <ul className="mt-5 space-y-4 text-[15px]">
          <Point icon={<ShieldCheck size={18} />} title="Your coins pass through the shielded pool">
            Two Ferry swaps with shielded ZEC between them, and a different partner each. No transaction links the two; only the amounts and the timing could hint at it.
          </Point>
          <Point icon={<Eye size={18} />} title="The NEAR Intents part is public">
            {front ? `You send your ${assetIn?.symbol} to NEAR Intents' deposit address, in public, and trust it to deliver ${tickerOf(A)} to your Ferry node. ` : ""}
            {back ? `The ${tickerOf(C)}, the ${outName} and your address are on public chains, and you trust NEAR Intents to deliver the ${outName}.` : ""} Ferry never sends ZEC to NEAR Intents.
          </Point>
          <Point icon={<Clock size={18} />} title="It takes longer">
            {aboutText(minutes).replace(/^a/, "A")} in all, with a random pause between the two Ferry swaps. You can close this page.
          </Point>
          <Point icon={<HandCoins size={18} />} title="If something stops">
            {front ? `NEAR Intents refunds your ${assetIn?.symbol} to the address above. ` : ""}If a Ferry swap stops, your coins come back; if the second can't run, you keep the ZEC.{back ? ` If NEAR Intents can't fill the last part, it refunds the ${tickerOf(C)} to your Ferry node.` : ""}
          </Point>
        </ul>

        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            onClick={start}
            disabled={!outOk || !inOk || busy}
            className="flex h-12 w-full items-center justify-center rounded-2xl bg-slate-900 text-[15px] font-semibold text-white transition-colors hover:bg-slate-800 disabled:bg-slate-100 disabled:text-slate-400"
          >
            {busy ? "Starting…" : front ? "Get deposit address" : "Start private swap"}
          </button>
          <button type="button" onClick={onClose} className="flex h-11 w-full items-center justify-center rounded-2xl text-[15px] font-medium text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900">
            Not now
          </button>
        </div>
        {fail ? (
          <p role="alert" className="mt-3 text-center text-sm text-rose-600">
            {fail}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
