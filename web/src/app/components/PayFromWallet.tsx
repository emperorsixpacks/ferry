import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, CircleNotch, ShieldCheck, Wallet, Warning, WarningCircle } from "@phosphor-icons/react";
import { getAddresses } from "@/api";
import { CopyText } from "./CopyText";
import { isEvmAddress, sameAddress, type BrowserWallet } from "../lib/browserWallet";
import { PayError, chainOf, connect, ensureChain, payTx, plainError, receiptOf, txLink, walletBalance } from "../lib/evmPay";
import { shortAddress } from "../lib/receive";
import { cn } from "../lib/utils";
import { inputText, parseUnits, payTarget, unitsText, type Coin, type Holding, type PayTarget } from "../lib/wallet";

// "Pay with MetaMask" in /wallet's Add funds, for an EVM coin on the person's own node: an amount,
// the wallet connected and put on the node's chain, one transfer to the node's account, then its
// status: sent, confirmed (the wallet's receipt), and in the node once its balance goes up. The
// wallet's address stays in this component's state; it is never sent to the server or the node.

export type PayPhase = "form" | "pending" | "confirmed" | "arrived" | "reverted";

export function PayFromWallet({
  wallet,
  coin,
  holding,
  target,
  base,
  need,
  onBack,
  onDone,
  onTitle,
}: {
  wallet: BrowserWallet;
  coin: Coin;
  // the side being paid, live (its balance shows the transfer arriving)
  holding: Holding;
  // the node's account, token and chain on screen
  target: PayTarget;
  base: string;
  // how much the swap card was short, in base units: the amount to start with
  need: bigint | null;
  onBack: () => void;
  onDone: () => void;
  onTitle: (title: string) => void;
}) {
  const p = wallet.provider;
  const network = coin.networkName;
  const dec = target.decimals;
  const t = target.ticker;
  const fmt = (v: bigint) => `${unitsText(v, dec, dec > 8 ? 6 : 8)} ${t}`;

  const [amount, setAmount] = useState(() => (need && need > 0n ? inputText(need, dec) : ""));
  const [from, setFrom] = useState<string | null>(null);
  // what the connected account holds here: undefined not read yet, null the wallet couldn't say
  const [bal, setBal] = useState<bigint | null | undefined>(undefined);
  // false: the person moved the wallet to another network (sending switches it back)
  const [onChain, setOnChain] = useState(true);
  const [busy, setBusy] = useState<"connect" | "send" | null>(null);
  const [fail, setFail] = useState<string | null>(null);
  const [sent, setSent] = useState<{ hash: string; units: bigint; baseline: bigint } | null>(null);
  const [receipt, setReceipt] = useState<"ok" | "reverted" | null>(null);

  const units = parseUnits(amount, dec);
  const amountProblem =
    amount.trim() === "" ? "Enter an amount." : units == null || units <= 0n ? `Enter an amount, like ${t === "ETH" ? "0.01" : "25"}.` : bal != null && units > bal ? `${wallet.name} has ${fmt(bal)} on ${network}.` : null;

  const arrived = !!sent && receipt !== "reverted" && holding.units > sent.baseline;
  const phase: PayPhase = !sent ? "form" : receipt === "reverted" ? "reverted" : arrived ? "arrived" : receipt === "ok" ? "confirmed" : "pending";
  const title = phase === "form" ? `Pay from ${wallet.name}` : phase === "arrived" ? "Arrived in your node" : phase === "reverted" ? "It didn't go through" : "Sent from your wallet";
  useEffect(() => onTitle(title), [title, onTitle]);

  const fromAccount = async (accounts: unknown) => {
    const a = Array.isArray(accounts) ? accounts.find(isEvmAddress) : undefined;
    setFrom(a ?? null);
    const here = (await chainOf(p)) === target.chainId;
    setOnChain(here);
    setBal(a && here ? await walletBalance(p, a, target.token) : undefined);
  };

  const connectWallet = async () => {
    if (busy) return;
    setBusy("connect");
    setFail(null);
    try {
      const a = await connect(p);
      await ensureChain(p, target.chainId);
      setFrom(a);
      setOnChain(true);
      setBal(await walletBalance(p, a, target.token));
    } catch (e) {
      setFail(plainError(e, wallet.name, network, target.chainId, t));
    } finally {
      setBusy(null);
    }
  };

  // The person clicked "Pay with …": ask the wallet at once (once, StrictMode or not).
  const asked = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    if (asked.current) return;
    asked.current = true;
    void connectWallet();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // another account or network picked in the wallet while this is open
  useEffect(() => {
    if (!p.on || !p.removeListener) return;
    const onAccounts = (accounts: unknown) => void fromAccount(accounts);
    const onChain = () => void p.request({ method: "eth_accounts" }).then(fromAccount, () => {});
    p.on("accountsChanged", onAccounts);
    p.on("chainChanged", onChain);
    return () => {
      p.removeListener?.("accountsChanged", onAccounts);
      p.removeListener?.("chainChanged", onChain);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p, target.chainId, target.token]);

  const send = async () => {
    if (busy || !from || units == null || units <= 0n || amountProblem) return;
    setBusy("send");
    setFail(null);
    try {
      // the node's account once more, right before sending: it must be the one on screen
      let now: PayTarget | null;
      try {
        now = payTarget(coin, holding, await getAddresses(base));
      } catch {
        setFail("Couldn't reach your Ferry node to check its address. Nothing was sent. Try again.");
        return;
      }
      if (!now || !sameAddress(now.address, target.address) || now.chainId !== target.chainId || (now.token ?? "").toLowerCase() !== (target.token ?? "").toLowerCase() || now.decimals !== target.decimals) {
        setFail("Your node's address isn't the one shown here any more. Nothing was sent. Close this and open Add funds again.");
        return;
      }
      // the account and the network the wallet is on now
      const accounts = await p.request({ method: "eth_accounts" });
      const account = Array.isArray(accounts) ? accounts.find(isEvmAddress) : undefined;
      if (!account) throw new PayError("locked");
      setFrom(account);
      if (sameAddress(account, target.address)) {
        setFail(`That ${wallet.name} account is your node's own. Pick another account in ${wallet.name}.`);
        return;
      }
      await ensureChain(p, target.chainId);
      setOnChain(true);
      const have = await walletBalance(p, account, target.token);
      setBal(have);
      if (have != null && units > have) {
        setFail(`${wallet.name} has ${fmt(have)} on ${network}. Enter less, or add ${t} to it first.`);
        return;
      }
      const baseline = holding.units;
      const hash = await p.request({ method: "eth_sendTransaction", params: [payTx(account, target.address, target.token, units)] });
      if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("it didn't return a transaction");
      setSent({ hash, units, baseline });
    } catch (e) {
      setFail(plainError(e, wallet.name, network, target.chainId, t));
    } finally {
      setBusy(null);
    }
  };

  // the receipt, through the wallet, until the chain has mined it
  useEffect(() => {
    if (!sent || receipt) return;
    let alive = true;
    const look = () =>
      receiptOf(p, sent.hash).then((r) => {
        if (alive && r) setReceipt(r);
      });
    void look();
    const id = setInterval(look, 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [sent, receipt, p]);

  const icon = wallet.icon ? <img src={wallet.icon} alt="" width={16} height={16} className="h-4 w-4 shrink-0 rounded-[4px]" /> : null;

  if (sent) {
    const link = txLink(target.chainId, sent.hash);
    return (
      <div className="px-5 pb-6 text-center" data-pay-state={phase}>
        <span className={cn("mx-auto flex h-14 w-14 items-center justify-center rounded-full", phase === "arrived" ? "bg-emerald-50 text-emerald-600" : phase === "reverted" ? "bg-rose-50 text-rose-600" : "bg-slate-100 text-slate-900")}>
          {phase === "arrived" ? <Check size={26} weight="bold" aria-hidden /> : phase === "reverted" ? <Warning size={26} weight="bold" aria-hidden /> : <CircleNotch size={26} weight="bold" className="animate-spin motion-reduce:animate-none" aria-hidden />}
        </span>
        <p className="mt-4 text-lg font-semibold text-slate-900 tabular-nums">{fmt(sent.units)}</p>
        <p className="mt-1 text-sm text-slate-600" role="status">
          {phase === "arrived"
            ? `In your node on ${network}, ready to swap.`
            : phase === "reverted"
              ? `${network} turned the transfer down, so no ${t} moved. Only the gas was spent.`
              : phase === "confirmed"
                ? `Confirmed on ${network}. Your node shows it once it sees that block.`
                : `Sent from ${wallet.name}. Waiting for ${network} to confirm it.`}
        </p>
        <p className="mt-3 font-mono text-xs break-all text-slate-500">to {target.address}</p>
        <p className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
          <CopyText value={sent.hash} head={10} tail={8} />
          {link ? (
            <a href={link.href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 rounded text-xs font-medium text-slate-700 underline-offset-4 transition-colors hover:text-slate-900 hover:underline" data-pay-explorer>
              View on {link.name}
              <ArrowUpRight size={11} weight="bold" aria-hidden />
            </a>
          ) : null}
        </p>
        <button type="button" onClick={onDone} data-autofocus className="mt-6 flex h-12 w-full items-center justify-center rounded-2xl bg-slate-900 text-[15px] font-semibold text-white transition-colors hover:bg-slate-800">
          Done
        </button>
      </div>
    );
  }

  return (
    <div className="px-5 pb-6" data-pay-state="form">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void (from ? send() : connectWallet());
        }}
      >
        <label className="block">
          <span className="flex items-baseline justify-between gap-3 text-[13px]">
            <span className="font-medium text-slate-700">Amount</span>
            {from ? (
              <span className="truncate text-slate-500 tabular-nums" data-wallet-balance>
                {!onChain ? `${wallet.name} is on another network` : bal === undefined ? `Reading ${wallet.name}…` : bal === null ? "" : `${fmt(bal)} in ${wallet.name}`}
              </span>
            ) : null}
          </span>
          <span className="mt-1.5 flex h-12 items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 pr-1.5 pl-3.5 focus-within:border-slate-300 focus-within:bg-white">
            <input
              ref={input}
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(",", "."))}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              data-autofocus
              aria-label={`${t} to add`}
              aria-invalid={!!amount && !!amountProblem}
              className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-slate-900 tabular-nums placeholder:text-slate-400 focus:outline-none"
            />
            <span className="text-sm text-slate-500">{t}</span>
            {target.token && bal ? (
              <button type="button" onClick={() => setAmount(inputText(bal, dec))} className="rounded-full px-2.5 py-1 text-xs font-semibold text-slate-900 transition-colors hover:bg-slate-200/70">
                Max
              </button>
            ) : (
              <span className="w-1.5" aria-hidden />
            )}
          </span>
        </label>
        {amount && amountProblem ? (
          <p role="alert" className="mt-1.5 text-[13px] text-rose-600" data-pay-amount-problem>
            {amountProblem}
          </p>
        ) : from && onChain && bal === null ? (
          <p className="mt-1.5 text-[13px] text-slate-500" data-pay-balance-unknown>
            Couldn't read what's in {wallet.name}. It checks before it sends.
          </p>
        ) : null}

        <dl className="mt-4 space-y-2.5 rounded-2xl bg-slate-50 px-4 py-3.5 text-sm">
          <div>
            <dt className="text-slate-500">To your node</dt>
            <dd className="mt-0.5 font-mono text-[13px] break-all text-slate-900" data-pay-to>
              {target.address}
            </dd>
          </div>
          <Row label="Network" value={network} />
          <Row
            label="From"
            value={
              <span className="inline-flex max-w-full items-center gap-1.5">
                {icon}
                <span className="truncate">{wallet.name}</span>
                {from ? <span className="font-mono text-xs text-slate-500">{shortAddress(from)}</span> : null}
              </span>
            }
          />
        </dl>
        <p className="mt-4 flex items-start gap-2 text-[13px] text-slate-600" data-pay-privacy>
          <ShieldCheck size={16} className="mt-px shrink-0 text-slate-500" aria-hidden />
          <span>
            Ferry doesn't keep your {wallet.name} address. The transfer is public on {network}, like any {t} payment.
          </span>
        </p>
        {fail ? (
          <p role="alert" className="mt-4 flex items-start gap-2 rounded-2xl bg-rose-50 px-3.5 py-2.5 text-[13px] text-rose-700" data-pay-error>
            <WarningCircle size={16} weight="fill" className="mt-px shrink-0 text-rose-500" aria-hidden />
            <span>{fail}</span>
          </p>
        ) : null}

        <div className="mt-5 flex flex-col gap-2">
          <button
            type="submit"
            disabled={busy != null || (!!from && !!amountProblem)}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-slate-900 text-[15px] font-semibold text-white transition-colors hover:bg-slate-800 disabled:bg-slate-100 disabled:text-slate-400"
            data-pay-submit
          >
            {busy ? <CircleNotch size={16} weight="bold" className="animate-spin motion-reduce:animate-none" aria-hidden /> : from ? null : <Wallet size={16} weight="bold" aria-hidden />}
            {busy === "connect" ? `Waiting for ${wallet.name}…` : busy === "send" ? `Confirm in ${wallet.name}…` : from ? (units && units > 0n ? `Send ${fmt(units)}` : "Send") : `Connect ${wallet.name}`}
          </button>
          <button type="button" onClick={onBack} className="flex h-11 w-full items-center justify-center rounded-2xl text-[15px] font-medium text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900">
            Back to the QR code
          </button>
        </div>
      </form>
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className="min-w-0 text-right text-slate-900 tabular-nums">{value}</dd>
    </div>
  );
}
