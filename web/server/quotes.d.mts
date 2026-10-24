// Types for quotes.mjs (imported by vite.config.ts).
import type { MakerDirectory } from "./makers.mjs";

export interface FirmQuote {
  maker: string;
  index: number;
  quote_id: string;
  rate_sat_per_zec: number;
  min_zat: number;
  max_zat: number;
  expires_in_ms: number;
}

export interface FoundQuote {
  json: string;
  min_zat: number;
  max_zat: number;
  entry: unknown;
}

// a quote claimed for one start (claim()): give it back with release() if the start goes no further
export interface ClaimedQuote extends FoundQuote {
  rate_sat_per_zec: number;
  release: () => void;
}

export interface QuoteDesk {
  request(body: unknown): Promise<{ status: number; body: { bucket_zat?: number | null; quotes?: FirmQuote[]; error?: string } }>;
  find(makerIndex: number, quoteId: unknown): FoundQuote | null;
  take(found: Pick<FoundQuote, "entry">): void;
  claim(makerIndex: number, quoteId: unknown, zat: number): Promise<ClaimedQuote | null>;
}

export const BUCKETS_ZAT: number[];
export const MIN_LEFT_MS: number;
export const MIN_START_MS: number;
export function bucketFor(zat: number): { lower: number; bucket: number } | null;
export function pairLabel(id: unknown): { pair: string; chain: string | null } | null;
export function marketOf(offer: unknown): string | null;
export function quoteDesk(
  directory: MakerDirectory,
  opts?: { timeoutMs?: number; minLeftMs?: number; fetcher?: (url: string, body: unknown, timeoutMs: number) => Promise<string> },
): QuoteDesk;
export function rateLimit(perWindow: number, windowMs?: number): (key: string) => number;
