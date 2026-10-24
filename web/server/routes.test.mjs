// `node --test server/routes.test.mjs` (in web/): private swaps (routes) as the UI servers start
// them: which routes a router offers, the same-partner rule, and how a browser's request is rebuilt
// (routes.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import { buildRoute, canRoute, publicRoute, routeBlocks, routeLegs, routerLink, samePartner } from "./routes.mjs";

const LEGS = { from: ["btc", "usdc-base"], to: ["btc", "usdc-base", "ltc"] };

// a maker directory: entries (what resolve() hands out) and summaries (GET /api/makers)
const entries = [
  { name: "Sandpiper", url: "http://127.0.0.1:7101/m/sandpiper", pair: "ZEC/BTC", chain: null },
  { name: "Egret", url: "http://127.0.0.1:7102/m/egret", pair: "ZEC/USDC", chain: "base" },
  { name: "Ibis", url: "http://127.0.0.1:7102/m/ibis", pair: "ZEC/USDC", chain: "base" },
  { name: "Tern", url: "http://127.0.0.1:7102/m/tern", pair: "ZEC/USDC", chain: "base" },
  { name: "Arbo", url: "http://127.0.0.1:7102/m/arbo", pair: "ZEC/USDC", chain: "arbitrum" },
  { name: "Kestrel", url: "http://127.0.0.1:7102/m/kestrel", pair: "ZEC/BTC", chain: null },
];
const summary = (i, role, rate, more = {}) => ({ index: i, name: entries[i].name, pair: entries[i].pair, chain: entries[i].chain, role, available: true, paused: false, online: true, rate_sat_per_zec: rate, ...more });
const list = [
  summary(0, "Z", 413_800),
  summary(1, "B", 41_250_000),
  summary(2, "B", 41_080_000),
  summary(3, "B", 41_900_000, { available: false, paused: true }),
  summary(4, "B", 42_000_000),
  summary(5, "B", 412_350),
];
const resolve = (ref) => (typeof ref === "number" ? entries[ref] ?? null : typeof ref === "string" ? entries.find((e) => e.name.toLowerCase() === ref.toLowerCase()) ?? null : null);
const ok = { from: "btc", to: "usdc-base", zec_zat: 100_000_000, maker1: "Sandpiper", maker2: "Ibis", max_in: 420_000, min_out: 40_000_000 };

test("the routes a router offers come from its legs: B legs start, Z legs end", () => {
  const status = { legs: [{ pair: "btc", role: "B" }, { pair: "usdc-base", role: "Z" }, { pair: "ltc", role: "Z" }, { pair: "nope", role: "Z" }] };
  assert.deepEqual(routeLegs(status), { from: ["btc"], to: ["ltc", "usdc-base"] });
  // one asset on both ends is no route
  assert.equal(routeLegs({ legs: [{ pair: "usdc-base", role: "B" }, { pair: "usdc-arbitrum", role: "Z" }] }), null);
  assert.equal(routeLegs({}), null);
  assert.equal(canRoute(LEGS, "btc", "usdc-base"), true);
  assert.equal(canRoute(LEGS, "usdc-base", "btc"), true);
  assert.equal(canRoute(LEGS, "btc", "btc"), false);
  assert.equal(canRoute(LEGS, "ltc", "btc"), false);
  assert.equal(canRoute(null, "btc", "usdc-base"), false);
});

test("the same partner: one name, or one host (one host and port on loopback)", () => {
  assert.equal(samePartner({ name: "Heron", url: "https://a.example" }, { name: " heron ", url: "https://b.example" }), true);
  assert.equal(samePartner({ name: "A", url: "https://maker.example:7112" }, { name: "B", url: "https://maker.example/usdc" }), true);
  assert.equal(samePartner({ name: "A", url: "http://127.0.0.1:7101/m/x" }, { name: "B", url: "http://127.0.0.1:7102/m/y" }), false);
  assert.equal(samePartner({ name: "A", url: "http://127.0.0.1:7102/m/x" }, { name: "B", url: "http://127.0.0.1:7102/m/y" }), true);
  assert.equal(samePartner({ url: "https://a.example" }, { url: "https://b.example" }), false);
});

test("a request is rebuilt with allowlisted URLs, leg 2's fallbacks and the pause", () => {
  const r = buildRoute(ok, { list, resolve, legs: LEGS });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.body, {
    from: "btc",
    to: "usdc-base",
    zec_zat: 100_000_000,
    maker1: { url: entries[0].url, name: "Sandpiper" },
    // the one asked for, then the others on that chain: available by rate, then paused
    maker2: [entries[2], entries[1], entries[3]].map(({ url, name }) => ({ url, name })),
    max_in: 420_000,
    min_out: 40_000_000,
    delay_secs: [300, 1800],
  });
  assert.deepEqual(buildRoute({ ...ok, pause: "off" }, { list, resolve, legs: LEGS }).body.delay_secs, [0, 0]);
  assert.deepEqual(buildRoute({ ...ok, pause: "long", maker2: undefined }, { list, resolve, legs: LEGS }).body.maker2[0].name, "Egret");
  // an index works as well as a name
  assert.equal(buildRoute({ ...ok, maker1: 0, maker2: [2] }, { list, resolve, legs: LEGS }).body.maker2[0].name, "Ibis");
});

test("payout_to goes through on the person's own node only", () => {
  const to = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
  assert.equal(buildRoute({ ...ok, payout_to: to }, { list, resolve, legs: LEGS }).body.payout_to, undefined, "dropped on a public demo");
  assert.equal(buildRoute({ ...ok, payout_to: ` ${to} ` }, { list, resolve, legs: LEGS, payout: true }).body.payout_to, to);
  assert.equal(buildRoute({ ...ok, payout_to: "" }, { list, resolve, legs: LEGS, payout: true }).body.payout_to, undefined);
  assert.match(buildRoute({ ...ok, payout_to: "0x90F7;rm" }, { list, resolve, legs: LEGS, payout: true }).error, /doesn't look right/);
});

test("what a browser can't do", () => {
  const no = (body, opts = {}) => buildRoute(body, { list, resolve, legs: LEGS, ...opts });
  assert.equal(no(ok, { legs: null }).status, 503);
  assert.match(no({ ...ok, to: "usdc-arbitrum" }).error, /can't end/);
  assert.match(no({ ...ok, from: "ltc" }).error, /can't start/);
  assert.match(no({ ...ok, from: "usdc-base", to: "usdc-base" }).error, /different coins/);
  assert.match(no({ ...ok, zec_zat: 1.5 }).error, /zec_zat/);
  assert.match(no({ ...ok, zec_zat: 300_000_000 }, { maxZat: 50_000_000 }).error, /limited to 0.50 ZEC/);
  assert.match(no({ ...ok, max_in: 0 }).error, /max_in/);
  assert.match(no({ ...ok, min_out: "lots" }).error, /min_out/);
  assert.match(no({ ...ok, pause: "forever" }).error, /pause/);
  // URLs never come from a client: a URL is just an unknown name
  assert.match(no({ ...ok, maker1: entries[0].url }).error, /Unknown partner/);
  assert.match(no({ ...ok, maker2: ["http://169.254.169.254"] }).error, /Unknown partner/);
  // a partner for the wrong pair or side
  assert.match(no({ ...ok, maker1: "Egret" }).error, /isn't selling ZEC for BTC/);
  // leg 2 never goes to leg 1's partner, and needs someone who takes swaps now
  const btcBack = no({ ...ok, from: "usdc-base", to: "btc", maker1: "Sandpiper" });
  assert.match(btcBack.error, /isn't selling ZEC for USDC/);
  const onlyPaused = list.map((m) => (m.name === "Egret" || m.name === "Ibis" ? { ...m, available: false } : m));
  assert.match(no(ok, { list: onlyPaused }).error, /No other partner is buying ZEC for USDC/);
  // and a sweep address or any other field is dropped, never forwarded
  const extra = no({ ...ok, sweep_to: "utest1attacker", delay_secs: [0, 0] });
  assert.equal("sweep_to" in extra.body, false);
  assert.deepEqual(extra.body.delay_secs, [300, 1800]);
});

test("a browser never chooses where a route pays: payout_to and sweep_to are dropped", () => {
  const r = buildRoute({ ...ok, payout_to: "bc1qattacker0000000000000000000000000000", sweep_to: "uregtest1attacker", keep_bps: 9999 }, { list, resolve, legs: LEGS });
  assert.equal(r.error, undefined);
  assert.deepEqual(Object.keys(r.body).sort(), ["delay_secs", "from", "maker1", "maker2", "max_in", "min_out", "to", "zec_zat"]);
});

test("a browser never sees a partner's URL in a route", () => {
  const v = { id: "r1", legs: [{ n: 1, maker: "Sandpiper", maker_url: "http://x" }, { n: 2, maker: null, maker_url: null }] };
  assert.deepEqual(publicRoute([v])[0].legs, [{ n: 1, maker: "Sandpiper" }, { n: 2, maker: null }]);
});

test("the router link caches its legs and asks every time whether a route is moving", async () => {
  const calls = [];
  const answers = { "/api/status": { status: 200, body: { legs: [{ pair: "btc", role: "B" }, { pair: "ltc", role: "Z" }] } }, "/api/routes": { status: 200, body: [{ state: "holding" }, { state: "pausing" }] } };
  const link = routerLink({ url: "http://127.0.0.1:7140/", token: () => "t", request: async (u, method, token) => (calls.push([method, u.pathname, token]), answers[u.pathname]) });
  assert.deepEqual(await link.legs(), { from: ["btc"], to: ["ltc"] });
  await link.legs();
  assert.equal(calls.filter((c) => c[1] === "/api/status").length, 1);
  assert.equal(await link.busy(), true);
  answers["/api/routes"].body = [{ state: "holding" }, { state: "done" }];
  assert.equal(await link.busy(), false);
  assert.deepEqual(calls[0], ["GET", "/api/status", "t"]);
  const down = routerLink({ url: "http://127.0.0.1:1", request: async () => Promise.reject(new Error("refused")) });
  assert.equal(await down.legs(), null);
  assert.equal(await down.busy(), null);
});

test("a moving route keeps out sells on its pair, and buys there when its seller is also a partner", () => {
  const moving = [{ state: "leg2", from: "btc", to: "usdc-base" }, { state: "done", to: "ltc" }];
  const sell = (pair) => routeBlocks(moving, { pair, side: "sell" });
  const buy = (pair, sellerMakes) => routeBlocks(moving, { pair, side: "buy", sellerMakes });
  assert.match(sell("usdc-base"), /selling ZEC on this pair/);
  assert.equal(sell("btc"), null, "the pair it buys on is not held");
  assert.equal(sell("ltc"), null, "a finished route holds nothing");
  assert.equal(buy("usdc-base", false), null, "the seller isn't a partner: no buy can reach its ZEC");
  assert.match(buy("usdc-base", true), /using this pair's ZEC/);
  assert.equal(buy("btc", true), null);
  for (const state of ["leg1", "settling", "pausing", "leg2"]) assert.ok(routeBlocks([{ state, to: "btc" }], { pair: "btc", side: "sell" }), state);
  for (const routes of [[], null, [{ state: "holding", to: "btc" }], [{ state: "failed", to: "btc" }]]) assert.equal(routeBlocks(routes, { pair: "btc", side: "sell" }), null);
});
