// Private swaps (routes) for the UI servers (server/prod.mjs and the Vite dev server). Plain Node.
//
// ferry-route (crates/ferry-route) runs a route, coin A → shielded ZEC → coin C, as two swaps on the
// user's own daemons: leg 1 buys ZEC with coin A on their B daemon for pair A, leg 2 sells it for
// coin C on their Z daemon for pair C. The UI servers front it at /router/... with its bearer token
// added server-side, as they front the daemons at /daemon/<key>:
//   FERRY_ROUTER_URL                      the router's API (ferry-route --api-listen)
//   FERRY_ROUTER_TOKEN / _TOKEN_FILE      its token (<data-dir>/api-token)
//
// A browser starts a route by naming partners, by name or index as for a swap. The server maps them
// to allowlisted URLs, adds the other partners who could take leg 2 as fallbacks, and rebuilds the
// body (buildRoute), so no URL or address from a client ever reaches the router. GET /api/pairs says
// which routes the router can run (routeLegs), so a page without a router shows none of it.
import http from "node:http";
import https from "node:https";
import { PAIR_IDS } from "./pairs.mjs";
import { pairLabel } from "./quotes.mjs";

// The privacy pause between the two swaps, in seconds: [min, max], drawn once by the router.
export const PAUSES = { off: [0, 0], standard: [300, 1800], long: [3600, 21_600] };
// u64::MAX, as the router reads amounts
const U64_MAX = 18_446_744_073_709_551_615;

// "usdc-base" → "usdc": a route between two pairs of one asset is refused (amount in ≈ amount out)
export const assetOf = (id) => String(id).split("-")[0];

// GET /api/status's legs → the pairs a route can start from (the user's B daemons, which buy ZEC)
// and end in (their Z daemons, which sell it), or null when no route is possible.
export function routeLegs(status) {
  const legs = Array.isArray(status?.legs) ? status.legs : [];
  const of = (role) => PAIR_IDS.filter((id) => legs.some((l) => l?.pair === id && l?.role === role));
  const from = of("B");
  const to = of("Z");
  return from.some((a) => to.some((c) => assetOf(a) !== assetOf(c))) ? { from, to } : null;
}

// A route the router can run: A from a B leg, C to a Z leg, two different assets.
export const canRoute = (legs, from, to) => !!legs && legs.from.includes(from) && legs.to.includes(to) && assetOf(from) !== assetOf(to);

function hostPort(url) {
  try {
    const u = new URL(url);
    return [u.hostname.toLowerCase().replace(/^\[|\]$/g, ""), Number(u.port || (u.protocol === "https:" ? 443 : 80))];
  } catch {
    return null;
  }
}
const isLoopback = (h) => h === "localhost" || h === "::1" || /^127\./.test(h);

// The same partner as far as anyone can tell, as the router decides it (route.rs, Maker::same_partner):
// the same name, or the same URL host (on a loopback host, where a local demo runs every maker, the
// port too). The router refuses a route that has one partner on both legs, since that partner would
// see both sides.
export function samePartner(a, b) {
  const norm = (n) => (typeof n === "string" && n.trim() ? n.trim().toLowerCase() : null);
  if (norm(a?.name) && norm(a.name) === norm(b?.name)) return true;
  const x = hostPort(a?.url);
  const y = hostPort(b?.url);
  if (x && y) return x[0] === y[0] && (!isLoopback(x[0]) || x[1] === y[1]);
  return String(a?.url ?? "").replace(/\/+$/, "") === String(b?.url ?? "").replace(/\/+$/, "");
}

// A maker summary (GET /api/makers) that swaps `pair` with role `role` and takes swaps now.
const swaps = (m, pair, role) => {
  const want = pairLabel(pair);
  return !!want && m?.role === role && m.pair === want.pair && (want.chain === null || m.chain === want.chain);
};

const units = (v) => (typeof v === "number" && Number.isInteger(v) && v > 0 && v <= U64_MAX ? v : null);
const zecText = (zat) => (zat / 1e8).toFixed(2);
const coinOf = (pair) => pairLabel(pair)?.pair.split("/")[1] ?? pair;

// Rebuild a browser's POST /api/routes for the router.
//   in:  {from, to, zec_zat, maker1: name|index, maker2?: name|index|[...], max_in, min_out, pause?,
//         payout_to?}
//   out: {body} for the router, or {status, error}
// `list` is the maker directory's summaries, `resolve` maps a client's reference to an allowlisted
// entry ({name, url}), `legs` is routeLegs() of the router (null: none), and maxZat/minZat are the
// public demo's limits. `payout`: the person owns the node (own.mjs), so `payout_to` (where swap 2
// pays coin C: their own wallet) goes through; otherwise it is dropped, as on a public demo. Leg 2's partners are the ones asked for (if they take swaps), then every
// other partner who buys ZEC for coin C, best rate first and paused ones last, never one that is the
// same partner as leg 1's, at most 8.
export function buildRoute(body, { list, resolve, legs, maxZat = Infinity, minZat = 0, payout = false }) {
  const bad = (error) => ({ status: 400, error });
  if (!legs) return { status: 503, error: "Private swaps aren't available right now." };
  const from = body?.from;
  const to = body?.to;
  if (typeof from !== "string" || !legs.from.includes(from)) return bad("Private swaps can't start from that coin here.");
  if (typeof to !== "string" || !legs.to.includes(to)) return bad("Private swaps can't end in that coin here.");
  if (assetOf(from) === assetOf(to)) return bad("Pick two different coins: swapping a coin for itself would link the two sides.");
  const zat = body?.zec_zat;
  if (!Number.isSafeInteger(zat) || zat <= 0) return bad("zec_zat must be a positive whole number of zatoshi");
  if (zat > maxZat) return bad(`The public demo is limited to ${zecText(maxZat)} ZEC per swap`);
  if (zat < minZat) return bad(`The smallest demo swap is ${zecText(minZat)} ZEC`);
  const maxIn = units(body?.max_in);
  const minOut = units(body?.min_out);
  if (!maxIn || !minOut) return bad("max_in and min_out must be positive whole numbers of the coins' smallest units");
  const pause = body?.pause ?? "standard";
  if (typeof pause !== "string" || !Object.hasOwn(PAUSES, pause)) return bad('pause must be "off", "standard" or "long"');
  // the router takes 1 to 100 ASCII letters and digits; the leg-2 daemon checks it for its chain
  const payoutTo = payout && body?.payout_to != null && body.payout_to !== "" ? String(body.payout_to).trim() : null;
  if (payoutTo !== null && !/^[A-Za-z0-9]{8,100}$/.test(payoutTo)) return bad(`That ${coinOf(to)} address doesn't look right. Check it and try again.`);

  const summary = (e) => list.find((m) => m.name === e.name);
  const e1 = resolve(body?.maker1);
  if (!e1) return bad("Unknown partner for swap 1. Pick one from the list.");
  const s1 = summary(e1);
  if (!s1 || !swaps(s1, from, "Z") || !s1.available) return bad(`${e1.name} isn't selling ZEC for ${coinOf(from)} right now.`);

  const asked = body?.maker2 == null ? [] : Array.isArray(body.maker2) ? body.maker2.slice(0, 8) : [body.maker2];
  const picks = [];
  for (const ref of asked) {
    const e = resolve(ref);
    if (!e) return bad("Unknown partner for swap 2. Pick one from the list.");
    picks.push(e);
  }
  const rate = (m) => m.rate_sat_per_zec ?? 0;
  const others = list
    .filter((m) => swaps(m, to, "B"))
    .sort((a, b) => Number(b.available) - Number(a.available) || rate(b) - rate(a))
    .map((m) => resolve(m.index));
  const maker2 = [];
  for (const e of [...picks, ...others]) {
    const s = e && summary(e);
    if (!s || !swaps(s, to, "B") || (!s.available && !s.paused)) continue;
    if (samePartner(e, e1) || maker2.includes(e) || maker2.length >= 8) continue;
    maker2.push(e);
  }
  if (!maker2.some((e) => summary(e)?.available)) return bad(`No other partner is buying ZEC for ${coinOf(to)} right now.`);

  return {
    body: {
      from,
      to,
      zec_zat: zat,
      maker1: { url: e1.url, name: e1.name },
      maker2: maker2.map((e) => ({ url: e.url, name: e.name })),
      max_in: maxIn,
      min_out: minOut,
      delay_secs: PAUSES[pause],
      ...(payoutTo ? { payout_to: payoutTo } : {}),
    },
  };
}

// A route that is still moving (as opposed to done, failed, or holding ZEC for the user).
export const RUNNING = ["leg1", "settling", "pausing", "leg2"];
export const running = (v) => RUNNING.includes(v?.state);

// What a moving route keeps out of a direct start on `pair` (`side`: "sell" or "buy"), as the
// sentence to answer, or null. The ZEC a route bought waits in the daemon that sells it on (the
// route's `to` pair), and that daemon counts it as free: no direct sell there may spend it. If that
// daemon is also a partner others buy ZEC from (`sellerMakes`: started with --maker-offer), a buy on
// the pair could reach it too, so none starts either.
export function routeBlocks(routes, { pair, side, sellerMakes = false }) {
  if (!Array.isArray(routes) || !routes.some((v) => running(v) && v.to === pair)) return null;
  if (side === "sell") return "A private swap is selling ZEC on this pair right now. Try again when it finishes.";
  if (side === "buy" && sellerMakes) return "A private swap is using this pair's ZEC right now. Try again when it finishes.";
  return null;
}

// The router's views as a browser gets them: without the partners' URLs (GET /api/makers never
// shows one either).
export function publicRoute(v) {
  if (Array.isArray(v)) return v.map(publicRoute);
  if (v && Array.isArray(v.legs)) for (const l of v.legs) if (l && typeof l === "object") delete l.maker_url;
  return v;
}

// One JSON request to the router: no redirects, a timeout, at most 1 MB back. {status, body}.
function requestJson(target, method, token, body, timeoutMs) {
  const lib = target.protocol === "https:" ? https : http;
  const data = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
  const headers = { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  if (data !== null) Object.assign(headers, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  return new Promise((ok, fail) => {
    const req = lib.request(target, { method, headers, timeout: timeoutMs }, (res) => {
      let size = 0;
      const chunks = [];
      res.on("data", (c) => {
        size += c.length;
        if (size > 1 << 20) req.destroy(new Error("too large"));
        else chunks.push(c);
      });
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          /* not JSON */
        }
        ok({ status: res.statusCode ?? 502, body: parsed });
      });
      res.on("error", fail);
    });
    const deadline = setTimeout(() => req.destroy(new Error("timeout")), timeoutMs);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", fail);
    req.on("close", () => clearTimeout(deadline));
    req.end(data ?? undefined);
  });
}

// The UI server's link to the router. `token` is a function (the token file is re-read now and
// then). legs() is cached for ttlMs (a failure for a few seconds), so GET /api/pairs costs the router
// little; busy() asks every time.
export function routerLink({ url, token = () => null, timeoutMs = 5000, ttlMs = 30_000, request = requestJson }) {
  const base = new URL(url);
  let cache = { at: 0, ttl: 0, legs: null, pending: null };
  const call = (method, path, body) => request(new URL(path, base), method, token(), body, timeoutMs);
  return {
    url: base.href.replace(/\/+$/, ""),
    call,
    legs() {
      if (Date.now() - cache.at < cache.ttl) return Promise.resolve(cache.legs);
      if (cache.pending) return cache.pending;
      const pending = call("GET", "/api/status")
        .then(
          (r) => ({ legs: r.status === 200 ? routeLegs(r.body) : null, ok: r.status === 200 }),
          () => ({ legs: null, ok: false }),
        )
        .then(({ legs, ok }) => {
          cache = { at: Date.now(), ttl: ok ? ttlMs : 5000, legs, pending: null };
          return legs;
        });
      cache.pending = pending;
      return pending;
    },
    // whether a route is moving now; null when the router can't be asked
    async busy() {
      try {
        const r = await call("GET", "/api/routes");
        return r.status === 200 && Array.isArray(r.body) ? r.body.some(running) : null;
      } catch {
        return null;
      }
    },
  };
}
