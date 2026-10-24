import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, CircleNotch } from "@phosphor-icons/react";
import { continueRoute, type RouteView } from "@/api";
import { Link } from "@/router";
import { clock, clockSeconds } from "@/swap/timing";
import { CopyText } from "../components/CopyText";
import { Layout } from "../components/Layout";
import { StatusIcon, Tracker, type TrackerStep } from "../components/Progress";
import { RouteStrip } from "../components/RouteStrip";
import { ToneBadge } from "../components/ui/badge";
import { Fold } from "../components/ui/fold";
import { PAUSE, ROUTE_WORD, inAbout, isRunning, legNote, routeAmounts, tickerOf, unitsText, useRoutes, zecText } from "../lib/routes";
import type { Tone } from "../lib/progress";

// /app/route/:id: a private swap, as one calm card. A status word, a headline, its three parts
// (swap 1, the private pause, swap 2) with the current one explained, and what to expect. Holding
// the ZEC (the second swap couldn't run) offers "Finish now". Everything technical is folded away.

// a Zcash block, for "about N min" while the ZEC settles
const ZEC_BLOCK_SECS = 75;

export function RouteDetail({ id }: { id: string }) {
  const routes = useRoutes();
  const v = routes.byId[id];
  return (
    <Layout>
      <div className="mx-auto w-full max-w-[480px]">
        <Link to="/app/activity" className="mb-4 inline-flex items-center gap-1.5 rounded text-sm text-slate-500 transition-colors hover:text-slate-900">
          <ArrowLeft size={14} weight="bold" aria-hidden />
          Activity
        </Link>
        {v ? (
          <Body v={v} />
        ) : (
          <div className="rounded-3xl border border-slate-200 bg-white px-6 py-14 text-center">
            {routes.legs ? <CircleNotch size={28} weight="bold" className="mx-auto animate-spin text-slate-400 motion-reduce:animate-none" aria-hidden /> : null}
            <p className="mt-4 text-slate-600">{routes.legs ? "Loading your private swap…" : "Private swaps aren't available on this server."}</p>
          </div>
        )}
      </div>
    </Layout>
  );
}

// a clock that ticks while something counts down
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

// the reason a route holds the ZEC, without the router's "You hold ... in your wallet ..." tail
function why(v: RouteView): string {
  const first = (v.note || "").split(/\. You hold /)[0].replace(/\.$/, "");
  if (/stopped/i.test(first)) return "You stopped before the second swap";
  if (/No partner took your ZEC/i.test(first)) return "No partner took your ZEC at your price in time";
  if (/called off and refunded/i.test(first)) return "The second swap was called off and undone";
  if (/called off before/i.test(first)) return "The second swap was called off before anything moved";
  if (/can spend only/i.test(first)) return "Your wallet couldn't spend the ZEC yet";
  return first || "The second swap couldn't run";
}

function Body({ v }: { v: RouteView }) {
  const routes = useRoutes();
  const now = useNow(v.state === "pausing" || v.state === "settling");
  const [acting, setActing] = useState(false);
  const [fail, setFail] = useState<string | null>(null);
  const a = tickerOf(v.from);
  const c = tickerOf(v.to);
  const amt = routeAmounts(v);
  const word = ROUTE_WORD(v);
  const running = isRunning(v);
  const holding = v.state === "holding";

  const finish = async () => {
    setActing(true);
    setFail(null);
    try {
      routes.put(await continueRoute(v.id));
    } catch (e) {
      setFail((e as Error).message.replace(/\broute\b/gi, "private swap"));
    } finally {
      setActing(false);
    }
  };

  let head: { tone: Tone; title: string; sub: ReactNode };
  if (v.state === "leg1") head = { tone: "live", title: `Swapping ${a} for ${c} privately`, sub: `Swap 1 of 2 is buying shielded ZEC with your ${a}.` };
  else if (v.state === "settling") head = { tone: "live", title: `Swapping ${a} for ${c} privately`, sub: "Swap 1 is done. Your ZEC is settling in your shielded wallet." };
  else if (v.state === "pausing") head = { tone: "live", title: `Swapping ${a} for ${c} privately`, sub: "Swap 1 is done. Your ZEC is resting in your shielded wallet." };
  else if (v.state === "leg2") head = { tone: "live", title: `Swapping ${a} for ${c} privately`, sub: `Swap 2 of 2 is selling your ZEC for ${c}.` };
  else if (holding) head = { tone: "warn", title: `You hold ${zecText(v.zec.held_zat)}`, sub: `${why(v)}. Your ZEC is safe in your shielded wallet. Nothing is lost.` };
  else if (v.state === "done") head = { tone: "good", title: `You received ${amt.outShort}`, sub: `${amt.inShort} went in, through shielded ZEC. Nothing on either chain links the two.` };
  else if (v.outcome === "refunded") head = { tone: "neutral", title: `Your ${a} is back`, sub: "The first swap didn't finish in time, so it was undone. The second never started." };
  else if (v.outcome === "punished") head = { tone: "bad", title: "The swap didn't complete", sub: `Your Ferry node was offline past the deadline, so the ${a} went to your partner.` };
  else head = { tone: "neutral", title: "Nothing moved", sub: (v.note || "The private swap didn't start.").replace(/\bmaker\b/gi, "partner") };

  // the three parts; "done" times from the router's own log
  const at = (kind: string) => v.timeline.find((e) => e.kind === kind)?.at;
  const after1 = !["leg1", "failed"].includes(v.state);
  const paused = ["leg2", "done"].includes(v.state) || (holding && !!v.legs[1].swap_id) || (holding && !!v.legs[1].earlier_swaps.length);
  const left = Math.max(0, v.zec.needed_confs - v.zec.sweep_confs);
  const steps: TrackerStep[] = [
    { title: `Swap 1: ${a} → shielded ZEC`, status: after1 ? "done" : "active", at: at("leg1_swapped"), note: legNote(v.legs[0]) },
    {
      title: "Private pause",
      status: paused ? "done" : v.state === "settling" || v.state === "pausing" ? "active" : "pending",
      at: at("leg2_starting") ?? at("leg2_started"),
      note:
        v.state === "settling"
          ? v.legs[0].outcome !== "swapped"
            ? "Your ZEC is on its way to your shielded wallet."
            : left > 0
              ? `Your ZEC is in your shielded wallet. It can be spent after ${v.zec.needed_confs} confirmations: ${Math.min(v.zec.sweep_confs, v.zec.needed_confs)} so far, about ${Math.max(1, Math.round((left * ZEC_BLOCK_SECS) / 60))} min to go.`
              : "Your ZEC is in your shielded wallet, almost ready to spend."
          : `A random wait, so the two swaps are harder to link. Swap 2 starts ${inAbout(v, now)}.`,
      extra:
        v.state === "pausing" ? (
          <p className="text-[13px] text-slate-500">
            In a hurry?{" "}
            <button type="button" onClick={finish} disabled={acting} className="rounded font-medium text-slate-900 underline underline-offset-4 hover:no-underline disabled:text-slate-400">
              Skip the pause
            </button>{" "}
            — faster, but easier to link.
          </p>
        ) : null,
    },
    {
      title: `Swap 2: ZEC → ${c}`,
      status: v.state === "done" ? "done" : v.state === "leg2" || holding ? "active" : "pending",
      at: at("done"),
      note: holding
        ? "Waiting for you: finish now, or keep the ZEC."
        : v.phase === "leg2_starting"
          ? `Finding a partner who pays at least ${unitsText(v.amounts.out_min, v.to)}.${v.problem ? " The last one said no; trying again." : ""}`
          : legNote(v.legs[1]),
    },
  ];

  return (
    <>
      <div className="rounded-3xl border border-slate-200 bg-white px-5 py-7 shadow-[0_1px_2px_rgba(24,24,27,0.04)] sm:px-8 sm:py-8">
        <div className="flex flex-col items-center text-center">
          <StatusIcon tone={head.tone} holding={holding} />
          <ToneBadge tone={word.tone} className="mt-5">
            {word.label}
          </ToneBadge>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-balance text-slate-900 tabular-nums sm:text-[28px]">{head.title}</h1>
          {head.sub ? <p className="mt-2 max-w-sm text-[15px] text-balance text-slate-600">{head.sub}</p> : null}
        </div>

        {running || holding ? (
          <RouteStrip
            className="mt-6"
            from={v.from}
            to={v.to}
            sell={amt.inShort}
            zec={zecText(holding ? v.zec.held_zat : v.amounts.zec_zat)}
            get={v.legs[1].counter_units != null && v.state === "leg2" ? unitsText(v.legs[1].counter_units, v.to) : unitsText(v.amounts.out_min, v.to)}
            getNote={v.legs[1].counter_units != null && v.state === "leg2" ? undefined : "at least"}
            faded={holding}
          />
        ) : null}

        {v.state !== "failed" ? <Tracker steps={steps} /> : null}

        {running ? (
          <div className="mt-6 space-y-2 border-t border-slate-100 pt-5 text-sm text-slate-600">
            <p>Private swaps usually take {PAUSE[pauseOf(v)].total} in all.</p>
            <p>If the second swap can't run at your price, you keep the ZEC in your shielded wallet.</p>
            <p className="text-slate-900">You can close this page — your Ferry node finishes both swaps.</p>
          </div>
        ) : holding ? (
          <div className="mt-7 flex flex-col items-center gap-3">
            <button
              type="button"
              onClick={finish}
              disabled={acting}
              className="flex h-12 w-full items-center justify-center rounded-2xl bg-slate-900 text-[15px] font-semibold text-white transition-colors hover:bg-slate-800 disabled:bg-slate-100 disabled:text-slate-400"
            >
              {acting ? "Starting…" : "Finish now"}
            </button>
            <p className="text-center text-sm text-balance text-slate-600">
              Tries the second swap again, for at least {unitsText(v.amounts.out_min, v.to)}. Or keep the ZEC: it's yours, with no deadline.
            </p>
          </div>
        ) : (
          <div className="mt-7 flex flex-col items-center gap-3">
            <Link to="/app" className="flex h-12 w-full items-center justify-center rounded-2xl bg-slate-900 text-[15px] font-semibold text-white transition-colors hover:bg-slate-800">
              {v.state === "done" ? "Swap again" : "Start a new swap"}
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
        <Technical v={v} />
      </Fold>
    </>
  );
}

// the pause the route was started with, by its window
const pauseOf = (v: RouteView) => (v.privacy.delay_secs[1] === 0 ? "off" : v.privacy.delay_secs[0] >= 3600 ? "long" : "standard");
const mins = (s: number) => (s >= 3600 ? `${Math.round(s / 360) / 10} h` : `${Math.round(s / 60)} min`);

function Technical({ v }: { v: RouteView }) {
  const [l1, l2] = v.legs;
  const [lo, hi] = v.privacy.delay_secs;
  return (
    <div className="space-y-7 text-sm">
      <Group title="Private swap">
        <Row label="ID" value={<CopyText value={v.id} head={10} tail={6} />} />
        <Row label="Route" value={`${tickerOf(v.from)} → shielded ZEC → ${tickerOf(v.to)}`} />
        <Row label="Started" value={new Date(v.created_at * 1000).toLocaleString()} />
        <Row label="You pay at most" value={unitsText(v.amounts.in_max, v.from)} />
        <Row label="ZEC bought" value={zecText(v.amounts.zec_zat)} />
        <Row label="ZEC sold" value={zecText(v.amounts.zec2_zat)} />
        <Row label="You get at least" value={unitsText(v.amounts.out_min, v.to)} />
        <Row label="Privacy pause" value={hi === 0 ? "Off" : `${mins(lo)} to ${mins(hi)}, drawn at random`} />
        {v.privacy.not_before ? <Row label="Pause ends" value={clock(new Date(v.privacy.not_before * 1000))} /> : null}
      </Group>

      {[l1, l2].map((l) => (
        <Group key={l.n} title={`Swap ${l.n}: ${l.n === 1 ? `${l.unit.ticker} → ZEC` : `ZEC → ${l.unit.ticker}`}`}>
          <Row label="Partner" value={l.maker ?? "not picked yet"} />
          <Row label="Swap ID" value={l.swap_id ? <CopyText value={l.swap_id} head={10} tail={6} /> : "not started"} />
          {l.state ? <Row label="State" value={<span className="font-mono text-xs">{l.state}</span>} /> : null}
          {l.counter_units != null ? <Row label={l.n === 1 ? "Paid" : "Paid to you"} value={unitsText(l.counter_units, l.pair)} /> : null}
          <Row label="Your Ferry node" value={l.wallet || "–"} />
          <Row label="Watchtower" value={l.watchtower?.status === "armed" ? "Armed" : l.watchtower ? String(l.watchtower.status ?? "Arming") : "None"} />
          {l.earlier_swaps.length ? <Row label="Earlier tries" value={l.earlier_swaps.length} /> : null}
        </Group>
      ))}

      <Group title="Shielded ZEC between the swaps">
        <Row label="Sweep" value={v.zec.sweep_txid ? <CopyText value={v.zec.sweep_txid} head={8} tail={6} /> : "not yet"} />
        <Row label="Confirmations" value={`${Math.min(v.zec.sweep_confs, v.zec.needed_confs)} of ${v.zec.needed_confs} needed`} />
        {v.zec.spendable_zat != null ? <Row label="Spendable now" value={zecText(v.zec.spendable_zat)} /> : null}
      </Group>

      <Group title="Every step">
        <ol className="space-y-1.5">
          {v.timeline.map((e, i) => (
            <li key={i} className="flex items-baseline justify-between gap-3">
              <span className="text-slate-900">{e.label.replace(/\bmaker\b/gi, "partner")}</span>
              <span className="shrink-0 text-xs text-slate-500 tabular-nums">{clockSeconds(e.at)}</span>
            </li>
          ))}
        </ol>
        {v.note ? <p className="text-slate-600">{v.note}</p> : null}
      </Group>

      <Group title="What can still link the two swaps">
        <p className="text-slate-600">
          The ZEC in the middle is shielded: its amounts and addresses never appear on any chain, and the first partner can't see where its ZEC went. What can still link
          the two swaps is their <span className="text-slate-900">timing</span> (the random pause blurs it) and their <span className="text-slate-900">amounts</span>, which
          follow from one ZEC amount at public prices. Each partner sees its own swap and your IP address, and two partners run by one operator could link them.
        </p>
      </Group>

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
