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
  offer: { pair: string; rate_sat_per_zec: number; min_zat: number; max_zat: number };
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
}

export const DAEMONS: Record<Role, string> = { Z: "/daemon/z", B: "/daemon/b" };
export const MAKER_URL: string = __FERRY_MAKER_URL__;

async function call<T>(base: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(base + path, body === undefined ? undefined : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export const getStatus = (role: Role) => call<Status>(DAEMONS[role], "/api/status");
export const getSwaps = (role: Role) => call<SwapView[]>(DAEMONS[role], "/api/swaps");
export const startSwap = (zec_zat: number) =>
  call<{ id: string }>(DAEMONS.Z, "/api/swaps", { maker: MAKER_URL, zec_zat });
export const injectStall = (role: Role, id: string) =>
  call<unknown>(DAEMONS[role], `/api/swaps/${id}/fault`, { fault: "stall" });
