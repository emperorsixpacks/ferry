// `node --test server/quotes.test.mjs` (in web/): the UI server's firm-quote checks (quotes.mjs),
// against a quote ferryd signed (the fixed vector in crates/ferryd/src/quote.rs,
// signing_text_is_stable).
import assert from "node:assert/strict";
import test from "node:test";
import { bucketFor, marketOf, pairLabel, parseSignedQuote, quoteJson, quoteDesk, signingText, verifySignature } from "./quotes.mjs";

const KEY = "02989c0b76cb563971fdc9bef31ec06c3560f3249d6ee9e5d83c57625596e05f6f";
const VECTOR = {
  v: 1,
  quote_id: "0123456789abcdef0123456789abcdef",
  pair: "ZEC/BTC",
  market: "btc:regtest",
  maker_role: "B",
  taker_role: "Z",
  rate_sat_per_zec: 410000,
  min_zat: 50000000,
  max_zat: 100000000,
  issued_at: 1792400000,
  expires_at: 1792400045,
  maker_key: KEY,
  sig: "349f4c95e5687e036604e2d771c6b466578b026e62f28c5bfbff06427ccf017e22ff9af410bc3b2163ffa9f991a613ab83a2f643bc401426ff884b83aee60d3f",
};

test("buckets round up", () => {
  assert.deepEqual(bucketFor(1), { lower: 0, bucket: 10_000_000 });
  assert.deepEqual(bucketFor(70_000_000), { lower: 50_000_000, bucket: 100_000_000 });
  assert.deepEqual(bucketFor(100_000_000), { lower: 50_000_000, bucket: 100_000_000 });
  assert.equal(bucketFor(10_000_000_001), null);
  assert.equal(bucketFor(0), null);
  assert.equal(bucketFor(1.5), null);
});

test("pairs and markets", () => {
  assert.deepEqual(pairLabel("btc"), { pair: "ZEC/BTC", chain: null });
  assert.deepEqual(pairLabel("usdc-base"), { pair: "ZEC/USDC", chain: "base" });
  assert.equal(pairLabel("usdc"), null);
  assert.equal(pairLabel("btc-base"), null);
  assert.equal(marketOf({ network: "regtest" }), "btc:regtest");
  assert.equal(marketOf({ coin: "ltc", network: "regtest" }), "ltc:regtest");
  assert.equal(marketOf({ counter: "evm", chain_id: 8453, token: "0xABcd" }), "evm:8453:0xabcd");
});

test("a quote ferryd signed verifies, and any change breaks it", () => {
  const q = parseSignedQuote(JSON.stringify(VECTOR));
  assert.ok(q);
  assert.match(signingText(q), /^ferry-quote\/1\nv=1\nquote_id=0123/);
  assert.ok(verifySignature(q, KEY));
  assert.ok(verifySignature(q, KEY.toUpperCase()));
  for (const [k, v] of Object.entries({ rate_sat_per_zec: "410001", max_zat: "100000001", expires_at: "1792400046", taker_role: "B", market: "btc:main" })) {
    assert.ok(!verifySignature({ ...q, [k]: v }, KEY), k);
  }
  // another maker's key
  assert.ok(!verifySignature(q, "03" + KEY.slice(2)));
  // malformed answers are not quotes
  assert.equal(parseSignedQuote("{"), null);
  assert.equal(parseSignedQuote(JSON.stringify({ ...VECTOR, pair: "ZEC/BTC\nmarket=x" })), null);
  assert.equal(parseSignedQuote(JSON.stringify({ ...VECTOR, rate_sat_per_zec: -1 })), null);
  assert.equal(parseSignedQuote(JSON.stringify({ ...VECTOR, rate_sat_per_zec: 1.5 })), null);
  assert.equal(parseSignedQuote(JSON.stringify({ ...VECTOR, maker_role: "Z", taker_role: "Z" })), null);
});

test("integers above 2^53 stay exact (a WETH rate in wei)", () => {
  const text = JSON.stringify({ ...VECTOR, rate_sat_per_zec: 0 }).replace('"rate_sat_per_zec":0', '"rate_sat_per_zec":12000000000000001');
  const q = parseSignedQuote(text);
  assert.equal(q.rate_sat_per_zec, "12000000000000001");
  assert.match(quoteJson(q), /"rate_sat_per_zec":12000000000000001[,}]/);
  assert.match(signingText(q), /rate_sat_per_zec=12000000000000001\n/);
});

test("the desk asks with a bucket, keeps good quotes only, and hands each out once", async () => {
  const offer = { role: "B", network: "regtest", making: true, rate_sat_per_zec: 410000, min_zat: 1, max_zat: 1e9, quote_key: KEY };
  const makers = [{ name: "Kestrel", url: "http://k", pair: "ZEC/BTC", chain: null }];
  const dir = {
    makers,
    list: async () => [{ index: 0, name: "Kestrel", pair: "ZEC/BTC", chain: null, available: true, role: "B" }],
    offerOf: () => offer,
  };
  const asked = [];
  const fetcher = async (url, body) => {
    asked.push(body);
    return JSON.stringify({ ...VECTOR, issued_at: 1, expires_at: 46 });
  };
  // the vector's signature is over its own times: re-signed times don't verify, so nothing is shown
  let desk = quoteDesk(dir, { fetcher });
  let r = await desk.request({ pair: "btc", direction: "sell", zec_zat: 70_000_000 });
  assert.deepEqual(asked, [{ pair: "ZEC/BTC", taker_role: "Z", bucket_zat: 100_000_000 }]);
  assert.deepEqual(r.body.quotes, []);
  // the vector itself: its lifetime counts from when we asked
  desk = quoteDesk(dir, { fetcher: async () => JSON.stringify(VECTOR) });
  r = await desk.request({ pair: "btc", direction: "sell", zec_zat: 70_000_000 });
  assert.equal(r.status, 200);
  assert.equal(r.body.bucket_zat, 100_000_000);
  assert.equal(r.body.quotes.length, 1);
  assert.equal(r.body.quotes[0].maker, "Kestrel");
  assert.ok(r.body.quotes[0].expires_in_ms > 40_000);
  assert.ok(!("url" in r.body.quotes[0]));
  // the exact amount must be inside the quote
  r = await desk.request({ pair: "btc", direction: "sell", zec_zat: 40_000_000 });
  assert.deepEqual(r.body.quotes, []);
  // buying ZEC asks Z makers: none here
  r = await desk.request({ pair: "btc", direction: "buy", zec_zat: 70_000_000 });
  assert.deepEqual(r.body.quotes, []);
  const found = desk.find(0, VECTOR.quote_id);
  assert.ok(found);
  assert.deepEqual(JSON.parse(found.json), VECTOR);
  desk.take(found);
  assert.equal(desk.find(0, VECTOR.quote_id), null);
  assert.equal(desk.find(1, VECTOR.quote_id), null);
  // bad requests
  assert.equal((await desk.request({ pair: "btc", direction: "up", zec_zat: 1 })).status, 400);
  assert.equal((await desk.request({ pair: "btc", direction: "sell", zec_zat: -1 })).status, 400);
  assert.deepEqual((await desk.request({ pair: "btc", direction: "sell", zec_zat: 20e9 })).body, { bucket_zat: null, quotes: [] });
});
