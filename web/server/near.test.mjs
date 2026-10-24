// `node --test server/near.test.mjs` (in web/): NEAR Intents for the UI servers (near.mjs): 1Click's
// signatures (a real quote, and tampering), tokens and addresses, quotes composed with a Ferry leg,
// swaps started from them (and refused), the jobs that follow them, and the HTTP routes' guards.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  FERRY_ASSETS,
  PLACEHOLDER,
  dryAddress,
  segwitAddress,
  addressProblem,
  base58,
  bestFerry,
  buyNeed,
  cleanTokens,
  mainnet,
  nearDesk,
  nearRoutes,
  oneClick,
  ownDaemons,
  pairOfStatus,
  planRoute,
  quoteMessage,
  roundSig,
  stableJson,
  unbase58,
  verifyQuote,
} from "./near.mjs";

// A dry quote as 1Click answered it on 2026-10-20 (USDC on Base → SOL), signature and all.
const REAL = {
  quote: { amountIn: "50000000", amountInFormatted: "50.0", amountInUsd: "49.994950000000", minAmountIn: "50000000", amountOut: "478279901", amountOutFormatted: "0.478279901", amountOutUsd: "49.903724870340", minAmountOut: "473497101", timeEstimate: 32, refundFee: "2400", withdrawFee: "96046" },
  quoteRequest: {
    dry: true,
    depositMode: "SIMPLE",
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    depositType: "ORIGIN_CHAIN",
    destinationAsset: "nep141:sol.omft.near",
    amount: "50000000",
    refundTo: "0x0000000000000000000000000000000000000001",
    refundType: "ORIGIN_CHAIN",
    recipient: "7dKbmvKfvwZjJ1Y2NYCQKsEXATBMVvUSSbYmdbHxQk5i",
    recipientType: "DESTINATION_CHAIN",
    deadline: "2026-10-20T14:40:11.746Z",
    confidentiality: "public",
    quoteWaitingTimeMs: 0,
    insured: false,
    appFees: [{ recipient: "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd", fee: 20 }],
  },
  signature: "ed25519:2T54vUf3NPrHGvcbQXuE1LdVkniKMdX2ZjLCsUHDai3RsZx2uDJRNjnYyVNnBKNpKm971c2NXrzSdHB4mojAWugJ",
  timestamp: "2026-10-20T12:40:12.459Z",
  correlationId: "181ad0d8-282e-4feb-855d-5eafe7eb6d13",
};

test("1Click's own signature checks out, and any change to the quote breaks it", () => {
  assert.equal(verifyQuote(REAL), true);
  const changed = (f) => {
    const r = structuredClone(REAL);
    f(r);
    return verifyQuote(r);
  };
  assert.equal(changed((r) => (r.quote.amountOut = "478279902")), false);
  assert.equal(changed((r) => (r.quoteRequest.recipient = "8dKbmvKfvwZjJ1Y2NYCQKsEXATBMVvUSSbYmdbHxQk5i")), false);
  assert.equal(changed((r) => (r.timestamp = "2026-10-20T12:40:13.459Z")), false);
  // fields 1Click doesn't sign may change (its SDK leaves them out too)
  assert.equal(changed((r) => (r.quoteRequest.appFees = [])), true);
  assert.equal(changed((r) => (r.signature = "ed25519:abc")), false);
  // someone else's key
  assert.equal(verifyQuote(REAL, "ed25519:8upG3kYAvbQxAWG44Mwf4FEvvhkBq6KZHCm3m2XZecHm"), false);
});

test("base58 and stable JSON, as 1Click's SDK does them", () => {
  const b = Buffer.from("0000ff01a2", "hex");
  assert.deepEqual(unbase58(base58(b)), b);
  assert.equal(base58(Buffer.from([0, 0, 1])), "112");
  assert.equal(stableJson({ b: 1, a: { d: undefined, c: [2, "x"] } }), '{"a":{"c":[2,"x"]},"b":1}');
});

test("tokens: only well-formed entries; native ZEC is never offered", () => {
  const raw = [
    { assetId: "nep141:sol.omft.near", symbol: "SOL", blockchain: "sol", decimals: 9, price: 104.3, extra: "dropped" },
    { assetId: "nep141:zec.omft.near", symbol: "ZEC", blockchain: "zec", decimals: 8, price: 1148 },
    { assetId: "bad id with spaces", symbol: "X", blockchain: "sol", decimals: 9 },
    { assetId: "nep141:x", symbol: "<script>", blockchain: "sol", decimals: 9 },
    { assetId: "nep141:y", symbol: "Y", blockchain: "sol", decimals: 99 },
    { assetId: "nep141:sol.omft.near", symbol: "DUP", blockchain: "sol", decimals: 9 },
    "nope",
  ];
  const t = cleanTokens(raw);
  assert.deepEqual(t.map((x) => x.symbol), ["SOL", "ZEC"]);
  assert.equal("extra" in t[0], false);
  assert.deepEqual(cleanTokens({}), []);
});

test("addresses: a first format check per chain, and never a Zcash address", () => {
  assert.equal(addressProblem("sol", "7dKbmvKfvwZjJ1Y2NYCQKsEXATBMVvUSSbYmdbHxQk5i"), null);
  assert.equal(addressProblem("eth", "0x2527D02599Ba641c19FEa793cD0F167589a0f10D"), null);
  assert.equal(addressProblem("base", "0x2527D02599Ba641c19FEa793cD0F167589a0f10"), "Enter an address that starts with 0x and has 40 hex characters.");
  assert.equal(addressProblem("btc", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"), null);
  assert.equal(addressProblem("btc", "0x2527D02599Ba641c19FEa793cD0F167589a0f10D") !== null, true);
  assert.equal(addressProblem("near", "alice.near"), null);
  assert.equal(addressProblem("tron", "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7"), null);
  assert.equal(addressProblem("xrp", "rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv"), null);
  assert.match(addressProblem("sol", "t1Ku2KLyndDPsR32jwnrTMd3yvi9tfFP8ML"), /Zcash address/);
  assert.match(addressProblem("eth", "u1qwertyuiopasdfghjklzxcvbnm1234567890qwertyuiop"), /Zcash address/);
  assert.equal(addressProblem("zec", "anything"), "Ferry never sends ZEC through NEAR Intents.");
  assert.equal(addressProblem("sol", ""), "Enter an address.");
  assert.equal(addressProblem("sol", "has space"), "That doesn't look like an address.");
  // a chain without a known format: anything address-like, and 1Click decides
  assert.equal(addressProblem("qtc", "qtc1abcdefgh12345"), null);
});

test("dry quotes' placeholder addresses: valid on their chain, held by nobody, NEAR Intents' own account elsewhere", () => {
  // BIP-173's own test vector
  assert.equal(segwitAddress("bc", Buffer.from("751e76e8199196d454941c45d1b3a323f1433bd6", "hex")), "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
  for (const chain of ["btc", "ltc", "sol", "eth", "base", "arb", "op", "bsc"]) {
    const [a, type] = dryAddress(chain, "DESTINATION_CHAIN");
    assert.equal(type, "DESTINATION_CHAIN");
    assert.equal(addressProblem(chain, a), null, `${chain}: ${a}`);
  }
  assert.deepEqual(dryAddress("tron", "ORIGIN_CHAIN"), [PLACEHOLDER, "INTENTS"]);
});

test("amounts: three significant digits for a dry quote, and what a buy asks for", () => {
  assert.equal(roundSig(412_345n), 412_000n);
  assert.equal(roundSig(412_345n, true), 413_000n);
  assert.equal(roundSig(412_000n, true), 412_000n);
  assert.equal(roundSig(41n), 41n);
  // 1% more than the ZEC costs, and the lock's fee on a UTXO coin
  assert.equal(buyNeed(410_000n, "btc"), 414_100n + 10_000n);
  assert.equal(buyNeed(41_250_000n, "usdc-base"), 41_662_500n);
});

test("a daemon's pair and network", () => {
  assert.equal(pairOfStatus({ chains: { btc: { coin: "usdc", network: "arbitrum" } } }), "usdc-arbitrum");
  assert.equal(pairOfStatus({ chains: { btc: { coin: "weth", network: "anvil" } } }), "weth-base");
  assert.equal(pairOfStatus({ chains: { btc: { coin: "ltc" } } }), "ltc");
  assert.equal(pairOfStatus({}), "btc");
  assert.equal(mainnet({ chains: { btc: { network: "bitcoin" }, zec: { network: "main" } } }), true);
  assert.equal(mainnet({ chains: { btc: { network: "base" }, zec: { network: "test" } } }), false);
  assert.equal(mainnet({ chains: { btc: { network: "signet" }, zec: { network: "main" } } }), false);
});

// ------------------------------------------------------------------------------------------------
// a fake world: makers, the user's daemons, and a 1Click that signs with its own key

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PUB = `ed25519:${base58(publicKey.export({ format: "der", type: "spki" }).subarray(-32))}`;
const TOKENS = [
  { assetId: FERRY_ASSETS.btc.assetId, symbol: "BTC", blockchain: "btc", decimals: 8, price: 100_000 },
  { assetId: FERRY_ASSETS["usdc-base"].assetId, symbol: "USDC", blockchain: "base", decimals: 6, price: 1 },
  { assetId: "nep141:sol.omft.near", symbol: "SOL", blockchain: "sol", decimals: 9, price: 100 },
  { assetId: "nep141:zec.omft.near", symbol: "ZEC", blockchain: "zec", decimals: 8, price: 400 },
  { assetId: "nep141:tron-usdt.omft.near", symbol: "USDT", blockchain: "tron", decimals: 6, price: 1 },
];
const SOL = "7dKbmvKfvwZjJ1Y2NYCQKsEXATBMVvUSSbYmdbHxQk5i";

function fakeOneClick({ tamper = null } = {}) {
  const calls = [];
  const deposits = new Map();
  const request = async (url, opts) => {
    calls.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body: opts.body, headers: opts.headers });
    if (url.pathname === "/v0/tokens") return { status: 200, body: TOKENS };
    if (url.pathname === "/v0/status") {
      const d = deposits.get(url.searchParams.get("depositAddress"));
      return d ? { status: 200, body: { status: d.status, quoteResponse: d.response, swapDetails: d.details ?? {} } } : { status: 404, body: { message: "Deposit address not found" } };
    }
    const q = opts.body;
    if (q.recipientType === "DESTINATION_CHAIN" && q.recipient === "11111111111111111111111111111111") return { status: 400, body: { message: "recipient is not valid" } };
    const from = TOKENS.find((t) => t.assetId === q.originAsset);
    const to = TOKENS.find((t) => t.assetId === q.destinationAsset);
    const rate = (v) => (BigInt(v) * BigInt(Math.round(from.price * 1e6)) * 10n ** BigInt(to.decimals)) / (BigInt(Math.round(to.price * 1e6)) * 10n ** BigInt(from.decimals));
    const back = (v) => (BigInt(v) * BigInt(Math.round(to.price * 1e6)) * 10n ** BigInt(from.decimals)) / (BigInt(Math.round(from.price * 1e6)) * 10n ** BigInt(to.decimals));
    const out = q.swapType === "EXACT_OUTPUT" ? BigInt(q.amount) : rate(q.amount);
    const inn = q.swapType === "EXACT_OUTPUT" ? back(q.amount) : BigInt(q.amount);
    const quote = { amountIn: inn.toString(), amountInFormatted: "x", amountInUsd: "1", minAmountIn: ((inn * 99n) / 100n).toString(), amountOut: out.toString(), amountOutFormatted: "y", amountOutUsd: "1", minAmountOut: ((out * 99n) / 100n).toString(), timeEstimate: 30, withdrawFee: "0" };
    if (!q.dry) Object.assign(quote, { depositAddress: from.blockchain === "btc" ? `bc1qdeposit${calls.length}xyzxyzxyzxyzxyz` : SOL.replace("7", String(calls.length % 9)), deadline: q.deadline });
    const response = { quote, quoteRequest: { ...q }, timestamp: new Date().toISOString(), signature: "", correlationId: "c" };
    response.signature = `ed25519:${base58(sign(null, Buffer.from(quoteMessage(response), "utf8"), privateKey))}`;
    tamper?.(response);
    if (!q.dry) deposits.set(quote.depositAddress, { status: "PENDING_DEPOSIT", response });
    return { status: 201, body: response };
  };
  return { link: oneClick({ url: "http://127.0.0.1:9", request, jwt: "partner-jwt" }), calls, deposits };
}

const MAKERS = [
  { name: "Kestrel", url: "http://maker.example/kestrel", pair: "ZEC/BTC", chain: null },
  { name: "Egret", url: "http://maker.example/egret", pair: "ZEC/USDC", chain: "base" },
  { name: "Sandpiper", url: "http://maker.example/sandpiper", pair: "ZEC/BTC", chain: null },
];
const summary = (i, role, rate, more = {}) => ({ index: i, name: MAKERS[i].name, pair: MAKERS[i].pair, chain: MAKERS[i].chain, role, available: true, paused: false, online: true, rate_sat_per_zec: rate, min_zat: 1_000_000, max_zat: 1_000_000_000, fee_sat: MAKERS[i].chain ? null : 2000, liquidity_zat: null, ...more });
// every partner's offer lists "payout" (it can pay a sell's coin to an address of ours) unless `old`
const directory = (list = [summary(0, "B", 400_000), summary(1, "B", 401_000_000), summary(2, "Z", 410_000)], old = []) => ({
  makers: MAKERS,
  list: async () => list,
  resolve: () => null,
  offerOf: (i) => ({ features: old.includes(MAKERS[i].name) ? [] : ["payout"] }),
});

function fakeDaemons({ mainnet: main = true, features = ["route", "payout"], balance = 0 } = {}) {
  const net = (n) => (main ? n : "regtest");
  const statuses = {
    z: { role: "Z", chains: { btc: { coin: "btc", network: net("bitcoin") }, zec: { network: main ? "main" : "regtest" } }, offer: {}, balances: {}, features },
    "usdc-base": { role: "Z", chains: { btc: { coin: "usdc", network: main ? "base" : "base-sepolia" }, zec: { network: main ? "main" : "test" } }, offer: {}, balances: {}, features },
    b: { role: "B", chains: { btc: { coin: "btc", network: net("bitcoin") }, zec: { network: main ? "main" : "regtest" } }, offer: {}, balances: { btc_sat: balance }, features },
  };
  const swaps = [];
  const call = async (key, method, path, body) => {
    if (path === "/api/status") return { status: 200, body: statuses[key] };
    if (path === "/api/addresses") return { status: 200, body: { btc: { address: key === "usdc-base" ? "0x2527D02599Ba641c19FEa793cD0F167589a0f10D" : "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" } } };
    if (method === "POST" && path === "/api/swaps") {
      const b = JSON.parse(body);
      swaps.push({ key, body: b, raw: body, id: `s${swaps.length}`, outcome: null });
      return { status: 201, body: { id: `s${swaps.length - 1}` } };
    }
    const m = path.match(/^\/api\/swaps\/(s\d+)$/);
    if (m) {
      const s = swaps.find((x) => x.id === m[1]);
      return { status: 200, body: { id: s.id, state: s.outcome ? "Done" : "ZecLocked", outcome: s.outcome, amounts: { btc_sat: 1 } } };
    }
    return { status: 404, body: null };
  };
  const daemons = ownDaemons({ sell: [{ key: "z", auto: true }, { key: "usdc-base", pair: "usdc-base" }], buy: [{ key: "b", auto: true }], call, ttlMs: 0 });
  return { call, daemons, swaps, statuses };
}

function desk(opts = {}) {
  const one = opts.one ?? fakeOneClick();
  const d = opts.d ?? fakeDaemons(opts);
  const n = nearDesk({ link: one.link, directory: directory(opts.makers, opts.old), daemons: d.daemons, call: d.call, execution: opts.execution ?? true, pubkey: PUB, tickMs: 1e9, statusEveryMs: 0, log: () => {}, ...(opts.desk ?? {}) });
  return { n, one, d };
}

test("a quote: the best coin Ferry swaps here, then NEAR Intents' dry quote for what it comes to", async () => {
  const { n, one } = desk();
  const r = await n.quote({ direction: "sell", zec_zat: 100_000_000, asset: "nep141:sol.omft.near" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // 1 ZEC is 0.004 BTC ($400, less the 2000 sat fee) or 401 USDC: USDC on Base wins
  assert.equal(r.body.via, "usdc-base");
  assert.equal(r.body.maker, "Egret");
  assert.equal(r.body.ferry.units, "401000000");
  assert.equal(r.body.near.amount_out, String(4_010_000_000n));
  assert.equal(r.body.near.approximate, true);
  // the time: Ferry's usual range on Base mainnet (15-20 min), plus NEAR Intents' own estimate
  assert.deepEqual(r.body.ferry.time_range_s, [900, 1200]);
  assert.deepEqual(r.body.time_range_s, [900 + r.body.near.time_s, 1200 + r.body.near.time_s]);
  assert.equal(r.body.time_s, 1050 + r.body.near.time_s);
  const asked = one.calls.find((c) => c.path === "/v0/quote").body;
  assert.equal(asked.dry, true);
  assert.equal(asked.swapType, "FLEX_INPUT");
  // a row's quote: a rounded amount, and NEAR Intents placeholders, never a real address
  assert.equal(asked.amount, "401000000");
  assert.deepEqual([asked.recipient, asked.recipientType], dryAddress("sol", "DESTINATION_CHAIN"));
  assert.deepEqual([asked.refundTo, asked.refundType], dryAddress("base", "ORIGIN_CHAIN"));
  assert.equal(one.calls.find((c) => c.path === "/v0/quote").headers.authorization, "Bearer partner-jwt");
  // a buy: the cheapest route, an exact output of the coin plus the buffer
  const b = await n.quote({ direction: "buy", zec_zat: 100_000_000, asset: "nep141:sol.omft.near" });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(b.body.via, "btc");
  assert.equal(b.body.ferry.units, String(buyNeed(410_000n, "btc")));
  assert.deepEqual(b.body.ferry.time_range_s, [2700, 3600], "Bitcoin mainnet: 45-60 min");
  const exact = one.calls.filter((c) => c.path === "/v0/quote").at(-1).body;
  assert.equal(exact.swapType, "EXACT_OUTPUT");
  assert.equal(exact.amount, String(roundSig(buyNeed(410_000n, "btc"), true)));
});

test("a quote checks the address: the format here, then 1Click's word", async () => {
  const { n } = desk();
  let r = await n.quote({ direction: "sell", zec_zat: 50_000_000, asset: "nep141:sol.omft.near", address: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D", exact: true });
  assert.equal(r.status, 400);
  assert.equal(r.body.field, "address");
  r = await n.quote({ direction: "sell", zec_zat: 50_000_000, asset: "nep141:sol.omft.near", address: "11111111111111111111111111111111", exact: true });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /isn't a valid address/);
  r = await n.quote({ direction: "sell", zec_zat: 50_000_000, asset: "nep141:sol.omft.near", address: SOL, exact: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.address, "ok");
  assert.equal(r.body.near.approximate, false);
  // what a browser can't ask
  assert.equal((await n.quote({ direction: "sideways", zec_zat: 1, asset: "nep141:sol.omft.near" })).status, 400);
  assert.equal((await n.quote({ direction: "sell", zec_zat: 1.5, asset: "nep141:sol.omft.near" })).status, 400);
  assert.equal((await n.quote({ direction: "sell", zec_zat: 1e8, asset: "nep141:zec.omft.near" })).status, 400);
  assert.equal((await n.quote({ direction: "sell", zec_zat: 1e8, asset: "http://evil.example" })).status, 400);
});

test("a quote whose signature doesn't check out is never shown", async () => {
  const one = fakeOneClick({ tamper: (r) => (r.quote.amountOut = "999999999999") });
  const { n } = desk({ one });
  const r = await n.quote({ direction: "sell", zec_zat: 100_000_000, asset: "nep141:sol.omft.near" });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /signature/);
});

test("on a public demo, or a test network, quotes only", async () => {
  const off = desk({ execution: false });
  const q = await off.n.quote({ direction: "sell", zec_zat: 100_000_000, asset: "nep141:sol.omft.near" });
  assert.equal(q.status, 200);
  assert.equal(q.body.execution, false);
  assert.equal(q.body.reason, "demo");
  const s = await off.n.start({ direction: "sell", zec_zat: 100_000_000, asset: "nep141:sol.omft.near", address: SOL, min_out: "1" });
  assert.equal(s.status, 403);
  assert.equal(off.one.calls.some((c) => c.body && c.body.dry === false), false);
  assert.equal(off.d.swaps.length, 0);
  const info = await off.n.info();
  assert.deepEqual(info.execution, { sell: false, buy: false, direct: false });
  assert.equal(info.reason, "demo");
  assert.equal(info.tokens.some((t) => t.blockchain === "zec"), false);
  assert.equal(info.tokens.find((t) => t.symbol === "BTC").ferry, "btc");

  const test_ = desk({ mainnet: false });
  const t = await test_.n.start({ direction: "sell", zec_zat: 100_000_000, asset: "nep141:sol.omft.near", address: SOL, min_out: "1" });
  assert.equal(t.status, 409);
  assert.match(t.body.error, /mainnet/);
  assert.equal((await test_.n.info()).reason, "mainnet");
});

test("the info says the host's per-swap range, so a card can start inside it", async () => {
  assert.equal((await desk().n.info()).limits, null);
  const capped = desk({ desk: { limits: { maxZat: 50_000_000, minZat: 1_000_000 } } });
  assert.deepEqual((await capped.n.info()).limits, { max_zat: 50_000_000, min_zat: 1_000_000 });
  // and a quote above it is refused, which is what a card that ignored the range kept hitting
  const over = await capped.n.quote({ direction: "sell", zec_zat: 100_000_000, asset: "nep141:sol.omft.near" });
  assert.equal(over.status, 400);
  assert.match(over.body.error, /limited to 0\.50 ZEC/);
});

test("a sell: a real quote to the person's address, then the Ferry swap paying into its deposit address", async () => {
  const { n, one, d } = desk();
  let gated = null;
  const r = await n.start(
    { direction: "sell", zec_zat: 100_000_000, asset: "nep141:sol.omft.near", address: SOL, min_out: "3900000000", via: "usdc-base", sweep_to: "evil", payout_to: "evil" },
    { admit: async (w) => ((gated = w), null) },
  );
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(gated, { key: "usdc-base", pair: "usdc-base", kind: "sell" });
  const real = one.calls.find((c) => c.body?.dry === false).body;
  assert.equal(real.recipient, SOL);
  assert.equal(real.recipientType, "DESTINATION_CHAIN");
  // a refund goes to the person's own Ferry node, never anywhere a browser said
  assert.equal(real.refundTo, "0x2527D02599Ba641c19FEa793cD0F167589a0f10D");
  assert.equal(real.refundType, "ORIGIN_CHAIN");
  assert.equal(real.amount, "401000000");
  const start = d.swaps[0];
  assert.equal(start.key, "usdc-base");
  assert.equal(start.body.maker, "http://maker.example/egret");
  assert.equal(start.body.payout_to, r.body.near.deposit_address);
  assert.equal(start.body.min_counter, 396_990_000);
  assert.equal("sweep_to" in start.body, false);
  assert.equal(r.body.state, "ferry");
  assert.equal(r.body.near.verified, true);
  assert.equal(r.body.near.signature.startsWith("ed25519:"), true);

  // the Ferry swap finishes: NEAR Intents takes over, then delivers
  start.outcome = "swapped";
  await n.tick();
  assert.equal(n.job(r.body.id).state, "near");
  one.deposits.get(r.body.near.deposit_address).status = "PROCESSING";
  await n.tick();
  assert.equal(n.job(r.body.id).near.status, "PROCESSING");
  Object.assign(one.deposits.get(r.body.near.deposit_address), { status: "SUCCESS", details: { amountOut: "4010000000", destinationChainTxHashes: [{ hash: "abc", explorerUrl: "https://solscan.io/tx/abc" }, { hash: "x", explorerUrl: "javascript:alert(1)" }] } });
  await n.tick();
  const done = n.job(r.body.id);
  assert.equal(done.state, "done");
  assert.deepEqual(done.near.details.destination_txs, [
    { hash: "abc", url: "https://solscan.io/tx/abc" },
    { hash: "x", url: null },
  ]);
  assert.equal(n.jobs().length, 1);
});

test("a sell is refused before anything moves", async () => {
  // an older ferryd without payout_to
  const old = desk({ features: ["route"] });
  let r = await old.n.start({ direction: "sell", zec_zat: 100_000_000, asset: "nep141:sol.omft.near", address: SOL, min_out: "1" });
  assert.equal(r.status, 501);
  assert.equal(old.one.calls.some((c) => c.body?.dry === false), false);
  // a partner whose ferryd can't pay out to an address of ours isn't asked: Egret is out, so the
  // sell goes through BTC with Kestrel; with neither, there's no route
  const oldMaker = desk({ old: ["Egret"] });
  const q = await oldMaker.n.quote({ direction: "sell", zec_zat: 100_000_000, asset: "nep141:sol.omft.near" });
  assert.equal(q.body.via, "btc");
  assert.equal(q.body.maker, "Kestrel");
  const none = desk({ old: ["Egret", "Kestrel"] });
  r = await none.n.start({ direction: "sell", zec_zat: 100_000_000, asset: "nep141:sol.omft.near", address: SOL, min_out: "1" });
  assert.equal(r.status, 409);
  // the price moved below what the person agreed to: the deposit address is never paid
  const moved = desk();
  let refunds = 0;
  r = await moved.n.start({ direction: "sell", zec_zat: 100_000_000, asset: "nep141:sol.omft.near", address: SOL, min_out: "4000000000" }, { refused: () => refunds++ });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "price_moved");
  assert.equal(refunds, 1);
  assert.equal(moved.d.swaps.length, 0);
  // a quote that changed on the way, or whose signature fails
  const swapped = desk({ one: fakeOneClick({ tamper: (x) => !x.quoteRequest.dry && (x.quoteRequest.recipient = "8dKbmvKfvwZjJ1Y2NYCQKsEXATBMVvUSSbYmdbHxQk5i") }) });
  r = await swapped.n.start({ direction: "sell", zec_zat: 100_000_000, asset: "nep141:sol.omft.near", address: SOL, min_out: "1" });
  assert.equal(r.status, 502);
  assert.equal(swapped.d.swaps.length, 0);
  // the guard says no
  const busy = desk();
  r = await busy.n.start({ direction: "sell", zec_zat: 100_000_000, asset: "nep141:sol.omft.near", address: SOL, min_out: "1" }, { admit: async () => ({ status: 409, body: { error: "busy" } }) });
  assert.equal(r.status, 409);
  assert.equal(busy.one.calls.some((c) => c.body?.dry === false), false);
  // a Zcash address, or none
  r = await busy.n.start({ direction: "sell", zec_zat: 100_000_000, asset: "nep141:sol.omft.near", address: "t1Ku2KLyndDPsR32jwnrTMd3yvi9tfFP8ML", min_out: "1" });
  assert.equal(r.status, 400);
  assert.equal(r.body.field, "address");
});

test("a buy: a deposit address for the person's coin, then the Ferry buy once NEAR Intents delivered", async () => {
  const { n, one, d } = desk();
  const r = await n.start({ direction: "buy", zec_zat: 100_000_000, asset: "nep141:sol.omft.near", address: SOL, max_in: "100000000000" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.state, "deposit");
  const real = one.calls.find((c) => c.body?.dry === false).body;
  assert.equal(real.swapType, "EXACT_OUTPUT");
  assert.equal(real.originAsset, "nep141:sol.omft.near");
  assert.equal(real.destinationAsset, FERRY_ASSETS.btc.assetId);
  // NEAR Intents pays the person's own B node; refunds go to the address they gave
  assert.equal(real.recipient, "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
  assert.equal(real.refundTo, SOL);
  assert.equal(real.amount, String(buyNeed(410_000n, "btc")));
  assert.equal(d.swaps.length, 0);
  const dep = one.deposits.get(r.body.near.deposit_address);
  dep.status = "PROCESSING";
  await n.tick();
  assert.equal(n.job(r.body.id).state, "near");
  // delivered, but the wallet doesn't show it yet: wait, and hold the coins against other starts
  Object.assign(dep, { status: "SUCCESS", details: { amountOut: real.amount } });
  await n.tick();
  assert.equal(n.job(r.body.id).state, "funding");
  assert.deepEqual([...n.holds()], ["b"]);
  assert.equal(d.swaps.length, 0);
  d.statuses.b.balances.btc_sat = 500_000;
  await n.tick();
  const s = d.swaps[0];
  assert.equal(s?.key, "b");
  assert.equal(s.body.zec_zat, 100_000_000);
  assert.equal(s.body.maker, "http://maker.example/sandpiper");
  // never more than NEAR Intents delivered for this swap, less the lock's fee
  assert.equal(s.body.max_counter, Number(buyNeed(410_000n, "btc")) - 10_000);
  assert.equal(n.job(r.body.id).state, "ferry");
  s.outcome = "swapped";
  await n.tick();
  assert.equal(n.job(r.body.id).state, "done");
});

test("a buy refunded by NEAR Intents, and one nobody paid", async () => {
  const { n, one, d } = desk();
  const r = await n.start({ direction: "buy", zec_zat: 100_000_000, asset: "nep141:sol.omft.near", address: SOL, max_in: "100000000000" });
  one.deposits.get(r.body.near.deposit_address).status = "REFUNDED";
  await n.tick();
  assert.equal(n.job(r.body.id).state, "refunded");
  assert.equal(d.swaps.length, 0);
  const late = desk({ desk: { buyDeadlineSecs: -3600 } });
  const r2 = await late.n.start({ direction: "buy", zec_zat: 100_000_000, asset: "nep141:sol.omft.near", address: SOL, max_in: "100000000000" });
  await late.n.tick();
  assert.equal(late.n.job(r2.body.id).state, "expired");
  // the person agreed to send less than NEAR Intents now asks
  const cheap = desk();
  const r3 = await cheap.n.start({ direction: "buy", zec_zat: 100_000_000, asset: "nep141:sol.omft.near", address: SOL, max_in: "1000" });
  assert.equal(r3.status, 409);
});

test("HTTP: the routes and their guards", async () => {
  const { n } = desk({ execution: false });
  const sent = [];
  const send = (_res, code, body) => sent.push([code, body]);
  let limited = 0;
  const routes = nearRoutes(n, {
    send,
    readBody: async (req) => req.body,
    origin: (req) => (req.headers.origin === "https://evil.example" ? "This origin may not use the Ferry demo" : null),
    limit: () => (++limited > 2 ? 30 : null),
  });
  const req = (method, body = "{}", origin = null) => ({ method, body, headers: origin ? { origin } : {} });
  assert.equal(await routes(req("GET"), {}, "/api/pairs"), false);
  await routes(req("GET"), {}, "/api/near/tokens");
  assert.equal(sent.at(-1)[0], 200);
  await routes(req("POST", JSON.stringify({ direction: "sell", zec_zat: 1e8, asset: "nep141:sol.omft.near" })), {}, "/api/near/quote");
  assert.equal(sent.at(-1)[0], 200);
  await routes(req("POST", "{}", "https://evil.example"), {}, "/api/near/quote");
  assert.equal(sent.at(-1)[0], 403);
  await routes(req("POST", "not json"), {}, "/api/near/quote");
  assert.equal(sent.at(-1)[0], 400);
  await routes(req("POST", "{}"), {}, "/api/near/quote");
  await routes(req("POST", "{}"), {}, "/api/near/quote");
  assert.equal(sent.at(-1)[0], 429);
  await routes(req("POST", JSON.stringify({ direction: "sell", zec_zat: 1e8, asset: "nep141:sol.omft.near", address: SOL, min_out: "1" })), {}, "/api/near/swap");
  assert.equal(sent.at(-1)[0], 403);
  await routes(req("GET"), {}, "/api/near/status/n0123456789abcdef");
  assert.equal(sent.at(-1)[0], 404);
  await routes(req("GET"), {}, "/api/near/status/../../etc");
  assert.equal(sent.at(-1)[0], 404);
  await routes(req("GET"), {}, "/api/near/jobs");
  assert.deepEqual(sent.at(-1), [200, []]);
});

test("the best Ferry leg", () => {
  const list = [summary(0, "B", 400_000), summary(2, "B", 401_000, { available: false }), summary(1, "B", 401_000_000)];
  assert.equal(bestFerry(list, "btc", "sell", 1e8).maker.name, "Kestrel");
  assert.equal(bestFerry(list, "btc", "sell", 1e8).value, 398_000n);
  assert.equal(bestFerry(list, "btc", "buy", 1e8), null);
  assert.equal(bestFerry(list, "usdc-base", "sell", 1e8).fee, 0n);
  assert.equal(bestFerry(list, "btc", "sell", 5e9), null);
});

// ------------------------------------------------------------------------------------------------
// private swaps with NEAR Intents at an end: a router, and partners both ways for BTC and USDC

const RMAKERS = [
  { name: "Kestrel", url: "http://k.example", pair: "ZEC/BTC", chain: null },
  { name: "Egret", url: "http://e.example", pair: "ZEC/USDC", chain: "base" },
  { name: "Sandpiper", url: "http://s.example", pair: "ZEC/BTC", chain: null },
  { name: "Godwit", url: "http://g.example", pair: "ZEC/USDC", chain: "base" },
];
const rsum = (i, role, rate) => ({ index: i, name: RMAKERS[i].name, pair: RMAKERS[i].pair, chain: RMAKERS[i].chain, role, available: true, paused: false, online: true, rate_sat_per_zec: rate, min_zat: 1_000_000, max_zat: 1_000_000_000, fee_sat: RMAKERS[i].chain ? null : 2000, liquidity_zat: null });
// Kestrel and Egret buy ZEC (for BTC, for USDC), Sandpiper and Godwit sell it
const RLIST = [rsum(0, "B", 400_000), rsum(1, "B", 400_000_000), rsum(2, "Z", 410_000), rsum(3, "Z", 410_000_000)];
const rdirectory = () => ({
  makers: RMAKERS,
  list: async () => RLIST,
  resolve: (ref) => (typeof ref === "number" ? RMAKERS[ref] : RMAKERS.find((m) => m.name === ref)) ?? null,
  offerOf: () => ({ features: ["payout"] }),
});

function fakeRouter(legs = { from: ["btc", "usdc-base"], to: ["btc", "usdc-base"] }) {
  const routes = new Map();
  const posts = [];
  const view = (r) => ({
    id: r.id,
    from: r.body.from,
    to: r.body.to,
    state: r.state,
    outcome: r.outcome,
    note: r.note ?? "",
    amounts: { in_max: r.body.max_in, zec_zat: r.body.zec_zat, zec2_zat: r.body.zec_zat - 60_000, out_min: r.body.min_out, keep_zat: 0 },
    zec: { held_zat: r.state === "holding" ? r.body.zec_zat - 10_000 : 0 },
    legs: [
      { swap_id: "rs1", counter_units: 1, earlier_swaps: [] },
      { swap_id: r.out != null ? "rs2" : null, counter_units: r.out ?? null, earlier_swaps: [] },
    ],
    payout_to: r.body.payout_to ?? null,
  });
  return {
    routes,
    posts,
    legs: async () => legs,
    call: async (method, path, body) => {
      if (method === "POST" && path === "/api/routes") {
        posts.push(body);
        const r = { id: `r${posts.length}`, body, state: "leg1", outcome: null };
        routes.set(r.id, r);
        return { status: 201, body: view(r) };
      }
      const m = path.match(/^\/api\/routes\/(r\d+)$/);
      if (method === "GET" && m && routes.has(m[1])) return { status: 200, body: view(routes.get(m[1])) };
      return { status: 404, body: { error: "no such route" } };
    },
  };
}

function comboDesk(opts = {}) {
  const one = fakeOneClick();
  const d = fakeDaemons(opts);
  const router = opts.router === undefined ? fakeRouter() : opts.router;
  const n = nearDesk({ link: one.link, directory: rdirectory(), daemons: d.daemons, call: d.call, execution: opts.execution ?? true, pubkey: PUB, tickMs: 1e9, statusEveryMs: 0, log: () => {}, router, ...(opts.desk ?? {}) });
  return { n, one, d, router };
}
const realOf = (one) => one.calls.filter((c) => c.body?.dry === false).map((c) => c.body);
const USDT = "nep141:tron-usdt.omft.near";
const TRON = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";

test("a private swap's numbers, as the card works them out", () => {
  // 0.0041 BTC at Sandpiper's 410 000 sat/ZEC with 0.5% room: 0.995 ZEC; swap 2 sells 60 000 zat less
  const p = planRoute(RLIST, "btc", "usdc-base", 410_000);
  assert.equal(p.maker1.name, "Sandpiper");
  assert.equal(p.zat, 99_500_000);
  assert.equal(p.zat2, 99_440_000);
  assert.equal(p.maker2.name, "Egret");
  // 2% under Egret's 400 USDC
  assert.equal(p.minOut, (99_440_000n * 400_000_000n * 9_800n) / 10_000n / 100_000_000n);
  assert.equal(p.fee2, 0n);
  assert.match(planRoute(RLIST, "btc", "usdc-base", 1).error, /No partner is selling ZEC/);
  assert.match(planRoute(RLIST.filter((m) => m.name !== "Egret"), "btc", "usdc-base", 410_000).error, /No other partner is buying ZEC for USDC/);
});

test("info: what a private swap can hand to NEAR Intents and take from it", async () => {
  const { n } = comboDesk();
  const info = await n.info();
  assert.deepEqual(info.compose, { to: ["btc", "usdc-base"], from: ["btc"], runs: true });
  assert.deepEqual(info.vias, { sell: ["btc", "usdc-base"], buy: ["btc"] });
  assert.equal((await comboDesk({ router: null }).n.info()).compose, null);
  assert.equal((await comboDesk({ execution: false }).n.info()).compose.runs, false);
  // an older ferryd can't pay out into a deposit address
  assert.equal((await comboDesk({ features: ["route"] }).n.info()).compose.runs, false);
});

test("a hop: NEAR Intents' part of a private swap, priced alone", async () => {
  const { n, one } = comboDesk();
  let r = await n.hop({ side: "out", pair: "btc", asset: "nep141:sol.omft.near", amount: "193000" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // 0.00193 BTC at $100 000 is $193: 1.93 SOL
  assert.equal(r.body.amount_out, "1930000000");
  const asked = one.calls.at(-1).body;
  assert.equal(asked.swapType, "FLEX_INPUT");
  assert.equal(asked.originAsset, FERRY_ASSETS.btc.assetId);
  r = await n.hop({ side: "in", pair: "btc", asset: "nep141:sol.omft.near", amount: "5000000000", address: SOL, exact: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.amount_out, "500000");
  assert.equal(r.body.address, "ok");
  assert.equal(one.calls.at(-1).body.swapType, "EXACT_INPUT");
  assert.equal(one.calls.at(-1).body.refundTo, SOL);
  assert.equal((await n.hop({ side: "in", pair: "btc", asset: "nep141:sol.omft.near", amount: "1", address: "t1Ku2KLyndDPsR32jwnrTMd3yvi9tfFP8ML" })).body.field, "address");
  assert.equal((await n.hop({ side: "out", pair: "doge", asset: "nep141:sol.omft.near", amount: "1" })).status, 400);
  assert.equal((await n.hop({ side: "out", pair: "btc", asset: FERRY_ASSETS.btc.assetId, amount: "1" })).status, 400);
});

const routeNear = (more = {}) => ({
  kind: "route-near",
  route: { from: "usdc-base", to: "btc", zec_zat: 50_000_000, maker1: "Godwit", maker2: ["Kestrel"], max_in: 210_000_000, min_out: 195_000, pause: "off", payout_to: "bc1qattacker" },
  asset_out: "nep141:sol.omft.near",
  address: SOL,
  min_asset_out: "1900000000",
  payout_to: "bc1qattacker",
  ...more,
});

test("coin → NEAR asset: the route's second swap pays into a deposit address made here", async () => {
  const { n, one, router } = comboDesk();
  let gated = null;
  const r = await n.startCombo(routeNear(), { admit: async (w) => ((gated = w), null) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(gated, { key: "z", pair: "usdc-base", kind: "route" });
  assert.equal(r.body.state, "route");
  // NEAR Intents' quote: from BTC (the least swap 2 pays, less Kestrel's 2000 sat fee) to SOL at the
  // person's address; refunds go to their own BTC node
  const [real] = realOf(one);
  assert.equal(real.swapType, "FLEX_INPUT");
  assert.equal(real.originAsset, FERRY_ASSETS.btc.assetId);
  assert.equal(real.amount, "193000");
  assert.equal(real.recipient, SOL);
  assert.equal(real.refundTo, "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
  // the route: partners as allowlisted URLs, the pause, and the deposit address made here as its
  // payout, never the browser's
  const post = router.posts[0];
  assert.equal(post.maker1.url, "http://g.example");
  assert.equal(post.maker2[0].url, "http://k.example");
  assert.deepEqual(post.delay_secs, [0, 0]);
  assert.equal(post.payout_to, r.body.back.deposit_address);
  assert.notEqual(post.payout_to, "bc1qattacker");
  assert.equal("signed" in r.body.back, false);
  assert.equal(r.body.back.signature.startsWith("ed25519:"), true);
  // swap 2 done: NEAR Intents' part, then delivered
  router.routes.get("r1").state = "done";
  router.routes.get("r1").out = 199_760;
  await n.tick();
  assert.equal(n.combo(r.body.id).state, "near_out");
  assert.equal(n.combo(r.body.id).route.out, 199_760);
  Object.assign(one.deposits.get(r.body.back.deposit_address), { status: "SUCCESS", details: { amountOut: "1990000000" } });
  await n.tick();
  const done = n.combo(r.body.id);
  assert.equal(done.state, "done");
  assert.equal(done.back.details.amount_out, "1990000000");
  assert.equal(n.combos().length, 1);
  assert.equal(n.jobs().length, 0);
});

test("coin → NEAR asset, refused before anything moves", async () => {
  // a public demo: quotes only
  const demo = comboDesk({ execution: false });
  assert.equal((await demo.n.startCombo(routeNear())).status, 403);
  // no router
  assert.equal((await comboDesk({ router: null }).n.startCombo(routeNear())).status, 503);
  const { n, one, router } = comboDesk();
  // the same asset at both ends
  let r = await n.startCombo(routeNear({ asset_out: FERRY_ASSETS["usdc-base"].assetId, address: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D" }));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /two different coins/);
  // a Zcash address
  r = await n.startCombo(routeNear({ address: "t1Ku2KLyndDPsR32jwnrTMd3yvi9tfFP8ML" }));
  assert.equal(r.body.field, "address");
  // a route the router can't run
  r = await n.startCombo(routeNear({ route: { ...routeNear().route, from: "ltc" } }));
  assert.equal(r.status, 400);
  // the price moved under what the person agreed to: no route
  let refunds = 0;
  r = await n.startCombo(routeNear({ min_asset_out: "1999000000" }), { refused: () => refunds++ });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "price_moved");
  assert.equal(refunds, 1);
  assert.equal(router.posts.length, 0);
  // the guard says no: nothing asked of 1Click
  const before = realOf(one).length;
  r = await n.startCombo(routeNear(), { admit: async () => ({ status: 409, body: { error: "busy" } }) });
  assert.equal(r.status, 409);
  assert.equal(realOf(one).length, before);
  // an older ferryd that can't pay out
  assert.equal((await comboDesk({ features: ["route"] }).n.startCombo(routeNear())).status, 501);
  // a test network
  assert.equal((await comboDesk({ mainnet: false }).n.startCombo(routeNear())).status, 409);
});

const nearRoute = (more = {}) => ({
  kind: "near-route",
  route: { from: "btc", to: "usdc-base", zec_zat: 118_800_000, min_out: 450_000_000, pause: "standard" },
  asset_in: "nep141:sol.omft.near",
  amount_in: "5000000000",
  refund_address: SOL,
  min_mid: "490000",
  ...more,
});

test("NEAR asset → coin: the deposit, NEAR Intents into the B node, then the route", async () => {
  const { n, one, d, router } = comboDesk();
  let gated = null;
  const r = await n.startCombo(nearRoute(), { admit: async (w) => ((gated = w), null) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(gated, { key: "b", pair: "btc", kind: "route-later" });
  assert.equal(r.body.state, "deposit");
  const [real] = realOf(one);
  assert.equal(real.swapType, "EXACT_INPUT");
  assert.equal(real.originAsset, "nep141:sol.omft.near");
  assert.equal(real.destinationAsset, FERRY_ASSETS.btc.assetId);
  assert.equal(real.amount, "5000000000");
  // NEAR Intents pays the person's own B node; refunds go to the address they gave
  assert.equal(real.recipient, "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
  assert.equal(real.refundTo, SOL);
  assert.equal(router.posts.length, 0);
  const dep = one.deposits.get(r.body.front.deposit_address);
  dep.status = "PROCESSING";
  await n.tick();
  assert.equal(n.combo(r.body.id).state, "near_in");
  // delivered, but the wallet doesn't show it yet: wait, and hold the coins against other starts
  Object.assign(dep, { status: "SUCCESS", details: { amountOut: "500000" } });
  await n.tick();
  assert.equal(n.combo(r.body.id).state, "funding");
  assert.deepEqual([...n.holds()], ["b"]);
  assert.equal(router.posts.length, 0);
  d.statuses.b.balances.btc_sat = 600_000;
  await n.tick();
  const post = router.posts[0];
  assert.ok(post, n.combo(r.body.id).problem);
  // never more than NEAR Intents delivered for this swap, less the lock's fee
  assert.equal(post.max_in, 490_000);
  assert.equal(post.from, "btc");
  assert.equal(post.to, "usdc-base");
  assert.equal(post.maker1.name, "Sandpiper");
  assert.equal(post.maker2[0].name, "Egret");
  assert.equal("payout_to" in post, false);
  const plan = planRoute(RLIST, "btc", "usdc-base", 490_000);
  assert.equal(post.zec_zat, plan.zat);
  // never under the person's own floor, scaled to the ZEC this buys now
  assert.ok(BigInt(post.min_out) >= (450_000_000n * BigInt(plan.zat2)) / BigInt(118_800_000 - 60_000));
  assert.deepEqual(post.delay_secs, [300, 1800]);
  assert.equal(n.combo(r.body.id).state, "route");
  // the route holds the ZEC, then finishes
  router.routes.get("r1").state = "holding";
  await n.tick();
  assert.equal(n.combo(r.body.id).state, "holding");
  router.routes.get("r1").state = "done";
  router.routes.get("r1").out = 470_000_000;
  await n.tick();
  assert.equal(n.combo(r.body.id).state, "done");
});

test("NEAR asset → NEAR asset: the second quote once the coin arrived, the route paying into it", async () => {
  const { n, one, d, router } = comboDesk();
  const r = await n.startCombo(nearRoute({ kind: "near-near", asset_out: USDT, address: TRON, min_asset_out: "440000000" }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  d.statuses.b.balances.btc_sat = 600_000;
  Object.assign(one.deposits.get(r.body.front.deposit_address), { status: "SUCCESS", details: { amountOut: "500000" } });
  await n.tick();
  const v = n.combo(r.body.id);
  assert.equal(v.state, "route", v.problem);
  const second = realOf(one)[1];
  assert.equal(second.originAsset, FERRY_ASSETS["usdc-base"].assetId);
  assert.equal(second.destinationAsset, USDT);
  assert.equal(second.recipient, TRON);
  // refunds of the USDC go to the person's own USDC node
  assert.equal(second.refundTo, "0x2527D02599Ba641c19FEa793cD0F167589a0f10D");
  assert.equal(second.amount, String(router.posts[0].min_out));
  assert.equal(router.posts[0].payout_to, v.back.deposit_address);
  router.routes.get("r1").state = "done";
  await n.tick();
  assert.equal(n.combo(r.body.id).state, "near_out");
  one.deposits.get(v.back.deposit_address).status = "REFUNDED";
  await n.tick();
  assert.equal(n.combo(r.body.id).state, "refunded");
  // NEAR Intents now offers less than the person agreed: hold the coin, and go on only when asked
  const late = comboDesk();
  const r2 = await late.n.startCombo(nearRoute({ kind: "near-near", asset_out: USDT, address: TRON, min_asset_out: "999000000" }));
  late.d.statuses.b.balances.btc_sat = 600_000;
  Object.assign(late.one.deposits.get(r2.body.front.deposit_address), { status: "SUCCESS", details: { amountOut: "500000" } });
  await late.n.tick();
  assert.equal(late.n.combo(r2.body.id).state, "holding");
  assert.match(late.n.combo(r2.body.id).problem, /less USDT than you agreed/);
  assert.equal(late.router.posts.length, 0);
  const again = await late.n.retryCombo(r2.body.id);
  assert.equal(again.status, 200);
  assert.equal(again.body.state, "route");
  assert.equal(late.router.posts.length, 1);
});

test("the opt-out: NEAR Intents alone, from the person's own wallet to their own address", async () => {
  const { n, one, router } = comboDesk();
  const BTC_ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
  const USDC = FERRY_ASSETS["usdc-base"].assetId;
  // priced alone: 0.005 BTC is $500, 500 USDC
  let q = await n.hop({ side: "direct", asset_in: FERRY_ASSETS.btc.assetId, asset_out: USDC, amount: "500000" });
  assert.equal(q.status, 200, JSON.stringify(q.body));
  assert.equal(q.body.amount_out, "500000000");
  assert.equal(one.calls.at(-1).body.swapType, "EXACT_INPUT");
  q = await n.hop({ side: "direct", asset_in: FERRY_ASSETS.btc.assetId, asset_out: USDC, amount: "500000", address: SOL });
  assert.equal(q.body.field, "address");
  const body = { kind: "near-only", asset_in: FERRY_ASSETS.btc.assetId, amount_in: "500000", refund_address: BTC_ADDR, asset_out: USDC, address: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D", min_asset_out: "490000000" };
  let gated = null;
  const r = await n.startCombo(body, { admit: async (w) => ((gated = w), null) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(gated.kind, "near-only");
  assert.equal(r.body.state, "deposit");
  assert.equal(r.body.from, "btc");
  assert.equal(r.body.to, "usdc-base");
  // the person's own addresses at both ends; no Ferry swap, no route, no node of the operator's
  const [real] = realOf(one);
  assert.equal(real.recipient, "0x2527D02599Ba641c19FEa793cD0F167589a0f10D");
  assert.equal(real.refundTo, BTC_ADDR);
  assert.equal(router.posts.length, 0);
  one.deposits.get(r.body.front.deposit_address).status = "SUCCESS";
  await n.tick();
  assert.equal(n.combo(r.body.id).state, "done");
  assert.equal(router.posts.length, 0);
  // refused: the same coin, a demo, a moved price
  assert.equal((await n.startCombo({ ...body, asset_out: FERRY_ASSETS.btc.assetId, address: BTC_ADDR })).status, 400);
  assert.equal((await comboDesk({ execution: false }).n.startCombo(body)).status, 403);
  assert.equal((await comboDesk({ mainnet: false }).n.startCombo(body)).status, 409);
  const moved = await n.startCombo({ ...body, min_asset_out: "999000000" });
  assert.equal(moved.body.code, "price_moved");
  // it needs no router
  assert.equal((await comboDesk({ router: null }).n.startCombo(body)).status, 201);
  assert.equal((await comboDesk({ router: null }).n.info()).execution.direct, true);
});

test("HTTP: the private swaps' routes", async () => {
  const { n } = comboDesk({ execution: false });
  const sent = [];
  const routes = nearRoutes(n, { send: (_res, code, body) => sent.push([code, body]), readBody: async (req) => req.body, limit: () => null });
  const req = (method, body = "{}") => ({ method, body, headers: {} });
  await routes(req("POST", JSON.stringify({ side: "out", pair: "btc", asset: "nep141:sol.omft.near", amount: "193000" })), {}, "/api/near/hop");
  assert.equal(sent.at(-1)[0], 200);
  await routes(req("POST", JSON.stringify(routeNear())), {}, "/api/near/combo");
  assert.equal(sent.at(-1)[0], 403);
  await routes(req("GET"), {}, "/api/near/combos");
  assert.deepEqual(sent.at(-1), [200, []]);
  await routes(req("GET"), {}, "/api/near/combo/c0123456789abcdef");
  assert.equal(sent.at(-1)[0], 404);
  await routes(req("POST"), {}, "/api/near/combos/c0123456789abcdef/retry");
  assert.equal(sent.at(-1)[0], 404);
});

test("on the person's own node, a buy's ZEC can go to their own shielded wallet (sweep_to)", async () => {
  const { n, one, d } = desk();
  const UA = "utest1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqgqqqqqqqqqqqqqqqqqqqqq";
  const buy = { direction: "buy", zec_zat: 100_000_000, asset: "nep141:sol.omft.near", address: SOL, max_in: "100000000000" };
  assert.equal((await n.start({ ...buy, sweep_to: "utest1 nope" })).body.field, "sweep_to");
  const r = await n.start({ ...buy, sweep_to: UA });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.sweep_to, UA);
  const real = one.calls.find((c) => c.body?.dry === false).body;
  Object.assign(one.deposits.get(r.body.near.deposit_address), { status: "SUCCESS", details: { amountOut: real.amount } });
  d.statuses.b.balances.btc_sat = 500_000;
  await n.tick();
  await n.tick();
  assert.equal(d.swaps[0]?.body.sweep_to, UA, "the Ferry buy sweeps to it");
});

test("on the person's own node, NEAR asset → coin can pay coin C to their own wallet (payout_to)", async () => {
  const { n, one, d, router } = comboDesk();
  const to = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
  assert.equal((await n.startCombo({ ...nearRoute(), payout_to: "0x90;F7" })).body.field, "payout_to");
  const r = await n.startCombo({ ...nearRoute(), payout_to: to });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.payout_to, to);
  Object.assign(one.deposits.get(r.body.front.deposit_address), { status: "SUCCESS", details: { amountOut: "500000" } });
  await n.tick();
  d.statuses.b.balances.btc_sat = 600_000;
  await n.tick();
  assert.equal(router.posts[0]?.payout_to, to);
});

test("HTTP: receive addresses reach the desk on the person's own node only", async () => {
  const seen = [];
  const fake = { start: async (b) => (seen.push(b), { status: 201, body: {} }), startCombo: async (b) => (seen.push(b), { status: 201, body: {} }) };
  const call = async (own, path, body) => {
    const routes = nearRoutes(fake, { send: () => {}, readBody: async () => JSON.stringify(body), own: () => own });
    await routes({ method: "POST", headers: {} }, {}, path);
  };
  await call(false, "/api/near/swap", { direction: "buy", sweep_to: "utest1abcdefgh" });
  await call(true, "/api/near/swap", { direction: "buy", sweep_to: "utest1abcdefgh" });
  await call(false, "/api/near/combo", { kind: "near-route", payout_to: "bc1qabcdefgh" });
  await call(true, "/api/near/combo", { kind: "near-route", payout_to: "bc1qabcdefgh" });
  assert.deepEqual(
    seen.map((b) => b.sweep_to ?? b.payout_to ?? null),
    [null, "utest1abcdefgh", null, "bc1qabcdefgh"],
  );
});
