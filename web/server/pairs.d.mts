// Types for pairs.mjs (imported by vite.config.ts).

export const PAIR_IDS: string[];

export function envName(id: string): string;

export function pairDaemons(env: Record<string, string | undefined>): { id: string; url: string }[];
