// Production server for the Ferry UI: `node web/server/prod.mjs` (plain Node, no dependencies).
//
// - Serves web/dist with an SPA fallback and cache headers.
// - Proxies /daemon/z and /daemon/b to the user's two ferryd control APIs (Z sells shielded ZEC,
//   B buys it), and any per-pair ones, adding each daemon's bearer token server-side (the browser
//   never sees a token), like the Vite dev proxy does.
// - Proxies /router to the user's ferry-route (private swaps), if FERRY_ROUTER_URL is set, the same way.
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
//                           start names a maker by index or name, never by URL. POST /api/quotes
//                           asks them for firm quotes for an amount's bucket (quotes.mjs); a swap
//                           start may name one ({"maker", "zec_zat", "quote": id})
//   FERRY_Z_TOKEN / FERRY_Z_TOKEN_FILE, FERRY_B_TOKEN / FERRY_B_TOKEN_FILE
//                                              the daemons' API tokens (<data-dir>/api-token); a file is
//                                              re-read every 30 s, so a restarted daemon is picked up
//   FERRY_BTC_URL, FERRY_LTC_URL, FERRY_USDC_BASE_URL, FERRY_WETH_ARBITRUM_URL, ... [unset]
//                           Z's daemons for other pairs (one ferryd per pair; tokens USDC or WETH
//                           on BASE, ETHEREUM, ARBITRUM or OPTIMISM), with FERRY_<PAIR>_TOKEN /
//                           FERRY_<PAIR>_TOKEN_FILE; proxied at /daemon/<pair> (usdc-base, ...)
//                           and listed by GET /api/pairs, so the swap page offers them (pairs.mjs)
//   FERRY_BTC_B_URL, FERRY_USDC_BASE_B_URL, ... [unset]
//                           B's daemons for other pairs (buying ZEC), with FERRY_<PAIR>_B_TOKEN /
//                           FERRY_<PAIR>_B_TOKEN_FILE; proxied at /daemon/b-<pair>
//   FERRY_Z_SELLS [auto]    0: visitors can't start swaps on FERRY_Z_URL's daemon (selling ZEC on the
//                           main pair), e.g. when it is the demo's maker
//   FERRY_B_BUYS [auto]     0: visitors can't start swaps on FERRY_B_URL's daemon (buying ZEC on the
//                           main pair), e.g. when it is the demo's maker. Buy starts take the same
//                           guards as sell starts: the caps and both rate limits, and the maker
//                           allowlist. Several swaps may run at once on a pair: each daemon takes as
//                           many as its free funds and its --max-swaps allow, and a start it can't take
//                           is answered 409 {"code": "busy"}, which reaches the browser as "Every
//                           partner is busy right now. Try again in a few minutes."
//   PUBLIC_ORIGIN [unset]   e.g. https://ferry.example: POSTs whose Origin is something else get 403
//                           (with FERRY_OWN_NODE=1, a loopback origin's other loopback name passes too:
//                           http://127.0.0.1:7865 and http://localhost:7865)
//   FERRY_OWN_NODE [0]      1: the daemons behind this server are the person's own node, opened from
//                           their own machine (the node installer sets it). The browser may then say
//                           where a swap's coins go (payout_to on a sell, sweep_to on a buy, a private
//                           swap's payout_to, a NEAR buy's sweep_to, a NEAR-first private swap's
//                           payout_to), send coins out (POST /daemon/<key>/api/withdraw), and read
//                           GET /api/addresses and /api/withdrawals. Each such request must carry a
//                           loopback Host header and no foreign Origin (own.mjs). Off (a public demo),
//                           those fields are dropped from swap starts, and withdraw, withdrawals and
//                           addresses get 403. GET /api/pairs says which ("node": {"own"})
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
//   DEMO_QUOTES_PER_MIN [30] firm-quote requests (POST /api/quotes) per client IP per minute
//   DEMO_QUOTES_PER_MIN_TOTAL [600] firm-quote requests per minute in all (makers hear far less:
//                           quotes are cached per maker and bucket)
//   FERRY_ROUTER_URL [unset] the user's ferry-route (private swaps: coin A -> shielded ZEC -> coin C),
//                           with FERRY_ROUTER_TOKEN / FERRY_ROUTER_TOKEN_FILE; proxied at /router/...
//                           (routes.mjs). GET /api/pairs says which routes it runs ("routes"), so a
//                           page without one shows no private swaps. A route start takes the swap
//                           guards: the caps, both rate limits (a route counts as two swap starts),
//                           the maker allowlist (partners named by name or index, mapped to their
//                           URLs here, leg 2's fallbacks added here), and one moving route at a time.
//                           Routes and ordinary swaps don't wait for each other (the daemons' free
//                           funds and caps decide), with one exception: while a route is moving, no
//                           direct sell starts on the pair it sells ZEC on, because the ZEC it bought
//                           waits in that daemon's wallet, which the daemon counts as free. The views
//                           lose the partners' URLs on the way out
//
// NEAR Intents (its 1Click Swap API; near.mjs): sell shielded ZEC for any of its assets, or buy
// shielded ZEC with them. Ferry swaps ZEC for a coin it supports, and NEAR Intents carries that coin
// on; Ferry never sends ZEC to NEAR Intents. 1Click is called from here only (the browser never sees
// its URL or the JWT), with timeouts and size caps, and every quote's signature is checked.
//   FERRY_NEAR_QUOTES [1]   0 hides NEAR Intents. Otherwise the swap card lists its assets (GET
//                           /api/near/tokens, cached 5 min) with composed quotes (POST /api/near/quote:
//                           dry, cached 30 s, rate limited): informational unless swaps run here
//   FERRY_NEAR [0]          1 runs NEAR Intents swaps (POST /api/near/swap). ONLY for an operator on
//                           their own node: a NEAR swap pays out to an address the person types, so on
//                           a public demo a visitor would choose where the operator's funds go. Off,
//                           the card shows quotes labelled "on your own node (mainnet)". Mainnet only:
//                           a node on a test network gets quotes, never swaps
//   FERRY_NEAR_URL [https://1click.chaindefuser.com]  FERRY_NEAR_JWT / FERRY_NEAR_JWT_FILE [unset]
//                           a partner JWT (lower fees: unauthenticated quotes cost 0.25% more)
//   FERRY_NEAR_PUBKEY [1Click's]  the key 1Click signs quotes with (a mock's, for the mock)
//   FERRY_NEAR_TESTNET [0]  1, with a loopback FERRY_NEAR_URL (the mock): swaps on test networks
//   FERRY_NEAR_STATE [.near/jobs.json next to DIST's parent]  where NEAR swaps are kept: deposit
//                           addresses and 1Click's signed quotes, which are the record for disputes
//   FERRY_NEAR_SLIPPAGE_BPS [100]  FERRY_NEAR_SELL_DEADLINE_SECS [86400]  FERRY_NEAR_BUY_DEADLINE_SECS
//                           [10800]: a sell's quote must outlive its Ferry swap; a buy's is the time to
//                           send the deposit
//   DEMO_NEAR_QUOTES_PER_MIN [40]  DEMO_NEAR_QUOTES_PER_MIN_TOTAL [400]  NEAR quotes per IP / in all
//   A NEAR start takes the swap guards: the caps and both rate limits, and a NEAR sell the route
//   exception above; the Ferry buy that follows a NEAR delivery starts when its daemon takes it (a
//   busy daemon is asked again). With FERRY_ROUTER_URL too, a private swap can have NEAR Intents at
//   an end (POST /api/near/combo: coin → NEAR asset, NEAR asset → coin, NEAR → NEAR), with the route
//   guards (two starts, no other route moving), the partners mapped here (buildRoute), and the
//   route's payout_to set here to a 1Click deposit address this server made, never one from a
//   browser. Only with FERRY_NEAR=1.
//
// The daemons see no browser Origin header: this server strips it after its own PUBLIC_ORIGIN
// check, so ferryd's --ui-origin allowlist doesn't need to know the public domain.
import http from "node:http";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { makerDirectory, parseMakers } from "./makers.mjs";
import { quoteDesk, rateLimit } from "./quotes.mjs";
import { extraDaemons, mainSide, pairsBody } from "./pairs.mjs";
import { buildRoute, publicRoute, routerLink, running } from "./routes.mjs";
import { ONE_CLICK_PUBKEY, ONE_CLICK_URL, nearDesk, nearRoutes, oneClick, ownDaemons, pairOfStatus, requestJson } from "./near.mjs";
import { originAllowed, ownProblem, receiveFields, withdrawBody } from "./own.mjs";
import { sseTransform } from "./sse.mjs";

const env = process.env;
const PORT = Number(env.PORT ?? 5300);
const HOST = env.HOST ?? "0.0.0.0";
const DIST = resolve(env.DIST ?? join(fileURLToPath(new URL(".", import.meta.url)), "..", "dist"));
const TRUST_PROXY = env.TRUST_PROXY === "1";
const PUBLIC_ORIGIN = env.PUBLIC_ORIGIN?.replace(/\/+$/, "") || null;
const OWN_NODE = env.FERRY_OWN_NODE === "1";
// a POST's Origin may post here (PUBLIC_ORIGIN, or its other loopback name on the own node)
const foreignOrigin = (req) => !originAllowed(req.headers.origin, PUBLIC_ORIGIN, OWN_NODE);
// null when this request may say where coins go or move them (own.mjs), else why not
const ownRefusal = (req) => ownProblem(req, OWN_NODE);
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
const QUOTES = quoteDesk(MAKERS);
const quotesPerIp = rateLimit(Number(env.DEMO_QUOTES_PER_MIN ?? 30));
const quotesInAll = rateLimit(Number(env.DEMO_QUOTES_PER_MIN_TOTAL ?? 600));

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

const EXTRA = extraDaemons(env);
const MAIN_SELL = mainSide(env.FERRY_Z_SELLS);
const MAIN_BUY = mainSide(env.FERRY_B_BUYS);
const PAIRS_BODY = pairsBody(EXTRA, { mainSell: MAIN_SELL, mainBuy: MAIN_BUY });
const DAEMONS = {
  z: { url: new URL(env.FERRY_Z_URL ?? "http://127.0.0.1:7101"), token: tokenSource("Z") },
  b: { url: new URL(env.FERRY_B_URL ?? "http://127.0.0.1:7102"), token: tokenSource("B") },
  ...Object.fromEntries(EXTRA.map((d) => [d.key, { url: new URL(d.url), token: tokenSource(d.tokenName) }])),
};
// the daemons a visitor starts swaps on: Z's (selling ZEC) and B's (buying it), for every pair
// "auto" stays a taker here: a start naming a maker of the daemon's own role is refused by ferryd
const TAKERS = new Set([...(MAIN_SELL !== false ? ["z"] : []), ...(MAIN_BUY !== false ? ["b"] : []), ...EXTRA.map((d) => d.key)]);

// the user's router (private swaps), if any
const ROUTER_TOKEN = tokenSource("ROUTER");
const ROUTER = env.FERRY_ROUTER_URL ? routerLink({ url: env.FERRY_ROUTER_URL, token: ROUTER_TOKEN }) : null;

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
// NEAR Intents (near.mjs): its link, the user's own daemons each way, and the desk that quotes,
// starts and follows NEAR swaps. The guards for a start are below, with the others (nearAdmit).

const NEAR_QUOTES = env.FERRY_NEAR_QUOTES !== "0";
const NEAR_RUN = env.FERRY_NEAR === "1";
// the partner JWT, from the env or a file re-read now and then (like the daemons' tokens)
const NEAR_JWT = (() => {
  const value = env.FERRY_NEAR_JWT;
  const file = env.FERRY_NEAR_JWT_FILE;
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
})();
// any daemon this server fronts, as near.mjs asks: {status, body}. A swap start the daemon can't
// take (it, or its partner, runs as many swaps as it takes at once) is said the way the browser says
// it (busyBody).
const daemonCall = (key, method, path, body) =>
  requestJson(new URL(path, DAEMONS[key].url), { method, headers: authHeader(DAEMONS[key]), body, timeoutMs: 30_000 }).then((r) =>
    method === "POST" && path === "/api/swaps" && r?.status === 409 ? { ...r, body: busyBody(r.body) } : r,
  );
const NEAR_DAEMONS = ownDaemons({
  sell: [...(MAIN_SELL !== false ? [{ key: "z", auto: MAIN_SELL === "auto" }] : []), ...EXTRA.filter((d) => d.side === "sell").map((d) => ({ key: d.key, pair: d.id }))],
  buy: [...(MAIN_BUY !== false ? [{ key: "b", auto: MAIN_BUY === "auto" }] : []), ...EXTRA.filter((d) => d.side === "buy").map((d) => ({ key: d.key, pair: d.id }))],
  call: daemonCall,
});
const NEAR = NEAR_QUOTES
  ? nearDesk({
      link: oneClick({ url: env.FERRY_NEAR_URL || ONE_CLICK_URL, jwt: NEAR_JWT }),
      directory: MAKERS,
      quotes: QUOTES,
      daemons: NEAR_DAEMONS,
      call: daemonCall,
      execution: NEAR_RUN,
      testnet: env.FERRY_NEAR_TESTNET === "1",
      state: NEAR_RUN ? resolve(env.FERRY_NEAR_STATE ?? join(DIST, "..", ".near", "jobs.json")) : null,
      pubkey: env.FERRY_NEAR_PUBKEY || ONE_CLICK_PUBKEY,
      slippageBps: Number(env.FERRY_NEAR_SLIPPAGE_BPS ?? 100),
      sellDeadlineSecs: Number(env.FERRY_NEAR_SELL_DEADLINE_SECS ?? 86_400),
      buyDeadlineSecs: Number(env.FERRY_NEAR_BUY_DEADLINE_SECS ?? 10_800),
      limits: { maxZat: DEMO_MAX_ZAT, minZat: DEMO_MIN_ZAT },
      // the Ferry buy that follows a NEAR delivery: whenever its daemon takes it (a busy one is asked
      // again later); a private swap that follows one: when no other route moves
      admit: async ({ key, kind }) => (kind === "route" ? routeIdle() : routeConflict(key)),
      // private swaps with NEAR Intents at an end: the route through the user's router
      router: ROUTER,
    })
  : null;
const nearPerIp = rateLimit(Number(env.DEMO_NEAR_QUOTES_PER_MIN ?? 40));
const nearInAll = rateLimit(Number(env.DEMO_NEAR_QUOTES_PER_MIN_TOTAL ?? 400));

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

// the global cap, checked before the per-IP limit so a refused start costs nobody a slot; `n` slots
// (a route is two swap starts)
function globalWait(n = 1) {
  const now = Date.now();
  while (recentAll.length && now - recentAll[0] >= 3_600_000) recentAll.shift();
  if (recentAll.length + n <= SWAPS_PER_HOUR) return 0;
  if (!recentAll.length) return 3600;
  return Math.max(1,Math.ceil((recentAll[Math.min(recentAll.length - 1, recentAll.length + n - 1 - SWAPS_PER_HOUR)] + 3_600_000 - now) / 1000));
}

function takeRate(ip, n = 1) {
  const now = Date.now();
  const recent = (rates.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length + n > RATE_PER_HOUR) {
    rates.set(ip, recent);
    return recent.length ? Math.max(1, Math.ceil((recent[Math.min(recent.length - 1, recent.length + n - 1 - RATE_PER_HOUR)] + 3_600_000 - now) / 1000)) : 3600;
  }
  for (let i = 0; i < n; i++) recent.push(now);
  rates.set(ip, recent);
  return 0;
}

// Take `n` swap starts for this request (both limits), or answer 429 and return false. A start the
// daemon or router then refuses gives them back (req.ferryRefused).
function takeStarts(req, res, n) {
  const no = startsRefused(req, n);
  if (no) json(res, no.status, no.body, no.headers);
  return !no;
}

// The same, as a value: null when the starts were taken, else the 429 to answer.
function startsRefused(req, n) {
  const busy = globalWait(n);
  if (busy) return { status: 429, body: { error: `The demo has hit its limit of ${SWAPS_PER_HOUR} swaps an hour. Try again in ${Math.ceil(busy / 60)} minutes.` }, headers: { "retry-after": String(busy) } };
  const wait = takeRate(clientIp(req), n);
  if (wait) return { status: 429, body: { error: `Too many swaps from your address. Try again in ${Math.ceil(wait / 60)} minutes.` }, headers: { "retry-after": String(wait) } };
  const at = Date.now();
  for (let i = 0; i < n; i++) recentAll.push(at);
  req.ferryRefused = () => {
    for (let i = 0; i < n; i++) {
      const j = recentAll.indexOf(at);
      if (j >= 0) recentAll.splice(j, 1);
      const mine = rates.get(clientIp(req));
      if (mine?.length) mine.pop();
    }
  };
  return null;
}

// What the browser hears when a daemon can't take a swap now: it runs as many swaps as it takes at
// once (ferryd --max-swaps), its free funds are tied up in swaps in progress, or its partner said the
// same. ferryd answers 409 {"code": "busy"}; anything else passes as it is.
const BUSY_TEXT = "Every partner is busy right now. Try again in a few minutes.";
function busyBody(body) {
  return body?.code === "busy" ? { error: BUSY_TEXT, code: "busy" } : body;
}

// The daemons that sell ZEC: the main Z daemon and every pair's own sell-side daemon.
const sells = (key) => key === "z" || EXTRA.some((d) => d.key === key && d.side === "sell");

// The pair a daemon swaps ("btc", "usdc-base"): a pair's own daemon says so in its name, the main
// ones in their status (asked once a minute at most).
const pairCache = new Map();
async function pairOf(key) {
  const d = EXTRA.find((x) => x.key === key);
  if (d) return d.id;
  const c = pairCache.get(key);
  if (c && Date.now() - c.at < 60_000) return c.pair;
  const s = await daemonJson(key, "/api/status");
  if (s.status !== 200) throw new Error(`status ${s.status}`);
  const pair = pairOfStatus(s.body);
  pairCache.set(key, { at: Date.now(), pair });
  return pair;
}

// A private swap that is selling ZEC on `key`'s pair: the ZEC its first swap bought waits in that
// daemon's wallet, which the daemon counts as free, so no direct sell may start there until the
// route is done. Everything else runs side by side (the daemons' free funds and caps decide). null
// when nothing is in the way (or `key` doesn't sell ZEC), else the 409 (or 502) to answer.
async function routeConflict(key) {
  if (!ROUTER || !sells(key)) return null;
  let routes;
  let pair;
  try {
    [routes, pair] = await Promise.all([ROUTER.call("GET", "/api/routes"), pairOf(key)]);
  } catch {
    return { status: 502, body: { error: "Can't reach the private swap service or the daemon. Try again in a moment." } };
  }
  if (routes.status !== 200 || !Array.isArray(routes.body)) return { status: 502, body: { error: "Can't reach the private swap service. Try again in a moment." } };
  if (routes.body.some((v) => running(v) && v.to === pair)) return { status: 409, body: { error: "A private swap is selling ZEC on this pair right now. Try again when it finishes." } };
  return null;
}

// Routes run one at a time: null when none is moving, else the 409 (or 502, 503) to answer. Ordinary
// swaps don't hold a route back: a leg the daemon can't take yet is asked again by the router.
async function routeIdle() {
  if (!ROUTER) return { status: 503, body: { error: "Private swaps aren't available on this server." } };
  const moving = await ROUTER.busy();
  if (moving === null) return { status: 502, body: { error: "Can't reach the private swap service. Try again in a moment." } };
  if (moving) return { status: 409, body: { error: "A private swap is already in progress. Try again when it finishes." } };
  return null;
}

// A NEAR swap's start: a sell starts its Ferry swap now (one start, and not on a pair a private swap
// is selling on); a buy only takes a start (its Ferry swap waits for NEAR Intents, then for its
// daemon to take it). A private swap with NEAR Intents at an end is two swap starts: now when it
// starts now (no other route moving), else when NEAR Intents has delivered its coin.
async function nearAdmit(req, { key, kind }) {
  if (kind === "sell") {
    const busy = await routeConflict(key);
    if (busy) return busy;
  }
  if (kind === "route") {
    const busy = await routeIdle();
    if (busy) return busy;
  }
  return startsRefused(req, kind === "route" || kind === "route-later" ? 2 : 1);
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of rates) if (!ts.some((t) => now - t < 3_600_000)) rates.delete(ip);
}, 600_000).unref();

const READ_ONLY = [/^\/api\/status$/, /^\/api\/swaps$/, /^\/api\/swaps\/[0-9a-fA-F]+$/, /^\/api\/events$/];
// the node's own addresses and what it sent out: its owner's business, on their own node only
const OWN_READ = [/^\/api\/addresses$/, /^\/api\/withdrawals$/];

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
    if (OWN_READ.some((r) => r.test(path))) {
      const no = ownRefusal(req);
      if (!no) return null;
      deny(res, no);
      return false;
    }
    deny(res, "Not available on the public demo");
    return false;
  }
  if (method !== "POST") {
    deny(res, "Not available on the public demo");
    return false;
  }
  if (foreignOrigin(req)) {
    deny(res, "This origin may not use the Ferry demo");
    return false;
  }

  // sending coins out of the node: its owner only, rebuilt field by field (own.mjs)
  if (path === "/api/withdraw") {
    const no = ownRefusal(req);
    if (no) {
      deny(res, no);
      return false;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: 'Send a JSON body like {"asset": "zec", "amount": 10000000, "to": "u1…"}' });
      return false;
    }
    // a fee preview only from a daemon that says it previews: any other would send for real
    let preview = false;
    if (body?.dry_run === true) {
      try {
        const s = await daemonJson(key, "/api/status");
        preview = s.status === 200 && Array.isArray(s.body?.features) && s.body.features.includes("withdraw_preview");
      } catch {
        json(res, 502, { error: "Can't reach the daemon. Is it running?" });
        return false;
      }
    }
    const built = withdrawBody(body, { preview });
    if (built.error) {
      json(res, built.status ?? 400, { error: built.error });
      return false;
    }
    if (!built.body.dry_run) {
      // coins NEAR Intents delivered for a swap that is about to start, or a private swap's ZEC
      // between its two swaps: the daemon counts both as free, but they are spoken for
      if (NEAR?.holds().has(key)) {
        json(res, 409, { error: "A NEAR Intents swap is about to use this node's coins. Try again when it has started." });
        return false;
      }
      if (ROUTER && (await ROUTER.busy())) {
        json(res, 409, { error: "A private swap is using your node's coins. Try again when it finishes." });
        return false;
      }
    }
    return JSON.stringify(built.body);
  }

  if (TAKERS.has(key) && path === "/api/swaps") {
    // a NEAR buy's coins arrived on this daemon and its Ferry swap is about to spend them
    if (NEAR?.holds().has(key)) {
      json(res, 409, { error: "A NEAR Intents buy is about to use this node's coins. Try again when it has started." });
      return false;
    }
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
    // a firm quote, named by id: the signed quote this server got from that maker itself
    const quote = body?.quote == null ? null : QUOTES.find(MAKERS.makers.indexOf(maker), body.quote);
    if (body?.quote != null && !quote) {
      json(res, 400, { error: "That firm price has expired. Get a new one." });
      return false;
    }
    if (quote && (zat < quote.min_zat || zat > quote.max_zat)) {
      json(res, 400, { error: "The amount is outside that firm price's range. Get a new one." });
      return false;
    }
    // where the coins go: the person's own wallet, on their own node only (own.mjs); a public
    // demo's daemons pay their own wallets, whatever a browser says
    let receive = "";
    if (!ownRefusal(req)) {
      const f = receiveFields(body, key === "z" ? "sell" : key === "b" ? "buy" : (EXTRA.find((d) => d.key === key)?.side ?? "sell"));
      if (f.error) {
        json(res, 400, { error: f.error });
        return false;
      }
      receive = f.json;
    }
    // Several swaps run side by side: the daemon (and its partner) take as many as their free funds
    // and --max-swaps allow, and answer 409 "busy" past that (said plainly on the way back, in
    // proxy()). The one thing that waits: a sell on the pair a private swap is selling ZEC on, whose
    // bought ZEC sits unreserved in this daemon's wallet.
    const conflict = await routeConflict(key);
    if (conflict) {
      json(res, conflict.status, conflict.body);
      return false;
    }
    if (!takeStarts(req, res, 1)) return false;
    if (quote) QUOTES.take(quote);
    // the signed quote is forwarded as the maker sent it (its integers exact)
    if (quote) return `{"maker":${JSON.stringify(maker.url)},"zec_zat":${zat},"quote":${quote.json}${receive}}`;
    return `{"maker":${JSON.stringify(maker.url)},"zec_zat":${zat}${receive}}`;
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

function rewriteJson(up, res, fn = clampOffer) {
  let body = "";
  up.setEncoding("utf8");
  up.on("data", (c) => (body += c));
  up.on("end", () => {
    try {
      body = JSON.stringify(fn(JSON.parse(body)));
    } catch {
      /* not JSON: pass through */
    }
    res.end(body);
  });
}

// `name` events' data through `fn`: the daemons' status (clampOffer), the router's routes; `drop`'s
// messages left out: a daemon's withdrawals, for a page that doesn't own the node (sse.mjs)
function rewriteEvents(up, res, name = "status", fn = clampOffer, drop = []) {
  const pass = sseTransform({ rewrite: { [name]: fn }, drop });
  up.setEncoding("utf8");
  up.on("data", (chunk) => {
    const out = pass(chunk);
    if (out) res.write(out);
  });
  up.on("end", () => res.end());
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
    // a start the daemon (or its partner) can't take now: said plainly (busyBody)
    const busy = req.method === "POST" && path === "/api/swaps" && up.statusCode === 409;
    if ((path === "/api/status" && up.statusCode === 200) || busy) delete out["content-length"];
    if ((up.statusCode ?? 502) >= 300) req.ferryRefused?.();
    res.writeHead(up.statusCode ?? 502, out);
    // what the node sent out reaches its owner's page only
    if (sse && path === "/api/events") rewriteEvents(up, res, "status", clampOffer, ownRefusal(req) ? ["withdrawal"] : []);
    else if (path === "/api/status" && up.statusCode === 200) rewriteJson(up, res);
    else if (busy) rewriteJson(up, res, busyBody);
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
// router: /router/... to the user's ferry-route (private swaps), guarded like the daemons

const ROUTE_ID = "r[0-9a-f]{1,32}";
const ROUTER_READ = [/^\/api\/routes$/, new RegExp(`^/api/routes/${ROUTE_ID}$`), /^\/api\/events$/];

// Decide whether a /router request may go through: null (forward), a body to forward instead, or
// false after the response has been sent.
async function routerGuard(path, req, res) {
  const method = req.method;
  if (method === "GET" || method === "HEAD") {
    if (ROUTER_READ.some((r) => r.test(path))) return null;
    deny(res, "Not available on the public demo");
    return false;
  }
  if (method !== "POST") {
    deny(res, "Not available on the public demo");
    return false;
  }
  if (foreignOrigin(req)) {
    deny(res, "This origin may not use the Ferry demo");
    return false;
  }
  // one route moving at a time; ordinary swaps don't hold one back (routeIdle)
  const idle = async () => {
    const no = await routeIdle();
    if (no) json(res, no.status, no.body);
    return !no;
  };

  if (path === "/api/routes") {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: 'Send a JSON body like {"from": "btc", "to": "usdc-base", "zec_zat": 10000000, ...}' });
      return false;
    }
    // payout_to (swap 2 pays the person's own wallet) on their own node only
    const built = buildRoute(body, { list: await MAKERS.list(), resolve: MAKERS.resolve, legs: await ROUTER.legs(), maxZat: DEMO_MAX_ZAT, minZat: DEMO_MIN_ZAT, payout: !ownRefusal(req) });
    if (built.error) {
      json(res, built.status, { error: built.error });
      return false;
    }
    if (!(await idle())) return false;
    // two swaps: two starts against both limits
    if (!takeStarts(req, res, 2)) return false;
    return JSON.stringify(built.body);
  }

  const m = path.match(new RegExp(`^/api/routes/(${ROUTE_ID})/(continue|stop)$`));
  if (m && m[2] === "stop") return "";
  if (m) {
    // "Finish now": out of holding, a new second swap (one start, no other route moving); during the
    // pause, the same second swap sooner. Always on the route's own terms: no body gets through.
    let route;
    try {
      route = await ROUTER.call("GET", `/api/routes/${m[1]}`);
    } catch {
      json(res, 502, { error: "Can't reach the private swap service. Try again in a moment." });
      return false;
    }
    if (route.status === 200 && route.body?.state === "holding") {
      if (!(await idle())) return false;
      if (!takeStarts(req, res, 1)) return false;
    }
    return "{}";
  }

  deny(res, "Not available on the public demo");
  return false;
}

async function routerProxy(path, search, req, res) {
  const decision = await routerGuard(path, req, res);
  if (decision === false) return;
  if (path === "/api/events" && !openStream(req, res)) return;

  const headers = {};
  for (const k of FORWARD) if (typeof req.headers[k] === "string") headers[k] = req.headers[k];
  const token = ROUTER_TOKEN();
  if (token) headers.authorization = `Bearer ${token}`;
  let body = null;
  if (typeof decision === "string") {
    body = decision;
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(body);
  }

  const upstream = http.request(new URL(path + search, ROUTER.url), { method: req.method, headers }, (up) => {
    const out = { ...SECURITY };
    for (const [k, v] of Object.entries(up.headers)) if (!HOP.has(k) && !k.startsWith("access-control-")) out[k] = v;
    out["cache-control"] = "no-store";
    const type = String(up.headers["content-type"] ?? "");
    const sse = type.startsWith("text/event-stream");
    const views = type.startsWith("application/json");
    if (sse) out["x-accel-buffering"] = "no";
    if (views) delete out["content-length"];
    if ((up.statusCode ?? 502) >= 300) req.ferryRefused?.();
    res.writeHead(up.statusCode ?? 502, out);
    // the partners' URLs stay here, as in GET /api/makers
    if (sse) rewriteEvents(up, res, "route", publicRoute);
    else if (views) rewriteJson(up, res, publicRoute);
    else up.pipe(res);
    up.on("close", () => {
      if (!res.writableEnded) res.destroy();
    });
  });
  upstream.on("error", () => {
    req.ferryRefused?.();
    if (!res.headersSent) json(res, 502, { error: "Can't reach the private swap service. Is ferry-route running?" });
    else res.destroy();
  });
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
// firm quotes: POST /api/quotes {pair, direction, zec_zat}. The amount is rounded up to a bucket
// before anything leaves this server, and is never logged (quotes.mjs). The demo's own limit applies
// to the amount and to each quote's range.

async function serveQuotes(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  if (foreignOrigin(req)) return deny(res, "This origin may not use the Ferry demo");
  let body;
  try {
    body = JSON.parse(await readBody(req, 1024));
  } catch {
    return json(res, 400, { error: 'Send a JSON body like {"pair": "btc", "direction": "sell", "zec_zat": 10000000}' });
  }
  const zat = Number(body?.zec_zat);
  if (Number.isSafeInteger(zat) && zat > DEMO_MAX_ZAT) return json(res, 400, { error: `The public demo is limited to ${zec(DEMO_MAX_ZAT)} ZEC per swap` });
  const wait = quotesPerIp(clientIp(req)) || quotesInAll("all");
  if (wait) return json(res, 429, { error: "Too many price requests. Try again in a minute." }, { "retry-after": String(wait) });
  const r = await QUOTES.request(body);
  for (const q of r.body.quotes ?? []) {
    q.max_zat = Math.min(q.max_zat, DEMO_MAX_ZAT);
    if (DEMO_MIN_ZAT) q.min_zat = Math.max(q.min_zat, DEMO_MIN_ZAT);
  }
  json(res, r.status, r.body);
}

// ------------------------------------------------------------------------------------------------
// NEAR Intents: /api/near/... (near.mjs). Quotes are rate limited per IP and in all; a swap start
// takes the swap guards (nearAdmit) and only runs with FERRY_NEAR=1.

const nearHttp = NEAR
  ? nearRoutes(NEAR, {
      send: json,
      readBody,
      origin: (req) => (foreignOrigin(req) ? "This origin may not use the Ferry demo" : null),
      own: (req) => !ownRefusal(req),
      limit: (req) => nearPerIp(clientIp(req)) || nearInAll("all"),
      admit: nearAdmit,
    })
  : null;

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
  const m = url.pathname.match(/^\/daemon\/([a-z-]+)(\/.*)?$/);
  if (m && !Object.hasOwn(DAEMONS, m[1])) return json(res, 404, { error: "No such daemon on this server" });
  if (m) {
    proxy(m[1], m[2] ?? "/", url.search, req, res).catch((e) => {
      console.error("ferry-ui proxy:", e);
      if (!res.headersSent) json(res, 500, { error: "Internal error" });
    });
    return;
  }
  // exactly /router or /router/...: never /routerx
  if (url.pathname === "/router" || url.pathname.startsWith("/router/")) {
    if (!ROUTER) return json(res, 404, { error: "No private swaps on this server" });
    routerProxy(url.pathname.slice("/router".length) || "/", url.search, req, res).catch((e) => {
      console.error("ferry-ui router:", e?.message ?? "failed");
      if (!res.headersSent) json(res, 500, { error: "Internal error" });
    });
    return;
  }
  if (url.pathname === "/healthz") return json(res, 200, { ok: true });
  if (url.pathname.startsWith("/api/near/")) {
    if (!NEAR) return json(res, 404, { error: "NEAR Intents is off on this server" });
    nearHttp(req, res, url.pathname).catch((e) => {
      console.error("ferry-ui near:", e?.message ?? "failed");
      if (!res.headersSent) json(res, 500, { error: "Internal error" });
    });
    return;
  }
  if (url.pathname === "/api/pairs") {
    // routes: what the router can run (null without one, or while it can't be reached); node.own: this
    // page may say where coins go and send them out (FERRY_OWN_NODE=1, opened on loopback; own.mjs)
    (ROUTER ? ROUTER.legs() : Promise.resolve(null)).then((routes) => json(res, 200, { ...PAIRS_BODY, routes, node: { own: !ownRefusal(req) } }));
    return;
  }
  if (url.pathname === "/api/quotes") {
    serveQuotes(req, res).catch((e) => {
      console.error("ferry-ui quotes:", e?.message ?? "failed");
      if (!res.headersSent) json(res, 500, { error: "Internal error" });
    });
    return;
  }
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
  console.log(`  Z ${DAEMONS.z.url.origin}${MAIN_SELL === false ? " (no sell starts)" : ""}  B ${DAEMONS.b.url.origin}${MAIN_BUY === false ? " (no buy starts)" : ""}${EXTRA.map((d) => `  ${d.key.toUpperCase()} ${d.url}`).join("")}  makers ${MAKERS.makers.map((m) => `${m.name} (${m.pair})`).join(", ") || "none"}`);
  if (ROUTER) console.log(`  router ${ROUTER.url} (private swaps)`);
  console.log(
    OWN_NODE
      ? "  own node (FERRY_OWN_NODE=1): pages opened on loopback may choose where coins go and send them out"
      : "  public demo: swaps pay the daemons' own wallets, and nothing is sent out (FERRY_OWN_NODE=1 on your own node)",
  );
  if (NEAR) console.log(`  NEAR Intents ${env.FERRY_NEAR_URL || ONE_CLICK_URL}: quotes${NEAR_RUN ? ", swaps (FERRY_NEAR=1: your own node only)" : " only (FERRY_NEAR=1 runs swaps)"}${NEAR_JWT() ? ", with a JWT" : ""}`);
  console.log(`  demo: max ${zec(DEMO_MAX_ZAT)} ZEC, ${RATE_PER_HOUR} swaps/IP/hour, ${SWAPS_PER_HOUR} swaps/hour in all, ${SSE_PER_IP} streams/IP, ${SSE_TOTAL} streams in all, faults ${FAULTS ? "on" : "off"}${PUBLIC_ORIGIN ? `, origin ${PUBLIC_ORIGIN}` : ""}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
