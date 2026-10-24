import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, ArrowSquareOut, CircleNotch, SealCheck } from "@phosphor-icons/react";
import { retryNear, type NearJob, type RouteLeg } from "@/api";
import { Link, navigate } from "@/router";
import { clock, clockSeconds } from "@/swap/timing";
import { CopyText } from "../components/CopyText";
import { Layout } from "../components/Layout";
import { NearTokenLogo, PairLogo, TokenLogo } from "../components/Logos";
import { StatusIcon, Tracker, type TrackerStep } from "../components/Progress";
import { NearMark } from "../components/TokenPicker";
import { ToneBadge } from "../components/ui/badge";
import { Fold } from "../components/ui/fold";
import { useLocal } from "../lib/daemon";
import { aboutTime, chainName, isActive, jobZec, nearText, nearWord, useNear } from "../lib/near";
import { pairName } from "../lib/pairs";
import type { Tone } from "../lib/progress";
import { legNote } from "../lib/routes";
import { cn } from "../lib/utils";

// /app/near/:id: a NEAR Intents swap, as one calm card. A status word, a headline, its parts (the
// Ferry swap and NEAR Intents' swap, in their order; a buy starts with the person's deposit), the
// current one explained, and what to expect. A buy waiting for its deposit shows where to send it.
// The technical side (deposit address, NEAR Intents' signed quote and status, transactions) folds away.

export function NearDetail({ id }: { id: string }) {
  const near = useNear();
  const j = near.job(id);
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
            {near.info === undefined || near.runs("sell") || near.runs("buy") ? <CircleNotch size={28} weight="bold" className="mx-auto animate-spin text-slate-400 motion-reduce:animate-none" aria-hidden /> : null}
            <p className="mt-4 text-slate-600">{near.info === undefined || near.runs("sell") || near.runs("buy") ? "Loading your swap…" : "NEAR Intents swaps don't run on this server."}</p>
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

// "1:52:07" or "14:05"
function left(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function Body({ j }: { j: NearJob }) {
  const near = useNear();
  const d = useLocal();
  const now = useNow(j.state === "deposit");
  const [acting, setActing] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const word = nearWord(j);
  const a = j.asset;
  const c = j.via_asset.symbol;
  const via = pairName(j.via);
  const selling = j.kind === "sell";
  const chain = chainName(a.blockchain);
  const got = j.near.details?.amount_out ?? null;
  const getsText = selling ? (j.state === "done" && got ? nearText(got, a) : `at least ${nearText(j.near.min_amount_out, a)}`) : jobZec(j);
  const ferryLeg = { role: selling ? "Z" : "B", state: j.ferry.state, maker: j.maker, unit: { ticker: c, decimals: j.via_asset.decimals } } as unknown as RouteLeg;

  const retry = async () => {
    setActing(true);
    setFail(null);
    try {
      near.put(await retryNear(j.id));
    } catch (e) {
      setFail((e as Error).message);
    } finally {
      setActing(false);
    }
  };
  // the Ferry swap's own page lives with that pair's node: switch to it first
  const openSwap = (id: string) => {
    d.choosePair(j.via, j.kind);
    if (d.dir !== j.kind) d.chooseDirection(j.kind);
    navigate(`/app/swap/${id}`);
  };

  let head: { tone: Tone; title: string; sub: ReactNode };
  const nearStatus = j.near.status;
  if (j.state === "deposit") head = { tone: "live", title: `Send ${nearText(j.near.amount_in, a)}`, sub: `To NEAR Intents' deposit address on ${chain}. Once it arrives, the rest happens on its own.` };
  else if (j.state === "near" && !selling) head = { tone: "live", title: `Swapping your ${a.symbol}`, sub: `NEAR Intents got your deposit and is sending ${c} to your Ferry node.` };
  else if (j.state === "funding") head = { tone: "live", title: "Buying your ZEC", sub: `Your ${c} arrived in your Ferry node. Ferry is starting the swap for shielded ZEC.` };
  else if (j.state === "ferry" && selling) head = { tone: "live", title: `Selling ${jobZec(j)} for ${a.symbol}`, sub: `Ferry is swapping your shielded ZEC for ${c}, paid straight to NEAR Intents.` };
  else if (j.state === "ferry") head = { tone: "live", title: "Buying your ZEC", sub: `Ferry is swapping the ${c} for shielded ZEC.` };
  else if (j.state === "near") head = { tone: "live", title: `Sending your ${a.symbol}`, sub: `The Ferry swap is done. NEAR Intents is swapping the ${c} for ${a.symbol}.` };
  else if (j.state === "holding") head = { tone: "warn", title: `Your ${c} is in your Ferry node`, sub: `${j.problem ? `${j.problem.replace(/\.$/, "")}. ` : ""}Nothing is lost: buy the ZEC now, or keep the ${c}.` };
  else if (j.state === "done") head = { tone: "good", title: `You received ${selling ? getsText : `${jobZec(j)}`}`, sub: selling ? `${jobZec(j)} left your shielded wallet, through ${c} and NEAR Intents.` : `It's in your shielded wallet. You sent ${nearText(j.near.details?.amount_in ?? j.near.amount_in, a)}.` };
  else if (j.state === "refunded") head = { tone: "neutral", title: selling ? `Your ${c} is back` : `Your ${a.symbol} is on its way back`, sub: selling ? `NEAR Intents couldn't fill the swap, so it refunded the ${c} to your Ferry node.` : `NEAR Intents couldn't fill the swap, so it refunds your ${a.symbol} to ${short(j.address)}.` };
  else if (j.state === "expired") head = { tone: "neutral", title: "Nothing moved", sub: "No deposit arrived before the deadline. If you sent one late, NEAR Intents refunds it to your refund address." };
  else head = { tone: j.outcome === "punished" ? "bad" : "neutral", title: j.outcome === "punished" ? "The swap didn't complete" : "Your ZEC is back", sub: j.outcome === "punished" ? "Your Ferry node was offline past the deadline." : "The Ferry swap was called off before anything reached NEAR Intents." };

  const at = (kind: string) => j.timeline.find((e) => e.kind === kind)?.at;
  const nearWords = (s: string) =>
    ({
      PENDING_DEPOSIT: selling ? `Waiting for the ${c}.` : `Waiting for your ${a.symbol}.`,
      KNOWN_DEPOSIT_TX: "NEAR Intents sees the deposit on its way.",
      PROCESSING: selling ? `NEAR Intents delivers ${getsText} to ${short(j.address)}.` : `NEAR Intents delivers ${nearText(j.near.amount_out, j.via_asset)} to your Ferry node.`,
      INCOMPLETE_DEPOSIT: "NEAR Intents got less than the quote needs; it will refund it.",
    })[s] ?? (selling ? `NEAR Intents delivers ${getsText} to ${short(j.address)}.` : "NEAR Intents is working on it.");

  const ferryStep = (title: string, status: TrackerStep["status"], kindDone: string): TrackerStep => ({
    title,
    status,
    at: at(kindDone),
    note: j.state === "funding" ? (j.problem ?? "Starting the swap with your partner.") : legNote(ferryLeg),
    extra: j.ferry.swap_id ? (
      <button type="button" onClick={() => openSwap(j.ferry.swap_id!)} className="inline-flex items-center gap-1 rounded text-[13px] font-medium text-slate-900 underline underline-offset-4 hover:no-underline">
        The swap, step by step
        <ArrowRight size={12} weight="bold" aria-hidden />
      </button>
    ) : null,
  });
  const nearStep = (title: string, status: TrackerStep["status"]): TrackerStep => ({ title, status, at: at("near_success") ?? at("refunded"), note: nearWords(nearStatus) });

  const steps: TrackerStep[] = selling
    ? [
        ferryStep(`Ferry: shielded ZEC → ${c}`, j.state === "ferry" ? "active" : j.state === "failed" ? "pending" : "done", "ferry_swapped"),
        nearStep(`NEAR Intents: ${c} → ${a.symbol}`, j.state === "near" ? "active" : j.state === "done" || j.state === "refunded" ? "done" : "pending"),
      ]
    : [
        {
          title: `You send ${nearText(j.near.amount_in, a)}`,
          status: j.state === "deposit" ? "active" : j.state === "expired" ? "pending" : "done",
          at: at("near_known_deposit_tx") ?? at("near_processing"),
          note: `Before ${clock(new Date(j.near.deadline))}.`,
          extra: <Deposit j={j} now={now} />,
        },
        nearStep(`NEAR Intents: ${a.symbol} → ${c}`, j.state === "near" ? "active" : ["deposit", "expired"].includes(j.state) ? "pending" : "done"),
        ferryStep(`Ferry: ${c} → shielded ZEC`, ["funding", "ferry", "holding"].includes(j.state) ? "active" : j.state === "done" ? "done" : "pending", "ferry_swapped"),
      ];

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

        <Strip j={j} gets={getsText} />

        {j.state !== "expired" ? <Tracker steps={steps} /> : null}

        {isActive(j) && j.state !== "holding" ? (
          <div className="mt-6 space-y-2 border-t border-slate-100 pt-5 text-sm text-slate-600">
            {j.near.time_s != null ? <p>NEAR Intents' part usually takes {aboutTime(j.near.time_s)}{selling ? ", after the Ferry swap" : ", once your deposit confirms"}.</p> : null}
            <p>Your ZEC stays shielded. The NEAR Intents part is public, and you trust NEAR Intents for it.</p>
            <p className="text-slate-900">You can close this page — the server follows both parts.</p>
          </div>
        ) : j.state === "holding" ? (
          <div className="mt-7 flex flex-col items-center gap-3">
            <button type="button" onClick={retry} disabled={acting} className="flex h-12 w-full items-center justify-center rounded-2xl bg-slate-900 text-[15px] font-semibold text-white transition-colors hover:bg-slate-800 disabled:bg-slate-100 disabled:text-slate-400">
              {acting ? "Starting…" : "Buy ZEC now"}
            </button>
            <p className="text-center text-sm text-balance text-slate-600">Tries the Ferry swap again with the {c} in your Ferry node. Or keep it: it's yours.</p>
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
        <Technical j={j} via={via.noun} />
      </Fold>
    </>
  );
}

const short = (s: string) => (s.length > 16 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s);

// The three amounts in a row: what goes in, the coin between, what comes out.
function Strip({ j, gets }: { j: NearJob; gets: string }) {
  const sell = j.kind === "sell";
  const zecPart = <Part logo={<TokenLogo id="zec" size={22} />} value={jobZec(j)} note="shielded" />;
  const assetPart = (value: string, note?: string) => <Part logo={<NearTokenLogo symbol={j.asset.symbol} chain={j.asset.blockchain} size={22} />} value={value} note={note} />;
  const mid = <Part logo={<PairLogo pair={j.via} size={22} />} value={nearText(sell ? j.ferry.counter : j.near.amount_out, j.via_asset)} note={sell ? "Ferry → NEAR" : "NEAR → Ferry"} />;
  const out = sell ? (gets.startsWith("at least ") ? assetPart(gets.slice(9), "at least") : assetPart(gets)) : zecPart;
  return (
    <div className="mt-6 grid grid-cols-[1fr_auto_1fr_auto_1fr] items-start gap-1 rounded-2xl bg-slate-50 px-2 py-3 text-center tabular-nums">
      {sell ? zecPart : assetPart(nearText(j.near.amount_in, j.asset))}
      <ArrowRight size={14} weight="bold" className="mt-1 text-slate-400" aria-label="for" />
      {mid}
      <ArrowRight size={14} weight="bold" className="mt-1 text-slate-400" aria-label="then" />
      {out}
    </div>
  );
}

function Part({ logo, value, note }: { logo: ReactNode; value: string; note?: string }) {
  const [n, ticker] = value.split(" ");
  return (
    <span className="flex min-w-0 flex-col items-center gap-1">
      {logo}
      <span className="max-w-full truncate text-[13px] font-medium text-slate-900 sm:text-sm">{n}</span>
      <span className="text-xs text-slate-500">{note ? `${ticker} · ${note}` : ticker}</span>
    </span>
  );
}

// Where to send a buy's deposit: the amount, the address (and memo), and the time left.
function Deposit({ j, now }: { j: NearJob; now: number }) {
  const ms = Date.parse(j.near.deadline) - now;
  return (
    <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-3.5" data-near-deposit>
      <div>
        <p className="text-xs font-medium tracking-wider text-slate-500 uppercase">Send exactly</p>
        <p className="mt-1 flex items-center gap-2 text-lg font-semibold text-slate-900 tabular-nums">
          <NearTokenLogo symbol={j.asset.symbol} chain={j.asset.blockchain} size={20} />
          {nearText(j.near.amount_in, j.asset)}
          <span className="text-sm font-normal text-slate-500">on {chainName(j.asset.blockchain)}</span>
        </p>
      </div>
      <div>
        <p className="text-xs font-medium tracking-wider text-slate-500 uppercase">To NEAR Intents' deposit address</p>
        <CopyText value={j.near.deposit_address} truncate={false} className="mt-1 text-[13px] text-slate-900" />
      </div>
      {j.near.deposit_memo ? (
        <div>
          <p className="text-xs font-medium tracking-wider text-rose-700 uppercase">With this memo, or it's lost</p>
          <CopyText value={j.near.deposit_memo} truncate={false} className="mt-1 text-[13px] text-slate-900" />
        </div>
      ) : null}
      <p className="text-[13px] text-slate-600 tabular-nums">
        {ms > 0 ? (
          <>
            <span className="font-medium text-slate-900">{left(ms)}</span> left. Send from your own wallet; a refund goes to {short(j.address)}.
          </>
        ) : (
          "The deadline has passed. Don't send anything now."
        )}
      </p>
    </div>
  );
}

function Technical({ j, via }: { j: NearJob; via: string }) {
  const near = useNear();
  const det = j.near.details;
  const txs = [...(det?.origin_txs ?? []).map((t) => ({ ...t, where: j.kind === "sell" ? via : chainName(j.asset.blockchain) })), ...(det?.destination_txs ?? []).map((t) => ({ ...t, where: j.kind === "sell" ? chainName(j.asset.blockchain) : via }))];
  return (
    <div className="space-y-7 text-sm">
      <Group title="NEAR Intents">
        <Row label="Deposit address" value={<CopyText value={j.near.deposit_address} head={10} tail={6} />} />
        {j.near.deposit_memo ? <Row label="Memo" value={<CopyText value={j.near.deposit_memo} />} /> : null}
        <Row label="Status" value={<span className="font-mono text-xs">{j.near.status}</span>} />
        <Row label={j.kind === "sell" ? "Sends to" : "Refunds to"} value={<CopyText value={j.address} head={8} tail={6} />} />
        <Row label={j.kind === "sell" ? "Refunds to" : "Delivers to"} value={<span className="inline-flex items-center gap-1">your Ferry node <CopyText value={j.own_address} head={6} tail={4} /></span>} />
        <Row label="Quote" value={`${nearText(j.near.amount_in, j.kind === "sell" ? j.via_asset : j.asset)} → ${nearText(j.near.amount_out, j.kind === "sell" ? j.asset : j.via_asset)}`} />
        <Row label={j.kind === "sell" ? "At least" : "Exactly"} value={nearText(j.near.min_amount_out, j.kind === "sell" ? j.asset : j.via_asset)} />
        <Row label="Quote deadline" value={new Date(j.near.deadline).toLocaleString()} />
        <Row
          label="Signed by 1Click"
          value={
            j.near.verified ? (
              <span className="inline-flex items-center gap-1 text-emerald-700">
                <SealCheck size={14} weight="fill" aria-hidden /> checked
              </span>
            ) : (
              "not checked"
            )
          }
        />
        {j.near.signature ? <Row label="Signature" value={<CopyText value={j.near.signature} head={14} tail={6} />} /> : null}
        {j.near.correlation_id ? <Row label="Correlation ID" value={<CopyText value={j.near.correlation_id} head={8} tail={4} />} /> : null}
        {det?.refunded ? <Row label="Refunded" value={`${nearText(det.refunded, j.kind === "sell" ? j.via_asset : j.asset)}${det.refund_reason ? ` (${det.refund_reason.toLowerCase().replace(/_/g, " ")})` : ""}`} /> : null}
        {txs.map((t) => (
          <Row
            key={t.hash}
            label={`Transaction on ${t.where}`}
            value={
              t.url ? (
                <a href={t.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-mono text-xs text-slate-900 underline underline-offset-4">
                  {short(t.hash)}
                  <ArrowSquareOut size={12} aria-hidden />
                </a>
              ) : (
                <CopyText value={t.hash} head={8} tail={6} />
              )
            }
          />
        ))}
        <a href={near.info?.explorer ?? j.explorer} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1.5 font-medium text-accent-700 underline-offset-4 hover:underline">
          <NearMark size={14} />
          Look it up on the NEAR Intents Explorer
          <ArrowSquareOut size={13} aria-hidden />
        </a>
        <p className="text-xs text-slate-500">Search there for the deposit address above.</p>
      </Group>

      <Group title="Ferry">
        <Row label="Route" value={j.kind === "sell" ? `Shielded ZEC → ${via}` : `${via} → shielded ZEC`} />
        <Row label="Partner" value={j.maker} />
        <Row label="Swap ID" value={j.ferry.swap_id ? <CopyText value={j.ferry.swap_id} head={10} tail={6} /> : "not started"} />
        {j.ferry.state ? <Row label="State" value={<span className="font-mono text-xs">{j.ferry.state}</span>} /> : null}
        {j.ferry.earlier.length ? <Row label="Earlier tries" value={j.ferry.earlier.length} /> : null}
      </Group>

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
          The Ferry swap is atomic: your partner can't take your coins, and your ZEC never leaves the shielded pool. Ferry never sends ZEC to NEAR Intents. The NEAR Intents part
          runs on its bridges and solvers, on public chains: you trust NEAR Intents to deliver it, or to refund it. 1Click signed the quote above; keep it if you ever need to
          dispute a swap.
        </p>
      </Group>
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
    <div className={cn("flex items-baseline justify-between gap-4")}>
      <span className="shrink-0 text-slate-500">{label}</span>
      <span className="min-w-0 text-right text-slate-900 tabular-nums">{value}</span>
    </div>
  );
}
