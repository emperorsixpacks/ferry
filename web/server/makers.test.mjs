// node --test server/makers.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { makerDirectory, parseMakers } from "./makers.mjs";

const offer = (more = {}) => ({ role: "B", coin: "btc", network: "regtest", making: true, paused: false, rate_sat_per_zec: 410_000, min_zat: 10_000_000, max_zat: 1_000_000_000, terms: { btc_fee: 2000 }, liquidity: { zec_zat: 240_000_000 }, ...more });

async function listOf(offers) {
  const makers = parseMakers(offers.map((_, i) => `M${i}|http://127.0.0.1:${7650 + i}|ZEC/BTC`).join(","));
  const byUrl = new Map(makers.map((m, i) => [m.url, offers[i]]));
  const dir = makerDirectory(makers, {
    fetcher: async (url) => {
      const o = byUrl.get(url);
      if (o instanceof Error) throw o;
      return o;
    },
  });
  return dir.list();
}

// A maker's free slots (ferryd --max-swaps less the swaps it runs) come through; at 0 it is busy and
// can't be picked, and one that doesn't say (an older ferryd) is taken at its word.
test("free slots and busy", async () => {
  const [free, full, old, paused, down, junk] = await listOf([offer({ free_slots: 3 }), offer({ free_slots: 0 }), offer(), offer({ free_slots: 0, paused: true, making: false }), new Error("timeout"), offer({ free_slots: -1 })]);
  assert.equal(free.free_slots, 3);
  assert.equal(free.available, true);
  assert.equal(free.busy, false);

  assert.equal(full.free_slots, 0);
  assert.equal(full.available, false, "a full partner can't take a swap");
  assert.equal(full.busy, true);
  assert.equal(full.online, true);

  assert.equal(old.free_slots, null);
  assert.equal(old.available, true);
  assert.equal(old.busy, false);

  // paused says more than full
  assert.equal(paused.busy, false);
  assert.equal(paused.available, false);

  assert.equal(down.online, false);
  assert.equal(down.busy, false);
  assert.equal(down.free_slots, null);

  // not a count: ignored
  assert.equal(junk.free_slots, null);
  assert.equal(junk.available, true);
});
