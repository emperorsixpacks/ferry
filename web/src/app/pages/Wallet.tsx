import { Suspense, lazy, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowRight, Check, CircleNotch, Info, PaperPlaneTilt, Plus, Wallet as WalletIcon, Warning, WarningCircle } from "@phosphor-icons/react";
import { getAddresses, previewSend, sendOut, type Addresses, type SendAsset, type Withdrawal } from "@/api";
import { Link } from "@/router";
import { CopyText } from "../components/CopyText";
import { Layout, PageHeader } from "../components/Layout";
import { ChainLogo, PairLogo, TokenLogo } from "../components/Logos";
import { QrCode } from "../components/QrCode";
import { ToneBadge } from "../components/ui/badge";
import { Sheet } from "../components/ui/sheet";
import { useBrowserWallet } from "../lib/browserWallet";
import { useLocal } from "../lib/daemon";
import { addressProblem, cleanAddress, shortAddress, storedReceive } from "../lib/receive";
import { cn } from "../lib/utils";
import {
  USUAL_FEE,
  canPreview,
  canSend,
  fundFirst,
  fundOptions,
  fundingNotes,
  fundingOf,
  inputText,
  parseUnits,
  payTarget,
  receiveOf,
  sendAsset,
  sendFirst,
  sendState,
  sentAt,
  sideName,
  unitsText,
  useWallet,
  type Coin,
  type Holding,
} from "../lib/wallet";

// /wallet: the coins the person's Ferry node holds, by coin. Each shows what's free and what a swap
// holds, with "Add funds" (the node's address for it, a QR code with the payment link wallets read,
// and which network to send on) and "Send to my wallet" (an amount, an address, the network fee, one
// check, then the send's status as the node reports it). Below, what the node sent. On a public demo
// it only shows the balances: the coins there are the operator's. Opened from the account menu, the
// swap card's "Add funds" (?add=<coin>, with ?need=<base units> when the swap was short of it) and a
// finished swap's "Send it to my wallet" (?send=<coin>).
// An EVM coin's Add funds also offers "Pay with MetaMask" (or the browser's other wallet) when the
// browser has one; that flow is loaded only when it is used.
const PayFromWallet = lazy(() =>
  import("../components/PayFromWallet").then(
    (m) => ({ default: m.PayFromWallet }),
    () => ({ default: () => <p className="px-5 pb-6 text-sm text-rose-600">Couldn't open this. Reload the page and try again, or use the QR code.</p> }),
  ),
);

export function WalletPage() {
  const d = useLocal();
  const own = d.info.own;
  const funds = d.info.funds || own;
  const w = useWallet(own);
  const params = new URLSearchParams(window.location.search);
  const [adding, setAdding] = useState<string | null>(() => params.get("add"));
  const [sending, setSending] = useState<string | null>(() => params.get("send"));
  // ?need=<base units>: how much the swap card was short of the coin it opened Add funds for
  const [need, setNeed] = useState<bigint | null>(() => {
    const n = params.get("need");
    return n && /^\d{1,30}$/.test(n) ? BigInt(n) : null;
  });
  // the sheets close back to plain /wallet, so a reload doesn't reopen them
  const close = () => {
    setAdding(null);
    setSending(null);
    setNeed(null);
    if (window.location.search) window.history.replaceState(null, "", "/wallet");
  };
  const addCoin = funds ? w.coins.find((c) => c.key === adding) : undefined;
  const sendCoin = own ? w.coins.find((c) => c.key === sending) : undefined;
  const sends = useMemo(() => {
    const all: { w: Withdrawal; coin: Coin | undefined; base: string }[] = [];
    for (const [base, list] of Object.entries(w.sends.data))
      for (const x of list) {
        const node = w.nodes.find((n) => n.base === base);
        const coin = w.coins.find((c) => c.holdings.some((h) => h.node.base === base && h.asset === sendAsset(x))) ?? w.coins.find((c) => (sendAsset(x) === "zec" ? c.key === "zec" : c.key === node?.pair));
        all.push({ w: x, coin, base });
      }
    return all.sort((a, b) => (sentAt(b.w) ?? 0) - (sentAt(a.w) ?? 0));
  }, [w.sends.data, w.nodes, w.coins]);
  const sendErrors = Object.keys(w.sends.errors).length;

  return (
    <Layout>
      <div className="mx-auto w-full max-w-[640px]" data-wallet={own ? "own" : funds ? "funds" : "demo"}>
        <PageHeader eyebrow="Your Ferry node" title="Wallet" subtitle={own ? "The coins your node holds. Add funds to swap, or send them to your own wallet. Works with Zodl: scan to add funds, paste your Zodl address to receive." : funds ? "The coins this node holds. Add funds to swap." : "The coins this node holds."} />

        {!own ? (
          <div className="mt-6 flex items-start gap-3 rounded-2xl bg-slate-50 px-4 py-3.5 text-sm text-slate-600" data-demo-note>
            <Info size={18} className="mt-px shrink-0 text-slate-500" aria-hidden />
            <p>
              {funds
                ? "This is the public demo's node: you can add funds to it, but not send its coins out. On your own Ferry node you can do both. "
                : "This is the public demo's node, so you can look but not move its coins. On your own Ferry node, this is where you add funds and send coins to your own wallet. "}
              <Link to="/run-a-node" className="inline-flex items-center gap-0.5 font-medium text-slate-900 underline-offset-4 hover:underline">
                Run your own node
                <ArrowRight size={12} weight="bold" aria-hidden />
              </Link>
            </p>
          </div>
        ) : null}

        <section aria-label="Your coins" className="mt-6">
          {w.coins.length ? (
            <ul className="space-y-3">
              {w.coins.map((c) => (
                <CoinCard key={c.key} coin={c} own={own} funds={funds} onAdd={() => setAdding(c.key)} onSend={() => setSending(c.key)} />
              ))}
            </ul>
          ) : (
            <Empty known={d.known} offline={!d.connected && !d.status} />
          )}
        </section>

        {own && w.coins.length ? (
          <section aria-labelledby="sent-title" className="mt-10">
            <h2 id="sent-title" className="text-[15px] font-semibold tracking-tight text-slate-900">
              Sent from your node
            </h2>
            {sends.length ? (
              <ul className="mt-3 divide-y divide-slate-100 rounded-3xl border border-slate-200 bg-white" data-sends>
                {sends.map(({ w: x, coin }) => (
                  <SendRow key={`${x.id ?? x.txid}`} w={x} coin={coin} />
                ))}
              </ul>
            ) : sendErrors ? (
              <p className="mt-3 flex items-center gap-2 text-sm text-rose-600">
                <WarningCircle size={16} weight="fill" aria-hidden />
                Couldn't load what your node sent. It tries again by itself.
              </p>
            ) : (
              <p className="mt-3 text-sm text-slate-500" data-sends-empty>
                Nothing sent yet. Coins you send to your own wallet show up here.
              </p>
            )}
          </section>
        ) : null}
      </div>

      {addCoin ? <AddFunds coin={addCoin} need={addCoin.kind === "token" ? need : null} onClose={close} /> : null}
      {sendCoin ? <SendSheet coin={sendCoin} onClose={close} sends={w.sends.data} refresh={w.sends.refresh} /> : null}
    </Layout>
  );
}

function CoinLogo({ coin, size = 36 }: { coin: Coin; size?: number }) {
  if ("pair" in coin.logo) return <PairLogo pair={coin.logo.pair} size={size} />;
  const chain = coin.logo.eth as Parameters<typeof ChainLogo>[0]["id"] | null;
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      <TokenLogo id="eth" size={size} />
      {chain ? (
        <span className="absolute -right-1 -bottom-1 inline-flex rounded-full bg-white p-[1.5px]" aria-hidden>
          <ChainLogo id={chain} size={Math.round(size * 0.46)} />
        </span>
      ) : null}
    </span>
  );
}

function CoinCard({ coin, own, funds, onAdd, onSend }: { coin: Coin; own: boolean; funds: boolean; onAdd: () => void; onSend: () => void }) {
  const amt = (v: bigint) => unitsText(v, coin.decimals, coin.decimals > 8 ? 6 : 8);
  const sendable = coin.holdings.some((h) => canSend(h.node.status));
  const empty = coin.total === 0n;
  return (
    <li className="rounded-3xl border border-slate-200 bg-white px-5 py-4 shadow-[0_1px_2px_rgba(24,24,27,0.04)]" data-coin={coin.key}>
      <div className="flex items-center gap-3">
        <CoinLogo coin={coin} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-slate-900">{coin.label}</p>
          <p className="truncate text-[13px] text-slate-500">{coin.kind === "eth" ? `${coin.networkName} · for gas` : coin.networkName}</p>
        </div>
        <div className="min-w-0 text-right">
          <p className="truncate font-semibold text-slate-900 tabular-nums" data-balance>
            {amt(coin.total)} {coin.ticker}
          </p>
          <p className="truncate text-[13px] text-slate-500 tabular-nums" data-free>
            {coin.inSwap > 0n ? `${amt(coin.free)} free · ${amt(coin.inSwap)} in a swap` : empty ? "Empty" : "All free to use"}
          </p>
        </div>
      </div>
      {funds || own ? (
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onAdd}
            className={cn(
              "inline-flex h-10 items-center justify-center gap-1.5 rounded-full text-sm font-medium transition-colors",
              empty ? "bg-slate-900 text-white hover:bg-slate-800" : "border border-slate-200 bg-white text-slate-900 hover:bg-slate-50",
            )}
          >
            <Plus size={14} weight="bold" aria-hidden />
            Add funds
          </button>
          {own ? (
            <button
              type="button"
              onClick={onSend}
              disabled={!sendable || coin.free === 0n}
              title={!sendable ? "Your Ferry node needs an update to send coins out." : coin.free === 0n ? "Nothing free to send." : undefined}
              className="inline-flex h-10 items-center justify-center gap-1.5 rounded-full border border-slate-200 bg-white text-sm font-medium text-slate-900 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400 disabled:hover:bg-white"
            >
              <PaperPlaneTilt size={14} weight="bold" aria-hidden />
              Send to my wallet
            </button>
          ) : (
            <div />
          )}
        </div>
      ) : null}
      {own && !sendable ? <p className="mt-2 text-center text-[13px] text-slate-500">Sending out needs a newer Ferry node.</p> : null}
    </li>
  );
}

function Empty({ known, offline }: { known: boolean; offline: boolean }) {
  if (!known && !offline)
    return (
      <div className="rounded-3xl border border-slate-200 bg-white px-6 py-14 text-center">
        <CircleNotch size={24} weight="bold" className="mx-auto animate-spin text-slate-400 motion-reduce:animate-none" aria-hidden />
        <p className="mt-3 text-slate-600">Asking your Ferry node…</p>
      </div>
    );
  return (
    <div className="rounded-3xl border border-slate-200 bg-white px-6 py-12 text-center" data-wallet-empty>
      <p className="font-medium text-slate-900">{offline ? "Can't reach your Ferry node" : "No wallets here yet"}</p>
      <p className="mt-1 text-sm text-slate-500">{offline ? "Its balances show here once it's running. This page reconnects by itself." : "This server doesn't front a Ferry node with a wallet."}</p>
    </div>
  );
}

// Which side of the node, when a coin is on both: a segmented choice, as in the header's tabs.
function Sides({ coin, options, value, onChange, label }: { coin: Coin; options: Holding[]; value: string; onChange: (base: string) => void; label: string }) {
  if (options.length < 2) return null;
  return (
    <div className="px-5 pb-4">
      <p className="text-xs font-medium tracking-wider text-slate-500 uppercase">{label}</p>
      <div role="radiogroup" aria-label={label} className="mt-1.5 space-y-1">
        {options.map((h) => {
          const on = h.node.base === value;
          return (
            <button
              key={h.node.base}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(h.node.base)}
              className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors", on ? "bg-slate-100" : "hover:bg-slate-50")}
            >
              <span className={cn("min-w-0 flex-1 truncate", on ? "font-medium text-slate-900" : "text-slate-700")}>{sideName(h.node)}</span>
              <span className="shrink-0 text-[13px] text-slate-500 tabular-nums">
                {unitsText(h.free, coin.decimals, coin.decimals > 8 ? 6 : 8)} {coin.ticker}
              </span>
              {on ? <Check size={14} weight="bold" className="shrink-0 text-slate-900" aria-hidden /> : <span className="w-3.5 shrink-0" aria-hidden />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Add funds: the address, a QR code and what to send

function AddFunds({ coin, need, onClose }: { coin: Coin; need: bigint | null; onClose: () => void }) {
  // the sides that use this coin in swaps (ZEC: selling; a coin: buying; gas: every EVM side)
  const options = fundOptions(coin);
  // the side picked, else the first that uses it (as balances arrive, until one is picked)
  const [base, setBase] = useState<string | null>(null);
  const h = options.find((x) => x.node.base === base) ?? fundFirst(coin);
  const [got, setGot] = useState<Record<string, Addresses>>({});
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  const at = h.node.base;
  useEffect(() => {
    if (got[at]) return;
    let alive = true;
    setError(null);
    getAddresses(at).then(
      (a) => alive && setGot((x) => ({ ...x, [at]: a })),
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, tries]);
  const f = fundingOf(coin, h, got[at]);
  const missing = got[at] && !f;
  // an EVM coin can also be paid from the browser's wallet (MetaMask, Rabby, ...), when it has one
  const target = payTarget(coin, h, got[at]);
  const wallet = useBrowserWallet(coin.kind === "token" || coin.kind === "eth");
  const [paying, setPaying] = useState(false);
  const [payTitle, setPayTitle] = useState<string | null>(null);
  if (paying && wallet && target)
    return (
      <Sheet open onClose={onClose} title={payTitle ?? `Pay from ${wallet.name}`}>
        <Suspense
          fallback={
            <div className="flex h-40 items-center justify-center">
              <CircleNotch size={22} weight="bold" className="animate-spin text-slate-400 motion-reduce:animate-none" aria-label="Opening" />
            </div>
          }
        >
          <PayFromWallet wallet={wallet} coin={coin} holding={h} target={target} base={at} need={need} onBack={() => (setPaying(false), setPayTitle(null))} onDone={onClose} onTitle={setPayTitle} />
        </Suspense>
      </Sheet>
    );
  return (
    <Sheet open onClose={onClose} title={`Add ${coin.ticker}`} note={options.length > 1 ? "Your node keeps a wallet for each way it swaps. Add to the one that will use it." : undefined}>
      <Sides coin={coin} options={options} value={at} onChange={setBase} label="Add to" />
      <div className="px-5 pb-6" data-add-funds-sheet={coin.key}>
        <div className="flex flex-col items-center">
          {f ? (
            <QrCode text={f.uri} label={`QR code: ${coin.ticker} to your node, ${f.address}`} />
          ) : (
            <div className="flex h-[208px] w-[208px] flex-col items-center justify-center rounded-2xl bg-slate-50 px-5 text-center text-[13px] text-slate-500">
              {error ? (
                <>
                  <WarningCircle size={22} weight="fill" className="text-rose-500" aria-hidden />
                  <span className="mt-2 text-rose-700">Couldn't get an address from your node.</span>
                  <button type="button" onClick={() => setTries((n) => n + 1)} className="mt-2 rounded font-medium text-slate-900 underline underline-offset-4">
                    Try again
                  </button>
                </>
              ) : missing ? (
                <span>Your node has no {coin.ticker} address to show. It may still be setting up its wallet.</span>
              ) : (
                <CircleNotch size={22} weight="bold" className="animate-spin text-slate-400 motion-reduce:animate-none" aria-label="Getting the address" />
              )}
            </div>
          )}
        </div>
        {f ? (
          <div className="mt-4 rounded-2xl bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium tracking-wider text-slate-500 uppercase">{coin.kind === "zec" ? "Your node's shielded address" : `Your node's address on ${coin.networkName}`}</p>
            <p className="mt-1.5 font-mono text-[13px] break-all text-slate-900" data-address>
              {f.address}
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <CopyButton value={f.address} />
              {coin.kind === "btc" || coin.kind === "ltc" ? (
                <button
                  type="button"
                  onClick={() => getAddresses(at, true).then((a) => setGot((x) => ({ ...x, [at]: a })), (e: Error) => setError(e.message))}
                  className="mt-3 rounded text-[13px] font-medium text-slate-700 underline-offset-4 transition-colors hover:text-slate-900 hover:underline"
                  data-fresh-address
                >
                  Use a new address
                </button>
              ) : null}
            </div>
            {coin.kind === "btc" || coin.kind === "ltc" ? <p className="mt-2 text-[13px] text-slate-500">This one works every time. A new one for each deposit keeps them apart on the chain.</p> : null}
          </div>
        ) : null}
        {f && target && wallet ? (
          <button
            type="button"
            onClick={() => (setBase(at), setPaying(true))}
            className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white text-sm font-medium text-slate-900 transition-colors hover:bg-slate-50"
            data-pay-wallet={wallet.name}
          >
            {wallet.icon ? <img src={wallet.icon} alt="" width={18} height={18} className="h-[18px] w-[18px] shrink-0 rounded-[4px]" /> : <WalletIcon size={16} weight="bold" aria-hidden />}
            Pay with {wallet.name}
          </button>
        ) : null}
        <ul className="mt-4 space-y-2 text-[13px] text-slate-600" data-funding-notes>
          {fundingNotes(coin, h).map((n) => (
            <li key={n} className="flex gap-2">
              <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-slate-400" aria-hidden />
              <span>{n}</span>
            </li>
          ))}
        </ul>
      </div>
    </Sheet>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() =>
        navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          },
          () => {},
        )
      }
      data-autofocus
      className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-full bg-slate-900 px-4 text-[13px] font-semibold text-white transition-colors hover:bg-slate-800"
    >
      {copied ? <Check size={14} weight="bold" aria-hidden /> : null}
      {copied ? "Copied" : "Copy address"}
    </button>
  );
}

// ------------------------------------------------------------------------------------------------
// Send to my wallet: the form, one check, then the send's status

function SendSheet({ coin, onClose, sends, refresh }: { coin: Coin; onClose: () => void; sends: Record<string, Withdrawal[]>; refresh: () => void }) {
  // the sides that can send and have something free (the most free first)
  const sendable = coin.holdings.filter((x) => canSend(x.node.status));
  const options = sendable.some((x) => x.free > 0n) ? sendable.filter((x) => x.free > 0n) : sendable;
  // the side picked, else the one with the most free (as balances arrive, until one is picked)
  const [base, setBase] = useState<string | null>(null);
  const h = options.find((x) => x.node.base === base) ?? sendFirst({ ...coin, holdings: options.length ? options : coin.holdings });
  const recv = receiveOf(coin, h);
  const remembered = storedReceive(recv.key);
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [toTouched, setToTouched] = useState(false);
  const [step, setStep] = useState<"form" | "review" | "sent">("form");
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const [sent, setSent] = useState<Withdrawal | null>(null);
  const [fee, setFee] = useState<{ amount: bigint; asset: SendAsset } | null>(null);

  const asset = h.asset;
  const dec = coin.decimals;
  const units = parseUnits(amount, dec);
  const dest = cleanAddress(recv, to);
  const toProblem = to.trim() ? addressProblem(recv, to) : "Paste your wallet's address.";
  const feeAsset: SendAsset = asset === "token" ? "eth" : asset;
  const feeGuess = fee && fee.asset === feeAsset ? fee.amount : USUAL_FEE[feeAsset];
  const feeSame = feeAsset === asset;
  const max = feeSame ? (h.free > feeGuess ? h.free - feeGuess : 0n) : h.free;
  const amountProblem = amount.trim() === "" ? "Enter an amount." : units == null || units <= 0n ? "Enter an amount, like 0.5." : units > h.free ? `Your node has ${unitsText(h.free, dec)} ${coin.ticker} free to send.` : feeSame && units + feeGuess > h.free ? "Leave a little for the network fee, or use Max." : null;
  const ready = !amountProblem && !toProblem;
  const fmt = (v: bigint, a: SendAsset = asset) => `${unitsText(v, a === "eth" ? 18 : a === "token" ? dec : 8, a === "eth" || dec > 8 ? 6 : 8)} ${a === "eth" ? "ETH" : coin.ticker}`;

  // the fee, from a node that can say before sending
  const preview = canPreview(h.node.status);
  useEffect(() => {
    if (!preview || !ready || units == null || step === "sent") return;
    let alive = true;
    const t = setTimeout(() => {
      previewSend(h.node.base, { asset, amount: units.toString(), to: dest }).then(
        (r) => alive && r.fee != null && setFee({ amount: BigInt(String(r.fee)), asset: r.fee_coin === "eth" ? "eth" : feeAsset }),
        () => {},
      );
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, ready, amount, dest, h.node.base, step]);

  // the send as the node reports it now
  const live = sent ? ((sends[h.node.base] ?? []).find((x) => (sent.id && x.id === sent.id) || (sent.txid && x.txid === sent.txid)) ?? sent) : null;

  const send = async () => {
    // the node is the judge of what is free now (a swap may have taken some since the form): only
    // the amount and the address are checked here
    if (units == null || units <= 0n || toProblem || busy) return;
    setBusy(true);
    setFail(null);
    try {
      const r = await sendOut(h.node.base, { asset, amount: units.toString(), to: dest });
      setSent(r);
      setStep("sent");
      refresh();
    } catch (e) {
      setFail(plainSendError((e as Error).message, coin.ticker));
      setStep("form");
    } finally {
      setBusy(false);
    }
  };

  const feeLine =
    fee && fee.asset === feeAsset
      ? `${fmt(fee.amount, feeAsset)}${feeSame ? "" : ", for gas"}`
      : preview
        ? "Shown once the amount and address are in"
        : `On top of the amount, about ${fmt(USUAL_FEE[feeAsset], feeAsset)}; shown once sent`;
  const title = step === "sent" ? (live && sendState(live) === "failed" ? "It didn't go through" : live && sendState(live) === "sent" ? "Sent" : "Sending…") : step === "review" ? "Check and send" : `Send ${coin.ticker} to your wallet`;

  return (
    <Sheet open onClose={onClose} title={title}>
      {step === "form" ? <Sides coin={coin} options={options} value={h.node.base} onChange={(b) => (setBase(b), setFee(null))} label="Send from" /> : null}
      <div className="px-5 pb-6" data-send-sheet={step}>
        {step === "form" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setToTouched(true);
              if (ready) setStep("review");
            }}
          >
            <label className="block">
              <span className="flex items-baseline justify-between gap-3 text-[13px]">
                <span className="font-medium text-slate-700">Amount</span>
                <span className="text-slate-500 tabular-nums">{unitsText(h.free, dec)} {coin.ticker} free</span>
              </span>
              <span className="mt-1.5 flex h-12 items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 pr-1.5 pl-3.5 focus-within:border-slate-300 focus-within:bg-white">
                <input
                  value={amount}
                  onChange={(e) => (setAmount(e.target.value.replace(",", ".")), base ?? setBase(h.node.base))}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  data-autofocus
                  aria-label={`${coin.ticker} to send`}
                  aria-invalid={!!amount && !!amountProblem}
                  className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-slate-900 tabular-nums placeholder:text-slate-400 focus:outline-none"
                />
                <span className="text-sm text-slate-500">{coin.ticker}</span>
                <button type="button" onClick={() => setAmount(inputText(max, dec))} disabled={max === 0n} className="rounded-full px-2.5 py-1 text-xs font-semibold text-slate-900 transition-colors hover:bg-slate-200/70 disabled:text-slate-400">
                  Max
                </button>
              </span>
            </label>
            {amount && amountProblem ? (
              <p role="alert" className="mt-1.5 text-[13px] text-rose-600">
                {amountProblem}
              </p>
            ) : null}

            <label className="mt-4 block">
              <span className="text-[13px] font-medium text-slate-700">To your {coin.kind === "zec" ? "shielded" : coin.ticker} address</span>
              <input
                value={to}
                onChange={(e) => (setTo(e.target.value), base ?? setBase(h.node.base))}
                onBlur={() => to.trim() && setToTouched(true)}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                aria-invalid={toTouched && !!to.trim() && !!toProblem}
                aria-describedby="send-to-note"
                placeholder={coin.kind === "zec" ? "Your Zodl or other shielded address (u…)" : coin.kind === "token" || coin.kind === "eth" ? "0x…" : `Your ${coin.ticker} address`}
                className={cn(
                  "mt-1.5 h-12 w-full rounded-2xl border bg-slate-50 px-3.5 font-mono text-[13px] text-slate-900 placeholder:font-sans placeholder:text-slate-400 focus:bg-white focus:outline-none",
                  toTouched && to.trim() && toProblem ? "border-rose-300" : to.trim() && !toProblem ? "border-emerald-300" : "border-slate-200 focus:border-slate-300",
                )}
              />
            </label>
            <p id="send-to-note" role={toTouched && to.trim() && toProblem ? "alert" : undefined} className={cn("mt-1.5 text-[13px]", toTouched && to.trim() && toProblem ? "text-rose-600" : "text-slate-500")}>
              {toTouched && to.trim() && toProblem
                ? toProblem
                : coin.kind === "zec"
                  ? "Shielded only: a unified address. It arrives shielded."
                  : `On ${coin.networkName} only.`}
            </p>
            {remembered && remembered !== dest ? (
              <button type="button" onClick={() => (setTo(remembered), setToTouched(true))} className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-[13px] text-slate-700 transition-colors hover:bg-slate-200 hover:text-slate-900">
                <span className="shrink-0">Use your wallet</span>
                <span className="truncate font-mono text-xs">{shortAddress(remembered)}</span>
              </button>
            ) : null}

            <dl className="mt-5 space-y-2 rounded-2xl bg-slate-50 px-4 py-3 text-sm">
              <Line label="Network" value={coin.kind === "zec" ? `${coin.networkName}, shielded` : coin.networkName} />
              <Line label="Network fee" value={feeLine} />
            </dl>

            <button
              type="submit"
              disabled={!ready}
              className="mt-5 flex h-12 w-full items-center justify-center rounded-2xl bg-slate-900 text-[15px] font-semibold text-white transition-colors hover:bg-slate-800 disabled:bg-slate-100 disabled:text-slate-400"
            >
              Review
            </button>
            {fail ? (
              <p role="alert" className="mt-3 text-center text-sm text-rose-600" data-send-error>
                {fail}
              </p>
            ) : null}
          </form>
        ) : step === "review" && units != null ? (
          <div>
            <p className="text-3xl font-semibold tracking-tight text-slate-900 tabular-nums">{fmt(units)}</p>
            <dl className="mt-4 space-y-2.5 rounded-2xl bg-slate-50 px-4 py-3.5 text-sm">
              <div>
                <dt className="text-slate-500">To</dt>
                <dd className="mt-0.5 font-mono text-[13px] break-all text-slate-900" data-review-to>
                  {dest}
                </dd>
              </div>
              {options.length > 1 ? <Line label="From" value={sideName(h.node)} /> : null}
              <Line label="Network" value={coin.kind === "zec" ? `${coin.networkName}, shielded` : coin.networkName} />
              <Line label="Network fee" value={feeLine} />
              <Line label="Left in your node" value={fmt(h.free - units - (feeSame ? feeGuess : 0n) > 0n ? h.free - units - (feeSame ? feeGuess : 0n) : 0n)} />
            </dl>
            <p className="mt-4 flex items-start gap-2 text-[13px] text-slate-600">
              <Warning size={16} className="mt-px shrink-0 text-slate-500" aria-hidden />
              A send can't be undone. Check the address against your wallet{coin.kind === "zec" ? "" : `, and that it's on ${coin.networkName}`}.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <button
                type="button"
                onClick={send}
                disabled={busy}
                data-autofocus
                className="flex h-12 w-full items-center justify-center rounded-2xl bg-slate-900 text-[15px] font-semibold text-white transition-colors hover:bg-slate-800 disabled:bg-slate-100 disabled:text-slate-400"
              >
                {busy ? "Sending…" : `Send ${fmt(units)}`}
              </button>
              <button type="button" onClick={() => setStep("form")} className="flex h-11 w-full items-center justify-center rounded-2xl text-[15px] font-medium text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900">
                Back
              </button>
            </div>
          </div>
        ) : live ? (
          <SentStatus w={live} coin={coin} onDone={onClose} />
        ) : null}
      </div>
    </Sheet>
  );
}

function SentStatus({ w, coin, onDone }: { w: Withdrawal; coin: Coin; onDone: () => void }) {
  const s = sendState(w);
  const amount = BigInt(String(w.amount));
  const dec = sendAsset(w) === "eth" ? 18 : coin.decimals;
  return (
    <div className="text-center" data-sent-state={s}>
      <span className={cn("mx-auto flex h-14 w-14 items-center justify-center rounded-full", s === "sent" ? "bg-emerald-50 text-emerald-600" : s === "failed" ? "bg-rose-50 text-rose-600" : "bg-slate-100 text-slate-900")}>
        {s === "sent" ? <Check size={26} weight="bold" aria-hidden /> : s === "failed" ? <Warning size={26} weight="bold" aria-hidden /> : <CircleNotch size={26} weight="bold" className="animate-spin motion-reduce:animate-none" aria-hidden />}
      </span>
      <p className="mt-4 text-lg font-semibold text-slate-900 tabular-nums">
        {unitsText(amount, dec, dec > 8 ? 6 : 8)} {sendAsset(w) === "eth" ? "ETH" : coin.ticker}
      </p>
      <p className="mt-1 text-sm text-slate-600">
        {s === "sent"
          ? `In your wallet${w.confirmations ? `, ${w.confirmations} confirmation${w.confirmations === 1 ? "" : "s"}` : ""}.`
          : s === "failed"
            ? (w.error ?? "Your node couldn't send it.").replace(/\bdaemon\b/gi, "Ferry node")
            : "On its way. It shows in your wallet once the network confirms it."}
      </p>
      <p className="mt-3 font-mono text-xs break-all text-slate-500">to {w.to}</p>
      {w.fee != null && s !== "failed" ? (
        <p className="mt-1 text-xs text-slate-500 tabular-nums" data-sent-fee>
          Network fee {unitsText(BigInt(String(w.fee)), w.fee_coin === "eth" ? 18 : coin.decimals, w.fee_coin === "eth" || coin.decimals > 8 ? 6 : 8)} {w.fee_coin === "eth" ? "ETH" : coin.ticker}, paid on top
        </p>
      ) : null}
      {w.txid ? (
        <p className="mt-2 flex justify-center">
          <CopyText value={w.txid} head={10} tail={8} />
        </p>
      ) : null}
      <button type="button" onClick={onDone} className="mt-6 flex h-12 w-full items-center justify-center rounded-2xl bg-slate-900 text-[15px] font-semibold text-white transition-colors hover:bg-slate-800">
        Done
      </button>
    </div>
  );
}

function SendRow({ w, coin }: { w: Withdrawal; coin: Coin | undefined }) {
  const s = sendState(w);
  const dec = sendAsset(w) === "eth" ? 18 : (coin?.decimals ?? 8);
  const at = sentAt(w);
  return (
    <li className="flex items-center gap-3 px-5 py-3.5" data-send-row={s}>
      {coin ? <CoinLogo coin={coin} size={28} /> : null}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-900 tabular-nums">
          {unitsText(BigInt(String(w.amount)), dec, dec > 8 ? 6 : 8)} {sendAsset(w) === "eth" ? "ETH" : (coin?.ticker ?? String(w.coin ?? w.asset).toUpperCase())}
        </p>
        <p className="truncate text-[13px] text-slate-500">
          to <span className="font-mono text-xs">{shortAddress(w.to)}</span>
          {at ? ` · ${ago(at)}` : ""}
          {s === "failed" && w.error ? ` · ${w.error}` : ""}
        </p>
      </div>
      <ToneBadge tone={s === "sent" ? "good" : s === "failed" ? "bad" : "live"}>{s === "sent" ? "Sent" : s === "failed" ? "Failed" : "Sending"}</ToneBadge>
    </li>
  );
}

function Line({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className="min-w-0 text-right text-slate-900 tabular-nums">{value}</dd>
    </div>
  );
}

const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
};

// The node's refusals, for people: how much is free, the address, anything else in its words.
function plainSendError(raw: string, ticker: string): string {
  // "Only 0.9999 ZEC is free to withdraw: 3.9999 ZEC is in the wallet and 3 ZEC is held for a swap…"
  if (/free to withdraw|is free for gas|not enough free|insufficient/i.test(raw)) {
    const detail = raw.replace(/\.?$/, ".");
    return `Your node doesn't have that much ${ticker} free right now.${/swap/i.test(detail) ? "" : " A swap may be holding some."} ${detail}`;
  }
  if (/^to:\s*/i.test(raw)) return `Your node refused the address: ${raw.replace(/^to:\s*/i, "").replace(/^./, (c) => c.toUpperCase())}.`.replace(/\.\.$/, ".");
  // a send and a swap start never run together; nor two sends
  if (/swap is being started|starting a swap|swap start/i.test(raw)) return "A swap is starting. Try again in a moment.";
  if (/another withdrawal|withdrawal is being sent/i.test(raw)) return "Your node is still sending something else. Try again in a moment.";
  if (/lock is funded/i.test(raw)) return "A swap is about to lock your coins. Try again in a moment.";
  if (/waiting for confirmations|change confirms|tie up/i.test(raw)) return `Some of your ${ticker} is still confirming. Try again in a few minutes. (${raw})`;
  if (/fee.*(cap|too high|above)|above the cap/i.test(raw)) return "The network fee is unusually high right now, so your node didn't send. Try again later.";
  if (/nothing was sent|did not answer/i.test(raw)) return `Your node couldn't send it, and nothing left your wallet. ${raw.replace(/\bdaemon\b/gi, "Ferry node")}`;
  if (/own Ferry node|127\.0\.0\.1|own page/i.test(raw)) return raw;
  if (/private swap|NEAR Intents/i.test(raw)) return raw;
  if (/reach the daemon|unreachable|timed? ?out/i.test(raw)) return "Couldn't reach your Ferry node. Try again in a moment.";
  return raw.replace(/\bdaemon\b/gi, "Ferry node");
}

