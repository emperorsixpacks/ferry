// NEAR Intents (its 1Click Swap API) for the UI servers (server/prod.mjs and the Vite dev server).
// Plain Node, no dependencies.
//
// Ferry is the private hop; NEAR Intents is the reach. Ferry swaps shielded ZEC for a coin it
// supports (BTC, LTC, USDC or WETH on Base, Ethereum, Arbitrum or Optimism), and NEAR Intents
// carries that coin on to any of its assets, or the other way round:
//   sell  shielded ZEC → (a Ferry swap on the user's Z node) → coin C, paid straight into a 1Click
//         deposit address (ferryd's payout_to) → (NEAR Intents) → asset X, to the user's address.
//         If NEAR Intents can't fill it, it refunds C to the user's own Ferry node (refundTo).
//   buy   the user sends asset X to a 1Click deposit address → (NEAR Intents) → coin C into the
//         user's own Ferry node (B) → (a Ferry swap on that node, started here) → shielded ZEC.
// Ferry never sends ZEC to NEAR Intents (its ZEC deposit address is transparent), so the ZEC side
// stays shielded and trustless. The NEAR leg is public, and the user trusts NEAR Intents for it.
// NEAR Intents is mainnet only: on test networks a quote is informational, unless a mock 1Click on
// this machine (FERRY_NEAR_URL on loopback, FERRY_NEAR_TESTNET=1) stands in for it.
//
// Everything here talks to 1Click from the server: the browser never sees the API's URL or the
// operator's JWT, never names a URL, and its addresses are checked before they leave. Every quote
// 1Click returns is checked against its ed25519 signature (verify-quote-signature in its docs).
//
//   oneClick({url, jwt})     the API: tokens (cached 5 min), quote, status; timeouts, size caps
//   nearDesk({...})          quotes composed with a Ferry leg, swaps started from them, and the jobs
//                            that follow them to the end (kept in a JSON file)
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import http from "node:http";
import https from "node:https";
import { pairLabel } from "./quotes.mjs";

export const ONE_CLICK_URL = "https://1click.chaindefuser.com";
// 1Click's signing key, as its TypeScript SDK pins it (verifyQuoteSignature)
export const ONE_CLICK_PUBKEY = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";
export const EXPLORER_URL = "https://explorer.near-intents.org";

// The coins Ferry swaps, as 1Click names them on mainnet, and their decimals (Ferry's units are
// these base units). A coin missing from 1Click's token list, or listed with other decimals, is
// never used.
export const FERRY_ASSETS = {
  btc: { assetId: "nep141:btc.omft.near", decimals: 8 },
  ltc: { assetId: "nep141:ltc.omft.near", decimals: 8 },
  "usdc-base": { assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", decimals: 6 },
  "usdc-ethereum": { assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", decimals: 6 },
  "usdc-arbitrum": { assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", decimals: 6 },
  "usdc-optimism": { assetId: "nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ", decimals: 6 },
  "weth-base": { assetId: "nep141:base-0x4200000000000000000000000000000000000006.omft.near", decimals: 18 },
  "weth-ethereum": { assetId: "nep141:eth-0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2.omft.near", decimals: 18 },
  "weth-arbitrum": { assetId: "nep141:arb-0x82af49447d8a07e3bd95bd0d56f35241523fbab1.omft.near", decimals: 18 },
  "weth-optimism": { assetId: "nep245:v2_1.omni.hot.tg:10_vLAiSt9KfUGKpw5cD3vsSyNYBn5", decimals: 18 },
};
export const pairOfAsset = (assetId) => Object.keys(FERRY_ASSETS).find((p) => FERRY_ASSETS[p].assetId === assetId) ?? null;

// A dry quote needs a valid recipient and refund address before the user has typed one: an
// account inside NEAR Intents (an implicit account of zeros), which 1Click accepts for any asset.
// It leaves out the destination chain's withdrawal fee, so these quotes are marked approximate.
export const PLACEHOLDER = "0".repeat(64);

// what a Ferry leg takes, roughly, before NEAR Intents' part (mainnet block times)
const FERRY_SECS = { btc: 1800, ltc: 900, evm: 600 };
// what a Bitcoin or Litecoin lock's own fee needs on top of the amount (ferryd's B keeps as much)
export const LOCK_FEE_RESERVE = 10_000;
// a buy asks NEAR Intents for this much more coin than the ZEC costs now, so a rate that ticks up
// while NEAR Intents works doesn't leave the Ferry swap short; what's left stays in the user's node
export const BUY_BUFFER_BPS = 100;
const MAINNETS = new Set(["bitcoin", "main", "mainnet", "litecoin", "ethereum", "base", "arbitrum", "optimism"]);

// ------------------------------------------------------------------------------------------------
// HTTP: one JSON request, no redirects, a timeout on the whole exchange, a size cap

export function requestJson(target, { method = "GET", headers = {}, body, timeoutMs = 8000, maxBytes = 1 << 20 } = {}) {
  const lib = target.protocol === "https:" ? https : http;
  const data = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
  const h = { accept: "application/json", ...headers };
  if (data !== null) Object.assign(h, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  return new Promise((ok, fail) => {
    const req = lib.request(target, { method, headers: h, timeout: timeoutMs }, (res) => {
      let size = 0;
      const chunks = [];
      res.on("data", (c) => {
        size += c.length;
        if (size > maxBytes) req.destroy(new Error("too large"));
        else chunks.push(c);
      });
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        ok({ status: res.statusCode ?? 502, body: parsed });
      });
      res.on("error", fail);
    });
    const deadline = setTimeout(() => req.destroy(new Error("timeout")), timeoutMs);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", fail);
    req.on("close", () => clearTimeout(deadline));
    req.end(data ?? undefined);
  });
}

// ------------------------------------------------------------------------------------------------
// 1Click's signatures: ed25519 over base58(sha256(stable JSON of the request and quote fields))

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58(buf) {
  let n = BigInt("0x" + (Buffer.from(buf).toString("hex") || "0"));
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

export function unbase58(s) {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error("not base58");
    n = n * 58n + BigInt(i);
  }
  let hex = n === 0n ? "" : n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  let zeros = 0;
  for (const ch of s) {
    if (ch !== "1") break;
    zeros++;
  }
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, "hex")]);
}

// json-stable-stringify: keys sorted, undefined values left out
export function stableJson(v) {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => stableJson(x) ?? "null").join(",")}]`;
  const parts = [];
  for (const k of Object.keys(v).sort()) {
    const s = stableJson(v[k]);
    if (s !== undefined) parts.push(`${JSON.stringify(k)}:${s}`);
  }
  return `{${parts.join(",")}}`;
}

const orUndef = (v) => (v ? v : undefined);

// What 1Click signs for a quote response (its SDK's quoteHash): the request's own fields, the
// quote's amounts (and, for a real quote, its deposit address and terms), and the timestamp.
export function quoteMessage(r) {
  const q = r?.quoteRequest ?? {};
  const k = r?.quote ?? {};
  const request = {
    dry: q.dry,
    swapType: q.swapType,
    slippageTolerance: q.slippageTolerance,
    originAsset: q.originAsset,
    depositType: q.depositType,
    destinationAsset: q.destinationAsset,
    amount: q.amount,
    refundTo: q.refundTo,
    refundType: q.refundType,
    recipient: q.recipient,
    recipientType: q.recipientType,
    deadline: q.deadline,
    quoteWaitingTimeMs: orUndef(q.quoteWaitingTimeMs),
    referral: orUndef(q.referral),
    virtualChainRecipient: orUndef(q.virtualChainRecipient),
    virtualChainRefundRecipient: orUndef(q.virtualChainRefundRecipient),
    customRecipientMsg: orUndef(q.customRecipientMsg),
  };
  const amounts = {
    amountIn: k.amountIn,
    amountInFormatted: k.amountInFormatted,
    amountInUsd: k.amountInUsd,
    minAmountIn: k.minAmountIn,
    amountOut: k.amountOut,
    amountOutFormatted: k.amountOutFormatted,
    amountOutUsd: k.amountOutUsd,
    minAmountOut: k.minAmountOut,
  };
  const quote = q.dry
    ? amounts
    : {
        ...amounts,
        depositAddress: orUndef(k.depositAddress),
        depositMemo: orUndef(k.depositMemo),
        deadline: orUndef(k.deadline),
        timeWhenInactive: orUndef(k.timeWhenInactive),
        timeEstimate: orUndef(k.timeEstimate),
        refundFee: orUndef(k.refundFee),
        withdrawFee: orUndef(k.withdrawFee),
      };
  return base58(createHash("sha256").update(stableJson({ ...request, ...quote, timestamp: r?.timestamp }), "utf8").digest());
}

// SPKI DER prefix of a raw 32-byte ed25519 public key
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
export const ed25519Key = (pub) => createPublicKey({ key: Buffer.concat([ED25519_SPKI, unbase58(String(pub).replace(/^ed25519:/, ""))]), format: "der", type: "spki" });

export function verifyQuote(r, pubkey = ONE_CLICK_PUBKEY) {
  try {
    if (typeof r?.signature !== "string" || typeof r?.timestamp !== "string") return false;
    const sig = unbase58(r.signature.replace(/^ed25519:/, ""));
    if (sig.length !== 64) return false;
    return verify(null, Buffer.from(quoteMessage(r), "utf8"), ed25519Key(pubkey), sig);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------------------
// tokens

const ASSET_ID = /^[A-Za-z0-9:._-]{1,200}$/;
const SYMBOL = /^[A-Za-z0-9.$_+-]{1,20}$/;
const CHAIN = /^[a-z0-9_-]{1,20}$/;

// 1Click's /v0/tokens, keeping only well-formed entries and the fields the page uses.
export function cleanTokens(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const t of raw.slice(0, 2000)) {
    if (!t || typeof t !== "object") continue;
    const { assetId, symbol, blockchain, decimals, price } = t;
    if (typeof assetId !== "string" || !ASSET_ID.test(assetId) || seen.has(assetId)) continue;
    if (typeof symbol !== "string" || !SYMBOL.test(symbol)) continue;
    if (typeof blockchain !== "string" || !CHAIN.test(blockchain)) continue;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) continue;
    seen.add(assetId);
    out.push({
      assetId,
      symbol,
      blockchain,
      decimals,
      price: typeof price === "number" && Number.isFinite(price) && price >= 0 ? price : null,
      contractAddress: typeof t.contractAddress === "string" && t.contractAddress.length <= 200 ? t.contractAddress : null,
    });
  }
  return out;
}

// The tokens a person can pick: not native ZEC (its NEAR Intents address is transparent; Ferry
// delivers and takes shielded ZEC itself), each with the Ferry pair it is, if it is one.
export function pickable(tokens) {
  return tokens.filter((t) => t.blockchain !== "zec").map((t) => ({ ...t, ferry: pairOfAsset(t.assetId) }));
}

// ------------------------------------------------------------------------------------------------
// addresses: a first check of the format per chain family; 1Click's own check (a quote that names
// the address) has the last word.

const EVM = /^0x[0-9a-fA-F]{40}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const FORMATS = {
  btc: /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
  ltc: /^(ltc1[02-9ac-hj-np-z]{11,71}|[LM3][1-9A-HJ-NP-Za-km-z]{25,34})$/,
  doge: /^[DA9][1-9A-HJ-NP-Za-km-z]{25,34}$/,
  bch: /^((bitcoincash:)?[qp][02-9ac-hj-np-z]{41}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
  dash: /^[X7][1-9A-HJ-NP-Za-km-z]{25,34}$/,
  sol: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  fogo: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  xrp: /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/,
  stellar: /^G[A-Z2-7]{55}$/,
  near: /^([a-f0-9]{64}|0x[0-9a-fA-F]{40}|(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+)$/,
  ton: /^([EUk0][Qf][A-Za-z0-9_-]{46}|-?\d:[0-9a-fA-F]{64})$/,
  sui: /^0x[0-9a-fA-F]{64}$/,
  aptos: /^0x[0-9a-fA-F]{1,64}$/,
  movement: /^0x[0-9a-fA-F]{1,64}$/,
  starknet: /^0x[0-9a-fA-F]{1,64}$/,
  cardano: /^addr1[02-9ac-hj-np-z]{50,120}$/,
  aleo: /^aleo1[02-9ac-hj-np-z]{58}$/,
};
const EVM_CHAINS = new Set(["eth", "base", "arb", "op", "bsc", "pol", "avax", "gnosis", "bera", "monad", "xlayer", "scroll", "hood", "plasma", "abs", "adi", "hlevm", "hypercore"]);

// Why `address` can't be one on `blockchain`, or null. Never a Zcash address: Ferry delivers and
// takes shielded ZEC itself.
export function addressProblem(blockchain, address) {
  if (typeof address !== "string") return "Enter an address.";
  const a = address.trim();
  if (!a) return "Enter an address.";
  if (a.length > 128 || /\s/.test(a)) return "That doesn't look like an address.";
  if (/^(t1|t3|tm|u1|utest1|uregtest1|zs1|zc)[0-9A-Za-z]{20,}$/.test(a)) return "That's a Zcash address. Ferry handles your ZEC itself, shielded; enter an address on the other chain.";
  if (blockchain === "zec") return "Ferry never sends ZEC through NEAR Intents.";
  if (EVM_CHAINS.has(blockchain)) return EVM.test(a) ? null : "Enter an address that starts with 0x and has 40 hex characters.";
  const f = FORMATS[blockchain];
  if (f) return f.test(a) ? null : "That doesn't look like an address on this chain.";
  // a chain we don't know the format of: anything address-like, and 1Click decides
  return /^[A-Za-z0-9:._-]{8,128}$/.test(a) && (BASE58.test(a) || /[0-9]/.test(a)) ? null : "That doesn't look like an address.";
}

// a mock's own regtest/testnet addresses pass for its own chains
const testAddress = (blockchain, a) => (blockchain === "btc" && /^(bcrt1|tb1)[02-9ac-hj-np-z]{8,87}$/.test(a)) || (blockchain === "ltc" && /^(rltc1|tltc1)[02-9ac-hj-np-z]{8,87}$/.test(a));

// ------------------------------------------------------------------------------------------------
// amounts: base-unit integers as decimal strings, kept exact as BigInt

const INT = /^(0|[1-9][0-9]{0,39})$/;
export const big = (v) => (typeof v === "string" && INT.test(v) ? BigInt(v) : typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null);

// "0.0041035 BTC": base units as a decimal, trailing zeros dropped
export function unitsText(v, t) {
  const d = t.decimals;
  const s = BigInt(v).toString().padStart(d + 1, "0");
  const n = d ? `${s.slice(0, s.length - d)}.${s.slice(s.length - d)}`.replace(/\.?0+$/, "") : s;
  return `${n} ${t.symbol}`;
}

// Three significant digits, down (or up): a dry quote for 0.0123456 BTC asks about 0.0123, so one
// cached answer serves everyone near that amount, and the exact amount stays here until a swap.
export function roundSig(n, up = false, digits = 3) {
  if (n <= 0n) return n;
  const len = n.toString().length;
  if (len <= digits) return n;
  const step = 10n ** BigInt(len - digits);
  const down = (n / step) * step;
  return up && down < n ? down + step : down;
}

// `v` (an amount for `from`) as it would be for `to`, in proportion; BigInt
const scale = (v, to, from) => (from > 0n ? (v * to) / from : v);

// ------------------------------------------------------------------------------------------------
// the 1Click API

export function oneClick({ url = ONE_CLICK_URL, jwt = null, timeoutMs = 8000, tokensTtlMs = 300_000, request = requestJson } = {}) {
  const base = new URL(url);
  const headers = () => {
    const t = typeof jwt === "function" ? jwt() : jwt;
    return t ? { authorization: `Bearer ${t}` } : {};
  };
  let cache = { at: 0, ttl: 0, list: null, pending: null };
  return {
    url: base.href.replace(/\/+$/, ""),
    // loopback: a mock, never the real API
    local: ["localhost", "127.0.0.1", "[::1]", "::1"].includes(base.hostname),
    // the cleaned token list, cached; null while 1Click can't be reached
    async tokens() {
      if (Date.now() - cache.at < cache.ttl) return cache.list;
      if (cache.pending) return cache.pending;
      cache.pending = request(new URL("/v0/tokens", base), { headers: headers(), timeoutMs, maxBytes: 2 << 20 })
        .then(
          (r) => (r.status === 200 ? cleanTokens(r.body) : null),
          () => null,
        )
        .then((list) => {
          // a failure is asked again after 30 s, keeping the last good list meanwhile
          cache = { at: Date.now(), ttl: list ? tokensTtlMs : 30_000, list: list ?? cache.list, pending: null };
          return cache.list;
        });
      return cache.pending;
    },
    quote(body) {
      return request(new URL("/v0/quote", base), { method: "POST", headers: headers(), body, timeoutMs, maxBytes: 64 * 1024 });
    },
    status(depositAddress, depositMemo = null) {
      const u = new URL("/v0/status", base);
      u.searchParams.set("depositAddress", depositAddress);
      if (depositMemo) u.searchParams.set("depositMemo", depositMemo);
      return request(u, { headers: headers(), timeoutMs, maxBytes: 256 * 1024 });
    },
  };
}

// ------------------------------------------------------------------------------------------------
// the user's own Ferry nodes, as the UI server fronts them

const NETWORK_CHAIN = { base: "base", "base-sepolia": "base", ethereum: "ethereum", sepolia: "ethereum", arbitrum: "arbitrum", "arbitrum-sepolia": "arbitrum", optimism: "optimism", "op-sepolia": "optimism" };

// The pair a daemon's status describes ("btc", "usdc-base"); a local EVM chain (anvil) counts as Base.
export function pairOfStatus(s) {
  const raw = String(s?.chains?.btc?.ticker ?? s?.chains?.btc?.coin ?? "btc").toLowerCase();
  if (raw === "ltc") return "ltc";
  if (raw === "usdc" || raw === "weth") return `${raw}-${NETWORK_CHAIN[s?.chains?.btc?.network] ?? "base"}`;
  return "btc";
}

// Both chains of a daemon are main networks.
export const mainnet = (s) => MAINNETS.has(String(s?.chains?.btc?.network ?? "")) && ["main", "mainnet"].includes(String(s?.chains?.zec?.network ?? ""));

// The user's daemons that start swaps each way, with their status (cached). `sell`/`buy` list
// {key, pair?, auto?}, the main daemon first: it names no pair (its status says), and `auto` leaves
// it out when its status says it is a maker. A pair's own daemon wins over the main one.
export function ownDaemons({ sell = [], buy = [], call, ttlMs = 15_000 }) {
  const cache = new Map();
  async function statusOf(key) {
    const c = cache.get(key);
    if (c && Date.now() - c.at < c.ttl) return c.status;
    let status = null;
    try {
      const r = await call(key, "GET", "/api/status");
      status = r.status === 200 && r.body && typeof r.body === "object" ? r.body : null;
    } catch {
      status = null;
    }
    cache.set(key, { at: Date.now(), ttl: status ? ttlMs : 3000, status });
    return status;
  }
  return {
    statusOf,
    forget: (key) => cache.delete(key),
    async list(dir) {
      const got = await Promise.all(
        (dir === "sell" ? sell : buy).map(async (d) => {
          const status = await statusOf(d.key);
          if (!status) return null;
          if (d.auto && status.offer?.maker === true) return null;
          return { key: d.key, pair: d.pair ?? pairOfStatus(status), status };
        }),
      );
      // one daemon per pair: a pair's own daemon wins over the main one (listed last)
      const out = [];
      for (const d of got.filter(Boolean).reverse()) if (!out.some((x) => x.pair === d.pair)) out.push(d);
      return out.reverse();
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Ferry's leg, from the maker directory (makers.mjs summaries)

const isEvm = (pair) => pair.includes("-");
const coinKind = (pair) => (pair === "btc" ? "btc" : pair === "ltc" ? "ltc" : "evm");
export const ferrySecs = (pair) => FERRY_SECS[coinKind(pair)];

// The best maker for our side of `pair` at `zat`: selling ZEC (we are Z) pays the most net of its
// payout fee; buying (we are B) costs the least. null: nobody takes it now.
export function bestFerry(list, pair, dir, zat) {
  const want = pairLabel(pair);
  if (!want) return null;
  const makerRole = dir === "sell" ? "B" : "Z";
  let best = null;
  for (const m of list ?? []) {
    if (!m?.available || m.role !== makerRole || m.pair !== want.pair || (want.chain !== null && m.chain !== want.chain)) continue;
    if (!Number.isSafeInteger(m.rate_sat_per_zec) || m.rate_sat_per_zec <= 0) continue;
    const cap = Math.min(m.max_zat ?? 0, m.liquidity_zat ?? Infinity);
    if (zat < (m.min_zat ?? 0) || zat > cap) continue;
    const gross = (BigInt(zat) * BigInt(m.rate_sat_per_zec) + 50_000_000n) / 100_000_000n;
    const fee = isEvm(pair) ? 0n : BigInt(m.fee_sat ?? 0);
    const value = dir === "sell" ? gross - fee : gross;
    if (!best || (dir === "sell" ? value > best.value : value < best.value)) best = { maker: m, rate: m.rate_sat_per_zec, gross, fee, value };
  }
  return best;
}

// What a buy asks NEAR Intents to deliver for `gross`: a little more (BUY_BUFFER_BPS), and the
// lock's own fee on a UTXO coin.
export const buyNeed = (gross, pair) => (gross * (10_000n + BigInt(BUY_BUFFER_BPS)) + 9_999n) / 10_000n + (isEvm(pair) ? 0n : BigInt(LOCK_FEE_RESERVE));

// ------------------------------------------------------------------------------------------------
// 1Click's answers, for people

export function nearError(status, body) {
  const m = String(body?.message ?? body?.error ?? "").slice(0, 200);
  if (/recipient is not valid/i.test(m)) return { field: "address", error: "NEAR Intents says that isn't a valid address on this chain." };
  if (/refund.* is not valid/i.test(m)) return { field: "address", error: "NEAR Intents says that isn't a valid address for a refund on this chain." };
  if (/no liquidity|not enough liquidity/i.test(m)) return { error: "NEAR Intents has no route for this amount right now. Try another amount or token." };
  if (/too low|too small|minimum/i.test(m)) return { error: "That's below the smallest amount NEAR Intents takes for this token." };
  if (/too high|too large|maximum/i.test(m)) return { error: "That's above what NEAR Intents can fill for this token right now." };
  if (status === 401 || status === 403) return { error: "NEAR Intents refused this server's API key." };
  if (status === 429) return { error: "NEAR Intents is busy. Try again in a minute." };
  if (status >= 500 || !status) return { error: "Couldn't reach NEAR Intents. Try again in a moment." };
  return { error: m ? `NEAR Intents: ${m}` : "NEAR Intents couldn't quote this." };
}

// 1Click's status words → ours
export const NEAR_DONE = ["SUCCESS", "REFUNDED", "FAILED"];

// ------------------------------------------------------------------------------------------------
// the desk

const JOB_ID = /^n[0-9a-f]{16}$/;
const ISO = (t) => new Date(t).toISOString();
const isoSecs = (t) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
const digits = (v) => (typeof v === "string" && INT.test(v) ? v : null);

function txList(v) {
  if (!Array.isArray(v)) return [];
  return v
    .slice(0, 10)
    .map((t) => ({ hash: typeof t?.hash === "string" ? t.hash.slice(0, 200) : null, url: typeof t?.explorerUrl === "string" && /^https:\/\/[^\s"<>]{1,300}$/.test(t.explorerUrl) ? t.explorerUrl : null }))
    .filter((t) => t.hash);
}

export function nearDesk({
  link,
  directory,
  quotes = null,
  daemons,
  call,
  execution = false,
  testnet = false,
  state = null,
  slippageBps = 100,
  sellDeadlineSecs = 24 * 3600,
  buyDeadlineSecs = 3 * 3600,
  pubkey = ONE_CLICK_PUBKEY,
  verifySignatures = true,
  limits = {},
  quoteTtlMs = 30_000,
  tickMs = 4000,
  statusEveryMs = 5000,
  fundWaitMs = 30 * 60_000,
  admit = async () => null,
  log = (...a) => console.error("ferry-ui near:", ...a),
}) {
  const maxZat = limits.maxZat ?? Infinity;
  const minZat = limits.minZat ?? 0;
  // a test network may run swaps only against a mock 1Click on this machine
  const testOk = testnet && link.local;
  const canRun = (status) => execution && (mainnet(status) || testOk);
  const reason = () => (!execution ? "demo" : testOk ? null : "mainnet");

  // ---------------------------------------------------------------- tokens
  async function tokenList() {
    const list = await link.tokens();
    return list ? pickable(list) : null;
  }
  async function tokenOf(assetId) {
    const list = await tokenList();
    return list?.find((t) => t.assetId === assetId) ?? null;
  }
  // a Ferry pair's 1Click token, when 1Click lists it with Ferry's decimals
  async function viaToken(pair) {
    const t = await tokenOf(FERRY_ASSETS[pair]?.assetId);
    return t && t.decimals === FERRY_ASSETS[pair].decimals ? t : null;
  }

  // ---------------------------------------------------------------- dry quotes, cached
  const cache = new Map();
  async function dry(body) {
    const key = stableJson({ ...body, deadline: undefined });
    const c = cache.get(key);
    const now = Date.now();
    if (c && now - c.at < (c.ok ? quoteTtlMs : 10_000)) return c.pending ?? c.result;
    const entry = { at: now, ok: false, result: null, pending: null };
    entry.pending = link
      .quote({ ...body, dry: true, deadline: ISO(now + 3600_000) })
      .then(
        (r) => {
          if (r.status !== 200 && r.status !== 201) return { ok: false, ...nearError(r.status, r.body) };
          if (verifySignatures && !verifyQuote(r.body, pubkey)) return { ok: false, error: "NEAR Intents' answer didn't carry a valid signature, so it isn't shown." };
          return { ok: true, quote: r.body.quote, signed: r.body };
        },
        () => ({ ok: false, ...nearError(0, null) }),
      )
      .then((result) => {
        Object.assign(entry, { result, ok: result.ok, pending: null, at: Date.now() });
        return result;
      });
    cache.set(key, entry);
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return entry.pending;
  }

  // addresses the daemons fund themselves at (GET /api/addresses), cached a minute
  const addrCache = new Map();
  async function ownAddress(key) {
    const c = addrCache.get(key);
    if (c && Date.now() - c.at < 60_000) return c.address;
    let address = null;
    try {
      const r = await call(key, "GET", "/api/addresses");
      address = r.status === 200 && typeof r.body?.btc?.address === "string" ? r.body.btc.address : null;
    } catch {
      address = null;
    }
    if (address) addrCache.set(key, { at: Date.now(), address });
    return address;
  }

  // A sell's partner must pay its coin to an address of ours (its offer lists "payout"); where swaps
  // run, only those are quoted. On a demo the quote is informational, and every partner counts.
  const payoutOk = (m) => (directory.offerOf?.(m.index)?.features ?? []).includes("payout");

  // The routes Ferry can take for `dir`: the user's daemons whose pair NEAR Intents lists, best Ferry
  // leg first, with the maker that takes `zat` and the amount of coin C it comes to.
  async function vias(dir, zat, asset) {
    const [own, all] = await Promise.all([daemons.list(dir), directory.list()]);
    const list = dir === "sell" && execution ? all.filter(payoutOk) : all;
    const out = [];
    for (const d of own) {
      const t = await viaToken(d.pair);
      if (!t || t.assetId === asset.assetId) continue;
      const leg = bestFerry(list, d.pair, dir, zat);
      if (!leg) continue;
      const units = dir === "sell" ? leg.value : buyNeed(leg.gross, d.pair);
      // in dollars, to rank before asking NEAR Intents: most for a sell, least for a buy
      const usd = t.price != null ? (Number(units) / 10 ** t.decimals) * t.price : null;
      out.push({ ...d, token: t, leg, units, usd, run: canRun(d.status) });
    }
    out.sort((a, b) => (a.usd == null) - (b.usd == null) || (dir === "sell" ? (b.usd ?? 0) - (a.usd ?? 0) : (a.usd ?? 0) - (b.usd ?? 0)) || ferrySecs(a.pair) - ferrySecs(b.pair));
    return out;
  }

  function quoteBody(dir, v, asset, amount, { address = null, recipient = null } = {}) {
    if (dir === "sell")
      return {
        swapType: "FLEX_INPUT",
        slippageTolerance: slippageBps,
        originAsset: v.token.assetId,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: asset.assetId,
        amount: amount.toString(),
        refundTo: PLACEHOLDER,
        refundType: "INTENTS",
        recipient: address ?? PLACEHOLDER,
        recipientType: address ? "DESTINATION_CHAIN" : "INTENTS",
      };
    return {
      swapType: "EXACT_OUTPUT",
      slippageTolerance: slippageBps,
      originAsset: asset.assetId,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: v.token.assetId,
      amount: amount.toString(),
      refundTo: address ?? PLACEHOLDER,
      refundType: address ? "ORIGIN_CHAIN" : "INTENTS",
      recipient: recipient ?? PLACEHOLDER,
      recipientType: recipient ? "DESTINATION_CHAIN" : "INTENTS",
    };
  }

  // One route priced end to end: Ferry's leg, then a dry 1Click quote for what it comes to.
  async function price(dir, v, asset, exact, address) {
    const want = v.units;
    const ask = exact ? want : roundSig(want, dir === "buy");
    const recipient = dir === "buy" && exact && v.run ? await ownAddress(v.key) : null;
    const got = await dry(quoteBody(dir, v, asset, ask, { address: exact ? address : null, recipient }));
    if (!got.ok) return { v, error: got.error, field: got.field };
    const q = got.quote;
    const amountIn = big(q.amountIn);
    const amountOut = big(q.amountOut);
    const minOut = big(q.minAmountOut);
    if (amountIn == null || amountOut == null || minOut == null) return { v, error: "NEAR Intents' answer was incomplete." };
    // a rounded ask, scaled back to the exact amount
    const s = (x) => (ask === want ? x : scale(x, want, ask));
    const t = Number.isFinite(q.timeEstimate) ? Math.max(0, Math.round(q.timeEstimate)) : 60;
    return {
      v,
      near: {
        amount_in: dir === "sell" ? want.toString() : s(amountIn).toString(),
        amount_out: dir === "sell" ? s(amountOut).toString() : want.toString(),
        min_amount_out: dir === "sell" ? s(minOut).toString() : want.toString(),
        max_amount_in: dir === "buy" ? s(amountIn).toString() : null,
        time_s: t,
        withdraw_fee: digits(q.withdrawFee),
        approximate: ask !== want || (dir === "sell" ? !address : !recipient),
        verified: verifySignatures,
      },
    };
  }

  // ---------------------------------------------------------------- POST /api/near/quote
  // {direction: "sell"|"buy", zec_zat, asset, address?, exact?}: Ferry's leg × NEAR Intents' leg,
  // through the best coin Ferry swaps here. `exact` (the card): the exact amount, the two best
  // routes, and the address checked by 1Click; else (a picker row) a rounded amount, the best one.
  async function quote(body) {
    const bad = (error, field) => ({ status: 400, body: { error, ...(field ? { field } : {}) } });
    const dir = body?.direction;
    if (dir !== "sell" && dir !== "buy") return bad('direction must be "sell" or "buy" (ZEC)');
    const zat = body?.zec_zat;
    if (!Number.isSafeInteger(zat) || zat <= 0) return bad("zec_zat must be a positive whole number of zatoshi");
    if (zat > maxZat) return bad(`This server is limited to ${(maxZat / 1e8).toFixed(2)} ZEC per swap`);
    const asset = typeof body?.asset === "string" ? await tokenOf(body.asset) : null;
    if (!asset) return (await tokenList()) ? bad("NEAR Intents doesn't list that token") : { status: 503, body: { error: "Couldn't reach NEAR Intents. Try again in a moment." } };
    const exact = body?.exact === true;
    let address = null;
    if (body?.address != null && body.address !== "") {
      const p = addressProblem(asset.blockchain, body.address);
      if (p) return bad(p, "address");
      address = String(body.address).trim();
    }
    const routes = await vias(dir, zat, asset);
    if (!routes.length) return { status: 409, body: { error: dir === "sell" ? "No partner is buying ZEC for a coin NEAR Intents takes right now." : "No partner is selling ZEC for a coin NEAR Intents delivers right now." } };
    const priced = await Promise.all(routes.slice(0, exact ? 2 : 1).map((v) => price(dir, v, asset, exact, address)));
    const good = priced.filter((p) => p.near);
    if (!good.length) {
      const f = priced.find((p) => p.field) ?? priced[0];
      return { status: f.field ? 400 : 502, body: { error: f.error, ...(f.field ? { field: f.field } : {}) } };
    }
    const cmp = (x, y) => (x > y ? 1 : x < y ? -1 : 0);
    // a sell gets the most of the token, a buy sends the least; then the quicker route
    good.sort((a, b) => (dir === "sell" ? cmp(BigInt(b.near.amount_out), BigInt(a.near.amount_out)) : cmp(BigInt(a.near.amount_in), BigInt(b.near.amount_in))) || ferrySecs(a.v.pair) - ferrySecs(b.v.pair));
    const best = good[0];
    const v = best.v;
    return {
      status: 200,
      body: {
        direction: dir,
        zec_zat: zat,
        asset: asset.assetId,
        via: v.pair,
        maker: v.leg.maker.name,
        ferry: { rate_sat_per_zec: v.leg.rate, counter: v.leg.gross.toString(), fee: v.leg.fee.toString(), units: v.units.toString(), time_s: ferrySecs(v.pair) },
        near: best.near,
        time_s: ferrySecs(v.pair) + best.near.time_s,
        execution: v.run,
        reason: v.run ? null : reason(),
        address: address ? "ok" : null,
      },
    };
  }

  // ---------------------------------------------------------------- jobs
  let jobs = [];
  if (state && existsSync(state)) {
    try {
      const saved = JSON.parse(readFileSync(state, "utf8"));
      if (Array.isArray(saved?.jobs)) jobs = saved.jobs.filter((j) => j && JOB_ID.test(j.id));
    } catch (e) {
      log(`can't read ${state}: ${e.message}`);
    }
  }
  function save() {
    if (!state) return;
    try {
      mkdirSync(dirname(state), { recursive: true });
      const tmp = `${state}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, jobs }, null, 1), { mode: 0o600 });
      renameSync(tmp, state);
    } catch (e) {
      log(`can't write ${state}: ${e.message}`);
    }
  }
  const note = (j, kind, label) => {
    j.timeline.push({ at: isoSecs(Date.now()), kind, label });
    j.updated_at = Math.floor(Date.now() / 1000);
  };
  const active = (j) => !["done", "refunded", "failed", "expired"].includes(j.state);

  // A Ferry start on the user's own daemon `key`. `quote`: a firm quote (quotes.mjs find()), whose
  // signed JSON is forwarded exactly as the maker sent it.
  async function ferryStart(key, makerIndex, zat, extra, firm) {
    const url = directory.makers[makerIndex]?.url;
    if (!url) return { status: 400, body: { error: "Unknown partner" } };
    const fields = Object.entries(extra)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `,${JSON.stringify(k)}:${typeof v === "bigint" ? v.toString() : JSON.stringify(v)}`)
      .join("");
    const body = `{"maker":${JSON.stringify(url)},"zec_zat":${zat}${firm ? `,"quote":${firm.json}` : ""}${fields}}`;
    try {
      return await call(key, "POST", "/api/swaps", body);
    } catch {
      return { status: 502, body: { error: "Can't reach your Ferry node. Is it running?" } };
    }
  }

  // the best firm quote this server holds for a Ferry leg, from `name` if it gives one (and only from
  // partners that can pay out to an address of ours, for a sell)
  async function firmFor(pair, dir, zat, name) {
    if (!quotes) return null;
    try {
      const r = await quotes.request({ pair, direction: dir, zec_zat: zat });
      const list = (r.status === 200 ? (r.body.quotes ?? []) : []).filter((q) => dir !== "sell" || payoutOk(q));
      const q = list.find((x) => x.maker === name) ?? list[0];
      if (!q) return null;
      const found = quotes.find(q.index, q.quote_id);
      return found ? { ...found, index: q.index, maker: q.maker, rate: q.rate_sat_per_zec } : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- POST /api/near/swap
  // sell {direction: "sell", zec_zat, asset, address, min_out}: a real 1Click quote paying `asset`
  //   to `address`, then the Ferry swap paying its coin into the quote's deposit address. min_out:
  //   the least of `asset` the person agreed to; a quote that promises less is refused.
  // buy {direction: "buy", zec_zat, asset, address (refunds), max_in}: a real 1Click quote taking
  //   `asset` and delivering coin C into the user's own Ferry node; the Ferry buy follows once it
  //   has arrived. max_in: the most of `asset` the person agreed to send.
  // `admit()` is the server's own guard (idle daemons, rate limits), called just before anything
  // is asked of 1Click; `refused()` gives back what it took if the start then fails.
  async function start(body, { admit: gate = admit, refused = () => {} } = {}) {
    const bad = (error, field) => ({ status: 400, body: { error, ...(field ? { field } : {}) } });
    if (!execution) return { status: 403, body: { error: "NEAR Intents swaps run on your own Ferry node: they pay out to an address you choose, which this public demo can't allow." } };
    const dir = body?.direction;
    if (dir !== "sell" && dir !== "buy") return bad('direction must be "sell" or "buy" (ZEC)');
    const zat = body?.zec_zat;
    if (!Number.isSafeInteger(zat) || zat <= 0) return bad("zec_zat must be a positive whole number of zatoshi");
    if (zat > maxZat) return bad(`This server is limited to ${(maxZat / 1e8).toFixed(2)} ZEC per swap`);
    if (zat < minZat) return bad(`The smallest swap here is ${(minZat / 1e8).toFixed(2)} ZEC`);
    const asset = typeof body?.asset === "string" ? await tokenOf(body.asset) : null;
    if (!asset) return bad("NEAR Intents doesn't list that token");
    const problem = addressProblem(asset.blockchain, body?.address);
    if (problem) return bad(problem, "address");
    const address = String(body.address).trim();
    const limit = big(dir === "sell" ? body?.min_out : body?.max_in);
    if (limit == null || limit <= 0n) return bad(dir === "sell" ? "min_out must be a whole number of the token's smallest units" : "max_in must be a whole number of the token's smallest units");

    const routes = (await vias(dir, zat, asset)).filter((v) => v.run);
    if (!routes.length) return { status: 409, body: { error: execution && !testOk ? "NEAR Intents runs on mainnet: your Ferry node for this coin is on a test network." : "No partner takes this swap through NEAR Intents right now." } };
    // the route the person saw, if it's still there, else the best one
    const v = routes.find((r) => r.pair === body?.via) ?? routes[0];
    if (dir === "sell" && !(v.status.features ?? []).some((f) => f === "payout" || f === "payout_to"))
      return { status: 501, body: { error: "Your Ferry node can't pay out to NEAR Intents yet: it needs a ferryd with payout_to. Update it and try again." } };
    if (dir === "buy" && isEvm(v.pair) && v.status.balances?.eth_wei === "0") return { status: 409, body: { error: "Your Ferry node needs a little ETH to pay for gas before it can buy ZEC." } };

    const blocked = await gate({ key: v.key, pair: v.pair, kind: dir });
    if (blocked) return blocked;
    const fail = (r) => {
      refused();
      return r;
    };

    const own = await ownAddress(v.key);
    if (!own) return fail({ status: 502, body: { error: "Couldn't read your Ferry node's own address. Is it running?" } });
    if (addressProblem(v.token.blockchain, own) && !(testOk && testAddress(v.token.blockchain, own))) return fail({ status: 409, body: { error: "Your Ferry node's own address isn't one NEAR Intents can use (a test network?)." } });

    // sell: Ferry's leg at a firm price if a partner gives one, so the payout is exact
    let firm = null;
    let makerIndex = v.leg.maker.index;
    let gross = v.leg.gross;
    if (dir === "sell") {
      firm = await firmFor(v.pair, "sell", zat, v.leg.maker.name);
      if (firm) {
        makerIndex = firm.index;
        gross = (BigInt(zat) * BigInt(firm.rate) + 50_000_000n) / 100_000_000n;
      }
    }
    // what the payout loses on the way: a UTXO redeem's presigned fee, or an EVM claim's relayer tip
    // (at most the lock's max_tip; 0 with default daemons)
    const fee = v.leg.fee + (isEvm(v.pair) ? (big(directory.offerOf?.(makerIndex)?.terms?.max_tip) ?? 0n) : 0n);
    const units = dir === "sell" ? gross - fee : buyNeed(gross, v.pair);
    const now = Date.now();
    const req =
      dir === "sell"
        ? { ...quoteBody(dir, v, asset, units, { address }), refundTo: own, refundType: "ORIGIN_CHAIN", dry: false, deadline: ISO(now + sellDeadlineSecs * 1000) }
        : { ...quoteBody(dir, v, asset, units, { address, recipient: own }), dry: false, deadline: ISO(now + buyDeadlineSecs * 1000) };
    let r;
    try {
      r = await link.quote(req);
    } catch {
      return fail({ status: 502, body: nearError(0, null) });
    }
    if (r.status !== 200 && r.status !== 201) {
      const e = nearError(r.status, r.body);
      return fail({ status: e.field ? 400 : 502, body: e });
    }
    const signed = r.body;
    const q = signed?.quote ?? {};
    const echo = signed?.quoteRequest ?? {};
    if (verifySignatures && !verifyQuote(signed, pubkey)) return fail({ status: 502, body: { error: "NEAR Intents' quote didn't carry a valid signature. Nothing was started." } });
    const same = ["originAsset", "destinationAsset", "amount", "recipient", "refundTo", "swapType", "recipientType", "refundType", "depositType"].every((k) => echo[k] === req[k]) && echo.dry === false;
    const deposit = typeof q.depositAddress === "string" && /^[A-Za-z0-9:._-]{8,128}$/.test(q.depositAddress) ? q.depositAddress : null;
    const memo = typeof q.depositMemo === "string" && q.depositMemo ? q.depositMemo.slice(0, 100) : null;
    if (!same || !deposit) return fail({ status: 502, body: { error: "NEAR Intents' quote didn't match what was asked. Nothing was started." } });
    if (dir === "sell" && memo) return fail({ status: 502, body: { error: "NEAR Intents asked for a deposit memo, which a Ferry payout can't carry. Nothing was started." } });
    const minIn = big(q.minAmountIn) ?? units;
    const minOut = big(q.minAmountOut);
    const amountIn = big(q.amountIn);
    if (minOut == null || amountIn == null) return fail({ status: 502, body: { error: "NEAR Intents' quote was incomplete. Nothing was started." } });
    if (dir === "sell" && minOut < limit) return fail({ status: 409, body: { error: "The price moved: NEAR Intents now promises less than you agreed to. Check the new quote and try again.", code: "price_moved" } });
    if (dir === "buy" && amountIn > limit) return fail({ status: 409, body: { error: "The price moved: NEAR Intents now asks for more than you agreed to. Check the new quote and try again.", code: "price_moved" } });

    const j = {
      id: `n${randomBytes(8).toString("hex")}`,
      kind: dir,
      state: dir === "sell" ? "ferry" : "deposit",
      created_at: Math.floor(now / 1000),
      updated_at: Math.floor(now / 1000),
      zec_zat: zat,
      via: v.pair,
      daemon: v.key,
      maker: directory.makers[makerIndex]?.name ?? v.leg.maker.name,
      asset: { id: asset.assetId, symbol: asset.symbol, blockchain: asset.blockchain, decimals: asset.decimals },
      via_asset: { id: v.token.assetId, symbol: v.token.symbol, decimals: v.token.decimals },
      address,
      own_address: own,
      ferry: { swap_id: null, state: null, outcome: null, counter: units.toString(), earlier: [] },
      near: {
        deposit_address: deposit,
        deposit_memo: memo,
        amount_in: amountIn.toString(),
        min_amount_in: minIn.toString(),
        amount_out: digits(q.amountOut),
        min_amount_out: minOut.toString(),
        deadline: typeof q.deadline === "string" ? q.deadline : req.deadline,
        time_s: Number.isFinite(q.timeEstimate) ? q.timeEstimate : null,
        status: "PENDING_DEPOSIT",
        checked_at: 0,
        details: null,
        correlation_id: typeof signed.correlationId === "string" ? signed.correlationId.slice(0, 80) : null,
        verified: verifySignatures,
        signed,
      },
      note: "",
      problem: null,
      timeline: [],
    };
    const sell = dir === "sell";
    note(j, "near_quote", `NEAR Intents quoted ${sell ? `at least ${unitsText(minOut, asset)} for ${unitsText(units, v.token)}` : `${unitsText(units, v.token)} for ${unitsText(amountIn, asset)}`} (signed by 1Click; ${verifySignatures ? "signature checked" : "signature not checked"})`);

    if (dir === "sell") {
      // the Ferry payout never falls below what 1Click needs to start (its minAmountIn)
      const r2 = await ferryStart(v.key, makerIndex, zat, { payout_to: deposit, min_counter: minIn + fee }, firm);
      if (r2.status !== 201 || typeof r2.body?.id !== "string") return fail({ status: r2.status >= 400 ? r2.status : 502, body: { error: r2.body?.error ?? "Your Ferry node didn't start the swap." } });
      if (firm) quotes.take(firm);
      j.ferry.swap_id = r2.body.id;
      note(j, "ferry_started", `Ferry swap started with ${j.maker}: ${(zat / 1e8).toFixed(4)} ZEC for ${v.token.symbol}, paid to NEAR Intents' deposit address`);
    } else {
      note(j, "deposit_waiting", `Waiting for your ${asset.symbol} at NEAR Intents' deposit address`);
    }
    jobs.unshift(j);
    if (jobs.length > 200) jobs = jobs.filter((x, i) => i < 200 || active(x));
    save();
    return { status: 201, body: view(j) };
  }

  // ---------------------------------------------------------------- following a job
  async function nearStatus(j) {
    if (Date.now() - j.near.checked_at < (j.state === "deposit" ? statusEveryMs * 3 : statusEveryMs)) return;
    j.near.checked_at = Date.now();
    let r;
    try {
      r = await link.status(j.near.deposit_address, j.near.deposit_memo);
    } catch {
      return;
    }
    if (r.status !== 200 || typeof r.body?.status !== "string") return;
    const s = r.body.status;
    const d = r.body.swapDetails ?? {};
    // the status answer carries the quote it is for: it must be ours
    const theirs = r.body.quoteResponse?.quote?.depositAddress;
    if (theirs && theirs !== j.near.deposit_address) return;
    j.near.details = {
      amount_in: digits(d.amountIn),
      amount_out: digits(d.amountOut),
      deposited: digits(d.depositedAmount),
      refunded: digits(d.refundedAmount),
      refund_reason: typeof d.refundReason === "string" ? d.refundReason.slice(0, 80) : null,
      origin_txs: txList(d.originChainTxHashes),
      destination_txs: txList(d.destinationChainTxHashes),
      near_txs: Array.isArray(d.nearTxHashes) ? d.nearTxHashes.filter((h) => typeof h === "string").slice(0, 10).map((h) => h.slice(0, 100)) : [],
    };
    if (s !== j.near.status) {
      j.near.status = s;
      const words = {
        KNOWN_DEPOSIT_TX: "NEAR Intents sees the deposit transaction",
        PENDING_DEPOSIT: "NEAR Intents is waiting for the deposit",
        INCOMPLETE_DEPOSIT: "NEAR Intents got less than the quote needs",
        PROCESSING: "NEAR Intents is swapping",
        SUCCESS: `NEAR Intents delivered ${j.kind === "sell" ? j.asset.symbol : j.via_asset.symbol}`,
        REFUNDED: "NEAR Intents refunded the deposit",
        FAILED: "NEAR Intents reported a failure",
      };
      note(j, `near_${s.toLowerCase()}`, words[s] ?? `NEAR Intents: ${s}`);
    }
  }

  async function ferrySwap(j) {
    let r;
    try {
      r = await call(j.daemon, "GET", `/api/swaps/${j.ferry.swap_id}`);
    } catch {
      return null;
    }
    if (r.status !== 200 || !r.body) return null;
    j.ferry.state = typeof r.body.state === "string" ? r.body.state.slice(0, 60) : null;
    j.ferry.outcome = r.body.outcome ?? null;
    if (r.body.amounts?.btc_sat != null) j.ferry.counter_units = String(r.body.amounts.btc_sat);
    return r.body;
  }

  // a buy whose coin has arrived: start the Ferry swap on the user's B node
  async function buyNow(j) {
    const daemon = (await daemons.list("buy")).find((d) => d.key === j.daemon);
    daemons.forget(j.daemon);
    const status = daemon?.status ?? (await daemons.statusOf(j.daemon));
    if (!status) return;
    const balance = big(status.balances?.token_units) ?? big(status.balances?.btc_sat) ?? 0n;
    const reserve = isEvm(j.via) ? 0n : BigInt(LOCK_FEE_RESERVE);
    const list = await directory.list();
    const firm = await firmFor(j.via, "buy", j.zec_zat, j.maker);
    const leg = bestFerry(list, j.via, "buy", j.zec_zat);
    const rate = firm?.rate ?? leg?.rate;
    const makerIndex = firm?.index ?? leg?.maker.index;
    if (rate == null || makerIndex == null) return wait(j, "No partner is selling ZEC right now. Trying again.");
    // never more than NEAR Intents delivered for this job (the rest of the wallet is the user's)
    const got = big(j.near.details?.amount_out) ?? big(j.near.amount_out) ?? 0n;
    const budget = (got < balance ? got : balance) - reserve;
    const cost = (z) => (BigInt(z) * BigInt(rate) + 50_000_000n) / 100_000_000n;
    let zat = j.zec_zat;
    if (cost(zat) > budget) {
      // the price ticked up more than the buffer: buy what the coin covers, to 0.001 ZEC
      zat = Number(((budget > 0n ? budget : 0n) * 100_000_000n) / BigInt(rate) / 100_000n) * 100_000;
      const m = list.find((x) => x.index === makerIndex);
      if (zat <= 0 || zat < (m?.min_zat ?? 0)) return wait(j, balance < got ? "Waiting for your Ferry node's wallet to show the coins NEAR Intents delivered." : "What arrived doesn't cover the smallest swap now.");
    }
    const blocked = await admit({ key: j.daemon, pair: j.via, auto: true });
    if (blocked) return wait(j, blocked.body?.error ?? "Waiting for another swap to finish.");
    const r = await ferryStart(j.daemon, makerIndex, zat, { max_counter: budget > 0n ? budget : 0n }, firm && zat >= firm.min_zat && zat <= firm.max_zat ? firm : null);
    if (r.status !== 201 || typeof r.body?.id !== "string") return wait(j, r.body?.error ?? "Your Ferry node didn't start the swap. Trying again.");
    if (firm && zat >= firm.min_zat && zat <= firm.max_zat) quotes.take(firm);
    if (j.ferry.swap_id) j.ferry.earlier.push(j.ferry.swap_id);
    j.ferry = { ...j.ferry, swap_id: r.body.id, state: null, outcome: null, zec_zat: zat };
    j.state = "ferry";
    j.problem = null;
    note(j, "ferry_started", `Ferry swap started with ${directory.makers[makerIndex]?.name ?? "a partner"}: ${(zat / 1e8).toFixed(4)} ZEC for ${j.via_asset.symbol}`);
  }

  function wait(j, why) {
    if (j.problem !== why) {
      j.problem = why;
      j.updated_at = Math.floor(Date.now() / 1000);
    }
    j.funding_since ??= Date.now();
    if (Date.now() - j.funding_since > fundWaitMs) {
      j.state = "holding";
      note(j, "holding", `The Ferry swap couldn't start: ${why} Your ${j.via_asset.symbol} is in your Ferry node.`);
    }
  }

  async function step(j) {
    if (j.kind === "sell") {
      if (j.state === "ferry") {
        const s = await ferrySwap(j);
        if (!s?.outcome) return;
        if (s.outcome === "swapped") {
          j.state = "near";
          note(j, "ferry_swapped", `Ferry swap done: ${j.via_asset.symbol} paid to NEAR Intents' deposit address`);
        } else {
          j.state = "failed";
          j.outcome = s.outcome === "punished" ? "punished" : "ferry_refunded";
          note(j, "ferry_" + s.outcome, s.outcome === "punished" ? "The Ferry swap's deadline passed while your node was offline" : "The Ferry swap was called off: your ZEC is back in your shielded wallet. Nothing went to NEAR Intents");
        }
        return;
      }
      if (j.state === "near") {
        await nearStatus(j);
        if (j.near.status === "SUCCESS") {
          j.state = "done";
          j.outcome = "swapped";
        } else if (j.near.status === "REFUNDED" || j.near.status === "FAILED") {
          j.state = "refunded";
          j.outcome = "near_refunded";
          note(j, "refunded", `Your ${j.via_asset.symbol} goes back to your Ferry node's own address`);
        }
      }
      return;
    }
    // buy
    if (j.state === "deposit" || j.state === "near") {
      await nearStatus(j);
      const s = j.near.status;
      if (["KNOWN_DEPOSIT_TX", "PROCESSING", "INCOMPLETE_DEPOSIT"].includes(s)) j.state = "near";
      if (s === "SUCCESS") {
        j.state = "funding";
        j.funding_since = Date.now();
      } else if (s === "REFUNDED" || s === "FAILED") {
        j.state = "refunded";
        j.outcome = "near_refunded";
        note(j, "refunded", `Your ${j.asset.symbol} goes back to your refund address`);
      } else if (s === "PENDING_DEPOSIT" && Date.parse(j.near.deadline) + 600_000 < Date.now()) {
        j.state = "expired";
        j.outcome = "not_started";
        note(j, "expired", "No deposit arrived before the deadline. Nothing moved");
      }
    }
    if (j.state === "funding") return buyNow(j);
    if (j.state === "ferry") {
      const s = await ferrySwap(j);
      if (!s?.outcome) return;
      if (s.outcome === "swapped") {
        j.state = "done";
        j.outcome = "swapped";
        note(j, "ferry_swapped", "Ferry swap done: your ZEC is in your shielded wallet");
      } else {
        j.state = "holding";
        note(j, "ferry_" + s.outcome, s.outcome === "punished" ? "The Ferry swap's deadline passed while your node was offline" : `The Ferry swap was called off. Your ${j.via_asset.symbol} is back in your Ferry node`);
      }
    }
  }

  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      for (const j of jobs.filter(active)) {
        const before = JSON.stringify([j.state, j.near.status, j.ferry.state, j.ferry.outcome, j.problem, j.timeline.length, j.near.details]);
        try {
          await step(j);
        } catch (e) {
          log(`job ${j.id}: ${e?.message ?? e}`);
        }
        if (JSON.stringify([j.state, j.near.status, j.ferry.state, j.ferry.outcome, j.problem, j.timeline.length, j.near.details]) !== before) {
          j.updated_at = Math.floor(Date.now() / 1000);
          save();
        }
      }
    } finally {
      ticking = false;
    }
  }
  const timer = execution ? setInterval(tick, tickMs) : null;
  timer?.unref?.();

  // "Buy ZEC now": a buy holding its coin (the Ferry swap couldn't run) tries again
  async function retry(id) {
    const j = jobs.find((x) => x.id === id);
    if (!j) return { status: 404, body: { error: "No such NEAR Intents swap" } };
    if (j.kind !== "buy" || j.state !== "holding") return { status: 409, body: { error: "Nothing to retry" } };
    j.state = "funding";
    j.funding_since = Date.now();
    j.problem = null;
    await buyNow(j);
    save();
    return { status: 200, body: view(j) };
  }

  // What a browser gets: everything about the job but the signed quote's raw request, which is
  // kept for disputes (it repeats the addresses).
  function view(j) {
    const { signed, checked_at, ...near } = j.near;
    void checked_at;
    return {
      id: j.id,
      kind: j.kind,
      state: j.state,
      outcome: j.outcome ?? null,
      created_at: j.created_at,
      updated_at: j.updated_at,
      zec_zat: j.zec_zat,
      via: j.via,
      maker: j.maker,
      asset: j.asset,
      via_asset: j.via_asset,
      address: j.address,
      own_address: j.own_address,
      ferry: j.ferry,
      near: { ...near, signature: signed?.signature ?? null, timestamp: signed?.timestamp ?? null },
      problem: j.problem ?? null,
      timeline: j.timeline,
      explorer: EXPLORER_URL,
    };
  }

  return {
    async info() {
      const tokens = await tokenList();
      const [sell, buy] = await Promise.all([daemons.list("sell"), daemons.list("buy")]);
      const runs = (list) => list.some((d) => canRun(d.status) && FERRY_ASSETS[d.pair]);
      return {
        available: !!tokens,
        execution: { sell: runs(sell), buy: runs(buy) },
        // why not: "demo" (this server doesn't run NEAR swaps) or "mainnet" (its nodes are on test networks)
        reason: runs(sell) || runs(buy) ? null : reason() ?? "mainnet",
        tokens: tokens ?? [],
        explorer: EXPLORER_URL,
      };
    },
    quote,
    start,
    retry,
    tick,
    jobs: () => jobs.map(view),
    job: (id) => {
      const j = typeof id === "string" && JOB_ID.test(id) ? jobs.find((x) => x.id === id) : null;
      return j ? view(j) : null;
    },
    // the daemons whose coins a NEAR buy is about to spend (it arrived, the Ferry swap hasn't started)
    holds: () => new Set(jobs.filter((j) => j.kind === "buy" && j.state === "funding").map((j) => j.daemon)),
    stop: () => timer && clearInterval(timer),
  };
}

// ------------------------------------------------------------------------------------------------
// HTTP, for both UI servers (their req/res are Node's):
//   GET  /api/near/tokens           what NEAR Intents lists, and whether swaps run here
//   POST /api/near/quote            a composed quote (dry); `limit(req)` may refuse it (rate limits)
//   POST /api/near/swap             start one; `admit(req, {key, pair, kind})` is the server's guard
//   GET  /api/near/jobs             every NEAR swap, newest first
//   GET  /api/near/status/:id       one of them
//   POST /api/near/jobs/:id/retry   a buy holding its coin tries the Ferry swap again
// `origin(req)`: an error when the request's Origin may not post here. Returns false for a path it
// doesn't serve.
export function nearRoutes(desk, { send, readBody, origin = () => null, limit = () => null, admit = async () => null }) {
  const post = async (req, res, max = 2048) => {
    if (req.method !== "POST") {
      send(res, 405, { error: "Method not allowed" });
      return undefined;
    }
    const o = origin(req);
    if (o) {
      send(res, 403, { error: o });
      return undefined;
    }
    try {
      return JSON.parse((await readBody(req, max)) || "{}");
    } catch {
      send(res, 400, { error: "Send a JSON body" });
      return undefined;
    }
  };
  return async (req, res, path) => {
    if (!path.startsWith("/api/near/")) return false;
    if (path === "/api/near/tokens") {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed" }), true;
      send(res, 200, await desk.info());
      return true;
    }
    if (path === "/api/near/quote") {
      const body = await post(req, res);
      if (body === undefined) return true;
      const wait = limit(req);
      if (wait) return send(res, 429, { error: "Too many price requests. Try again in a minute." }, { "retry-after": String(wait) }), true;
      const r = await desk.quote(body);
      send(res, r.status, r.body);
      return true;
    }
    if (path === "/api/near/swap") {
      const body = await post(req, res, 4096);
      if (body === undefined) return true;
      // what admit() took (a rate-limit slot) comes back if the start then fails
      const r = await desk.start(body, { admit: (what) => admit(req, what), refused: () => req.ferryRefused?.() });
      send(res, r.status, r.body);
      return true;
    }
    if (path === "/api/near/jobs") {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed" }), true;
      send(res, 200, desk.jobs());
      return true;
    }
    const one = path.match(/^\/api\/near\/status\/(n[0-9a-f]{16})$/);
    if (one) {
      const v = desk.job(one[1]);
      send(res, v ? 200 : 404, v ?? { error: "No such NEAR Intents swap" });
      return true;
    }
    const again = path.match(/^\/api\/near\/jobs\/(n[0-9a-f]{16})\/retry$/);
    if (again) {
      if ((await post(req, res)) === undefined) return true;
      const r = await desk.retry(again[1]);
      send(res, r.status, r.body);
      return true;
    }
    send(res, 404, { error: "Not found" });
    return true;
  };
}
