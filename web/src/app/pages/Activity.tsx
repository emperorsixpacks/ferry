import { useEffect, useState } from "react";
import { ArrowRight, ArrowsLeftRight } from "@phosphor-icons/react";
import { getSwaps, pairChain, pairCoin, type PairId, type Status, type SwapView } from "@/api";
import { coin, coinOf } from "@/format";
import { navigate } from "@/router";
import { phaseOf } from "@/swap/steps";
import { Layout } from "../components/Layout";
import { PairLogo, TokenLogo } from "../components/Logos";
import { ToneBadge } from "../components/ui/badge";
import { useLocal } from "../lib/daemon";
import { pairName } from "../lib/pairs";
import { STATUS_WORD, swapAmounts, wordsFor, type Words } from "../lib/progress";

// /app/activity: every swap this party's Ferry nodes know, newest first, across the coins this
// server offers. A row opens the swap (switching the coin on screen first when it's another one).

const POLL_MS = 10_000;

interface Item {
  swap: SwapView;
  pair: PairId;
  status: Status | null;
  words: Words;
}

export function Activity() {
  const d = useLocal();
  const others = d.pairs.filter((p) => p.daemon && p.daemon !== d.daemon);
  const key = others.map((p) => p.daemon).join(",");
  const [extra, setExtra] = useState<Record<string, SwapView[]>>({});

  useEffect(() => {
    if (!others.length) return;
    let alive = true;
    const load = async () => {
      const got = await Promise.all(others.map((p) => getSwaps(p.daemon!).catch(() => [] as SwapView[])));
      if (alive) setExtra(Object.fromEntries(others.map((p, i) => [p.id, got[i]])));
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const items: Item[] = [
    ...d.list.map((swap) => ({ swap, pair: d.pair, status: d.status, words: wordsFor(coin()) })),
    ...others.flatMap((p) =>
      (extra[p.id] ?? []).map((swap) => ({
        swap,
        pair: p.id,
        status: p.status,
        words: wordsFor(coinOf(p.status ?? { chains: { btc: { coin: pairCoin(p.id) } } }, pairChain(p.id))),
      })),
    ),
  ].sort((x, y) => (y.swap.timeline[0]?.at ?? "").localeCompare(x.swap.timeline[0]?.at ?? ""));

  const open = (it: Item) => {
    if (it.pair !== d.pair) d.choosePair(it.pair);
    navigate(`/app/swap/${it.swap.id}`);
  };

  return (
    <Layout>
      <div className="mx-auto w-full max-w-[640px]">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Activity</h1>
        <p className="mt-1 text-slate-600">Your swaps, newest first.</p>
        {items.length === 0 ? (
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
            {items.map((it) => (
              <li key={`${it.pair}:${it.swap.id}`}>
                <Row item={it} onOpen={() => open(it)} />
              </li>
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
          {started ? new Date(started).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "–"}
          <span className="hidden sm:inline"> · {pairName(pair).title}</span>
        </span>
      </span>
      <ToneBadge tone={st.tone}>{st.label}</ToneBadge>
      <ArrowRight size={14} weight="bold" className="hidden shrink-0 text-slate-400 transition-colors group-hover:text-slate-900 sm:block" aria-hidden />
    </a>
  );
}
