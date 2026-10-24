import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CaretDown, Check, MagnifyingGlass } from "@phosphor-icons/react";
import { PAIR_IDS, pairChain, pairCoin, type Direction, type NearToken, type PairId, type Role } from "@/api";
import { CHAIN_NAMES, amountIn, coinInfo } from "@/format";
import { useLocal } from "../lib/daemon";
import { bestMaker, forPair, ownQuote, quoteOf, type Makers } from "../lib/makers";
import { FERRY_CHAIN_IDS, chainName as nearChainName, nearAmount, useNear, useRowQuote } from "../lib/near";
import { pairName } from "../lib/pairs";
import { canRoute, tickerOf, useRoutes } from "../lib/routes";
import { cn } from "../lib/utils";
import { ChainLogo, Monogram, NearTokenLogo, PairLogo, TokenLogo, type ChainMarkId } from "./Logos";
import { Sheet, arrowKeys } from "./ui/sheet";

// "Select a token": every coin Ferry can swap ZEC for, filtered by chain or by a search. A row is
// one pair (USDC on Base, ETH on Arbitrum); pairs this server has no Ferry node for in the
// direction on screen are listed dimmed ("only for selling ZEC here", "not available here"), so
// people see what exists without being able to pick it.
//
// With a router (private swaps), the ZEC side of the card opens a picker too: shielded ZEC on top,
// then the coins that can go through it to (or come from) the coin on the other side.
//
// With NEAR Intents on the server, the coin picker ends with "More via NEAR Intents": its assets on
// every chain it reaches (a "More chains" chip opens the rest), each with a composed quote for the
// amount on the card. Ferry's own coins stay first and unchanged; a NEAR row carries a small "via
// NEAR Intents" tag, and on a server that doesn't run NEAR swaps it says they run on your own node.

const FILTERS: { id: "all" | ChainMarkId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "bitcoin", label: "Bitcoin" },
  { id: "litecoin", label: "Litecoin" },
  { id: "ethereum", label: "Ethereum" },
  { id: "base", label: "Base" },
  { id: "arbitrum", label: "Arbitrum" },
  { id: "optimism", label: "Optimism" },
];

// a coin on the card: shielded ZEC or a pair
export type Token = "zec" | PairId;

const chainMark = (id: PairId): ChainMarkId => (id === "btc" ? "bitcoin" : id === "ltc" ? "litecoin" : pairChain(id)!);
const assetName = (id: PairId) => ({ btc: "Bitcoin", ltc: "Litecoin", usdc: "USD Coin", weth: "Wrapped Ether" })[pairCoin(id)];
const chainName = (id: PairId) => (pairChain(id) ? CHAIN_NAMES[pairChain(id)!] : assetName(id));
// "Bitcoin", "USD Coin · Base", "Wrapped Ether · Arbitrum"
export const tokenSubtitle = (id: PairId) => (pairChain(id) ? `${assetName(id)} · ${chainName(id)}` : assetName(id));

// One row of the sheet. `sub` replaces the coin's subtitle; `off` says why it can't be picked.
export interface TokenRow {
  id: Token;
  can: boolean;
  sub?: string;
  off?: string;
  rate?: number;
}

function matches(id: Token, q: string): boolean {
  if (id === "zec") return ["zec", "zcash", "shielded"].some((s) => s.includes(q) || q.includes(s));
  const n = pairName(id);
  return [n.title, n.ticker, n.noun, assetName(id), chainName(id), pairCoin(id) === "weth" ? "eth ether" : ""].some((s) => s.toLowerCase().includes(q));
}

// NEAR Intents' assets for the coin picker: `tokens` already leave out what Ferry swaps here itself.
export interface NearSection {
  tokens: NearToken[];
  dir: Direction;
  // the ZEC on the card, for each row's quote
  zat: number;
  selected: string | null;
  onPick: (assetId: string) => void;
  // NEAR swaps don't run on this server: why, in a few words
  off: string | null;
}

// a chip: one of the card's chains, or another chain NEAR Intents reaches ("near:sol")
type Filter = (typeof FILTERS)[number]["id"] | `near:${string}`;

// the coins people look for first, then the rest by name
const POPULAR = ["USDT", "USDC", "ETH", "SOL", "BTC", "wNEAR", "BNB", "XRP", "DOGE", "TRX", "TON", "SUI", "ADA", "AVAX", "POL", "DAI"];
const rank = (t: NearToken) => {
  const i = POPULAR.indexOf(t.symbol);
  return i < 0 ? POPULAR.length : i;
};

function nearMatches(t: NearToken, q: string): boolean {
  return [t.symbol, nearChainName(t.blockchain), t.blockchain, t.contractAddress ?? ""].some((s) => s.toLowerCase().includes(q));
}

export function TokenSheet({ open, onClose, rows, selected, onPick, label = "Tokens", near }: { open: boolean; onClose: () => void; rows: TokenRow[]; selected: Token | null; onPick: (id: Token) => void; label?: string; near?: NearSection | null }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [more, setMore] = useState(false);
  const [query, setQuery] = useState("");
  const phone = typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches;
  // each opening starts from the whole list
  useEffect(() => {
    if (!open) return;
    setFilter("all");
    setMore(false);
    setQuery("");
  }, [open]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (filter.startsWith("near:")) return [];
    const list = rows.filter((r) => (filter === "all" || (r.id !== "zec" && chainMark(r.id) === filter)) && (!q || matches(r.id, q)));
    // what can be picked first, in the order given
    return [...list.filter((r) => r.can), ...list.filter((r) => !r.can)];
  }, [rows, filter, query]);

  // the chains NEAR Intents reaches besides the card's own, most tokens first
  const moreChains = useMemo(() => {
    const own = new Set(Object.values(FERRY_CHAIN_IDS));
    const count = new Map<string, number>();
    for (const t of near?.tokens ?? []) if (!own.has(t.blockchain)) count.set(t.blockchain, (count.get(t.blockchain) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1] || nearChainName(a[0]).localeCompare(nearChainName(b[0]))).map(([c]) => c);
  }, [near?.tokens]);

  const nearShown = useMemo(() => {
    if (!near) return [];
    const q = query.trim().toLowerCase();
    const chain = filter === "all" ? null : filter.startsWith("near:") ? filter.slice(5) : FERRY_CHAIN_IDS[filter];
    return near.tokens
      .filter((t) => (!chain || t.blockchain === chain) && (!q || nearMatches(t, q)))
      .sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol) || nearChainName(a.blockchain).localeCompare(nearChainName(b.blockchain)));
  }, [near, filter, query]);

  const pick = (id: Token) => {
    onPick(id);
    onClose();
  };
  const focusRow = shown.find((r) => r.id === selected && r.can)?.id ?? shown.find((r) => r.can)?.id;
  const firstOff = shown.findIndex((r) => !r.can);
  const can = shown.filter((r) => r.can);
  // the coins Ferry has no node for here, dimmed so people see what exists
  const offGroup =
    firstOff >= 0 ? (
      <div role="group" aria-labelledby="tokens-off">
        <p id="tokens-off" className={cn("px-3 pb-1.5 text-xs font-medium text-slate-500", firstOff > 0 || near ? "pt-4" : "pt-1")}>
          Not available here
        </p>
        {shown
          .filter((r) => !r.can)
          .map((r) => (
            <Row key={r.id} row={r} selected={r.id === selected} focus={false} phone={phone} onPick={pick} />
          ))}
      </div>
    ) : null;

  return (
    <Sheet open={open} onClose={onClose} title="Select a token">
      <div className="px-5 pb-3">
        <label className="flex h-11 items-center gap-2.5 rounded-2xl border border-slate-200 bg-slate-50 px-3.5 transition-colors focus-within:border-slate-300 focus-within:bg-white">
          <MagnifyingGlass size={16} className="shrink-0 text-slate-500" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                document.querySelector<HTMLElement>('[data-token-list] [data-option]:not([aria-disabled="true"])')?.focus();
              }
            }}
            placeholder="Search by name or chain"
            aria-label="Search by name or chain"
            autoComplete="off"
            data-autofocus={phone ? undefined : true}
            className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-slate-900 placeholder:text-slate-500 focus:outline-none focus-visible:outline-none"
          />
        </label>
        <div role="group" aria-label="Filter by chain" className="mt-3 flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <Chip key={f.id} on={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.id !== "all" ? <ChainLogo id={f.id} size={16} /> : null}
              {f.label}
            </Chip>
          ))}
          {near && moreChains.length ? (
            <Chip on={filter.startsWith("near:")} expanded={more} onClick={() => setMore((m) => !m)}>
              More chains
              <CaretDown size={12} weight="bold" className={cn("transition-transform motion-reduce:transition-none", more && "rotate-180")} aria-hidden />
            </Chip>
          ) : null}
        </div>
        {near && more ? (
          <div role="group" aria-label="More chains, through NEAR Intents" className="mt-1.5 flex flex-wrap gap-1.5">
            {moreChains.map((c) => (
              <Chip key={c} on={filter === `near:${c}`} onClick={() => setFilter(filter === `near:${c}` ? "all" : `near:${c}`)}>
                <ChainDot chain={c} />
                {nearChainName(c)}
              </Chip>
            ))}
          </div>
        ) : null}
      </div>
      <div className="border-t border-slate-100 px-2 pt-2 pb-4">
        {shown.length === 0 && nearShown.length === 0 ? (
          <p className="px-3 py-10 text-center text-sm text-slate-500">Nothing matches{query.trim() ? ` “${query.trim()}”` : " on this chain"}.</p>
        ) : (
          <>
            {/* Ferry's own coins; with NEAR Intents here, the ones it can't swap here move below NEAR's */}
            {shown.length && (!near || firstOff !== 0) ? (
              <div role="listbox" aria-label={label} data-token-list onKeyDown={arrowKeys}>
                <div role="group" aria-label="Available">
                  {can.map((r) => (
                    <Row key={r.id} row={r} selected={r.id === selected} focus={r.id === focusRow} phone={phone} onPick={pick} />
                  ))}
                </div>
                {!near ? offGroup : null}
              </div>
            ) : null}
            {near && nearShown.length ? (
              <section aria-labelledby="tokens-near" className={cn(can.length ? "mt-3 border-t border-slate-100 pt-3" : "pt-1")}>
                <div className="flex items-center gap-2 px-3 pb-1">
                  <NearMark size={16} />
                  <h3 id="tokens-near" className="text-xs font-medium text-slate-700">
                    More via NEAR Intents
                  </h3>
                </div>
                <p className="px-3 pb-2 text-xs text-slate-500">
                  {near.dir === "sell" ? "Ferry sells your ZEC for a coin it swaps, and NEAR Intents carries it on." : "NEAR Intents turns your coin into one Ferry swaps, and Ferry buys the ZEC."} That part is public.
                  {near.off ? ` ${near.off}` : ""}
                </p>
                <div role="listbox" aria-label="More via NEAR Intents" onKeyDown={arrowKeys}>
                  {nearShown.map((t, i) => (
                    <NearRow
                      key={t.assetId}
                      token={t}
                      near={near}
                      focus={!can.length && i === 0}
                      onPick={(id) => {
                        near.onPick(id);
                        onClose();
                      }}
                    />
                  ))}
                </div>
              </section>
            ) : null}
            {near && firstOff >= 0 ? (
              <div role="listbox" aria-label="Not available here" onKeyDown={arrowKeys} className={cn((can.length || nearShown.length) && "mt-3 border-t border-slate-100 pt-1")}>
                {offGroup}
              </div>
            ) : null}
          </>
        )}
      </div>
    </Sheet>
  );
}

function Chip({ on, expanded, onClick, children }: { on: boolean; expanded?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={expanded === undefined ? on : undefined}
      aria-expanded={expanded}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[13px] transition-colors",
        on ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
      )}
    >
      {children}
    </button>
  );
}

// a chain NEAR Intents reaches, as a small mark
function ChainDot({ chain }: { chain: string }) {
  const sym: Record<string, string> = { sol: "SOL", near: "NEAR", bsc: "BNB", tron: "TRX", xrp: "XRP", doge: "DOGE", ton: "TON", sui: "SUI", aptos: "APT", cardano: "ADA", stellar: "XLM", avax: "AVAX", pol: "POL", bch: "BCH" };
  return <Monogram symbol={sym[chain] ?? chain.toUpperCase()} size={16} />;
}

// NEAR Intents, as a small mark: an N in a dark disc (not its logo)
export function NearMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} className={cn("shrink-0", className)} aria-hidden>
      <rect width="32" height="32" rx="9" fill="#18181b" />
      <path d="M10 23V9h2.6l6.8 9.6V9H22v14h-2.6l-6.8-9.6V23z" fill="#fff" />
    </svg>
  );
}

// One NEAR Intents asset: its mark and chain, a "via NEAR Intents" tag, and what the card's ZEC
// comes to (selling) or costs (buying), from a dry quote asked once the row is on screen.
function NearRow({ token: t, near, focus, onPick }: { token: NearToken; near: NearSection; focus: boolean; onPick: (assetId: string) => void }) {
  const q = useRowQuote(near.dir, near.zat, t.assetId);
  const selected = near.selected === t.assetId;
  const amount = q.quote ? (near.dir === "sell" ? q.quote.near.amount_out : q.quote.near.amount_in) : null;
  const zec = (near.zat / 1e8).toFixed(4).replace(/0{1,2}$/, "");
  return (
    <button
      ref={q.ref}
      type="button"
      role="option"
      data-option
      data-near-row
      aria-selected={selected}
      tabIndex={focus || selected ? 0 : -1}
      onClick={() => onPick(t.assetId)}
      className={cn("flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors", selected ? "bg-slate-100" : "hover:bg-slate-50")}
    >
      <NearTokenLogo symbol={t.symbol} chain={t.blockchain} size={36} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-medium text-slate-900">{t.symbol}</span>
          <span className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full bg-slate-100 px-1.5 text-[10px] font-medium text-slate-600">
            <NearMark size={10} />
            via NEAR Intents
          </span>
        </span>
        <span className="block truncate text-[13px] text-slate-500">
          {nearChainName(t.blockchain)}
          {near.off ? " · on your own node" : ""}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className={cn("block text-sm tabular-nums", amount ? "text-slate-900" : "text-slate-400")}>{amount ? `≈ ${nearAmount(amount, t.decimals)}` : q.error ? "–" : "…"}</span>
        <span className="block text-xs text-slate-500">{q.error ? "no quote now" : `${near.dir === "sell" ? "for" : "buys"} ${zec} ZEC`}</span>
      </span>
      {selected ? <Check size={18} weight="bold" className="shrink-0 text-slate-900" aria-hidden /> : <span className="w-[18px] shrink-0" aria-hidden />}
    </button>
  );
}

function Row({ row, selected, focus, phone, onPick }: { row: TokenRow; selected: boolean; focus: boolean; phone: boolean; onPick: (id: Token) => void }) {
  const { id, can, rate } = row;
  const zec = id === "zec";
  const ticker = zec ? "ZEC" : pairName(id).ticker;
  const sub = row.sub ?? (zec ? "Zcash · shielded" : tokenSubtitle(id));
  const off = row.off ?? "not available here";
  return (
    <button
      type="button"
      role="option"
      data-option
      aria-selected={selected}
      aria-disabled={!can}
      tabIndex={focus ? 0 : -1}
      data-autofocus={phone && focus ? true : undefined}
      onClick={() => can && onPick(id)}
      className={cn("flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors", selected ? "bg-slate-100" : can ? "hover:bg-slate-50" : "cursor-not-allowed")}
    >
      {zec ? <TokenLogo id="zec" size={36} className={can ? undefined : "opacity-40 grayscale"} /> : <PairLogo pair={id} size={36} className={can ? undefined : "opacity-40 grayscale"} />}
      <span className="min-w-0 flex-1">
        <span className={cn("block font-medium", can ? "text-slate-900" : "text-slate-500")}>{ticker}</span>
        <span className="block truncate text-[13px] text-slate-500">{can ? sub : `${zec ? "Zcash" : chainName(id)} · ${off}`}</span>
      </span>
      {can && rate != null && !zec ? (
        <span className="shrink-0 text-right">
          <span className="block text-sm text-slate-900 tabular-nums">
            {amountIn(rate, coinInfo(pairCoin(id)))} {ticker}
          </span>
          <span className="block text-xs text-slate-500">per ZEC</span>
        </span>
      ) : null}
      {selected ? <Check size={18} weight="bold" className="shrink-0 text-slate-900" aria-hidden /> : <span className="w-[18px] shrink-0" aria-hidden />}
    </button>
  );
}

// The coin side of a ZEC swap: the pairs, those with a Ferry node for the direction on screen first,
// then NEAR Intents' assets when the server has it and `onNear` takes them. `nearSelected`: the NEAR
// asset on the card (then no pair is the selected one).
export function TokenPicker({
  open,
  onClose,
  makers,
  role,
  zat = 1e8,
  onNear,
  onPair,
  nearSelected = null,
}: {
  open: boolean;
  onClose: () => void;
  makers: Makers;
  role: Role;
  zat?: number;
  onNear?: (assetId: string) => void;
  onPair?: (id: PairId) => void;
  nearSelected?: string | null;
}) {
  const { pairs, pair, choosePair, status, dir } = useLocal();
  const nearCtx = useNear();

  // each pair's best rate for 1 ZEC, from the partners that take swaps now
  const rates = useMemo(() => {
    const out: Partial<Record<PairId, number>> = {};
    for (const id of PAIR_IDS) {
      if (makers.list === null) {
        if (id === pair && status) out[id] = ownQuote(status).rate;
        continue;
      }
      const usable = (makers.list ?? []).filter((m) => m.available && (m.role == null || m.role !== role) && forPair(m, id, pair));
      const best = bestMaker(usable, 1e8, role);
      if (best) out[id] = quoteOf(best)!.rate;
    }
    return out;
  }, [makers.list, pair, role, status]);

  const rows = useMemo(
    () =>
      PAIR_IDS.map((id): TokenRow => {
        const p = pairs.find((x) => x.id === id);
        const can = !!p?.[dir].daemon;
        const otherWay = !!p?.[dir === "sell" ? "buy" : "sell"].daemon;
        return { id, can, rate: can ? rates[id] : undefined, off: otherWay ? `only for ${dir === "buy" ? "selling" : "buying"} ZEC here` : "not available here" };
      }),
    [pairs, dir, rates],
  );

  // NEAR Intents' assets, without the coins Ferry swaps here itself this way (those are above)
  const near = useMemo((): NearSection | null => {
    if (!onNear || !nearCtx.info?.available) return null;
    const direct = new Set(pairs.filter((p) => p[dir].daemon).map((p) => p.id));
    const tokens = nearCtx.tokens.filter((t) => !(t.ferry && direct.has(t.ferry)));
    if (!tokens.length) return null;
    const off = nearCtx.runs(dir) ? null : nearCtx.info.reason === "mainnet" ? "Quotes only: NEAR Intents runs on mainnet, and this node is on a test network." : "Quotes only here: NEAR Intents swaps run on your own node, on mainnet.";
    return { tokens, dir, zat: zat > 0 ? zat : 1e8, selected: nearSelected, onPick: onNear, off };
  }, [onNear, nearCtx, pairs, dir, zat, nearSelected]);

  return (
    <TokenSheet
      open={open}
      onClose={onClose}
      rows={rows}
      selected={nearSelected ? null : pair}
      onPick={(id) => {
        if (id === "zec") return;
        choosePair(id);
        onPair?.(id);
      }}
      near={near}
    />
  );
}

// One side of a private swap, or the ZEC side of a ZEC swap when the server has a router: shielded
// ZEC on top (a plain ZEC swap with the coin on the other side, if this server does that one), then
// every coin that can go through ZEC to (selling) or come from (buying) the coin on the other side.
export function RoutePicker({
  open,
  onClose,
  side,
  current,
  other,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  // the panel it opened from: "sell" (Sell) or "buy" (Buy)
  side: Direction;
  current: Token;
  // the coin on the other panel
  other: PairId;
  onPick: (id: Token) => void;
}) {
  const { pairs } = useLocal();
  const { legs } = useRoutes();
  const rows = useMemo(() => {
    // ZEC here makes a plain swap: sell ZEC for `other` (this is Sell) or buy it with `other`
    const p = pairs.find((x) => x.id === other);
    const direct = !!p?.[side === "sell" ? "sell" : "buy"].daemon;
    const zec: TokenRow = { id: "zec", can: direct, sub: "Zcash · shielded", off: `not with ${tickerOf(other)} here` };
    const coins = PAIR_IDS.map((id): TokenRow => {
      const ok = side === "sell" ? canRoute(legs, id, other) : canRoute(legs, other, id);
      if (ok) return { id, can: true, sub: `${tokenSubtitle(id)} · privately, through ZEC` };
      const ends = side === "sell" ? legs?.from.includes(id) : legs?.to.includes(id);
      const off = id === other ? `already what you ${side === "sell" ? "get" : "sell"}` : ends && pairCoin(id) === pairCoin(other) ? `the same coin as you ${side === "sell" ? "get" : "sell"}` : `not with ${tickerOf(other)} here`;
      return { id, can: false, off };
    });
    return [zec, ...coins];
  }, [pairs, legs, side, other]);
  return <TokenSheet open={open} onClose={onClose} rows={rows} selected={current} onPick={onPick} />;
}
