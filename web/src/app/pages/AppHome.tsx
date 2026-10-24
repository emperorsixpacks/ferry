import { useEffect, useState, type ReactNode } from "react";
import { ArrowDown, ArrowsLeftRight, ShieldCheck } from "@phosphor-icons/react";
import { startSwap, type Status, type SwapView } from "@/api";
import { zec } from "@/format";
import { Link, navigate } from "@/router";
import { btcFor, btcText } from "@/swap/shared";
import { phaseOf } from "@/swap/steps";
import { confirmationsLabel, roughDuration, typicalSeconds, type BlockTimes } from "@/swap/timing";
import { Detail, Label, Layout, PageHeader } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { StatusBadge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { useLocal } from "../lib/daemon";
import { STATUS, amounts, direction, summary } from "../lib/swaps";

// /app: the swap form and this party's swaps, laid out like SealPad's sale list.
export function AppHome() {
  const d = useLocal();
  const live = d.list.find((s) => !s.outcome);
  return (
    <Layout>
      <div className="space-y-8">
        <PageHeader
          eyebrow="Shielded atomic swaps"
          title={d.role === "Z" ? "Swap ZEC for BTC" : "Buy ZEC with BTC"}
          subtitle="No bridge. No custodian. Your ZEC never leaves the shielded pool."
          aside={
            live ? (
              <Link to={`/app/swap/${live.id}`} className="inline-flex items-center gap-2 rounded bg-slate-900 px-5 py-2.5 font-medium text-white transition-colors hover:bg-slate-800">
                <ArrowsLeftRight size={16} weight="bold" />
                Open swap in progress
              </Link>
            ) : null
          }
        />
        <SwapForm status={d.status} bt={d.bt} busySwap={live} />
        <div className="space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-xl font-semibold tracking-tight text-slate-900">My swaps</h2>
            <Label>{d.list.length} total</Label>
          </div>
          {d.list.length === 0 ? (
            <Card>
              <CardContent className="py-16 text-center text-slate-500">
                <ShieldCheck size={28} weight="duotone" className="mx-auto mb-3 text-brand-500" />
                <p>No swaps yet. Your first one shows up here.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4">
              {d.list.map((s) => (
                <SwapRow key={s.id} swap={s} status={d.status} />
              ))}
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}

function SwapForm({ status, bt, busySwap }: { status: Status | null; bt: BlockTimes; busySwap?: SwapView }) {
  const { role } = useLocal();
  const [amount, setAmount] = useState("1.00");
  const [touched, setTouched] = useState(false);
  // a host can cap swaps below the default amount (the public demo does): start at the cap
  useEffect(() => {
    const max = status?.offer.max_zat;
    if (!touched && max != null && max < 1e8) setAmount(zec(max));
  }, [status?.offer.max_zat, touched]);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const offer = status?.offer;
  const zat = Math.round(Number(amount) * 1e8);
  const valid = amount.trim() !== "" && Number.isFinite(zat) && zat > 0;
  const gross = offer && valid ? Math.round((zat / 1e8) * offer.rate_sat_per_zec) : 0;
  const btcSide = btcText(btcFor(role, gross, status));

  let problem: string | null = null;
  if (amount.trim() === "") problem = "Enter how much ZEC.";
  else if (!valid) problem = "Enter an amount, like 1.00.";
  else if (offer) {
    if (zat < offer.min_zat) problem = `The smallest swap is ${zec(offer.min_zat)} ZEC.`;
    else if (zat > offer.max_zat) problem = `The largest swap is ${zec(offer.max_zat)} ZEC.`;
    else if (role === "Z" && status && zat > status.balances.zec_shielded_zat) problem = `You have ${zec(status.balances.zec_shielded_zat)} shielded ZEC.`;
    else if (role === "B" && status && gross > status.balances.btc_sat) problem = `You have ${btcText(status.balances.btc_sat)} BTC.`;
  }
  const blocked = busySwap ? "Finish the swap in progress first." : null;

  const submit = async () => {
    if (problem || blocked || busy) return;
    setBusy(true);
    setFail(null);
    try {
      const { id } = await startSwap(zat, role);
      navigate(`/app/swap/${id}`);
    } catch (e) {
      setFail((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const zecField = (
    <Field label={role === "Z" ? "You send" : "You receive"} unit="ZEC" note={role === "Z" ? "From your shielded balance" : "Into your shielded wallet"}>
      <input
        inputMode="decimal"
        autoComplete="off"
        value={amount}
        onChange={(e) => {
          setTouched(true);
          setAmount(e.target.value);
        }}
        aria-invalid={!!problem}
        className="w-full bg-transparent font-mono text-2xl font-medium text-slate-900 outline-none"
      />
    </Field>
  );
  const btcField = (
    <Field label={role === "Z" ? "You receive" : "You pay"} unit="BTC" note="In the open, like any Bitcoin payment" readOnly>
      <span className="font-mono text-2xl font-medium text-slate-900">≈ {valid && offer ? btcSide : "–"}</span>
    </Field>
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="inline-flex items-center gap-2 text-base font-semibold text-slate-900">
          New swap <span className="font-mono text-xs text-slate-500">{direction(role)}</span>
        </CardTitle>
        <StatusBadge variant="outline" className="border-brand-200 bg-brand-50/40 text-brand-700">
          {status?.chains.btc.network ?? "regtest"}
        </StatusBadge>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="grid items-center gap-3 md:grid-cols-[1fr_auto_1fr]">
            {zecField}
            <ArrowDown size={18} weight="bold" className="mx-auto -rotate-90 text-slate-400 max-md:rotate-0" />
            {btcField}
          </div>
          <div className="grid grid-cols-2 gap-4 border-t border-slate-100 pt-4 text-sm md:grid-cols-4">
            <Detail label="Rate" value={<span className="font-mono">{offer ? `1 ZEC = ${btcText(offer.rate_sat_per_zec)} BTC` : "–"}</span>} />
            <Detail label="Network fee" value={<span className="font-mono">{offer?.fee_sat != null ? `${offer.fee_sat.toLocaleString("en-US")} sat` : "–"}</span>} />
            <Detail
              label="Takes"
              value={
                status ? (
                  <>
                    Typically {roughDuration(typicalSeconds(status, bt))}
                    <span className="mt-0.5 block font-mono text-[11px] font-normal text-slate-500">{confirmationsLabel(status)}</span>
                  </>
                ) : (
                  "–"
                )
              }
            />
            <Detail label="If it fails" value="Your coins come back" />
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <Button type="submit" size="lg" disabled={!status || !!problem || !!blocked || busy}>
              {busy ? "Starting…" : "Swap"}
            </Button>
            {problem || fail || blocked ? (
              <p className="rounded-md border border-rose-100 bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
                {problem ?? fail ?? blocked}
              </p>
            ) : (
              <p className="font-mono text-xs text-slate-500">You never trust the other side. Nobody holds your coins in between.</p>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function Field({ label, unit, note, readOnly, children }: { label: string; unit: string; note: string; readOnly?: boolean; children: ReactNode }) {
  return (
    <label className="block">
      <Label>{label}</Label>
      <span className={`mt-2 flex h-14 items-center gap-3 border px-4 ${readOnly ? "border-dashed border-slate-300 bg-slate-50" : "border-slate-200 bg-white focus-within:border-brand-500 focus-within:ring-3 focus-within:ring-brand-500/20"}`}>
        <span className="min-w-0 flex-1">{children}</span>
        <span className="font-mono text-xs tracking-widest text-slate-500">{unit}</span>
      </span>
      <span className="mt-1.5 block text-xs text-slate-500">{note}</span>
    </label>
  );
}

function SwapRow({ swap, status }: { swap: SwapView; status: Status | null }) {
  const phase = phaseOf(swap);
  const st = STATUS[phase];
  const a = amounts(swap, status);
  const started = swap.timeline[0]?.at;
  const settled = phase === "done" || phase === "settled";
  return (
    <Link to={`/app/swap/${swap.id}`} className="group block">
      <Card className="transition-all hover:shadow-sm hover:ring-brand-300">
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="inline-flex items-center gap-2 text-base font-semibold text-slate-900">
            <span>Swap</span>
            <span className="font-mono text-xs text-slate-500">{`${swap.id.slice(0, 6)}...${swap.id.slice(-4)}`}</span>
          </CardTitle>
          <StatusBadge variant={st.tone}>{st.label}</StatusBadge>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
            <Detail label="Type" value={direction(swap.role)} />
            <Detail label={swap.role === "Z" ? "You send" : "You pay"} value={<span className="font-mono">{swap.role === "Z" ? a.zec : a.btc}</span>} />
            <Detail label={swap.role === "Z" ? "You receive" : "You receive"} value={<span className="font-mono">{swap.role === "Z" ? a.btc : a.zec}</span>} />
            <Detail label="Started" value={<span className="font-mono">{started ? new Date(started).toLocaleString() : "–"}</span>} />
          </div>
          <p className={`mt-3 ${settled ? "text-sm font-medium text-brand-600" : "font-mono text-xs text-slate-500"}`}>{summary(swap, status)}</p>
        </CardContent>
      </Card>
    </Link>
  );
}
