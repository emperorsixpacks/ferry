import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CaretDown, Check, MagnifyingGlass } from "@phosphor-icons/react";
import { PAIR_IDS, pairChain, pairCoin, type Direction, type NearToken, type PairId, type Role } from "@/api";
import { CHAIN_NAMES, amountIn, coinInfo } from "@/format";
import { useLocal } from "../lib/daemon";
import { bestMaker, forPair, ownQuote, partnersOffline, quoteOf, type Makers } from "../lib/makers";
import { FERRY_CHAIN_IDS, chainName as nearChainName, nearAmount, useNear, useRowQuote } from "../lib/near";
import { isOffline, pairName } from "../lib/pairs";
import { ZEC, isNear, nearToken, present, resolvePath, storePick, tickerOf, type Pick, type PathCtx, type Side, type Token } from "../lib/paths";
import { cn } from "../lib/utils";
import { ChainLogo, Monogram, NearMark, NearTokenLogo, PairLogo, TokenLogo, type ChainMarkId } from "./Logos";
import { Sheet, arrowKeys } from "./ui/sheet";

export { NearMark };

// "Select a token": one picker for either side of the swap card. Shielded ZEC on top, then Ferry's
// own coins this server swaps or routes through, then "More via NEAR Intents": its assets on every
// chain it reaches (a "More chains" chip opens the rest), then Ferry's other coins, "not available
// here". Every row can be picked; the card says why a pick can't run. Filtered by chain or a search.
//
// Any coin this server does something with can be picked on either side. A row says, in a few
// words, how it goes with the coin on the other side ("privately, through ZEC", "not with BTC
// here"); the card says the rest. Picking the other side's coin swaps the two, as the arrow does.
// With ZEC on the other side, a NEAR row carries a composed quote for the amount on the card.

const FILTERS: { id: "all" | ChainMarkId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "bitcoin", label: "Bitcoin" },
  { id: "litecoin", label: "Litecoin" },
  { id: "ethereum", label: "Ethereum" },
  { id: "base", label: "Base" },
  { id: "arbitrum", label: "Arbitrum" },
  { id: "optimism", label: "Optimism" },
];

// a coin on a picker row: shielded ZEC or a pair
type RowId = "zec" | PairId;

const chainMark = (id: PairId): ChainMarkId => (id === "btc" ? "bitcoin" : id === "ltc" ? "litecoin" : pairChain(id)!);
const assetName = (id: PairId) => ({ btc: "Bitcoin", ltc: "Litecoin", usdc: "USD Coin", weth: "Wrapped Ether" })[pairCoin(id)];
const chainName = (id: PairId) => (pairChain(id) ? CHAIN_NAMES[pairChain(id)!] : assetName(id));
// "Bitcoin", "USD Coin · Base", "Wrapped Ether · Arbitrum"
export const tokenSubtitle = (id: PairId) => (pairChain(id) ? `${assetName(id)} · ${chainName(id)}` : assetName(id));

// One row of the sheet. `sub` replaces the coin's subtitle. `off`: this server doesn't swap the coin
// (it is listed under "Not available here", with these words); `can`: it can be picked all the same
// (the swap card then says why it can't run), or not at all (dimmed). A coin this server swaps whose
// daemon, or every partner for it, isn't answering stays where it is, says "Partner offline" and shows
// no rate, and is back to normal once it answers.
export interface TokenRow {
  id: RowId;
  can: boolean;
  sub?: string;
  off?: string;
  rate?: number;
}

function matches(id: RowId, q: string): boolean {
  if (id === "zec") return ["zec", "zcash", "shielded"].some((s) => s.includes(q) || q.includes(s));
  const n = pairName(id);
  return [n.title, n.ticker, n.noun, assetName(id), chainName(id), pairCoin(id) === "weth" ? "eth ether" : ""].some((s) => s.toLowerCase().includes(q));
}

// NEAR Intents' assets for the picker: `tokens` already leave out what Ferry swaps here itself.
export interface NearSection {
  tokens: NearToken[];
  // a row's quote: ZEC sold (sell) or bought (buy) for it, when ZEC is on the other side; else none
  dir: Direction | null;
  zat: number;
  selected: string | null;
  // the other side's asset: picking it swaps the two
  other: string | null;
  onPick: (assetId: string) => void;
  // what a NEAR row means here, in a sentence
  intro: string;
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

export function TokenSheet({ open, onClose, rows, selected, onPick, label = "Tokens", near }: { open: boolean; onClose: () => void; rows: TokenRow[]; selected: RowId | null; onPick: (id: RowId) => void; label?: string; near?: NearSection | null }) {
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
    // what this server swaps first, in the order given
    return [...list.filter((r) => !r.off), ...list.filter((r) => r.off)];
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

  const pick = (id: RowId) => {
    onPick(id);
    onClose();
  };
  const focusRow = shown.find((r) => r.id === selected && r.can)?.id ?? shown.find((r) => r.can && !r.off)?.id;
  const firstOff = shown.findIndex((r) => !!r.off);
  const can = shown.filter((r) => !r.off);
  // the coins Ferry has no node for here, listed so people see what exists (and, on the swap card,
  // can still pick one to see why it can't run)
  const offGroup =
    firstOff >= 0 ? (
      <div role="group" aria-labelledby="tokens-off">
        <p id="tokens-off" className={cn("px-3 pb-1.5 text-xs font-medium text-slate-500", firstOff > 0 || near ? "pt-4" : "pt-1")}>
          Not available here
        </p>
        {shown
          .filter((r) => r.off)
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
            {/* shielded ZEC and Ferry's own coins; with NEAR Intents here, the ones it can't swap here move below NEAR's */}
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
                  {near.intro} That part is public.
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

// One NEAR Intents asset: its mark and chain, a "via NEAR Intents" tag, and, with ZEC on the other
// side, what the card's ZEC comes to (selling) or costs (buying), from a dry quote asked once the
// row is on screen.
function NearRow({ token: t, near, focus, onPick }: { token: NearToken; near: NearSection; focus: boolean; onPick: (assetId: string) => void }) {
  const q = useRowQuote(near.dir ?? "sell", near.dir ? near.zat : 0, t.assetId);
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
          {near.other === t.assetId ? " · switches the two sides" : near.off ? " · on your own node" : ""}
        </span>
      </span>
      {near.dir ? (
        <span className="shrink-0 text-right">
          <span className={cn("block text-sm tabular-nums", amount ? "text-slate-900" : "text-slate-400")}>{amount ? `≈ ${nearAmount(amount, t.decimals)}` : q.error ? "–" : "…"}</span>
          <span className="block text-xs text-slate-500">{q.error ? "no quote now" : `${near.dir === "sell" ? "for" : "buys"} ${zec} ZEC`}</span>
        </span>
      ) : null}
      {selected ? <Check size={18} weight="bold" className="shrink-0 text-slate-900" aria-hidden /> : <span className="w-[18px] shrink-0" aria-hidden />}
    </button>
  );
}

function Row({ row, selected, focus, phone, onPick }: { row: TokenRow; selected: boolean; focus: boolean; phone: boolean; onPick: (id: RowId) => void }) {
  const { id, can, rate } = row;
  const zec = id === "zec";
  const ticker = zec ? "ZEC" : pairName(id).ticker;
  const sub = row.off ? `${zec ? "Zcash" : chainName(id)} · ${row.off}` : (row.sub ?? (zec ? "Zcash · shielded" : tokenSubtitle(id)));
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
        <span className="block truncate text-[13px] text-slate-500">{sub}</span>
      </span>
      {can && !row.off && rate != null && !zec ? (
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

// The landing page's coin picker: the coin side of a ZEC swap in the direction on screen, Ferry's
// own coins only; the pick carries over to /app.
export function TokenPicker({ open, onClose, makers, role }: { open: boolean; onClose: () => void; makers: Makers; role: Role }) {
  const { pairs, pair, choosePair, status, dir } = useLocal();
  const rows = useMemo(
    () =>
      PAIR_IDS.map((id): TokenRow => {
        const p = pairs.find((x) => x.id === id);
        const can = !!p?.[dir].daemon;
        const otherWay = !!p?.[dir === "sell" ? "buy" : "sell"].daemon;
        if (can && (isOffline(p?.[dir]) || partnersOffline(makers, id, pair, role))) return { id, can, sub: `${tokenSubtitle(id)} · Partner offline` };
        let rate: number | undefined;
        if (can && makers.list === null && id === pair && status) rate = ownQuote(status).rate;
        else if (can && makers.list) {
          const best = bestMaker(makers.list.filter((m) => m.available && (m.role == null || m.role !== role) && forPair(m, id, pair)), 1e8, role);
          rate = best ? quoteOf(best)?.rate : undefined;
        }
        return { id, can, rate, off: can ? undefined : otherWay ? `only for ${dir === "buy" ? "selling" : "buying"} ZEC here` : "not available here" };
      }),
    [pairs, dir, makers.list, pair, status, role],
  );
  return (
    <TokenSheet
      open={open}
      onClose={onClose}
      rows={rows}
      selected={pair}
      onPick={(id) => {
        if (id === "zec") return;
        choosePair(id);
        storePick(dir === "sell" ? { sell: ZEC, buy: id } : { sell: id, buy: ZEC });
      }}
    />
  );
}

// The one picker, for the side of the card it opened from (`side`), with `pick` on the card.
// `zat`: the ZEC on the card, for the NEAR rows' quotes when ZEC is on the other side.
export function CoinPicker({ open, onClose, side, pick, ctx, makers, zat = 1e8, onPick }: { open: boolean; onClose: () => void; side: Side; pick: Pick; ctx: PathCtx; makers?: Makers; zat?: number; onPick: (t: Token) => void }) {
  const { pair: onScreen, status, pairs } = useLocal();
  const nearCtx = useNear();
  const current = side === "sell" ? pick.sell : pick.buy;
  const other = side === "sell" ? pick.buy : pick.sell;
  const withZec = other === ZEC;
  const otherName = tickerOf(other, ctx);
  // with ZEC on the other side: the coin's daemon that way, or every partner for it, isn't answering
  const offline = (id: PairId): boolean => {
    if (!withZec) return false;
    const dir: Direction = side === "buy" ? "sell" : "buy";
    return isOffline(pairs.find((p) => p.id === id)?.[dir]) || partnersOffline(makers, id, onScreen, side === "buy" ? "Z" : "B");
  };

  // with ZEC on the other side, each coin's best rate for 1 ZEC from the partners that take swaps now
  const rates = useMemo(() => {
    const out: Partial<Record<PairId, number>> = {};
    if (!withZec || !makers) return out;
    // the role you take: selling ZEC (Z) when the coin is what you get, else buying it (B)
    const role: Role = side === "buy" ? "Z" : "B";
    for (const id of PAIR_IDS) {
      if (makers.list === null) {
        if (id === onScreen && status) out[id] = ownQuote(status).rate;
        continue;
      }
      const usable = (makers.list ?? []).filter((m) => m.available && (m.role == null || m.role !== role) && forPair(m, id, onScreen));
      const best = bestMaker(usable, 1e8, role);
      if (best) out[id] = quoteOf(best)!.rate;
    }
    return out;
  }, [withZec, makers, side, onScreen, status]);

  // how a coin goes with the other side's, in a few words
  const hint = (t: Token): string | null => {
    if (t === other) return "switches the two sides";
    const p = side === "sell" ? resolvePath(t, other, ctx) : resolvePath(other, t, ctx);
    if (p.available === false) return `not with ${otherName} here`;
    if (p.private) return "privately, through ZEC";
    return null;
  };

  const rows = useMemo((): TokenRow[] => {
    const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(" · ");
    const zec: TokenRow = { id: "zec", can: true, sub: join("Zcash · shielded", hint(ZEC)) };
    // a coin this server doesn't swap at all is listed apart, and can still be picked: the card
    // then says why it can't run
    const coins = PAIR_IDS.map((id): TokenRow =>
      !present(ctx, id) ? { id, can: true, off: "not available here" } : offline(id) ? { id, can: true, sub: join(tokenSubtitle(id), "Partner offline") } : { id, can: true, sub: join(tokenSubtitle(id), hint(id)), rate: rates[id] },
    );
    return [zec, ...coins];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, rates, side, other, pairs, makers, onScreen]);

  // NEAR Intents' assets, without the coins Ferry swaps here itself (those are above)
  const near = useMemo((): NearSection | null => {
    if (!nearCtx.info?.available) return null;
    const here = new Set(PAIR_IDS.filter((p) => present(ctx, p)));
    const tokens = nearCtx.tokens.filter((t) => !(t.ferry && here.has(t.ferry)));
    if (!tokens.length) return null;
    const dir: Direction | null = withZec ? (side === "buy" ? "sell" : "buy") : null;
    const runs = dir ? nearCtx.runs(dir) : !!nearCtx.info.compose?.runs;
    const off = runs ? null : nearCtx.info.reason === "mainnet" ? "Quotes only: NEAR Intents runs on mainnet, and this node is on a test network." : "Quotes only here: NEAR Intents swaps run on your own node, on mainnet.";
    const intro = withZec
      ? side === "buy"
        ? "Ferry sells your ZEC for a coin it swaps, and NEAR Intents carries it on."
        : "NEAR Intents turns your coin into one Ferry swaps, and Ferry buys the ZEC."
      : side === "buy"
        ? "Your coin goes privately through shielded ZEC, then NEAR Intents carries it on."
        : "NEAR Intents brings your coin in, then it goes privately through shielded ZEC.";
    return {
      tokens,
      dir,
      zat: zat > 0 ? zat : 1e8,
      selected: isNear(current) ? current.slice(5) : null,
      other: isNear(other) ? other.slice(5) : null,
      onPick: (id) => onPick(nearToken(id)),
      intro,
      off,
    };
  }, [nearCtx, ctx, withZec, side, zat, current, other, onPick]);

  return <TokenSheet open={open} onClose={onClose} rows={rows} selected={isNear(current) ? null : (current as RowId)} onPick={(id) => onPick(id)} near={near} />;
}
