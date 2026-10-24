// `node scripts/near-evm.mjs`: one NEAR Intents sell against real daemons. Shielded ZEC (mock Zcash)
// is sold for USDC by two real ferryd (infra/evm-demo.sh, anvil + FerryLock), and the USDC is paid
// straight into a 1Click deposit address (payout_to). NEAR Intents is mainnet only, so its part is
// the mock 1Click (mock/oneclick.mjs): this script reads the deposit address's USDC balance on
// anvil, and only once the real claim has landed there tells the mock about the deposit. The UI
// server is server/prod.mjs (needs `pnpm build`) with FERRY_NEAR=1 and FERRY_NEAR_TESTNET=1 (allowed
// against a loopback 1Click only).
//
// Start the EVM demo first, on ports of your choice, e.g.
//   ANVIL_PORT=7470 Z_PORT=7471 B_PORT=7472 Z_PEER_PORT=7473 B_PEER_PORT=7474 \
//     FERRY_EVM_DEMO_DIR=$PWD/../.demo-evm-near infra/evm-demo.sh up
// then FERRY_EVM_DEMO_DIR=... ANVIL_PORT=7470 node scripts/near-evm.mjs. Ports: 1Click base+3, UI
// server base+12 (SHOOT_PORT_BASE, default 7450).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { MOCK_ONE_CLICK_PUBKEY } from "../mock/oneclick.mjs";

const STATE = process.env.FERRY_EVM_DEMO_DIR ?? new URL("../../.demo-evm", import.meta.url).pathname;
const RPC = `http://127.0.0.1:${process.env.ANVIL_PORT ?? 18545}`;
const BASE_PORT = Number(process.env.SHOOT_PORT_BASE ?? 7450);
const NEAR = BASE_PORT + 3;
const UI = BASE_PORT + 12;
const SOL = "7dKbmvKfvwZjJ1Y2NYCQKsEXATBMVvUSSbYmdbHxQk5i";
const SOL_ID = "nep141:sol.omft.near";

// the demo's env file: export K=V lines
const demo = Object.fromEntries(
  readFileSync(`${STATE}/env`, "utf8")
    .split("\n")
    .map((l) => l.match(/^export ([A-Z_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const token = readFileSync(`${STATE}/token`, "utf8").trim();
const env = {
  ...process.env,
  ...demo,
  PORT: String(UI),
  HOST: "127.0.0.1",
  MOCK_NEAR_PORT: String(NEAR),
  // the demo's B makes offers on a local chain: the operator's entry says it stands for Base
  FERRY_MAKERS: JSON.stringify([{ name: "Bram", url: demo.FERRY_MAKER_URL, pair: "ZEC/USDC", chain: "base" }]),
  FERRY_NEAR_URL: `http://127.0.0.1:${NEAR}`,
  FERRY_NEAR_PUBKEY: MOCK_ONE_CLICK_PUBKEY,
  FERRY_NEAR: "1",
  FERRY_NEAR_TESTNET: "1",
  FERRY_NEAR_STATE: `${STATE}/near-jobs.json`,
  DEMO_MAX_ZAT: "100000000",
};
const procs = [spawn(process.execPath, ["mock/oneclick.mjs"], { env, stdio: "ignore" }), spawn(process.execPath, ["server/prod.mjs"], { env, stdio: "inherit" })];
const cleanup = () => procs.forEach((p) => p.kill("SIGTERM"));
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(1));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function up(url) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error("did not start: " + url);
}
const S = `http://127.0.0.1:${UI}`;
const ONE = `http://127.0.0.1:${NEAR}`;
await Promise.all([up(S + "/healthz"), up(ONE + "/v0/tokens")]);
const check = (cond, msg) => {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("ok:", msg);
};
const post = (base, path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const daemon = async (port, tokenValue, path) => (await fetch(`${port}${path}`, { headers: { authorization: `Bearer ${tokenValue}` } })).json();
// USDC at an address on anvil (balanceOf), as a BigInt
async function balanceOf(addr) {
  const data = "0x70a08231" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const r = await (await post(RPC, "", { jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: token, data }, "latest"] })).json();
  return BigInt(r.result);
}
async function until(pred, label, secs = 240) {
  for (let i = 0; i < secs * 4; i++) {
    const v = await (await fetch(`${S}/api/near/jobs`)).json();
    const j = v[0];
    if (j && pred(j)) return j;
    await sleep(250);
  }
  throw new Error("timed out waiting for " + label);
}

const status = await daemon(demo.FERRY_Z_URL, demo.FERRY_Z_TOKEN, "/api/status");
check(status.features?.includes("payout"), `the real Z ferryd lists the payout feature (${JSON.stringify(status.features)})`);
const info = await (await fetch(S + "/api/near/tokens")).json();
check(info.execution.sell === true, "the UI server runs NEAR sells here (a loopback 1Click, test networks allowed)");
const q = await (await post(S, "/api/near/quote", { direction: "sell", zec_zat: 50_000_000, asset: SOL_ID, address: SOL, exact: true })).json();
check(q.via === "usdc-base" && q.maker === "Bram" && q.near.verified, `a quote: shielded ZEC → USDC with Bram (real offer), then NEAR Intents (${q.error ?? q.near.amount_out})`);

const r = await post(S, "/api/near/swap", { direction: "sell", zec_zat: 50_000_000, asset: SOL_ID, address: SOL, via: q.via, min_out: q.near.min_amount_out });
const started = await r.json();
check(r.status === 201, `the NEAR sell started (${r.status} ${started.error ?? started.id})`);
const deposit = started.near.deposit_address;
const before = await balanceOf(deposit);
const view = await daemon(demo.FERRY_Z_URL, demo.FERRY_Z_TOKEN, `/api/swaps/${started.ferry.swap_id}`);
check(String(view.payout_to).toLowerCase() === deposit.toLowerCase(), `the real swap carries payout_to = 1Click's deposit address (${view.payout_to})`);
if (view.counter?.claimer) check(view.counter.claimer.toLowerCase() === deposit.toLowerCase(), "FerryLock's claimer is the deposit address");

const j = await until((x) => x.state === "near" || x.state === "failed", "the Ferry swap");
check(j.state === "near" && j.ferry.outcome === "swapped", "the Ferry swap finished");
const landed = (await balanceOf(deposit)) - before;
check(landed > 0n && landed >= BigInt(j.near.min_amount_in), `the claim paid ${landed} USDC units into the deposit address on anvil (1Click needs at least ${j.near.min_amount_in}; quoted ${j.near.amount_in})`);
// the real payout is the deposit the mock 1Click now sees
check((await post(ONE, "/_mock/deposit", { depositAddress: deposit, amount: landed.toString() })).ok, "the mock 1Click got the deposit");
const done = await until((x) => x.state === "done" || x.state === "refunded", "NEAR Intents' part", 60);
check(done.state === "done" && done.near.status === "SUCCESS", `done: NEAR Intents delivered ${done.near.details.amount_out} lamports to ${SOL}`);
console.log(JSON.stringify({ job: done.id, swap: done.ferry.swap_id, deposit, landed: landed.toString(), out: done.near.details.amount_out }, null, 1));
process.exit(0);
