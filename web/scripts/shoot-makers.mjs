// `node scripts/shoot-makers.mjs`: the swap partners on /app at 1440 and 390, against the node
// mock and its mock makers (mock/makers.mjs), into screenshots/app/makers/. The swap card quotes
// the best partner by itself; the settings pill above it lists every partner and lets you pick
// one. Firm prices (POST /api/quotes) replace a partner's indicative rate when it gives one. Then
// the same flow through the production server (server/prod.mjs, needs `pnpm build` first):
// GET /api/makers, POST /api/quotes, a swap started by maker name and by firm quote, a raw URL
// refused, and the quote rate limit. SHOOT_OUT=dir puts the screenshots elsewhere, SHOOT_THEME=dark
// takes them in dark mode.
//
// Several swaps at once: the card says how many more swaps its partner takes ("Partner online ·
// can take 4 more swaps"), a full partner is listed as busy and another one quotes, every partner
// full is said calmly, three swaps in progress are listed together (and the card still starts
// another), and through the production server a sell runs beside a buy until the node's cap
// (MOCK_MAX_SWAPS, 4), where the next start is "Every partner is busy right now".
//
// Ports (override with SHOOT_PORT_BASE): mock Z base+11, B base+12, Vite base+51, prod base+52;
// SHOOT_VITE_PORT and SHOOT_PROD_PORT set those two on their own.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { mockMakersEnv } from "../mock/makers.mjs";

const BASE_PORT = Number(process.env.SHOOT_PORT_BASE ?? 7800);
const Z = BASE_PORT + 11;
const B = BASE_PORT + 12;
const VITE = Number(process.env.SHOOT_VITE_PORT ?? BASE_PORT + 51);
const PROD = Number(process.env.SHOOT_PROD_PORT ?? BASE_PORT + 52);
const BUSY_TEXT = "Every partner is busy right now. Try again in a few minutes.";
const OUT = (process.env.SHOOT_OUT ?? new URL("../screenshots/app/makers/", import.meta.url).pathname).replace(/\/?$/, "/");
mkdirSync(OUT, { recursive: true });

const env = {
  ...process.env,
  MOCK_SPEED: "4",
  MOCK_Z_PORT: String(Z),
  MOCK_B_PORT: String(B),
  FERRY_Z_URL: `http://127.0.0.1:${Z}`,
  FERRY_B_URL: `http://127.0.0.1:${B}`,
  FERRY_MAKERS: mockMakersEnv(B),
  FERRY_Z_TOKEN: "",
  FERRY_B_TOKEN: "",
};
const procs = [
  spawn(process.execPath, ["mock/server.mjs"], { env, stdio: "ignore" }),
  spawn("pnpm", ["exec", "vite", "--port", String(VITE), "--strictPort"], { env: { ...env, PORT: String(VITE) }, stdio: "ignore" }),
  spawn(process.execPath, ["server/prod.mjs"], { env: { ...env, PORT: String(PROD), HOST: "127.0.0.1", DEMO_MAX_ZAT: "200000000", DEMO_QUOTES_PER_MIN: "20", DEMO_RATE_PER_HOUR: "10", DEMO_SWAPS_PER_HOUR: "20" }, stdio: "inherit" }),
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
await Promise.all([up(DEV), up(PRD + "/healthz"), up(`http://127.0.0.1:${B}/peer/offer`)]);

const check = (cond, msg) => {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("ok:", msg);
};
const post = (base, path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const reset = () => post(`http://127.0.0.1:${Z}`, "/api/_mock/reset", {});

// ------------------------------------------------------------------------------ dev server shots
const browser = await chromium.launch();
const shots = [];
async function page(width) {
  const p = await browser.newPage({ viewport: { width, height: width < 500 ? 844 : 900 }, colorScheme: process.env.SHOOT_THEME === "dark" ? "dark" : "light" });
  p.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && console.log(`[${width}]`, m.text()));
  return p;
}
const shot = async (p, name, opts = {}) => {
  const path = OUT + name + ".png";
  await p.screenshot({ path, ...opts });
  shots.push(path);
};
const text = (p, s) => p.waitForFunction((s) => document.body.innerText.includes(s), s, { timeout: 10_000 });
// the swap card's rate line, with or without a firm price: "1 ZEC = 0.0041 BTC · firm for 28 s · from Bram"
const rateLine = (p, rate, maker, firm = null) =>
  p.waitForFunction(
    ([rate, maker, firm]) => {
      const m = document.body.innerText.match(/1 ZEC = (\S+) BTC( · firm for \d+ s)? · from ([^\n]+)/);
      return !!m && m[1] === rate && m[3].trim() === maker && (firm === null || !!m[2] === firm);
    },
    [rate, maker, firm],
    { timeout: 10_000 },
  );
const radios = '[role="radiogroup"][aria-label="Swap partner"] [role="radio"]';
const settings = (p) => p.getByRole("button", { name: /^Settings/ });
const partner = (p, name) => p.getByRole("radio", { name });

await reset();
const desk = await page(1440);
await desk.goto(DEV + "/app");
// with no pick, the card quotes the best rate that can fill 1 ZEC: Kestrel, 412350 sat/ZEC
await rateLine(desk, "0.0041235", "Kestrel");
check(true, "the swap card picks the best rate by itself (Kestrel)");
// ...and, a moment later, Kestrel's firm price for the 1 ZEC bucket
await rateLine(desk, "0.0041235", "Kestrel", true);
check(true, "the rate line shows Kestrel's firm price with its countdown");
await text(desk, "Partner online · can take 4 more swaps");
check(true, "the card says how many more swaps the partner takes (Kestrel: 4)");
await sleep(400);
await shot(desk, "01-swap-1440");

await settings(desk).click();
await desk.getByRole("radiogroup", { name: "Swap partner" }).waitFor();
await desk.waitForFunction((sel) => document.querySelectorAll(sel).length === 6, radios);
check((await partner(desk, /^Best rate/).getAttribute("aria-checked")) === "true", "settings list Best rate (checked) and the 5 partners");
await desk.waitForFunction((sel) => [...document.querySelectorAll(sel)].filter((r) => /Firm price for \d+ s/.test(r.textContent)).length === 3, radios);
check(true, "the partner list marks the 3 firm prices (Kestrel, Bram, Heron)");
await sleep(300);
await shot(desk, "01-makers-1440");

// pick Bram: the quote follows its rate (410000 sat/ZEC)
await partner(desk, /Bram/).click();
await rateLine(desk, "0.0041", "Bram", true);
check(true, "picking Bram updates the quote to its (firm) rate");

// offline and paused partners can't be picked
await partner(desk, /Plover/).click({ force: true });
await partner(desk, /Wren/).click({ force: true });
check((await partner(desk, /Bram/).getAttribute("aria-checked")) === "true", "offline/paused rows don't take the selection");

// pick Kestrel: 412350 sat/ZEC, 1 ZEC → 0.0041235 less the 2000 sat fee
await partner(desk, /Kestrel/).click();
await rateLine(desk, "0.0041235", "Kestrel", true);
check(true, "picking Kestrel updates the quote to its rate");
await shot(desk, "02-kestrel-selected-1440");
await desk.keyboard.press("Escape");
await desk.getByRole("dialog").waitFor({ state: "detached" });
check(/^Settings/.test((await desk.evaluate(() => document.activeElement?.getAttribute("aria-label"))) ?? ""), "Escape closes the settings and returns focus to the pill");

// more than Kestrel can fill: the best partner that can (Bram) takes it, and says why
await desk.locator("input[inputmode=decimal]").fill("3.00");
await text(desk, "Kestrel can fill up to 2.40 ZEC right now, so Bram takes this one.");
check(true, "liquidity limit: another partner takes the amount, with the reason shown");
await shot(desk, "03-kestrel-liquidity-1440");
await rateLine(desk, "0.0041", "Bram", true);
check(true, "...at Bram's firm price for the 5 ZEC bucket");
await desk.locator("input[inputmode=decimal]").fill("1.00");
await text(desk, "from Kestrel");
check(true, "a picked partner comes back once it can fill the amount");

// start with Heron (min 1 ZEC): the swap runs at Heron's rate
await settings(desk).click();
await partner(desk, /Heron/).click();
await desk.keyboard.press("Escape");
await rateLine(desk, "0.004089", "Heron OTC", true);
await desk.locator("form button[type=submit]").click();
await desk.waitForURL(/\/app\/swap\//);
const id = desk.url().split("/").pop();
const sv = await (await fetch(`http://127.0.0.1:${Z}/api/swaps/${id}`)).json();
check(sv.amounts.btc_sat === 408900, `swap started with Heron at its firm rate (btc_sat ${sv.amounts.btc_sat})`);

// the token picker: every pair listed, only the ones with a daemon here can be picked
await reset();
await sleep(400);
await desk.goto(DEV + "/app");
await text(desk, "from Kestrel");
await desk.getByRole("button", { name: /^You get .*Choose another coin/ }).click();
const listbox = desk.getByRole("listbox", { name: "Tokens" });
await listbox.waitFor();
const options = await listbox.getByRole("option").evaluateAll((els) => els.map((e) => [e.textContent, e.getAttribute("aria-disabled")]));
check(options.length === 11 && /^ZEC/.test(options[0][0]) && /^BTC/.test(options[1][0]) && options.filter(([t]) => /not available here/.test(t)).length === 9 && options.every(([, off]) => off === "false"), `the token picker lists shielded ZEC on top and all 10 pairs, the 9 this server doesn't swap marked not available here, every one pickable (${options.length})`);
await shot(desk, "06-token-picker-1440");
await desk.keyboard.press("Escape");
check(/Choose another coin/.test((await desk.evaluate(() => document.activeElement?.getAttribute("aria-label"))) ?? ""), "Escape closes the token picker and returns focus to the coin pill");

// a host that caps swaps below 1 ZEC (the public demo): the card starts at the cap
const capped = await page(1440);
await capped.route("**/api/makers", async (r) => {
  const { makers } = await (await r.fetch()).json();
  for (const m of makers) if (m.max_zat != null) m.max_zat = Math.min(m.max_zat, 50_000_000);
  await r.fulfill({ json: { makers } });
});
await capped.goto(DEV + "/app");
await capped.waitForFunction(() => document.querySelector("input[inputmode=decimal]")?.value === "0.50", null, { timeout: 10_000 });
check(true, "partners capped below 1 ZEC set the starting amount (0.50)");
await capped.close();

// ------------------------------------------------------------------------------ several swaps at once
// A partner that is full (it already runs as many swaps as it takes at once) says so in the list,
// and the next best partner quotes; with every partner full the card says so calmly. The maker
// list is edited on its way to the page, as a full partner's offer would make it.
async function withFull(width, full) {
  const p = await page(width);
  await p.route("**/api/makers", async (r) => {
    const { makers } = await (await r.fetch()).json();
    for (const m of makers) if (full(m)) Object.assign(m, { busy: true, available: false, free_slots: 0 });
    await r.fulfill({ json: { makers } });
  });
  await p.goto(DEV + "/app");
  return p;
}
const message = (p) => p.evaluate(() => {
  const el = document.getElementById("swap-message");
  return { text: el?.textContent ?? "", calm: !!el?.className.includes("text-slate-600") };
});
await reset();
await sleep(400);
const oneFull = await withFull(1440, (m) => m.name === "Kestrel");
await rateLine(oneFull, "0.0041", "Bram");
await text(oneFull, "Partner online · can take 4 more swaps");
check(true, "Kestrel full: Bram quotes, and says it can take 4 more swaps");
// a firm price from the full partner isn't used either: Bram's own firm price comes in
await rateLine(oneFull, "0.0041", "Bram", true);
await sleep(1500);
await rateLine(oneFull, "0.0041", "Bram", true);
check(true, "...at Bram's firm price, never the full partner's");
await settings(oneFull).click();
await oneFull.getByRole("radiogroup", { name: "Swap partner" }).waitFor();
const kestrelRow = await partner(oneFull, /Kestrel/).textContent();
check(/Busy · try again in a few minutes/.test(kestrelRow) && (await partner(oneFull, /Kestrel/).getAttribute("aria-disabled")) === "true", `the settings list Kestrel as busy, not pickable (${kestrelRow})`);
check(/can take 4 more swaps/i.test(await partner(oneFull, /^Bram/).textContent()), "...and Bram with its free slots");
await sleep(300);
await shot(oneFull, "08-partner-busy-1440");
await oneFull.close();
for (const width of [1440, 390]) {
  const allFull = await withFull(width, (m) => m.role === "B");
  await text(allFull, BUSY_TEXT);
  const m = await message(allFull);
  check(m.text === BUSY_TEXT && m.calm, `every partner full (${width}): "${m.text}", calm, not as an error`);
  check(await allFull.locator("form button[type=submit]").isDisabled(), `...and nothing to press (${width})`);
  await sleep(300);
  await shot(allFull, `09-all-busy-${width}`);
  await allFull.close();
}

// three swaps in progress at once: all listed in Recent activity, and the card still starts one
await reset();
await sleep(400);
for (const zat of [20_000_000, 30_000_000, 40_000_000]) {
  const r = await post(`http://127.0.0.1:${Z}`, "/api/swaps", { maker: `http://127.0.0.1:${B}/m/kestrel`, zec_zat: zat });
  check(r.status === 201, `mock: swap of ${zat / 1e8} ZEC started beside the others (${r.status})`);
}
const several = await page(1440);
await several.goto(DEV + "/app");
await several.waitForFunction(() => document.querySelectorAll("[data-recent-list] li").length === 3, null, { timeout: 10_000 });
check(true, "Recent activity lists the 3 swaps in progress");
await text(several, "from Kestrel");
const free = await several.locator("form button[type=submit]").isEnabled();
check(free, "a swap in progress no longer holds the card back: Sell ZEC can be pressed");
await sleep(600);
await shot(several, "10-several-live-1440");
const severalPhone = await page(390);
await severalPhone.goto(DEV + "/app");
await text(severalPhone, "You have 3 swaps in progress");
check(true, "on a phone, one banner for the 3 swaps in progress, to Activity");
await sleep(400);
await shot(severalPhone, "10-several-live-390", { fullPage: true });
// a fourth from the card fills this node (MOCK_MAX_SWAPS 4); then the card says it is busy
await several.locator("input[inputmode=decimal]").fill("0.50");
await several.locator("form button[type=submit]").click();
await several.waitForURL(/\/app\/swap\//);
check(true, "the card started a 4th swap beside the 3");
await several.goto(DEV + "/app");
await text(several, BUSY_TEXT);
const m4 = await message(several);
check(m4.text === BUSY_TEXT && m4.calm, `with 4 live swaps the node is full: "${m4.text}"`);
await several.close();
await severalPhone.close();

// mobile
await reset();
await sleep(400);
const phone = await page(390);
await phone.goto(DEV + "/app");
await text(phone, "from Kestrel");
await sleep(400);
await shot(phone, "04-swap-390");
await settings(phone).click();
await phone.getByRole("radiogroup", { name: "Swap partner" }).waitFor();
await sleep(400);
await shot(phone, "04-makers-390");
const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check(overflow <= 0, `no horizontal scroll at 390 (overflow ${overflow}px)`);
await partner(phone, /Bram/).click();
await phone.keyboard.press("Escape");
await rateLine(phone, "0.0041", "Bram");
await shot(phone, "05-bram-selected-390", { fullPage: true });

// ------------------------------------------------------------------------------ production server
await reset();
await sleep(400);
const list = (await (await fetch(PRD + "/api/makers")).json()).makers;
check(list.length === 8, "prod /api/makers lists the 8 allowlisted makers");
check(list.filter((m) => m.role === "B").length === 4 && list.filter((m) => m.role === "Z").length === 3, "4 of them buy ZEC (role B), 3 sell it (role Z), Plover is offline");
check(list.every((m) => !("url" in m) && !("error" in m)), "prod /api/makers exposes no URLs or error details");
const heron = list.find((m) => m.name === "Heron OTC");
check(heron.max_zat === 200000000 && heron.liquidity_zat === 200000000, "demo limit clamps a maker's range and liquidity");
check(list.find((m) => m.name === "Plover").online === false, "offline maker reported offline");
check(list.find((m) => m.name === "Wren").paused === true, "paused maker reported paused");

let r = await post(PRD, "/daemon/z/api/swaps", { maker: `http://127.0.0.1:${B}/m/kestrel`, zec_zat: 50000000 });
check(r.status === 400, `raw maker URL refused (${r.status} ${(await r.json()).error})`);
r = await post(PRD, "/daemon/z/api/swaps", { maker: "http://169.254.169.254", zec_zat: 50000000 });
check(r.status === 400, "SSRF-style URL refused");
r = await post(PRD, "/daemon/z/api/swaps", { maker: 1, zec_zat: 50000000 });
const started = await r.json();
check(r.status === 201, `swap by maker index starts (${r.status})`);
const sv2 = await (await fetch(`http://127.0.0.1:${Z}/api/swaps/${started.id}`)).json();
check(sv2.amounts.btc_sat === Math.round(0.5 * 412350), "index 1 resolved to Kestrel's allowlisted URL");

// firm quotes through the production server: verified, best first, nothing private
await reset();
await sleep(400);
const quotes = async (body) => {
  const r = await post(PRD, "/api/quotes", body);
  return [r.status, await r.json()];
};
let [qs, qb] = await quotes({ pair: "btc", direction: "sell", zec_zat: 70_000_000 });
check(qs === 200 && qb.bucket_zat === 100_000_000, `prod /api/quotes rounds 0.7 ZEC up to the 1 ZEC bucket (${qs}, ${qb.bucket_zat})`);
check(qb.quotes.map((q) => q.maker).join() === "Kestrel,Bram", `firm quotes best first, only those covering 0.7 ZEC (${qb.quotes.map((q) => q.maker)})`);
check(qb.quotes.every((q) => Object.keys(q).sort().join() === "expires_in_ms,index,maker,max_zat,min_zat,quote_id,rate_sat_per_zec" && q.expires_in_ms > 20_000), "quotes carry no URL, key or error");
[qs, qb] = await quotes({ pair: "btc", direction: "sell", zec_zat: 300_000_000 });
check(qs === 400, "an amount above the demo limit gets no quotes");
r = await post(PRD, "/daemon/z/api/swaps", { maker: "Kestrel", zec_zat: 70_000_000, quote: "ab".repeat(16) });
check(r.status === 400 && /expired/.test((await r.json()).error), "a quote the server doesn't hold is refused");
[qs, qb] = await quotes({ pair: "btc", direction: "sell", zec_zat: 70_000_000 });
const kq = qb.quotes.find((q) => q.maker === "Kestrel");
r = await post(PRD, "/daemon/z/api/swaps", { maker: "Bram", zec_zat: 70_000_000, quote: kq.quote_id });
check(r.status === 400, "Kestrel's quote can't start a swap with Bram");
r = await post(PRD, "/daemon/z/api/swaps", { maker: "Kestrel", zec_zat: 70_000_000, quote: kq.quote_id });
const firmStart = await r.json();
check(r.status === 201, `swap started from Kestrel's firm quote (${r.status} ${firmStart.error ?? ""})`);
const sv3 = await (await fetch(`http://127.0.0.1:${Z}/api/swaps/${firmStart.id}`)).json();
check(sv3.amounts.btc_sat === Math.round(0.7 * kq.rate_sat_per_zec), `...at the quote's rate (btc_sat ${sv3.amounts.btc_sat})`);
r = await post(PRD, "/daemon/z/api/swaps", { maker: "Kestrel", zec_zat: 70_000_000, quote: kq.quote_id });
check(r.status === 400, "one quote, one swap: the same quote is refused again");

// buying ZEC through the production server: the main B daemon takes from a Z maker, behind the
// same guards as a sell (maker allowlist, demo cap), and swaps run side by side up to the cap
await reset();
await sleep(400);
const pairs = await (await fetch(PRD + "/api/pairs")).json();
check(pairs.main?.sell === "auto" && pairs.main?.buy === "auto" && Array.isArray(pairs.buy), `prod /api/pairs leaves both main daemons to the page: it uses each unless its status says it is a maker (${JSON.stringify(pairs)})`);
[qs, qb] = await quotes({ pair: "btc", direction: "buy", zec_zat: 70_000_000 });
check(qs === 200 && qb.quotes.map((q) => q.maker).join() === "Sandpiper,Zoe", `buying, firm quotes come from the partners who sell ZEC, cheapest first (${qb.quotes.map((q) => q.maker)})`);
r = await post(PRD, "/daemon/b/api/swaps", { maker: `http://127.0.0.1:${Z}/m/sandpiper`, zec_zat: 50_000_000 });
check(r.status === 400, "buying: a raw maker URL is refused too");
r = await post(PRD, "/daemon/b/api/swaps", { maker: "Sandpiper", zec_zat: 300_000_000 });
check(r.status === 400 && /limited/.test((await r.json()).error), "buying: the demo's per-swap cap applies");
r = await post(PRD, "/daemon/b/api/swaps", { maker: "Kestrel", zec_zat: 50_000_000 });
check(r.status === 400 && /role B/.test((await r.json()).error), "buying from a partner who only buys ZEC is refused");
r = await post(PRD, "/daemon/b/api/swaps", { maker: "Sandpiper", zec_zat: 50_000_000 });
const buy = await r.json();
check(r.status === 201, `a buy starts on B through the guard (${r.status} ${buy.error ?? ""})`);
const bv = await (await fetch(`http://127.0.0.1:${B}/api/swaps/${buy.id}`)).json();
check(bv.role === "B" && bv.taker === true && bv.amounts.btc_sat === Math.round(0.5 * 413800), `...as B, the taker, at Sandpiper's rate (${bv.amounts.btc_sat})`);
// several at once: a sell starts beside the buy, then two more, to the node's cap (4)
for (let i = 0; i < 3; i++) {
  r = await post(PRD, "/daemon/z/api/swaps", { maker: "Kestrel", zec_zat: 50_000_000 });
  check(r.status === 201, `prod: sell ${i + 1} starts beside the buy (${r.status} ${r.status === 201 ? "" : (await r.json()).error})`);
}
const cap = (await (await fetch(PRD + "/daemon/z/api/status")).json()).capacity;
check(cap?.live === 4 && cap?.free_slots === 0 && cap?.max_swaps === 4, `prod: the node's status says it is full (${JSON.stringify(cap)})`);
r = await post(PRD, "/daemon/z/api/swaps", { maker: "Kestrel", zec_zat: 50_000_000 });
const full = await r.json();
check(r.status === 409 && full.code === "busy" && full.error === BUSY_TEXT, `prod: past the cap, a start is "${full.error}" (${r.status}, code ${full.code})`);
r = await post(PRD, "/daemon/b/api/swaps", { maker: "Sandpiper", zec_zat: 50_000_000 });
check(r.status === 409 && (await r.json()).error === BUSY_TEXT, "prod: a buy too, when the other side runs as many as it takes");

await reset();
await sleep(400);
const prodPage = await page(1440);
await prodPage.goto(PRD + "/app");
await text(prodPage, "1 ZEC = ");
await text(prodPage, "firm for");
await sleep(800);
await shot(prodPage, "07-prod-server-1440");

// the per-IP quote limit (DEMO_QUOTES_PER_MIN=20 here)
let limited = 0;
for (let i = 0; i < 25 && !limited; i++) if ((await post(PRD, "/api/quotes", { pair: "btc", direction: "sell", zec_zat: 10_000_000 })).status === 429) limited = i + 1;
check(limited > 0, `prod limits quote requests per IP (429 after ${limited} more)`);

await browser.close();
console.log(shots.join("\n"));
process.exit(0);
