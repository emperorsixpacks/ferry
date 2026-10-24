// Types and calls for the ferryd HTTP + SSE API (docs/API.md).

export type Role = "Z" | "B";
export type Outcome = "swapped" | "refunded" | "punished" | null;

export interface Status {
  role: Role;
  name: string;
  // btc_sat saturates at u64::MAX for an 18-decimal token; token_units (EVM) is the exact
  // balance as a decimal string. Read it with counterBalance().
  // eth_wei (EVM): the account's ETH for gas, as a decimal string.
  balances: { zec_shielded_zat: number; btc_sat: number; token_units?: string; eth_wei?: string };
  chains: {
    // the coin swapped against ZEC ("btc" | "ltc"); older daemons leave it out (btc)
    // coin "usdc": an EVM daemon (--counter evm); `time` is the latest block's unix time
    btc: { network: string; height: number; coin?: string; ticker?: string; decimals?: number; time?: number };
    zec: { network: string; height: number; pool: string };
  };
  offer: {
    pair: string;
    rate_sat_per_zec: number;
    min_zat: number;
    max_zat: number;
    // optional terms; older daemons leave them out and the UI falls back to defaults
    fee_sat?: number;
    t1_blocks?: number;
    t2_blocks?: number;
    btc_lock_confs?: number;
    zec_confs?: number;
    // a maker's live rate (--maker-price-feed): "fixed" or the feeds; unix seconds of the price
    rate_source?: string;
    rate_updated_at?: number;
    // the largest ZEC amount this party's balance covers as maker
    liquidity_zat?: number;
    paused?: boolean;
    // started with --maker-offer (older daemons leave it out)
    maker?: boolean;
  };
}

export interface TimelineEntry {
  at: string;
  chain: "local" | "btc" | "zec" | "peer";
  kind: string;
  label: string;
  txid: string | null;
  height: number | null;
}

export interface SwapView {
  id: string;
  coin?: string;
  role: Role;
  // this daemon started the swap (proposed to a maker); false: it is the maker. Older daemons
  // leave it out.
  taker?: boolean;
  counterparty: string;
  state: string;
  outcome: Outcome;
  amounts: { zec_zat: number; btc_sat: number };
  deadlines: {
    t1_blocks: number;
    t2_blocks: number;
    btc_lock_height: number | null;
    cancel_height: number | null;
    // EVM swaps: block-time deadlines (unix seconds) and the latest block time seen
    t1_unix?: number;
    t2_unix?: number;
    now_unix?: number;
  };
  keys: {
    my_share_point_pallas: string;
    my_share_point_secp: string;
    peer_share_point_pallas: string;
    peer_share_point_secp: string;
    dleq_verified: boolean;
    joint_ak: string;
    sigma: number;
  };
  addresses: { btc_lock: string; zec_joint: string };
  secrets: { mine_revealed: boolean; peer_learned: boolean };
  timeline: TimelineEntry[];
  observer: { btc: string[]; zec: string[] };
  /** Our package at the watchtower (ferryd --watchtower); absent without one. */
  watchtower?: { url: string; status: "pending" | "armed" | "refused"; package_id: string | null; note: string } | null;
  /** One of a private swap's two swaps: the router's label, "<route id>/1" or "<route id>/2". */
  route?: string | null;
}

export const DAEMONS: Record<Role, string> = { Z: "/daemon/z", B: "/daemon/b" };
// Which way the swap goes, for the person: selling shielded ZEC (their Z daemon takes from a B
// maker) or buying it (their B daemon takes from a Z maker).
export type Direction = "sell" | "buy";
export const roleOf = (dir: Direction): Role => (dir === "sell" ? "Z" : "B");
export const directionOf = (role: Role): Direction => (role === "Z" ? "sell" : "buy");
// a swap the person started, as opposed to one their daemon made as a maker (in a local demo the
// two parties are both "theirs")
export const isMine = (v: SwapView) => v.taker !== false;
// The counter-coin balance in base units: the exact token_units when the daemon sends it (a JS
// number above 2^53 rounds, which is fine for showing it).
export const counterBalance = (s: Status) => (s.balances.token_units != null ? Number(s.balances.token_units) : s.balances.btc_sat);
// What ZEC swaps against: a UTXO coin, or an ERC-20 on an EVM chain. One ferryd runs one pair;
// the UI server may front a daemon per pair (server/pairs.mjs), at /daemon/<pair>.
export type CoinId = "btc" | "ltc" | "usdc" | "weth";
export type ChainId = "base" | "ethereum" | "arbitrum" | "optimism";
export const EVM_TOKENS = ["usdc", "weth"] as const;
export const EVM_CHAINS: ChainId[] = ["base", "ethereum", "arbitrum", "optimism"];
export type PairId = "btc" | "ltc" | `${(typeof EVM_TOKENS)[number]}-${ChainId}`;
export const PAIR_IDS: PairId[] = ["btc", "ltc", ...EVM_TOKENS.flatMap((t) => EVM_CHAINS.map((c): PairId => `${t}-${c}`))];
export const pairDaemon = (id: PairId) => `/daemon/${id}`;
// a pair's buy-side (B) daemon, when the UI server fronts one besides the main B
export const pairBuyDaemon = (id: PairId) => `/daemon/b-${id}`;
export const pairCoin = (id: PairId) => id.split("-")[0] as CoinId;
export const pairChain = (id: PairId) => (id.split("-")[1] as ChainId | undefined) ?? null;
export const pairId = (coin: CoinId, chain: ChainId | null): PairId => (coin === "btc" || coin === "ltc" ? coin : `${coin}-${chain ?? "base"}`);
// The side the swap page starts on until the viewer flips it (the UI server's FERRY_LOCAL: z
// sells ZEC, b buys it). `?as=b` overrides it, as does a direction the viewer picked before.
export const LOCAL_ROLE: Role = (() => {
  const q = new URLSearchParams(window.location.search).get("as");
  const v = (q ?? __FERRY_LOCAL__).toUpperCase();
  return v === "B" ? "B" : "Z";
})();

async function call<T>(base: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(base + path, body === undefined ? undefined : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = (data as { error?: string }).error;
    if (res.status === 401) throw new Error("The daemon refused the API token. Start the UI from a shell that has sourced the .demo/env file infra/demo.sh wrote (cd web && source ../.demo/env && pnpm dev:ui), so the proxy can send FERRY_Z_TOKEN and FERRY_B_TOKEN.");
    if (error) throw new Error(error);
    // no JSON body: the dev proxy answering for a daemon that isn't running
    throw new Error(res.status >= 500 ? "Can't reach the daemon. Is it running?" : `${res.status} ${res.statusText}`);
  }
  return data as T;
}

// `daemon` is a base path: DAEMONS[role] or pairDaemon(id)
export const getStatus = (daemon: string) => call<Status>(daemon, "/api/status");
export const getSwaps = (daemon: string) => call<SwapView[]>(daemon, "/api/swaps");
// `maker` is a name from GET /api/makers; the UI server maps it to the maker's allowlisted URL
// (the browser never sends a URL). Left out, the server's first maker. `quote`: the id of that
// maker's firm price (POST /api/quotes), which the server forwards as the maker signed it. The
// same call sells ZEC on a Z daemon and buys it on a B daemon; the amount is the ZEC either way.
export const startSwap = (zec_zat: number, daemon: string = DAEMONS.Z, maker?: string, quote?: string) =>
  call<{ id: string }>(daemon, "/api/swaps", maker === undefined ? { zec_zat } : quote === undefined ? { maker, zec_zat } : { maker, zec_zat, quote });

// The daemons this UI server fronts (GET /api/pairs): which other pairs have a sell-side (Z)
// daemon at /daemon/<pair> or a buy-side (B) one at /daemon/b-<pair>, and whether the main Z
// (/daemon/z) and B (/daemon/b) take swaps, whatever pair they run.
export interface PairsInfo {
  sell: PairId[];
  buy: PairId[];
  // "auto": used unless the daemon's status says it is a maker (offer.maker)
  main: { sell: boolean | "auto"; buy: boolean | "auto" };
  // private swaps the server's router runs: from the pairs it buys ZEC with, to the ones it sells
  // ZEC for; null without a router (and then the page shows none of it)
  routes: RouteLegs | null;
}

export async function getPairs(): Promise<PairsInfo> {
  // an older server: no extra pairs, and the page's own side only
  const old: PairsInfo = { sell: [], buy: [], main: { sell: LOCAL_ROLE === "Z", buy: LOCAL_ROLE === "B" }, routes: null };
  const res = await fetch("/api/pairs").catch(() => null);
  if (!res?.ok) return old;
  const data = (await res.json().catch(() => null)) as { pairs?: unknown; buy?: unknown; main?: { sell?: unknown; buy?: unknown }; routes?: { from?: unknown; to?: unknown } | null } | null;
  const ids = (v: unknown) => (Array.isArray(v) ? PAIR_IDS.filter((id) => (v as unknown[]).includes(id)) : []);
  if (!data) return old;
  const side = (v: unknown) => (v === true || v === false || v === "auto" ? v : "auto");
  const routes = data.routes ? { from: ids(data.routes.from), to: ids(data.routes.to) } : null;
  return {
    sell: ids(data.pairs),
    buy: ids(data.buy),
    main: data.main ? { sell: side(data.main.sell), buy: side(data.main.buy) } : old.main,
    routes: routes && routes.from.length && routes.to.length ? routes : null,
  };
}

// ------------------------------------------------------------------------------------------------
// Private swaps (routes): coin A → shielded ZEC → coin C, run by the user's router (ferry-route,
// crates/ferry-route/README.md) as two swaps on their own daemons, one after the other. The UI
// server fronts it at /router, as it fronts the daemons.

export const ROUTER = "/router";

export interface RouteLegs {
  from: PairId[];
  to: PairId[];
}

export type RouteState = "leg1" | "settling" | "pausing" | "leg2" | "done" | "holding" | "failed";
export type RouteOutcome = "swapped" | "holding_zec" | "refunded" | "punished" | "not_started" | null;
// the privacy pause between the two swaps: off, 5–30 min, 1–6 h
export type Pause = "off" | "standard" | "long";

export interface RouteLeg {
  n: 1 | 2;
  pair: string;
  // leg 1: the user buys ZEC (B); leg 2: they sell it (Z)
  role: Role;
  unit: { ticker: string; decimals: number };
  wallet: string;
  maker: string | null;
  label: string | null;
  swap_id: string | null;
  // the leg's swap, as its daemon says (SwapView.state / outcome)
  state: string | null;
  outcome: string | null;
  zec_zat: number | null;
  counter_units: number | null;
  watchtower: { status?: string; note?: string } | null;
  earlier_swaps: string[];
}

export interface RouteView {
  id: string;
  from: string;
  to: string;
  state: RouteState;
  phase: string;
  outcome: RouteOutcome;
  amounts: { in_max: number; zec_zat: number; zec2_zat: number; out_min: number; keep_zat: number };
  privacy: { delay_secs: [number, number]; not_before: number | null };
  zec: { sweep_txid: string | null; sweep_confs: number; needed_confs: number; spendable_zat: number | null; need_zat: number; held_zat: number };
  legs: [RouteLeg, RouteLeg];
  timeline: { at: string; kind: string; label: string }[];
  // where the money is and what happens next, in the router's words
  note: string;
  problem: string | null;
  stop_requested: boolean;
  created_at: number;
  updated_at: number;
}

export const getRoutes = () => call<RouteView[]>(ROUTER, "/api/routes");
// Partners are named as for a swap; the UI server maps them to allowlisted URLs and adds leg 2's
// fallbacks. max_in / min_out are in the coins' smallest units.
export const startRoute = (body: { from: PairId; to: PairId; zec_zat: number; maker1: string; maker2: string[]; max_in: number; min_out: number; pause: Pause }) =>
  call<RouteView>(ROUTER, "/api/routes", body);
// "Finish now": out of holding, try the second swap again; during the pause, start it now
export const continueRoute = (id: string) => call<RouteView>(ROUTER, `/api/routes/${id}/continue`, {});

// One maker the UI server allowlists, with its live offer (GET /api/makers).
export interface Maker {
  index: number;
  name: string;
  pair: string;
  online: boolean;
  // online, making and not paused: it takes a swap now
  available: boolean;
  paused: boolean;
  role: Role | null;
  rate_sat_per_zec: number | null;
  min_zat: number | null;
  max_zat: number | null;
  fee_sat: number | null;
  liquidity_zat: number | null;
  rate_source: string | null;
  rate_updated_at: number | null;
  // seconds, as of the server's answer
  rate_age_s: number | null;
  // an EVM maker's chain (from its offer's network, or the operator's FERRY_MAKERS entry)
  chain?: ChainId | null;
}

// null: this server has no maker directory (an older server); the form then uses the daemon's offer
export async function getMakers(): Promise<Maker[] | null> {
  const res = await fetch("/api/makers");
  if (res.status === 404) return null;
  const data = (await res.json().catch(() => null)) as { makers?: Maker[] } | null;
  if (!res.ok || !Array.isArray(data?.makers)) throw new Error("Can't load the maker list");
  return data.makers;
}
export const injectStall = (role: Role, id: string) =>
  call<unknown>(DAEMONS[role], `/api/swaps/${id}/fault`, { fault: "stall" });

// ------------------------------------------------------------------------------------------------
// NEAR Intents (server/near.mjs): sell shielded ZEC for any of its assets, or buy shielded ZEC with
// them. Ferry swaps ZEC for a coin it supports; NEAR Intents (its 1Click API, called by the UI
// server only) carries that coin on. Amounts of NEAR Intents assets are base-unit decimal strings.

export interface NearToken {
  assetId: string;
  symbol: string;
  // 1Click's chain id: "sol", "eth", "base", "near", "btc", ...
  blockchain: string;
  decimals: number;
  price: number | null;
  contractAddress: string | null;
  // the Ferry pair it is, if Ferry swaps it itself
  ferry: PairId | null;
}

export interface NearInfo {
  available: boolean;
  // whether NEAR swaps run here, each way (the operator's own node, on mainnet)
  execution: { sell: boolean; buy: boolean };
  // why not: "demo" (a public demo: quotes only) or "mainnet" (the nodes are on test networks)
  reason: "demo" | "mainnet" | null;
  tokens: NearToken[];
  explorer: string;
}

export interface NearQuote {
  direction: Direction;
  zec_zat: number;
  asset: string;
  // the coin Ferry swaps ZEC for (sell) or with (buy), and the partner for it
  via: PairId;
  maker: string;
  ferry: { rate_sat_per_zec: number; counter: string; fee: string; units: string; time_s: number };
  near: {
    amount_in: string;
    amount_out: string;
    min_amount_out: string;
    max_amount_in: string | null;
    time_s: number;
    withdraw_fee: string | null;
    approximate: boolean;
    verified: boolean;
  };
  time_s: number;
  execution: boolean;
  reason: "demo" | "mainnet" | null;
  address: "ok" | null;
}

export type NearState = "deposit" | "near" | "funding" | "ferry" | "holding" | "done" | "refunded" | "failed" | "expired";

export interface NearTx {
  hash: string;
  url: string | null;
}

export interface NearJob {
  id: string;
  kind: Direction;
  state: NearState;
  outcome: string | null;
  created_at: number;
  updated_at: number;
  zec_zat: number;
  via: PairId;
  maker: string;
  asset: { id: string; symbol: string; blockchain: string; decimals: number };
  via_asset: { id: string; symbol: string; decimals: number };
  // sell: where NEAR Intents sends the asset; buy: where it refunds it
  address: string;
  // the user's own Ferry node's address for the coin between (a sell's refunds; a buy's delivery)
  own_address: string;
  ferry: { swap_id: string | null; state: string | null; outcome: Outcome; counter: string; counter_units?: string; zec_zat?: number; earlier: string[] };
  near: {
    deposit_address: string;
    deposit_memo: string | null;
    amount_in: string;
    min_amount_in: string;
    amount_out: string | null;
    min_amount_out: string;
    deadline: string;
    time_s: number | null;
    status: string;
    details: {
      amount_in: string | null;
      amount_out: string | null;
      deposited: string | null;
      refunded: string | null;
      refund_reason: string | null;
      origin_txs: NearTx[];
      destination_txs: NearTx[];
      near_txs: string[];
    } | null;
    correlation_id: string | null;
    verified: boolean;
    signature: string | null;
    timestamp: string | null;
  };
  problem: string | null;
  timeline: { at: string; kind: string; label: string }[];
  explorer: string;
}

// An error from a NEAR call: `field` "address" when it is about the address typed.
export class NearError extends Error {
  field: string | null;
  code: string | null;
  constructor(message: string, field: string | null = null, code: string | null = null) {
    super(message);
    this.field = field;
    this.code = code;
  }
}

async function near<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/near${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { error?: string; field?: string; code?: string };
  if (!res.ok) throw new NearError(data.error ?? (res.status >= 500 ? "Couldn't reach NEAR Intents. Try again in a moment." : `${res.status} ${res.statusText}`), data.field ?? null, data.code ?? null);
  return data as T;
}

// null: this server has no NEAR Intents (an older one, or FERRY_NEAR_QUOTES=0)
export async function getNearInfo(): Promise<NearInfo | null> {
  const res = await fetch("/api/near/tokens").catch(() => null);
  if (!res || !res.ok) return null;
  return (await res.json().catch(() => null)) as NearInfo | null;
}
// `exact`: the card's quote (the exact amount, and the address checked); else a picker row's
export const getNearQuote = (body: { direction: Direction; zec_zat: number; asset: string; address?: string; exact?: boolean }) => near<NearQuote>("/quote", body);
export const startNear = (body: { direction: Direction; zec_zat: number; asset: string; address: string; via: PairId; min_out?: string; max_in?: string }) => near<NearJob>("/swap", body);
export const getNearJobs = () => near<NearJob[]>("/jobs");
export const retryNear = (id: string) => near<NearJob>(`/jobs/${id}/retry`, {});
