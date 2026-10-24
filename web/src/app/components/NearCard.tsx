import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, CircleNotch, Eye, GearSix, HandCoins, Info, ShieldCheck } from "@phosphor-icons/react";
import { NearError, startNear, type Direction, type NearQuote, type NearToken } from "@/api";
import { zec } from "@/format";
import { navigate } from "@/router";
import { useLocal } from "../lib/daemon";
import { useMakers } from "../lib/makers";
import { chainName, nearAmount, nearText, numText, quoteTime, shade, useNear, useNearQuote, whole } from "../lib/near";
import { pairName } from "../lib/pairs";
import { nearToken, type CardProps, type Side } from "../lib/paths";
import { nearKey, receiveFor, shortAddress, storeReceive, storedReceive, useReceive } from "../lib/receive";
import { cn } from "../lib/utils";
import { NearMark } from "./Logos";
import { ReceiveNext, ReceiveTo } from "./ReceiveTo";
import { Fact, FlipButton, Panel, PathLine, PrivacyLine, Section, SidePill, amountSize } from "./SwapParts";
import { CoinPicker } from "./TokenPicker";
import { Sheet } from "./ui/sheet";

// The swap card with a NEAR Intents asset on the coin side. Selling: shielded ZEC on top, the asset
// below; Ferry swaps the ZEC for a coin it supports (the best route here, often USDC on Base) and
// pays it straight into a NEAR Intents deposit address, and NEAR Intents sends the asset on to an
// address the person gives. Buying (flipped): the asset on top; the person sends it to a NEAR
// Intents deposit address, NEAR Intents delivers the coin to their own Ferry node, and Ferry buys
// the ZEC with it. The amount is always the ZEC. The ZEC side stays shielded and trustless; the
// NEAR side is public and trusted, and the card says so in a line, the confirmation in three.

// what the ZEC lock's network fee needs on top of the amount (ferry-zec's SEND_FEE_RESERVE)
const ZEC_FEE_RESERVE = 50_000;
// the room between the quote shown and what the person agrees to: the real quote comes a moment later
const ROOM_BPS = 50;

export function NearCard({ asset, pick, path, ctx, onPick, onFlip, blocked }: CardProps & { asset: string }) {
  const d = useLocal();
  const near = useNear();
  const makers = useMakers();
  const token = near.byId[asset] ?? null;
  const dir: Direction = path.dir ?? d.dir;
  const selling = dir === "sell";
  const [amount, setAmount] = useState("1.00");
  const [picker, setPicker] = useState<Side | null>(null);
  const [settings, setSettings] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const zat = Math.round(Number(amount) * 1e8);
  const valid = amount.trim() !== "" && Number.isFinite(zat) && zat > 0;
  const q = useNearQuote(dir, valid ? zat : 0, token ? asset : null);
  const quote = q.quote;
  const runs = near.runs(dir);
  // the ZEC in the Ferry node on screen: what you sell from, or what you hold
  const zecBal = d.status ? d.status.balances.zec_shielded_zat : null;
  // buying: where the ZEC goes, your Ferry node or your own shielded wallet (the Ferry buy's
  // sweep_to, on your own node), as the node for the coin between says it can
  const buyNode = d.pairs.find((p) => p.id === quote?.via)?.buy.status ?? d.pairs.find((p) => p.buy.status?.features?.includes("route"))?.buy.status ?? null;
  const receive = !selling && runs ? receiveFor("zec", buyNode, d.info.own) : null;
  const receiveTo = useReceive(receive?.key ?? null);

  const problem = (() => {
    if (amount.trim() === "") return selling ? "Enter how much ZEC to sell." : "Enter how much ZEC you want.";
    if (!valid) return "Enter an amount, like 1.00.";
    if (selling && zecBal != null) {
      if (zat > zecBal) return `You only have ${zec(zecBal)} ZEC.`;
      if (zat > zecBal - ZEC_FEE_RESERVE) return "Leave 0.0005 ZEC for the network fee, or use Max.";
    }
    if (q.error) return q.error;
    return null;
  })();

  const setMax = () => {
    if (zecBal == null) return;
    const most = Math.max(0, zecBal - ZEC_FEE_RESERVE);
    const [whole_, frac = ""] = (most / 1e8).toFixed(8).replace(/0+$/, "").split(".");
    setAmount(`${whole_}.${frac.padEnd(2, "0")}`);
    input.current?.focus();
  };

  if (!token)
    return (
      <div className="rounded-3xl border border-slate-200 px-6 py-14 text-center">
        {near.info === undefined ? <CircleNotch size={24} weight="bold" className="mx-auto animate-spin text-slate-400 motion-reduce:animate-none" aria-hidden /> : null}
        <p className="mt-3 text-slate-600">{near.info === undefined ? "Loading NEAR Intents' tokens…" : "NEAR Intents doesn't list this token right now."}</p>
      </div>
    );

  const sym = token.symbol;
  const via = quote ? pairName(quote.via) : null;
  const out = quote ? (selling ? quote.near.amount_out : quote.near.amount_in) : null;
  const outText = out ? nearAmount(out, token.decimals) : "0";
  const perZec = quote && valid ? whole(selling ? quote.near.amount_out : quote.near.amount_in, token.decimals) / (zat / 1e8) : null;
  const message = problem ?? blocked;

  const zecPanel = (
    <Panel
      key="zec"
      label={selling ? "Sell" : "Buy"}
      onClick={() => input.current?.focus()}
      pill={<SidePill token="zec" side={selling ? "sell" : "buy"} onOpen={() => setPicker(selling ? "sell" : "buy")} />}
      foot={
        selling ? (
          <>
            <span className="truncate tabular-nums">{zecBal == null ? "You have –" : `You have ${zec(zecBal)} ZEC`}</span>
            <button type="button" onClick={setMax} disabled={zecBal == null} className="rounded-full px-2 py-0.5 text-xs font-semibold text-slate-900 transition-colors hover:bg-slate-200/70 disabled:text-slate-400">
              Max
            </button>
          </>
        ) : (
          <>
            <span className="truncate">Arrives shielded</span>
            <span className="shrink-0 tabular-nums">{zecBal == null ? "You have –" : `You have ${zec(zecBal)} ZEC`}</span>
          </>
        )
      }
    >
      <input
        ref={input}
        inputMode="decimal"
        autoComplete="off"
        aria-label={selling ? "ZEC to sell" : "ZEC to buy"}
        placeholder="0"
        value={amount}
        onChange={(e) => setAmount(e.target.value.replace(",", "."))}
        aria-invalid={!!problem && valid}
        aria-describedby="near-message"
        className={cn("h-12 w-full min-w-0 bg-transparent leading-none font-medium tracking-tight text-slate-900 tabular-nums placeholder:text-slate-300 dark:placeholder:text-slate-400 focus:outline-none focus-visible:outline-none", amountSize(amount))}
      />
    </Panel>
  );
  const tokenPanel = (
    <Panel
      key="token"
      label={selling ? "Buy" : "Sell"}
      pill={<SidePill token={nearToken(asset)} side={selling ? "buy" : "sell"} onOpen={() => setPicker(selling ? "buy" : "sell")} name={`${sym} on ${chainName(token.blockchain)}, via NEAR Intents`} />}
      foot={
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          {chainName(token.blockchain)}
          <span aria-hidden>·</span>
          <NearMark size={12} />
          via NEAR Intents
        </span>
      }
    >
      <output aria-live="polite" aria-label={selling ? `You get ${sym}` : `You pay ${sym}`} className={cn("flex h-12 items-center truncate leading-none font-medium tracking-tight tabular-nums", amountSize(outText), out ? "text-slate-900" : "text-slate-300 dark:text-slate-400")}>
        {out ? (quote?.near.approximate ? `≈${outText}` : outText) : "0"}
      </output>
    </Panel>
  );
  const flip = <FlipButton key="flip" onFlip={onFlip} title={selling ? `Buy ZEC with ${sym} instead` : `Sell ZEC for ${sym} instead`} />;

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Swap</h1>
        <div className="relative">
          <button
            type="button"
            onClick={() => setSettings(true)}
            aria-haspopup="dialog"
            aria-label={`Settings: the route through ${via?.ticker ?? "a coin Ferry swaps"} and NEAR Intents`}
            className="inline-flex h-9 items-center gap-2 rounded-full border border-slate-200 bg-white pr-2.5 pl-3.5 text-sm text-slate-700 shadow-[0_1px_2px_rgba(24,24,27,0.04)] transition-colors hover:border-slate-300 hover:text-slate-900"
          >
            <span className="text-slate-500">via</span>
            <span className="max-w-[9rem] truncate font-medium text-slate-900">{via ? via.ticker : "…"}</span>
            <GearSix size={16} weight="bold" className="text-slate-500" aria-hidden />
          </button>
          <Sheet anchored open={settings} onClose={() => setSettings(false)} title="Route">
            <Section title="Two parts" note="Ferry's part is a private atomic swap. NEAR Intents' part is public, and you trust it for that part.">
              <dl className="space-y-3 px-5 pb-1 text-sm">
                {selling ? (
                  <>
                    <Fact label="Ferry" value={quote && via ? `Swaps your shielded ZEC for ${via.noun} with ${quote.maker}, paid straight into NEAR Intents' deposit address` : "–"} />
                    <Fact label="NEAR Intents" value={via ? `Swaps the ${via.ticker} for ${sym} and sends it to your address on ${chainName(token.blockchain)}` : "–"} />
                  </>
                ) : (
                  <>
                    <Fact label="NEAR Intents" value={via ? `Swaps your ${sym} for ${via.noun} and sends it to your Ferry node` : "–"} />
                    <Fact label="Ferry" value={quote && via ? `Buys shielded ZEC with the ${via.ticker} from ${quote.maker}` : "–"} />
                  </>
                )}
              </dl>
            </Section>
            <Section title="Details" last>
              <dl className="space-y-3 px-5 text-sm">
                {quote ? (
                  selling ? (
                    <Fact label="You get" value={`About ${nearText(quote.near.amount_out, token)}, and at least ${nearText(shade(quote.near.min_amount_out, ROOM_BPS), token)}`} />
                  ) : (
                    <Fact label="You send" value={`About ${nearText(quote.near.amount_in, token)}`} />
                  )
                ) : null}
                <Fact label="Typical time" value={quote ? capital(quoteTime(quote)) : "–"} />
                <Fact label="If it fails" value={selling ? `If the Ferry swap stops, your ZEC comes back. If NEAR Intents can't fill it, it refunds the ${via?.ticker ?? "coin"} to your Ferry node.` : `If NEAR Intents can't fill it, it refunds your ${sym}. If the Ferry swap stops, the ${via?.ticker ?? "coin"} stays in your Ferry node.`} />
                <Fact label="Privacy" value={`Your ZEC stays shielded, and Ferry never sends ZEC to NEAR Intents. The ${via?.ticker ?? "coin"} and the ${sym} move on public chains.`} />
              </dl>
            </Section>
          </Sheet>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (runs && !problem && !blocked && quote) setConfirm(true);
        }}
      >
        <div className="flex flex-col">{selling ? [zecPanel, flip, tokenPanel] : [tokenPanel, flip, zecPanel]}</div>
        {selling ? runs && d.info.own ? <ReceiveNext symbol={sym} /> : null : <ReceiveTo coin={receive} />}

        <div className="mt-3 min-h-5 space-y-0.5 px-1 text-[13px] text-slate-500">
          {quote && via ? (
            <p className="flex flex-wrap items-center gap-x-1.5">
              <span className="text-slate-700 tabular-nums">
                1 ZEC ≈ {perZec != null ? numText(perZec, token.decimals) : "–"} {sym}
              </span>
              {selling ? <span className="tabular-nums">· at least {nearText(shade(quote.near.min_amount_out, ROOM_BPS), token)}</span> : null}
            </p>
          ) : q.loading ? (
            <p>Finding the best route…</p>
          ) : null}
          <PathLine path={path} via={quote ? [quote.via] : []} time={quote ? quoteTime(quote) : undefined} />
        </div>

        {runs ? null : (
          <p className="mt-3 flex items-start gap-2 rounded-2xl bg-slate-50 px-4 py-3 text-[13px] text-slate-600" data-near-off>
            <Info size={16} className="mt-px shrink-0 text-slate-500" aria-hidden />
            <span>
              {near.info?.reason === "mainnet"
                ? "Quote only: NEAR Intents runs on mainnet, and this Ferry node is on a test network."
                : "Quote only. NEAR Intents runs on mainnet and pays out to an address you choose, so it runs on your own Ferry node, not on this demo."}
            </span>
          </p>
        )}

        <button
          type="submit"
          disabled={!runs || !quote || !!problem || !!blocked}
          className="mt-3 flex h-14 w-full items-center justify-center rounded-2xl bg-slate-900 text-base font-semibold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
        >
          {!runs ? "Swap on your own node" : path.button}
        </button>
        <p id="near-message" role={message ? "alert" : undefined} className={cn("mt-3 text-center text-sm", !message ? "sr-only" : message === blocked ? "text-slate-600" : "text-rose-600")}>
          {message ?? ""}
        </p>
      </form>

      <PrivacyLine text={path.privacy} />

      <CoinPicker open={picker !== null} onClose={() => setPicker(null)} side={picker ?? "sell"} pick={pick} ctx={ctx} makers={makers} zat={valid ? zat : 1e8} onPick={(t) => onPick(picker ?? "sell", t)} />
      {quote && confirm ? <NearConfirm open onClose={() => setConfirm(false)} token={token} dir={dir} zat={zat} first={quote} sweepTo={receiveTo} /> : null}
    </>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// The destination step and the confirmation, on one sheet: the address (where the asset goes when
// selling; where a refund goes when buying), checked by NEAR Intents as it's typed, then the
// amounts and the three things that are different about a NEAR swap.
function NearConfirm({ open, onClose, token, dir, zat, first, sweepTo }: { open: boolean; onClose: () => void; token: NearToken; dir: Direction; zat: number; first: NearQuote; sweepTo: string | null }) {
  const near = useNear();
  const selling = dir === "sell";
  const sym = token.symbol;
  const chain = chainName(token.blockchain);
  // the address last used on this chain, offered again
  const [address, setAddress] = useState(() => storedReceive(nearKey(token.blockchain)) ?? "");
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const typed = address.trim();
  const checked = useNearQuote(dir, zat, token.assetId, typed.length >= 8 ? typed : null);
  // the quote for this address once NEAR Intents accepted it, else the card's
  const quote = checked.quote && checked.quote.address === "ok" ? checked.quote : null;
  const q = quote ?? first;
  const via = pairName(q.via);
  const minOut = shade(q.near.min_amount_out, ROOM_BPS);
  const maxIn = shade(q.near.max_amount_in ?? q.near.amount_in, ROOM_BPS, true);
  useEffect(() => setFail(null), [typed]);

  const state: { tone: "idle" | "checking" | "ok" | "bad"; text: string } =
    typed.length === 0
      ? { tone: "idle", text: selling ? `NEAR Intents sends the ${sym} here, on ${chain}.` : `If NEAR Intents can't complete, it sends your ${sym} back here.` }
      : typed.length < 8
        ? { tone: "bad", text: "That's too short for an address." }
        : checked.loading
          ? { tone: "checking", text: "Checking with NEAR Intents…" }
          : checked.field || (checked.error && !quote)
            ? { tone: "bad", text: checked.error ?? "NEAR Intents doesn't take that address." }
            : quote
              ? { tone: "ok", text: `NEAR Intents accepts this ${chain} address.` }
              : { tone: "checking", text: "Checking with NEAR Intents…" };

  const start = async () => {
    if (!quote || busy) return;
    setBusy(true);
    setFail(null);
    try {
      const job = await startNear({ direction: dir, zec_zat: zat, asset: token.assetId, address: typed, via: quote.via, ...(selling ? { min_out: minOut } : { max_in: maxIn, ...(sweepTo ? { sweep_to: sweepTo } : {}) }) });
      storeReceive(nearKey(token.blockchain), typed);
      near.put(job);
      onClose();
      navigate(`/app/near/${job.id}`);
    } catch (e) {
      const err = e as NearError;
      if (err.code === "price_moved") checked.refresh();
      setFail(err.message.replace(/\bdaemon\b/gi, "Ferry node").replace(/\bmaker\b/gi, "partner"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title={selling ? `Where should the ${sym} go?` : `Where should a refund go?`}>
      <div className="px-5 pb-5">
        <label className="block">
          <span className="text-[13px] font-medium text-slate-700">{selling ? `Receive to: your ${sym} address on ${chain}` : `Your ${sym} address on ${chain}, for a refund`}</span>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            data-autofocus
            aria-invalid={state.tone === "bad"}
            aria-describedby="near-address-note"
            placeholder={token.blockchain === "sol" ? "e.g. 7dKb…Qk5i" : token.blockchain === "near" ? "e.g. alice.near" : "Paste an address"}
            className={cn(
              "mt-1.5 h-12 w-full rounded-2xl border bg-slate-50 px-3.5 font-mono text-[13px] text-slate-900 placeholder:font-sans placeholder:text-slate-400 focus:bg-white focus:outline-none",
              state.tone === "bad" ? "border-rose-300" : state.tone === "ok" ? "border-emerald-300" : "border-slate-200 focus:border-slate-300",
            )}
          />
        </label>
        <p id="near-address-note" role={state.tone === "bad" ? "alert" : undefined} className={cn("mt-1.5 flex items-center gap-1.5 text-[13px]", state.tone === "bad" ? "text-rose-600" : state.tone === "ok" ? "text-emerald-700" : "text-slate-500")}>
          {state.tone === "ok" ? <Check size={14} weight="bold" aria-hidden /> : state.tone === "checking" ? <CircleNotch size={14} weight="bold" className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
          {state.text}
        </p>

        <dl className="mt-5 space-y-2.5 rounded-2xl bg-slate-50 px-4 py-3.5 text-sm tabular-nums">
          {selling ? (
            <>
              <Line label="You sell" value={`${(zat / 1e8).toFixed(4).replace(/0{1,2}$/, "")} ZEC, shielded`} />
              <Line label="You get at least" value={nearText(minOut, token)} strong />
              <Line label="About" value={nearText(q.near.amount_out, token)} />
            </>
          ) : (
            <>
              <Line label="You send at most" value={nearText(maxIn, token)} strong />
              <Line label="You get" value={`${(zat / 1e8).toFixed(4).replace(/0{1,2}$/, "")} ZEC, shielded`} />
              <Line label="Receive to" value={sweepTo ? `Your wallet ${shortAddress(sweepTo)}` : "Your Ferry node"} />
            </>
          )}
          <Line label="Through" value={`${via.noun}, then ${selling ? "NEAR Intents" : "Ferry"}`} />
          <Line label="Takes" value={quoteTime(q)} />
        </dl>

        <ul className="mt-5 space-y-4 text-[15px]">
          {selling ? (
            <>
              <Point icon={<ShieldCheck size={18} />} title="Your ZEC stays shielded">
                Ferry sells it for {via.ticker} in an atomic swap. It never leaves the shielded pool, and Ferry never sends ZEC to NEAR Intents.
              </Point>
              <Point icon={<Eye size={18} />} title="The NEAR Intents part is public">
                The {via.ticker}, the {sym} and both addresses are on public chains, and you trust NEAR Intents to deliver the {sym}.
              </Point>
              <Point icon={<HandCoins size={18} />} title="If something stops">
                If the Ferry swap stops, your ZEC comes back. If NEAR Intents can't fill it at this price, it refunds the {via.ticker} to your Ferry node.
              </Point>
            </>
          ) : (
            <>
              <Point icon={<Eye size={18} />} title="You send first, to NEAR Intents">
                Its deposit address is on {chain}, in public. You trust NEAR Intents with your {sym} until it delivers {via.ticker} to your Ferry node.
              </Point>
              <Point icon={<ShieldCheck size={18} />} title="Your ZEC arrives shielded">
                Then Ferry buys the ZEC with that {via.ticker} in an atomic swap, straight into your shielded wallet.
              </Point>
              <Point icon={<HandCoins size={18} />} title="If something stops">
                NEAR Intents refunds your {sym} to the address above. If the Ferry swap stops, the {via.ticker} stays in your Ferry node.
              </Point>
            </>
          )}
        </ul>

        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            onClick={start}
            disabled={!quote || busy}
            className="flex h-12 w-full items-center justify-center rounded-2xl bg-slate-900 text-[15px] font-semibold text-white transition-colors hover:bg-slate-800 disabled:bg-slate-100 disabled:text-slate-400"
          >
            {busy ? "Starting…" : selling ? "Start swap" : "Get deposit address"}
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

export function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className={cn("min-w-0 truncate text-right", strong ? "font-semibold text-slate-900" : "text-slate-900")}>{value}</dd>
    </div>
  );
}

export function Point({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
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
