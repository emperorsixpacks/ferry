import { useRef, useState } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import { chainName, useNear } from "../lib/near";
import { ZEC, isNear, isPair, type CardProps, type Side, type Token } from "../lib/paths";
import { cn } from "../lib/utils";
import { NearMark } from "./Logos";
import { FlipButton, Panel, PathLine, PrivacyLine, SidePill, amountSize } from "./SwapParts";
import { CoinPicker, tokenSubtitle } from "./TokenPicker";

// The swap card for two coins this server can't swap (yet), or before it said what it swaps. It looks
// like any other card, both coins on their pills and the arrow between them, so people can change
// either side; the path line says how it would go, and one plain sentence says why it can't here.

export function OffCard(props: (CardProps & { loading?: false }) | { loading: true }) {
  const [picker, setPicker] = useState<Side | null>(null);
  const [amount, setAmount] = useState("");
  const input = useRef<HTMLInputElement>(null);
  if (props.loading)
    return (
      <>
        <h1 className="mb-3 text-xl font-semibold tracking-tight text-slate-900">Swap</h1>
        <div className="flex flex-col items-center rounded-3xl border border-slate-200/70 bg-slate-50 px-6 py-16 text-center">
          <CircleNotch size={24} weight="bold" className="animate-spin text-slate-400 motion-reduce:animate-none" aria-hidden />
          <p className="mt-3 text-sm text-slate-600">Finding what this server swaps…</p>
        </div>
      </>
    );
  const { pick, path, ctx, onPick, onFlip } = props;
  const waiting = path.available === null;
  const reason = waiting ? null : path.reason;
  return (
    <>
      <div className="mb-3 flex h-9 items-center">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Swap</h1>
      </div>
      <form onSubmit={(e) => e.preventDefault()} data-off-card>
        <div className="flex flex-col">
          <Panel label="Sell" onClick={() => input.current?.focus()} pill={<SidePill token={pick.sell} side="sell" onOpen={() => setPicker("sell")} />} foot={<Foot token={pick.sell} zec="Your shielded ZEC" />}>
            <input
              ref={input}
              inputMode="decimal"
              autoComplete="off"
              aria-label="Amount to sell"
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(",", "."))}
              aria-describedby="off-message"
              className={cn("h-12 w-full min-w-0 bg-transparent leading-none font-medium tracking-tight text-slate-900 tabular-nums placeholder:text-slate-300 dark:placeholder:text-slate-400 focus:outline-none focus-visible:outline-none", amountSize(amount || "0"))}
            />
          </Panel>
          <FlipButton onFlip={onFlip} title="Swap the two sides" />
          <Panel label="Buy" pill={<SidePill token={pick.buy} side="buy" onOpen={() => setPicker("buy")} />} foot={<Foot token={pick.buy} zec="Arrives shielded" />}>
            <output aria-live="polite" className={cn("flex h-12 items-center truncate leading-none font-medium tracking-tight text-slate-300 tabular-nums dark:text-slate-400", amountSize("0"))}>
              0
            </output>
          </Panel>
        </div>

        <div className="mt-3 min-h-5 space-y-0.5 px-1 text-[13px] text-slate-500">{waiting ? <p>Finding the best route…</p> : path.steps.length ? <PathLine path={path} /> : null}</div>

        <button type="submit" disabled className="mt-3 flex h-14 w-full cursor-not-allowed items-center justify-center rounded-2xl bg-slate-100 text-base font-semibold text-slate-400">
          {path.button}
        </button>
        <p id="off-message" role={reason ? "status" : undefined} className={cn("mt-3 text-center text-sm text-balance", reason ? "text-slate-600" : "sr-only")} data-off-reason>
          {reason ?? ""}
        </p>
      </form>

      {path.privacy ? <PrivacyLine text={path.privacy} /> : null}

      <CoinPicker open={picker !== null} onClose={() => setPicker(null)} side={picker ?? "sell"} pick={pick} ctx={ctx} onPick={(t) => onPick(picker ?? "sell", t)} />
    </>
  );
}

// what a coin is, under its panel: "Your shielded ZEC", "USD Coin · Base", "Solana · via NEAR Intents"
function Foot({ token, zec }: { token: Token; zec: string }) {
  const near = useNear();
  const t = isNear(token) ? near.byId[token.slice(5)] : null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 truncate">
      {token === ZEC ? (
        zec
      ) : t ? (
        <>
          {chainName(t.blockchain)}
          <span aria-hidden>·</span>
          <NearMark size={12} />
          via NEAR Intents
        </>
      ) : isPair(token) ? (
        tokenSubtitle(token)
      ) : (
        " "
      )}
    </span>
  );
}
