// node --test server/paths.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { aboutText, defaultPick, familyOf, ferryMinutes, nearToken, netKind, pickOn, resolvePath, stepWords, swapNet } from "./paths.mjs";

const SOL = "nep141:sol.omft.near";
const USDT_TRON = "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near";
const USDC_SOL = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
const ZEC_SOL = "1cs_v1:sol:spl:A7bd";
const tokens = {
  [SOL]: { symbol: "SOL", blockchain: "sol", ferry: null },
  [USDT_TRON]: { symbol: "USDT", blockchain: "tron", ferry: null },
  [USDC_SOL]: { symbol: "USDC", blockchain: "sol", ferry: null },
  [ZEC_SOL]: { symbol: "ZEC", blockchain: "sol", ferry: null },
};
const sol = nearToken(SOL);
const usdt = nearToken(USDT_TRON);
const usdcSol = nearToken(USDC_SOL);

// a server that does everything: BTC both ways, a router from BTC and USDC on Base to BTC, LTC and
// USDC on Base, NEAR Intents running (the operator's own node)
const full = {
  ready: true,
  sell: ["btc"],
  buy: ["btc"],
  nets: { btc: "main", ltc: "main", "usdc-base": "main" },
  routes: { from: ["btc", "usdc-base"], to: ["btc", "ltc", "usdc-base"] },
  near: { tokens, runs: { sell: true, buy: true }, reason: null, vias: { sell: ["btc"], buy: ["btc"] }, compose: { to: ["btc", "ltc"], from: ["btc"], runs: true } },
};
// the public demo: no router, NEAR Intents quotes only
const demo = { ready: true, sell: ["btc"], buy: ["btc"], routes: null, near: { tokens, runs: { sell: false, buy: false }, reason: "demo", vias: { sell: ["btc"], buy: ["btc"] }, compose: null } };

test("ZEC and a Ferry coin: one swap, either way", () => {
  const s = resolvePath("zec", "btc", full);
  assert.equal(s.kind, "sell");
  assert.equal(s.available, true);
  assert.equal(s.runs, true);
  assert.equal(s.button, "Sell ZEC");
  assert.equal(s.dir, "sell");
  assert.equal(s.pair, "btc");
  assert.equal(stepWords(s.steps), "Ferry");
  assert.equal(s.time, "about 45–60 min");
  assert.match(s.privacy, /nothing on either chain links the two sides/);
  const b = resolvePath("btc", "zec", full);
  assert.equal(b.kind, "buy");
  assert.equal(b.button, "Buy ZEC");
  assert.match(b.privacy, /arrives shielded/);
  // a coin this server doesn't swap that way
  const l = resolvePath("zec", "ltc", full);
  assert.equal(l.kind, "sell");
  assert.equal(l.available, false);
  assert.equal(l.reason, "Selling ZEC for LTC isn't available on this server.");
  assert.equal(resolvePath("ltc", "zec", full).reason, "Buying ZEC with LTC isn't available on this server.");
  assert.equal(resolvePath("zec", "usdc-base", full).time, "about 15–20 min");
});

test("a swap's time is a range for its coin and network, and none while the network is unknown", () => {
  const on = (nets) => ({ ...full, sell: ["btc", "ltc", "usdc-base", "weth-ethereum"], buy: ["btc", "usdc-base"], nets });
  const time = (sell, buy, nets) => resolvePath(sell, buy, on(nets)).time;
  // main networks: mostly 10 Zcash confirmations, and Bitcoin's own
  assert.equal(time("zec", "usdc-base", { "usdc-base": "main" }), "about 15–20 min");
  assert.equal(time("usdc-base", "zec", { "usdc-base": "main" }), "about 15–20 min");
  assert.equal(time("zec", "weth-ethereum", { "weth-ethereum": "main" }), "about 25–35 min");
  assert.equal(time("zec", "btc", { btc: "main" }), "about 45–60 min");
  assert.equal(time("zec", "ltc", { ltc: "main" }), "about 30–45 min");
  // test networks: Base Sepolia as measured, signet and Litecoin testnet from their block times
  assert.equal(time("zec", "usdc-base", { "usdc-base": "test" }), "about 2–10 min");
  assert.equal(time("zec", "btc", { btc: "test" }), "about 20–40 min");
  assert.equal(time("zec", "ltc", { ltc: "test" }), "about 10–20 min");
  assert.equal(time("btc", "zec", { btc: "local" }), "about 1–5 min");
  // not known yet: no time rather than a guess
  assert.equal(time("zec", "btc", {}), "");
  assert.deepEqual(resolvePath("zec", "btc", on({})).minutes, [0, 0]);
  // a mainnet range never starts below a test network's
  for (const p of ["btc", "ltc", "usdc-base", "weth-ethereum"]) {
    const [m, t, l] = ["main", "test", "local"].map((n) => ferryMinutes(p, n));
    assert.ok(m[0] > t[0] && t[0] >= l[0] && m[0] <= m[1] && t[0] <= t[1], p);
  }
  assert.deepEqual(ferryMinutes("usdc-arbitrum"), [15, 20], "main by default");
});

test("the kind of network a daemon reports", () => {
  for (const n of ["bitcoin", "main", "litecoin", "base", "ethereum", "arbitrum", "optimism"]) assert.equal(netKind(n), "main", n);
  for (const n of ["signet", "testnet", "test", "testnet4", "base-sepolia", "sepolia", "evm-59144"]) assert.equal(netKind(n), "test", n);
  for (const n of ["regtest", "anvil"]) assert.equal(netKind(n), "local", n);
  assert.equal(netKind(undefined), null);
  // the slower of a swap's two chains
  assert.equal(swapNet("base", "main"), "main");
  assert.equal(swapNet("anvil", "test"), "test");
  assert.equal(swapNet("anvil", "regtest"), "local");
  assert.equal(swapNet("base-sepolia", undefined), "test");
  assert.equal(swapNet(undefined, undefined), null);
});

test("the same coin on both sides is refused plainly", () => {
  for (const t of ["zec", "btc", sol]) {
    const p = resolvePath(t, t, full);
    assert.equal(p.kind, "same");
    assert.equal(p.available, false);
    assert.match(p.reason, /same coin on both sides/);
  }
  // one asset on two chains links the two ends by amount, through ZEC or not
  assert.match(resolvePath("usdc-base", "usdc-arbitrum", full).reason, /USDC for USDC would put about the same amount on both sides/);
  assert.match(resolvePath("usdc-base", usdcSol, full).reason, /USDC for USDC/);
  assert.match(resolvePath("zec", nearToken(ZEC_SOL), full).reason, /never sends ZEC through NEAR Intents/);
  assert.equal(familyOf("weth-base"), "eth");
});

test("ZEC and a NEAR Intents asset: Ferry, then NEAR Intents (or the other way)", () => {
  const s = resolvePath("zec", sol, full);
  assert.equal(s.kind, "near-sell");
  assert.equal(s.available, true);
  assert.equal(s.runs, true);
  assert.equal(s.button, "Sell ZEC for SOL");
  assert.equal(s.asset, SOL);
  assert.equal(stepWords(s.steps), "Ferry → BTC → NEAR Intents");
  assert.equal(s.time, "about 50–65 min");
  assert.match(s.privacy, /never goes to NEAR Intents.*public, and you trust NEAR Intents/);
  const b = resolvePath(sol, "zec", full);
  assert.equal(b.kind, "near-buy");
  assert.equal(b.button, "Buy ZEC with SOL");
  assert.equal(stepWords(b.steps), "NEAR Intents → BTC → Ferry");
  // the public demo quotes, and says why it doesn't run
  const d = resolvePath("zec", sol, demo);
  assert.equal(d.available, true);
  assert.equal(d.runs, false);
  assert.match(d.reason, /^Quote only\. .*your own Ferry node/);
  // no NEAR Intents here, or a token it doesn't list
  assert.equal(resolvePath("zec", sol, { ...full, near: null }).reason, "NEAR Intents isn't available on this server.");
  assert.equal(resolvePath("zec", nearToken("nep141:gone.near"), full).reason, "NEAR Intents doesn't list this token right now.");
  // still loading: nothing ruled out
  assert.equal(resolvePath("zec", sol, { ...full, near: undefined }).available, null);
});

test("coin to coin goes through shielded ZEC: a private swap, the default", () => {
  const r = resolvePath("btc", "usdc-base", full);
  assert.equal(r.kind, "route");
  assert.equal(r.available, true);
  assert.equal(r.private, true);
  assert.equal(r.button, "Swap privately");
  assert.equal(stepWords(r.steps), "Ferry → shielded ZEC → Ferry");
  assert.equal(r.time, "about 35–75 min");
  assert.equal(resolvePath("btc", "usdc-base", full, { pause: "off" }).time, "about 30–45 min");
  assert.equal(resolvePath("btc", "usdc-base", full, { pause: "long" }).time, "about 1½–7 hours");
  assert.match(r.privacy, /No transaction links your BTC to your USDC.*amounts and the timing could hint/);
  // no router
  assert.equal(resolvePath("btc", "usdc-base", { ...full, routes: null }).reason, "This server has no router, so coin-to-coin swaps aren't available here.");
  // the router doesn't take that end
  assert.equal(resolvePath("ltc", "usdc-base", full).reason, "Private swaps can't start from LTC on this server.");
  assert.equal(resolvePath("btc", "weth-base", full).reason, "Private swaps can't end in WETH on this server.");
});

test("a Ferry coin and a NEAR Intents asset: a private swap with NEAR Intents at the end", () => {
  const p = resolvePath("usdc-base", sol, full);
  assert.equal(p.kind, "route-near");
  assert.equal(p.available, true);
  assert.equal(p.runs, true);
  assert.equal(p.from, "usdc-base");
  assert.equal(p.to, null);
  assert.deepEqual(p.via, [["usdc-base", "btc"], ["usdc-base", "ltc"]]);
  assert.equal(stepWords(p.steps), "Ferry → shielded ZEC → Ferry → BTC → NEAR Intents");
  assert.equal(p.button, "Swap privately");
  assert.equal(p.time, "about 40–80 min");
  assert.match(p.privacy, /No transaction links your two Ferry swaps.*public, and you trust NEAR Intents/);
  // BTC → SOL: BTC can't hand BTC to NEAR Intents (the same asset at both Ferry ends), so through LTC
  const b = resolvePath("btc", sol, full);
  assert.deepEqual(b.via, [["btc", "ltc"]]);
  // without a coin to hand over
  assert.equal(resolvePath("btc", sol, { ...full, near: { ...full.near, compose: { to: ["btc"], from: [], runs: true } } }).reason, "No private swap here goes from BTC to a coin NEAR Intents takes.");
  assert.equal(resolvePath("btc", sol, { ...full, routes: null }).reason, "This server has no router, so coin-to-coin swaps aren't available here.");
  // quotes only on the demo (and no router there anyway)
  assert.equal(resolvePath("btc", sol, { ...full, near: { ...full.near, compose: { ...full.near.compose, runs: false }, reason: "mainnet" } }).reason, "Quote only: NEAR Intents runs on mainnet, and this Ferry node is on a test network.");
});

test("a NEAR Intents asset to a Ferry coin, and NEAR to NEAR: NEAR Intents first", () => {
  const p = resolvePath(sol, "usdc-base", full);
  assert.equal(p.kind, "near-route");
  assert.equal(p.available, true);
  assert.deepEqual(p.via, [["btc", "usdc-base"]]);
  assert.equal(stepWords(p.steps), "NEAR Intents → BTC → Ferry → shielded ZEC → Ferry");
  assert.equal(p.asset_in, SOL);
  // the router doesn't end in that coin
  assert.equal(resolvePath(sol, "weth-base", full).reason, "Private swaps can't end in WETH on this server.");
  // the only coin NEAR Intents can deliver here is BTC, and BTC to BTC isn't a private swap
  assert.equal(resolvePath(sol, "btc", full).reason, "No private swap here can take SOL from NEAR Intents to BTC.");
  const n = resolvePath(sol, usdt, full);
  assert.equal(n.kind, "near-near");
  assert.equal(n.available, true);
  assert.deepEqual(n.via, [["btc", "ltc"]]);
  assert.equal(stepWords(n.steps), "NEAR Intents → BTC → Ferry → shielded ZEC → Ferry → LTC → NEAR Intents");
  assert.equal(n.time, "about 45–85 min");
  assert.equal(resolvePath(sol, usdt, { ...full, near: { ...full.near, compose: { to: ["btc"], from: ["btc"], runs: true } } }).reason, "No private swap here can take SOL from NEAR Intents and hand USDT back to it.");
});

test("the opt-out for two coins: NEAR Intents alone, faster and public, never the default", () => {
  const withBtc = { ...full, near: { ...full.near, tokens: { ...tokens, "nep141:btc.omft.near": { symbol: "BTC", blockchain: "btc", ferry: "btc" }, usdcBase: { symbol: "USDC", blockchain: "base", ferry: "usdc-base" } }, runs: { sell: true, buy: true, direct: true } } };
  assert.equal(resolvePath("btc", "usdc-base", withBtc).kind, "route", "private by default");
  const p = resolvePath("btc", "usdc-base", withBtc, { public: true });
  assert.equal(p.kind, "near-only");
  assert.equal(p.available, true);
  assert.equal(p.runs, true);
  assert.equal(p.private, false);
  assert.equal(p.asset_in, "nep141:btc.omft.near");
  assert.equal(p.asset_out, "usdcBase");
  assert.equal(stepWords(p.steps), "NEAR Intents");
  assert.equal(p.time, "about 5–15 min");
  assert.equal(p.button, "Swap through NEAR Intents");
  assert.match(p.privacy, /^Faster, but public: anyone can link what you sold to what you got/);
  // it needs no router, but NEAR Intents must take both coins
  assert.equal(resolvePath(sol, usdt, { ...withBtc, routes: null }, { public: true }).available, true);
  assert.equal(resolvePath("ltc", sol, withBtc, { public: true }).reason, "NEAR Intents doesn't take LTC here.");
  // quotes only where NEAR swaps don't run; ZEC paths never opt out
  assert.match(resolvePath(sol, usdt, demo, { public: true }).reason, /^Quote only/);
  assert.equal(resolvePath("zec", "btc", withBtc, { public: true }).kind, "sell");
  assert.match(resolvePath("usdc-base", usdcSol, withBtc, { public: true }).reason, /USDC for USDC/);
});

test("every combination resolves to one path, with words for each", () => {
  const coins = ["zec", "btc", "ltc", "usdc-base", "weth-arbitrum", sol, usdt];
  for (const ctx of [full, demo, { ...full, ready: false }, { ready: true, sell: [], buy: [], routes: null, near: null }])
    for (const a of coins)
      for (const b of coins) {
        const p = resolvePath(a, b, ctx);
        assert.ok(p.kind, `${a} → ${b}`);
        assert.ok(p.button, `${a} → ${b}: a button`);
        if (p.available === false) assert.ok(p.reason && p.reason.endsWith("."), `${a} → ${b}: a plain reason (${p.reason})`);
        if (p.available && !p.runs) assert.match(p.reason, /^Quote only/);
        if (p.kind !== "same" && p.kind !== "none") assert.ok(p.privacy.length > 20, `${a} → ${b}: a privacy line`);
      }
  // before the server said what it runs, nothing is ruled out
  assert.equal(resolvePath("zec", "ltc", { ...full, ready: false }).available, null);
});

test("the first coins, picks and times", () => {
  assert.deepEqual(defaultPick(full), { sell: "zec", buy: "btc" });
  assert.deepEqual(defaultPick({ ready: true, sell: [], buy: ["ltc"], routes: null }), { sell: "ltc", buy: "zec" });
  assert.deepEqual(defaultPick({ ready: true, sell: [], buy: [], routes: { from: ["usdc-base"], to: ["btc"] } }), { sell: "zec", buy: "btc" });
  const pick = { sell: "zec", buy: "btc" };
  assert.deepEqual(pickOn(pick, "buy", "zec"), { sell: "btc", buy: "zec" }, "the other side's coin swaps the two");
  assert.deepEqual(pickOn(pick, "sell", "btc"), { sell: "btc", buy: "zec" });
  assert.deepEqual(pickOn(pick, "sell", "usdc-base"), { sell: "usdc-base", buy: "btc" });
  assert.deepEqual(pickOn(pick, "buy", sol), { sell: "zec", buy: sol });
  assert.equal(aboutText([30, 30]), "about 30 min");
  assert.equal(aboutText([45, 120]), "about 45 min–2 hours");
});
