// `pnpm shoot:directions`: the three candidate visual directions of the swap app (?direction=A|B|C)
// in the idle, in-progress and done states, at 1440 and 1280 wide, against the node mock.
// Saved into screenshots/directions/{A,B,C}/ (DIRS=bold1,bold2: screenshots/bold/{1,2}/).
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const PORT = process.env.PORT ?? "5195";
const OUT = new URL("../screenshots/directions/", import.meta.url).pathname;
const env = { ...process.env, MOCK_SPEED: process.env.MOCK_SPEED ?? "1.5", MOCK_Z_PORT: "7181", MOCK_B_PORT: "7182", FERRY_Z_URL: "http://127.0.0.1:7181", FERRY_B_URL: "http://127.0.0.1:7182", PORT };
const procs = [
  spawn(process.execPath, ["mock/server.mjs"], { env, stdio: "ignore" }),
  spawn("pnpm", ["exec", "vite"], { env, stdio: "ignore" }),
];
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
const pages = [];
// DIRS=bold1,bold2 shoots the bold takes into screenshots/bold/{1,2}/ instead
const DIRS = (process.env.DIRS ?? "A,B,C").split(",");
const dirOf = (d) => (d.startsWith("bold") ? `${OUT}../bold/${d.slice(4)}/` : `${OUT}${d}/`);
for (const d of DIRS) {
  mkdirSync(dirOf(d), { recursive: true });
  for (const width of [1440, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on("console", (m) => m.type() === "error" && console.log(`[${d}-${width}]`, m.text()));
    await page.goto(`${BASE}/?direction=${d}`);
    pages.push({ d, width, page });
  }
}
const main = pages[0].page;
const swaps = () => main.evaluate(async () => (await fetch("/daemon/z/api/swaps")).json());
async function until(pred, label) {
  for (let i = 0; i < 2000; i++) {
    const s = (await swaps()).at(-1);
    if (s && pred(s)) return;
    await sleep(150);
  }
  throw new Error("timed out: " + label);
}
async function shoot(name, settle = 3200) {
  await sleep(settle);
  for (const { d, width, page } of pages) await page.screenshot({ path: `${dirOf(d)}${name}-${width}.png` });
  console.log("shot", name);
}

await sleep(1500);
await shoot("01-idle");
await main.locator("button[type=submit]").click();
await until((s) => s.timeline.some((e) => e.kind === "zec_lock_broadcast" && e.height != null), "ZEC locked");
await shoot("02-in-progress");
await until((s) => s.outcome, "done");
await shoot("03-done");
await browser.close();
cleanup();
process.exit(0);
