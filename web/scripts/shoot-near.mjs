// `node scripts/shoot-near.mjs`: NEAR Intents on /app, at 1440 and 390, against the node mock and its
// mock 1Click (mock/oneclick.mjs): the coin picker's "More via NEAR Intents" section (chain chips,
// "More chains", search, a composed quote per row), a NEAR sell on the card, the destination step
// (an address NEAR Intents refuses, then one it accepts), the sell's progress (the Ferry swap paid into
// 1Click's deposit address, then NEAR Intents delivering), a buy with SOL (the deposit screen, the
// deposit, NEAR Intents delivering BTC to the B node, the Ferry buy the server starts), a refund,
// Activity and Help. Then the production server (server/prod.mjs, needs `pnpm build` first) as a
// public demo: quotes only, no NEAR swap starts, no payout_to from a browser, the rate limit; and with
// FERRY_NEAR=1 on test-network nodes: still no swaps (NEAR Intents is mainnet only).
// Screenshots go to screenshots/app/near/ (SHOOT_OUT=dir to put them elsewhere).
//
// Ports (override with SHOOT_PORT_BASE, default 7450): mock Z base+1, B base+2, 1Click base+3,
// prod base+10 and base+11; Vite on SHOOT_VITE_PORT (5198).
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { mockMakersEnv } from "../mock/makers.mjs";
import { MOCK_ONE_CLICK_PUBKEY } from "../mock/oneclick.mjs";

const BASE_PORT = Number(process.env.SHOOT_PORT_BASE ?? 7450);
const Z = BASE_PORT + 1;
const B = BASE_PORT + 2;
const NEAR = BASE_PORT + 3;
const PROD = BASE_PORT + 10;
const PROD2 = BASE_PORT + 11;
const VITE = Number(process.env.SHOOT_VITE_PORT ?? 5198);
const OUT = (process.env.SHOOT_OUT ?? new URL("../screenshots/app/near/", import.meta.url).pathname).replace(/\/?$/, "/");
const STATE = new URL("../.near/shoot-near.json", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
rmSync(STATE, { force: true });

const env = {
  ...process.env,
  MOCK_SPEED: "4",
  MOCK_Z_PORT: String(Z),
  MOCK_B_PORT: String(B),
  MOCK_NEAR_PORT: String(NEAR),
  MOCK_NEAR_SPEED: "2",
  MOCK_ROUTE_PORT: "",
  FERRY_Z_URL: `http://127.0.0.1:${Z}`,
  FERRY_B_URL: `http://127.0.0.1:${B}`,
  FERRY_MAKERS: mockMakersEnv(B, Z),
  FERRY_Z_TOKEN: "",
  FERRY_B_TOKEN: "",
  FERRY_ROUTER_URL: "",
  // the mock 1Click on loopback, its own signing key, and swaps on the mock's test chains
  FERRY_NEAR_URL: `http://127.0.0.1:${NEAR}`,
  FERRY_NEAR_PUBKEY: MOCK_ONE_CLICK_PUBKEY,
};
const dev = { ...env, PORT: String(VITE), FERRY_NEAR: "1", FERRY_NEAR_TESTNET: "1", FERRY_NEAR_STATE: STATE, FERRY_NEAR_TICK_MS: "700", FERRY_NEAR_STATUS_MS: "600" };
const procs = [
  spawn(process.execPath, ["mock/server.mjs"], { env, stdio: "ignore" }),
  spawn("pnpm", ["exec", "vite", "--port", String(VITE), "--strictPort"], { env: dev, stdio: "ignore" }),
  // the public demo: NEAR quotes, never NEAR swaps
  spawn(process.execPath, ["server/prod.mjs"], { env: { ...env, PORT: String(PROD), HOST: "127.0.0.1", DEMO_MAX_ZAT: "200000000", DEMO_NEAR_QUOTES_PER_MIN: "60" }, stdio: "inherit" }),
  // an operator's node that turned NEAR on, but on test networks: still quotes only
  spawn(process.execPath, ["server/prod.mjs"], { env: { ...env, PORT: String(PROD2), HOST: "127.0.0.1", FERRY_NEAR: "1", FERRY_NEAR_STATE: STATE + ".prod2" }, stdio: "ignore" }),
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
const PRD = `http://127.0.0.1:${PROD}`;
const PRD2 = `http://127.0.0.1:${PROD2}`;
const ONE = `http://127.0.0.1:${NEAR}`;
await Promise.all([up(DEV), up(PRD + "/healthz"), up(PRD2 + "/healthz"), up(ONE + "/v0/tokens"), up(`http://127.0.0.1:${B}/m/kestrel/peer/offer`)]);

const check = (cond, msg) => {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("ok:", msg);
};
const post = (base, path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const reset = async () => {
  await post(`http://127.0.0.1:${Z}`, "/api/_mock/reset", {});
  await post(ONE, "/_mock/reset", {});
};
const job = async (id) => (await fetch(`${DEV}/api/near/status/${id}`)).json();
async function until(id, pred, label, tries = 900) {
  for (let i = 0; i < tries; i++) {
    const v = await job(id);
    if (pred(v)) return v;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}: ${(await job(id)).state}`);
}
// every mock swap over, on both sides
async function idle() {
  for (let i = 0; i < 400; i++) {
    const lists = await Promise.all([Z, B].map(async (port) => (await fetch(`http://127.0.0.1:${port}/api/swaps`)).json()));
    if (lists.every((l) => l.every((s) => s.outcome))) return;
    await sleep(100);
  }
  throw new Error("the mock's swaps never finished");
}

const browser = await chromium.launch();
const shots = [];
async function page(width) {
  const p = await browser.newPage({ viewport: { width, height: width < 500 ? 844 : 900 } });
  p.on("console", (m) => m.type() === "error" && !/Failed to load resource|EventSource/.test(m.text()) && console.log(`[${width}]`, m.text()));
  return p;
}
const shot = async (p, name, opts = {}) => {
  const path = OUT + name + ".png";
  await p.screenshot({ path, ...opts });
  shots.push(path);
};
const text = (p, s, timeout = 15_000) => p.waitForFunction((s) => document.body.innerText.includes(s), s, { timeout });
const noOverflow = async (p, what) => {
  const o = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(o <= 0, `no horizontal scroll at 390: ${what} (${o}px)`);
};
const settle = () => sleep(500);
const SOL = "7dKbmvKfvwZjJ1Y2NYCQKsEXATBMVvUSSbYmdbHxQk5i";
const SOL_ID = "nep141:sol.omft.near";
// the Buy pill of a card selling ZEC
const coinPill = (p) => p.getByRole("button", { name: /^You get .*Choose another coin/ });
const nearList = (p) => p.getByRole("listbox", { name: "More via NEAR Intents" });

// ------------------------------------------------------------------------------ the picker
await reset();
const desk = await page(1440);
const phone = await page(390);
await desk.goto(DEV + "/app?dir=sell");
await text(desk, "1 ZEC = ");
await coinPill(desk).click();
await nearList(desk).waitFor();
const own = await desk.getByRole("listbox", { name: "Tokens" }).getByRole("option").allTextContents();
const dimmed = await desk.getByRole("listbox", { name: "Not available here" }).getByRole("option").count();
check(own.length === 2 && /^ZEC/.test(own[0]) && /^BTC/.test(own[1]) && own.length + dimmed === 11, `shielded ZEC and Ferry's own coins stay first (BTC here), and the ones it can't swap here are listed after NEAR Intents' (${own.length} + ${dimmed})`);
const order = await desk.evaluate(() => [...document.querySelectorAll('[role="listbox"]')].map((l) => l.getAttribute("aria-label")));
check(order.join("|") === "Tokens|More via NEAR Intents|Not available here", `the picker's order: Ferry's coins, NEAR Intents', then what isn't available here (${order.join(", ")})`);
const nearRows = await nearList(desk).getByRole("option").count();
const listed = (await (await fetch(ONE + "/v0/tokens")).json()).filter((t) => t.blockchain !== "zec").length;
// BTC is Ferry's own here (this server sells ZEC for it), so NEAR Intents' BTC isn't listed again
check(nearRows === listed - 1, `"More via NEAR Intents" lists NEAR Intents' assets, without native ZEC or the coin Ferry swaps here itself (${nearRows} of ${listed})`);
await desk.waitForFunction(() => [...document.querySelectorAll("[data-near-row]")].slice(0, 4).every((r) => r.textContent.includes("≈")), null, { timeout: 15_000 });
const first = await nearList(desk).getByRole("option").first().textContent();
check(/via NEAR Intents/.test(first) && /≈ [\d.]+/.test(first) && /for 1\.00 ZEC/.test(first), `a NEAR row: a "via NEAR Intents" tag and a composed quote for the card's ZEC (${first})`);
await settle();
await shot(desk, "01-picker-1440");
// More chains, then one of them
await desk.getByRole("button", { name: "More chains" }).click();
await desk.getByRole("group", { name: "More chains, through NEAR Intents" }).getByRole("button", { name: "Solana" }).click();
const sol = await nearList(desk).getByRole("option").allTextContents();
const onSol = (await (await fetch(ONE + "/v0/tokens")).json()).filter((t) => t.blockchain === "sol").length;
check(sol.length === onSol && sol.every((t) => /Solana/.test(t)) && (await desk.getByRole("listbox", { name: "Tokens" }).count()) === 0, `"More chains" → Solana: only NEAR Intents' Solana assets (${sol.length})`);
await settle();
await shot(desk, "01b-picker-solana-1440");
await desk.getByRole("button", { name: "Base", exact: true }).click();
const base = await nearList(desk).getByRole("option").allTextContents();
check(base.some((t) => /cbBTC/.test(t)) && base.every((t) => /Base/.test(t)), "a Ferry chain chip shows NEAR Intents' assets on that chain under Ferry's own");
await desk.getByRole("searchbox", { name: "Search by name or chain" }).fill("usdt");
await desk.getByRole("button", { name: "All", exact: true }).click();
const usdt = await nearList(desk).getByRole("option").allTextContents();
check(usdt.length === 4 && usdt.every((t) => t.startsWith("USDT")), `search finds USDT on every chain (${usdt.length})`);
await desk.getByRole("searchbox", { name: "Search by name or chain" }).fill("sol");
await nearList(desk).getByRole("option", { name: /^SOL.*Solana/ }).click();

// ------------------------------------------------------------------------------ the NEAR sell card
await desk.getByRole("button", { name: "Sell ZEC for SOL" }).waitFor();
await desk.waitForFunction(() => /1 ZEC ≈ [\d.]+ SOL\s*· at least [\d.]+ SOL/.test(document.body.innerText), null, { timeout: 15_000 });
const route = await desk.locator("[data-near-route]").textContent();
check(/Ferry.*BTC.*NEAR Intents · about \d+ min/.test(route), `the card shows the route: Ferry → BTC → NEAR Intents, and the time (${route})`);
const q = await (await post(DEV, "/api/near/quote", { direction: "sell", zec_zat: 100_000_000, asset: SOL_ID, exact: true })).json();
check(q.via === "btc" && q.maker === "Kestrel" && q.near.verified, `the quote goes through the best Ferry partner for BTC, then NEAR Intents, signature checked (${q.maker})`);
const out = await desk.locator("output").textContent();
check(Math.abs(Number(out.replace("≈", "")) / (Number(q.near.amount_out) / 1e9) - 1) < 1e-3, `the card shows what NEAR Intents' quote says (${out} SOL)`);
check(await desk.getByText("Your ZEC stays shielded and never goes to NEAR Intents. The NEAR Intents part is public, and you trust NEAR Intents for it.").isVisible(), "one plain line says what's private and what isn't");
await settle();
await shot(desk, "02-sell-quote-1440");
await desk.getByRole("button", { name: /^Settings: the route/ }).click();
await text(desk, "Swaps your shielded ZEC for Bitcoin with Kestrel");
await settle();
await shot(desk, "02b-sell-route-1440");
await desk.keyboard.press("Escape");

// ------------------------------------------------------------------------------ the destination step
await desk.getByRole("button", { name: "Sell ZEC for SOL" }).click();
const dialog = desk.getByRole("dialog", { name: "Where should the SOL go?" });
await dialog.waitFor();
const field = dialog.getByRole("textbox", { name: /Your SOL address on Solana/ });
await field.fill("0x2527D02599Ba641c19FEa793cD0F167589a0f10D");
await text(desk, "That doesn't look like an address on this chain.");
check((await dialog.getByRole("button", { name: "Start swap" }).isDisabled()) === true, "an Ethereum address for SOL is refused before anything is asked");
await field.fill("t1Ku2KLyndDPsR32jwnrTMd3yvi9tfFP8ML");
await text(desk, "That's a Zcash address");
check(true, "a Zcash address is never a destination");
await field.fill(SOL);
await text(desk, "NEAR Intents accepts this Solana address.");
for (const t of ["Your ZEC stays shielded", "The NEAR Intents part is public", "If something stops", "You get at least"]) await text(desk, t);
check(true, "the destination step checks the address with NEAR Intents and says what's different");
await settle();
await shot(desk, "03-destination-1440");
await dialog.getByRole("button", { name: "Start swap" }).click();
await desk.waitForURL(/\/app\/near\/n[0-9a-f]{16}$/);
const id = desk.url().split("/").pop();
let v = await job(id);
check(v.kind === "sell" && v.state === "ferry" && v.address === SOL && v.near.verified, "the swap started: a NEAR Intents quote to your address, signature checked");
const zswaps = await (await fetch(`http://127.0.0.1:${Z}/api/swaps`)).json();
const zs = zswaps.find((s) => s.id === v.ferry.swap_id);
check(zs && zs.payout_to === v.near.deposit_address, "the Ferry swap pays its BTC into NEAR Intents' deposit address (payout_to)");
const quotes = await (await fetch(ONE + "/_mock/quotes")).json();
const real = quotes.find((x) => x.depositAddress === v.near.deposit_address);
check(real.request.recipient === SOL && real.request.refundTo === v.own_address && real.request.refundType === "ORIGIN_CHAIN", "NEAR Intents pays your address and refunds to your own Ferry node");

// ------------------------------------------------------------------------------ the sell's progress
await phone.goto(`${DEV}/app/near/${id}`);
await Promise.all([text(desk, "Selling 1.00 ZEC for SOL"), text(phone, "Selling 1.00 ZEC for SOL")]);
await settle();
await shot(desk, "04-sell-ferry-1440");
await shot(phone, "04-sell-ferry-390");
await noOverflow(phone, "NEAR progress");
await until(id, (x) => x.state === "near", "NEAR Intents' part");
await Promise.all([text(desk, "Sending your SOL"), text(phone, "Sending your SOL")]);
await settle();
await shot(desk, "05-sell-near-1440");
await shot(phone, "05-sell-near-390");
v = await until(id, (x) => x.state === "done", "done");
await Promise.all([text(desk, "You received"), text(phone, "You received")]);
check(v.near.status === "SUCCESS" && v.near.details.amount_out, `done: NEAR Intents delivered ${v.near.details.amount_out} lamports`);
await desk.getByRole("button", { name: "Technical details" }).click();
await text(desk, "Signed by 1Click");
await text(desk, "Look it up on the NEAR Intents Explorer");
await settle();
await shot(desk, "06-sell-done-1440", { fullPage: true });
await shot(phone, "06-sell-done-390");

// ------------------------------------------------------------------------------ a buy with SOL
await idle();
await desk.goto(DEV + "/app");
await desk.getByRole("button", { name: "Sell ZEC for SOL" }).waitFor();
check(true, "the card remembers the NEAR asset");
await desk.getByRole("button", { name: "Switch direction" }).click();
await desk.getByRole("button", { name: "Buy ZEC with SOL" }).waitFor();
await desk.waitForFunction(() => /1 ZEC ≈ [\d.]+ SOL/.test(document.body.innerText) && /NEAR Intents.*BTC.*Ferry · about/.test(document.querySelector("[data-near-route]")?.textContent ?? ""), null, { timeout: 15_000 });
await desk.locator("input[inputmode=decimal]").fill("0.5");
await desk.waitForFunction(() => /1 ZEC ≈/.test(document.body.innerText), null, { timeout: 15_000 });
await settle();
await shot(desk, "07-buy-quote-1440");
await desk.getByRole("button", { name: "Buy ZEC with SOL" }).click();
const refund = desk.getByRole("dialog", { name: "Where should a refund go?" });
await refund.getByRole("textbox").fill(SOL);
await text(desk, "NEAR Intents accepts this Solana address.");
await text(desk, "You send first, to NEAR Intents");
await refund.getByRole("button", { name: "Get deposit address" }).click();
await desk.waitForURL(/\/app\/near\/n[0-9a-f]{16}$/);
const bid = desk.url().split("/").pop();
await desk.locator("[data-near-deposit]").waitFor();
let b = await job(bid);
check(b.kind === "buy" && b.state === "deposit" && b.near.deposit_address, "a buy: NEAR Intents' deposit address for your SOL");
const bq = (await (await fetch(ONE + "/_mock/quotes")).json()).find((x) => x.depositAddress === b.near.deposit_address);
check(bq.request.recipient === b.own_address && bq.request.refundTo === SOL && bq.request.swapType === "EXACT_OUTPUT", "NEAR Intents delivers BTC to your own B node and refunds SOL to your address");
check(/Send exactly.*SOL.*To NEAR Intents' deposit address/.test(await desk.locator("[data-near-deposit]").textContent()), "the deposit screen: how much SOL, and where to");
await phone.goto(`${DEV}/app/near/${bid}`);
await phone.locator("[data-near-deposit]").waitFor();
await settle();
await shot(desk, "08-buy-deposit-1440");
await shot(phone, "08-buy-deposit-390");
await noOverflow(phone, "deposit screen");
const bal0 = (await (await fetch(`http://127.0.0.1:${B}/api/status`)).json()).balances.btc_sat;
await post(ONE, "/_mock/deposit", { depositAddress: b.near.deposit_address });
b = await until(bid, (x) => x.state === "ferry", "the Ferry buy, started by the server");
const bs = (await (await fetch(`http://127.0.0.1:${B}/api/swaps`)).json()).find((s) => s.id === b.ferry.swap_id);
check(bs && bs.amounts.zec_zat === 50_000_000, "once NEAR Intents delivered, the server started the Ferry buy for 0.5 ZEC");
await Promise.all([text(desk, "Buying your ZEC"), text(phone, "Buying your ZEC")]);
await settle();
await shot(desk, "09-buy-ferry-1440");
await shot(phone, "09-buy-ferry-390");
await until(bid, (x) => x.state === "done", "the buy done");
const bal1 = (await (await fetch(`http://127.0.0.1:${B}/api/status`)).json()).balances.btc_sat;
check(bal1 === bal0 + Number(b.near.details.amount_out) - bs.amounts.btc_sat, `the BTC NEAR Intents delivered went into the B node, and the buy spent ${bs.amounts.btc_sat} sat of it (the rest stays there)`);
await text(desk, "You received 0.50 ZEC");
await settle();
await shot(desk, "10-buy-done-1440");

// ------------------------------------------------------------------------------ a refund
await idle();
await post(ONE, "/_mock/fault", { next: "refund" });
const sell2 = await post(DEV, "/api/near/swap", { direction: "sell", zec_zat: 20_000_000, asset: SOL_ID, address: SOL, via: "btc", min_out: "1" });
const r2 = await sell2.json();
check(sell2.status === 201, `a second sell (${sell2.status} ${r2.error ?? ""})`);
await desk.goto(`${DEV}/app/near/${r2.id}`);
const refunded = await until(r2.id, (x) => x.state === "refunded", "the refund");
await text(desk, "Your BTC is back");
check(refunded.near.details.refunded && refunded.outcome === "near_refunded", "NEAR Intents refunded the BTC to your Ferry node");
await settle();
await shot(desk, "11-refunded-1440");

// ------------------------------------------------------------------------------ Activity, Help
for (const p of [desk, phone]) {
  await p.goto(DEV + "/app/activity");
  await text(p, "via NEAR Intents");
}
const rows = await desk.locator("main ul > li").allTextContents();
check(rows.length === 3 && rows.every((t) => /via NEAR Intents/.test(t)), `Activity: one row per NEAR swap, their Ferry swaps not listed on their own (${rows.length} rows)`);
await settle();
await shot(desk, "12-activity-1440");
await shot(phone, "12-activity-390");
for (const p of [desk, phone]) {
  await p.goto(DEV + "/help");
  await p.getByRole("heading", { name: "NEAR Intents" }).scrollIntoViewIfNeeded();
  await p.getByRole("button", { name: "Does my ZEC go to NEAR Intents?" }).click();
  await text(p, "Ferry never sends ZEC to NEAR Intents");
}
await settle();
const helpAt = async (p) => {
  await p.getByRole("heading", { name: "NEAR Intents" }).evaluate((h) => h.closest("section").scrollIntoView({ block: "start" }));
  // clear of the sticky header
  await p.evaluate(() => window.scrollBy(0, -130));
  await sleep(200);
};
await helpAt(desk);
await shot(desk, "13-help-1440");
await helpAt(phone);
await shot(phone, "13-help-390");
await noOverflow(phone, "help");

// ------------------------------------------------------------------------------ phone: picker and card
// a link can name the NEAR asset: ?near=<assetId>
await phone.goto(DEV + "/app?dir=sell&near=" + encodeURIComponent(SOL_ID));
await phone.getByRole("button", { name: "Sell ZEC for SOL" }).waitFor();
await phone.waitForFunction(() => /1 ZEC ≈/.test(document.body.innerText), null, { timeout: 15_000 });
await settle();
await shot(phone, "02-sell-quote-390");
await noOverflow(phone, "NEAR card");
await coinPill(phone).click();
await nearList(phone).waitFor();
await phone.locator("#tokens-near").scrollIntoViewIfNeeded();
await phone.waitForFunction(() => [...document.querySelectorAll("[data-near-row]")].slice(0, 3).every((r) => r.textContent.includes("≈")), null, { timeout: 15_000 });
await settle();
await shot(phone, "01-picker-390");
await phone.keyboard.press("Escape");
await phone.getByRole("button", { name: "Sell ZEC for SOL" }).click();
await phone.getByRole("dialog", { name: "Where should the SOL go?" }).getByRole("textbox").fill(SOL);
await text(phone, "NEAR Intents accepts this Solana address.");
await settle();
await shot(phone, "03-destination-390");
await phone.keyboard.press("Escape");

// ------------------------------------------------------------------------------ production: the public demo
let r = await fetch(PRD + "/api/near/tokens");
let info = await r.json();
check(r.status === 200 && info.available && info.execution.sell === false && info.execution.buy === false && info.reason === "demo", "prod (public demo): NEAR Intents' assets, quotes only");
r = await post(PRD, "/api/near/quote", { direction: "sell", zec_zat: 50_000_000, asset: SOL_ID });
const pq = await r.json();
check(r.status === 200 && pq.execution === false && pq.reason === "demo", "prod: a composed quote, labelled not runnable here");
r = await post(PRD, "/api/near/swap", { direction: "sell", zec_zat: 50_000_000, asset: SOL_ID, address: SOL, via: "btc", min_out: "1" });
check(r.status === 403 && /own Ferry node/.test((await r.json()).error), "prod: a visitor can't start a NEAR swap (it would pay the operator's coins to their address)");
check((await (await fetch(ONE + "/_mock/quotes")).json()).length === 3, "prod: no real 1Click quote was asked for (only the three from the dev server)");
r = await fetch(PRD + "/api/near/jobs");
check(r.status === 200 && (await r.json()).length === 0, "prod: no NEAR swaps on the demo");
const demo = await page(1440);
await demo.addInitScript(() => localStorage.setItem("ferry.near", "nep141:sol.omft.near"));
await demo.goto(PRD + "/app?dir=sell");
await demo.getByRole("button", { name: "Swap on your own node" }).waitFor();
await demo.waitForFunction(() => /1 ZEC ≈ [\d.]+ SOL/.test(document.body.innerText), null, { timeout: 15_000 });
check(await demo.getByRole("button", { name: "Swap on your own node" }).isDisabled(), "prod demo page: the NEAR card quotes, and its button says it runs on your own node");
await text(demo, "Quote only.");
await settle();
await shot(demo, "14-demo-quote-only-1440");
await coinPill(demo).click();
await nearList(demo).waitFor();
check(/on your own node/.test(await nearList(demo).getByRole("option").first().textContent()), "prod demo page: NEAR rows say they run on your own node");
await demo.close();
await idle();
r = await post(PRD, "/daemon/z/api/swaps", { maker: "Kestrel", zec_zat: 20_000_000, payout_to: "bc1qattacker0000000000000000000000000000", min_counter: 1 });
const direct = await r.json();
const dz = (await (await fetch(`http://127.0.0.1:${Z}/api/swaps`)).json()).find((s) => s.id === direct.id);
check(r.status === 201 && dz && !dz.payout_to, "prod: a browser's payout_to never reaches a daemon (the swap pays the node's own wallet)");
// an operator turned NEAR on, but their nodes are on test networks
info = await (await fetch(PRD2 + "/api/near/tokens")).json();
check(info.execution.sell === false && info.reason === "mainnet", "prod with FERRY_NEAR=1 on test networks: quotes only (NEAR Intents is mainnet only)");
r = await post(PRD2, "/api/near/swap", { direction: "sell", zec_zat: 50_000_000, asset: SOL_ID, address: SOL, via: "btc", min_out: "1" });
check(r.status === 409 && /mainnet/.test((await r.json()).error), "prod with FERRY_NEAR=1 on test networks: a NEAR swap is refused");
// the quote rate limit
let limited = 0;
for (let i = 0; i < 62; i++) {
  r = await post(PRD, "/api/near/quote", { direction: "sell", zec_zat: 50_000_000, asset: SOL_ID });
  if (r.status === 429) limited++;
}
check(limited > 0, `prod: NEAR quotes are rate limited per IP (${limited} refused)`);

await browser.close();
console.log(shots.join("\n"));
process.exit(0);
