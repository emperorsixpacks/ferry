// `node --test server/quotes.test.mjs` (in web/): the UI server's firm-quote checks (quotes.mjs),
// against a quote ferryd signed (the fixed vector in crates/ferryd/src/quote.rs,
// signing_text_is_stable).
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import test, { after } from "node:test";
import { bucketFor, marketOf, pairLabel, parseSignedQuote, quoteJson, quoteDesk, signingText, verifySignature } from "./quotes.mjs";
import { bodyOf, fakeDaemon, get, ports, prodServer, sleep } from "./testing.mjs";

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

// ------------------------------------------------------------------------------------------------
// one quote, one swap: a start claims its quote (claim()), and two at once never share one

// A maker key of our own, signing quotes as ferryd does (quote.rs); `answer` is its POST /peer/quote:
// a fresh quote for the bucket asked, at `rate`, from a maker of role `makerRole`.
function signer(makerRole = "B") {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const der = publicKey.export({ format: "der", type: "spki" });
  const pt = der.subarray(der.length - 65);
  const key = Buffer.concat([Buffer.from([pt[64] & 1 ? 3 : 2]), pt.subarray(1, 33)]).toString("hex");
  const answer = (body, rate) => {
    const b = bucketFor(body.bucket_zat);
    const t = Math.floor(Date.now() / 1000);
    const q = { v: 1, quote_id: randomBytes(16).toString("hex"), pair: "ZEC/BTC", market: "btc:regtest", maker_role: makerRole, taker_role: body.taker_role, rate_sat_per_zec: rate, min_zat: b.lower, max_zat: b.bucket, issued_at: t, expires_at: t + 45, maker_key: key };
    return JSON.stringify({ ...q, sig: sign("sha256", Buffer.from(signingText(q)), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("hex") });
  };
  const offer = { role: makerRole, coin: "btc", network: "regtest", making: true, paused: false, rate_sat_per_zec: 410000, min_zat: 1_000_000, max_zat: 1_000_000_000, liquidity: { zec_zat: 1_000_000_000 }, free_slots: 4, quote_key: key };
  return { key, answer, offer };
}

// a directory of one maker, `s`
const oneMaker = (s) => ({
  makers: [{ name: "Kestrel", url: "http://k", pair: "ZEC/BTC", chain: null }],
  list: async () => [{ index: 0, name: "Kestrel", pair: "ZEC/BTC", chain: null, available: true, role: s.offer.role }],
  offerOf: () => s.offer,
});
const idOf = (claimed) => JSON.parse(claimed.json).quote_id;

test("two starts in the same bucket at once each claim a quote of their own", async () => {
  const s = signer();
  let rate = 410_000;
  let asked = 0;
  const desk = quoteDesk(oneMaker(s), {
    fetcher: async (_url, body) => {
      asked++;
      return s.answer(body, rate);
    },
  });
  // 0.02 and 0.03 ZEC are one bucket (up to 0.1): both visitors are shown the same quote, asked once
  const [a, b] = await Promise.all([desk.request({ pair: "btc", direction: "sell", zec_zat: 2_000_000 }), desk.request({ pair: "btc", direction: "sell", zec_zat: 3_000_000 })]);
  const shown = a.body.quotes[0].quote_id;
  assert.equal(b.body.quotes[0].quote_id, shown);
  assert.equal(asked, 1);

  // both start at once, naming it: the first takes it, the second gets a fresh one from the same maker
  const [x, y] = await Promise.all([desk.claim(0, shown, 2_000_000), desk.claim(0, shown, 3_000_000)]);
  assert.ok(x && y, "both starts have a firm quote");
  assert.equal(idOf(x), shown);
  assert.notEqual(idOf(y), shown);
  for (const [c, zat] of [
    [x, 2_000_000],
    [y, 3_000_000],
  ]) {
    assert.ok(verifySignature(parseSignedQuote(c.json), s.key), "signed by the maker");
    assert.ok(zat >= c.min_zat && zat <= c.max_zat, "covering its amount");
  }
  // a third, still naming it: another fresh one; the one shown is never handed out again
  const z = await desk.claim(0, shown, 2_500_000);
  assert.ok(z && ![idOf(x), idOf(y)].includes(idOf(z)));
  assert.equal(desk.find(0, shown), null);
  // nor shown: the next visitor to ask for the bucket gets a fresh one
  const next = await desk.request({ pair: "btc", direction: "sell", zec_zat: 2_000_000 });
  assert.ok(![shown, idOf(y), idOf(z)].includes(next.body.quotes[0].quote_id));

  // the fresh one is no worse for the person than the price they were shown (selling ZEC: at least it)
  rate = 409_999;
  assert.equal(await desk.claim(0, shown, 2_000_000), null, "a worse price is refused: the page shows the new one first");
  rate = 410_500;
  assert.ok(await desk.claim(0, shown, 2_000_000), "a better one is fine");
  // ...and covers the amount
  assert.equal(await desk.claim(0, shown, 0), null);
  // a quote this server never handed out
  assert.equal(await desk.claim(0, "f".repeat(32), 2_000_000), null);
  assert.equal(await desk.claim(0, "not an id", 2_000_000), null);

  // a start that goes no further than this server (a rate limit) gives its quote back
  rate = 410_000;
  const again = (await desk.request({ pair: "btc", direction: "sell", zec_zat: 3_000_000 })).body.quotes[0].quote_id;
  const c = await desk.claim(0, again, 3_000_000);
  assert.equal(idOf(c), again);
  c.release();
  assert.equal(idOf(await desk.claim(0, again, 3_000_000)), again);
});

test("buying ZEC: a fresh quote may cost no more than the one shown", async () => {
  const s = signer("Z");
  let rate = 415_000;
  const desk = quoteDesk(oneMaker(s), { fetcher: async (_url, body) => s.answer(body, rate) });
  const shown = (await desk.request({ pair: "btc", direction: "buy", zec_zat: 5_000_000 })).body.quotes[0].quote_id;
  assert.equal(idOf(await desk.claim(0, shown, 5_000_000)), shown);
  rate = 415_001;
  assert.equal(await desk.claim(0, shown, 5_000_000), null, "costs more: refused");
  rate = 414_000;
  assert.ok(await desk.claim(0, shown, 5_000_000), "costs less: fine");
});

// prod.mjs itself, in front of a maker that signs a fresh quote each time it is asked and a daemon
// that takes every start: two visitors start at once in one bucket, naming the quote they were both
// shown, and the daemon gets two different quotes, each signed by the maker and covering its amount.
test("prod.mjs: two visitors who start at once in the same bucket both start, each with a quote of its own", async () => {
  const port = ports(10);
  const s = signer();
  const maker = await fakeDaemon(
    {
      "GET /peer/offer": (_, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(s.offer)),
      "POST /peer/quote": async (req, res) => res.writeHead(200, { "content-type": "application/json" }).end(s.answer(await bodyOf(req), 410_000)),
    },
    port,
  );
  const started = [];
  const daemon = await fakeDaemon(
    {
      "POST /api/swaps": async (req, res) => {
        started.push(await bodyOf(req));
        await sleep(100);
        res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id: started.length.toString(16).padStart(4, "0") }));
      },
    },
    port,
  );
  const ui = await prodServer({ FERRY_Z_URL: daemon.url, FERRY_B_URL: daemon.url, FERRY_MAKERS: `Kestrel|${maker.url}|ZEC/BTC` }, port);
  after(async () => (await ui.close(), daemon.close(), maker.close()));

  const ask = (zat) => get(ui.url + "/api/quotes", { method: "POST", body: JSON.stringify({ pair: "btc", direction: "sell", zec_zat: zat }) });
  const [a, b] = await Promise.all([ask(2_000_000), ask(3_000_000)]);
  const shown = a.json.quotes[0].quote_id;
  assert.equal(b.json.quotes[0].quote_id, shown, "both were shown the same quote");
  const start = (zat) => get(ui.url + "/daemon/z/api/swaps", { method: "POST", body: JSON.stringify({ maker: "Kestrel", zec_zat: zat, quote: shown }) });
  const [x, y] = await Promise.all([start(2_000_000), start(3_000_000)]);
  assert.equal(x.status, 201, x.text);
  assert.equal(y.status, 201, y.text);
  assert.equal(started.length, 2);
  const ids = started.map((s) => s.quote.quote_id);
  assert.ok(ids.includes(shown));
  assert.notEqual(ids[0], ids[1], "never the same quote twice");
  for (const st of started) {
    const q = parseSignedQuote(JSON.stringify(st.quote));
    assert.ok(verifySignature(q, s.key));
    assert.ok(BigInt(q.min_zat) <= BigInt(st.zec_zat) && BigInt(st.zec_zat) <= BigInt(q.max_zat));
    assert.equal(st.maker, maker.url, "the maker's allowlisted URL, as before");
  }
  // the guard is still in front: a quote the server never handed out, and the demo's cap
  const unknown = await get(ui.url + "/daemon/z/api/swaps", { method: "POST", body: JSON.stringify({ maker: "Kestrel", zec_zat: 2_000_000, quote: "f".repeat(32) }) });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.error, /firm price has expired/);
  assert.equal(started.length, 2);
});
