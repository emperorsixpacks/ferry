// Types for makers.mjs (imported by vite.config.ts).

export interface MakerEntry {
  name: string;
  url: string;
  pair: string;
}

export interface MakerSummary {
  index: number;
  name: string;
  pair: string;
  online: boolean;
  available: boolean;
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
  resolve(ref: unknown): MakerEntry | null;
}

export const MAX_MAKERS: number;
export function parseMakers(raw: string | undefined, fallbackUrl?: string): MakerEntry[];
export function makerDirectory(
  makers: MakerEntry[],
  opts?: { timeoutMs?: number; ttlMs?: number; fetcher?: (url: string, timeoutMs: number) => Promise<unknown> },
): MakerDirectory;
