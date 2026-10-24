import { useEffect, useState } from "react";
import { CaretDown, Check, Wallet } from "@phosphor-icons/react";
import { addressProblem, cleanAddress, shortAddress, storeReceive, useReceive, type ReceiveCoin } from "../lib/receive";
import { cn } from "../lib/utils";
import { Sheet } from "./ui/sheet";

// "Receive to" under the Buy panel, on the person's own node: their Ferry node (the default), or
// their own wallet for this coin, pasted once and remembered on this device. One quiet line on the
// card; the choice opens in a sheet. `coin` null: what's bought can't be sent elsewhere here (a public
// demo, or a node too old to pay another address), and the row isn't shown.
export function ReceiveTo({ coin }: { coin: ReceiveCoin | null }) {
  const address = useReceive(coin?.key ?? null);
  const [open, setOpen] = useState(false);
  if (!coin) return null;
  return (
    <div className="mt-2 flex items-center justify-between gap-3 px-1 text-[13px]" data-receive-to>
      <span className="shrink-0 text-slate-500">Receive to</span>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={`Receive to: ${address ? `your wallet, ${address}` : "your Ferry node"}. Change`}
        className="-mr-2 inline-flex min-w-0 items-center gap-1.5 rounded-full px-2 py-1 font-medium text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900"
      >
        {address ? (
          <>
            <Wallet size={14} weight="bold" className="shrink-0 text-slate-500" aria-hidden />
            <span className="truncate font-mono text-xs" data-receive-address>
              {shortAddress(address)}
            </span>
          </>
        ) : (
          <span className="truncate">Your Ferry node</span>
        )}
        <CaretDown size={12} weight="bold" className="shrink-0 text-slate-500" aria-hidden />
      </button>
      {open ? <ReceiveSheet coin={coin} current={address} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

// NEAR Intents pays the last asset straight to the person: the same line, saying the address comes next.
export function ReceiveNext({ symbol }: { symbol: string }) {
  return (
    <div className="mt-2 flex items-center justify-between gap-3 px-1 text-[13px]" data-receive-to>
      <span className="shrink-0 text-slate-500">Receive to</span>
      <span className="truncate text-slate-700">Your {symbol} wallet · next step</span>
    </div>
  );
}

function ReceiveSheet({ coin, current, onClose }: { coin: ReceiveCoin; current: string | null; onClose: () => void }) {
  const [own, setOwn] = useState(!!current);
  const [text, setText] = useState(current ?? "");
  const [touched, setTouched] = useState(!!current);
  const typed = text.trim();
  const problem = own ? addressProblem(coin, typed) : null;
  useEffect(() => {
    if (!typed) setTouched(false);
  }, [typed]);
  const shown = own && touched && typed ? problem : null;

  const save = () => {
    if (own && problem) return setTouched(true);
    storeReceive(coin.key, own ? cleanAddress(coin, typed) : null);
    onClose();
  };
  const placeholder = coin.kind === "zec" ? "Your unified address (u…)" : coin.kind === "evm" ? "0x…" : `Your ${coin.ticker} address`;
  const options = [
    { on: false, label: "Your Ferry node", note: `The ${coin.ticker} stays in your node. Send it on from Wallet whenever you like.` },
    { on: true, label: "Your own wallet", note: coin.kind === "zec" ? "A shielded address from your Zcash wallet, like Zashi." : `An address of yours on ${coin.networkName}.` },
  ];

  return (
    <Sheet open onClose={onClose} title={`Where should the ${coin.ticker} go?`}>
      <div className="px-2 pb-5">
        <div role="radiogroup" aria-label="Receive to" className="space-y-1">
          {options.map((o) => (
            <button
              key={o.label}
              type="button"
              role="radio"
              aria-checked={own === o.on}
              data-autofocus={own === o.on || undefined}
              onClick={() => setOwn(o.on)}
              className={cn("flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors", own === o.on ? "bg-slate-100" : "hover:bg-slate-50")}
            >
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-slate-900">{o.label}</span>
                <span className="mt-0.5 block text-[13px] text-slate-500">{o.note}</span>
              </span>
              {own === o.on ? <Check size={16} weight="bold" className="shrink-0 text-slate-900" aria-hidden /> : <span className="w-4 shrink-0" aria-hidden />}
            </button>
          ))}
        </div>

        {own ? (
          <div className="mt-3 px-3">
            <label className="block">
              <span className="text-[13px] font-medium text-slate-700">Your {coin.noun} address</span>
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                onBlur={() => typed && setTouched(true)}
                onKeyDown={(e) => e.key === "Enter" && save()}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                autoFocus={!current}
                aria-invalid={!!shown}
                aria-describedby="receive-note"
                placeholder={placeholder}
                className={cn(
                  "mt-1.5 h-12 w-full rounded-2xl border bg-slate-50 px-3.5 font-mono text-[13px] text-slate-900 placeholder:font-sans placeholder:text-slate-400 focus:bg-white focus:outline-none",
                  shown ? "border-rose-300" : typed && !problem ? "border-emerald-300" : "border-slate-200 focus:border-slate-300",
                )}
              />
            </label>
            <p id="receive-note" role={shown ? "alert" : undefined} className={cn("mt-1.5 text-[13px]", shown ? "text-rose-600" : typed && !problem ? "text-emerald-700" : "text-slate-500")}>
              {shown ?? (typed && !problem ? (coin.kind === "zec" ? "A shielded address. The ZEC arrives there, still shielded." : `An address on ${coin.networkName}.`) : coin.kind === "zec" ? "Shielded only: a unified address. A transparent (t…) address won't do." : `On ${coin.networkName} only.`)}
            </p>
          </div>
        ) : null}

        <div className="mt-5 px-3">
          <button
            type="button"
            onClick={save}
            disabled={own && !!problem && touched}
            className="flex h-12 w-full items-center justify-center rounded-2xl bg-slate-900 text-[15px] font-semibold text-white transition-colors hover:bg-slate-800 disabled:bg-slate-100 disabled:text-slate-400"
          >
            Done
          </button>
          <p className="mt-3 text-center text-[13px] text-slate-500">Remembered for {coin.noun} on this device.</p>
        </div>
      </div>
    </Sheet>
  );
}
