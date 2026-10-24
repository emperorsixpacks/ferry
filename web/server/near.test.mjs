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
  assert.deepEqual(info.execution, { sell: false, buy: false });
  assert.equal(info.reason, "demo");
  assert.equal(info.tokens.some((t) => t.blockchain === "zec"), false);
  assert.equal(info.tokens.find((t) => t.symbol === "BTC").ferry, "btc");

  const test_ = desk({ mainnet: false });
  const t = await test_.n.start({ direction: "sell", zec_zat: 100_000_000, asset: "nep141:sol.omft.near", address: SOL, min_out: "1" });
  assert.equal(t.status, 409);
  assert.match(t.body.error, /mainnet/);
  assert.equal((await test_.n.info()).reason, "mainnet");
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
