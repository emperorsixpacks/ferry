// Types for makers.mjs (imported by vite.config.ts).

export interface MakerEntry {
  name: string;
  url: string;
  pair: string;
  chain: string | null;
}

export interface MakerSummary {
  index: number;
  name: string;
  pair: string;
  chain: string | null;
  online: boolean;
  available: boolean;
  // making offers, but already running as many swaps as it takes at once
  busy: boolean;
  // how many more swaps it takes right now; null: it doesn't say (an older ferryd)
  free_slots: number | null;
  paused: boolean;
  role: "Z" | "B" | null;
  rate_sat_per_zec: number | null;
  min_zat: number | null;
  max_zat: number | null;
  fee_sat: number | null;
  liquidity_zat: number | null;
  rate_source: string | null;
  rate_updated_at: number | null;
  rate_age_s: number | null;
  error?: string;
}

export interface MakerDirectory {
  makers: MakerEntry[];
  list(): Promise<MakerSummary[]>;
  offerOf(index: number): Record<string, unknown> | null;
  resolve(ref: unknown): MakerEntry | null;
}

export const MAX_MAKERS: number;
export function parseMakers(raw: string | undefined, fallbackUrl?: string): MakerEntry[];
export function makerDirectory(
  makers: MakerEntry[],
  opts?: { timeoutMs?: number; ttlMs?: number; fetcher?: (url: string, timeoutMs: number) => Promise<unknown> },
): MakerDirectory;
