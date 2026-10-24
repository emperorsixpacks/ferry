// Production server for the Ferry UI: `node web/server/prod.mjs` (plain Node, no dependencies).
//
// - Serves web/dist with an SPA fallback and cache headers.
// - Proxies /daemon/z and /daemon/b to the two ferryd control APIs, adding each daemon's bearer
//   token server-side (the browser never sees a token), like the Vite dev proxy does.
// - Guards the public demo: the UI is on the open internet with real (testnet) wallets behind it,
//   so only the calls the UI needs get through, and swap starts are limited.
//
// Env (defaults in brackets):
//   PORT [5300]  HOST [0.0.0.0]  DIST [web/dist next to this file]
//   FERRY_Z_URL [http://127.0.0.1:7101]  FERRY_B_URL [http://127.0.0.1:7102]
//   FERRY_MAKER_URL [http://127.0.0.1:7112]   B's peer URL, as reachable from Z's daemon; the only
//                                              maker when FERRY_MAKERS is unset
//   FERRY_MAKERS [unset]    the makers a visitor may pick, allowlisted by the operator: JSON
//                           [{"name","url","pair"}] or "name|url|pair, ..." (see makers.mjs). URLs are
//                           peer URLs as reachable from this server and from Z's daemon. GET
//                           /api/makers lists their live offers (fetched here, cached 10 s); a swap
//                           start names a maker by index or name, never by URL
//   FERRY_Z_TOKEN / FERRY_Z_TOKEN_FILE, FERRY_B_TOKEN / FERRY_B_TOKEN_FILE
//                                              the daemons' API tokens (<data-dir>/api-token); a file is
//                                              re-read every 30 s, so a restarted daemon is picked up
//   PUBLIC_ORIGIN [unset]   e.g. https://ferry.example: POSTs whose Origin is something else get 403
//   TRUST_PROXY [0]         1 behind a reverse proxy: the client IP is the last X-Forwarded-For hop
//   DEMO_MAX_ZAT [50000000] largest swap a visitor may start (0.5 ZEC)
//   DEMO_MIN_ZAT [unset]    smallest; the maker's own minimum applies anyway
//   DEMO_RATE_PER_HOUR [3]  swap starts per client IP per rolling hour
//   DEMO_SWAPS_PER_HOUR [12] swap starts across all clients per rolling hour (rotating addresses
//                           can't get past it, so fees can't drain the wallets)
//   DEMO_FAULTS [0]         1 allows POST /api/swaps/:id/fault (the inspector's stall buttons)
//   DEMO_SSE_PER_IP [8]     open /api/events streams per client IP (each holds a stream to ferryd;
//                           one /inspect tab uses 3, an /app tab 1)
//   DEMO_SSE_TOTAL [200]    open /api/events streams in all
//
// The daemons see no browser Origin header: this server strips it after its own PUBLIC_ORIGIN
// check, so ferryd's --ui-origin allowlist doesn't need to know the public domain.
import http from "node:http";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { makerDirectory, parseMakers } from "./makers.mjs";

const env = process.env;
const PORT = Number(env.PORT ?? 5300);
const HOST = env.HOST ?? "0.0.0.0";
const DIST = resolve(env.DIST ?? join(fileURLToPath(new URL(".", import.meta.url)), "..", "dist"));
const TRUST_PROXY = env.TRUST_PROXY === "1";
const PUBLIC_ORIGIN = env.PUBLIC_ORIGIN?.replace(/\/+$/, "") || null;
const MAKER_URL = env.FERRY_MAKER_URL ?? "http://127.0.0.1:7112";
const DEMO_MAX_ZAT = Number(env.DEMO_MAX_ZAT ?? 50_000_000);
const DEMO_MIN_ZAT = env.DEMO_MIN_ZAT ? Number(env.DEMO_MIN_ZAT) : 0;
const RATE_PER_HOUR = Number(env.DEMO_RATE_PER_HOUR ?? 3);
const SWAPS_PER_HOUR = Number(env.DEMO_SWAPS_PER_HOUR ?? 12);
const FAULTS = env.DEMO_FAULTS === "1";
const SSE_PER_IP = Number(env.DEMO_SSE_PER_IP ?? 8);
const SSE_TOTAL = Number(env.DEMO_SSE_TOTAL ?? 200);
// a bad FERRY_MAKERS stops the server here, with the reason
const MAKERS = makerDirectory(parseMakers(env.FERRY_MAKERS, MAKER_URL));

// ------------------------------------------------------------------------------------------------
// daemons and their tokens

function tokenSource(name) {
  const value = env[`FERRY_${name}_TOKEN`];
  const file = env[`FERRY_${name}_TOKEN_FILE`];
  let cached = value ?? null;
  let readAt = 0;
  return () => {
    if (value || !file) return cached;
    if (Date.now() - readAt > 30_000) {
      readAt = Date.now();
      try {
        cached = readFileSync(file, "utf8").trim();
      } catch (e) {
        console.error(`ferry-ui: can't read ${file}: ${e.message}`);
      }
    }
    return cached;
  };
}

const DAEMONS = {
  z: { url: new URL(env.FERRY_Z_URL ?? "http://127.0.0.1:7101"), token: tokenSource("Z") },
  b: { url: new URL(env.FERRY_B_URL ?? "http://127.0.0.1:7102"), token: tokenSource("B") },
};

// one request to a daemon from this server, for the guard's own checks
function daemonJson(key, path) {
  const d = DAEMONS[key];
  return new Promise((ok, fail) => {
    const req = http.request(new URL(path, d.url), { headers: authHeader(d), timeout: 10_000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          ok({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          fail(new Error(`bad JSON from ${key} daemon`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", fail);
    req.end();
  });
}

const authHeader = (d) => {
  const t = d.token();
  return t ? { authorization: `Bearer ${t}` } : {};
};

// ------------------------------------------------------------------------------------------------
// responses

const SECURITY = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

function json(res, code, body, extra = {}) {
  res.writeHead(code, { ...SECURITY, "content-type": "application/json", "cache-control": "no-store", ...extra });
  res.end(JSON.stringify(body));
}

const deny = (res, error) => json(res, 403, { error });

// ------------------------------------------------------------------------------------------------
// demo guard

const rates = new Map(); // ip -> timestamps of swap starts in the last hour

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.trim()) return xff.split(",").at(-1).trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

const recentAll = []; // timestamps of every swap start in the last hour

// the global cap, checked before the per-IP limit so a refused start costs nobody a slot
function globalWait() {
  const now = Date.now();
  while (recentAll.length && now - recentAll[0] >= 3_600_000) recentAll.shift();
  return recentAll.length >= SWAPS_PER_HOUR ? Math.ceil((recentAll[0] + 3_600_000 - now) / 1000) : 0;
}

function takeRate(ip) {
  const now = Date.now();
  const recent = (rates.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= RATE_PER_HOUR) {
    rates.set(ip, recent);
    return Math.ceil((recent[0] + 3_600_000 - now) / 1000);
  }
  recent.push(now);
  rates.set(ip, recent);
  return 0;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of rates) if (!ts.some((t) => now - t < 3_600_000)) rates.delete(ip);
}, 600_000).unref();

const READ_ONLY = [/^\/api\/status$/, /^\/api\/swaps$/, /^\/api\/swaps\/[0-9a-fA-F]+$/, /^\/api\/events$/, /^\/api\/addresses$/];

function readBody(req, limit = 4096) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        fail(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

const zec = (zat) => (zat / 1e8).toFixed(2);

// Decide whether a /daemon request may go through. Resolves to null (forward unchanged), a body
// to forward instead, or false after the response has been sent.
async function guard(key, path, req, res) {
  const method = req.method;
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

  if (key === "z" && path === "/api/swaps") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: "Send a JSON body like {\"zec_zat\": 10000000}" });
      return false;
    }
    const zat = Number(body?.zec_zat);
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
    // the browser names a maker (index or name); only an allowlisted URL reaches the daemon,
    // which fetches whatever URL it's given
    const maker = MAKERS.resolve(body?.maker);
    if (!maker) {
      json(res, 400, { error: "Unknown maker. Pick one from the list." });
      return false;
    }
    // the maker (B) finishes a moment after Z, and refuses a new swap until it has
    let lists;
    try {
      lists = await Promise.all([daemonJson("z", "/api/swaps"), daemonJson("b", "/api/swaps")]);
    } catch {
      json(res, 502, { error: "Can't reach the daemon. Is it running?" });
      return false;
    }
    if (lists.some((l) => l.status === 200 && Array.isArray(l.body) && l.body.some((s) => !s.outcome))) {
      json(res, 409, { error: "A swap is already in progress on the demo. Try again when it finishes." });
      return false;
    }
    const busy = globalWait();
    if (busy) {
      json(res, 429, { error: `The demo has hit its limit of ${SWAPS_PER_HOUR} swaps an hour. Try again in ${Math.ceil(busy / 60)} minutes.` }, { "retry-after": String(busy) });
      return false;
    }
    const wait = takeRate(clientIp(req));
    if (wait) {
      json(res, 429, { error: `Too many swaps from your address. Try again in ${Math.ceil(wait / 60)} minutes.` }, { "retry-after": String(wait) });
      return false;
    }
    const at = Date.now();
    recentAll.push(at);
    // a start the daemon refuses gives both slots back
    req.ferryRefused = () => {
      const i = recentAll.indexOf(at);
      if (i >= 0) recentAll.splice(i, 1);
      const mine = rates.get(clientIp(req));
      if (mine?.length) mine.pop();
    };
    return JSON.stringify({ maker: maker.url, zec_zat: zat });
  }

  if (/^\/api\/swaps\/[0-9a-fA-F]+\/fault$/.test(path)) {
    if (!FAULTS) {
      deny(res, "Fault injection is off on the public demo");
      return false;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: "Send {\"fault\": \"stall\"}" });
      return false;
    }
    return JSON.stringify({ fault: body?.fault });
  }

  deny(res, "Not available on the public demo");
  return false;
}

// The demo's own limit is part of the offer the UI sees, so its form says "the largest swap is
// 0.50 ZEC" before anyone presses Swap. Applies to /api/status and to the status events.
function clampOffer(status) {
  if (status && status.offer && typeof status.offer.max_zat === "number") {
    status.offer.max_zat = Math.min(status.offer.max_zat, DEMO_MAX_ZAT);
    if (DEMO_MIN_ZAT) status.offer.min_zat = Math.max(status.offer.min_zat, DEMO_MIN_ZAT);
  }
  return status;
}

function rewriteJson(up, res) {
  let body = "";
  up.setEncoding("utf8");
  up.on("data", (c) => (body += c));
  up.on("end", () => {
    try {
      body = JSON.stringify(clampOffer(JSON.parse(body)));
    } catch {
      /* not JSON: pass through */
    }
    res.end(body);
  });
}

function rewriteEvents(up, res) {
  let buf = "";
  let event = "";
  up.setEncoding("utf8");
  up.on("data", (chunk) => {
    buf += chunk;
    let i;
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
  up.on("end", () => res.end(buf));
}

// ------------------------------------------------------------------------------------------------
// proxy

// response headers that stay between ferryd and this server
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer", "host", "origin", "referer", "cookie", "authorization"]);

// request headers that reach ferryd: an allowlist, so nothing the browser sends (Content-Length or
// Expect on a GET, cookies, forwarding headers) gets to the daemon unexamined
const FORWARD = ["accept", "last-event-id"];

// open event streams, per IP and in all
const streams = new Map();
let streamsOpen = 0;

function openStream(req, res) {
  const ip = clientIp(req);
  const mine = streams.get(ip) ?? 0;
  if (streamsOpen >= SSE_TOTAL) {
    json(res, 429, { error: "The demo is busy. Try again in a minute." }, { "retry-after": "60" });
    return false;
  }
  if (mine >= SSE_PER_IP) {
    json(res, 429, { error: "Too many open Ferry tabs from your address. Close one and reload." }, { "retry-after": "60" });
    return false;
  }
  streams.set(ip, mine + 1);
  streamsOpen++;
  let closed = false;
  res.on("close", () => {
    if (closed) return;
    closed = true;
    streamsOpen--;
    const n = (streams.get(ip) ?? 1) - 1;
    if (n > 0) streams.set(ip, n);
    else streams.delete(ip);
  });
  return true;
}

async function proxy(key, path, search, req, res) {
  const d = DAEMONS[key];
  const decision = await guard(key, path, req, res);
  if (decision === false) return;

  if (path === "/api/events" && !openStream(req, res)) return;

  const headers = {};
  for (const k of FORWARD) if (typeof req.headers[k] === "string") headers[k] = req.headers[k];
  Object.assign(headers, authHeader(d));
  // the only bodies that reach ferryd are the ones the guard rebuilt
  let body = null;
  if (typeof decision === "string") {
    body = decision;
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(body);
  }

  const upstream = http.request(new URL(path + search, d.url), { method: req.method, headers }, (up) => {
    const out = { ...SECURITY };
    for (const [k, v] of Object.entries(up.headers)) if (!HOP.has(k) && !k.startsWith("access-control-")) out[k] = v;
    out["cache-control"] = "no-store";
    if (String(up.headers["content-type"] ?? "").startsWith("text/event-stream")) out["x-accel-buffering"] = "no";
    // the body may be rewritten below, so its length is recomputed by Node
    const sse = String(up.headers["content-type"] ?? "").startsWith("text/event-stream");
    if (path === "/api/status" && up.statusCode === 200) delete out["content-length"];
    if ((up.statusCode ?? 502) >= 300) req.ferryRefused?.();
    res.writeHead(up.statusCode ?? 502, out);
    if (sse && path === "/api/events") rewriteEvents(up, res);
    else if (path === "/api/status" && up.statusCode === 200) rewriteJson(up, res);
    else up.pipe(res);
    // a daemon that dies mid-stream must end the browser's event stream, so EventSource reconnects
    up.on("close", () => {
      if (!res.writableEnded) res.destroy();
    });
  });
  upstream.on("error", () => {
    req.ferryRefused?.();
    if (!res.headersSent) json(res, 502, { error: "Can't reach the daemon. Is it running?" });
    else res.destroy();
  });
  // a browser that leaves must not keep a stream open to the daemon
  res.on("close", () => upstream.destroy());
  upstream.end(body ?? undefined);
}

// ------------------------------------------------------------------------------------------------
// maker directory: GET /api/makers. Answers from the directory's cache, so however often it is
// called, each maker gets at most one offer fetch per cache period. The demo's own limits apply
// to every maker's range, as they do to the daemon's offer.

async function serveMakers(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Method not allowed" });
  const list = await MAKERS.list();
  for (const m of list) {
    if (m.max_zat != null) m.max_zat = Math.min(m.max_zat, DEMO_MAX_ZAT);
    if (m.min_zat != null && DEMO_MIN_ZAT) m.min_zat = Math.max(m.min_zat, DEMO_MIN_ZAT);
    if (m.liquidity_zat != null && m.max_zat != null) m.liquidity_zat = Math.min(m.liquidity_zat, m.max_zat);
    delete m.error;
  }
  json(res, 200, { makers: list });
}

// ------------------------------------------------------------------------------------------------
// static files

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

function sendFile(res, file, method, cache) {
  res.writeHead(200, { ...SECURITY, "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": cache });
  if (method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
}

function serveStatic(pathname, req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Method not allowed" });
  let rel;
  try {
    rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  } catch {
    return json(res, 400, { error: "Bad path" });
  }
  const file = resolve(DIST, rel);
  if (file !== DIST && !file.startsWith(DIST + sep)) return json(res, 404, { error: "Not found" });
  try {
    if (rel && statSync(file).isFile()) {
      // hashed build assets never change; everything else revalidates
      return sendFile(res, file, req.method, rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "public, max-age=300");
    }
  } catch {
    /* fall through */
  }
  // a path with an extension that doesn't exist is a real 404, not a page
  if (extname(rel)) return json(res, 404, { error: "Not found" });
  sendFile(res, join(DIST, "index.html"), req.method, "no-cache");
}

// ------------------------------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://ui");
  const m = url.pathname.match(/^\/daemon\/(z|b)(\/.*)?$/);
  if (m) {
    proxy(m[1], m[2] ?? "/", url.search, req, res).catch((e) => {
      console.error("ferry-ui proxy:", e);
      if (!res.headersSent) json(res, 500, { error: "Internal error" });
    });
    return;
  }
  if (url.pathname === "/healthz") return json(res, 200, { ok: true });
  if (url.pathname === "/api/makers") {
    serveMakers(req, res).catch((e) => {
      console.error("ferry-ui makers:", e);
      if (!res.headersSent) json(res, 500, { error: "Internal error" });
    });
    return;
  }
  serveStatic(url.pathname, req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`ferry-ui on http://${HOST}:${PORT}  dist ${DIST}`);
  console.log(`  Z ${DAEMONS.z.url.origin}  B ${DAEMONS.b.url.origin}  makers ${MAKERS.makers.map((m) => `${m.name} (${m.pair})`).join(", ") || "none"}`);
  console.log(`  demo: max ${zec(DEMO_MAX_ZAT)} ZEC, ${RATE_PER_HOUR} swaps/IP/hour, ${SWAPS_PER_HOUR} swaps/hour in all, ${SSE_PER_IP} streams/IP, ${SSE_TOTAL} streams in all, faults ${FAULTS ? "on" : "off"}${PUBLIC_ORIGIN ? `, origin ${PUBLIC_ORIGIN}` : ""}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
