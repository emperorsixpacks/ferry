// A mock of NEAR Intents' 1Click Swap API (https://1click.chaindefuser.com), so the NEAR Intents
// part of the swap card can be built and filmed without mainnet. The same paths and shapes:
//   GET  /v0/tokens                 a subset of the real list (real asset ids, fixed prices)
//   POST /v0/quote                  dry and real quotes, priced from those prices less a fee,
//                                   signed with the mock's own ed25519 key (MOCK_ONE_CLICK_PUBKEY;
//                                   the UI server checks it with FERRY_NEAR_PUBKEY), deposit addresses
//                                   on the origin chain
//   GET  /v0/status?depositAddress  PENDING_DEPOSIT → KNOWN_DEPOSIT_TX → PROCESSING → SUCCESS, from
//                                   when a deposit arrives; REFUNDED for a short deposit or a fault
// and for scripts:
//   POST /_mock/deposit {depositAddress, amount?}   the user's deposit (a buy), the quote's amount
//                                                   if left out
//   POST /_mock/fault {next: "refund"}              the next swap is refunded instead
//   POST /_mock/reset                               forget every quote
// A Ferry payout into a deposit address (the mock ferryd's payout_to) arrives through deposit().
// What NEAR Intents delivers, or refunds, goes to onDeliver({asset, address, amount}), so the mock
// world can credit its own parties.
import { createPrivateKey, createPublicKey, createHash, randomBytes, sign } from "node:crypto";
import { addressProblem, base58, ed25519Key, quoteMessage } from "../server/near.mjs";

// [assetId, symbol, blockchain, decimals, price]; ZEC at what the mock makers' BTC rates make it
const TOKENS = [
  ["nep141:btc.omft.near", "BTC", "btc", 8, 81479],
  ["nep141:ltc.omft.near", "LTC", "ltc", 8, 58.72],
  ["nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", "USDC", "base", 6, 0.999905],
  ["nep141:base-0x4200000000000000000000000000000000000006.omft.near", "WETH", "base", 18, 2388.77],
  ["nep141:base.omft.near", "ETH", "base", 18, 2388.77],
  ["nep141:base-0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf.omft.near", "cbBTC", "base", 8, 81439],
  ["nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", "USDC", "eth", 6, 0.999905],
  ["nep141:eth-0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2.omft.near", "WETH", "eth", 18, 2388.77],
  ["nep141:eth.omft.near", "ETH", "eth", 18, 2388.77],
  ["nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near", "USDT", "eth", 6, 0.999167],
  ["nep141:eth-0x6b175474e89094c44da98b954eedeac495271d0f.omft.near", "DAI", "eth", 18, 1],
  ["nep141:eth-0x2260fac5e5542a773aa44fbcfedf7c193bc2c599.omft.near", "WBTC", "eth", 8, 81338],
  ["nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near", "USDC", "arb", 6, 0.999905],
  ["nep141:arb-0x82af49447d8a07e3bd95bd0d56f35241523fbab1.omft.near", "WETH", "arb", 18, 2388.77],
  ["nep141:arb.omft.near", "ETH", "arb", 18, 2388.77],
  ["nep141:arb-0x912ce59144191c1204e64559fe8253a0e49e6548.omft.near", "ARB", "arb", 18, 0.189208],
  ["nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ", "USDC", "op", 6, 0.999905],
  ["nep245:v2_1.omni.hot.tg:10_vLAiSt9KfUGKpw5cD3vsSyNYBn5", "WETH", "op", 18, 2388.77],
  ["nep245:v2_1.omni.hot.tg:10_11111111111111111111", "ETH", "op", 18, 2388.77],
  ["nep245:v2_1.omni.hot.tg:10_vLAiSt9KfUGKpw5cD3vsSyNYBo7", "OP", "op", 18, 0.12605],
  ["nep141:sol.omft.near", "SOL", "sol", 9, 104.31],
  ["nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", "USDC", "sol", 6, 0.999905],
  ["nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near", "USDT", "sol", 6, 0.999167],
  ["nep141:wrap.near", "wNEAR", "near", 24, 4.7],
  ["nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "USDC", "near", 6, 0.999905],
  ["nep245:v2_1.omni.hot.tg:56_11111111111111111111", "BNB", "bsc", 18, 730.32],
  ["nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g", "USDT", "bsc", 18, 0.999167],
  ["nep141:tron.omft.near", "TRX", "tron", 6, 0.331275],
  ["nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near", "USDT", "tron", 6, 0.999167],
  ["nep141:xrp.omft.near", "XRP", "xrp", 6, 1.3],
  ["nep141:doge.omft.near", "DOGE", "doge", 8, 0.079294],
  ["nep141:sui.omft.near", "SUI", "sui", 9, 0.996567],
  ["nep141:cardano.omft.near", "ADA", "cardano", 6, 0.217225],
  ["nep141:zec.omft.near", "ZEC", "zec", 8, 336.1],
  ["1cs_v1:sol:spl:A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS", "ZEC", "sol", 8, 336.1],
  ["nep245:v2_1.omni.hot.tg:43114_11111111111111111111", "AVAX", "avax", 18, 9.46],
  ["nep245:v2_1.omni.hot.tg:137_11111111111111111111", "POL", "pol", 18, 0.092467],
  ["nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz", "XLM", "stellar", 7, 0.176131],
  ["nep141:aptos.omft.near", "APT", "aptos", 8, 0.777213],
  ["nep141:bch.omft.near", "BCH", "bch", 8, 273.97],
].map(([assetId, symbol, blockchain, decimals, price]) => ({ assetId, symbol, blockchain, decimals, price, priceUpdatedAt: new Date().toISOString(), contractAddress: null }));

// a fixed key, so the UI server can be told it: MOCK_ONE_CLICK_PUBKEY
const SEED = createHash("sha256").update("ferry mock 1click").digest();
const KEY = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), SEED]), format: "der", type: "pkcs8" });
const RAW_PUB = createPublicKey(KEY).export({ format: "der", type: "spki" }).subarray(-32);
export const MOCK_ONE_CLICK_PUBKEY = `ed25519:${base58(RAW_PUB)}`;
// sanity: the key the server will build from that string verifies what this one signs
ed25519Key(MOCK_ONE_CLICK_PUBKEY);

// the fee 1Click keeps without an API key (25 bps) and its protocol and partner fees, roughly
const FEE_BPS = 45n;
const BECH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const bech = (n) => Array.from(randomBytes(n), (x) => BECH[x & 31]).join("");
const hex = (n) => randomBytes(n).toString("hex");

// a fresh deposit address on `chain`, in its format
function depositAddress(chain) {
  if (chain === "btc") return `bc1q${bech(38)}`;
  if (chain === "ltc") return `ltc1q${bech(38)}`;
  if (chain === "sol") return base58(randomBytes(32));
  if (chain === "near") return hex(32);
  if (chain === "tron") return `T${base58(randomBytes(24)).slice(0, 33).padEnd(33, "1")}`;
  if (chain === "xrp") return `r${base58(randomBytes(20)).slice(0, 30)}`;
  if (chain === "doge") return `D${base58(randomBytes(24)).slice(0, 33).padEnd(33, "1")}`;
  if (chain === "sui" || chain === "aptos") return `0x${hex(32)}`;
  if (chain === "cardano") return `addr1${bech(98)}`;
  if (chain === "stellar") return `G${Array.from(randomBytes(55), (x) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[x & 31]).join("")}`;
  if (chain === "bch") return `bitcoincash:q${bech(41)}`;
  return `0x${hex(20)}`;
}
// how long the mock says its part takes, by origin chain (seconds)
const TIMES = { btc: 600, ltc: 300, doge: 180, bch: 300, eth: 60, sol: 20, near: 10 };

export function mockOneClick({ speed = 1, onDeliver = () => {}, now = Date.now } = {}) {
  const byDeposit = new Map(); // depositAddress -> { response, status, updatedAt, deposited, timers }
  let fault = null;
  const tokenOf = (id) => TOKENS.find((t) => t.assetId === id);

  const send = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const bad = (res, message) => send(res, 400, { message, correlationId: crypto.randomUUID(), timestamp: new Date().toISOString(), path: "/v0/quote" });

  const accountish = (v) => typeof v === "string" && (/^[0-9a-f]{64}$/.test(v) || /^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.near$/.test(v));
  // a recipient or refund address of `type` for `token`
  function addressOk(type, v, token) {
    if (type === "INTENTS") return accountish(v);
    if (type !== "ORIGIN_CHAIN" && type !== "DESTINATION_CHAIN") return false;
    if (token.blockchain === "btc" && /^(bcrt1|tb1)[02-9ac-hj-np-z]{8,87}$/.test(v)) return true;
    return addressProblem(token.blockchain, v) === null;
  }

  const units = (n, d) => BigInt(Math.round(n * 10 ** Math.min(d, 15))) * 10n ** BigInt(Math.max(0, d - 15));
  const fmt = (v, d) => {
    const s = v.toString().padStart(d + 1, "0");
    return d ? `${s.slice(0, -d)}.${s.slice(-d)}`.replace(/0+$/, "").replace(/\.$/, "") : s;
  };
  const usd = (v, t) => ((Number(v) / 10 ** t.decimals) * t.price).toFixed(4);

  function quote(body) {
    const q = body ?? {};
    const required = ["swapType", "slippageTolerance", "originAsset", "depositType", "destinationAsset", "amount", "refundTo", "refundType", "recipient", "recipientType", "deadline"];
    for (const k of required) if (q[k] === undefined) return [400, `${k} is required`];
    const from = tokenOf(q.originAsset);
    const to = tokenOf(q.destinationAsset);
    if (!from) return [400, "originAsset is not valid"];
    if (!to) return [400, "destinationAsset is not valid"];
    if (!/^[1-9][0-9]{0,39}$/.test(String(q.amount))) return [400, "amount is not valid"];
    if (!["EXACT_INPUT", "EXACT_OUTPUT", "FLEX_INPUT"].includes(q.swapType)) return [400, "swapType is not valid"];
    if (!addressOk(q.recipientType, q.recipient, to)) return [400, "recipient is not valid"];
    if (!addressOk(q.refundType, q.refundTo, from)) return [400, "refundTo is not valid"];
    const slip = BigInt(Math.max(0, Math.min(10_000, Number(q.slippageTolerance) || 0)));
    const amount = BigInt(q.amount);
    // the exchange rate, in base units, as a fraction: to per from
    const num = units(from.price, 12) * 10n ** BigInt(to.decimals);
    const den = units(to.price, 12) * 10n ** BigInt(from.decimals);
    const withdraw = q.recipientType === "DESTINATION_CHAIN" ? units(0.02 / to.price, to.decimals) : 0n;
    let amountIn, amountOut, minIn, minOut;
    if (q.swapType === "EXACT_OUTPUT") {
      amountOut = amount;
      minOut = amount;
      minIn = ((amount + withdraw) * den * 10_000n) / (num * (10_000n - FEE_BPS)) + 1n;
      amountIn = (minIn * (10_000n + slip)) / 10_000n;
    } else {
      amountIn = amount;
      amountOut = (amount * num * (10_000n - FEE_BPS)) / (den * 10_000n) - withdraw;
      minIn = q.swapType === "FLEX_INPUT" ? (amount * (10_000n - slip)) / 10_000n : amount;
      minOut = (amountOut * (10_000n - slip)) / 10_000n;
    }
    if (amountOut <= 0n || Number(usd(amountIn, from)) < 0.5) return [400, "Amount is too low for bridge, try at least 0.5 USD"];
    const t = TIMES[from.blockchain] ?? 30;
    const quoteOut = {
      amountIn: amountIn.toString(),
      amountInFormatted: fmt(amountIn, from.decimals),
      amountInUsd: usd(amountIn, from),
      minAmountIn: minIn.toString(),
      amountOut: amountOut.toString(),
      amountOutFormatted: fmt(amountOut, to.decimals),
      amountOutUsd: usd(amountOut, to),
      minAmountOut: minOut.toString(),
      timeEstimate: t,
      refundFee: "0",
      withdrawFee: withdraw.toString(),
    };
    if (!q.dry) {
      quoteOut.depositAddress = depositAddress(from.blockchain);
      quoteOut.deadline = q.deadline;
      quoteOut.timeWhenInactive = q.deadline;
    }
    const request = {
      dry: !!q.dry,
      depositMode: "SIMPLE",
      swapType: q.swapType,
      slippageTolerance: Number(q.slippageTolerance),
      originAsset: q.originAsset,
      depositType: q.depositType,
      destinationAsset: q.destinationAsset,
      amount: String(q.amount),
      refundTo: q.refundTo,
      refundType: q.refundType,
      recipient: q.recipient,
      recipientType: q.recipientType,
      deadline: q.deadline,
      quoteWaitingTimeMs: 0,
    };
    const response = { quote: quoteOut, quoteRequest: request, signature: "", timestamp: new Date(now()).toISOString(), correlationId: crypto.randomUUID() };
    response.signature = `ed25519:${base58(sign(null, Buffer.from(quoteMessage(response), "utf8"), KEY))}`;
    if (!q.dry) byDeposit.set(quoteOut.depositAddress, { response, status: "PENDING_DEPOSIT", updatedAt: now(), details: null, timers: [] });
    return [201, response];
  }

  const later = (e, ms, fn) => e.timers.push(setTimeout(fn, ms / speed));
  const set = (e, status, details = e.details) => Object.assign(e, { status, updatedAt: now(), details });

  // a deposit arrives at `address` (a Ferry payout, or the user's own for a buy)
  function deposit(address, amount = null) {
    const e = byDeposit.get(address);
    if (!e || e.status !== "PENDING_DEPOSIT") return false;
    const q = e.response.quote;
    const r = e.response.quoteRequest;
    const got = amount == null ? BigInt(q.amountIn) : BigInt(amount);
    const from = tokenOf(r.originAsset);
    const to = tokenOf(r.destinationAsset);
    const tx = (chain) => ({ hash: chain === "near" ? base58(randomBytes(32)) : hex(32), explorerUrl: chain === "btc" ? `https://mempool.space/tx/${hex(32)}` : null });
    const base = { intentHashes: [], nearTxHashes: [], originChainTxHashes: [tx(from.blockchain)], destinationChainTxHashes: [], depositedAmount: got.toString(), depositedAmountFormatted: fmt(got, from.decimals) };
    set(e, "KNOWN_DEPOSIT_TX", base);
    const refund = fault === "refund" || got < BigInt(q.minAmountIn);
    if (fault === "refund") fault = null;
    later(e, 3000, () => set(e, refund && got < BigInt(q.minAmountIn) ? "INCOMPLETE_DEPOSIT" : "PROCESSING", { ...base, intentHashes: [base58(randomBytes(32))], nearTxHashes: [base58(randomBytes(32))] }));
    later(e, 10_000, () => {
      if (refund) {
        set(e, "REFUNDED", { ...e.details, refundedAmount: got.toString(), refundedAmountFormatted: fmt(got, from.decimals), refundReason: got < BigInt(q.minAmountIn) ? "PARTIAL_DEPOSIT" : "PRICE_CHANGED" });
        onDeliver({ asset: r.originAsset, address: r.refundTo, amount: got, refund: true });
        return;
      }
      // a bigger deposit pays out in proportion (FLEX_INPUT), an exact output pays what it said
      const out = r.swapType === "EXACT_OUTPUT" ? BigInt(q.amountOut) : (BigInt(q.amountOut) * got) / BigInt(q.amountIn);
      const dest = { hash: to.blockchain === "near" ? base58(randomBytes(32)) : hex(32), explorerUrl: to.blockchain === "sol" ? `https://solscan.io/tx/${base58(randomBytes(64))}` : null };
      set(e, "SUCCESS", { ...e.details, amountIn: got.toString(), amountInFormatted: fmt(got, from.decimals), amountOut: out.toString(), amountOutFormatted: fmt(out, to.decimals), destinationChainTxHashes: [dest], slippage: 12 });
      onDeliver({ asset: r.destinationAsset, address: r.recipient, amount: out, refund: false });
    });
    return true;
  }

  function status(address) {
    const e = byDeposit.get(address);
    if (!e) return [404, { message: "Deposit address not found" }];
    return [200, { correlationId: crypto.randomUUID(), quoteResponse: e.response, status: e.status, updatedAt: new Date(e.updatedAt).toISOString(), swapDetails: e.details ?? { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [] } }];
  }

  async function handler(req, res, readBody) {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/v0/tokens") return send(res, 200, TOKENS);
    if (req.method === "POST" && url.pathname === "/v0/quote") {
      const [code, body] = quote(await readBody(req));
      return code === 201 ? send(res, 201, body) : bad(res, body);
    }
    if (req.method === "GET" && url.pathname === "/v0/status") {
      const [code, body] = status(url.searchParams.get("depositAddress"));
      return send(res, code, body);
    }
    if (req.method === "POST" && url.pathname === "/_mock/deposit") {
      const b = await readBody(req);
      return deposit(b?.depositAddress, b?.amount ?? null) ? send(res, 200, { ok: true }) : send(res, 404, { error: "no quote waiting for a deposit at that address" });
    }
    if (req.method === "POST" && url.pathname === "/_mock/fault") {
      fault = (await readBody(req))?.next === "refund" ? "refund" : null;
      return send(res, 200, { ok: true, fault });
    }
    if (req.method === "POST" && url.pathname === "/_mock/reset") {
      for (const e of byDeposit.values()) e.timers.forEach(clearTimeout);
      byDeposit.clear();
      fault = null;
      return send(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/_mock/quotes") return send(res, 200, [...byDeposit.entries()].map(([a, e]) => ({ depositAddress: a, status: e.status, request: e.response.quoteRequest, quote: e.response.quote })));
    send(res, 404, { message: "Not found" });
  }

  return { handler, deposit, status, tokens: TOKENS, publicKey: MOCK_ONE_CLICK_PUBKEY };
}
