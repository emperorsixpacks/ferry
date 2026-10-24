// Vercel serverless proxy for the two ferryd control APIs.
//
// vercel.json rewrites /daemon/:role to /api/daemon?role=:role, and the frontend adds the real
// daemon sub-path as ?path=... This avoids Next.js-style catch-all files (Vercel's api/ filesystem
// doesn't have them) and avoids slashes in query values, which Vercel's routing handles unreliably.
//
// This function adds the target daemon's bearer token — the browser must never hold it, and
// EventSource cannot set headers — and then forwards the request, streaming /api/events through so
// the UI's EventSource keeps working.
//
// It also carries the public demo guard that web/server/prod.mjs used to apply, because the
// browser talks to this function rather than to a container. State (the rate limits) lives in
// module scope: it survives between warm invocations of the same instance and is best-effort
// across instances, which is enough because a start is refused anyway while a swap is running.
//
// Env (Vercel project settings, production):
//   FERRY_Z_URL, FERRY_B_URL      the domains Coolify exposes ferryd-z (7101) / ferryd-b (7102) on
//   FERRY_Z_TOKEN, FERRY_B_TOKEN  the daemons' API tokens
//   FERRY_MAKER_URL               how Z's daemon reaches B's peer port — reachable FROM ferryd-z,
//                                 so http://ferryd-b:7112. Always what a swap is proposed to, never
//                                 whatever the browser sent.
//   PUBLIC_ORIGIN                 [unset] e.g. https://ferryzec.vercel.app: POSTs whose Origin is
//                                 something else get 403, and the Origin is stripped before
//                                 forwarding so ferryd's --ui-origin need not know the domain
//   DEMO_MAX_ZAT [50000000]       largest swap a visitor may start (0.5 ZEC)
//   DEMO_MIN_ZAT [unset]          smallest; the maker's own minimum applies anyway
//   DEMO_RATE_PER_HOUR [3]        swap starts per client IP per rolling hour
//   DEMO_SWAPS_PER_HOUR [12]      swap starts across all clients per rolling hour
//   DEMO_FAULTS [0]               1 allows POST /api/swaps/:id/fault
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

type Req = IncomingMessage & {
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
  /** when guard took a rate-limit slot, so a refused start can hand back exactly this one */
  ferryAt?: number;
};
type Res = ServerResponse;
type Role = "z" | "b";

const env = process.env;
const PUBLIC_ORIGIN = (env.PUBLIC_ORIGIN ?? "").replace(/\/+$/, "") || null;
const MAKER_URL = env.FERRY_MAKER_URL ?? "";
const DEMO_MAX_ZAT = Number(env.DEMO_MAX_ZAT ?? 50_000_000);
const DEMO_MIN_ZAT = env.DEMO_MIN_ZAT ? Number(env.DEMO_MIN_ZAT) : 0;
const RATE_PER_HOUR = Number(env.DEMO_RATE_PER_HOUR ?? 3);
const SWAPS_PER_HOUR = Number(env.DEMO_SWAPS_PER_HOUR ?? 12);
const FAULTS = env.DEMO_FAULTS === "1";

const DAEMONS: Record<Role, { url?: string; token?: string }> = {
  z: { url: env.FERRY_Z_URL, token: env.FERRY_Z_TOKEN },
  b: { url: env.FERRY_B_URL, token: env.FERRY_B_TOKEN },
};

const SECURITY: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
};

// request headers worth dropping before forwarding: hop-by-hop, our own identity, anything fetch
// should pick itself
const REQ_DROP = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "te",
  "trailer",
  "content-length",
  "origin",
  "referer",
  "cookie",
  "authorization",
  "accept-encoding",
]);
// response headers: the body may be rewritten and fetch decodes it, so lengths/encodings lie
const RES_DROP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "te",
  "trailer",
  "content-length",
  "content-encoding",
]);

const READ_ONLY = [
  /^\/api\/status$/,
  /^\/api\/swaps$/,
  /^\/api\/swaps\/[0-9a-fA-F]+$/,
  /^\/api\/events$/,
  /^\/api\/addresses$/,
];

// ------------------------------------------------------------------------------------------------
// responses

function json(res: Res, code: number, body: unknown, extra: Record<string, string> = {}) {
  res.writeHead(code, {
    ...SECURITY,
    "content-type": "application/json",
    "cache-control": "no-store",
    ...extra,
  });
  res.end(JSON.stringify(body));
}

const deny = (res: Res, error: string) => json(res, 403, { error });

// ------------------------------------------------------------------------------------------------
// demo guard: null = forward unchanged, string = forward this body instead, false = already answered

const rates = new Map<string, number[]>(); // ip -> swap-start timestamps in the last hour
const recentAll: number[] = []; // every swap start in the last hour, across clients

function clientIp(req: Req): string {
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.trim()) return real.trim();
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) return xff.split(",")[0]!.trim();
  return "unknown";
}

function globalWait(): number {
  const now = Date.now();
  while (recentAll.length && now - recentAll[0]! >= 3_600_000) recentAll.shift();
  return recentAll.length >= SWAPS_PER_HOUR
    ? Math.ceil((recentAll[0]! + 3_600_000 - now) / 1000)
    : 0;
}

function takeRate(ip: string): number {
  const now = Date.now();
  const recent = (rates.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= RATE_PER_HOUR) {
    rates.set(ip, recent);
    return Math.ceil((recent[0]! + 3_600_000 - now) / 1000);
  }
  recent.push(now);
  // a long-lived map on a warm instance: drop whatever has aged out, and reset rather than grow
  if (rates.size > 10_000) rates.clear();
  rates.set(ip, recent);
  return 0;
}

const zec = (zat: number) => (zat / 1e8).toFixed(2);

// a start the daemon turns down gives both slots back
function giveBack(req: Req, ip: string) {
  if (req.ferryAt !== undefined) {
    const i = recentAll.indexOf(req.ferryAt);
    if (i >= 0) recentAll.splice(i, 1);
    req.ferryAt = undefined;
  }
  const mine = rates.get(ip);
  if (mine?.length) mine.pop();
}

const jsonBody = (req: Req): Record<string, unknown> | null => {
  const b = req.body;
  if (b === undefined || b === null || b === "") return {};
  if (typeof b === "string") {
    try {
      const p = JSON.parse(b);
      return p && typeof p === "object" ? (p as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  if (typeof b === "object") return b as Record<string, unknown>;
  return null;
};

async function daemonJson(key: Role, path: string): Promise<{ status: number; body: unknown }> {
  const d = DAEMONS[key];
  const res = await fetch(new URL(path, d.url), {
    headers: { authorization: `Bearer ${d.token}`, "accept-encoding": "identity" },
    signal: AbortSignal.timeout(10_000),
  });
  const body: unknown = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function guard(role: Role, path: string, req: Req, res: Res): Promise<string | null | false> {
  const method = (req.method ?? "GET").toUpperCase();

  if (method === "GET" || method === "HEAD") {
    if (READ_ONLY.some((r) => r.test(path))) return null;
    deny(res, "Not available on the public demo");
    return false;
  }
  if (method !== "POST") {
    deny(res, "Not available on the public demo");
    return false;
  }
  if (PUBLIC_ORIGIN) {
    const origin = req.headers.origin;
    if (origin && origin !== PUBLIC_ORIGIN) {
      deny(res, "This origin may not use the Ferry demo");
      return false;
    }
  }

  if (role === "z" && path === "/api/swaps") {
    const body = jsonBody(req);
    if (body === null) {
      json(res, 400, { error: 'Send a JSON body like {"zec_zat": 10000000}' });
      return false;
    }
    const zat = Number(body.zec_zat);
    if (!Number.isSafeInteger(zat) || zat <= 0) {
      json(res, 400, { error: "zec_zat must be a positive whole number of zatoshi" });
      return false;
    }
    if (zat > DEMO_MAX_ZAT) {
      json(res, 400, { error: `The public demo is limited to ${zec(DEMO_MAX_ZAT)} ZEC per swap` });
      return false;
    }
    if (zat < DEMO_MIN_ZAT) {
      json(res, 400, { error: `The smallest demo swap is ${zec(DEMO_MIN_ZAT)} ZEC` });
      return false;
    }
    if (!MAKER_URL) {
      json(res, 500, { error: "FERRY_MAKER_URL is not configured" });
      return false;
    }
    // the maker (B) finishes a moment after Z, and refuses a new swap until it has
    let lists: { status: number; body: unknown }[];
    try {
      lists = await Promise.all([daemonJson("z", "/api/swaps"), daemonJson("b", "/api/swaps")]);
    } catch {
      json(res, 502, { error: "Can't reach the daemon. Is it running?" });
      return false;
    }
    if (
      lists.some(
        (l) =>
          l.status === 200 && Array.isArray(l.body) && l.body.some((s) => !(s as { outcome?: unknown }).outcome),
      )
    ) {
      json(res, 409, { error: "A swap is already in progress on the demo. Try again when it finishes." });
      return false;
    }
    const busy = globalWait();
    if (busy) {
      json(
        res,
        429,
        {
          error: `The demo has hit its limit of ${SWAPS_PER_HOUR} swaps an hour. Try again in ${Math.ceil(busy / 60)} minutes.`,
        },
        { "retry-after": String(busy) },
      );
      return false;
    }
    const wait = takeRate(clientIp(req));
    if (wait) {
      json(
        res,
        429,
        { error: `Too many swaps from your address. Try again in ${Math.ceil(wait / 60)} minutes.` },
        { "retry-after": String(wait) },
      );
      return false;
    }
    req.ferryAt = Date.now();
    recentAll.push(req.ferryAt);
    // the maker is always ours: the daemon fetches whatever URL it's given
    return JSON.stringify({ maker: MAKER_URL, zec_zat: zat });
  }

  if (/^\/api\/swaps\/[0-9a-fA-F]+\/fault$/.test(path)) {
    if (!FAULTS) {
      deny(res, "Fault injection is off on the public demo");
      return false;
    }
    const body = jsonBody(req);
    if (body === null) {
      json(res, 400, { error: 'Send {"fault": "stall"}' });
      return false;
    }
    return JSON.stringify({ fault: body.fault });
  }

  deny(res, "Not available on the public demo");
  return false;
}

// ------------------------------------------------------------------------------------------------
// body rewriting: the demo's own limit is part of the offer the UI sees, so its form says "the
// largest swap is 0.50 ZEC" before anyone presses Swap

function clampOffer(status: Record<string, unknown> | null): Record<string, unknown> | null {
  const offer = status?.offer as { max_zat?: number; min_zat?: number } | undefined;
  if (offer && typeof offer.max_zat === "number") {
    offer.max_zat = Math.min(offer.max_zat, DEMO_MAX_ZAT);
    if (DEMO_MIN_ZAT) offer.min_zat = Math.max(offer.min_zat ?? 0, DEMO_MIN_ZAT);
  }
  return status;
}

// ------------------------------------------------------------------------------------------------
// routing

function route(req: Req): { role: Role; path: string; search: string } | null {
  const q = req.query as Record<string, string | string[] | undefined> | undefined;
  const rawRole = q?.role;
  const role = (Array.isArray(rawRole) ? rawRole[0] : rawRole)?.toLowerCase();
  if (role !== "z" && role !== "b") return null;

  const raw = q?.path;
  const value = Array.isArray(raw) ? raw.join("/") : (raw ?? "");
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // a malformed escape stays as-is; the daemon will reject nonsense the same as we would
  }
  const path = "/" + decoded.replace(/^\/+/, "");

  // keep any query string the caller actually sent, minus our routing params
  const url = req.url ?? "/";
  const qi = url.indexOf("?");
  const search = qi >= 0 ? url.slice(qi) : "";
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  params.delete("role");
  params.delete("path");
  const rest = params.toString();
  return { role, path, search: rest ? `?${rest}` : "" };
}

// ------------------------------------------------------------------------------------------------
// proxy

async function forward(role: Role, path: string, search: string, req: Req, res: Res, body: string | null) {
  const d = DAEMONS[role];
  if (!d.url || !d.token) {
    json(res, 502, {
      error: `The ${role.toUpperCase()} daemon is not configured (FERRY_${role.toUpperCase()}_URL / FERRY_${role.toUpperCase()}_TOKEN)`,
    });
    return;
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (REQ_DROP.has(key) || key.startsWith("x-vercel") || key.startsWith("cf-")) continue;
    if (v === undefined) continue;
    headers[key] = Array.isArray(v) ? v.join(", ") : v;
  }
  // no compression anywhere: the body may be rewritten below, and a decoded body with an
  // encoded header would corrupt the response
  headers["accept-encoding"] = "identity";
  headers.authorization = `Bearer ${d.token}`;

  const init: RequestInit = { method: req.method ?? "GET", headers, redirect: "manual" };
  if (body !== null) {
    init.body = body;
    headers["content-type"] = "application/json";
  }

  const ip = clientIp(req);
  // only a start the daemon turns down hands its slot back, and guard only took one for a Z start
  const takeSlot = role === "z" && req.method === "POST" && path === "/api/swaps";
  let up: Response;
  try {
    up = await fetch(new URL(path + search, d.url), init);
  } catch {
    if (takeSlot) giveBack(req, ip);
    if (!res.headersSent) json(res, 502, { error: "Can't reach the daemon. Is it running?" });
    else res.destroy();
    return;
  }

  const contentType = up.headers.get("content-type") ?? "";
  const out: Record<string, string> = { ...SECURITY, "cache-control": "no-store" };
  up.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (RES_DROP.has(k) || k.startsWith("access-control-")) return;
    out[k] = value;
  });
  out["content-type"] = contentType || "application/json";
  const sse = contentType.startsWith("text/event-stream");
  if (sse) out["x-accel-buffering"] = "no";

  const status = up.status;
  if (!up.body) {
    res.writeHead(status, out);
    res.end();
    return;
  }
  res.writeHead(status, out);

  if (status >= 300 && takeSlot) giveBack(req, ip);

  const src = Readable.fromWeb(up.body as unknown as import("node:stream/web").ReadableStream);

  const done = () => {
    // a browser that leaves must not keep a stream open to the daemon
    if (!res.writableEnded) res.destroy();
  };

  if (sse && path === "/api/events") {
    // rewrite `status` events so the form knows the demo's own maximum
    let buf = "";
    let event = "";
    src.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line === "") event = "";
        else if (event === "status" && line.startsWith("data:")) {
          try {
            line = "data: " + JSON.stringify(clampOffer(JSON.parse(line.slice(5))));
          } catch {
            /* pass through */
          }
        }
        res.write(line + "\n");
      }
    });
    src.on("end", () => res.end(buf));
    src.on("error", done);
  } else if (path === "/api/status" && status === 200) {
    let text = "";
    src.setEncoding("utf8");
    src.on("data", (c: string) => (text += c));
    src.on("end", () => {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown> | null;
        res.end(JSON.stringify(clampOffer(parsed)));
      } catch {
        res.end(text);
      }
    });
    src.on("error", done);
  } else {
    src.on("error", done);
    src.pipe(res);
  }

  res.on("close", () => {
    if (!res.writableEnded) src.destroy();
  });
}

// ------------------------------------------------------------------------------------------------

export default async function handler(req: Req, res: Res) {
  const r = route(req);
  if (!r) return json(res, 404, { error: "Not found" });

  let body: string | null = null;
  try {
    const decision = await guard(r.role, r.path, req, res);
    if (decision === false) return;
    body = decision;
  } catch (e) {
    console.error("ferry daemon proxy guard:", e);
    if (!res.headersSent) json(res, 500, { error: "Internal error" });
    return;
  }

  try {
    await forward(r.role, r.path, r.search, req, res, body);
  } catch (e) {
    console.error("ferry daemon proxy:", e);
    if (!res.headersSent) json(res, 500, { error: "Internal error" });
    else res.destroy();
  }
}
