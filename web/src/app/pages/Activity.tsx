import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, ArrowsLeftRight } from "@phosphor-icons/react";
import { directionOf, getSwaps, isMine, pairChain, pairCoin, type ComboJob, type Direction, type NearJob, type PairId, type RouteView, type Status, type SwapView } from "@/api";
import { coin, coinOf } from "@/format";
import { navigate } from "@/router";
import { phaseOf } from "@/swap/steps";
import { Layout } from "../components/Layout";
import { NearTokenLogo, PairLogo, TokenLogo } from "../components/Logos";
import { NearMark } from "../components/TokenPicker";
import { ToneBadge } from "../components/ui/badge";
import { useLocal } from "../lib/daemon";
import { chainName, comboGot, comboIn, comboOut, comboWord, jobIn, jobOut, nearText, nearWord, useNear } from "../lib/near";
import { pairName } from "../lib/pairs";
import { STATUS_WORD, swapAmounts, wordsFor, type Words } from "../lib/progress";
import { ROUTE_WORD, legSwapIds, routeAmounts, tickerOf, unitsText, useRoutes, zecText } from "../lib/routes";

// /app/activity: every swap the person started on their Ferry nodes, newest first, both ways
// round (selling ZEC on their Z nodes, buying it on their B nodes) and across the coins this
// server offers. A row opens the swap, switching the coin and direction on screen first when it's
// another one. Swaps a node of theirs made as a maker (in a local demo) are not theirs to list.
// A private swap (coin → shielded ZEC → coin) is one row: its two swaps aren't listed on their own.
// So is a NEAR Intents swap: its Ferry swap is part of its row.

const POLL_MS = 10_000;

interface Item {
  swap: SwapView;
  pair: PairId;
  dir: Direction;
  status: Status | null;
  words: Words;
}

interface Source {
  pair: PairId;
  dir: Direction;
  daemon: string;
  status: Status | null;
}

export interface ActivityRow {
  at: number;
  key: string;
  // still moving (or waiting for the person)
  live: boolean;
  row: ReactNode;
}

// Every swap of the person's, newest first, as rows: this page lists them all, the swap card's
// "Recent activity" panel the latest few. Live: the followed daemon streams, the others are polled,
// and private swaps and NEAR swaps come from their own providers.
export function useActivityRows(): ActivityRow[] {
  const d = useLocal();
  // every daemon this server fronts, each once: the followed one included (it may not be probed yet)
  const sources: Source[] = [];
  for (const p of d.pairs)
    for (const dir of ["sell", "buy"] as const) {
      const daemon = p[dir].daemon;
      if (daemon && !sources.some((x) => x.daemon === daemon)) sources.push({ pair: p.id, dir, daemon, status: p[dir].status });
    }
  if (d.daemon && !sources.some((x) => x.daemon === d.daemon)) sources.push({ pair: d.pair, dir: d.dir, daemon: d.daemon, status: d.status });
  const polled = sources.filter((x) => x.daemon !== d.daemon);
  const key = polled.map((x) => x.daemon).join(",");
  const [extra, setExtra] = useState<Record<string, SwapView[]>>({});

  useEffect(() => {
    if (!polled.length) return;
    let alive = true;
    const load = async () => {
      const got = await Promise.all(polled.map((x) => getSwaps(x.daemon).catch(() => [] as SwapView[])));
      if (alive) setExtra(Object.fromEntries(polled.map((x, i) => [x.daemon, got[i]])));
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const routes = useRoutes();
  const near = useNear();
  // a private swap's own two swaps are in its row, and a NEAR swap's Ferry swap in its own; a
  // private swap with NEAR Intents at an end is one row, its route and swaps in it
  const seen = legSwapIds(routes.list);
  for (const j of near.jobs) for (const id of [j.ferry.swap_id, ...j.ferry.earlier]) if (id) seen.add(id);
  const comboRoutes = new Set(near.combos.map((c) => c.route.id).filter(Boolean));
  for (const c of near.combos) for (const id of c.route.swaps) seen.add(id);
  const items: Item[] = sources
    .flatMap((x) => {
      const followed = x.daemon === d.daemon;
      // the followed daemon's views are live (the provider also holds the other side's, polled)
      const swaps = followed ? Object.values(d.swaps).filter((s) => s.role === d.role) : (extra[x.daemon] ?? []);
      const words = followed ? wordsFor(coin()) : wordsFor(coinOf(x.status ?? { chains: { btc: { coin: pairCoin(x.pair) } } }, pairChain(x.pair)));
      return swaps.filter((s) => isMine(s) && !s.route).map((swap) => ({ swap, pair: x.pair, dir: directionOf(swap.role), status: followed ? d.status : x.status, words }));
    })
    .filter((it) => !seen.has(it.swap.id) && !!seen.add(it.swap.id));
  const open = (it: Item) => {
    if (it.pair !== d.pair) d.choosePair(it.pair, it.dir);
    if (it.dir !== d.dir) d.chooseDirection(it.dir);
    navigate(`/app/swap/${it.swap.id}`);
  };
  const ended = (s: string) => ["done", "failed", "refunded", "expired"].includes(s);

  // swaps and private swaps together, newest first
  return [
    ...items.map((it) => ({ at: Date.parse(it.swap.timeline[0]?.at ?? "") || 0, key: `${it.pair}:${it.swap.id}`, live: !it.swap.outcome, row: <Row item={it} onOpen={() => open(it)} /> })),
    ...routes.list.filter((v) => !comboRoutes.has(v.id)).map((v) => ({ at: v.created_at * 1000, key: v.id, live: !ended(v.state), row: <RouteRow route={v} /> })),
    ...near.jobs.map((j) => ({ at: j.created_at * 1000, key: j.id, live: !ended(j.state), row: <NearRow job={j} /> })),
    ...near.combos.map((j) => ({ at: j.created_at * 1000, key: j.id, live: !ended(j.state), row: <ComboRow job={j} /> })),
  ].sort((x, y) => y.at - x.at);
}

export function Activity() {
  const rows = useActivityRows();
  return (
    <Layout>
      <div className="mx-auto w-full max-w-[640px]">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Activity</h1>
        <p className="mt-1 text-slate-600">Your swaps both ways, newest first.</p>
        {rows.length === 0 ? (
          <div className="mt-8 rounded-3xl border border-slate-200 px-6 py-14 text-center">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-600">
              <ArrowsLeftRight size={22} weight="bold" aria-hidden />
            </span>
            <p className="mt-4 font-medium text-slate-900">No swaps yet</p>
            <p className="mt-1 text-sm text-slate-500">When you swap, it shows up here.</p>
            <a
              href="/app"
              onClick={(e) => {
                e.preventDefault();
                navigate("/app");
              }}
              className="mt-6 inline-flex h-11 items-center gap-2 rounded-2xl bg-slate-900 px-5 text-sm font-semibold text-white transition-colors hover:bg-slate-800"
            >
              Start a swap
            </a>
          </div>
        ) : (
          <ul className="mt-8 divide-y divide-slate-100 overflow-hidden rounded-3xl border border-slate-200">
            {rows.map((r) => (
              <li key={r.key}>{r.row}</li>
            ))}
          </ul>
        )}
      </div>
    </Layout>
  );
}

function Row({ item, onOpen }: { item: Item; onOpen: () => void }) {
  const { swap, pair, status, words } = item;
  const a = swapAmounts(swap, status, words);
  const st = STATUS_WORD[phaseOf(swap)];
  const z = swap.role === "Z";
  const started = swap.timeline[0]?.at;
  return (
    <a
      href={`/app/swap/${swap.id}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onOpen();
      }}
      className="group flex items-center gap-4 px-4 py-4 transition-colors hover:bg-slate-50 sm:px-5"
    >
      <span className="relative flex h-10 w-[52px] shrink-0 items-center" aria-hidden>
        <span className="absolute left-0">{z ? <TokenLogo id="zec" size={32} /> : <PairLogo pair={pair} size={32} />}</span>
        <span className="absolute left-5 rounded-full bg-white p-[2px]">{z ? <PairLogo pair={pair} size={30} /> : <TokenLogo id="zec" size={30} />}</span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium break-words text-slate-900 tabular-nums">
          {z ? a.zec : a.coin} <span className="text-slate-400">→</span> <span className="whitespace-nowrap">{z ? a.coin : a.zec}</span>
        </span>
        <span className="mt-0.5 block truncate text-[13px] text-slate-500">
          <span className="font-medium text-slate-700">{z ? "Sell ZEC" : "Buy ZEC"}</span>
          {" · "}
          {started ? new Date(started).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "–"}
          <span className="hidden sm:inline"> · {pairName(pair).title}</span>
        </span>
      </span>
      <ToneBadge tone={st.tone}>{st.label}</ToneBadge>
      <ArrowRight size={14} weight="bold" className="hidden shrink-0 text-slate-400 transition-colors group-hover:text-slate-900 sm:block" aria-hidden />
    </a>
  );
}

// A private swap: what went in and what came out (or the ZEC held), "Private swap", its status.
function RouteRow({ route: v }: { route: RouteView }) {
  const a = routeAmounts(v);
  const st = ROUTE_WORD(v);
  const out = v.state === "holding" ? zecText(v.zec.held_zat) : a.got != null ? a.outShort : tickerOf(v.to);
  const started = new Date(v.created_at * 1000);
  return (
    <a
      href={`/app/route/${v.id}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(`/app/route/${v.id}`);
      }}
      className="group flex items-center gap-4 px-4 py-4 transition-colors hover:bg-slate-50 sm:px-5"
    >
      <span className="relative flex h-10 w-[52px] shrink-0 items-center" aria-hidden>
        <span className="absolute left-0">
          <PairLogo pair={v.from as PairId} size={32} />
        </span>
        <span className="absolute left-5 rounded-full bg-white p-[2px]">
          <PairLogo pair={v.to as PairId} size={30} />
        </span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium break-words text-slate-900 tabular-nums">
          {a.inShort} <span className="text-slate-400">→</span> <span className="whitespace-nowrap">{out}</span>
        </span>
        <span className="mt-0.5 block truncate text-[13px] text-slate-500">
          <span className="font-medium text-slate-700">Private swap</span>
          {" · "}
          {started.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          <span className="hidden sm:inline">
            {" "}
            · {tickerOf(v.from)} → shielded ZEC → {tickerOf(v.to)}
          </span>
        </span>
      </span>
      <ToneBadge tone={st.tone}>{st.label}</ToneBadge>
      <ArrowRight size={14} weight="bold" className="hidden shrink-0 text-slate-400 transition-colors group-hover:text-slate-900 sm:block" aria-hidden />
    </a>
  );
}

// A private swap with NEAR Intents at an end: what went in, what came out, "Private swap · via NEAR
// Intents", its status.
function ComboRow({ job: j }: { job: ComboJob }) {
  const st = comboWord(j);
  const started = new Date(j.created_at * 1000);
  const logo = (side: "in" | "out", size: number) => {
    const a = side === "in" ? j.asset_in : j.asset_out;
    return a ? <NearTokenLogo symbol={a.symbol} chain={a.blockchain} size={size} /> : <PairLogo pair={side === "in" ? j.from : j.to} size={size} />;
  };
  const inText = j.front && j.asset_in ? nearText(j.front.amount_in, j.asset_in) : j.route.paid != null ? unitsText(j.route.paid, j.from) : j.route.in_max != null ? unitsText(j.route.in_max, j.from) : comboIn(j);
  return (
    <a
      href={`/app/combo/${j.id}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(`/app/combo/${j.id}`);
      }}
      className="group flex items-center gap-4 px-4 py-4 transition-colors hover:bg-slate-50 sm:px-5"
    >
      <span className="relative flex h-10 w-[52px] shrink-0 items-center" aria-hidden>
        <span className="absolute left-0">{logo("in", 32)}</span>
        <span className="absolute left-5 rounded-full bg-white p-[2px]">{logo("out", 30)}</span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium break-words text-slate-900 tabular-nums">
          {inText} <span className="text-slate-400">→</span> <span className="whitespace-nowrap">{comboGot(j) ?? comboOut(j)}</span>
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1 truncate text-[13px] text-slate-500">
          <span className="font-medium text-slate-700">Private swap</span>
          <span aria-hidden>·</span>
          <NearMark size={12} />
          <span>via NEAR Intents</span>
          <span className="hidden sm:inline"> · {started.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
        </span>
      </span>
      <ToneBadge tone={st.tone}>{st.label}</ToneBadge>
      <ArrowRight size={14} weight="bold" className="hidden shrink-0 text-slate-400 transition-colors group-hover:text-slate-900 sm:block" aria-hidden />
    </a>
  );
}

// A NEAR Intents swap: shielded ZEC for an asset (or the other way), "via NEAR Intents", its status.
function NearRow({ job: j }: { job: NearJob }) {
  const st = nearWord(j);
  const sell = j.kind === "sell";
  const started = new Date(j.created_at * 1000);
  const token = <NearTokenLogo symbol={j.asset.symbol} chain={j.asset.blockchain} size={30} />;
  return (
    <a
      href={`/app/near/${j.id}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(`/app/near/${j.id}`);
      }}
      className="group flex items-center gap-4 px-4 py-4 transition-colors hover:bg-slate-50 sm:px-5"
    >
      <span className="relative flex h-10 w-[52px] shrink-0 items-center" aria-hidden>
        <span className="absolute left-0">{sell ? <TokenLogo id="zec" size={32} /> : <NearTokenLogo symbol={j.asset.symbol} chain={j.asset.blockchain} size={32} />}</span>
        <span className="absolute left-5 rounded-full bg-white p-[2px]">{sell ? token : <TokenLogo id="zec" size={30} />}</span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium break-words text-slate-900 tabular-nums">
          {jobIn(j)} <span className="text-slate-400">→</span> <span className="whitespace-nowrap">{j.state === "done" || !sell ? jobOut(j) : `${j.asset.symbol}`}</span>
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1 truncate text-[13px] text-slate-500">
          <span className="font-medium text-slate-700">{sell ? "Sell ZEC" : "Buy ZEC"}</span>
          <span aria-hidden>·</span>
          <NearMark size={12} />
          <span>via NEAR Intents</span>
          <span className="hidden sm:inline">
            {" "}
            · {chainName(j.asset.blockchain)} · {started.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </span>
        </span>
      </span>
      <ToneBadge tone={st.tone}>{st.label}</ToneBadge>
      <ArrowRight size={14} weight="bold" className="hidden shrink-0 text-slate-400 transition-colors group-hover:text-slate-900 sm:block" aria-hidden />
    </a>
  );
}
