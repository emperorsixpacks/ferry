import test from "node:test";
import assert from "node:assert/strict";
import { hostOf, isLoopback, originAllowed, ownProblem, receiveAddress, receiveFields, withdrawBody } from "./own.mjs";

const req = (headers) => ({ headers });

test("loopback names", () => {
  for (const n of ["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) assert.ok(isLoopback(n), n);
  for (const n of ["ferry.example", "10.0.0.1", "0.0.0.0", "127.0.0.1.evil.com", "localhost.evil.com", "", null]) assert.ok(!isLoopback(n), String(n));
  assert.deepEqual(hostOf("127.0.0.1:7865"), { name: "127.0.0.1", port: "7865" });
  assert.deepEqual(hostOf("[::1]:5180"), { name: "::1", port: "5180" });
  assert.equal(hostOf(""), null);
});

test("a public origin also matches its other loopback name, on the own node only", () => {
  const pub = "http://127.0.0.1:7865";
  assert.ok(originAllowed(undefined, pub));
  assert.ok(originAllowed(pub, pub));
  assert.ok(!originAllowed("http://localhost:7865", pub, false));
  assert.ok(originAllowed("http://localhost:7865", pub, true));
  assert.ok(!originAllowed("http://localhost:7866", pub, true), "another port");
  assert.ok(!originAllowed("https://localhost:7865", pub, true), "another scheme");
  assert.ok(!originAllowed("http://evil.example:7865", pub, true));
  assert.ok(!originAllowed("null", pub, true));
  assert.ok(originAllowed("http://anything", null), "no PUBLIC_ORIGIN: unchecked, as before");
});

test("only the own node's own page may move coins", () => {
  const ok = { host: "127.0.0.1:7865", origin: "http://127.0.0.1:7865", "sec-fetch-site": "same-origin" };
  assert.equal(ownProblem(req(ok), true), null);
  assert.equal(ownProblem(req({ host: "localhost:7865", origin: "http://localhost:7865" }), true), null);
  assert.equal(ownProblem(req({ host: "localhost:7865" }), true), null, "no Origin: not a browser's cross-site POST");
  assert.match(ownProblem(req(ok), false), /own Ferry node/);
  assert.match(ownProblem(req({ ...ok, host: "evil.example:7865", origin: "http://evil.example:7865" }), true), /127\.0\.0\.1/, "DNS rebinding");
  assert.ok(ownProblem(req({ ...ok, origin: "https://evil.example" }), true), "cross-site");
  assert.ok(ownProblem(req({ ...ok, origin: "null" }), true), "opaque origin");
  assert.ok(ownProblem(req({ ...ok, origin: "http://localhost:5173" }), true), "another local port");
  assert.ok(ownProblem(req({ ...ok, "sec-fetch-site": "cross-site" }), true));
  assert.ok(ownProblem(req({ ...ok, "sec-fetch-site": "same-site" }), true));
});

test("receive addresses and fields", () => {
  assert.equal(receiveAddress("  bcrt1qn7uqc8hytxc7mhtsdszr9f5yc6hgmqqlc0wsks "), "bcrt1qn7uqc8hytxc7mhtsdszr9f5yc6hgmqqlc0wsks");
  for (const bad of ["", "short", "bc1q xyz000000", "0x12;drop", 42, null, "a".repeat(601)]) assert.equal(receiveAddress(bad), null, String(bad));
  assert.deepEqual(receiveFields({ payout_to: "0x90F79bf6EB2c4f870365E785982E1f101E93b906" }, "sell"), { json: ',"payout_to":"0x90F79bf6EB2c4f870365E785982E1f101E93b906"' });
  assert.deepEqual(receiveFields({ payout_to: "0x90F79bf6EB2c4f870365E785982E1f101E93b906" }, "buy"), { json: "" }, "a buy has no payout_to");
  assert.deepEqual(receiveFields({ sweep_to: "utest1abcdefgh" }, "buy"), { json: ',"sweep_to":"utest1abcdefgh"' });
  assert.ok(receiveFields({ sweep_to: "u1 bad" }, "buy").error);
  assert.deepEqual(receiveFields({}, "sell"), { json: "" });
});

test("withdraw bodies are rebuilt", () => {
  assert.deepEqual(withdrawBody({ asset: "zec", amount: 50_000_000, to: "utest1abcdefgh", extra: 1 }), { body: { asset: "zec", amount: 50_000_000, to: "utest1abcdefgh" } });
  assert.deepEqual(withdrawBody({ asset: "btc", amount: "1500", to: "bcrt1qn7uqc8hytxc7mhtsdszr" }).body.amount, 1500);
  assert.deepEqual(withdrawBody({ asset: "eth", amount: "20000000000000000", to: "0x90F79bf6EB2c4f870365E785982E1f101E93b906" }).body.amount, "20000000000000000");
  assert.equal(withdrawBody({ asset: "token", amount: 5, to: "0x90F79bf6EB2c4f870365E785982E1f101E93b906" }).body.amount, "5");
  for (const b of [{ asset: "doge", amount: 1, to: "utest1abcdefgh" }, { asset: "zec", amount: 0, to: "utest1abcdefgh" }, { asset: "zec", amount: 1.5, to: "utest1abcdefgh" }, { asset: "zec", amount: 1, to: "u1 x" }, { asset: "token", amount: "-3", to: "0x90F79bf6EB2c4f870365E785982E1f101E93b906" }])
    assert.ok(withdrawBody(b).error, JSON.stringify(b));
  // a dry run only reaches a daemon that previews; anything else would send for real
  assert.equal(withdrawBody({ asset: "zec", amount: 1, to: "utest1abcdefgh", dry_run: true }).status, 501);
  assert.equal(withdrawBody({ asset: "zec", amount: 1, to: "utest1abcdefgh", dry_run: true }, { preview: true }).body.dry_run, true);
});
