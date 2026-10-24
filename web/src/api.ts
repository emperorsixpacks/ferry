// Types and calls for the ferryd HTTP + SSE API (docs/API.md).

export type Role = "Z" | "B";
export type Outcome = "swapped" | "refunded" | "punished" | null;

export interface Status {
  role: Role;
  name: string;
  balances: { zec_shielded_zat: number; btc_sat: number };
  chains: {
    // the coin swapped against ZEC ("btc" | "ltc"); older daemons leave it out (btc)
    // coin "usdc": an EVM daemon (--counter evm); `time` is the latest block's unix time
    btc: { network: string; height: number; coin?: "btc" | "ltc" | "usdc"; ticker?: string; decimals?: number; time?: number };
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
  coin?: "btc" | "ltc" | "usdc";
  role: Role;
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
}

export const DAEMONS: Record<Role, string> = { Z: "/daemon/z", B: "/daemon/b" };
// Which party this browser is: the swap app shows only that side. `?as=b` overrides it.
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

export const getStatus = (role: Role) => call<Status>(DAEMONS[role], "/api/status");
export const getSwaps = (role: Role) => call<SwapView[]>(DAEMONS[role], "/api/swaps");
// `maker` is a name from GET /api/makers; the UI server maps it to the maker's allowlisted URL
// (the browser never sends a URL). Left out, the server's first maker.
export const startSwap = (zec_zat: number, as: Role = "Z", maker?: string) =>
  call<{ id: string }>(DAEMONS[as], "/api/swaps", maker === undefined ? { zec_zat } : { maker, zec_zat });

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
