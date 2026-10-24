// `node scripts/shoot-any.mjs`: any coin on either side of the swap card on /app, at 1440 and 390,
// against the node mock with its mock router, its mock 1Click and its Z party also fronted as a
// Litecoin node (MOCK_Z_LTC_PORT). One picker for both pills (shielded ZEC, Ferry's coins, more via
// NEAR Intents), the arrow swapping any two coins, and every path the card resolves:
//   ZEC → BTC, BTC → ZEC                 one Ferry swap each way
//   BTC → USDC                           a private swap through shielded ZEC (the router)
//   ZEC → SOL, SOL → ZEC                 Ferry and NEAR Intents
//   USDC → SOL                           a private swap whose second swap pays NEAR Intents
//   SOL → USDC                           NEAR Intents into the B node, then a private swap
//   SOL → USDT (Tron)                    both
// each started from the card and followed to the end on the mock; the opt-out for two coins (NEAR
// Intents alone, public: offered in the settings, remembered per pair, never the default); and the
// combinations this server
// can't run (no daemon that way, the router doesn't take that coin, the same coin on both sides,
// the same asset at both ends, no router), each with its one plain sentence. The "Recent activity"
// panel beside the card, empty and then full. Then the production server (server/prod.mjs, needs
// `pnpm build` first) as a public demo: a coin-to-NEAR swap quotes only, a start is refused, and a
// browser's payout_to never reaches the router; and one without a router.
// Screenshots go to screenshots/app/any/ (SHOOT_OUT=dir to put them elsewhere; SHOOT_THEME=dark to
// take them in dark mode).
//
// Ports (override with SHOOT_PORT_BASE, default 7600): mock Z base+81, B base+82, 1Click base+83,
// router base+84, Z-as-LTC base+85, Vite base+91, prod base+92 (public demo) and base+93 (no router).
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { chromium } from "playwright";
import { mockMakersEnv } from "../mock/makers.mjs";
import { MOCK_ONE_CLICK_PUBKEY } from "../mock/oneclick.mjs";

const BASE = Number(process.env.SHOOT_PORT_BASE ?? 7600);
const [Z, B, NEAR, ROUTER, LTC, VITE, PROD, PROD2] = [81, 82, 83, 84, 85, 91, 92, 93].map((n) => BASE + n);
const OUT = (process.env.SHOOT_OUT ?? new URL("../screenshots/app/any/", import.meta.url).pathname).replace(/\/?$/, "/");
const STATE = new URL("../.near/shoot-any.json", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
rmSync(STATE, { force: true });

const env = {
  ...process.env,
  MOCK_SPEED: "4",
  MOCK_Z_PORT: String(Z),
  MOCK_B_PORT: String(B),
  MOCK_NEAR_PORT: String(NEAR),
  MOCK_NEAR_SPEED: "2",
  MOCK_ROUTE_PORT: String(ROUTER),
  // Standard's 5–30 min pause becomes 1.5–9 s at speed 4
  MOCK_ROUTE_PAUSE_SCALE: "0.02",
  MOCK_Z_LTC_PORT: String(LTC),
  FERRY_Z_URL: `http://127.0.0.1:${Z}`,
  FERRY_B_URL: `http://127.0.0.1:${B}`,
  FERRY_LTC_URL: `http://127.0.0.1:${LTC}`,
  FERRY_ROUTER_URL: `http://127.0.0.1:${ROUTER}`,
  FERRY_MAKERS: mockMakersEnv(B, Z, { routes: true }),
  FERRY_Z_TOKEN: "",
  FERRY_B_TOKEN: "",
  FERRY_LTC_TOKEN: "",
  FERRY_NEAR_URL: `http://127.0.0.1:${NEAR}`,
  FERRY_NEAR_PUBKEY: MOCK_ONE_CLICK_PUBKEY,
};
// the operator's own node (NEAR swaps run, on the mock's test chains against the mock 1Click)
const dev = { ...env, PORT: String(VITE), FERRY_NEAR: "1", FERRY_NEAR_TESTNET: "1", FERRY_NEAR_STATE: STATE, FERRY_NEAR_TICK_MS: "700", FERRY_NEAR_STATUS_MS: "600" };
const procs = [
  spawn(process.execPath, ["mock/server.mjs"], { env, stdio: "ignore" }),
  spawn("pnpm", ["exec", "vite", "--port", String(VITE), "--strictPort"], { env: dev, stdio: "ignore" }),
  // the public demo: a router and NEAR Intents' quotes, never NEAR swaps
  spawn(process.execPath, ["server/prod.mjs"], { env: { ...env, PORT: String(PROD), HOST: "127.0.0.1", DEMO_MAX_ZAT: "200000000" }, stdio: "inherit" }),
  // a server without a router
  spawn(process.execPath, ["server/prod.mjs"], { env: { ...env, PORT: String(PROD2), HOST: "127.0.0.1", FERRY_ROUTER_URL: "" }, stdio: "ignore" }),
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
const RT = `http://127.0.0.1:${ROUTER}`;
await Promise.all([up(DEV), up(PRD + "/healthz"), up(PRD2 + "/healthz"), up(ONE + "/v0/tokens"), up(RT + "/api/status"), up(`http://127.0.0.1:${LTC}/api/status`)]);

const check = (cond, msg) => {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("ok:", msg);
};
const post = (base, path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const json = async (url) => (await fetch(url)).json();
// every mock swap over, on both sides, and no route moving; then the mock's wallets back to their
// starting balances (its one Z party is every partner's Z side too, so many swaps drain it)
async function idle() {
  for (let i = 0; i < 600; i++) {
    const lists = await Promise.all([Z, B].map((port) => json(`http://127.0.0.1:${port}/api/swaps`)));
    const routes = await json(RT + "/api/routes");
    if (lists.every((l) => l.every((s) => s.outcome)) && routes.every((r) => !["leg1", "settling", "pausing", "leg2"].includes(r.state))) {
      await post(`http://127.0.0.1:${Z}`, "/api/_mock/balances", {});
      return;
    }
    await sleep(100);
  }
  throw new Error("the mock's swaps never finished");
}
async function until(get, pred, label, tries = 1800) {
  let v;
  for (let i = 0; i < tries; i++) {
    v = await get();
    if (pred(v)) return v;
    await sleep(100);
  }
  const routes = await json(RT + "/api/routes").catch(() => []);
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(v?.state ?? v?.outcome ?? v)} ${v?.problem ?? ""}\n  routes: ${routes.map((r) => `${r.id} ${r.phase} ${r.problem ?? ""} ${r.note}`).join("\n  ")}`);
}

const SOL_ID = "nep141:sol.omft.near";
const USDT_TRON = "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near";
const USDC_SOL = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
const SOL = "7dKbmvKfvwZjJ1Y2NYCQKsEXATBMVvUSSbYmdbHxQk5i";
const TRON = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
const near = (id) => `near:${id}`;

const browser = await chromium.launch();
const shots = [];
async function page(width) {
  const p = await browser.newPage({ viewport: { width, height: width < 500 ? 844 : 900 }, colorScheme: process.env.SHOOT_THEME === "dark" ? "dark" : "light" });
  p.on("console", (m) => m.type() === "error" && !/Failed to load resource|EventSource/.test(m.text()) && console.log(`[${width}]`, m.text()));
  p.on("pageerror", (e) => console.log(`[${width}] page error:`, e.message));
  return p;
}
const shot = async (p, name, opts = {}) => {
  const path = OUT + name + ".png";
  await p.screenshot({ path, ...opts });
  shots.push(path);
};
const text = (p, s, timeout = 20_000) => p.waitForFunction((s) => document.body.innerText.includes(s), s, { timeout });
const noOverflow = async (p, what) => {
  const o = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(o <= 0, `no horizontal scroll at 390: ${what} (${o}px)`);
};
const settle = () => sleep(600);
const sellPill = (p) => p.getByRole("button", { name: /^You sell .*Choose another coin$/ });
const buyPill = (p) => p.getByRole("button", { name: /^You get .*Choose another coin$/ });
const submit = (p) => p.locator("form button[type=submit]");
const pathLine = async (p) => (await p.locator("[data-path-line]").first().textContent()).replace(/\s+/g, " ").trim();
const privacy = async (p) => (await p.locator("[data-privacy-line]").textContent()).trim();
const openCard = async (p, sell, buy) => {
  await p.goto(`${DEV}/app?sell=${encodeURIComponent(sell)}&buy=${encodeURIComponent(buy)}`);
  await p.locator("[data-path-line], [data-off-reason]").first().waitFor({ timeout: 20_000 });
};
// the card is quoted and its button can be pressed
const ready = (p, label) => p.waitForFunction((label) => [...document.querySelectorAll("form button[type=submit]")].some((b) => !b.disabled && b.textContent.trim() === label), label, { timeout: 30_000 });

const desk = await page(1440);
const phone = await page(390);
await post(`http://127.0.0.1:${Z}`, "/api/_mock/reset", {});
await post(ONE, "/_mock/reset", {});

// ------------------------------------------------------------------------------ the card's first coins, the panel
await desk.goto(DEV + "/app");
await sellPill(desk).waitFor();
check(/^You sell shielded ZEC/.test(await sellPill(desk).getAttribute("aria-label")) && /^You get Bitcoin/.test(await buyPill(desk).getAttribute("aria-label")), "Sell starts on shielded ZEC, Buy on the first coin this server sells it for (BTC)");
await ready(desk, "Sell ZEC");
await text(desk, "Your swaps will show up here");
const panel = desk.locator("[data-recent]");
check((await panel.getByRole("link", { name: /View all/ }).getAttribute("href")) === "/app/activity", 'the "Recent activity" panel sits beside the card, empty, with "View all" to /app/activity');
// beside the card, from the top of its panels to the bottom of its button
const aligned = () =>
  desk.evaluate(() => {
    const card = document.querySelector("form").getBoundingClientRect();
    const button = document.querySelector("form button[type=submit]").getBoundingClientRect();
    const side = document.querySelector("[data-recent]").getBoundingClientRect();
    return side.left > card.right && Math.abs(side.top - card.top) < 2 && Math.abs(side.bottom - button.bottom) < 2;
  });
await desk.waitForFunction(() => document.querySelector("[data-recent]").style.height !== "", null, { timeout: 10_000 });
check(await aligned(), "at 1440 the panel is to the right of the card, as tall as the card down to its button");
await settle();
await shot(desk, "00-empty-1440");
await phone.goto(DEV + "/app");
await ready(phone, "Sell ZEC");
const below = await phone.evaluate(() => document.querySelector("[data-recent]").getBoundingClientRect().top > document.querySelector("form").getBoundingClientRect().bottom);
check(below, "at 390 the panel goes below the card");
await noOverflow(phone, "the card and the panel");
await settle();
await shot(phone, "00-empty-390", { fullPage: true });

// ------------------------------------------------------------------------------ the one picker, from the Sell pill
await sellPill(desk).click();
await desk.getByRole("listbox", { name: "Tokens" }).waitFor();
const order = await desk.evaluate(() => [...document.querySelectorAll('[role="listbox"]')].map((l) => l.getAttribute("aria-label")));
check(order.join("|") === "Tokens|More via NEAR Intents|Not available here", `the picker: shielded ZEC and Ferry's coins, then more via NEAR Intents, then what isn't available here (${order.join(", ")})`);
const own = await desk.getByRole("listbox", { name: "Tokens" }).getByRole("option").allTextContents();
check(/^ZEC/.test(own[0]), `shielded ZEC is on top (${own[0]})`);
const row = (t) => own.find((x) => x.startsWith(t)) ?? "";
check(/switches the two sides/.test(row("BTC")), `the other side's coin swaps the two (${row("BTC")})`);
check(/USD Coin · Base · privately, through ZEC/.test(row("USDC")), `a coin that goes to BTC through shielded ZEC says so (${row("USDC")})`);
check(/Litecoin · not with BTC here/.test(row("LTC")), `a coin that can't go to BTC here says so, and can still be picked (${row("LTC")})`);
const dimmed = await desk.getByRole("listbox", { name: "Not available here" }).getByRole("option").count();
check(own.length === 4 && dimmed === 7, `ZEC and the 3 coins this server swaps or routes, the other 7 dimmed (${own.length} + ${dimmed})`);
check(/NEAR Intents brings your coin in, then it goes privately through shielded ZEC/.test(await desk.locator("#tokens-near").locator("..").locator("..").textContent()), "the NEAR section says how a NEAR asset goes to a coin");
await settle();
await shot(desk, "01-picker-sell-1440");
// any coin can be picked: one that can't go to BTC here, and one this server doesn't swap at all
await desk.getByRole("listbox", { name: "Tokens" }).getByRole("option", { name: /^LTC/ }).click();
await desk.waitForFunction(() => document.querySelector("[data-off-reason]")?.textContent === "Private swaps can't start from LTC on this server.", null, { timeout: 10_000 });
check(/^You sell LTC/.test(await sellPill(desk).getAttribute("aria-label")), "picking LTC on the Sell pill puts it there, and the card says why it can't go to BTC here");
await sellPill(desk).click();
await desk.getByRole("listbox", { name: "Not available here" }).getByRole("option", { name: /^WETH.*Arbitrum/ }).click();
await desk.waitForFunction(() => document.querySelector("[data-off-reason]")?.textContent === "Private swaps can't start from WETH on this server.", null, { timeout: 10_000 });
check(/^You sell WETH/.test(await sellPill(desk).getAttribute("aria-label")), "a coin this server doesn't swap at all can be picked too, and the card says why");
await sellPill(desk).click();
await desk.getByRole("listbox", { name: "Tokens" }).getByRole("option", { name: /^ZEC/ }).click();
await ready(desk, "Sell ZEC");
await sellPill(phone).click();
await phone.getByRole("listbox", { name: "Tokens" }).waitFor();
await settle();
await shot(phone, "01-picker-sell-390");
await phone.keyboard.press("Escape");

// ------------------------------------------------------------------------------ ZEC → BTC: one swap
const card = async (p, name, { sell, buy, button, line, priv }) => {
  await openCard(p, sell, buy);
  await ready(p, button);
  const l = await pathLine(p);
  check(line.test(l), `${name}: the path line (${l})`);
  check(priv.test(await privacy(p)), `${name}: the privacy line`);
};
const ZB = { sell: "zec", buy: "btc", button: "Sell ZEC", line: /^Ferry · one swap · about/, priv: /^Your ZEC stays shielded, and nothing on either chain links the two sides\.$/ };
await card(desk, "ZEC → BTC", ZB);
await card(phone, "ZEC → BTC", ZB);
await settle();
await shot(desk, "02-zec-btc-1440");
await shot(phone, "02-zec-btc-390");
await noOverflow(phone, "ZEC → BTC");
await submit(desk).click();
await desk.waitForURL(/\/app\/swap\/[0-9a-f]+$/);
const s1 = desk.url().split("/").pop();
await until(() => json(`http://127.0.0.1:${Z}/api/swaps/${s1}`), (s) => s.outcome === "swapped", "ZEC → BTC");
check(true, "ZEC → BTC: done on the mock");

// ------------------------------------------------------------------------------ the arrow: BTC → ZEC
await idle();
await openCard(desk, "zec", "btc");
await ready(desk, "Sell ZEC");
await desk.getByRole("button", { name: "Switch direction" }).click();
await ready(desk, "Buy ZEC");
check(/^You sell Bitcoin/.test(await sellPill(desk).getAttribute("aria-label")), "the arrow swaps the two sides: BTC → ZEC");
check(/^Your ZEC arrives shielded/.test(await privacy(desk)), "BTC → ZEC: the privacy line");
await settle();
await shot(desk, "03-btc-zec-1440");
await card(phone, "BTC → ZEC", { sell: "btc", buy: "zec", button: "Buy ZEC", line: /^Ferry · one swap/, priv: /arrives shielded/ });
await settle();
await shot(phone, "03-btc-zec-390");
await submit(desk).click();
await desk.waitForURL(/\/app\/swap\/[0-9a-f]+$/);
const s2 = desk.url().split("/").pop();
await until(() => json(`http://127.0.0.1:${B}/api/swaps/${s2}`), (s) => s.outcome === "swapped", "BTC → ZEC");
check(true, "BTC → ZEC: done on the mock");

// ------------------------------------------------------------------------------ BTC → USDC: private, through shielded ZEC
await idle();
await openCard(desk, "btc", "zec");
await ready(desk, "Buy ZEC");
await buyPill(desk).click();
await desk.getByRole("listbox", { name: "Tokens" }).getByRole("option", { name: /^USDC.*privately, through ZEC/ }).click();
await ready(desk, "Swap privately");
let l = await pathLine(desk);
check(/^Ferry shielded ZEC Ferry · private · about 35–75 min$/.test(l), `BTC → USDC: picked on the Buy pill, a private swap through shielded ZEC, the default (${l})`);
check(/^No transaction links your BTC to your USDC: the ZEC between is shielded\. Only the amounts and the timing could hint at a link\.$/.test(await privacy(desk)), "BTC → USDC: the privacy line says what could still hint at a link");
await settle();
await shot(desk, "04-btc-usdc-route-1440");
await card(phone, "BTC → USDC", { sell: "btc", buy: "usdc-base", button: "Swap privately", line: /private/, priv: /No transaction links/ });
await settle();
await shot(phone, "04-btc-usdc-route-390");
await noOverflow(phone, "BTC → USDC");
await submit(desk).click();
await desk.getByRole("dialog", { name: "Swap privately" }).getByRole("button", { name: "Start private swap" }).click();
await desk.waitForURL(/\/app\/route\/r[0-9a-f]+$/);
const r1 = desk.url().split("/").pop();
await until(() => json(`${RT}/api/routes/${r1}`), (v) => v.state === "done", "BTC → USDC");
check(true, "BTC → USDC: both swaps done on the mock");

// ------------------------------------------------------------------------------ ZEC → SOL, SOL → ZEC: Ferry and NEAR Intents
await idle();
await openCard(desk, "zec", "btc");
await buyPill(desk).click();
const nearList = desk.getByRole("listbox", { name: "More via NEAR Intents" });
await nearList.waitFor();
await desk.getByRole("searchbox", { name: "Search by name or chain" }).fill("sol");
await nearList.getByRole("option", { name: /^SOL.*Solana/ }).click();
await ready(desk, "Sell ZEC for SOL");
l = await pathLine(desk);
check(/^Ferry BTC NEAR Intents · about \d+ min$/.test(l), `ZEC → SOL: Ferry, then NEAR Intents (${l})`);
check(/never goes to NEAR Intents\. The NEAR Intents part is public, and you trust NEAR Intents for it\.$/.test(await privacy(desk)), "ZEC → SOL: the privacy line");
await settle();
await shot(desk, "05-zec-sol-near-1440");
await card(phone, "ZEC → SOL", { sell: "zec", buy: near(SOL_ID), button: "Sell ZEC for SOL", line: /NEAR Intents/, priv: /never goes to NEAR Intents/ });
await settle();
await shot(phone, "05-zec-sol-near-390");
await submit(desk).click();
let dialog = desk.getByRole("dialog", { name: "Where should the SOL go?" });
await dialog.getByRole("textbox").fill(SOL);
await text(desk, "NEAR Intents accepts this Solana address.");
await dialog.getByRole("button", { name: "Start swap" }).click();
await desk.waitForURL(/\/app\/near\/n[0-9a-f]{16}$/);
const n1 = desk.url().split("/").pop();
await until(() => json(`${DEV}/api/near/status/${n1}`), (j) => j.state === "done", "ZEC → SOL");
check(true, "ZEC → SOL: the Ferry swap paid NEAR Intents, which delivered the SOL");

await idle();
await openCard(desk, "zec", near(SOL_ID));
await ready(desk, "Sell ZEC for SOL");
await desk.getByRole("button", { name: "Switch direction" }).click();
await ready(desk, "Buy ZEC with SOL");
l = await pathLine(desk);
check(/^NEAR Intents BTC Ferry · about \d+ min$/.test(l), `SOL → ZEC: the arrow, then NEAR Intents first (${l})`);
await settle();
await shot(desk, "06-sol-zec-near-1440");
await card(phone, "SOL → ZEC", { sell: near(SOL_ID), buy: "zec", button: "Buy ZEC with SOL", line: /^NEAR Intents/, priv: /no ZEC goes through NEAR Intents/ });
await settle();
await shot(phone, "06-sol-zec-near-390");
await submit(desk).click();
dialog = desk.getByRole("dialog", { name: "Where should a refund go?" });
await dialog.getByRole("textbox").fill(SOL);
await text(desk, "NEAR Intents accepts this Solana address.");
await dialog.getByRole("button", { name: "Get deposit address" }).click();
await desk.waitForURL(/\/app\/near\/n[0-9a-f]{16}$/);
const n2 = desk.url().split("/").pop();
let job = await json(`${DEV}/api/near/status/${n2}`);
await post(ONE, "/_mock/deposit", { depositAddress: job.near.deposit_address });
await until(() => json(`${DEV}/api/near/status/${n2}`), (j) => j.state === "done", "SOL → ZEC");
check(true, "SOL → ZEC: NEAR Intents delivered BTC to the B node, and the Ferry buy finished");

// ------------------------------------------------------------------------------ USDC → SOL: a private swap, then NEAR Intents
const comboOf = (id) => json(`${DEV}/api/near/combo/${id}`);
await idle();
await openCard(desk, "btc", near(SOL_ID));
await sellPill(desk).click();
await desk.getByRole("listbox", { name: "Tokens" }).getByRole("option", { name: /^USDC/ }).click();
await ready(desk, "Swap privately");
l = await pathLine(desk);
check(/^Ferry shielded ZEC Ferry BTC NEAR Intents · private · about 40–80 min$/.test(l), `USDC → SOL: through shielded ZEC, then NEAR Intents (${l})`);
check(/^No transaction links your two Ferry swaps: the ZEC between is shielded, though amounts and timing could hint at a link\. The NEAR Intents part is public, and you trust NEAR Intents for it\.$/.test(await privacy(desk)), "USDC → SOL: the privacy line");
await desk.waitForFunction(() => /1 USDC ≈ [\d.]+ SOL · at least [\d.]+ SOL/.test(document.body.innerText), null, { timeout: 20_000 });
await settle();
await shot(desk, "07-usdc-sol-route-near-1440");
await card(phone, "USDC → SOL", { sell: "usdc-base", buy: near(SOL_ID), button: "Swap privately", line: /NEAR Intents · private/, priv: /two Ferry swaps/ });
await settle();
await shot(phone, "07-usdc-sol-route-near-390");
await noOverflow(phone, "USDC → SOL");
await submit(desk).click();
dialog = desk.getByRole("dialog", { name: "Where should the SOL go?" });
await dialog.getByRole("textbox", { name: /your SOL address on Solana/i }).fill(SOL);
await text(desk, "NEAR Intents accepts this Solana address.");
for (const t of ["Your coins pass through the shielded pool", "The NEAR Intents part is public", "It takes longer", "If something stops"]) await text(desk, t);
await settle();
await shot(desk, "07b-usdc-sol-confirm-1440");
await dialog.getByRole("button", { name: "Start private swap" }).click();
await desk.waitForURL(/\/app\/combo\/c[0-9a-f]{16}$/);
const c1 = desk.url().split("/").pop();
let c = await comboOf(c1);
const routed = await json(`${RT}/api/routes/${c.route.id}`);
check(c.kind === "route-near" && routed.payout_to === c.back.deposit_address, "USDC → SOL: the route's second swap pays NEAR Intents' deposit address, made by the server");
const q1 = (await json(ONE + "/_mock/quotes")).find((x) => x.depositAddress === c.back.deposit_address);
check(q1.request.recipient === SOL && q1.request.originAsset === "nep141:btc.omft.near", "USDC → SOL: NEAR Intents turns the BTC into SOL for your address");
await phone.goto(`${DEV}/app/combo/${c1}`);
await until(comboOf.bind(null, c1), (x) => x.route.state === "pausing" || x.route.state === "leg2" || x.state === "near_out", "the pause");
await phone.waitForFunction(() => /Swapping USDC for SOL privately|Sending your SOL/.test(document.body.innerText), null, { timeout: 20_000 });
await settle();
await shot(desk, "07c-usdc-sol-progress-1440");
await shot(phone, "07c-usdc-sol-progress-390");
await noOverflow(phone, "combo progress");
c = await until(comboOf.bind(null, c1), (x) => x.state === "done", "USDC → SOL");
await text(desk, "You received");
check(c.back.status === "SUCCESS" && c.back.details.amount_out, `USDC → SOL: done, ${c.back.details.amount_out} lamports delivered`);
await settle();
await shot(desk, "07d-usdc-sol-done-1440");

// ------------------------------------------------------------------------------ SOL → USDC: NEAR Intents, then a private swap
await idle();
await openCard(desk, "usdc-base", near(SOL_ID));
await ready(desk, "Swap privately");
await desk.getByRole("button", { name: "Switch direction" }).click();
await ready(desk, "Swap privately");
l = await pathLine(desk);
check(/^NEAR Intents BTC Ferry shielded ZEC Ferry · private · about 40–80 min$/.test(l), `SOL → USDC: the arrow; NEAR Intents first, then through shielded ZEC (${l})`);
await settle();
await shot(desk, "08-sol-usdc-near-route-1440");
await card(phone, "SOL → USDC", { sell: near(SOL_ID), buy: "usdc-base", button: "Swap privately", line: /^NEAR Intents BTC Ferry/, priv: /two Ferry swaps/ });
await settle();
await shot(phone, "08-sol-usdc-near-route-390");
await submit(desk).click();
dialog = desk.getByRole("dialog", { name: "Where should a refund go?" });
await dialog.getByRole("textbox").fill(SOL);
await text(desk, "NEAR Intents accepts this Solana address.");
await dialog.getByRole("button", { name: "Get deposit address" }).click();
await desk.waitForURL(/\/app\/combo\/c[0-9a-f]{16}$/);
const c2 = desk.url().split("/").pop();
await desk.locator("[data-near-deposit]").waitFor();
check(/Send exactly.*SOL.*To NEAR Intents' deposit address/.test(await desk.locator("[data-near-deposit]").textContent()), "SOL → USDC: the deposit screen, how much SOL and where to");
await settle();
await shot(desk, "08b-sol-usdc-deposit-1440");
await phone.goto(`${DEV}/app/combo/${c2}`);
await phone.locator("[data-near-deposit]").waitFor();
await settle();
await shot(phone, "08b-sol-usdc-deposit-390");
await noOverflow(phone, "combo deposit");
c = await comboOf(c2);
const q2 = (await json(ONE + "/_mock/quotes")).find((x) => x.depositAddress === c.front.deposit_address);
check(q2.request.swapType === "EXACT_INPUT" && q2.request.refundTo === SOL && q2.request.recipient === c.own_in, "SOL → USDC: NEAR Intents delivers BTC to your own B node, and refunds SOL to your address");
await post(ONE, "/_mock/deposit", { depositAddress: c.front.deposit_address });
c = await until(comboOf.bind(null, c2), (x) => !!x.route.id, "the route after NEAR Intents delivered");
const routed2 = await json(`${RT}/api/routes/${c.route.id}`);
check(routed2.from === "btc" && routed2.to === "usdc-base" && !routed2.payout_to, "SOL → USDC: once the BTC arrived, the server started the private swap BTC → USDC");
c = await until(comboOf.bind(null, c2), (x) => x.state === "done", "SOL → USDC");
check(c.route.out > 0, `SOL → USDC: done, ${c.route.out} USDC units in your node`);

// ------------------------------------------------------------------------------ SOL → USDT (Tron): NEAR Intents at both ends
await idle();
await openCard(desk, near(SOL_ID), "usdc-base");
await buyPill(desk).click();
await desk.getByRole("searchbox", { name: "Search by name or chain" }).fill("usdt");
await desk.getByRole("listbox", { name: "More via NEAR Intents" }).getByRole("option", { name: /^USDT.*Tron/ }).click();
await ready(desk, "Swap privately");
l = await pathLine(desk);
check(/^NEAR Intents BTC Ferry shielded ZEC Ferry LTC NEAR Intents · private · about 45–85 min$/.test(l), `SOL → USDT: NEAR Intents, shielded ZEC, NEAR Intents (${l})`);
await settle();
await shot(desk, "09-sol-usdt-near-near-1440");
await card(phone, "SOL → USDT", { sell: near(SOL_ID), buy: near(USDT_TRON), button: "Swap privately", line: /LTC NEAR Intents/, priv: /two Ferry swaps/ });
await settle();
await shot(phone, "09-sol-usdt-near-near-390");
await noOverflow(phone, "SOL → USDT");
await submit(desk).click();
dialog = desk.getByRole("dialog", { name: "Where should the USDT go?" });
await dialog.getByRole("textbox", { name: /your USDT address on Tron/i }).fill(TRON);
await dialog.getByRole("textbox", { name: /Your SOL address on Solana, for a refund/ }).fill(SOL);
await text(desk, "NEAR Intents accepts this Tron address.");
await text(desk, "NEAR Intents accepts this Solana address.");
await settle();
await shot(desk, "09b-sol-usdt-confirm-1440");
await dialog.getByRole("button", { name: "Get deposit address" }).click();
await desk.waitForURL(/\/app\/combo\/c[0-9a-f]{16}$/);
const c3 = desk.url().split("/").pop();
c = await comboOf(c3);
await post(ONE, "/_mock/deposit", { depositAddress: c.front.deposit_address });
c = await until(comboOf.bind(null, c3), (x) => !!x.route.id && !!x.back, "the route and the second quote");
const routed3 = await json(`${RT}/api/routes/${c.route.id}`);
const q3 = (await json(ONE + "/_mock/quotes")).find((x) => x.depositAddress === c.back.deposit_address);
check(routed3.from === "btc" && routed3.to === "ltc" && routed3.payout_to === c.back.deposit_address && q3.request.recipient === TRON && q3.request.refundTo === c.own_out, "SOL → USDT: BTC → shielded ZEC → LTC, paid to NEAR Intents, which sends USDT to your Tron address (refunds to your LTC node)");
c = await until(comboOf.bind(null, c3), (x) => x.state === "done", "SOL → USDT");
check(c.back.status === "SUCCESS", "SOL → USDT: done");
await desk.goto(`${DEV}/app/combo/${c3}`);
await text(desk, "You received");
await settle();
await shot(desk, "09c-sol-usdt-done-1440", { fullPage: true });

// ------------------------------------------------------------------------------ what this server can't run, in a sentence
const off = async (p, sell, buy, reason, name) => {
  await openCard(p, sell, buy);
  await p.locator("[data-off-reason]").waitFor();
  await p.waitForFunction((r) => document.querySelector("[data-off-reason]")?.textContent === r, reason, { timeout: 20_000 });
  check((await submit(p).isDisabled()) && (await sellPill(p).isVisible()) && (await buyPill(p).isVisible()), `${name}: "${reason}" (both coins still on their pills, the button off)`);
};
await off(desk, "usdc-base", "zec", "Buying ZEC with USDC isn't available on this server.", "USDC → ZEC");
await settle();
await shot(desk, "10-off-usdc-zec-1440");
await off(phone, "usdc-base", "zec", "Buying ZEC with USDC isn't available on this server.", "USDC → ZEC (390)");
await settle();
await shot(phone, "10-off-usdc-zec-390");
await off(desk, "zec", "weth-arbitrum", "Selling ZEC for WETH isn't available on this server.", "ZEC → WETH");
await off(desk, "ltc", "usdc-base", "Private swaps can't start from LTC on this server.", "LTC → USDC");
await off(desk, "btc", "btc", "That's the same coin on both sides. Pick a different one.", "BTC → BTC");
await off(desk, "usdc-base", near(USDC_SOL), "USDC for USDC would put about the same amount on both sides, which links them. Pick two different coins.", "USDC on Base → USDC on Solana");
await off(desk, near(SOL_ID), near(SOL_ID), "That's the same coin on both sides. Pick a different one.", "SOL → SOL");
// picking the other side's coin swaps the two
await openCard(desk, "zec", "btc");
await ready(desk, "Sell ZEC");
await buyPill(desk).click();
await desk.getByRole("listbox", { name: "Tokens" }).getByRole("option", { name: /^ZEC/ }).click();
await ready(desk, "Buy ZEC");
check(true, "picking ZEC on the Buy side swaps the two: BTC → ZEC");
// a server without a router
const plain = await page(1440);
await plain.goto(`${PRD2}/app?sell=btc&buy=usdc-base`);
await plain.waitForFunction(() => document.querySelector("[data-off-reason]")?.textContent === "This server has no router, so coin-to-coin swaps aren't available here.", null, { timeout: 20_000 });
check(true, 'no router: "This server has no router, so coin-to-coin swaps aren\'t available here."');
await settle();
await shot(plain, "11-off-no-router-1440");
await plain.close();

// ------------------------------------------------------------------------------ the panel, full
await idle();
for (const p of [desk, phone]) {
  await p.goto(DEV + "/app?sell=zec&buy=btc");
  await p.locator("[data-recent] li").first().waitFor();
}
const rows = await desk.locator("[data-recent] li a").evaluateAll((els) => els.map((a) => [a.getAttribute("href"), a.textContent]));
check(rows.length === 7, `"Recent activity" lists the latest 7 of ${8} swaps`);
check(["/app/combo/", "/app/near/", "/app/route/", "/app/swap/"].every((h) => rows.some(([href]) => href.startsWith(h))), "its rows open every kind of progress page");
check(rows[0][0] === `/app/combo/${c3}` && /Private swap/.test(rows[0][1]) && /via NEAR Intents/.test(rows[0][1]), `newest first: the SOL → USDT swap (${rows[0][1].slice(0, 60)})`);
await ready(desk, "Sell ZEC");
check(await aligned(), "full, the panel still ends level with the card's button");
check(await desk.locator("[data-recent-list]").evaluate((ul) => ul.scrollHeight > ul.clientHeight), "... and its list scrolls inside it");
await settle();
await shot(desk, "12-recent-1440");
await phone.locator("[data-recent]").evaluate((el) => el.scrollIntoView({ block: "start" }));
// clear of the sticky header (two rows on a phone)
await phone.evaluate(() => window.scrollBy(0, -140));
await settle();
await shot(phone, "12-recent-390");
await noOverflow(phone, "the panel");
await desk.locator("[data-recent]").getByRole("link", { name: /View all/ }).click();
await desk.waitForURL(/\/app\/activity$/);
await desk.waitForFunction(() => document.querySelectorAll("main ul > li").length >= 8, null, { timeout: 20_000 }).catch(() => {});
const all = await desk.locator("main ul > li").count();
check(all === 8, `"View all" opens /app/activity: one row per swap, 8 (${all})`);

// ------------------------------------------------------------------------------ the opt-out: NEAR Intents alone, for two coins
await idle();
const routesBefore = (await json(RT + "/api/routes")).length;
const optOut = async (p) => {
  await openCard(p, "btc", "usdc-base");
  await ready(p, "Swap privately");
  await p.getByRole("button", { name: /^Settings: privacy pause/ }).click();
  await p.getByRole("radiogroup", { name: "Route" }).waitFor();
};
await optOut(desk);
const pub = desk.getByRole("radio", { name: /^Faster, but public: via NEAR Intents only/ });
check(/Anyone can link what you sold to what you got/.test(await pub.textContent()) && (await desk.getByRole("radio", { name: /^Private, through shielded ZEC/ }).getAttribute("aria-checked")) === "true", "BTC → USDC: the settings offer the opt-out, NEAR Intents alone, with its cost; private is checked");
await settle();
await shot(desk, "14-opt-out-settings-1440");
await pub.click();
await ready(desk, "Swap through NEAR Intents");
l = await pathLine(desk);
check(/^NEAR Intents · public · about \d+/.test(l), `opted out: the path line says public (${l})`);
check(/^Faster, but public: anyone can link what you sold to what you got/.test(await privacy(desk)), "opted out: the privacy line says what it costs");
await settle();
await shot(desk, "14b-btc-usdc-public-1440");
await optOut(phone);
await phone.getByRole("radio", { name: /^Faster, but public/ }).click();
await ready(phone, "Swap through NEAR Intents");
await settle();
await shot(phone, "14b-btc-usdc-public-390");
await noOverflow(phone, "the public card");
await desk.reload();
await ready(desk, "Swap through NEAR Intents");
check(true, "the opt-out is remembered for BTC → USDC");
await openCard(desk, "usdc-base", "btc");
await ready(desk, "Swap privately");
check(true, "... and only for those two coins: USDC → BTC stays private");
await openCard(desk, "btc", "usdc-base");
await ready(desk, "Swap through NEAR Intents");
await submit(desk).click();
dialog = desk.getByRole("dialog", { name: "Where should the USDC go?" });
await dialog.getByRole("textbox", { name: /your USDC address on Base/i }).fill("0x2527D02599Ba641c19FEa793cD0F167589a0f10D");
await dialog.getByRole("textbox", { name: /Your BTC address on Bitcoin, for a refund/ }).fill("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
await text(desk, "NEAR Intents accepts this Base address.");
await text(desk, "NEAR Intents accepts this Bitcoin address.");
await text(desk, "This swap is public");
await settle();
await shot(desk, "14c-public-confirm-1440");
await dialog.getByRole("button", { name: "Get deposit address" }).click();
await desk.waitForURL(/\/app\/combo\/c[0-9a-f]{16}$/);
const c4 = desk.url().split("/").pop();
c = await comboOf(c4);
const q4 = (await json(ONE + "/_mock/quotes")).find((x) => x.depositAddress === c.front.deposit_address);
check(c.kind === "near-only" && q4.request.recipient === "0x2527D02599Ba641c19FEa793cD0F167589a0f10D" && q4.request.refundTo === "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "opted out: NEAR Intents alone, from your own wallet to your own address");
await post(ONE, "/_mock/deposit", { depositAddress: c.front.deposit_address });
c = await until(comboOf.bind(null, c4), (x) => x.state === "done", "the public swap");
check((await json(RT + "/api/routes")).length === routesBefore, "opted out: done, and no private swap ran");
await text(desk, "public, end to end");
await settle();
await shot(desk, "14d-public-done-1440");
await openCard(desk, "btc", "usdc-base");
await ready(desk, "Swap through NEAR Intents");
await desk.getByRole("button", { name: /^Settings: route public/ }).click();
await desk.getByRole("radio", { name: /^Private, through shielded ZEC/ }).click();
await ready(desk, "Swap privately");
check(true, "back to private in one tap");

// ------------------------------------------------------------------------------ production: the public demo
const info = await json(PRD + "/api/near/tokens");
check(info.execution.sell === false && info.compose && info.compose.runs === false && info.reason === "demo", "prod (public demo): a router and NEAR Intents' quotes, no NEAR swaps");
const demo = await page(1440);
await demo.goto(`${PRD}/app?sell=usdc-base&buy=${encodeURIComponent(near(SOL_ID))}`);
await demo.getByRole("button", { name: "Swap on your own node" }).waitFor();
await demo.waitForFunction(() => /1 USDC ≈ [\d.]+ SOL/.test(document.body.innerText), null, { timeout: 20_000 });
check(await demo.getByRole("button", { name: "Swap on your own node" }).isDisabled(), "prod demo: USDC → SOL quotes, and its button says it runs on your own node");
await text(demo, "Quote only.");
await settle();
await shot(demo, "13-demo-quote-only-1440");
await demo.close();
let r = await post(PRD, "/api/near/combo", { kind: "route-near", route: { from: "usdc-base", to: "btc", zec_zat: 50_000_000, maker1: "Godwit", maker2: ["Kestrel"], max_in: 25_000_000, min_out: 1, pause: "off" }, asset_out: SOL_ID, address: SOL, min_asset_out: "1" });
check(r.status === 403, `prod demo: a visitor can't start a private swap that pays NEAR Intents (${r.status})`);
await idle();
r = await post(PRD, "/router/api/routes", { from: "btc", to: "usdc-base", zec_zat: 20_000_000, maker1: "Sandpiper", maker2: ["Egret"], max_in: 90_000, min_out: 7_000_000, pause: "off", payout_to: "bcrt1qattacker000000000000000000000000000000" });
const made = await r.json();
check(r.status === 201 && (await json(`${RT}/api/routes/${made.id}`)).payout_to == null, "prod demo: a browser's payout_to never reaches the router (the route pays the node's own wallet)");
await until(() => json(`${RT}/api/routes/${made.id}`), (v) => ["done", "holding", "failed"].includes(v.state), "the demo route", 2400);

await browser.close();
console.log(shots.join("\n"));
process.exit(0);
