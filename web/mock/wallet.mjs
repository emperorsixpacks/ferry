// The mock node's own wallet (mock/server.mjs): what each party may send out, sending it
// (POST /api/withdraw), and what it sent (GET /api/withdrawals), as the daemon contract has them:
//   POST /api/withdraw {asset: "zec" | "btc" | "token" | "eth", amount, to, dry_run?}
//     → {id, txid, asset, amount, fee, to, status: "pending"}; errors {error}
//   GET /api/withdrawals → newest first, each {…, status: "pending" | "confirmed" | "failed",
//     confirmations, created_at, error?}
// Amounts are base units: zatoshi and satoshi as numbers, token units and wei as decimal strings.
// Only free coins go out: what no swap holds before its lock. ZEC goes to shielded (unified)
// addresses only. A send is pending until its chain's next block, then confirmed; one marked to fail
// (POST /api/_mock/fail-next-withdraw) is dropped by the network a moment later, and its coins come
// back. Also a Ferry node for USDC on Base Sepolia that only holds coins (usdcNode), for the wallet's
// EVM side.
import { randomBytes } from "node:crypto";

const hex = (n) => randomBytes(n).toString("hex");
const nowS = () => Math.floor(Date.now() / 1000);

// what each send costs: a ZIP-317 fee for two actions, a small Bitcoin fee, and gas at 1 gwei
export const FEES = { zec: 10_000, btc: 1_500, eth: 21_000n * 1_000_000_000n, token: 65_000n * 1_000_000_000n };

// u1… on mainnet, utest1… on testnet, uregtest1… on regtest
export const uaPrefix = (network) => (network === "main" || network === "mainnet" ? "u1" : network === "test" || network === "testnet" ? "utest1" : `u${network}1`);

// why `to` isn't a shielded address of this Zcash network, in ferryd's plain words, or null
export function zecProblem(to, network) {
  if (/^(t1|t3|tm|t2|tex1|textest1)/i.test(to)) return "ZEC goes to shielded addresses only: that is a transparent address. Use your wallet's unified address.";
  if (/^z(s|testsapling|regtestsapling)1/.test(to)) return "ZEC goes to unified addresses only: that is an older Sapling address. Use your wallet's unified address.";
  if (!to.startsWith(uaPrefix(network)) || !/^[a-z0-9]{20,}$/.test(to)) return `not a unified address for Zcash ${network}`;
  return null;
}

const BTC_HRP = { regtest: "bcrt1", test: "tb1", testnet: "tb1", signet: "tb1", main: "bc1", bitcoin: "bc1", mainnet: "bc1" };
const LTC_HRP = { regtest: "rltc1", test: "tltc1", testnet: "tltc1", main: "ltc1", mainnet: "ltc1", litecoin: "ltc1" };
export function coinProblem(to, coin, network) {
  const hrp = (coin === "ltc" ? LTC_HRP : BTC_HRP)[network] ?? "bcrt1";
  if (!to.toLowerCase().startsWith(hrp) || !/^[a-z0-9]{14,90}$/i.test(to)) return `not a ${coin === "ltc" ? "Litecoin" : "Bitcoin"} ${network} address`;
  return null;
}
const evmProblem = (to) => (/^0x[0-9a-fA-F]{40}$/.test(to) ? (/^0x0{40}$/.test(to) ? "that is the zero address, which nobody can spend from" : null) : "not an address (0x and 40 hex digits)");

const big = (v) => {
  try {
    if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
    if (typeof v === "string" && /^\d{1,78}$/.test(v)) return BigInt(v);
  } catch {
    /* not an amount */
  }
  return null;
};
const text = (v, decimals, sym) => {
  const s = v.toString().padStart(decimals + 1, "0");
  const w = s.slice(0, -decimals) || "0";
  const f = s.slice(-decimals).replace(/0+$/, "");
  return `${w}${f ? `.${f}` : ""} ${sym}`;
};

// One party's sends. `wallet` says what it holds and how its chains work:
//   assets: {zec: {free(), take(n), give(n), chain, network}, btc|token|eth: {…}}
//   confs(rec): confirmations of a sent record
export function sendBook() {
  const list = [];
  let failNext = false;
  return {
    failNext: () => (failNext = true),
    reset: () => {
      list.length = 0;
      failNext = false;
    },
    // [status, body]
    withdraw(body, assets, { confs, broadcast, failMs }) {
      const asset = body?.asset;
      const a = assets[asset];
      if (!a) return [400, { error: `this daemon sends ${Object.keys(assets).map((k) => `"${k}"`).join(", ")}, not ${JSON.stringify(asset ?? null)}` }];
      const amount = big(body?.amount);
      if (amount == null || amount <= 0n) return [400, { error: "amount must be a positive whole number of base units" }];
      const to = typeof body?.to === "string" ? body.to.trim() : "";
      const bad = a.check(to);
      if (bad) return [400, { error: `to: ${bad}` }];
      const fee = BigInt(a.fee);
      // the fee comes out of the same coin, except a token's gas, which is ETH
      const need = a.feeFrom ? amount : amount + fee;
      const free = a.free();
      if (need > free) return [400, { error: `not enough free ${a.sym}: ${text(free, a.decimals, a.sym)} free (coins a swap holds can't be sent), ${text(need, a.decimals, a.sym)} needed${a.feeFrom ? "" : " with the fee"}` }];
      if (a.feeFrom && fee > a.feeFrom.free()) return [400, { error: `not enough ETH for gas: ${text(fee, 18, "ETH")} needed` }];
      const out = (v) => (a.decimals > 8 || asset === "token" ? v.toString() : Number(v));
      if (body?.dry_run === true) return [200, { asset, amount: out(amount), fee: out(fee), fee_asset: a.feeFrom ? "eth" : asset, to, dry_run: true }];
      a.take(need);
      a.feeFrom?.take(fee);
      const rec = { id: `w${hex(8)}`, txid: hex(32), asset, amount, fee, fee_asset: a.feeFrom ? "eth" : asset, to, created_at: nowS(), at: Date.now(), failed: null, tx: null, a, out };
      if (failNext) {
        failNext = false;
        rec.failAt = Date.now() + failMs;
      } else rec.tx = broadcast(rec);
      list.unshift(rec);
      return [200, view(rec, confs)];
    },
    tick() {
      for (const r of list)
        if (r.failAt && !r.failed && Date.now() >= r.failAt) {
          r.failed = "The network dropped the transaction (its fee was too low). The coins are back in your wallet.";
          r.a.give(r.a.feeFrom ? r.amount : r.amount + r.fee);
          if (r.a.feeFrom) r.a.feeFrom.give(r.fee);
        }
    },
    list: (confs) => list.map((r) => view(r, confs)),
  };
}

function view(r, confs) {
  const c = r.failed || !r.tx ? 0 : confs(r);
  return {
    id: r.id,
    txid: r.txid,
    asset: r.asset,
    amount: r.out(r.amount),
    fee: r.out(r.fee),
    fee_asset: r.fee_asset,
    to: r.to,
    status: r.failed ? "failed" : c >= 1 ? "confirmed" : "pending",
    confirmations: c,
    created_at: r.created_at,
    ...(r.failed ? { error: r.failed } : {}),
  };
}

// A Ferry node for USDC on Base Sepolia that holds coins and runs no swaps: its status (an EVM
// daemon's shape: token_units, eth_wei, the counter block), its addresses, its sends. `zec`: the
// mock's Zcash chain (its network and height).
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const FERRY_LOCK = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
export function usdcNode({ zec, blockMs = 2000, name = "bram-usdc" }) {
  const account = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const start = { zec: 30_000_000n, token: 125_500_000n, eth: 15_000_000_000_000_000n };
  let bal = { ...start };
  const born = Date.now();
  const height = () => 18_200_000 + Math.floor((Date.now() - born) / blockMs);
  const book = sendBook();
  const zecAddress = `${uaPrefix(zec.network)}mockwallet${Buffer.from(name).toString("hex")}`;
  const slot = (k, sym, decimals, check, fee, feeFrom) => ({
    sym,
    decimals,
    check,
    fee,
    feeFrom,
    free: () => bal[k],
    take: (n) => (bal[k] -= n),
    give: (n) => (bal[k] += n),
  });
  const eth = slot("eth", "ETH", 18, evmProblem, FEES.eth);
  const assets = {
    zec: slot("zec", "ZEC", 8, (to) => zecProblem(to, zec.network), FEES.zec),
    token: slot("token", "USDC", 6, (to) => (/^0x/i.test(to) && to.toLowerCase() === USDC_BASE_SEPOLIA.toLowerCase() ? "that is the USDC contract itself, which would keep the tokens" : evmProblem(to)), FEES.token, eth),
    eth,
  };
  const confs = (r) => (r.asset === "zec" ? (r.tx?.height != null ? zec.height - r.tx.height + 1 : 0) : Math.floor((Date.now() - r.at) / blockMs));
  const status = () => ({
    role: "B",
    name,
    balances: { zec_shielded_zat: Number(bal.zec), btc_sat: Number(bal.token), token_units: bal.token.toString(), eth_wei: bal.eth.toString() },
    chains: {
      btc: { network: "base-sepolia", height: height(), coin: "usdc", ticker: "USDC", decimals: 6, time: nowS() },
      zec: { network: zec.network, height: zec.height, pool: "ironwood" },
    },
    offer: { pair: "ZEC/USDC", rate_sat_per_zec: 41_250_000, min_zat: 10_000_000, max_zat: 1_000_000_000, t1_blocks: 0, t2_blocks: 0, zec_confs: 3, maker: false },
    counter: { kind: "evm", chain_id: 84532, contract: FERRY_LOCK, token: USDC_BASE_SEPOLIA, symbol: "USDC", decimals: 6, account },
    features: ["route", "payout", "withdraw", "withdraw_preview"],
  });
  return {
    status,
    reset() {
      bal = { ...start };
      book.reset();
    },
    failNext: () => book.failNext(),
    tick: () => book.tick(),
    // [status, body], or null for a path it doesn't serve
    async route(req, path, readBody, broadcastZec) {
      if (req.method === "GET" && path === "/api/status") return [200, status()];
      if (req.method === "GET" && path === "/api/swaps") return [200, []];
      if (req.method === "GET" && path === "/api/addresses")
        return [200, { role: "B", name, btc: { network: "base-sepolia", address: account, token: USDC_BASE_SEPOLIA, symbol: "USDC", decimals: 6, chain_id: 84532 }, zec: { address: zecAddress } }];
      if (req.method === "GET" && path === "/api/withdrawals") return [200, book.list(confs)];
      if (req.method === "POST" && path === "/api/withdraw") {
        const body = await readBody(req);
        return book.withdraw(body, assets, { confs, broadcast: (r) => (r.asset === "zec" ? broadcastZec() : { at: Date.now() }), failMs: blockMs * 1.5 });
      }
      if (req.method === "POST" && path === "/api/swaps") return [409, { error: "this mock node holds coins and runs no swaps" }];
      return null;
    },
  };
}
