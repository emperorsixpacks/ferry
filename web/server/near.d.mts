// Types for near.mjs (imported by vite.config.ts).
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MakerDirectory } from "./makers.mjs";
import type { QuoteDesk } from "./quotes.mjs";

export const ONE_CLICK_URL: string;
export const ONE_CLICK_PUBKEY: string;
export const EXPLORER_URL: string;
export const PLACEHOLDER: string;
export function segwitAddress(hrp: string, program: Uint8Array): string;
export function dryAddress(blockchain: string, side: string): [string, string];
export const LOCK_FEE_RESERVE: number;
export const BUY_BUFFER_BPS: number;
export const FERRY_ASSETS: Record<string, { assetId: string; decimals: number }>;
export const NEAR_DONE: string[];

export interface Reply {
  status: number;
  body: any;
}

export function requestJson(
  target: URL,
  opts?: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number; maxBytes?: number },
): Promise<Reply>;

export interface Token {
  assetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
  price: number | null;
  contractAddress: string | null;
}

export function base58(buf: Uint8Array): string;
export function unbase58(s: string): Buffer;
export function stableJson(v: unknown): string | undefined;
export function quoteMessage(r: unknown): string;
export function verifyQuote(r: unknown, pubkey?: string): boolean;
export function cleanTokens(raw: unknown): Token[];
export function pickable(tokens: Token[]): (Token & { ferry: string | null })[];
export function pairOfAsset(assetId: string): string | null;
export function addressProblem(blockchain: string, address: unknown): string | null;
export function big(v: unknown): bigint | null;
export function roundSig(n: bigint, up?: boolean, digits?: number): bigint;
export function unitsText(v: bigint | string, t: { decimals: number; symbol: string }): string;
export function pairOfStatus(s: unknown): string;
export function mainnet(s: unknown): boolean;
export function ferrySecs(pair: string): number;
export function buyNeed(gross: bigint, pair: string): bigint;
export function nearError(status: number, body: unknown): { error: string; field?: string };

export interface OneClick {
  url: string;
  local: boolean;
  tokens(): Promise<Token[] | null>;
  quote(body: unknown): Promise<Reply>;
  status(depositAddress: string, depositMemo?: string | null): Promise<Reply>;
}
export function oneClick(opts?: {
  url?: string;
  jwt?: string | null | (() => string | null);
  timeoutMs?: number;
  tokensTtlMs?: number;
  request?: (target: URL, opts: Record<string, unknown>) => Promise<Reply>;
}): OneClick;

export type DaemonCall = (key: string, method: string, path: string, body?: unknown) => Promise<Reply>;
export interface OwnDaemon {
  key: string;
  pair: string;
  status: any;
}
export interface OwnDaemons {
  statusOf(key: string): Promise<any>;
  forget(key: string): void;
  list(dir: "sell" | "buy"): Promise<OwnDaemon[]>;
}
export function ownDaemons(opts: {
  sell?: { key: string; pair?: string; auto?: boolean }[];
  buy?: { key: string; pair?: string; auto?: boolean }[];
  call: DaemonCall;
  ttlMs?: number;
}): OwnDaemons;

export function bestFerry(list: unknown[], pair: string, dir: "sell" | "buy", zat: number): { maker: any; rate: number; gross: bigint; fee: bigint; value: bigint } | null;

// kind: a NEAR sell or buy; "route" a private swap starting now; "route-later" one that starts once
// NEAR Intents delivered its coin
type AdmitKind = "sell" | "buy" | "route" | "route-later";
type Admit = (what: { key: string; pair: string; kind?: AdmitKind; auto?: boolean }) => Promise<Reply | null>;

export const ROUTE_FEE_ZAT: number;
export const COMBO_KINDS: string[];
export function planRoute(
  list: unknown[],
  from: string,
  to: string,
  maxIn: bigint | number | string,
): { error: string } | { error?: undefined; maker1: any; maker2: any; zat: number; zat2: number; pay: bigint; maxIn: bigint; out: bigint; fee2: bigint; minOut: bigint; minNet: bigint };

export interface NearDesk {
  info(): Promise<unknown>;
  quote(body: unknown): Promise<Reply>;
  start(body: unknown, opts?: { admit?: Admit; refused?: () => void }): Promise<Reply>;
  retry(id: string): Promise<Reply>;
  hop(body: unknown): Promise<Reply>;
  startCombo(body: unknown, opts?: { admit?: Admit; refused?: () => void }): Promise<Reply>;
  retryCombo(id: string): Promise<Reply>;
  tick(): Promise<void>;
  jobs(): unknown[];
  job(id: string): unknown | null;
  combos(): unknown[];
  combo(id: string): unknown | null;
  holds(): Set<string>;
  stop(): void;
}

export function nearDesk(opts: {
  link: OneClick;
  directory: MakerDirectory;
  quotes?: QuoteDesk | null;
  daemons: OwnDaemons;
  call: DaemonCall;
  execution?: boolean;
  testnet?: boolean;
  state?: string | null;
  slippageBps?: number;
  sellDeadlineSecs?: number;
  buyDeadlineSecs?: number;
  pubkey?: string;
  verifySignatures?: boolean;
  limits?: { maxZat?: number; minZat?: number };
  quoteTtlMs?: number;
  tickMs?: number;
  statusEveryMs?: number;
  fundWaitMs?: number;
  admit?: Admit;
  router?: { legs(): Promise<{ from: string[]; to: string[] } | null>; call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> } | null;
  log?: (...a: unknown[]) => void;
}): NearDesk;

export function nearRoutes(
  desk: NearDesk,
  opts: {
    send: (res: ServerResponse, code: number, body: unknown, extra?: Record<string, string>) => void;
    readBody: (req: IncomingMessage, limit?: number) => Promise<string>;
    origin?: (req: IncomingMessage) => string | null;
    limit?: (req: IncomingMessage) => number;
    admit?: (req: IncomingMessage, what: { key: string; pair: string; kind?: AdmitKind }) => Promise<Reply | null>;
    // the person owns the node (own.mjs): a buy's sweep_to and a NEAR-first route's payout_to pass
    own?: (req: IncomingMessage) => boolean;
  },
): (req: IncomingMessage, res: ServerResponse, path: string) => Promise<boolean>;
