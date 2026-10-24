// Types for firm.mjs (imported by the browser: src/app/lib/quotes.ts).

export function noWorse(rate: number | string | bigint, shown: number | string | bigint, takerRole: "Z" | "B"): boolean;
export function standIn<Q extends { maker: string; quote_id: string; rate_sat_per_zec: number; min_zat: number; max_zat: number }>(
  list: Q[] | null | undefined,
  pressed: Pick<Q, "maker" | "quote_id" | "rate_sat_per_zec">,
  zat: number,
  takerRole: "Z" | "B",
): Q | null;
