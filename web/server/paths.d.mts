// Types for paths.mjs (imported by the browser: src/app/lib/paths.ts).

export type Pair = "btc" | "ltc" | `${"usdc" | "weth"}-${"base" | "ethereum" | "arbitrum" | "optimism"}`;
// "zec", a Ferry pair, or "near:<assetId>"
export type Token = "zec" | Pair | `near:${string}`;
export type Side = "sell" | "buy";
export type Pause = "off" | "standard" | "long";

export type PathKind = "sell" | "buy" | "near-sell" | "near-buy" | "route" | "route-near" | "near-route" | "near-near" | "near-only" | "same" | "none";

export interface NearTokenInfo {
  symbol: string;
  blockchain: string;
  ferry?: string | null;
}

export type NetKind = "main" | "test" | "local";

export interface PathCtx {
  ready: boolean;
  sell: string[];
  buy: string[];
  // the kind of network each pair's daemons run on (swapNet); a pair missing shows no time
  nets?: Partial<Record<string, NetKind>>;
  routes: { from: string[]; to: string[] } | null;
  near:
    | undefined
    | null
    | {
        tokens: Record<string, NearTokenInfo>;
        // direct: NEAR Intents alone (the opt-out from a private swap) runs here
        runs: { sell: boolean; buy: boolean; direct?: boolean };
        reason: "demo" | "mainnet" | null;
        vias?: { sell: string[]; buy: string[] };
        compose?: { to: string[]; from: string[]; runs: boolean } | null;
      };
}

export type Step = { by: "ferry" | "near"; coin?: undefined } | { coin: Token | null; by?: undefined };

export interface Path {
  kind: PathKind;
  sell: string;
  buy: string;
  // null: still finding out what this server runs
  available: boolean | null;
  // it starts here (false: quotes only, or not available)
  runs: boolean;
  // why it isn't available, or why it only quotes here: one plain sentence
  reason: string | null;
  steps: Step[];
  minutes: [number, number];
  time: string;
  // through shielded ZEC: two Ferry swaps
  private: boolean;
  privacy: string;
  button: string;
  // a single Ferry swap, or ZEC with NEAR Intents
  dir?: Side;
  pair?: Pair;
  asset?: string | null;
  // the coins a NEAR path can go through (ZEC with NEAR), or the [from, to] private swaps one can use
  via: string[] | [string, string][];
  // a private swap: its ends when they are Ferry coins (null: NEAR Intents' asset there)
  from?: Pair | null;
  to?: Pair | null;
  asset_in?: string | null;
  asset_out?: string | null;
}

export const ZEC: "zec";
export const PAIRS: Pair[];
export const NEAR_MIN: number;
export const ROUTE_MIN: Record<Pause, [number, number]>;
export function nearToken(assetId: string): `near:${string}`;
export function isNear(t: string): t is `near:${string}`;
export function assetIdOf(t: string): string | null;
export function isPair(t: string): t is Pair;
export function isToken(t: string): t is Token;
export function tickerOf(t: string, ctx?: PathCtx | null): string;
export function familyOf(t: string, ctx?: PathCtx | null): string;
export function symbolFamily(symbol: string): string;
export function netKind(network: string | null | undefined): NetKind | null;
export function swapNet(counterNetwork: string | null | undefined, zecNetwork: string | null | undefined): NetKind | null;
export function ferryMinutes(pair: string, net?: NetKind): [number, number];
export function aboutText(minutes: [number, number]): string;
export function resolvePath(sell: string, buy: string, ctx: PathCtx | null, opts?: { pause?: Pause; public?: boolean }): Path;
export function stepWords(steps: Step[], ctx?: PathCtx | null): string;
export function present(ctx: PathCtx | null, pair: string): boolean;
export function defaultPick(ctx: PathCtx | null): { sell: Token; buy: Token };
export function pickOn(pick: { sell: Token; buy: Token }, side: Side, token: Token): { sell: Token; buy: Token };
