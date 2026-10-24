// `pnpm shoot:explainer`: /how-it-works at 1440 (and 1280): the full page, then each section in
// view with its demo running, plus the "both halves" state of section 02. Saved into
// screenshots/how-it-works/. Needs no daemons.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const PORT = process.env.PORT ?? "5197";
const OUT = new URL("../screenshots/how-it-works/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const procs = [spawn("pnpm", ["exec", "vite"], { env: { ...process.env, PORT, FERRY_Z_URL: "http://127.0.0.1:7189", FERRY_B_URL: "http://127.0.0.1:7188" }, stdio: "ignore" })];
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
for (const width of [1440, 1280]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(BASE + "/how-it-works");
  await sleep(1500);
  await page.screenshot({ path: `${OUT}00-hero-${width}.png` });
  const n = await page.locator(".hx-sec").count();
  for (let i = 0; i < n; i++) {
    const sec = page.locator(".hx-sec").nth(i);
    await sec.scrollIntoViewIfNeeded();
    await page.evaluate((i) => {
      const el = document.querySelectorAll(".hx-sec")[i];
      window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - (window.innerHeight - el.offsetHeight) / 2);
    }, i);
    await sleep(i === 2 ? 5600 : i === 3 ? 6200 : 2600); // let the played demos finish
    await page.screenshot({ path: `${OUT}0${i + 1}-section-${width}.png` });
    if (i === 1) {
      await page.locator(".hx-half-r").click();
      await sleep(900);
      await page.screenshot({ path: `${OUT}02b-both-halves-${width}.png` });
    }
  }
  await page.locator(".hx-end").scrollIntoViewIfNeeded();
  await sleep(600);
  await page.screenshot({ path: `${OUT}06-end-${width}.png` });
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(400);
  await page.screenshot({ path: `${OUT}full-page-${width}.png`, fullPage: true });
  await page.close();
}
await browser.close();
cleanup();
process.exit(0);
