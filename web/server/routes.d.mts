// Types for routes.mjs (imported by vite.config.ts).
import type { MakerEntry, MakerSummary } from "./makers.mjs";

export interface RouteLegs {
  from: string[];
  to: string[];
}

export const PAUSES: Record<"off" | "standard" | "long", [number, number]>;
export const RUNNING: string[];
export function assetOf(id: string): string;
export function routeLegs(status: unknown): RouteLegs | null;
export function canRoute(legs: RouteLegs | null, from: string, to: string): boolean;
export function samePartner(a: { name?: string | null; url?: string }, b: { name?: string | null; url?: string }): boolean;
export function running(v: unknown): boolean;
export function publicRoute<T>(v: T): T;

export interface RouterBody {
  from: string;
  to: string;
  zec_zat: number;
  maker1: { url: string; name: string };
  maker2: { url: string; name: string }[];
  max_in: number;
  min_out: number;
  delay_secs: [number, number];
  payout_to?: string;
}

export function buildRoute(
  body: unknown,
  opts: { list: MakerSummary[]; resolve: (ref: unknown) => MakerEntry | null; legs: RouteLegs | null; maxZat?: number; minZat?: number; payout?: boolean },
): { body: RouterBody; status?: undefined; error?: undefined } | { status: number; error: string; body?: undefined };

export interface RouterLink {
  url: string;
  call(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  legs(): Promise<RouteLegs | null>;
  busy(): Promise<boolean | null>;
}

export function routerLink(opts: {
  url: string;
  token?: () => string | null | undefined;
  timeoutMs?: number;
  ttlMs?: number;
  request?: (target: URL, method: string, token: string | null | undefined, body: unknown, timeoutMs: number) => Promise<{ status: number; body: unknown }>;
}): RouterLink;
