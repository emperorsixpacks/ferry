import { useEffect, useRef, useState } from "react";
import { Check, CircleNotch, Eye, GearSix, HandCoins, Info } from "@phosphor-icons/react";
import { NearError, startCombo, type NearToken } from "@/api";
import { navigate } from "@/router";
import { aboutTime, chainName, nearText, numText, shade, useDirect, useNear, whole, type HopQuoted } from "../lib/near";
import { type CardProps, type Side } from "../lib/paths";
import { nearKey, storeReceive, storedReceive } from "../lib/receive";
import { cn } from "../lib/utils";
import { firstAmount, toUnits } from "./ComboCard";
import { NearMark } from "./Logos";
import { Line, Point } from "./NearCard";
import { Fact, FlipButton, Panel, PathLine, PrivacyLine, RouteChoice, Section, SidePill, amountSize } from "./SwapParts";
import { CoinPicker } from "./TokenPicker";
import { Sheet } from "./ui/sheet";

// The opt-out from a private swap, for two coins: NEAR Intents alone. You send the coin from your own
// wallet to NEAR Intents' deposit address, and it sends the other to your address. Faster, and public
// end to end: anyone can link what you sold to what you got. Only ever chosen in the settings sheet,
// for these two coins, and the card says so: the path line reads "public", the line under the card
// says what it costs, and switching back is one tap away.

// the room between the quote shown and what the person agrees to: the real quote comes a moment later
const ROOM_BPS = 50;

export function NearOnlyCard({ pick, path, ctx, onPick, onFlip, blocked, optOut }: CardProps) {
  const near = useNear();
  const from = path.asset_in ? (near.byId[path.asset_in] ?? null) : null;
  const to = path.asset_out ? (near.byId[path.asset_out] ?? null) : null;
  const [amount, setAmount] = useState("");
  const [touched, setTouched] = useState(false);
  const [picker, setPicker] = useState<Side | null>(null);
  const [settings, setSettings] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const first = firstAmount(from);
  useEffect(() => setTouched(false), [pick.sell]);
  useEffect(() => {
    if (!touched && first) setAmount(first);
  }, [first, touched]);

  const units = from ? toUnits(amount, from.decimals) : null;
  const q = useDirect(from?.assetId ?? null, to?.assetId ?? null, units);
  const out = q.hop?.amount_out ?? null;
  const least = q.hop ? shade(q.hop.min_amount_out, ROOM_BPS) : null;
  const inName = from?.symbol ?? "…";
  const outName = to?.symbol ?? "…";
  const problem = amount.trim() === "" ? `Enter how much ${inName} to sell.` : !units ? "Enter an amount, like 0.5." : q.error;
  const message = problem ?? blocked;
  const rate = out && to && Number(amount) > 0 ? whole(out, to.decimals) / Number(amount) : null;

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Swap</h1>
        <div className="relative">
          <button
            type="button"
            onClick={() => setSettings(true)}
            aria-haspopup="dialog"
            aria-label="Settings: route public, NEAR Intents only"
            className="inline-flex h-9 items-center gap-2 rounded-full border border-slate-200 bg-white pr-2.5 pl-3.5 text-sm text-slate-700 shadow-[0_1px_2px_rgba(24,24,27,0.04)] transition-colors hover:border-slate-300 hover:text-slate-900"
          >
            <span className="text-slate-500">Route</span>
            <span className="font-medium text-slate-900">Public</span>
            <GearSix size={16} weight="bold" className="text-slate-500" aria-hidden />
          </button>
          <Sheet anchored open={settings} onClose={() => setSettings(false)} title="Swap settings">
            {optOut ? <RouteChoice optOut={optOut} /> : null}
            <Section title="Details" last>
              <dl className="space-y-3 px-5 text-sm">
                <Fact label="Typical time" value={q.hop ? aboutTime(q.hop.time_s).replace(/^a/, "A") : "–"} />
                <Fact label="If it fails" value={`NEAR Intents refunds your ${inName} to the refund address you give.`} />
                <Fact label="Privacy" value={path.privacy} />
              </dl>
            </Section>
          </Sheet>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (path.runs && !problem && !blocked && q.hop) setConfirm(true);
        }}
      >
        <div className="flex flex-col">
          <Panel
            label="Sell"
            onClick={() => input.current?.focus()}
            pill={<SidePill token={pick.sell} side="sell" onOpen={() => setPicker("sell")} />}
            foot={
              <span className="flex min-w-0 items-center gap-1.5 truncate">
                {from ? chainName(from.blockchain) : ""}
                <span aria-hidden>·</span>
                from your own wallet
              </span>
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
              aria-describedby="alone-message"
              className={cn("h-12 w-full min-w-0 bg-transparent leading-none font-medium tracking-tight text-slate-900 tabular-nums placeholder:text-slate-300 focus:outline-none focus-visible:outline-none", amountSize(amount))}
            />
          </Panel>
          <FlipButton onFlip={onFlip} title={`Sell ${outName} for ${inName} instead`} />
          <Panel
            label="Buy"
            pill={<SidePill token={pick.buy} side="buy" onOpen={() => setPicker("buy")} />}
            foot={
              <span className="flex min-w-0 items-center gap-1.5 truncate">
                {to ? chainName(to.blockchain) : ""}
                <span aria-hidden>·</span>
                <NearMark size={12} />
                NEAR Intents only
              </span>
            }
          >
            <output aria-live="polite" aria-label={`You get ${outName}`} className={cn("flex h-12 items-center truncate leading-none font-medium tracking-tight tabular-nums", amountSize(out && to ? nearText(out, to) : "0"), out ? "text-slate-900" : "text-slate-300")}>
              {out && to ? `≈${nearText(out, to).split(" ")[0]}` : "0"}
            </output>
          </Panel>
        </div>

        <div className="mt-3 min-h-5 space-y-0.5 px-1 text-[13px] text-slate-500">
          {rate != null && least && to ? (
            <p>
              <span className="text-slate-700 tabular-nums">
                1 {inName} ≈ {numText(rate)} {outName}
              </span>
              <span className="tabular-nums"> · at least {nearText(least, to)}</span>
            </p>
          ) : q.loading ? (
            <p>Finding the best price…</p>
          ) : null}
          <PathLine path={path} time={q.hop ? aboutTime(q.hop.time_s) : undefined} />
        </div>

        {path.runs ? null : (
          <p className="mt-3 flex items-start gap-2 rounded-2xl bg-slate-50 px-4 py-3 text-[13px] text-slate-600" data-near-off>
            <Info size={16} className="mt-px shrink-0 text-slate-500" aria-hidden />
            <span>{path.reason}</span>
          </p>
        )}

        <button
          type="submit"
          disabled={!path.runs || !q.hop || !!problem || !!blocked}
          className="mt-3 flex h-14 w-full items-center justify-center rounded-2xl bg-slate-900 text-base font-semibold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
        >
          {path.runs ? path.button : "Swap on your own node"}
        </button>
        <p id="alone-message" role={message ? "alert" : undefined} className={cn("mt-3 text-center text-sm", !message ? "sr-only" : message === blocked ? "text-slate-600" : "text-rose-600")}>
          {message ?? ""}
        </p>
      </form>

      <PrivacyLine text={path.privacy} />

      <CoinPicker open={picker !== null} onClose={() => setPicker(null)} side={picker ?? "sell"} pick={pick} ctx={ctx} onPick={(t) => onPick(picker ?? "sell", t)} />
      {confirm && from && to && units && q.hop ? <AloneConfirm onClose={() => setConfirm(false)} from={from} to={to} units={units} time={q.hop.time_s} /> : null}
    </>
  );
}

// Where the coin goes and where a refund goes, each checked by NEAR Intents as it's typed, then the
// amounts and what this swap is, on one sheet.
function AloneConfirm({ onClose, from, to, units, time }: { onClose: () => void; from: NearToken; to: NearToken; units: string; time: number }) {
  const near = useNear();
  // the addresses last used on these chains, offered again
  const [address, setAddress] = useState(() => storedReceive(nearKey(to.blockchain)) ?? "");
  const [refund, setRefund] = useState(() => storedReceive(nearKey(from.blockchain)) ?? "");
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const dest = address.trim();
  const ref = refund.trim();
  const destChecked = useDirect(from.assetId, to.assetId, dest.length >= 8 ? units : null, dest.length >= 8 ? dest : null);
  const refChecked = useDirect(from.assetId, to.assetId, ref.length >= 8 ? units : null, null, ref.length >= 8 ? ref : null);
  useEffect(() => setFail(null), [dest, ref]);
  const ok = (c: HopQuoted) => c.hop?.address === "ok" && !c.error;
  const minOut = destChecked.hop ? shade(destChecked.hop.min_amount_out, ROOM_BPS) : null;

  const state = (value: string, c: HopQuoted, t: NearToken, purpose: "dest" | "refund") =>
    value.length === 0
      ? { tone: "idle", text: purpose === "dest" ? `NEAR Intents sends the ${t.symbol} here, on ${chainName(t.blockchain)}.` : `If NEAR Intents can't complete, it sends your ${t.symbol} back here.` }
      : value.length < 8
        ? { tone: "bad", text: "That's too short for an address." }
        : c.loading
          ? { tone: "checking", text: "Checking with NEAR Intents…" }
          : c.error
            ? { tone: "bad", text: c.error }
            : ok(c)
              ? { tone: "ok", text: `NEAR Intents accepts this ${chainName(t.blockchain)} address.` }
              : { tone: "checking", text: "Checking with NEAR Intents…" };

  const start = async () => {
    if (!ok(destChecked) || !ok(refChecked) || !minOut || busy) return;
    setBusy(true);
    setFail(null);
    try {
      const job = await startCombo({ kind: "near-only", asset_in: from.assetId, amount_in: units, refund_address: ref, asset_out: to.assetId, address: dest, min_asset_out: minOut });
      storeReceive(nearKey(to.blockchain), dest);
      storeReceive(nearKey(from.blockchain), ref);
      near.putCombo(job);
      onClose();
      navigate(`/app/combo/${job.id}`);
    } catch (e) {
      const err = e as NearError;
      if (err.code === "price_moved") destChecked.refresh();
      setFail(err.message);
    } finally {
      setBusy(false);
    }
  };

  const field = (label: string, value: string, set: (v: string) => void, s: { tone: string; text: string }, id: string, autofocus: boolean) => (
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
          aria-invalid={s.tone === "bad"}
          aria-describedby={id}
          placeholder="Paste an address"
          className={cn(
            "mt-1.5 h-12 w-full rounded-2xl border bg-slate-50 px-3.5 font-mono text-[13px] text-slate-900 placeholder:font-sans placeholder:text-slate-400 focus:bg-white focus:outline-none",
            s.tone === "bad" ? "border-rose-300" : s.tone === "ok" ? "border-emerald-300" : "border-slate-200 focus:border-slate-300",
          )}
        />
      </label>
      <p id={id} role={s.tone === "bad" ? "alert" : undefined} className={cn("mt-1.5 flex items-center gap-1.5 text-[13px]", s.tone === "bad" ? "text-rose-600" : s.tone === "ok" ? "text-emerald-700" : "text-slate-500")}>
        {s.tone === "ok" ? <Check size={14} weight="bold" aria-hidden /> : s.tone === "checking" ? <CircleNotch size={14} weight="bold" className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
        {s.text}
      </p>
    </div>
  );

  return (
    <Sheet open onClose={onClose} title={`Where should the ${to.symbol} go?`}>
      <div className="px-5 pb-5">
        {field(`Receive to: your ${to.symbol} address on ${chainName(to.blockchain)}`, address, setAddress, state(dest, destChecked, to, "dest"), "alone-dest-note", true)}
        {field(`Your ${from.symbol} address on ${chainName(from.blockchain)}, for a refund`, refund, setRefund, state(ref, refChecked, from, "refund"), "alone-refund-note", false)}

        <dl className="mt-5 space-y-2.5 rounded-2xl bg-slate-50 px-4 py-3.5 text-sm tabular-nums">
          <Line label="You send" value={nearText(units, from)} strong />
          <Line label="You get at least" value={minOut ? nearText(minOut, to) : "–"} strong />
          <Line label="Through" value="NEAR Intents only" />
          <Line label="Takes" value={aboutTime(time)} />
        </dl>

        <ul className="mt-5 space-y-4 text-[15px]">
          <Point icon={<Eye size={18} />} title="This swap is public">
            Anyone can link the {from.symbol} you send to the {to.symbol} you get: no shielded ZEC is in between. Switch back to the private route in the settings for a swap that leaves no link.
          </Point>
          <Point icon={<NearMark size={18} />} title="You trust NEAR Intents for all of it">
            You send your {from.symbol} to its deposit address from your own wallet, and it sends the {to.symbol} to yours. No Ferry swap is in it.
          </Point>
          <Point icon={<HandCoins size={18} />} title="If something stops">
            NEAR Intents refunds your {from.symbol} to the refund address above.
          </Point>
        </ul>

        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            onClick={start}
            disabled={!ok(destChecked) || !ok(refChecked) || busy}
            className="flex h-12 w-full items-center justify-center rounded-2xl bg-slate-900 text-[15px] font-semibold text-white transition-colors hover:bg-slate-800 disabled:bg-slate-100 disabled:text-slate-400"
          >
            {busy ? "Starting…" : "Get deposit address"}
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
