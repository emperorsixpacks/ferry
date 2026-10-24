import type { ReactNode } from "react";
import { ArrowCounterClockwise, Check, CheckCircle, Clock, Lock, Warning } from "@phosphor-icons/react";
import type { Status, SwapView } from "@/api";
import { Link } from "@/router";
import { btcText } from "@/swap/shared";
import { phaseOf, stepsOf, transactions } from "@/swap/steps";
import { clock, clockSeconds, unwoundBy } from "@/swap/timing";
import { CopyText } from "../components/CopyText";
import { Detail, Label, Layout } from "../components/Layout";
import { ScrambleText } from "../components/ScrambleText";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { StatusBadge } from "../components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { useLocal } from "../lib/daemon";
import { STATUS, amounts, direction } from "../lib/swaps";

// /app/swap/:id, laid out like SealPad's SaleDetail: header, banner, progress, details,
// transactions, and what each chain sees.
export function SwapDetail({ id }: { id: string }) {
  const d = useLocal();
  const swap = d.swaps[id];
  return <Layout>{swap ? <Body swap={swap} status={d.status} /> : <p className="text-slate-500">{d.connected ? "Loading swap…" : "Waiting for your daemon…"}</p>}</Layout>;
}

function Body({ swap, status }: { swap: SwapView; status: Status | null }) {
  const { bt } = useLocal();
  const phase = phaseOf(swap);
  const st = STATUS[phase];
  const a = amounts(swap, status);
  const mine = swap.role === "Z" ? "ZEC" : "BTC";
  const by = unwoundBy(status, swap, bt);
  const live = phase === "progress" || phase === "unwinding";
  const d = swap.deadlines;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="mb-1 font-mono text-xs tracking-widest text-brand-600 uppercase">Shielded swap</p>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900">Swap</h1>
          <CopyText value={swap.id} truncate={false} className="mt-1" />
        </div>
        <StatusBadge variant={st.tone}>{st.label}</StatusBadge>
      </div>

      {live ? (
        <Banner tone={phase === "unwinding" ? "warn" : "info"} icon={<Clock size={22} weight="duotone" className="mt-0.5 shrink-0 text-brand-500" />}>
          <p className="text-sm font-semibold text-slate-900">
            {phase === "unwinding" ? `Nothing is lost. Your ${mine} should be back by about ${by ? clock(by) : "–"}.` : `If anything goes wrong, your ${mine} comes back to you automatically by about ${by ? clock(by) : "–"}.`}
          </p>
          <p className="mt-1 font-mono text-xs text-slate-600">
            {phase === "unwinding"
              ? "The swap didn't finish in time, so it was called off. The ways back were signed before anything was locked."
              : "Both ways back were signed before anything was locked. Keep this daemon running until the swap is done."}
          </p>
        </Banner>
      ) : (
        <Outcome swap={swap} status={status} />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Progress</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {stepsOf(swap).map((s, i) => (
            <div
              key={i}
              className={`flex items-start gap-4 rounded border p-3 text-sm ${s.status === "active" ? "border-brand-300 bg-brand-50/40" : "border-slate-200"}`}
            >
              <span className={`shrink-0 pt-0.5 font-mono text-xs tracking-widest ${s.status === "pending" ? "text-slate-400" : "text-brand-600"}`}>{String(i + 1).padStart(2, "0")}</span>
              <div className="min-w-0 flex-1">
                <p className={`font-semibold ${s.status === "pending" ? "text-slate-400" : "text-slate-900"}`}>{s.title}</p>
                {s.status === "active" && s.note ? <p className="mt-0.5 text-slate-600">{s.note}</p> : null}
              </div>
              <span className="shrink-0 pt-0.5">
                {s.status === "done" ? (
                  <span className="inline-flex items-center gap-1.5 font-mono text-xs text-slate-500">
                    {s.at ? clockSeconds(s.at) : ""}
                    <Check size={14} weight="bold" className="text-brand-500" />
                  </span>
                ) : s.status === "active" ? (
                  <span className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-widest text-brand-700 uppercase">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
                    In progress
                  </span>
                ) : null}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Detail label="Type" value={direction(swap.role)} />
            <Detail label="Started" value={swap.timeline[0] ? new Date(swap.timeline[0].at).toLocaleString() : "–"} />
            <Detail label={swap.role === "Z" ? "You send" : "You pay"} value={<span className="font-mono">{swap.role === "Z" ? a.zec : a.btc}</span>} />
            <Detail label="You receive" value={<span className="font-mono">{swap.role === "Z" ? a.btc : a.zec}</span>} />
            <Detail label="Network fee" value={<span className="font-mono">{status?.offer.fee_sat != null ? `${status.offer.fee_sat.toLocaleString("en-US")} sat` : "–"}</span>} />
            <Detail label="Rate" value={<span className="font-mono">{status ? `1 ZEC = ${btcText(status.offer.rate_sat_per_zec)} BTC` : "–"}</span>} />
            <Detail label="Bitcoin locked at" value={<span className="font-mono">{d.btc_lock_height != null ? `block ${d.btc_lock_height}` : "not yet"}</span>} />
            <Detail
              label="Called off at the latest"
              value={<span className="font-mono">{d.btc_lock_height != null ? `block ${d.btc_lock_height + d.t1_blocks}` : `${d.t1_blocks} blocks after the lock`}</span>}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Transactions</CardTitle>
        </CardHeader>
        <CardContent>
          {transactions(swap).length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Chain</TableHead>
                  <TableHead>What</TableHead>
                  <TableHead>Transaction</TableHead>
                  <TableHead className="text-right">Block</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {transactions(swap).map((t) => (
                  <TableRow key={t.txid}>
                    <TableCell>
                      <StatusBadge variant={t.chain === "zec" ? "default" : "secondary"} className={t.chain === "zec" ? "bg-slate-900" : ""}>
                        {t.chain === "zec" ? "Zcash" : "Bitcoin"}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className="font-medium">{t.label}</TableCell>
                    <TableCell>
                      <CopyText value={t.txid} head={8} tail={6} />
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">{t.height != null ? t.height : <span className="text-brand-700">pending</span>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="font-mono text-xs text-slate-500">Nothing on either chain yet.</p>
          )}
        </CardContent>
      </Card>

      <ChainsSee swap={swap} />
    </div>
  );
}

function Banner({ tone, icon, children }: { tone: "info" | "warn"; icon: ReactNode; children: ReactNode }) {
  return (
    <div className={`flex items-start gap-3 border px-5 py-4 ${tone === "warn" ? "border-slate-300 bg-slate-100" : "border-brand-200 bg-brand-50"}`}>
      {icon}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// The finished swap, like SealPad's centred result cards
function Outcome({ swap, status }: { swap: SwapView; status: Status | null }) {
  const phase = phaseOf(swap);
  const a = amounts(swap, status);
  const z = swap.role === "Z";
  const lockedMine = swap.timeline.some((e) => e.kind === (z ? "zec_lock_broadcast" : "btc_lock_broadcast"));
  const copy = {
    done: { icon: <CheckCircle size={28} weight="duotone" className="mx-auto text-brand-500" />, title: z ? `You received ${a.btc}` : `You received ${a.zec}`, note: z ? `${a.zec} left your shielded wallet.` : `It's in your shielded wallet. You paid ${a.btc}.` },
    settled: {
      icon: <CheckCircle size={28} weight="duotone" className="mx-auto text-brand-500" />,
      title: `You received ${a.btc}`,
      note: `The other side stopped responding, so after the deadline the Bitcoin was released to you. Your ${a.zec} stays locked: you were paid for it.`,
    },
    refunded: {
      icon: <ArrowCounterClockwise size={28} weight="duotone" className="mx-auto text-slate-500" />,
      title: lockedMine ? `Your ${z ? a.zec : a.btc} is back in your wallet` : "Nothing left your wallet",
      note: "The swap didn't complete, so it was undone. Nothing changed hands.",
    },
    lost: {
      icon: <Warning size={28} weight="duotone" className="mx-auto text-rose-600" />,
      title: "The swap didn't complete in time",
      note: `Your daemon was offline past the deadline, so the ${a.btc} went to the other side.`,
    },
  }[phase as "done" | "settled" | "refunded" | "lost"];
  return (
    <Card>
      <CardContent className="space-y-4 py-6 text-center">
        {copy.icon}
        <p className="text-lg font-semibold text-slate-900">{copy.title}</p>
        <p className="mx-auto max-w-md text-xs text-slate-500">{copy.note}</p>
        <Link to="/app" className="inline-block rounded bg-brand-500 px-8 py-3 font-semibold text-white transition-colors hover:bg-brand-600">
          {phase === "done" || phase === "settled" ? "Swap again" : "Start a new swap"}
        </Link>
      </CardContent>
    </Card>
  );
}

// What a public observer of each chain can learn, from the daemon's observer lines
function ChainsSee({ swap }: { swap: SwapView }) {
  const split = (l: string): [string | null, string] => {
    const i = l.indexOf(": ");
    return i > 0 && i < 24 ? [l.slice(0, i), l.slice(i + 2)] : [null, l];
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>What each chain sees</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Zcash</Label>
            <StatusBadge variant="outline" className="border-brand-200 bg-brand-50/40 text-brand-700">
              <Lock size={10} weight="fill" />
              <ScrambleText text="ENCRYPTED" mode="live" speed={180} />
            </StatusBadge>
          </div>
          {swap.observer.zec.length ? (
            swap.observer.zec.map((l, i) => {
              const [n, rest] = split(l);
              return (
                <div key={i} className="rounded border border-slate-200 p-3 text-sm">
                  {n ? <p className="font-mono text-xs text-slate-900">{n}</p> : null}
                  <p className="mt-1 text-slate-600">{rest}</p>
                  <p className="mt-2 font-mono text-xs break-all text-brand-600">
                    <ScrambleText text="value 00000000 sender 0000000000 receiver 000000000" mode="live" speed={140} />
                  </p>
                </div>
              );
            })
          ) : (
            <p className="font-mono text-xs text-slate-500">Nothing yet.</p>
          )}
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Bitcoin</Label>
            <StatusBadge variant="secondary">Public</StatusBadge>
          </div>
          {swap.observer.btc.length ? (
            swap.observer.btc.map((l, i) => {
              const [n, rest] = split(l);
              return (
                <div key={i} className={`rounded border p-3 text-sm ${/key-path/.test(l) ? "border-brand-300 bg-brand-50/40" : "border-slate-200"}`}>
                  {n ? <p className="font-mono text-xs text-slate-900">{n}</p> : null}
                  <p className="mt-1 text-slate-600">{rest}</p>
                </div>
              );
            })
          ) : (
            <p className="font-mono text-xs text-slate-500">Nothing yet.</p>
          )}
        </div>
        <div className="rounded border border-slate-200 bg-slate-50 p-4 text-sm md:col-span-2">
          <Label>Can the two be linked?</Label>
          <p className="mt-2 text-slate-700">No. The ZEC amount is encrypted, the shielded address was made for this swap and never published, and the Bitcoin side carries none of your Zcash keys.</p>
        </div>
      </CardContent>
    </Card>
  );
}
