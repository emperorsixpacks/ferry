// What `ferry status`, `ferry addresses` and `ferry up` print about the node's daemons. Runs with
// node inside the web container (`ferry` pipes it in on stdin), which reaches every daemon on the
// node's private network and can read their API tokens; no dependencies, nothing written.
//
// Env (set by infra/node/ferry):
//   FERRY_REPORT_MODE    status | addresses | ready
//   FERRY_REPORT_PAIRS   the enabled pairs, comma-separated (usdc-base,weth-base,btc,ltc)
//   FERRY_REPORT_NET     testnet | mainnet
//   FERRY_REPORT_PS      one line per container: "<service> <state> <health>"
//   FERRY_REPORT_BTC_NODE, FERRY_REPORT_LTC_NODE   the chain node's getblockchaininfo JSON, if any
//   FERRY_REPORT_RPC_HOST   the EVM RPC's scheme://host (never the path, which can hold a key)
import http from "node:http";
import { readFileSync } from "node:fs";

const env = process.env;
const MODE = env.FERRY_REPORT_MODE ?? "status";
const PAIRS = (env.FERRY_REPORT_PAIRS ?? "").split(",").filter(Boolean);
const MAINNET = env.FERRY_REPORT_NET === "mainnet";

const PS = Object.fromEntries(
  (env.FERRY_REPORT_PS ?? "")
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p[0])
    .map(([svc, state = "", health = ""]) => [svc, { state, health }]),
);

// ------------------------------------------------------------------------------------------------
// what each pair is

const EVM_NET = MAINNET ? "Base mainnet (chain 8453)" : "Base Sepolia (chain 84532)";
const EVM_SHORT = MAINNET ? "Base mainnet" : "Base Sepolia";
const ZEC_NET = MAINNET ? "Zcash mainnet" : "Zcash testnet";
const ZEC_UNIT = MAINNET ? "ZEC" : "TAZ";
const FAUCET = {
  taz: "https://fauzec.com (testnet ZEC, about 1 TAZ a day)",
  eth: "the Coinbase CDP faucet (https://portal.cdp.coinbase.com/products/faucet) or the Alchemy faucet (https://www.alchemy.com/faucets/base-sepolia); pick BASE SEPOLIA, not Ethereum Sepolia",
  usdc: "https://faucet.circle.com, network Base Sepolia",
  weth: "wrap Base Sepolia ETH: call deposit() on WETH 0x4200000000000000000000000000000000000006 from any wallet, then send the WETH here",
  sbtc: "https://signetfaucet.com or https://alt.signetfaucet.com (Bitcoin SIGNET, the default signet: not testnet3, testnet4 or Mutinynet)",
  tltc: "a Litecoin testnet faucet (they come and go: search \"litecoin testnet faucet\"), or anyone holding tLTC",
};

const PAIR = {
  "usdc-base": { token: "USDC", dec: 6, evm: true, net: EVM_NET, title: `ZEC <-> USDC on ${EVM_SHORT}`, gasB: "0.002", gasZ: "0.001", fund: "10" },
  "weth-base": { token: "WETH", dec: 18, evm: true, net: EVM_NET, title: `ZEC <-> WETH on ${EVM_SHORT}`, gasB: "0.002", gasZ: "0.001", fund: "0.005" },
  btc: { token: "BTC", dec: 8, evm: false, net: "Bitcoin signet", title: "ZEC <-> BTC on Bitcoin signet", fund: "0.001", node: "btc" },
  ltc: { token: "LTC", dec: 8, evm: false, net: "Litecoin testnet (testnet4)", title: "ZEC <-> LTC on Litecoin testnet", fund: "0.3", node: "ltc" },
};
if (MAINNET) {
  PAIR["usdc-base"].gasB = "0.0005";
  PAIR["usdc-base"].gasZ = "0.0002";
  PAIR["usdc-base"].fund = "5";
  PAIR["weth-base"].gasB = "0.0005";
  PAIR["weth-base"].gasZ = "0.0002";
  PAIR["weth-base"].fund = "0.002";
}

const svc = (role, pair) => `ferryd-${role}-${pair}`;
const port = (role) => (role === "z" ? 7101 : 7102);

// ------------------------------------------------------------------------------------------------
// talking to the daemons

function token(service) {
  try {
    return readFileSync(`/tokens/${service}/api-token`, "utf8").trim();
  } catch {
    return null;
  }
}

function get(service, role, path) {
  const t = token(service);
  if (!t) return Promise.resolve(null);
  return new Promise((ok) => {
    const req = http.request(
      { host: service, port: port(role), path, headers: { authorization: `Bearer ${t}` }, timeout: 8000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode !== 200) return ok(null);
          try {
            ok(JSON.parse(body));
          } catch {
            ok(null);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => ok(null));
    req.end();
  });
}

// ------------------------------------------------------------------------------------------------
// numbers

function units(n, d) {
  // an exact decimal of n base units at d decimals
  let s;
  try {
    s = BigInt(n).toString();
  } catch {
    return "?";
  }
  if (d === 0) return s;
  s = s.padStart(d + 1, "0");
  const whole = s.slice(0, -d);
  const frac = s.slice(-d).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
const zec = (zat) => units(zat, 8);
const eth = (wei) => {
  const s = units(wei, 18);
  const [w, f = ""] = s.split(".");
  const short = f.slice(0, 6).replace(/0+$/, "");
  return short ? `${w}.${short}` : w;
};
const counterBalance = (p, s) => (p.evm ? units(s.balances.token_units, p.dec) : units(s.balances.btc_sat, p.dec));
const int = (n) => Number(n).toLocaleString("en-US");

function nodeLine(kind) {
  const raw = env[kind === "btc" ? "FERRY_REPORT_BTC_NODE" : "FERRY_REPORT_LTC_NODE"];
  const name = kind === "btc" ? "Bitcoin signet node" : "Litecoin testnet node";
  const ps = PS[kind === "btc" ? "bitcoind" : "litecoind"];
  if (!ps || ps.state !== "running") return `${name}: not running`;
  let n;
  try {
    n = JSON.parse(raw ?? "");
  } catch {
    return `${name}: starting (not answering yet)`;
  }
  const size = n.size_on_disk ?? 0;
  const gb = size >= 1e9 ? `, ${(size / 1e9).toFixed(1)} GB on disk` : size ? `, ${Math.round(size / 1e6)} MB on disk` : "";
  const synced = !n.initialblockdownload && n.blocks === n.headers && n.headers > 0;
  if (synced) return `${name}: synced, block ${int(n.blocks)}${gb}`;
  const pct = (100 * (n.verificationprogress ?? 0)).toFixed(1);
  return `${name}: SYNCING, block ${int(n.blocks)} of ${int(n.headers)} headers (${pct}%)${gb}. ZEC/${kind.toUpperCase()} swaps work once it is synced; it keeps going in the background.`;
}

function state(service) {
  const p = PS[service];
  if (!p) return "not running";
  if (p.state !== "running") return p.state || "stopped";
  return p.health && p.health !== "healthy" ? `running (${p.health})` : "running";
}

// ------------------------------------------------------------------------------------------------

async function gather() {
  const out = [];
  for (const pair of PAIRS) {
    const sides = {};
    for (const role of ["z", "b"]) {
      const s = svc(role, pair);
      const [status, addresses, swaps] = await Promise.all([
        get(s, role, "/api/status"),
        MODE === "addresses" ? get(s, role, "/api/addresses") : null,
        MODE === "status" ? get(s, role, "/api/swaps") : null,
      ]);
      sides[role] = { service: s, status, addresses, swaps };
    }
    out.push({ pair, ...sides });
  }
  return out;
}

const LIVE = (sw) => sw.outcome == null || sw.outcome === "" || sw.outcome === "pending" || sw.outcome === "live";

function printStatus(data) {
  for (const { pair, z, b } of data) {
    const p = PAIR[pair];
    console.log(p.title);
    if (p.node) console.log(`  ${nodeLine(p.node)}`);
    const any = z.status ?? b.status;
    if (any) {
      const c = any.chains;
      const where = p.evm ? ` via ${env.FERRY_REPORT_RPC_HOST || "the RPC"}` : "";
      console.log(`  ${p.net}: block ${int(c.btc.height)}${where}; ${ZEC_NET}: block ${int(c.zec.height)}`);
    }
    for (const [label, side] of [["sell ZEC (Z)", z], ["buy ZEC (B)", b]]) {
      const s = side.status;
      if (!s) {
        console.log(`  ${label.padEnd(13)} ${state(side.service)}, not answering yet`);
        continue;
      }
      const bal = [`${zec(s.balances.zec_shielded_zat)} ${ZEC_UNIT}`, `${counterBalance(p, s)} ${p.token}`];
      if (p.evm) bal.push(`${eth(s.balances.eth_wei)} ETH`);
      console.log(`  ${label.padEnd(13)} ${state(side.service)}: ${bal.join(", ")}`);
      const sw = Array.isArray(side.swaps) ? side.swaps : [];
      const live = sw.filter(LIVE);
      if (live.length) {
        for (const w of live) console.log(`      swap ${String(w.id).slice(0, 12)}...  ${w.state}`);
      } else if (sw.length) {
        console.log(`      ${sw.length} finished swap${sw.length === 1 ? "" : "s"}, none in progress`);
      }
    }
    console.log("");
  }
}

function printAddresses(data) {
  if (!MAINNET) {
    console.log("Everything below is on TEST networks: the coins have no value, and the faucets give them away.");
    console.log("");
  }
  for (const { pair, z, b } of data) {
    const p = PAIR[pair];
    const zs = z.status;
    const za = z.addresses;
    const ba = b.addresses;
    console.log(p.title);
    if (p.node) console.log(`  (${nodeLine(p.node)})`);
    const maxZat = zs?.offer?.max_zat ?? null;
    const zAddr = za?.zec?.address ?? "(not answering yet: try again in a minute)";
    const zCounter = za?.btc?.address ?? "(not answering yet)";
    const bCounter = ba?.btc?.address ?? "(not answering yet: try again in a minute)";
    const bZec = ba?.zec?.address ?? "(not answering yet)";

    console.log(`  To SELL ZEC, fund your Z wallet ("${zs?.name ?? "sell"}"):`);
    console.log(`    ${ZEC_UNIT} on ${ZEC_NET}, to its shielded address${maxZat ? ` (${zec(maxZat + 50000)} ${ZEC_UNIT} covers the largest swap, ${zec(maxZat)}, plus fees)` : ""}:`);
    console.log(`      ${zAddr}`);
    if (!MAINNET) console.log(`      from ${FAUCET.taz}`);
    console.log(`      spendable after 10 confirmations (about 13 minutes)`);
    if (p.evm) {
      console.log(`    a little ETH on ${p.net} for the claim's gas: about ${p.gasZ} ETH`);
      console.log(`      ${zCounter}`);
      if (!MAINNET) console.log(`      from ${FAUCET.eth}`);
      console.log(`    The ${p.token} you get arrives at that same ${p.net} account.`);
    } else {
      console.log(`    The ${p.token} you get arrives in this wallet's ${p.net} addresses (no funding needed).`);
    }

    console.log(`  To BUY ZEC, fund your B wallet ("${b.status?.name ?? "buy"}"):`);
    if (p.evm) {
      console.log(`    ${p.token} on ${p.net}${MAINNET ? "" : ` (for example ${p.fund} ${p.token})`}, and about ${p.gasB} ETH there for gas:`);
      console.log(`      ${bCounter}`);
      if (!MAINNET) {
        console.log(`      ${p.token} from ${p.token === "USDC" ? FAUCET.usdc : FAUCET.weth}`);
        console.log(`      ETH from ${FAUCET.eth}`);
      } else {
        console.log(`      withdraw on the "Base" network from an exchange; Base is not Ethereum mainnet`);
      }
    } else {
      console.log(`    ${p.token} on ${p.net} (for example ${p.fund} ${p.token}):`);
      console.log(`      ${bCounter}`);
      console.log(`      from ${pair === "btc" ? FAUCET.sbtc : FAUCET.tltc}`);
      if (pair === "ltc") console.log(`      send to this tltc1 address only, never to an MWEB (tmweb1...) one`);
    }
    console.log(`    The ZEC you buy arrives in this ${ZEC_NET} wallet: ${bZec}`);
    console.log("");
  }
  console.log(`Both wallets of a pair are yours: until other people's makers are listed, a swap on this`);
  console.log(`node trades between them (sell ZEC from Z to B, or buy it back), which tests the whole path.`);
}

const data = await gather();
if (MODE === "ready") {
  for (const { z, b } of data) {
    for (const side of [z, b]) console.log(`${side.service} ${side.status ? "ok" : "down"}`);
  }
} else if (MODE === "addresses") {
  printAddresses(data);
} else {
  printStatus(data);
}
