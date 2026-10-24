// `node scripts/shoot-makers.mjs`: the swap partners on /app at 1440 and 390, against the node
// mock and its mock makers (mock/makers.mjs), into screenshots/app/makers/. The swap card quotes
// the best partner by itself; the settings pill above it lists every partner and lets you pick
// one. Then the same flow through the production server (server/prod.mjs, needs `pnpm build`
// first): GET /api/makers, a swap started by maker name, and a raw URL refused.
//
// Ports (override with SHOOT_PORT_BASE): mock Z base+11, B base+12, Vite base+51, prod base+52.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { mockMakersEnv } from "../mock/makers.mjs";

const BASE_PORT = Number(process.env.SHOOT_PORT_BASE ?? 7800);
const Z = BASE_PORT + 11;
const B = BASE_PORT + 12;
const VITE = BASE_PORT + 51;
const PROD = BASE_PORT + 52;
const OUT = new URL("../screenshots/app/makers/", import.meta.url).pathname;
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
  spawn(process.execPath, ["server/prod.mjs"], { env: { ...env, PORT: String(PROD), HOST: "127.0.0.1", DEMO_MAX_ZAT: "200000000" }, stdio: "inherit" }),
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
  const p = await browser.newPage({ viewport: { width, height: width < 500 ? 844 : 900 } });
  p.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && console.log(`[${width}]`, m.text()));
  return p;
}
const shot = async (p, name, opts = {}) => {
  const path = OUT + name + ".png";
  await p.screenshot({ path, ...opts });
  shots.push(path);
};
const text = (p, s) => p.waitForFunction((s) => document.body.innerText.includes(s), s, { timeout: 10_000 });
const radios = '[role="radiogroup"][aria-label="Swap partner"] [role="radio"]';
const settings = (p) => p.getByRole("button", { name: /^Settings/ });
const partner = (p, name) => p.getByRole("radio", { name });

await reset();
const desk = await page(1440);
await desk.goto(DEV + "/app");
// with no pick, the card quotes the best rate that can fill 1 ZEC: Kestrel, 412350 sat/ZEC
await text(desk, "1 ZEC = 0.0041235 BTC · from Kestrel");
check(true, "the swap card picks the best rate by itself (Kestrel)");
await sleep(400);
await shot(desk, "01-swap-1440");

await settings(desk).click();
await desk.getByRole("radiogroup", { name: "Swap partner" }).waitFor();
await desk.waitForFunction((sel) => document.querySelectorAll(sel).length === 6, radios);
check((await partner(desk, /^Best rate/).getAttribute("aria-checked")) === "true", "settings list Best rate (checked) and the 5 partners");
await sleep(300);
await shot(desk, "01-makers-1440");

// pick Bram: the quote follows its rate (410000 sat/ZEC)
await partner(desk, /Bram/).click();
await text(desk, "1 ZEC = 0.0041 BTC · from Bram");
check(true, "picking Bram updates the quote to its rate");

// offline and paused partners can't be picked
await partner(desk, /Plover/).click({ force: true });
await partner(desk, /Wren/).click({ force: true });
check((await partner(desk, /Bram/).getAttribute("aria-checked")) === "true", "offline/paused rows don't take the selection");

// pick Kestrel: 412350 sat/ZEC, 1 ZEC → 0.0041235 less the 2000 sat fee
await partner(desk, /Kestrel/).click();
await text(desk, "1 ZEC = 0.0041235 BTC · from Kestrel");
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
await desk.locator("input[inputmode=decimal]").fill("1.00");
await text(desk, "from Kestrel");
check(true, "a picked partner comes back once it can fill the amount");

// start with Heron (min 1 ZEC): the swap runs at Heron's rate
await settings(desk).click();
await partner(desk, /Heron/).click();
await desk.keyboard.press("Escape");
await text(desk, "from Heron OTC");
await desk.locator("form button[type=submit]").click();
await desk.waitForURL(/\/app\/swap\//);
const id = desk.url().split("/").pop();
const sv = await (await fetch(`http://127.0.0.1:${Z}/api/swaps/${id}`)).json();
check(sv.amounts.btc_sat === 408900, `swap started with Heron at its rate (btc_sat ${sv.amounts.btc_sat})`);

// the token picker: every pair listed, only the ones with a daemon here can be picked
await reset();
await sleep(400);
await desk.goto(DEV + "/app");
await text(desk, "from Kestrel");
await desk.getByRole("button", { name: /Choose another coin/ }).click();
const listbox = desk.getByRole("listbox", { name: "Tokens" });
await listbox.waitFor();
const options = await listbox.getByRole("option").evaluateAll((els) => els.map((e) => [e.textContent, e.getAttribute("aria-disabled")]));
check(options.length === 10 && options.filter(([, off]) => off === "false").length === 1 && /BTC/.test(options[0][0]), `the token picker lists all 10 pairs, only BTC pickable here (${options.length})`);
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
await text(phone, "1 ZEC = 0.0041 BTC · from Bram");
await shot(phone, "05-bram-selected-390", { fullPage: true });

// ------------------------------------------------------------------------------ production server
await reset();
await sleep(400);
const list = (await (await fetch(PRD + "/api/makers")).json()).makers;
check(list.length === 5, "prod /api/makers lists the 5 allowlisted makers");
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

const prodPage = await page(1440);
await prodPage.goto(PRD + "/app");
await text(prodPage, "1 ZEC = ");
await sleep(800);
await shot(prodPage, "07-prod-server-1440");

await browser.close();
console.log(shots.join("\n"));
process.exit(0);
