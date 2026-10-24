import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, CircleNotch, SealCheck } from "@phosphor-icons/react";
import { continueRoute, retryCombo, type ComboJob, type NearPart } from "@/api";
import { Link } from "@/router";
import { clock, clockSeconds } from "@/swap/timing";
import { CopyText } from "../components/CopyText";
import { Layout } from "../components/Layout";
import { NearMark, NearTokenLogo, PairLogo, TokenLogo } from "../components/Logos";
import { StatusIcon, Tracker, type TrackerStep } from "../components/Progress";
import { ToneBadge } from "../components/ui/badge";
import { Fold } from "../components/ui/fold";
import { aboutTime, chainName, comboGot, comboIn, comboMidIn, comboMidOut, comboOut, comboWord, isActive, nearText, useNear } from "../lib/near";
import type { Tone } from "../lib/progress";
import { PAUSE, inAbout, legNote, unitsText, useRoutes, zecText } from "../lib/routes";

// /app/combo/:id: a private swap with NEAR Intents at an end, as one calm card. A status word, a
// headline, its parts in order (your deposit and NEAR Intents' part, the two Ferry swaps with the
// private pause between them, NEAR Intents' last part), the current one explained, and what to
// expect. One waiting for its deposit shows where to send it; one holding coins offers to go on.

export function ComboDetail({ id }: { id: string }) {
  const near = useNear();
  const j = near.combo(id);
  return (
    <Layout>
      <div className="mx-auto w-full max-w-[480px]">
        <Link to="/app/activity" className="mb-4 inline-flex items-center gap-1.5 rounded text-sm text-slate-500 transition-colors hover:text-slate-900">
          <ArrowLeft size={14} weight="bold" aria-hidden />
          Activity
        </Link>
        {j ? (
          <Body j={j} />
        ) : (
          <div className="rounded-3xl border border-slate-200 bg-white px-6 py-14 text-center">
            {near.info === undefined || near.info?.compose?.runs ? <CircleNotch size={28} weight="bold" className="mx-auto animate-spin text-slate-400 motion-reduce:animate-none" aria-hidden /> : null}
            <p className="mt-4 text-slate-600">{near.info === undefined || near.info?.compose?.runs ? "Loading your swap…" : "Private swaps with NEAR Intents don't run on this server."}</p>
          </div>
        )}
      </div>
    </Layout>
  );
}

function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

const short = (s: string) => (s.length > 16 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s);
function left(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function Body({ j }: { j: ComboJob }) {
  const near = useNear();
  const routes = useRoutes();
  const route = j.route.id ? routes.byId[j.route.id] : undefined;
  const rstate = route?.state ?? j.route.state;
  const now = useNow(j.state === "deposit" || rstate === "pausing");
  const [acting, setActing] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const word = comboWord(j);
  const a = comboIn(j);
  const c = comboOut(j);
  const midIn = comboMidIn(j);
  const midOut = comboMidOut(j);
  const front = !!j.front;
  const back = !!j.back || j.kind !== "near-route";
  const zec = zecText(route?.amounts.zec_zat ?? j.route.zec_zat ?? j.agreed.zec_zat);
  const got = comboGot(j);

  const act = async (f: () => Promise<void>) => {
    setActing(true);
    setFail(null);
    try {
      await f();
    } catch (e) {
      setFail((e as Error).message.replace(/\broute\b/gi, "private swap"));
    } finally {
      setActing(false);
    }
  };
  const finish = () => act(async () => routes.put(await continueRoute(j.route.id!)));
  const retry = () => act(async () => near.putCombo(await retryCombo(j.id)));

  let head: { tone: Tone; title: string; sub: ReactNode };
  if (j.state === "deposit" && j.front && j.asset_in) head = { tone: "live", title: `Send ${nearText(j.front.amount_in, j.asset_in)}`, sub: `To NEAR Intents' deposit address on ${chainName(j.asset_in.blockchain)}. Once it arrives, the rest happens on its own.` };
  else if (j.state === "near_in") head = { tone: "live", title: `Swapping your ${a}`, sub: `NEAR Intents got your deposit and is sending ${midIn} to your Ferry node.` };
  else if (j.state === "funding") head = { tone: "live", title: `Swapping ${a} for ${c} privately`, sub: `Your ${midIn} arrived in your Ferry node. Starting the private swap.${j.problem ? ` ${j.problem}` : ""}` };
  else if (j.state === "route")
    head = {
      tone: "live",
      title: `Swapping ${a} for ${c} privately`,
      sub: rstate === "leg1" ? `Swap 1 of 2 is buying shielded ZEC with your ${midIn}.` : rstate === "leg2" ? `Swap 2 of 2 is selling your ZEC for ${midOut}${back ? ", paid straight to NEAR Intents" : ""}.` : "Swap 1 is done. Your ZEC is resting in your shielded wallet.",
    };
  else if (j.state === "holding" && j.route.id) head = { tone: "warn", title: `You hold ${zecText(route?.zec.held_zat ?? j.route.held_zat ?? 0)}`, sub: "The second swap couldn't run at your price. Your ZEC is safe in your shielded wallet. Nothing is lost." };
  else if (j.state === "holding") head = { tone: "warn", title: `Your ${midIn} is in your Ferry node`, sub: `${j.problem ? `${j.problem.replace(/\.$/, "")}. ` : ""}Nothing is lost: go on at today's price, or keep the ${midIn}.` };
  else if (j.state === "near_out") head = { tone: "live", title: `Sending your ${c}`, sub: `The private swap is done. NEAR Intents is swapping the ${midOut} for ${c}.` };
  else if (j.state === "done") head = { tone: "good", title: `You received ${got ?? c}`, sub: `Your ${a} went through shielded ZEC. No transaction links the two Ferry swaps.` };
  else if (j.state === "refunded")
    head = j.back && (j.back.status === "REFUNDED" || j.back.status === "FAILED") ? { tone: "neutral", title: `Your ${midOut} is back`, sub: `NEAR Intents couldn't fill the last part, so it refunded the ${midOut} to your Ferry node.` } : { tone: "neutral", title: `Your ${a} is on its way back`, sub: `NEAR Intents couldn't fill its part, so it refunds your ${a}${j.refund_address ? ` to ${short(j.refund_address)}` : ""}.` };
  else if (j.state === "expired") head = { tone: "neutral", title: "Nothing moved", sub: "No deposit arrived before the deadline. If you sent one late, NEAR Intents refunds it to your refund address." };
  else head = { tone: j.outcome === "punished" ? "bad" : "neutral", title: j.outcome === "punished" ? "The swap didn't complete" : j.outcome === "route_refunded" ? `Your ${midIn} is back` : "Nothing moved", sub: j.outcome === "punished" ? "Your Ferry node was offline past the deadline." : j.outcome === "route_refunded" ? "The first swap didn't finish in time, so it was undone. Nothing went on." : `The private swap didn't start. Your ${midIn} stays in your Ferry node.` };

  const at = (kind: string) => j.timeline.find((e) => e.kind === kind)?.at;
  const order = ["deposit", "near_in", "funding", "route", "near_out", "done"];
  const reached = (s: string) => order.indexOf(j.state === "holding" ? (j.route.id ? "route" : "funding") : j.state) >= order.indexOf(s) || j.state === "done";
  const routeDone = rstate === "done" || j.state === "near_out" || j.state === "done";
  const steps: TrackerStep[] = [];
  if (front && j.front && j.asset_in) {
    steps.push({ title: `You send ${nearText(j.front.amount_in, j.asset_in)}`, status: j.state === "deposit" ? "active" : reached("near_in") || j.state === "refunded" ? "done" : "pending", at: at("near_known_deposit_tx") ?? at("near_processing"), note: `Before ${clock(new Date(j.front.deadline))}.`, extra: <Deposit part={j.front} asset={j.asset_in} refund={j.refund_address} now={now} /> });
    steps.push({ title: `NEAR Intents: ${a} → ${midIn}`, status: j.state === "near_in" ? "active" : reached("funding") ? "done" : "pending", at: at("near_success"), note: `NEAR Intents delivers ${midIn} to your Ferry node.` });
  }
  const inRoute = j.state === "route" || (j.state === "holding" && !!j.route.id) || j.state === "funding";
  steps.push({ title: `Swap 1: ${midIn} → shielded ZEC`, status: inRoute && (rstate === "leg1" || j.state === "funding" || !rstate) ? "active" : reached("route") && rstate && rstate !== "leg1" ? "done" : routeDone ? "done" : "pending", at: route?.timeline.find((e) => e.kind === "leg1_swapped")?.at, note: j.state === "funding" ? (j.problem ?? "Starting the swap with your partner.") : route ? legNote(route.legs[0]) : "Buying shielded ZEC." });
  steps.push({
    title: "Private pause",
    status: inRoute && (rstate === "settling" || rstate === "pausing") ? "active" : routeDone || rstate === "leg2" || (j.state === "holding" && !!j.route.id) ? "done" : "pending",
    note: rstate === "settling" ? "Your ZEC is settling in your shielded wallet." : route ? `A random wait, so the two swaps are harder to link. Swap 2 starts ${inAbout(route, now)}.` : "A random wait, so the two swaps are harder to link.",
  });
  steps.push({ title: `Swap 2: ZEC → ${midOut}`, status: (j.state === "route" && rstate === "leg2") || (j.state === "holding" && !!j.route.id) ? "active" : routeDone ? "done" : "pending", at: route?.timeline.find((e) => e.kind === "done")?.at, note: j.state === "holding" ? "Waiting for you: finish now, or keep the ZEC." : route ? legNote(route.legs[1]) : "Selling the ZEC." });
  // the last NEAR Intents part's own success, after the first one's
  const lastSuccess = [...j.timeline].reverse().find((e) => e.kind === "near_success")?.at;
  if (back) steps.push({ title: `NEAR Intents: ${midOut} → ${c}`, status: j.state === "near_out" ? "active" : j.state === "done" || (j.state === "refunded" && !!j.back && j.back.status !== "PENDING_DEPOSIT") ? "done" : "pending", at: lastSuccess, note: j.address ? `NEAR Intents delivers ${c} to ${short(j.address)}.` : "" });

  const pause = j.pause && PAUSE[j.pause] ? PAUSE[j.pause].total : PAUSE.standard.total;
  return (
    <>
      <div className="rounded-3xl border border-slate-200 bg-white px-5 py-7 shadow-[0_1px_2px_rgba(24,24,27,0.04)] sm:px-8 sm:py-8">
        <div className="flex flex-col items-center text-center">
          <StatusIcon tone={head.tone} holding={j.state === "holding"} />
          <ToneBadge tone={word.tone} className="mt-5">
            {word.label}
          </ToneBadge>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-balance text-slate-900 tabular-nums sm:text-[28px]">{head.title}</h1>
          {head.sub ? <p className="mt-2 max-w-sm text-[15px] text-balance text-slate-600">{head.sub}</p> : null}
        </div>

        <Strip j={j} zec={zec} />

        {j.state !== "expired" ? <Tracker steps={steps} /> : null}

        {isActive(j) && j.state !== "holding" ? (
          <div className="mt-6 space-y-2 border-t border-slate-100 pt-5 text-sm text-slate-600">
            <p>Private swaps usually take {pause} in all, plus NEAR Intents' part.</p>
            <p>The ZEC between the two Ferry swaps stays shielded. The NEAR Intents part is public, and you trust NEAR Intents for it.</p>
            <p className="text-slate-900">You can close this page — the server follows every part.</p>
          </div>
        ) : j.state === "holding" ? (
          <div className="mt-7 flex flex-col items-center gap-3">
            <button type="button" onClick={j.route.id ? finish : retry} disabled={acting} className="flex h-12 w-full items-center justify-center rounded-2xl bg-slate-900 text-[15px] font-semibold text-white transition-colors hover:bg-slate-800 disabled:bg-slate-100 disabled:text-slate-400">
              {acting ? "Starting…" : j.route.id ? "Finish now" : "Swap now"}
            </button>
            <p className="text-center text-sm text-balance text-slate-600">{j.route.id ? "Tries the second swap again. Or keep the ZEC: it's yours, with no deadline." : `Goes on at today's price with the ${midIn} in your Ferry node. Or keep it: it's yours.`}</p>
          </div>
        ) : (
          <div className="mt-7 flex flex-col items-center gap-3">
            <Link to="/app" className="flex h-12 w-full items-center justify-center rounded-2xl bg-slate-900 text-[15px] font-semibold text-white transition-colors hover:bg-slate-800">
              {j.state === "done" ? "Swap again" : "Start a new swap"}
            </Link>
            <Link to="/app/activity" className="rounded text-sm text-slate-600 transition-colors hover:text-slate-900">
              View all activity
            </Link>
          </div>
        )}
        {fail ? (
          <p role="alert" className="mt-3 text-center text-sm text-rose-600">
            {fail}
          </p>
        ) : null}
      </div>

      <Fold
        title={<span className="text-sm font-medium text-slate-700">Technical details</span>}
        className="mt-4 rounded-3xl border border-slate-200 bg-white"
        buttonClassName="rounded-3xl px-5 py-4 hover:bg-slate-50"
        bodyClassName="border-t border-slate-100 px-5 pt-5 pb-6"
      >
        <Technical j={j} />
      </Fold>
    </>
  );
}

// What goes in, the shielded ZEC between, what comes out.
function Strip({ j, zec }: { j: ComboJob; zec: string }) {
  const inPart = j.asset_in ? (
    <Part logo={<NearTokenLogo symbol={j.asset_in.symbol} chain={j.asset_in.blockchain} size={22} />} value={j.front ? nearText(j.front.amount_in, j.asset_in) : j.asset_in.symbol} />
  ) : (
    <Part logo={<PairLogo pair={j.from} size={22} />} value={j.route.paid != null ? unitsText(j.route.paid, j.from) : j.route.in_max != null ? unitsText(j.route.in_max, j.from) : comboIn(j)} note={j.route.paid != null ? undefined : "at most"} />
  );
  const outVal = comboGot(j);
  const outPart = j.asset_out ? (
    <Part logo={<NearTokenLogo symbol={j.asset_out.symbol} chain={j.asset_out.blockchain} size={22} />} value={outVal ?? (j.back ? nearText(j.back.min_amount_out, j.asset_out) : `${j.asset_out.symbol}`)} note={outVal ? undefined : j.back ? "at least" : undefined} />
  ) : (
    <Part logo={<PairLogo pair={j.to} size={22} />} value={outVal ?? (j.route.out_min != null ? unitsText(j.route.out_min, j.to) : comboOut(j))} note={outVal ? undefined : j.route.out_min != null ? "at least" : undefined} />
  );
  return (
    <div className="mt-6 grid grid-cols-[1fr_auto_1fr_auto_1fr] items-start gap-1 rounded-2xl bg-slate-50 px-2 py-3 text-center tabular-nums">
      {inPart}
      <ArrowRight size={14} weight="bold" className="mt-1 text-slate-400" aria-label="for" />
      <Part logo={<TokenLogo id="zec" size={22} />} value={zec} note="shielded" />
      <ArrowRight size={14} weight="bold" className="mt-1 text-slate-400" aria-label="then" />
      {outPart}
    </div>
  );
}

function Part({ logo, value, note }: { logo: ReactNode; value: string; note?: string }) {
  const [n, ticker] = value.split(" ");
  return (
    <span className="flex min-w-0 flex-col items-center gap-1">
      {logo}
      <span className="max-w-full truncate text-[13px] font-medium text-slate-900 sm:text-sm">{n}</span>
      <span className="text-xs text-slate-500">{note ? `${ticker ?? ""} · ${note}` : (ticker ?? "")}</span>
    </span>
  );
}

// Where to send the deposit: the amount, the address (and memo), and the time left.
function Deposit({ part, asset, refund, now }: { part: NearPart; asset: { symbol: string; blockchain: string; decimals: number }; refund: string | null; now: number }) {
  const ms = Date.parse(part.deadline) - now;
  return (
    <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-3.5" data-near-deposit>
      <div>
        <p className="text-xs font-medium tracking-wider text-slate-500 uppercase">Send exactly</p>
        <p className="mt-1 flex items-center gap-2 text-lg font-semibold text-slate-900 tabular-nums">
          <NearTokenLogo symbol={asset.symbol} chain={asset.blockchain} size={20} />
          {nearText(part.amount_in, asset)}
          <span className="text-sm font-normal text-slate-500">on {chainName(asset.blockchain)}</span>
        </p>
      </div>
      <div>
        <p className="text-xs font-medium tracking-wider text-slate-500 uppercase">To NEAR Intents' deposit address</p>
        <CopyText value={part.deposit_address} truncate={false} className="mt-1 text-[13px] text-slate-900" />
      </div>
      {part.deposit_memo ? (
        <div>
          <p className="text-xs font-medium tracking-wider text-rose-700 uppercase">With this memo, or it's lost</p>
          <CopyText value={part.deposit_memo} truncate={false} className="mt-1 text-[13px] text-slate-900" />
        </div>
      ) : null}
      <p className="text-[13px] text-slate-600 tabular-nums">
        {ms > 0 ? (
          <>
            <span className="font-medium text-slate-900">{left(ms)}</span> left. Send from your own wallet{refund ? `; a refund goes to ${short(refund)}` : ""}.
          </>
        ) : (
          "The deadline has passed. Don't send anything now."
        )}
      </p>
    </div>
  );
}

function Technical({ j }: { j: ComboJob }) {
  const near = useNear();
  const nearGroup = (title: string, p: NearPart, from: string, to: string) => (
    <Group title={title}>
      <Row label="Deposit address" value={<CopyText value={p.deposit_address} head={10} tail={6} />} />
      <Row label="Status" value={<span className="font-mono text-xs">{p.status}</span>} />
      <Row label="Quote" value={`${from} → ${to}`} />
      {p.time_s != null ? <Row label="Usually takes" value={aboutTime(p.time_s)} /> : null}
      <Row label="Quote deadline" value={new Date(p.deadline).toLocaleString()} />
      <Row
        label="Signed by 1Click"
        value={
          p.verified ? (
            <span className="inline-flex items-center gap-1 text-emerald-700">
              <SealCheck size={14} weight="fill" aria-hidden /> checked
            </span>
          ) : (
            "not checked"
          )
        }
      />
      {p.signature ? <Row label="Signature" value={<CopyText value={p.signature} head={14} tail={6} />} /> : null}
    </Group>
  );
  return (
    <div className="space-y-7 text-sm">
      {j.front && j.asset_in && j.via_in ? nearGroup("NEAR Intents, first", j.front, nearText(j.front.amount_in, j.asset_in), `at least ${nearText(j.front.min_amount_out, j.via_in)}`) : null}
      <Group title="Private swap">
        <Row label="Route" value={`${comboMidIn(j)} → shielded ZEC → ${comboMidOut(j)}`} />
        <Row label="ID" value={j.route.id ? <CopyText value={j.route.id} head={10} tail={6} /> : "not started"} />
        {j.route.state ? <Row label="State" value={<span className="font-mono text-xs">{j.route.state}</span>} /> : null}
        {j.route.out_min != null ? <Row label="Swap 2 pays at least" value={unitsText(j.route.out_min, j.to)} /> : null}
        {j.route.id ? (
          <Link to={`/app/route/${j.route.id}`} className="inline-flex items-center gap-1 text-[13px] font-medium text-slate-900 underline underline-offset-4 hover:no-underline">
            The private swap, step by step
            <ArrowRight size={12} weight="bold" aria-hidden />
          </Link>
        ) : null}
      </Group>
      {j.back && j.asset_out && j.via_out ? nearGroup("NEAR Intents, last", j.back, `${nearText(j.back.min_amount_in, j.via_out)} or more`, `at least ${nearText(j.back.min_amount_out, j.asset_out)}`) : null}
      <Group title="Every step">
        <ol className="space-y-1.5">
          {j.timeline.map((e, i) => (
            <li key={i} className="flex items-baseline justify-between gap-3">
              <span className="text-slate-900">{e.label}</span>
              <span className="shrink-0 text-xs text-slate-500 tabular-nums">{clockSeconds(e.at)}</span>
            </li>
          ))}
        </ol>
      </Group>
      <Group title="Who you trust for what">
        <p className="text-slate-600">
          The two Ferry swaps are atomic: a partner can't take your coins, and the ZEC between them stays shielded. Ferry never sends ZEC to NEAR Intents. NEAR Intents' part runs on its bridges and solvers, on public chains: you trust it to deliver, or to refund. 1Click signed the quotes above; keep them if you ever need to dispute a swap.
        </p>
      </Group>
      <a href={near.info?.explorer ?? j.explorer} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1.5 font-medium text-slate-900 underline-offset-4 hover:underline">
        <NearMark size={14} />
        Look it up on the NEAR Intents Explorer
      </a>
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
