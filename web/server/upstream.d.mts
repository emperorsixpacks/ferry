// Types for upstream.mjs (imported by vite.config.ts).
import type { ClientRequest, ServerResponse } from "node:http";

export const READ_MS: number;
export const START_MS: number;
export const TIMEOUT_TEXT: string;
export const ROUTER_TIMEOUT_TEXT: string;
export function limitFor(method: string | undefined, limits?: { read?: number; start?: number }): number;
export function timeoutAnswer(error?: string): (res: ServerResponse) => void;
export function deadline(up: ClientRequest, res: ServerResponse, opts: { ms: number; answer?: (res: ServerResponse) => void }): () => void;
