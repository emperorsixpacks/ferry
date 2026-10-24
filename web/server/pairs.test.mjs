// `node --test server/pairs.test.mjs` (in web/): which daemons the UI servers front, per pair and
// direction, and what GET /api/pairs says about them (pairs.mjs).
import assert from "node:assert/strict";
import test from "node:test";
import { buyKey, extraDaemons, mainSide, pairDaemons, pairsBody, samePair } from "./pairs.mjs";

const env = {
  FERRY_LTC_URL: "http://ltc-z:7101/",
  FERRY_LTC_B_URL: "http://ltc-b:7102",
  FERRY_USDC_BASE_B_URL: "https://usdc-b.example",
  FERRY_USDC_BASE_B_TOKEN: "t",
};

test("a Z daemon per pair sells, a B daemon per pair buys", () => {
  const extra = extraDaemons(env);
  assert.deepEqual(
    extra.map((d) => [d.key, d.id, d.side, d.url, d.tokenName]),
    [
      ["ltc", "ltc", "sell", "http://ltc-z:7101", "LTC"],
      ["b-ltc", "ltc", "buy", "http://ltc-b:7102", "LTC_B"],
      ["b-usdc-base", "usdc-base", "buy", "https://usdc-b.example", "USDC_BASE_B"],
    ],
  );
  // the old list is unchanged: only the sell side
  assert.deepEqual(pairDaemons(env).map((p) => p.id), ["ltc"]);
});

test("GET /api/pairs: the old field, the buy side, and the main daemons", () => {
  const extra = extraDaemons(env);
  // unset: the page decides from each main daemon's status (a maker's is left out)
  assert.deepEqual(pairsBody(extra), { pairs: ["ltc"], buy: ["ltc", "usdc-base"], main: { sell: "auto", buy: "auto" } });
  assert.deepEqual(pairsBody([], { mainBuy: mainSide("0") }), { pairs: [], buy: [], main: { sell: "auto", buy: false } });
  // a local demo whose Z is the maker: only buying on the main pair
  assert.deepEqual(pairsBody([], { mainSell: mainSide("0"), mainBuy: mainSide("1") }).main, { sell: false, buy: true });
  assert.deepEqual([mainSide(undefined), mainSide(""), mainSide("1"), mainSide("0")], ["auto", "auto", true, false]);
});

test("buy-side keys can't be caught by another daemon's exact proxy pattern", () => {
  const keys = ["z", "b", "btc", "ltc", buyKey("btc"), buyKey("usdc-base")];
  for (const k of keys) {
    const re = new RegExp(`^/daemon/${k}(/|$)`);
    const caught = keys.filter((other) => re.test(`/daemon/${other}/api/status`));
    assert.deepEqual(caught, [k], `/daemon/${k} catches only itself`);
  }
});

test("one live swap per pair: a start checks both of the pair's daemons", () => {
  const extra = extraDaemons(env);
  assert.deepEqual(samePair("z", extra), ["z", "b"]);
  assert.deepEqual(samePair("b", extra), ["z", "b"]);
  assert.deepEqual(samePair("ltc", extra), ["ltc", "b-ltc"]);
  assert.deepEqual(samePair("b-ltc", extra), ["ltc", "b-ltc"]);
  assert.deepEqual(samePair("b-usdc-base", extra), ["b-usdc-base"]);
});

test("a bad URL stops the server at startup", () => {
  assert.throws(() => extraDaemons({ FERRY_BTC_B_URL: "not a url" }), /FERRY_BTC_B_URL/);
  assert.throws(() => extraDaemons({ FERRY_BTC_B_URL: "ftp://x" }), /only http/);
});
