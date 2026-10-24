// The mock node's own wallet (mock/server.mjs): what each party may send out, sending it
// (POST /api/withdraw), and what it sent (GET /api/withdrawals), as ferryd has them (docs/API.md,
// "Withdraw"):
//   POST /api/withdraw {asset: "zec" | "btc" ("ltc" on a Litecoin daemon) | "token" (or its symbol)
//     | "eth", amount, to} → 201 {id, asset, coin, amount, to, fee, fee_coin, txid, status,
//     confirmations, error, created_at, updated_at}; errors {error}: 400 for a bad body or address
//     ("to: …") or more than is free (saying how much is)
//   GET /api/withdrawals → newest first; status "pending" until its chain's next block, then
//     "confirmed" (confirmations up to 6), or "failed" with an error
// Amounts (and fees) are base units as decimal strings; the recipient gets `amount`, the fee is on
// top. Only free coins go out: what no swap holds before its lock. ZEC goes to shielded (unified)
// addresses only. One marked to fail (POST /api/_mock/fail-next-withdraw) is dropped by the network a
// moment later, and its coins come back.
// Mock only: {"dry_run": true} answers the fee without sending, and statuses list "withdraw_preview"
// for it (ferryd has no dry run; the UI server sends it to no daemon that doesn't list it).
// Also a Ferry node for USDC on Base Sepolia that only holds coins (usdcNode), for the wallet's EVM
// side.
import { randomBytes } from "node:crypto";

const hex = (n) => randomBytes(n).toString("hex");
const iso = (ms = Date.now()) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

// what each send costs: a ZIP-317 fee for two actions, a small Bitcoin fee, and gas at 1 gwei
export const FEES = { zec: 10_000, btc: 1_500, eth: 21_000n * 1_000_000_000n, token: 65_000n * 1_000_000_000n };

// u1… on mainnet, utest1… on testnet, uregtest1… on regtest
export const uaPrefix = (network) => (network === "main" || network === "mainnet" ? "u1" : network === "test" || network === "testnet" ? "utest1" : `u${network}1`);

// why `to` isn't a shielded address of this Zcash network, in ferryd's plain words, or null
export function zecProblem(to, network) {
  if (/^(t1|t3|tm|t2|tex1|textest1)/i.test(to)) return "Ferry only sends shielded ZEC; use a shielded address";
  if (/^z(s|testsapling|regtestsapling)1/.test(to)) return "a Sapling address; Ferry sends to a unified address with an Orchard receiver";
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

// One party's sends. `assets` says what it holds: {zec: slot, btc | token | eth: slot}, a slot being
// {sym, coin, decimals, alias?, check(to), fee, feeFrom? (a token's gas slot), units(), free(),
// take(n), give(n)}; `confs(rec)` counts a sent record's confirmations.
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
      const asked = body?.asset;
      const asset = Object.hasOwn(assets, asked) ? asked : Object.keys(assets).find((k) => assets[k].alias === asked);
      const a = asset && assets[asset];
      if (!a) return [400, { error: `asset: this daemon sends ${Object.keys(assets).map((k) => `"${k}"`).join(", ")}, not ${JSON.stringify(asked ?? null)}` }];
      const amount = big(body?.amount);
      if (amount == null || amount <= 0n) return [400, { error: "amount must be a positive whole number of base units (a JSON integer or a string of digits)" }];
      const to = typeof body?.to === "string" ? body.to.trim() : "";
      const bad = a.check(to);
      if (bad) return [400, { error: `to: ${bad}` }];
      const fee = BigInt(a.fee);
      // the recipient gets `amount`; the fee is on top, in the same coin except a token's gas (ETH)
      const need = a.feeFrom ? amount : amount + fee;
      const free = a.free();
      if (need > free) {
        const held = a.units() - free;
        const t = (v) => text(v, a.decimals, a.sym);
        return [400, { error: `Only ${t(free)} is free to withdraw: ${t(a.units())} is in the wallet${held > 0n ? ` and ${t(held)} is held for a swap in progress` : ""}. This needs ${t(amount)} plus up to ${a.feeFrom ? text(fee, 18, "ETH") : t(fee)} in fees` }];
      }
      if (a.feeFrom && fee > a.feeFrom.free()) return [400, { error: `Only ${text(a.feeFrom.free(), 18, "ETH")} is free for gas. This needs up to ${text(fee, 18, "ETH")}` }];
      const feeCoin = a.feeFrom ? a.feeFrom.coin : a.coin;
      if (body?.dry_run === true) return [200, { asset, coin: a.coin, amount: amount.toString(), to, fee: fee.toString(), fee_coin: feeCoin, dry_run: true }];
      a.take(need);
      a.feeFrom?.take(fee);
      const now = Date.now();
      const rec = { id: hex(16), txid: hex(32), asset, coin: a.coin, amount, fee, fee_coin: feeCoin, to, created: now, updated: now, status: "pending", error: null, tx: null, a };
      if (failNext) {
        failNext = false;
        rec.failAt = now + failMs;
      } else rec.tx = broadcast(rec);
      list.unshift(rec);
      return [201, view(rec, confs)];
    },
    // statuses as the chains move: confirmed once mined, failed when dropped (its coins come back)
    tick(confs) {
      for (const r of list) {
        if (r.status === "failed") continue;
        if (r.failAt && Date.now() >= r.failAt) {
          r.status = "failed";
          r.error = "The network dropped the transaction (its fee was too low), so it can never confirm. The coins are back in your wallet.";
          r.updated = Date.now();
          r.a.give(r.a.feeFrom ? r.amount : r.amount + r.fee);
          if (r.a.feeFrom) r.a.feeFrom.give(r.fee);
          continue;
        }
        const c = r.tx ? Math.min(6, confs(r)) : 0;
        if (c !== (r.confs ?? 0)) {
          r.confs = c;
          r.status = c >= 1 ? "confirmed" : "pending";
          r.updated = Date.now();
        }
      }
    },
    list: (confs) => list.map((r) => view(r, confs)),
  };
}

function view(r, confs) {
  const c = r.status === "failed" || !r.tx ? 0 : Math.min(6, confs(r));
  return {
    id: r.id,
    asset: r.asset,
    coin: r.coin,
    amount: r.amount.toString(),
    to: r.to,
    fee: r.fee.toString(),
    fee_coin: r.fee_coin,
    txid: r.txid,
    status: r.status === "failed" ? "failed" : c >= 1 ? "confirmed" : "pending",
    confirmations: c,
    error: r.error,
    created_at: iso(r.created),
    updated_at: iso(r.updated),
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
  const slot = (k, sym, coin, decimals, check, fee, feeFrom, alias) => ({
    sym,
    coin,
    decimals,
    check,
    fee,
    feeFrom,
    alias,
    units: () => bal[k],
    free: () => bal[k],
    take: (n) => (bal[k] -= n),
    give: (n) => (bal[k] += n),
  });
  const own = (to) => to.toLowerCase() === account.toLowerCase() && "that is this node's own account";
  const eth = slot("eth", "ETH", "eth", 18, (to) => own(to) || evmProblem(to), FEES.eth);
  const assets = {
    zec: slot("zec", "ZEC", "zec", 8, (to) => (to === zecAddress ? "that is this node's own address" : zecProblem(to, zec.network)), FEES.zec),
    token: slot("token", "USDC", "usdc", 6, (to) => (/^0x/i.test(to) && to.toLowerCase() === USDC_BASE_SEPOLIA.toLowerCase() ? "that is the USDC contract itself, which would keep the tokens" : own(to) || evmProblem(to)), FEES.token, eth, "usdc"),
    eth,
  };
  const confs = (r) => (r.asset === "zec" ? (r.tx?.height != null ? zec.height - r.tx.height + 1 : 0) : Math.floor((Date.now() - r.created) / blockMs));
  const status = () => ({
    role: "B",
    name,
    balances: { zec_shielded_zat: Number(bal.zec), btc_sat: Number(bal.token), token_units: bal.token.toString(), eth_wei: bal.eth.toString() },
    chains: {
      btc: { network: "base-sepolia", height: height(), coin: "usdc", ticker: "USDC", decimals: 6, time: Math.floor(Date.now() / 1000) },
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
    tick: () => book.tick(confs),
    sends: () => book.list(confs),
    // [status, body], or null for a path it doesn't serve
    async route(req, path, readBody, broadcastZec) {
      if (req.method === "GET" && path === "/api/status") return [200, status()];
      if (req.method === "GET" && path === "/api/swaps") return [200, []];
      // one account receives the token and the gas coin
      if (req.method === "GET" && path === "/api/addresses")
        return [200, { role: "B", name, btc: { coin: "usdc", ticker: "USDC", network: "base-sepolia", chain_id: 84532, address: account, token: USDC_BASE_SEPOLIA, symbol: "USDC", decimals: 6 }, zec: { address: zecAddress, network: zec.network } }];
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
