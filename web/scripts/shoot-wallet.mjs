// `node scripts/shoot-wallet.mjs`: Ferry with your own wallets, at 1440 and 390, in light and dark,
// against the node mock (its Z sells ZEC, its B buys it, a mock router, and a node for USDC on Base
// Sepolia that only holds coins). On your own node (the Vite dev server):
//   - "Receive to" under the Buy panel: your Ferry node by default; your own wallet's address,
//     checked for its chain and network as you paste it (a mainnet address on a test node, a typo,
//     a transparent Zcash address), remembered per coin; then used: a sell pays the BTC there
//     (payout_to), a buy sweeps the ZEC there (sweep_to), a private swap's second swap pays there,
//     and each progress page says where the coins went;
//   - /wallet, from the swap card's "Add funds" and the account menu: each coin's balance (free and
//     in a swap), "Add funds" with the right address and QR payment link per coin (ZIP-321 zcash:,
//     BIP-21 bitcoin:, EIP-681 for USDC and ETH on Base Sepolia) and its network notes, and "Send to
//     my wallet": a send that goes through (form, check, sending, sent), one the node refuses (a
//     swap took the coins in between) and one the network drops, all in the list of sends;
//   - "Pay with MetaMask" in Add funds for USDC and ETH, against a fake browser wallet (EIP-1193,
//     announced with EIP-6963 as MetaMask) that records every request: no button without a wallet;
//     the swap card's shortfall as the amount; connect, then the switch to Base Sepolia (0x14a34);
//     its balance read (balanceOf) and too much refused; a cancel (4001) in plain words; the token
//     transfer sent to the token contract with exactly transfer(node, amount) as its data, and ETH
//     with value to the node; Sent from your wallet, confirmed, then Arrived in your node once the
//     node's balance rises (POST /api/_mock/credit); a reverted one; and the wallet's address in no
//     request to the Ferry server and not in localStorage (the page makes no other request at all).
// Then the production server (server/prod.mjs, needs `pnpm build` first): as a public demo (no
// FERRY_OWN_NODE) the card has no "Receive to" or "Add funds", /wallet only shows balances, and the
// server drops a browser's payout_to and sweep_to, refuses withdraw, withdrawals and addresses, and
// leaves the daemons' `event: withdrawal` messages out of their event streams (and the page never
// offers to pay from a browser wallet, nor talks to one); PUBLIC_ORIGIN stays
// one origin. With FERRY_OWN_NODE=1 it passes them for the node's own page only (a loopback Host, no
// other site's Origin; PUBLIC_ORIGIN's other loopback name, http://localhost:<port>, is the node's
// own page too).
// Screenshots go to screenshots/app/wallet/ (SHOOT_OUT=dir to put them elsewhere); SHOOT_THEME=light
// or dark takes one theme only.
//
// Ports (override with SHOOT_PORT_BASE, default 7600): mock Z base+41, B base+42, router base+43,
// USDC node base+44, Vite base+45, prod as a public demo base+46, prod on an own node base+47.
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { mockMakersEnv } from "../mock/makers.mjs";

const BASE = Number(process.env.SHOOT_PORT_BASE ?? 7600);
const [Z, B, ROUTER, USDC, VITE, PUB, OWN] = [41, 42, 43, 44, 45, 46, 47].map((n) => BASE + n);
const OUT = (process.env.SHOOT_OUT ?? new URL("../screenshots/app/wallet/", import.meta.url).pathname).replace(/\/?$/, "/");
const THEMES = process.env.SHOOT_THEME === "dark" ? ["dark"] : process.env.SHOOT_THEME === "light" ? ["light"] : ["light", "dark"];
mkdirSync(OUT, { recursive: true });

const env = {
  ...process.env,
  MOCK_SPEED: "6",
  MOCK_Z_PORT: String(Z),
  MOCK_B_PORT: String(B),
  MOCK_ROUTE_PORT: String(ROUTER),
  MOCK_ROUTE_PAUSE_SCALE: "0.01",
  MOCK_USDC_PORT: String(USDC),
  FERRY_Z_URL: `http://127.0.0.1:${Z}`,
  FERRY_B_URL: `http://127.0.0.1:${B}`,
  FERRY_ROUTER_URL: `http://127.0.0.1:${ROUTER}`,
  FERRY_USDC_BASE_B_URL: `http://127.0.0.1:${USDC}`,
  FERRY_MAKERS: mockMakersEnv(B, Z, { routes: true }),
  FERRY_Z_TOKEN: "",
  FERRY_B_TOKEN: "",
  FERRY_USDC_BASE_B_TOKEN: "",
  FERRY_NEAR_QUOTES: "0",
};
const prod = (port, extra) => ({ ...env, PORT: String(port), HOST: "127.0.0.1", DEMO_MAX_ZAT: "500000000", DEMO_RATE_PER_HOUR: "20", DEMO_SWAPS_PER_HOUR: "40", ...extra });
const procs = [
  spawn(process.execPath, ["mock/server.mjs"], { env, stdio: "ignore" }),
  spawn("pnpm", ["exec", "vite", "--port", String(VITE), "--strictPort"], { env: { ...env, PORT: String(VITE) }, stdio: "ignore" }),
  spawn(process.execPath, ["server/prod.mjs"], { env: prod(PUB, { PUBLIC_ORIGIN: `http://127.0.0.1:${PUB}` }), stdio: "ignore" }),
  spawn(process.execPath, ["server/prod.mjs"], { env: prod(OWN, { FERRY_OWN_NODE: "1", PUBLIC_ORIGIN: `http://127.0.0.1:${OWN}` }), stdio: "ignore" }),
];
const cleanup = () => procs.forEach((p) => p.kill("SIGTERM"));
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(1));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function up(url) {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error("did not start: " + url);
}
const DEV = `http://localhost:${VITE}`;
const PUBLIC = `http://127.0.0.1:${PUB}`;
const OWNED = `http://127.0.0.1:${OWN}`;
const MZ = `http://127.0.0.1:${Z}`;
const MB = `http://127.0.0.1:${B}`;
const MU = `http://127.0.0.1:${USDC}`;
const RT = `http://127.0.0.1:${ROUTER}`;
await Promise.all([up(DEV), up(PUBLIC + "/healthz"), up(OWNED + "/healthz"), up(MZ + "/api/status"), up(MU + "/api/status"), up(RT + "/api/status")]);

const check = (cond, msg) => {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("ok:", msg);
};
const post = (base, path, body, headers = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const json = async (url) => (await fetch(url)).json();
const reset = async () => {
  await post(MZ, "/api/_mock/reset", {});
  await post(RT, "/api/_mock/reset", {}).catch(() => {});
};
// every mock swap over, on both sides (the partner finishes a moment after you)
async function idle() {
  for (let i = 0; i < 600; i++) {
    const lists = await Promise.all([MZ, MB].map((u) => json(u + "/api/swaps")));
    if (lists.every((l) => l.every((s) => s.outcome))) return;
    await sleep(100);
  }
  throw new Error("timed out: swaps still running");
}
async function until(fn, label, tries = 1500) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(120);
  }
  throw new Error("timed out: " + label);
}

// a valid bech32 / bech32m string (BIP-173 / BIP-350), for addresses of the mock's networks
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i];
  }
  return chk >>> 0;
}
function bech(hrp, data, m) {
  const expand = [...[...hrp].map((x) => x.charCodeAt(0) >> 5), 0, ...[...hrp].map((x) => x.charCodeAt(0) & 31)];
  const mod = polymod([...expand, ...data, 0, 0, 0, 0, 0, 0]) ^ (m ? 0x2bc830a3 : 1);
  return hrp + "1" + [...data, ...[0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31)].map((d) => CHARSET[d]).join("");
}
// the person's own wallets: a regtest Bitcoin address (BIP-173's), a regtest unified address
const MY_BTC = "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080";
const MY_ZEC = bech("uregtest", Array.from({ length: 120 }, (_, i) => (i * 11 + 3) % 32), true);
const MY_ZEC2 = bech("uregtest", Array.from({ length: 120 }, (_, i) => (i * 5 + 1) % 32), true);
const MY_EVM = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
// the account in the person's browser wallet (MetaMask), which pays the node
const MY_METAMASK = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const short = (a) => `${a.slice(0, 8)}…${a.slice(-6)}`;

// A fake MetaMask for the page (page.addInitScript): an EIP-1193 provider announced with EIP-6963,
// recording every request in window.__eth.calls. It holds 40 USDC and 0.5 ETH, starts on Ethereum
// (0x1), and its knobs are window.__eth.reject (the person cancels the send: 4001) and .revert (the
// chain reverts it); a receipt shows from the second time it is asked.
function fakeMetaMask({ account, token, eth }) {
  const s = { calls: [], chain: "0x1", reject: false, revert: false, sent: [], token: BigInt(token), eth: BigInt(eth), on: {} };
  window.__eth = s;
  const fail = (code, message) => Object.assign(new Error(message), { code });
  const emit = (ev, v) => (s.on[ev] ?? []).forEach((f) => f(v));
  const provider = {
    isMetaMask: true,
    async request({ method, params }) {
      s.calls.push({ method, params: JSON.parse(JSON.stringify(params ?? null)) });
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [account];
        case "eth_chainId":
          return s.chain;
        case "wallet_switchEthereumChain":
          s.chain = params[0].chainId;
          emit("chainChanged", s.chain);
          return null;
        case "eth_call":
          if (params[0].data.startsWith("0x70a08231")) return "0x" + s.token.toString(16).padStart(64, "0");
          throw fail(-32000, "execution reverted");
        case "eth_getBalance":
          return "0x" + s.eth.toString(16);
        case "eth_sendTransaction": {
          if (s.reject) throw fail(4001, "MetaMask Tx Signature: User denied transaction signature.");
          const hash = "0x" + String(s.sent.length + 1).padStart(64, "ab");
          s.sent.push({ hash, tx: params[0], asked: 0, revert: s.revert });
          return hash;
        }
        case "eth_getTransactionReceipt": {
          const x = s.sent.find((y) => y.hash === params[0]);
          if (!x || ++x.asked < 2) return null;
          return { transactionHash: x.hash, blockNumber: "0x10", status: x.revert ? "0x0" : "0x1" };
        }
        default:
          throw fail(4200, `unsupported: ${method}`);
      }
    },
    on: (ev, f) => (s.on[ev] ??= []).push(f),
    removeListener: (ev, f) => (s.on[ev] = (s.on[ev] ?? []).filter((g) => g !== f)),
  };
  // a plain test icon (not MetaMask's logo), as the data: URI a wallet announces
  const icon = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#3f3f46"/><path d="M8 23V9l8 8 8-8v14" fill="none" stroke="#fff" stroke-width="3" stroke-linejoin="round"/></svg>');
  const info = Object.freeze({ uuid: "6f1c1a52-3d0e-4c39-9d7e-2f4a0c5b8e11", name: "MetaMask", icon, rdns: "io.metamask" });
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
}
const word = (hex) => hex.toLowerCase().padStart(64, "0");

const browser = await chromium.launch();
const shots = [];
// on a failure, what every open page showed: OUT/failed-<width>.png
const open = new Set();
process.on("uncaughtException", async (e) => {
  console.error(e);
  for (const p of open) await p.screenshot({ path: `${OUT}failed-${p.viewportSize().width}.png` }).catch(() => {});
  process.exit(1);
});

for (const theme of THEMES) {
  const page = async (width) => {
    const p = await browser.newPage({ viewport: { width, height: width < 500 ? 844 : 900 }, colorScheme: theme });
    p.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && console.log(`[${width} ${theme}]`, m.text()));
    p.on("pageerror", (e) => console.log(`[${width} ${theme}] page error:`, e.message));
    p.on("close", () => open.delete(p));
    open.add(p);
    return p;
  };
  const pages = [await page(1440), await page(390)];
  const [desk, phone] = pages;
  const each = (fn) => Promise.all(pages.map(fn));
  const text = (p, s, timeout = 20_000) => p.waitForFunction((s) => document.body.innerText.includes(s), s, { timeout });
  const shoot = async (name, { settle = 600, on = pages } = {}) => {
    await sleep(settle);
    for (const p of on) {
      const w = p.viewportSize().width;
      const path = `${OUT}${name}-${w}${theme === "dark" ? "-dark" : ""}.png`;
      await p.screenshot({ path });
      shots.push(path);
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(overflow <= 0, `${name} at ${w} (${theme}): no horizontal scroll (${overflow}px)`);
    }
  };
  const t = (s) => `${s} (${theme})`;

  // ---------------------------------------------------------------------------- Receive to
  await reset();
  await each((p) => p.goto(DEV + "/app"));
  await each((p) => text(p, "from Kestrel"));
  const row = (p) => p.locator("[data-receive-to]");
  check((await row(desk).innerText()).replace(/\s+/g, " ").includes("Receive to Your Ferry node"), t("selling ZEC, a quiet Receive to row under the Buy panel says Your Ferry node"));
  check((await desk.locator("[data-add-funds]").count()) === 1 && (await desk.locator("[data-add-funds]").innerText()) === "Add funds", t("the Sell panel says You have 5.00 ZEC · Add funds"));
  await each((p) => p.getByRole("button", { name: /^Receive to: your Ferry node/ }).click());
  await each((p) => p.getByRole("dialog", { name: "Where should the BTC go?" }).waitFor());
  await each((p) => p.getByRole("radio", { name: /Your own wallet/ }).click());
  const field = (p) => p.getByLabel("Your Bitcoin address");
  // a mainnet address on a test node, a typo, then the right one
  await each((p) => field(p).fill("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"));
  await each((p) => field(p).blur());
  await each((p) => text(p, "That's a Bitcoin address for another network"));
  check(true, t("a mainnet address on this test node: another network, in plain words"));
  await shoot("01-receive-wrong-network");
  await each((p) => field(p).fill(MY_BTC.slice(0, -1) + "1"));
  await each((p) => text(p, "That address has a typo"));
  check(true, t("one character off: That address has a typo"));
  await each((p) => field(p).fill(MY_BTC));
  await each((p) => text(p, "An address on Bitcoin local test network."));
  await shoot("02-receive-own-wallet");
  await each((p) => p.getByRole("button", { name: "Done" }).click());
  await each((p) => p.locator("[data-receive-address]").waitFor());
  check((await desk.locator("[data-receive-address]").innerText()) === short(MY_BTC), t(`the row now shows the wallet: ${short(MY_BTC)}`));
  await desk.reload();
  await desk.locator("[data-receive-address]").waitFor();
  check(true, t("remembered for BTC after a reload"));
  await shoot("03-card-receive-set");

  // a sell pays the BTC to that wallet (payout_to)
  await desk.locator('input[aria-label="ZEC to sell"]').fill("0.50");
  await text(desk, "from Kestrel");
  await desk.locator("form button[type=submit]").click();
  await desk.waitForURL(/\/app\/swap\//);
  const sellId = desk.url().split("/").pop();
  const z0 = await json(`${MZ}/api/swaps/${sellId}`);
  check(z0.role === "Z" && z0.payout_to === MY_BTC, t(`the sell reached Z with payout_to = your wallet (${z0.payout_to})`));
  await phone.goto(`${DEV}/app/swap/${sellId}`);
  await each((p) => text(p, `To your wallet ${short(MY_BTC)}`));
  check(true, t("in progress: To your wallet …"));
  await shoot("04-sell-to-wallet-progress");
  await until(async () => (await json(`${MZ}/api/swaps/${sellId}`)).outcome === "swapped", "sell done");
  await each((p) => text(p, `It went to your wallet ${short(MY_BTC)}`));
  check((await json(MZ + "/api/status")).balances.btc_sat === 0, t("the node's own BTC didn't move: it went to your wallet"));
  await shoot("05-sell-paid-to-wallet");
  await idle();

  // a buy sweeps the ZEC to your own shielded wallet (sweep_to)
  await each((p) => p.goto(DEV + "/app"));
  await each((p) => p.getByRole("button", { name: "Switch direction" }).click());
  await each((p) => p.locator('input[aria-label="ZEC to buy"]').waitFor());
  await each((p) => p.getByRole("button", { name: /^Receive to: your Ferry node/ }).click());
  await each((p) => p.getByRole("radio", { name: /Your own wallet/ }).click());
  const zfield = (p) => p.getByLabel("Your shielded ZEC address");
  await each((p) => zfield(p).fill("tmJ1xYxP8XNTtCoDgvdmQPSrxh5qZJgy65Z"));
  await each((p) => zfield(p).blur());
  await each((p) => text(p, "That's a transparent Zcash address"));
  await each((p) => text(p, "the kind Zodl marks “Not Private”"));
  check(true, t("a transparent Zcash address is refused: shielded only, in Zodl's words"));
  await shoot("06-receive-zec-transparent");
  await each((p) => zfield(p).fill(MY_ZEC));
  await each((p) => p.getByRole("button", { name: "Done" }).click());
  await desk.locator('input[aria-label="ZEC to buy"]').fill("0.50");
  await text(desk, "from Sandpiper");
  // (B, the mock's maker for the sell above, got that swap's ZEC)
  const bZec = (await json(MB + "/api/status")).balances.zec_shielded_zat;
  await desk.locator("form button[type=submit]").click();
  await desk.waitForURL(/\/app\/swap\//);
  const buyId = desk.url().split("/").pop();
  check((await json(`${MB}/api/swaps/${buyId}`)).sweep_to === MY_ZEC, t("the buy reached B with sweep_to = your shielded wallet"));
  await phone.goto(`${DEV}/app/swap/${buyId}`);
  await until(async () => (await json(`${MB}/api/swaps/${buyId}`)).outcome === "swapped", "buy done");
  await each((p) => text(p, `It went to your own wallet ${short(MY_ZEC)}, shielded`));
  check((await json(MB + "/api/status")).balances.zec_shielded_zat === bZec, t("the node's B wallet got no ZEC from the buy: it was swept to yours"));
  await shoot("07-buy-swept-to-wallet");
  await idle();

  // a private swap's second swap pays your wallet (the route's payout_to)
  await each((p) => p.goto(DEV + "/app?sell=usdc-base&buy=btc"));
  await each((p) => p.getByRole("button", { name: "Swap privately" }).waitFor());
  await each((p) => p.locator("[data-receive-address]").waitFor());
  check(true, t("a private swap ending in BTC offers the same remembered wallet"));
  await desk.getByRole("button", { name: "Swap privately" }).click();
  const dialog = desk.getByRole("dialog", { name: "Swap privately" });
  await text(desk, `The BTC goes to your wallet ${short(MY_BTC)}`);
  await dialog.getByRole("button", { name: "Start private swap" }).click();
  await desk.waitForURL(/\/app\/route\/r[0-9a-f]+$/);
  const routeId = desk.url().split("/").pop();
  check((await json(`${RT}/api/routes/${routeId}`)).payout_to === MY_BTC, t("the router got payout_to = your wallet"));
  await phone.goto(`${DEV}/app/route/${routeId}`);
  await until(async () => (await json(`${RT}/api/routes/${routeId}`)).state === "done", "route done", 3000);
  await each((p) => text(p, `It went to your wallet ${short(MY_BTC)}`));
  check(true, t("the private swap's page says where the BTC went"));
  await shoot("08-route-paid-to-wallet");
  await idle();

  // ---------------------------------------------------------------------------- Wallet: add funds
  await post(MZ, "/api/_mock/balances", {});
  await each((p) => p.goto(DEV + "/app"));
  await each((p) => p.getByRole("button", { name: "Switch direction" }).click().catch(() => {}));
  await each((p) => p.locator('input[aria-label="ZEC to sell"]').waitFor());
  await desk.locator("[data-add-funds]").click();
  await desk.waitForURL(/\/wallet\?add=zec$/);
  check(true, t("the swap card's Add funds opens /wallet?add=zec"));
  await phone.goto(DEV + "/wallet?add=zec");
  const zaddr = (await json(MZ + "/api/addresses")).zec.address;
  await each((p) => p.locator(`[data-qr="zcash:${zaddr}"] svg`).waitFor());
  check((await desk.locator("[data-address]").innerText()) === zaddr, t(`Add ZEC shows the selling side's shielded address and a ZIP-321 code (zcash:${zaddr})`));
  await each((p) => text(p, "Works with Zodl: scan this code"));
  await each((p) => text(p, "transparent ZEC (from a t… address) can't be used here"));
  check(true, t("Add ZEC says it works with Zodl, and that transparent ZEC can't be used"));
  await shoot("09-add-zec");
  const addSheet = async (key, uri, address, note, name) => {
    await each((p) => p.goto(`${DEV}/wallet?add=${key}`));
    await each((p) => p.locator(`[data-qr="${uri}"] svg`).waitFor());
    check((await desk.locator("[data-address]").innerText()) === address, t(`Add ${key}: ${uri}`));
    await each((p) => text(p, note));
    if (name) await shoot(name);
  };
  const baddr = (await json(MB + "/api/addresses")).btc.address;
  await addSheet("btc", `bitcoin:${baddr}`, baddr, "Send BTC on the Bitcoin local test network only", "10-add-btc");
  // the node's funding address is stable; a new one per deposit on request (?fresh=1)
  await desk.locator("[data-fresh-address]").click();
  await desk.waitForFunction((a) => document.querySelector("[data-address]")?.textContent !== a, baddr);
  const fresh = await desk.locator("[data-address]").innerText();
  check(/^bcrt1q/.test(fresh) && fresh !== baddr && (await desk.locator(`[data-qr="bitcoin:${fresh}"]`).count()) === 1, t(`Use a new address: a fresh one, and its code (${fresh})`));
  const u = await json(MU + "/api/addresses");
  await addSheet("usdc-base", `ethereum:${u.btc.token}@84532/transfer?address=${u.btc.address}`, u.btc.address, "USDC on Base Sepolia — not Ethereum", "11-add-usdc");
  await addSheet("eth:base-sepolia", `ethereum:${u.btc.address}@84532`, u.btc.address, "ETH on Base Sepolia — not Ethereum, to pay for gas");

  // ---------------------------------------------------------------------------- Wallet: balances
  await each((p) => p.goto(DEV + "/wallet"));
  await each((p) => p.locator('[data-coin="zec"] [data-balance]').waitFor());
  const zecCard = async () => (await desk.locator('[data-coin="zec"]').innerText()).replace(/\s+/g, " ");
  // (each side of the node answers in its own time)
  await until(async () => (await zecCard()).includes("5.30 ZEC"), "both sides' ZEC on the card", 200).catch(() => {});
  check((await zecCard()).includes("5.30 ZEC"), t(`Shielded ZEC: Z's 5.00 and the USDC node's 0.30 (${await zecCard()})`));
  await shoot("12-wallet");
  // the account menu leads here too
  await desk.getByRole("button", { name: /^Your Ferry node/ }).click();
  check((await desk.getByRole("link", { name: "Wallet" }).count()) === 1, t("the account menu has Wallet"));
  await desk.keyboard.press("Escape");
  // a swap holds some: free and in a swap
  const held = await (await post(MZ, "/api/swaps", { maker: `http://127.0.0.1:${B}`, zec_zat: 100_000_000 })).json();
  check(!!held.id, t("a 1 ZEC sell starts on Z, so a swap holds some ZEC"));
  await until(async () => (await zecCard()).includes("in a swap"), "free / in a swap");
  check((await zecCard()).includes("4.30 free · 1.00 in a swap"), t(`while it runs: ${await zecCard()}`));
  await shoot("13-wallet-in-a-swap");
  await idle();

  // ---------------------------------------------------------------------------- Wallet: send
  await post(MZ, "/api/_mock/balances", {});
  await each((p) => p.goto(DEV + "/wallet?send=zec"));
  await each((p) => p.getByLabel("ZEC to send").waitFor());
  // two sides hold ZEC (Z and the USDC node): the one with the most free comes first
  check((await desk.getByRole("radiogroup", { name: "Send from" }).getByRole("radio", { checked: true }).innerText()).includes("Selling ZEC for BTC"), t("sending ZEC starts from the side with the most free"));
  await each((p) => p.getByLabel("ZEC to send").fill("0.50"));
  await each((p) => p.getByPlaceholder("Your Zodl or other shielded address (u…)").fill("t1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU"));
  await each((p) => p.getByPlaceholder("Your Zodl or other shielded address (u…)").blur());
  await each((p) => text(p, "That's a transparent Zcash address"));
  check(true, t("send: a transparent address is refused before anything leaves"));
  // your remembered wallet, one tap away
  await each((p) => p.getByRole("button", { name: /Use your wallet/ }).click());
  check((await desk.getByPlaceholder("Your Zodl or other shielded address (u…)").inputValue()) === MY_ZEC, t("send: Use your wallet fills the address remembered for ZEC"));
  await each((p) => p.getByPlaceholder("Your Zodl or other shielded address (u…)").fill(MY_ZEC2));
  await each((p) => text(p, "0.0001 ZEC"));
  check(true, t("send: the node previews the network fee (0.0001 ZEC)"));
  await shoot("14-send-form");
  await each((p) => p.getByRole("button", { name: "Review" }).click());
  await each((p) => p.locator("[data-review-to]").waitFor());
  check((await desk.locator("[data-review-to]").innerText()) === MY_ZEC2, t("check and send: the whole address, to compare with your wallet"));
  await shoot("15-send-review");
  const before = (await json(MZ + "/api/status")).balances.zec_shielded_zat;
  await each((p) => p.getByRole("button", { name: "Send 0.50 ZEC" }).click());
  // "sending" can be over before a page looks (the mock is quick): either state will do here
  await each((p) => p.locator('[data-sent-state="sending"], [data-sent-state="sent"]').first().waitFor());
  await shoot("16-send-sending", { settle: 200 });
  await each((p) => p.locator('[data-sent-state="sent"]').waitFor({ timeout: 20_000 }));
  const sent = (await json(MZ + "/api/withdrawals")).filter((x) => x.to === MY_ZEC2);
  check(sent.length === 2 && sent.every((x) => x.asset === "zec" && x.amount === "50000000" && x.fee === "10000" && x.fee_coin === "zec" && x.status === "confirmed"), t("two sends of 0.50 ZEC (one per page), confirmed"));
  check(before - (await json(MZ + "/api/status")).balances.zec_shielded_zat === 2 * (50_000_000 + 10_000), t("Z's ZEC went down by the sends and their fees"));
  await shoot("17-send-sent");
  await each((p) => p.getByRole("button", { name: "Done" }).click());

  // refused: a swap takes the coins between the form and the send
  await each((p) => p.goto(DEV + "/wallet?send=zec"));
  await each((p) => p.getByLabel("ZEC to send").fill("1.00"));
  await each((p) => p.getByPlaceholder("Your Zodl or other shielded address (u…)").fill(MY_ZEC2));
  await each((p) => p.getByRole("button", { name: "Review" }).click());
  const grab = await (await post(MZ, "/api/swaps", { maker: `http://127.0.0.1:${B}`, zec_zat: 380_000_000 })).json();
  check(!!grab.id, t("meanwhile a 3.8 ZEC swap starts on Z"));
  await each((p) => p.getByRole("button", { name: "Send 1.00 ZEC" }).click());
  await each((p) => p.locator("[data-send-error]").waitFor());
  const refusal = await desk.locator("[data-send-error]").innerText();
  check(/doesn't have that much ZEC free/.test(refusal) && /held for a swap/.test(refusal), t(`the node refuses, in plain words: ${refusal}`));
  await shoot("18-send-refused");
  await idle();

  // dropped by the network after it was sent: failed, the coins back
  await post(MZ, "/api/_mock/balances", {});
  await post(MZ, "/api/_mock/fail-next-withdraw", {});
  await desk.goto(DEV + "/wallet?send=zec");
  await desk.getByLabel("ZEC to send").fill("0.25");
  await desk.getByPlaceholder("Your Zodl or other shielded address (u…)").fill(MY_ZEC2);
  await desk.getByRole("button", { name: "Review" }).click();
  await desk.getByRole("button", { name: "Send 0.25 ZEC" }).click();
  await desk.locator('[data-sent-state="failed"]').waitFor({ timeout: 20_000 });
  check(/dropped the transaction/.test(await desk.locator('[data-sent-state="failed"]').innerText()), t("a send the network drops: It didn't go through, in the node's words"));
  check((await json(MZ + "/api/status")).balances.zec_shielded_zat === 500_000_000, t("its coins are back"));
  await phone.goto(DEV + "/wallet");
  await desk.getByRole("button", { name: "Done" }).click();
  await each((p) => p.locator('[data-send-row="failed"]').waitFor());
  const rows = await desk.locator("[data-send-row]").evaluateAll((els) => els.map((e) => e.getAttribute("data-send-row")));
  check(rows[0] === "failed" && rows.filter((r) => r === "sent").length === 2, t(`Sent from your node: newest first, failed then the two sent (${rows})`));
  await each((p) => p.locator("[data-sends]").scrollIntoViewIfNeeded());
  await shoot("19-wallet-sends");

  // a token: USDC to an EVM address, gas from ETH
  await each((p) => p.goto(DEV + "/wallet?send=usdc-base"));
  await each((p) => p.getByLabel("USDC to send").waitFor());
  await each((p) => p.getByPlaceholder("0x…").fill("0x036CbD53842c5426634e7929541eC2318f3dCF7e"));
  await each((p) => p.getByPlaceholder("0x…").blur());
  await each((p) => text(p, "That's a contract of this swap"));
  check(true, t("send USDC: the token contract itself is refused"));
  await each((p) => p.getByPlaceholder("0x…").fill(MY_EVM));
  await each((p) => p.getByLabel("USDC to send").fill("25"));
  await each((p) => text(p, "0.000065 ETH, for gas"));
  check(true, t("send USDC: the fee is gas, in ETH"));
  await shoot("20-send-usdc");

  // ---------------------------------------------------------------------------- Wallet: Pay with MetaMask
  // no browser wallet in these pages: the QR code only
  await each((p) => p.goto(`${DEV}/wallet?add=usdc-base`));
  await each((p) => p.locator('[data-qr^="ethereum:"] svg').waitFor());
  await sleep(800);
  check((await desk.locator("[data-pay-wallet]").count()) + (await phone.locator("[data-pay-wallet]").count()) === 0, t("no browser wallet: Add USDC has the QR code and no Pay with button"));
  for (const p of pages) await p.close();

  // the same, with MetaMask in the browser
  const ferryCalls = [];
  const elsewhere = [];
  const walletPage = async (width) => {
    const p = await page(width);
    await p.addInitScript(fakeMetaMask, { account: MY_METAMASK, token: "40000000", eth: "500000000000000000" });
    p.on("request", (r) => (r.url().startsWith(DEV + "/") ? ferryCalls.push(`${r.method()} ${r.url()} ${r.postData() ?? ""}`) : r.url().startsWith("data:") ? null : elsewhere.push(r.url())));
    return p;
  };
  const mm = [await walletPage(1440), await walletPage(390)];
  const [mdesk] = mm;
  const all = (fn) => Promise.all(mm.map(fn));
  const calls = (p, method) => p.evaluate((m) => window.__eth.calls.filter((c) => c.method === m), method);
  const sentTxs = (p) => p.evaluate(() => window.__eth.sent.map((x) => x.tx));
  // buying ZEC with more USDC than the node holds: the card's Add funds says by how much (?need=)
  await mdesk.goto(`${DEV}/app?sell=usdc-base&buy=zec`);
  await mdesk.locator('input[aria-label="ZEC to buy"]').fill("5");
  await text(mdesk, "and this costs");
  const [, have, cost] = (await mdesk.locator("#swap-message").innerText()).match(/You have ([\d.]+) USDC, and this costs ([\d.]+) USDC/) ?? [];
  const needHref = (await mdesk.locator("[data-add-funds]").getAttribute("href")) ?? "";
  const needUnits = Number(new URL(needHref, DEV).searchParams.get("need"));
  check(new URL(needHref, DEV).searchParams.get("add") === "usdc-base" && Math.abs(needUnits / 1e6 - (Number(cost) - Number(have))) < 0.01, t(`the swap card, ${have} USDC for ${cost}: Add funds carries the shortfall (${needHref})`));
  // the swap card was 12.50 USDC short (?need, in base units)
  await all((p) => p.goto(`${DEV}/wallet?add=usdc-base&need=12500000`));
  await all((p) => p.locator('[data-pay-wallet="MetaMask"]').waitFor());
  check((await mdesk.locator("[data-pay-wallet]").innerText()) === "Pay with MetaMask" && (await mdesk.locator('[data-pay-wallet] img[src^="data:image/svg+xml"]').count()) === 1, t("Add USDC: Pay with MetaMask, under the QR code, with the icon MetaMask announced"));
  check((await calls(mdesk, "eth_requestAccounts")).length === 0, t("nothing asks the wallet until the person clicks"));
  await shoot("22-add-usdc-metamask", { on: mm });
  await all((p) => p.locator("[data-pay-wallet]").click());
  await all((p) => p.locator("[data-wallet-balance]", { hasText: "40.00 USDC in MetaMask" }).waitFor());
  check((await calls(mdesk, "eth_requestAccounts")).length === 1, t("Pay with MetaMask: eth_requestAccounts, once"));
  const switches = await calls(mdesk, "wallet_switchEthereumChain");
  check(switches.length === 1 && switches[0].params[0].chainId === "0x14a34", t(`the wallet is switched to Base Sepolia: wallet_switchEthereumChain ${JSON.stringify(switches[0]?.params)}`));
  const reads = await calls(mdesk, "eth_call");
  check(reads.some((c) => c.params[0].to.toLowerCase() === u.btc.token.toLowerCase() && c.params[0].data === "0x70a08231" + word(MY_METAMASK.slice(2))), t("its USDC is read with balanceOf(account) on the token"));
  check((await mdesk.getByLabel("USDC to add").inputValue()) === "12.5", t("the amount starts at the swap card's shortfall: 12.5 USDC"));
  check((await mdesk.locator("[data-pay-to]").innerText()) === u.btc.address, t("the review shows the node's whole address"));
  check((await mdesk.locator("[data-pay-privacy]").innerText()) === "Ferry doesn't keep your MetaMask address. The transfer is public on Base Sepolia, like any USDC payment.", t("one line on privacy"));
  await shoot("23-pay-usdc-form", { on: mm });
  // more than the wallet has
  await all((p) => p.getByLabel("USDC to add").fill("50"));
  await all((p) => text(p, "MetaMask has 40.00 USDC on Base Sepolia."));
  check(await mdesk.locator("[data-pay-submit]").isDisabled(), t("more than MetaMask holds: said plainly, and Send waits"));
  // cancelled in the wallet
  await all((p) => p.getByLabel("USDC to add").fill("12.5"));
  await all((p) => p.evaluate(() => (window.__eth.reject = true)));
  await all((p) => p.getByRole("button", { name: "Send 12.50 USDC" }).click());
  await all((p) => p.locator("[data-pay-error]").waitFor());
  check((await mdesk.locator("[data-pay-error]").innerText()) === "You cancelled in MetaMask. Nothing was sent.", t("a cancel in MetaMask (4001): You cancelled in MetaMask. Nothing was sent."));
  await shoot("24-pay-cancelled", { on: mm });
  // sent
  await all((p) => p.evaluate(() => (window.__eth.reject = false)));
  const callsBefore = ferryCalls.length;
  await all((p) => p.getByRole("button", { name: "Send 12.50 USDC" }).click());
  await all((p) => p.locator('[data-pay-state="pending"], [data-pay-state="confirmed"]').first().waitFor());
  check(ferryCalls.slice(callsBefore).some((c) => c.startsWith(`GET ${DEV}/daemon/b-usdc-base/api/addresses`)), t("the node's address is fetched again right before sending"));
  const [tx] = await sentTxs(mdesk);
  const data = "0xa9059cbb" + word(u.btc.address.slice(2)) + word((12_500_000).toString(16));
  check(tx.from === MY_METAMASK && tx.to.toLowerCase() === u.btc.token.toLowerCase() && tx.data === data && !("value" in tx) && !("gas" in tx), t(`the transfer goes to the token contract with data ${tx.data}`));
  check(tx.data.length === 2 + 8 + 128 && tx.data.slice(34, 74) === u.btc.address.slice(2).toLowerCase(), t("the node's address is inside the call, never the recipient"));
  await all((p) => text(p, "Sent from your wallet"));
  const hash = (await mdesk.evaluate(() => window.__eth.sent[0].hash));
  check((await mdesk.locator("[data-pay-explorer]").getAttribute("href")) === `https://sepolia.basescan.org/tx/${hash}`, t("Sent from your wallet: the hash, and a link to Basescan"));
  await shoot("25-pay-sent", { on: mm, settle: 200 });
  await all((p) => p.locator('[data-pay-state="confirmed"]').waitFor());
  await all((p) => text(p, "Confirmed on Base Sepolia"));
  check(true, t("the wallet's receipt (eth_getTransactionReceipt, status 0x1): confirmed, waiting for the node"));
  check((await post(MU, "/api/_mock/credit", { asset: "token", amount: "25000000" })).ok, t("the two transfers land in the node's account"));
  await all((p) => p.locator('[data-pay-state="arrived"]').waitFor({ timeout: 20_000 }));
  await all((p) => text(p, "Arrived in your node"));
  check(true, t("Arrived in your node, once its USDC goes up"));
  await shoot("26-pay-arrived", { on: mm });

  // ETH for gas: value to the node's account
  await all((p) => p.goto(`${DEV}/wallet?add=eth:base-sepolia`));
  await all((p) => p.locator('[data-pay-wallet="MetaMask"]').waitFor());
  check(true, t("Add ETH: Pay with MetaMask too"));
  await all((p) => p.locator("[data-pay-wallet]").click());
  await all((p) => p.locator("[data-wallet-balance]", { hasText: "0.50 ETH in MetaMask" }).waitFor());
  check((await mdesk.getByLabel("ETH to add").inputValue()) === "", t("no shortfall for gas: the amount starts empty"));
  await all((p) => p.getByLabel("ETH to add").fill("0.01"));
  await all((p) => p.getByRole("button", { name: "Send 0.01 ETH" }).click());
  await all((p) => p.locator('[data-pay-state="pending"], [data-pay-state="confirmed"]').first().waitFor());
  const [ethTx] = await sentTxs(mdesk);
  check(ethTx.from === MY_METAMASK && ethTx.to === u.btc.address && ethTx.value === "0x2386f26fc10000" && !("data" in ethTx), t(`ETH goes to the node's account with value ${ethTx.value} (0.01 ETH)`));
  await post(MU, "/api/_mock/credit", { asset: "eth", amount: "20000000000000000" });
  await all((p) => p.locator('[data-pay-state="arrived"]').waitFor({ timeout: 20_000 }));
  check(true, t("Arrived in your node, once its ETH goes up"));

  // reverted on the chain
  await all((p) => p.goto(`${DEV}/wallet?add=usdc-base`));
  await all((p) => p.locator("[data-pay-wallet]").click());
  await all((p) => p.locator("[data-wallet-balance]", { hasText: "in MetaMask" }).waitFor());
  check((await mdesk.getByLabel("USDC to add").inputValue()) === "", t("opened from the Wallet page: the amount starts empty"));
  await all((p) => p.evaluate(() => (window.__eth.revert = true)));
  await all((p) => p.getByLabel("USDC to add").fill("5"));
  await all((p) => p.getByRole("button", { name: "Send 5.00 USDC" }).click());
  await all((p) => p.locator('[data-pay-state="reverted"]').waitFor({ timeout: 20_000 }));
  await all((p) => text(p, "It didn't go through"));
  check(true, t("a reverted transfer (receipt status 0x0): It didn't go through"));
  await shoot("27-pay-reverted", { on: mm });

  // the wallet's address went nowhere but the wallet
  const mine = MY_METAMASK.slice(2).toLowerCase();
  check(ferryCalls.length > 0 && ferryCalls.every((c) => !c.toLowerCase().includes(mine)), t(`the MetaMask address is in none of the ${ferryCalls.length} requests to the Ferry server`));
  check(elsewhere.length === 0, t(`the page made no request anywhere else (${elsewhere.join(", ")})`));
  for (const p of mm) check(!(await p.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).toLowerCase().includes(mine), t(`nor in localStorage (${p.viewportSize().width})`));
  for (const p of mm) await p.close();

  // ---------------------------------------------------------------------------- the public demo
  await reset();
  const demo = [await page(1440), await page(390)];
  const both = (fn) => Promise.all(demo.map(fn));
  await both((p) => p.goto(PUBLIC + "/app"));
  await both((p) => text(p, "from Kestrel"));
  await sleep(800);
  check((await demo[0].locator("[data-receive-to]").count()) === 0 && (await demo[0].locator("[data-add-funds]").count()) === 0, t("public demo: no Receive to, no Add funds on the card"));
  await both((p) => p.goto(PUBLIC + "/wallet"));
  await both((p) => p.locator("[data-demo-note]").waitFor());
  await both((p) => p.locator('[data-coin="zec"] [data-balance]').waitFor());
  check((await demo[0].getByRole("button", { name: /Add funds|Send to my wallet/ }).count()) === 0, t("public demo: /wallet shows balances and a note, no Add funds or Send"));
  for (const p of demo) {
    const w = p.viewportSize().width;
    const path = `${OUT}21-public-demo-wallet-${w}${theme === "dark" ? "-dark" : ""}.png`;
    await sleep(500);
    await p.screenshot({ path });
    shots.push(path);
  }
  for (const p of demo) await p.close();
  // with MetaMask in the browser too: no Add funds, so no Pay with, and the wallet is never asked
  const pub = await page(1440);
  await pub.addInitScript(fakeMetaMask, { account: MY_METAMASK, token: "40000000", eth: "500000000000000000" });
  await pub.goto(PUBLIC + "/wallet?add=usdc-base");
  await pub.locator('[data-coin="usdc-base"] [data-balance]').waitFor();
  await sleep(800);
  check((await pub.locator("[data-pay-wallet], [data-add-funds-sheet]").count()) === 0 && (await pub.evaluate(() => window.__eth.calls.length)) === 0, t("public demo with MetaMask in the browser: no Add funds sheet, no Pay with MetaMask, nothing asked of the wallet"));
  await pub.close();
}
await browser.close();

// ------------------------------------------------------------------------------ the servers' gate
// a raw request with any Host header (fetch won't send another)
const raw = (port, method, path, { host, origin, body } = {}) =>
  new Promise((ok, fail) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { host: host ?? `127.0.0.1:${port}`, ...(origin ? { origin } : {}), ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}) } }, (res) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = JSON.parse(s);
        } catch {}
        ok({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", fail);
    req.end(data ?? undefined);
  });
await reset();
const send = { asset: "zec", amount: 10_000_000, to: MY_ZEC2 };

// the public demo
check((await json(PUBLIC + "/api/pairs")).node.own === false, "public demo: /api/pairs says node.own false");
let r = await raw(PUB, "POST", "/daemon/z/api/withdraw", { body: send });
check(r.status === 403, `public demo: POST withdraw is refused (${r.status} ${r.body?.error})`);
for (const p of ["/daemon/z/api/withdrawals", "/daemon/z/api/addresses", "/daemon/b-usdc-base/api/addresses"]) check((await raw(PUB, "GET", p)).status === 403, `public demo: GET ${p} is refused`);
check((await json(MZ + "/api/withdrawals")).length === 0, "public demo: nothing was sent");
let s = await (await post(PUBLIC, "/daemon/z/api/swaps", { maker: "Kestrel", zec_zat: 50_000_000, payout_to: MY_BTC })).json();
check(!!s.id && !(await json(`${MZ}/api/swaps/${s.id}`)).payout_to, "public demo: a sell's payout_to is dropped (the operator's daemon pays its own wallet)");
await idle();
s = await (await post(PUBLIC, "/daemon/b/api/swaps", { maker: "Sandpiper", zec_zat: 50_000_000, sweep_to: MY_ZEC })).json();
check(!!s.id && !(await json(`${MB}/api/swaps/${s.id}`)).sweep_to, "public demo: a buy's sweep_to is dropped");
await idle();
r = await raw(PUB, "POST", "/daemon/z/api/swaps", { body: { maker: "Kestrel", zec_zat: 50_000_000 }, host: `localhost:${PUB}`, origin: `http://localhost:${PUB}` });
check(r.status === 403, `public demo: PUBLIC_ORIGIN stays one origin, so its other loopback name is refused (${r.status} ${r.body?.error})`);
const route = { from: "usdc-base", to: "btc", zec_zat: 50_000_000, maker1: "Godwit", max_in: 25_000_000, min_out: 150_000, pause: "off", payout_to: MY_BTC };
r = await raw(PUB, "POST", "/router/api/routes", { body: route });
check(r.status === 201 && !(await json(`${RT}/api/routes/${r.body.id}`)).payout_to, `public demo: a private swap's payout_to is dropped (${r.status} ${r.body?.error ?? ""})`);
await until(async () => ["done", "holding", "failed"].includes((await json(`${RT}/api/routes/${r.body.id}`)).state), "the demo route", 3000);
await idle();

// the own node
const own = OWN;
check((await json(OWNED + "/api/pairs")).node.own === true, "own node: /api/pairs from loopback says node.own true");
check((await raw(own, "GET", "/api/pairs", { host: "ferry.evil.example" })).body.node.own === false, "own node: opened under another name (DNS rebinding), node.own false");
r = await raw(own, "POST", "/daemon/z/api/withdraw", { body: send, host: "ferry.evil.example", origin: "http://ferry.evil.example" });
check(r.status === 403, `own node: a withdraw under another Host is refused (${r.body?.error})`);
r = await raw(own, "POST", "/daemon/z/api/withdraw", { body: send, origin: "https://evil.example" });
check(r.status === 403, `own node: a withdraw from another site's page is refused (${r.body?.error})`);
r = await raw(own, "POST", "/daemon/z/api/withdraw", { body: { ...send, dry_run: true }, origin: OWNED });
check(r.status === 200 && r.body.dry_run === true && r.body.fee === "10000" && (await json(MZ + "/api/withdrawals")).length === 0, "own node: a fee preview reaches a daemon that previews, and sends nothing");
r = await raw(own, "POST", "/daemon/z/api/withdraw", { body: { ...send, extra: "x" }, host: `localhost:${own}`, origin: `http://localhost:${own}` });
check(r.status === 201 && r.body.status === "pending" && r.body.amount === "10000000", `own node: a withdraw from the node's page under its other loopback name goes through (${r.status} ${r.body?.error ?? ""})`);
check((await raw(own, "GET", "/daemon/z/api/withdrawals")).body.length === 1, "own node: GET withdrawals");
r = await raw(own, "POST", "/daemon/z/api/withdraw", { body: { ...send, to: "tmJ1xYxP8XNTtCoDgvdmQPSrxh5qZJgy65Z" }, origin: OWNED });
check(r.status === 400 && r.body.error === "to: Ferry only sends shielded ZEC; use a shielded address", `own node: the daemon's own refusal of a transparent address comes through (${r.body?.error})`);

// the event streams: the node's sends reach its owner's page, never a public demo's visitors
const listen = (port) => {
  let got = "";
  const req = http.request({ host: "127.0.0.1", port, path: "/daemon/z/api/events", headers: { host: `127.0.0.1:${port}`, accept: "text/event-stream" } }, (res) => res.on("data", (c) => (got += c)));
  req.on("error", () => {});
  req.end();
  return { stop: () => (req.destroy(), got) };
};
const streams = [listen(PUB), listen(OWN)];
await sleep(600);
check((await post(MZ, "/api/withdraw", { asset: "zec", amount: "20000000", to: MY_ZEC2 })).status === 201, "a send out of the node, while both pages listen");
await sleep(2500);
const [pubSeen, ownSeen] = streams.map((s) => s.stop());
check(/event: status/.test(pubSeen) && !/event: withdrawal/.test(pubSeen) && !pubSeen.includes(MY_ZEC2), "public demo: its event stream carries status but no withdrawal (no amounts, no addresses)");
check(/event: withdrawal/.test(ownSeen) && ownSeen.includes(MY_ZEC2), "own node: its event stream carries the send");
check((await raw(own, "GET", "/daemon/b-usdc-base/api/addresses")).body.btc.chain_id === 84532, "own node: GET addresses");
r = await raw(own, "POST", "/daemon/z/api/withdraw", { body: { asset: "zec", amount: 1.5, to: MY_ZEC2 }, origin: OWNED });
check(r.status === 400, "own node: a withdraw is rebuilt field by field (a fractional amount is refused here)");
s = (await raw(own, "POST", "/daemon/z/api/swaps", { body: { maker: "Kestrel", zec_zat: 50_000_000, payout_to: MY_BTC }, origin: OWNED })).body;
check(!!s.id && (await json(`${MZ}/api/swaps/${s.id}`)).payout_to === MY_BTC, "own node: a sell's payout_to reaches the daemon");
await idle();
s = (await raw(own, "POST", "/daemon/z/api/swaps", { body: { maker: "Kestrel", zec_zat: 50_000_000, payout_to: MY_BTC }, origin: "https://evil.example" })).body;
check(!s.id, "own node: a swap start from another site is refused outright");
// PUBLIC_ORIGIN is http://127.0.0.1:<port>: a person who typed http://localhost:<port> may act too
r = await raw(own, "POST", "/daemon/z/api/swaps", { body: { maker: "Kestrel", zec_zat: 50_000_000 }, host: `localhost:${own}`, origin: `http://localhost:${own}` });
check(r.status === 201, `own node: PUBLIC_ORIGIN's other loopback name (http://localhost:${own}) starts a swap too (${r.status} ${r.body?.error ?? ""})`);
await idle();

console.log(shots.join("\n"));
process.exit(0);
