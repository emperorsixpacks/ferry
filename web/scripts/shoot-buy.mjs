// `node scripts/shoot-buy.mjs`: buying shielded ZEC on /app, at 1440 and 390, against the node mock
// (its Z party sells ZEC as a maker, its B party is you). Flips the swap card, checks the buy side
// (the coin on top, ZEC below, partners who sell ZEC, the direction remembered), buys 1 ZEC, and
// shows Activity with a swap each way. Screenshots go to screenshots/app/buy/ (SHOOT_OUT=dir to
// put them elsewhere).
//
// Ports (override with SHOOT_PORT_BASE): mock Z base+21, B base+22, Vite base+61.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { mockMakersEnv } from "../mock/makers.mjs";

const BASE_PORT = Number(process.env.SHOOT_PORT_BASE ?? 7800);
const Z = BASE_PORT + 21;
const B = BASE_PORT + 22;
const VITE = BASE_PORT + 61;
const OUT = (process.env.SHOOT_OUT ?? new URL("../screenshots/app/buy/", import.meta.url).pathname).replace(/\/?$/, "/");
mkdirSync(OUT, { recursive: true });

const env = {
  ...process.env,
  MOCK_SPEED: "4",
  MOCK_Z_PORT: String(Z),
  MOCK_B_PORT: String(B),
  FERRY_Z_URL: `http://127.0.0.1:${Z}`,
  FERRY_B_URL: `http://127.0.0.1:${B}`,
  FERRY_MAKERS: mockMakersEnv(B, Z),
  FERRY_Z_TOKEN: "",
  FERRY_B_TOKEN: "",
};
const procs = [
  spawn(process.execPath, ["mock/server.mjs"], { env, stdio: "ignore" }),
  spawn("pnpm", ["exec", "vite", "--port", String(VITE), "--strictPort"], { env: { ...env, PORT: String(VITE) }, stdio: "ignore" }),
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
await Promise.all([up(DEV), up(`http://127.0.0.1:${Z}/peer/offer`)]);

const check = (cond, msg) => {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("ok:", msg);
};
const post = (base, path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const reset = () => post(`http://127.0.0.1:${Z}`, "/api/_mock/reset", {});
const swapOn = async (port, id) => (await fetch(`http://127.0.0.1:${port}/api/swaps/${id}`)).json();
async function until(port, id, pred, label) {
  for (let i = 0; i < 1500; i++) {
    const s = await swapOn(port, id);
    if (s?.id && pred(s)) return s;
    await sleep(120);
  }
  throw new Error("timed out: " + label);
}

const browser = await chromium.launch();
const shots = [];
async function page(width) {
  const p = await browser.newPage({ viewport: { width, height: width < 500 ? 844 : 900 } });
  p.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && console.log(`[${width}]`, m.text()));
  return p;
}
const pages = [await page(1440), await page(390)];
const [desk, phone] = pages;
const shoot = async (name, { full = false, settle = 600 } = {}) => {
  await sleep(settle);
  for (const p of pages) {
    const w = p.viewportSize().width;
    const path = `${OUT}${name}-${w}.png`;
    await p.screenshot({ path, fullPage: full });
    shots.push(path);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `${name} at ${w}: no horizontal scroll (${overflow}px)`);
  }
};
const text = (p, s) => p.waitForFunction((s) => document.body.innerText.includes(s), s, { timeout: 15_000 });
const each = (fn) => Promise.all(pages.map(fn));

// ------------------------------------------------------------------------------ the flip
await reset();
await each((p) => p.goto(DEV + "/app"));
await each((p) => text(p, "from Kestrel"));
const flip = desk.getByRole("button", { name: "Switch direction" });
check((await flip.count()) === 1, "the arrow between the panels is a button named Switch direction");
check((await desk.locator("input[inputmode=decimal]").getAttribute("aria-label")) === "ZEC to sell", "it starts selling ZEC");
await each((p) => p.getByRole("button", { name: "Switch direction" }).click());
await each((p) => p.locator('input[aria-label="ZEC to buy"]').waitFor());
// the coin is sold on top now, ZEC bought below; the best partner that sells ZEC quotes it
const labels = await desk.locator("form p.uppercase").allInnerTexts();
check(labels.slice(0, 2).join(",").toLowerCase() === "sell,buy", `panels read Sell (the coin) then Buy (ZEC): ${labels.slice(0, 2)}`);
const order = await desk.evaluate(() => {
  const coinPill = document.querySelector('[aria-label*="Choose another coin"]');
  const input = document.querySelector('input[aria-label="ZEC to buy"]');
  return coinPill.getBoundingClientRect().top < input.getBoundingClientRect().top;
});
check(order, "the token picker moved up to the Sell panel, the amount to the Buy panel");
await each((p) => text(p, "from Sandpiper"));
check(true, "buying, the card quotes the cheapest partner that sells ZEC (Sandpiper)");
await each((p) => text(p, "You have 0.05 BTC"));
check(true, "the Sell panel says what you have: You have 0.05 BTC");
await shoot("01-buy-card", { settle: 1200 });

// the token picker, buying: BTC can be picked, the rest are listed as not available here
await each((p) => p.getByRole("button", { name: /Choose another coin/ }).click());
await each((p) => p.getByRole("listbox", { name: "Tokens" }).waitFor());
const opts = await desk.getByRole("listbox", { name: "Tokens" }).getByRole("option").evaluateAll((els) => els.map((e) => [e.textContent, e.getAttribute("aria-disabled")]));
check(opts.length === 10 && opts.filter(([, off]) => off === "false").length === 1, `the picker lists 10 pairs, BTC pickable for buying (${opts.length})`);
check(opts.filter(([t]) => /not available here/.test(t)).length === 9, "the other 9 say not available here");
await shoot("02-buy-picker", { settle: 500 });
await each((p) => p.keyboard.press("Escape"));

// the partners: the ones who sell ZEC; those who only buy it are named, not offered
await each((p) => p.getByRole("button", { name: /^Settings/ }).click());
await each((p) => p.getByRole("radiogroup", { name: "Swap partner" }).waitFor());
const rows = await desk.locator('[role="radiogroup"][aria-label="Swap partner"] [role="radio"]').evaluateAll((els) => els.map((e) => e.textContent));
check(rows.length === 5 && /Zoe/.test(rows[1]) && /Sandpiper/.test(rows[2]) && /Curlew/.test(rows[3]) && /Plover/.test(rows[4]), `buying lists Best rate, the 3 partners who sell ZEC and the offline one (${rows.map((r) => r.slice(0, 8))})`);
await text(desk, "Bram, Kestrel, Heron OTC and Wren only buy ZEC, so they're not available here.");
check(true, "the partners who only buy ZEC are named, not offered");
await shoot("03-buy-partners", { settle: 900 });
await each((p) => p.keyboard.press("Escape"));

// too much: plain words about the balance
await each((p) => p.locator('input[aria-label="ZEC to buy"]').fill("20"));
await each((p) => text(p, "You have 0.05 BTC, and this costs"));
check(true, "more than the BTC covers: You have 0.05 BTC, and this costs ...");
await shoot("04-buy-not-enough", { settle: 400 });

// remembered like the pair
await desk.reload();
await desk.locator('input[aria-label="ZEC to buy"]').waitFor();
check(true, "the direction is remembered after a reload");

// ------------------------------------------------------------------------------ a swap each way
// one sell swap (Z takes from Bram), finished, so Activity has both directions
await reset();
const sell = await (await post(DEV, "/daemon/z/api/swaps", { maker: "Bram", zec_zat: 50_000_000 })).json();
check(!!sell.id, `a sell swap starts on Z (${sell.error ?? sell.id})`);
await until(Z, sell.id, (s) => s.outcome, "sell swap done");
await until(B, sell.id, (s) => s.outcome, "maker done");

// the buy, through the card
await each((p) => p.goto(DEV + "/app"));
await each((p) => p.locator('input[aria-label="ZEC to buy"]').waitFor());
await desk.locator('input[aria-label="ZEC to buy"]').fill("1.00");
await text(desk, "from Sandpiper");
await desk.locator("form button[type=submit]").click();
await desk.waitForURL(/\/app\/swap\//);
const id = desk.url().split("/").pop();
const b0 = await swapOn(B, id);
check(b0.role === "B" && b0.taker === true && b0.amounts.btc_sat === 413_800, `the buy runs on B, as taker, at Sandpiper's rate (${b0.role} ${b0.taker} ${b0.amounts.btc_sat})`);
await phone.goto(`${DEV}/app/swap/${id}`);
await until(B, id, (s) => s.timeline.some((e) => e.kind === "btc_lock_broadcast" && e.height != null), "B's BTC locked");
await each((p) => text(p, "Partner locks their ZEC"));
check(true, "in progress: Your BTC is locked, then Partner locks their ZEC");
await shoot("05-buy-in-progress");
await until(B, id, (s) => s.outcome === "swapped", "bought");
await each((p) => text(p, "You received 1.00 ZEC"));
check(true, "done: You received 1.00 ZEC");
await shoot("06-buy-done");

await each((p) => p.goto(DEV + "/app/activity"));
await each((p) => text(p, "Buy ZEC"));
await each((p) => text(p, "Sell ZEC"));
const kinds = await desk.locator("main ul li").allInnerTexts();
check(kinds.length === 2 && /Buy ZEC/.test(kinds[0]) && /Sell ZEC/.test(kinds[1]), `Activity lists both directions, newest first (${kinds.length})`);
await shoot("07-activity-both");

await browser.close();
console.log(shots.join("\n"));
process.exit(0);
