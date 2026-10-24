// Types for own.mjs (imported by vite.config.ts).
import type { IncomingMessage } from "node:http";

export function isLoopback(name: unknown): boolean;
export function hostOf(header: unknown): { name: string; port: string } | null;
export function originAllowed(origin: string | undefined, publicOrigin: string | null, own?: boolean): boolean;
export function ownProblem(req: Pick<IncomingMessage, "headers">, own: boolean): string | null;
export function receiveAddress(v: unknown, max?: number): string | null;
export function receiveFields(body: unknown, side: "sell" | "buy"): { json: string; error?: undefined } | { error: string; json?: undefined };
export const WITHDRAW_ASSETS: ("zec" | "btc" | "token" | "eth")[];
export interface WithdrawBody {
  asset: "zec" | "btc" | "token" | "eth";
  amount: number | string;
  to: string;
  dry_run?: true;
}
export function withdrawBody(body: unknown, opts?: { preview?: boolean }): { body: WithdrawBody; error?: undefined; status?: undefined } | { error: string; status?: number; body?: undefined };
