// `pnpm shoot`: runs the mock and the UI, drives a happy swap, a Z stall (refund) and a B stall
// (punish), and saves screenshots at 1440 and 390 wide, light and dark, into screenshots/.
//
// `pnpm shoot:real`: the same against running ferryd daemons (FERRY_Z_URL, FERRY_B_URL; the maker
// URL defaults to FERRY_B_URL) instead of the mock, saving into screenshots/real/.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const REAL = process.argv.includes("--real");
const SPEED = process.env.MOCK_SPEED ?? "2";
const PORT = process.env.PORT ?? "5181";
const OUT = new URL(REAL ? "../screenshots/real/" : "../screenshots/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const env = REAL
  ? { ...process.env, PORT }
  : { ...process.env, MOCK_SPEED: SPEED, MOCK_Z_PORT: "7161", MOCK_B_PORT: "7162", FERRY_Z_URL: "http://127.0.0.1:7161", FERRY_B_URL: "http://127.0.0.1:7162", PORT };
if (REAL && !(env.FERRY_Z_URL && env.FERRY_B_URL)) throw new Error("--real needs FERRY_Z_URL and FERRY_B_URL");
const procs = [spawn("pnpm", ["exec", "vite"], { env, stdio: "ignore" })];
if (!REAL) procs.push(spawn(process.execPath, ["mock/server.mjs"], { env, stdio: "ignore" }));
const cleanup = () => procs.forEach((p) => p.kill("SIGTERM"));
process.on("exit", cleanup);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = `http://localhost:${PORT}`;
for (let i = 0; ; i++) {
  try {
    if ((await fetch(BASE)).ok) break;
  } catch {}
  if (i > 100) throw new Error("UI did not start");
  await sleep(200);
}

const browser = await chromium.launch();
const views = [
  { tag: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "light" },
  { tag: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: "light" },
  { tag: "1440-dark", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" },
  { tag: "390-dark", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: "dark" },
];
const pages = [];
for (const v of views) {
  const ctx = await browser.newContext({ viewport: v.viewport, deviceScaleFactor: v.deviceScaleFactor, colorScheme: v.colorScheme, reducedMotion: "no-preference" });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && console.log(`[${v.tag}] console:`, m.text()));
  await page.goto(BASE + "/inspect");
  pages.push({ ...v, page });
}
const main = pages[0].page;

async function shoot(name) {
  await sleep(1800); // let transitions settle
  for (const { tag, page } of pages) {
    await page.screenshot({ path: `${OUT}${name}-${tag}.png`, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) console.log(`  ! ${name}-${tag}: horizontal overflow ${overflow}px`);
  }
  console.log("shot", name);
}

const api = (who, path, body) =>
  main.evaluate(
    async ([who, path, body]) => {
      const r = await fetch(`/daemon/${who}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
      return r.json();
    },
    [who, path, body],
  );

// the daemons don't promise an order, so the newest swap is the one that started last
const newest = (list) => list.sort((x, y) => (x.timeline[0]?.at ?? "").localeCompare(y.timeline[0]?.at ?? "")).at(-1);

async function until(pred, label, minutes = REAL ? 10 : 3) {
  const end = Date.now() + minutes * 60_000;
  while (Date.now() < end) {
    const [z, b] = await Promise.all([api("z", "/api/swaps"), api("b", "/api/swaps")]);
    if (pred(newest(z), newest(b))) return;
    await sleep(150);
  }
  throw new Error("timed out waiting for " + label);
}

await sleep(1500);
await shoot("01-idle");

await main.click("button[type=submit]");
await until((z) => z?.state === "ZecLocked", "mid-swap");
await shoot("02-mid-swap");

await until((z, b) => b?.secrets.peer_learned, "magic moment");
await shoot("03-magic-moment");

await until((z, b) => z?.outcome && b?.outcome, "happy end");
await shoot("04-swapped");

await main.click("button[type=submit]");
await until((z) => z?.state === "ZecLocked", "Z locked");
await main.getByRole("button", { name: "Make Z stall" }).click();
await until((z, b) => b?.state === "Cancelled", "cancel");
await shoot("05-z-stalled-cancelled");
await until((z, b) => z?.outcome && b?.outcome, "refund end");
await shoot("06-refund-path");

await main.click("button[type=submit]");
await until((z, b) => b?.state === "BtcLocked", "B locked BTC");
await main.getByRole("button", { name: "Make B stall" }).click();
await until((z, b) => z?.outcome && b?.outcome, "punish end");
await shoot("07-punish-path");

await browser.close();
cleanup();
process.exit(0);
