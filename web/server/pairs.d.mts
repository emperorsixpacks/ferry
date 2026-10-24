// Types for pairs.mjs (imported by vite.config.ts).

export const PAIR_IDS: string[];

export function envName(id: string): string;
export function buyKey(id: string): string;
export function buyEnvName(id: string): string;

type Env = Record<string, string | undefined>;

export function pairDaemons(env: Env): { id: string; url: string }[];
export function buyDaemons(env: Env): { id: string; url: string }[];

export interface ExtraDaemon {
  key: string;
  id: string;
  side: "sell" | "buy";
  url: string;
  tokenName: string;
}
export function extraDaemons(env: Env): ExtraDaemon[];

// true or false when the operator said so, else "auto": used unless its status says it's a maker
export type MainSide = boolean | "auto";
export function mainSide(v: string | undefined): MainSide;

export interface PairsBody {
  pairs: string[];
  buy: string[];
  main: { sell: MainSide; buy: MainSide };
}
export function pairsBody(extras: ExtraDaemon[], opts?: { mainSell?: MainSide; mainBuy?: MainSide }): PairsBody;

export function samePair(key: string, extras: ExtraDaemon[]): string[];
