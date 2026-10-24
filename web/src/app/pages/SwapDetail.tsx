import { useEffect, type ReactNode } from "react";
import { ArrowCounterClockwise, ArrowLeft, ArrowRight, Check, CircleNotch, Lock, ShieldCheck, ShieldSlash, Warning } from "@phosphor-icons/react";
import { directionOf, type Status, type SwapView } from "@/api";
import { CHAIN_NAMES, coin } from "@/format";
import { Link } from "@/router";
import { btcText } from "@/swap/shared";
import { phaseOf, stepsOf, transactions } from "@/swap/steps";
import { clock, clockSeconds, roughDuration, typicalSeconds, unwoundBy } from "@/swap/timing";
import { CopyText } from "../components/CopyText";
import { Layout } from "../components/Layout";
import { PairLogo, TokenLogo } from "../components/Logos";
import { ScrambleText } from "../components/ScrambleText";
import { ToneBadge } from "../components/ui/badge";
import { Fold } from "../components/ui/fold";
import { cn } from "../lib/utils";
import { useLocal } from "../lib/daemon";
import { STATUS_WORD, lockedMine, plainSteps, swapAmounts, wordsFor, type PlainStep, type Tone } from "../lib/progress";
import { useWalletCaughtUp } from "../lib/walletSync";

// /app/swap/:id: one calm card. A status word, a headline, three or four plain steps with the
// current one explained, and what to expect. Everything technical (ids, transactions, deadlines,
// the watchtower, what each chain sees) is folded away under "Technical details".
export function SwapDetail({ id }: { id: string }) {
  const d = useLocal();
  const swap = d.swaps[id];
  // A swap of the other direction (opened from a link, or the banner after a flip): follow the
  // daemon that runs it, so the page updates live and reads that daemon's status.
  const other = !!swap && swap.role !== d.role && d.canFlip;
  useEffect(() => {
    if (other && swap) d.chooseDirection(directionOf(swap.role));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [other]);
  return (
    <Layout>
      <div className="mx-auto w-full max-w-[480px]">
        <Link to="/app/activity" className="mb-4 inline-flex items-center gap-1.5 rounded text-sm text-slate-500 transition-colors hover:text-slate-900">
          <ArrowLeft size={14} weight="bold" aria-hidden />
          Activity
        </Link>
        {swap ? (
          <Body swap={swap} status={d.status} />
        ) : (
          <div className="rounded-3xl border border-slate-200 bg-white px-6 py-14 text-center">
            <CircleNotch size={28} weight="bold" className="mx-auto animate-spin text-slate-400 motion-reduce:animate-none" aria-hidden />
            <p className="mt-4 text-slate-600">{d.connected ? "Loading your swap…" : "Waiting for your Ferry node…"}</p>
          </div>
        )}
      </div>
    </Layout>
  );
}

function Body({ swap, status }: { swap: SwapView; status: Status | null }) {
  const { bt, pair } = useLocal();
  const phase = phaseOf(swap);
  const w = wordsFor();
  const a = swapAmounts(swap, status, w);
  const z = swap.role === "Z";
  const mine = z ? a.zec : a.coin;
  const live = phase === "progress" || phase === "unwinding";
  const refused = swap.timeline.some((e) => e.kind === "zec_lock_refused");
  const lapsed = swap.timeline.some((e) => e.kind === "zec_lock_lapsed");
  const by = unwoundBy(status, swap, bt);
  const caughtUp = useWalletCaughtUp(swap, status);
  const word = STATUS_WORD[phase];

  let head: { tone: Tone; title: string; sub: ReactNode };
  if (!caughtUp) head = { tone: "live", title: "Updating wallet…", sub: "The swap is finished. Your wallet is picking up the result." };
  else if (phase === "progress") head = { tone: "live", title: "Swapping…", sub: status ? `Usually ${roughDuration(typicalSeconds(status, bt))}.` : null };
  else if (phase === "unwinding")
    head = {
      tone: "warn",
      title: "Cancelling…",
      sub: refused ? `Nothing left your wallet. It closes by about ${by ? clock(by) : "–"}.` : `Nothing is lost. Your ${mine} comes back by about ${by ? clock(by) : "–"}.`,
    };
  else if (phase === "done") head = { tone: "good", title: `You received ${z ? a.coin : a.zec}`, sub: z ? `${a.zec} left your shielded wallet.` : `It's in your shielded wallet. You paid ${a.coin}.` };
  else if (phase === "settled")
    head = { tone: "good", title: `You received ${a.coin}`, sub: `Your partner stopped responding, so after the deadline their ${w.ticker} was released to you. You were paid in full for your ZEC.` };
  else if (phase === "refunded")
    head = {
      tone: "neutral",
      title: lockedMine(swap) ? `Your ${mine} is back` : "Nothing left your wallet",
      sub: refused
        ? "Your wallet couldn't send the ZEC from shielded funds alone, so the swap was called off before any ZEC moved."
        : lapsed
          ? "Your ZEC payment never reached the network and expired, so no ZEC moved. The swap was called off."
          : "The swap didn't finish in time, so it was undone. Nothing changed hands.",
    };
  else head = { tone: "bad", title: "The swap didn't complete", sub: `Your Ferry node was offline past the deadline, so the ${a.coin} went to your partner.` };

  const steps = plainSteps(swap, w);
  const started = swap.timeline[0]?.at;
  const eta = started && status ? new Date(Date.parse(started) + typicalSeconds(status, bt) * 1000) : null;
  const armed = swap.watchtower?.status === "armed";

  return (
    <>
      <div className="rounded-3xl border border-slate-200 bg-white px-5 py-7 shadow-[0_1px_2px_rgba(24,24,27,0.04)] sm:px-8 sm:py-8">
        <div className="flex flex-col items-center text-center">
          <StatusIcon tone={head.tone} />
          <ToneBadge tone={caughtUp ? word.tone : "live"} className="mt-5">
            {caughtUp ? word.label : "Finishing"}
          </ToneBadge>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-balance text-slate-900 tabular-nums sm:text-[28px]">{head.title}</h1>
          {head.sub ? <p className="mt-2 max-w-sm text-[15px] text-balance text-slate-600">{head.sub}</p> : null}
        </div>

        {live ? (
          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-900 tabular-nums">
            <span className="inline-flex items-center gap-2">
              {z ? <TokenLogo id="zec" size={20} /> : <PairLogo pair={pair} size={20} />}
              {z ? a.zec : a.coin}
            </span>
            <ArrowRight size={14} weight="bold" className="text-slate-400" aria-label="for" />
            <span className="inline-flex items-center gap-2">
              {z ? <PairLogo pair={pair} size={20} /> : <TokenLogo id="zec" size={20} />}
              {z ? a.coin : a.zec}
            </span>
          </div>
        ) : null}

        <Tracker steps={steps} />

        {live ? (
          <div className="mt-6 space-y-2 border-t border-slate-100 pt-5 text-sm text-slate-600">
            {phase === "progress" && eta ? (
              <p>{eta.getTime() > Date.now() ? `Usually done by about ${clock(eta)}.` : "Taking a little longer than usual. Nothing is lost."}</p>
            ) : null}
            {phase === "progress" ? <p>If anything goes wrong, your {mine} comes back automatically by about {by ? clock(by) : "–"}.</p> : null}
            <p className="text-slate-900">
              You can close this page — your Ferry node finishes the swap.{" "}
              <span className="text-slate-600">{armed ? "A watchtower also keeps the deadlines if your node goes offline." : "Keep your node running until it's done."}</span>
            </p>
          </div>
        ) : (
          <div className="mt-7 flex flex-col items-center gap-3">
            <Link to="/app" className="flex h-12 w-full items-center justify-center rounded-2xl bg-slate-900 text-[15px] font-semibold text-white transition-colors hover:bg-slate-800">
              {phase === "done" || phase === "settled" ? "Swap again" : "Start a new swap"}
            </Link>
            <Link to="/app/activity" className="rounded text-sm text-slate-600 transition-colors hover:text-slate-900">
              View all activity
            </Link>
          </div>
        )}
      </div>

      <Fold
        title={<span className="text-sm font-medium text-slate-700">Technical details</span>}
        className="mt-4 rounded-3xl border border-slate-200 bg-white"
        buttonClassName="rounded-3xl px-5 py-4 hover:bg-slate-50"
        bodyClassName="border-t border-slate-100 px-5 pt-5 pb-6"
      >
        <Technical swap={swap} status={status} />
      </Fold>
    </>
  );
}

function StatusIcon({ tone }: { tone: Tone }) {
  const box = "flex h-14 w-14 items-center justify-center rounded-full";
  if (tone === "live")
    return (
      <span className={cn(box, "bg-slate-100 text-slate-900")}>
        <CircleNotch size={26} weight="bold" className="animate-spin motion-reduce:animate-none" aria-hidden />
      </span>
    );
  if (tone === "good")
    return (
      <span className={cn(box, "bg-emerald-50 text-emerald-600")}>
        <Check size={26} weight="bold" aria-hidden />
      </span>
    );
  if (tone === "bad")
    return (
      <span className={cn(box, "bg-rose-50 text-rose-600")}>
        <Warning size={26} weight="bold" aria-hidden />
      </span>
    );
  return (
    <span className={cn(box, tone === "warn" ? "bg-slate-100 text-slate-900" : "bg-slate-100 text-slate-600")}>
      <ArrowCounterClockwise size={26} weight="bold" aria-hidden />
    </span>
  );
}

// The plain steps, top to bottom: done ones ticked, the current one explained.
function Tracker({ steps }: { steps: PlainStep[] }) {
  return (
    <ol className="mt-7 space-y-0" aria-label="Progress">
      {steps.map((s, i) => (
        <li key={i} className="relative flex gap-4 pb-5 last:pb-0" aria-current={s.status === "active" ? "step" : undefined}>
          {i < steps.length - 1 ? <span className={cn("absolute top-7 bottom-1 left-[11px] w-0.5 rounded-full", s.status === "done" ? "bg-slate-900" : "bg-slate-200")} aria-hidden /> : null}
          <span
            className={cn(
              "relative z-10 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
              s.status === "done" ? "bg-slate-900 text-white" : s.status === "active" ? "border-2 border-slate-900 bg-white" : "border-2 border-slate-200 bg-white",
            )}
            aria-hidden
          >
            {s.status === "done" ? <Check size={12} weight="bold" /> : s.status === "active" ? <span className="h-2 w-2 animate-pulse rounded-full bg-slate-900 motion-reduce:animate-none" /> : null}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <p className={cn("text-[15px]", s.status === "pending" ? "text-slate-500" : "font-medium text-slate-900")}>
                {s.title}
                <span className="sr-only">{s.status === "done" ? " (done)" : s.status === "active" ? " (now)" : ""}</span>
              </p>
              {s.status === "done" && s.at ? <span className="shrink-0 text-xs text-slate-500 tabular-nums">{clockSeconds(s.at)}</span> : null}
            </div>
            {s.status === "active" && s.note ? <p className="mt-1 text-sm text-slate-600">{s.note}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

// Everything a curious or technical reader may want, in the order they'd look for it.
function Technical({ swap, status }: { swap: SwapView; status: Status | null }) {
  const d = swap.deadlines;
  const evm = coin().kind === "evm";
  const chain = evm ? (coin().chain ? CHAIN_NAMES[coin().chain!] : coin().name) : coin().name;
  const phase = phaseOf(swap);
  const armed = swap.watchtower?.status === "armed";
  const a = swapAmounts(swap, status);
  const rate = swap.amounts.zec_zat > 0 ? Math.round((swap.amounts.btc_sat * 1e8) / swap.amounts.zec_zat) : 0;
  const refused = swap.timeline.some((e) => e.kind === "zec_lock_refused");
  const protection = refused
    ? `Your wallet couldn't send the ZEC from shielded notes only, so no ZEC moved. The other side takes its ${coin().asset} back after the deadline.`
    : evm
      ? phase === "unwinding"
        ? `The swap didn't finish in time, so it was called off. From here the FerryLock contract on ${coin().name} only pays back.`
        : armed
          ? `The FerryLock contract on ${coin().name} enforces both ways back and their deadlines. A watchtower will call them on time even if your Ferry node goes offline.`
          : `The FerryLock contract on ${coin().name} enforces both ways back and their deadlines. Keep your Ferry node running until the swap is done.`
      : phase === "unwinding"
        ? "The swap didn't finish in time, so it was called off. The ways back were signed before anything was locked."
        : armed
          ? "Both ways back were signed before anything was locked. A watchtower holds them too, so the deadlines are met even if your Ferry node goes offline."
          : "Both ways back were signed before anything was locked. Keep your Ferry node running until the swap is done.";
  const txs = transactions(swap);

  return (
    <div className="space-y-7 text-sm">
      <Group title="Swap">
        <Row label="Swap ID" value={<CopyText value={swap.id} head={10} tail={8} />} />
        <Row label="Direction" value={swap.role === "Z" ? `ZEC → ${coin().ticker}` : `${coin().ticker} → ZEC`} />
        <Row label="Started" value={swap.timeline[0] ? new Date(swap.timeline[0].at).toLocaleString() : "–"} />
        <Row label={swap.role === "Z" ? "You send" : "You pay"} value={swap.role === "Z" ? a.zec : a.coin} />
        <Row label="You receive" value={swap.role === "Z" ? a.coin : a.zec} />
        <Row label="Rate" value={rate ? `1 ZEC = ${btcText(rate)} ${coin().ticker}` : "–"} />
        <Row
          label="Network fee"
          value={
            evm
              ? "Gas only, paid in ETH"
              : swap.role === "B"
                ? `Your wallet's usual fee for the ${coin().ticker} lock`
                : status?.offer.fee_sat != null
                  ? `${status.offer.fee_sat.toLocaleString("en-US")} ${coin().unit}, taken from what you receive`
                  : "–"
          }
        />
        <Row label="Counterparty" value={<span className="font-mono text-xs break-all">{swap.counterparty}</span>} />
        <Row label="Networks" value={`${chain} ${status?.chains.btc.network ?? ""} · Zcash ${status?.chains.zec.network ?? ""}`} />
      </Group>

      <Group title="Deadlines and protection">
        <p className="text-slate-600">{protection}</p>
        <Row label={`${coin().asset} locked at`} value={d.btc_lock_height != null ? `block ${d.btc_lock_height}` : "not yet"} />
        <Row
          label="Called off at the latest"
          value={d.t1_unix != null ? new Date(d.t1_unix * 1000).toLocaleString() : d.btc_lock_height != null ? `block ${d.btc_lock_height + d.t1_blocks}` : `${d.t1_blocks} blocks after the lock (t1)`}
        />
        <Row
          label="Final deadline"
          value={d.t2_unix != null ? new Date(d.t2_unix * 1000).toLocaleString() : d.btc_lock_height != null ? `block ${d.btc_lock_height + d.t1_blocks + d.t2_blocks}` : `${d.t2_blocks} blocks after the call-off (t2)`}
        />
        <TowerRow swap={swap} />
      </Group>

      <Group title="Every step">
        <ol className="space-y-1.5">
          {stepsOf(swap).map((s, i) => (
            <li key={i} className="flex items-baseline justify-between gap-3">
              <span className={s.status === "pending" ? "text-slate-500" : "text-slate-900"}>
                {i + 1}. {s.title}
              </span>
              <span className="shrink-0 text-xs text-slate-500 tabular-nums">{s.status === "done" ? (s.at ? clockSeconds(s.at) : "done") : s.status === "active" ? "now" : ""}</span>
            </li>
          ))}
        </ol>
      </Group>

      <Group title="Transactions">
        {txs.length ? (
          <ul className="divide-y divide-slate-100">
            {txs.map((t) => (
              <li key={t.txid} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
                <span className="text-slate-900">
                  {t.label} <span className="text-slate-500">· {t.chain === "zec" ? "Zcash" : coin().name}</span>
                </span>
                <span className="flex items-center gap-3">
                  <CopyText value={t.txid} head={8} tail={6} />
                  <span className="text-xs text-slate-500 tabular-nums">{t.height != null ? `block ${t.height}` : "pending"}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-slate-500">Nothing on either chain yet.</p>
        )}
      </Group>

      <ChainsSee swap={swap} />

      <Link to="/inspect" className="inline-flex items-center gap-1.5 rounded font-medium text-accent-700 underline-offset-4 hover:underline">
        Open the developer view
        <ArrowRight size={13} weight="bold" aria-hidden />
      </Link>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h3 className="text-xs font-medium tracking-wider text-slate-500 uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="shrink-0 text-slate-500">{label}</span>
      <span className="min-w-0 text-right text-slate-900 tabular-nums">{value}</span>
    </div>
  );
}

// Whether a watchtower meets the deadlines if this Ferry node goes offline (ferryd --watchtower)
function TowerRow({ swap }: { swap: SwapView }) {
  const t = swap.watchtower;
  if (!t) return <Row label="Watchtower" value="None" />;
  const icon = t.status === "armed" ? <ShieldCheck size={14} weight="fill" className="text-emerald-600" aria-hidden /> : t.status === "refused" ? <ShieldSlash size={14} weight="fill" className="text-slate-500" aria-hidden /> : null;
  const label = t.status === "armed" ? "Watchtower armed" : t.status === "refused" ? "No watchtower" : "Arming the watchtower";
  return (
    <div className="space-y-1">
      <Row label="Watchtower" value={<span className="inline-flex items-center gap-1.5">{icon}{label}</span>} />
      {t.note ? <p className="text-xs text-slate-500">{t.note}</p> : null}
    </div>
  );
}

// What a public observer of each chain can learn, from the daemon's observer lines
function ChainsSee({ swap }: { swap: SwapView }) {
  const split = (l: string): [string | null, string] => {
    const i = l.indexOf(": ");
    return i > 0 && i < 24 ? [l.slice(0, i), l.slice(i + 2)] : [null, l];
  };
  const evm = coin().kind === "evm";
  return (
    <Group title="What each chain sees">
      <div className="grid gap-3">
        <div className="rounded-2xl border border-slate-200 p-4">
          <div className="flex items-center justify-between">
            <span className="font-medium text-slate-900">Zcash</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
              <Lock size={10} weight="fill" aria-hidden />
              Encrypted
            </span>
          </div>
          {swap.observer.zec.length ? (
            swap.observer.zec.map((l, i) => {
              const [n, rest] = split(l);
              return (
                <div key={i} className="mt-3">
                  {n ? <p className="text-xs font-medium text-slate-900">{n}</p> : null}
                  <p className="mt-0.5 text-slate-600">{rest}</p>
                  <p className="mt-1 font-mono text-xs break-all text-slate-400" aria-hidden>
                    <ScrambleText text="value 00000000 sender 0000000000 receiver 000000000" mode="live" speed={140} />
                  </p>
                </div>
              );
            })
          ) : (
            <p className="mt-2 text-slate-500">Nothing yet.</p>
          )}
        </div>
        <div className="rounded-2xl border border-slate-200 p-4">
          <div className="flex items-center justify-between">
            <span className="font-medium text-slate-900">{coin().name}</span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">Public</span>
          </div>
          {swap.observer.btc.length ? (
            swap.observer.btc.map((l, i) => {
              const [n, rest] = split(l);
              return (
                <div key={i} className="mt-3">
                  {n ? <p className="text-xs font-medium text-slate-900">{n}</p> : null}
                  <p className="mt-0.5 text-slate-600">{rest}</p>
                </div>
              );
            })
          ) : (
            <p className="mt-2 text-slate-500">Nothing yet.</p>
          )}
        </div>
        <div className="rounded-2xl bg-slate-50 p-4">
          <p className="font-medium text-slate-900">Can the two be linked?</p>
          <p className="mt-1 text-slate-600">
            No. The ZEC amount is encrypted, the shielded address was made for this swap and never published, and{" "}
            {evm
              ? `the ${coin().name} side shows one key share only once a claim or refund publishes it, which opens nothing on its own and points to no note.`
              : `the ${coin().name} side carries none of your Zcash keys.`}
          </p>
        </div>
      </div>
    </Group>
  );
}

