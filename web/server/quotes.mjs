// Firm quotes for the UI servers (server/prod.mjs and the Vite dev server). Plain Node, no
// dependencies. See docs/API.md ("Firm quotes") and crates/ferryd/src/quote.rs.
//
// POST /api/quotes {pair, direction, zec_zat}: the amount is rounded UP to a bucket here, and only
// the bucket leaves this server. Each allowlisted maker that swaps the pair, on the other side, is
// asked directly (POST <url>/peer/quote {pair, taker_role, bucket_zat}), in parallel, with a short
// timeout and no identifying headers: no cookie, user agent, address, swap id or browser IP. Each
// answer is checked: signed (ECDSA over secp256k1, with Node's crypto) by the key in that maker's
// offer, for its pair and market and our side, and covering the exact amount. The browser gets the
// good ones, best first, without URLs, keys or errors.
//
// Quotes are cached per maker, side and bucket while they have MIN_LEFT_MS to run, and refusals for
// a few seconds, so however many browsers ask, a maker hears from this server at most about once per
// bucket per 25 s. A swap start names a quote by maker and id; the signed quote is looked up here
// and forwarded to the daemon with the maker's allowlisted URL, then dropped (one quote, one swap).
//
// Everyone asking for the same bucket is shown the same quote, but a maker honours each quote once
// (ferryd's claim_quote), so a start claims it (claim()) the moment it is checked: two visitors who
// start at once in the same bucket never both forward it. The one who comes second gets a fresh
// quote from the same maker, for that start alone, if it covers the amount at a rate at least as
// good for them as the one they were shown; otherwise the start is refused as before ("That firm
// price has expired"), and the browser asks for a new price.
//
// The exact amount is never logged, stored or sent to a maker.
import { createPublicKey, verify } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { noWorse } from "./firm.mjs";

// 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100 ZEC (as ferryd's quote::BUCKETS_ZAT)
export const BUCKETS_ZAT = [10_000_000, 25_000_000, 50_000_000, 100_000_000, 250_000_000, 500_000_000, 1_000_000_000, 2_500_000_000, 5_000_000_000, 10_000_000_000];

// {lower, bucket}: the bucket `zat` rounds up into and the one below it (0 for the first); null for
// 0 and above the largest bucket (no firm quote there)
export function bucketFor(zat) {
  if (!Number.isSafeInteger(zat) || zat <= 0) return null;
  const i = BUCKETS_ZAT.findIndex((b) => zat <= b);
  return i < 0 ? null : { lower: i === 0 ? 0 : BUCKETS_ZAT[i - 1], bucket: BUCKETS_ZAT[i] };
}

// The UI's pair ids (server/pairs.mjs) as a maker summary names them.
export function pairLabel(id) {
  const m = typeof id === "string" ? id.match(/^(btc|ltc|usdc|weth)(?:-(base|ethereum|arbitrum|optimism))?$/) : null;
  if (!m || (m[1] === "btc" || m[1] === "ltc") !== !m[2]) return null;
  return { pair: `ZEC/${m[1].toUpperCase()}`, chain: m[2] ?? null };
}

// The exact market an offer swaps, as ferryd names it in a quote (quote.rs: Offer::market,
// EvmOffer::market).
export function marketOf(offer) {
  if (offer?.counter === "evm") return typeof offer.chain_id === "number" && typeof offer.token === "string" ? `evm:${offer.chain_id}:${offer.token.toLowerCase()}` : null;
  return typeof offer?.network === "string" ? `${offer.coin === "ltc" ? "ltc" : "btc"}:${offer.network}` : null;
}

const SAFE = /^[A-Za-z0-9/:._-]{1,100}$/;
const DIGITS = /^(0|[1-9][0-9]{0,19})$/;
const INTS = ["v", "rate_sat_per_zec", "min_zat", "max_zat", "issued_at", "expires_at"];
const STRS = ["quote_id", "pair", "market", "maker_role", "taker_role", "maker_key", "sig"];
// SPKI DER prefix of a compressed secp256k1 public key (id-ecPublicKey, secp256k1, 33-byte point)
const SPKI = Buffer.from("3036301006072a8648ce3d020106052b8104000a032200", "hex");

// A maker's answer, parsed with every integer kept as its exact digits (a WETH rate is above 2^53),
// and only the quote's own fields. null if it isn't one.
export function parseSignedQuote(text) {
  let raw;
  try {
    // the reviver's source text keeps integers exact (Node 22)
    raw = JSON.parse(text, (_k, v, ctx) => (typeof v === "number" ? (ctx?.source ?? String(v)) : v));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const q = {};
  for (const k of INTS) {
    if (typeof raw[k] !== "string" || !DIGITS.test(raw[k]) || BigInt(raw[k]) > 18446744073709551615n) return null;
    q[k] = raw[k];
  }
  for (const k of STRS) {
    if (typeof raw[k] !== "string") return null;
    q[k] = raw[k];
  }
  const wellFormed =
    q.v === "1" &&
    /^[0-9a-f]{32}$/.test(q.quote_id) &&
    SAFE.test(q.pair) &&
    SAFE.test(q.market) &&
    ["Z", "B"].includes(q.maker_role) &&
    ["Z", "B"].includes(q.taker_role) &&
    q.maker_role !== q.taker_role &&
    /^0[23][0-9a-fA-F]{64}$/.test(q.maker_key) &&
    /^[0-9a-fA-F]{128}$/.test(q.sig) &&
    BigInt(q.min_zat) <= BigInt(q.max_zat) &&
    BigInt(q.issued_at) <= BigInt(q.expires_at);
  return wellFormed ? q : null;
}

// What the maker signed (quote.rs: Quote::signing_text).
export function signingText(q) {
  return [
    "ferry-quote/1",
    `v=${q.v}`,
    `quote_id=${q.quote_id}`,
    `pair=${q.pair}`,
    `market=${q.market}`,
    `maker_role=${q.maker_role}`,
    `taker_role=${q.taker_role}`,
    `rate_sat_per_zec=${q.rate_sat_per_zec}`,
    `min_zat=${q.min_zat}`,
    `max_zat=${q.max_zat}`,
    `issued_at=${q.issued_at}`,
    `expires_at=${q.expires_at}`,
  ].join("\n");
}

// `q` (from parseSignedQuote) is signed by `keyHex`, the quote_key of the maker's offer.
export function verifySignature(q, keyHex) {
  if (typeof keyHex !== "string" || q.maker_key.toLowerCase() !== keyHex.toLowerCase()) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(keyHex, "hex")]), format: "der", type: "spki" });
    return verify("sha256", Buffer.from(signingText(q), "utf8"), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(q.sig, "hex"));
  } catch {
    return false;
  }
}

// The signed quote as ferryd reads it (POST /api/swaps `quote`), integers exact.
export function quoteJson(q) {
  return `{${[...STRS.map((k) => `${JSON.stringify(k)}:${JSON.stringify(q[k])}`), ...INTS.map((k) => `${JSON.stringify(k)}:${q[k]}`)].join(",")}}`;
}

// POST <maker>/peer/quote: no redirects, a timeout on the whole exchange, at most 8 KB back, and
// only the headers JSON needs. Resolves to the body text of a 200, or rejects.
function postQuote(makerUrl, body, timeoutMs) {
  const target = new URL(makerUrl + "/peer/quote");
  const lib = target.protocol === "https:" ? https : http;
  const data = JSON.stringify(body);
  return new Promise((ok, fail) => {
    const req = lib.request(
      target,
      { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "content-length": Buffer.byteLength(data) }, timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return fail(new Error(`HTTP ${res.statusCode}`));
        }
        let size = 0;
        const chunks = [];
        res.on("data", (c) => {
          size += c.length;
          if (size > 8 * 1024) req.destroy(new Error("too large"));
          else chunks.push(c);
        });
        res.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
        res.on("error", fail);
      },
    );
    const deadline = setTimeout(() => req.destroy(new Error("timeout")), timeoutMs);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", fail);
    req.on("close", () => clearTimeout(deadline));
    req.end(data);
  });
}

// a quote is shown, and reused for another browser, while it has this long to run
export const MIN_LEFT_MS = 20_000;
// and a swap is only started from one with this long left
export const MIN_START_MS = 5_000;
const REFUSED_MS = 10_000;

// One desk per server, over its maker directory (makers.mjs).
export function quoteDesk(directory, { timeoutMs = 2000, fetcher = postQuote, minLeftMs = MIN_LEFT_MS } = {}) {
  // `${index}|${takerRole}|${bucket}` -> { q, deadline, until, pending }
  const cache = new Map();
  // `${index}|${quote_id}` -> the cache entry holding it
  const byId = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [k, e] of cache) if (!e.pending && now > Math.max(e.deadline ?? 0, e.until ?? 0) + 60_000) cache.delete(k);
    for (const [k, e] of byId) if (now > e.deadline + 60_000) byId.delete(k);
  }, 30_000).unref();

  // a fresh quote from maker `i`, verified, or null
  async function fetchQuote(i, offer, takerRole, label, bucket) {
    const sent = Date.now();
    let text;
    try {
      text = await fetcher(directory.makers[i].url, { pair: label, taker_role: takerRole, bucket_zat: bucket }, timeoutMs);
    } catch {
      return null;
    }
    const q = parseSignedQuote(text);
    if (!q || !verifySignature(q, offer.quote_key)) return null;
    if (q.pair !== label || q.market !== marketOf(offer) || q.maker_role !== offer.role || q.taker_role !== takerRole) return null;
    if (BigInt(q.max_zat) > BigInt(bucket)) return null;
    // the maker's own lifetime, counted from when we asked: no clock of ours is compared with its
    const ttl = Number(BigInt(q.expires_at) - BigInt(q.issued_at)) * 1000;
    return { q, deadline: sent + Math.min(ttl, 300_000) };
  }

  async function quoteFrom(i, offer, takerRole, label, bucket) {
    const key = `${i}|${takerRole}|${bucket}`;
    const c = cache.get(key);
    const now = Date.now();
    if (c?.pending) return c.pending;
    if (c?.q && c.deadline - now >= minLeftMs) return c;
    if (c && !c.q && now < c.until) return null;
    const entry = { pending: null };
    entry.pending = fetchQuote(i, offer, takerRole, label, bucket).then((got) => {
      if (got) {
        Object.assign(entry, got, { pending: null, index: i });
        byId.set(`${i}|${got.q.quote_id}`, entry);
        return entry;
      }
      Object.assign(entry, { q: null, until: Date.now() + REFUSED_MS, pending: null });
      return null;
    });
    cache.set(key, entry);
    return entry.pending;
  }

  // one quote, one swap: taken, and out of the cache so it isn't shown or handed out again
  function take(found) {
    found.entry.taken = true;
    for (const [k, c] of cache) if (c === found.entry) cache.delete(k);
  }

  return {
    // { status, body }: the firm quotes for `zec_zat`, best first
    async request(body) {
      const ids = pairLabel(body?.pair);
      if (!ids) return { status: 400, body: { error: "pair must be one of btc, ltc, usdc-base, weth-base, ..." } };
      if (body?.direction !== "sell" && body?.direction !== "buy") return { status: 400, body: { error: 'direction must be "sell" or "buy" (ZEC)' } };
      const zat = Number(body?.zec_zat);
      if (!Number.isSafeInteger(zat) || zat <= 0) return { status: 400, body: { error: "zec_zat must be a positive whole number of zatoshi" } };
      const b = bucketFor(zat);
      if (!b) return { status: 200, body: { bucket_zat: null, quotes: [] } };
      const takerRole = body.direction === "sell" ? "Z" : "B";
      const makerRole = takerRole === "Z" ? "B" : "Z";
      const list = await directory.list();
      const asked = list.filter((m) => m.available && m.role === makerRole && m.pair === ids.pair && (ids.chain === null || m.chain === ids.chain));
      const got = await Promise.all(
        asked.map(async (m) => {
          const offer = directory.offerOf(m.index);
          if (!offer?.quote_key) return null;
          const e = await quoteFrom(m.index, offer, takerRole, ids.pair, b.bucket);
          return e?.q ? { m, e } : null;
        }),
      );
      const now = Date.now();
      const quotes = got
        .filter((x) => x && BigInt(x.e.q.min_zat) <= BigInt(zat) && BigInt(zat) <= BigInt(x.e.q.max_zat) && x.e.deadline - now >= MIN_START_MS && !x.e.taken)
        .sort((x, y) => {
          const a = BigInt(x.e.q.rate_sat_per_zec);
          const c = BigInt(y.e.q.rate_sat_per_zec);
          // Z (selling ZEC) wants the most per ZEC, B (buying) pays the least
          if (a !== c) return (takerRole === "Z" ? a > c : a < c) ? -1 : 1;
          return y.e.deadline - x.e.deadline;
        })
        .map(({ m, e }) => ({
          maker: m.name,
          index: m.index,
          quote_id: e.q.quote_id,
          rate_sat_per_zec: Number(e.q.rate_sat_per_zec),
          min_zat: Number(e.q.min_zat),
          max_zat: Number(e.q.max_zat),
          expires_in_ms: Math.max(0, e.deadline - now),
        }));
      return { status: 200, body: { bucket_zat: b.bucket, quotes } };
    },

    // A swap start names a quote by maker index and id: the signed quote as JSON for ferryd, and
    // its range. null if this server doesn't hold it, it's taken, or it has too little time left.
    find(makerIndex, quoteId) {
      if (typeof quoteId !== "string" || !/^[0-9a-f]{32}$/.test(quoteId)) return null;
      const e = byId.get(`${makerIndex}|${quoteId}`);
      if (!e?.q || e.taken || e.deadline - Date.now() < MIN_START_MS) return null;
      return { json: quoteJson(e.q), min_zat: Number(e.q.min_zat), max_zat: Number(e.q.max_zat), entry: e };
    },
    // ...and once the start goes ahead: one quote, one swap, so it isn't shown or handed out again
    take,

    // A swap start of `zat` naming a quote by maker index and id: a signed quote for this start
    // alone, taken at once (before anything is awaited), so no other start can forward it too. The
    // one named if it's free and has MIN_START_MS left; if another start took it (or it is about to
    // run out), a fresh one asked of the same maker for the same side and the amount's bucket, if it
    // covers `zat` at a rate no worse for the taker than the named one's (the price the person was
    // shown). null: neither, or a quote this server never handed out. `release()` gives it back
    // when the start goes no further than this server (a rate limit, a conflict); once a daemon
    // has had it, it stays taken.
    async claim(makerIndex, quoteId, zat) {
      if (typeof quoteId !== "string" || !/^[0-9a-f]{32}$/.test(quoteId)) return null;
      const named = byId.get(`${makerIndex}|${quoteId}`);
      if (!named?.q) return null;
      const hold = (e) => {
        take({ entry: e });
        return { json: quoteJson(e.q), min_zat: Number(e.q.min_zat), max_zat: Number(e.q.max_zat), rate_sat_per_zec: Number(e.q.rate_sat_per_zec), entry: e, release: () => (e.taken = false) };
      };
      if (!named.taken && named.deadline - Date.now() >= MIN_START_MS) return hold(named);
      const b = bucketFor(Number(zat));
      const offer = directory.offerOf(makerIndex);
      if (!b || !offer?.quote_key) return null;
      const takerRole = named.q.taker_role;
      const got = await fetchQuote(makerIndex, offer, takerRole, named.q.pair, b.bucket);
      if (!got || got.deadline - Date.now() < MIN_START_MS) return null;
      if (BigInt(zat) < BigInt(got.q.min_zat) || BigInt(zat) > BigInt(got.q.max_zat)) return null;
      // Z (selling ZEC) gets at least the rate shown, B (buying) pays at most it (firm.mjs)
      if (!noWorse(got.q.rate_sat_per_zec, named.q.rate_sat_per_zec, takerRole)) return null;
      const e = { ...got, index: makerIndex };
      byId.set(`${makerIndex}|${got.q.quote_id}`, e);
      return hold(e);
    },
  };
}

// A per-key sliding-window rate limit: `take(key)` is 0 when allowed (and counted), else the
// seconds to wait.
export function rateLimit(perWindow, windowMs = 60_000) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, ts] of hits) if (!ts.some((t) => now - t < windowMs)) hits.delete(k);
  }, windowMs).unref();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= perWindow) {
      hits.set(key, recent);
      return Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
    }
    recent.push(now);
    hits.set(key, recent);
    return 0;
  };
}
