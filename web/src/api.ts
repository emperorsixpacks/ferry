// Types and calls for the ferryd HTTP + SSE API (docs/API.md).

export type Role = "Z" | "B";
export type Outcome = "swapped" | "refunded" | "punished" | null;

export interface Status {
  role: Role;
  name: string;
  balances: { zec_shielded_zat: number; btc_sat: number };
  chains: {
    btc: { network: string; height: number };
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
  role: Role;
  counterparty: string;
  state: string;
  outcome: Outcome;
  amounts: { zec_zat: number; btc_sat: number };
  deadlines: { t1_blocks: number; t2_blocks: number; btc_lock_height: number | null; cancel_height: number | null };
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
export const MAKER_URL: string = __FERRY_MAKER_URL__;
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
export const startSwap = (zec_zat: number, as: Role = "Z") =>
  call<{ id: string }>(DAEMONS[as], "/api/swaps", { maker: MAKER_URL, zec_zat });
export const injectStall = (role: Role, id: string) =>
  call<unknown>(DAEMONS[role], `/api/swaps/${id}/fault`, { fault: "stall" });
