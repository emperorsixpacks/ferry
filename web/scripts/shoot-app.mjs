// `pnpm shoot:app`: every page of the web app at 1440 and 1280, against the node mock, into
// screenshots/app/. Each story starts from a fresh mock world (POST /api/_mock/reset), so the
// wallet in every shot matches the story it tells.
//
//   landing, how-it-works, help, inspect, app (empty, validation error), activity, offline
//   Z: swap in progress, done; refund (cancelling, refunded); settled (the other side stalls)
//   B (screenshots/app/b/), buying ZEC from the mock Z maker: in progress, done, lost (B stalls
//   and is punished)
//
// `pnpm shoot:app:real` runs the Z happy and refund stories against running ferryd daemons
// (FERRY_Z_URL, FERRY_B_URL, FERRY_MAKER_URL and tokens from the demo env) into screenshots/app/real/.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { mockMakersEnv } from "../mock/makers.mjs";

const REAL = process.argv.includes("--real");
const PORT = process.env.PORT ?? "5191";
const ROOT = new URL(`../screenshots/app/${REAL ? "real/" : ""}`, import.meta.url).pathname;
mkdirSync(ROOT + "b", { recursive: true });

const env = REAL
  ? { ...process.env, PORT }
  : { ...process.env, MOCK_SPEED: process.env.MOCK_SPEED ?? "2", MOCK_Z_PORT: "7151", MOCK_B_PORT: "7152", FERRY_Z_URL: "http://127.0.0.1:7151", FERRY_B_URL: "http://127.0.0.1:7152", FERRY_MAKERS: mockMakersEnv(7152, 7151), PORT };
const deadEnv = { ...process.env, FERRY_Z_URL: "http://127.0.0.1:7159", FERRY_B_URL: "http://127.0.0.1:7158", FERRY_Z_TOKEN: "", FERRY_B_TOKEN: "", PORT: String(Number(PORT) + 1) };
const procs = [spawn("pnpm", ["exec", "vite"], { env, stdio: "ignore" })];
if (!REAL) {
  procs.push(spawn(process.execPath, ["mock/server.mjs"], { env, stdio: "ignore" }));
  procs.push(spawn("pnpm", ["exec", "vite"], { env: deadEnv, stdio: "ignore" }));
}
const cleanup = () => procs.forEach((p) => p.kill("SIGTERM"));
process.on("exit", cleanup);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = `http://localhost:${PORT}`;
const DEAD = `http://localhost:${deadEnv.PORT}`;
for (const url of REAL ? [BASE] : [BASE, DEAD])
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(url)).ok) break;
    } catch {}
    if (i > 100) throw new Error("UI did not start: " + url);
    await sleep(200);
  }

const browser = await chromium.launch();
const pages = [];
for (const width of [1440, 1280]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && console.log(`[${width}]`, m.text()));
  pages.push({ width, page });
}
const main = pages[0].page;
let as = "z"; // whose app the pages show
const each = (fn) => Promise.all(pages.map(({ page }) => fn(page)));
const goto = (path) => each((p) => p.goto(BASE + path + (as === "b" ? (path.includes("?") ? "&" : "?") + "as=b" : "")));

await main.goto(BASE + "/");
const api = (who, path, body) =>
  main.evaluate(
    async ([who, path, body]) =>
      (await fetch(`/daemon/${who}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined)).json(),
    [who, path, body],
  );
const swap = (id, who = as) => api(who, `/api/swaps/${id}`);
const has = (s, ...k) => s.timeline.some((e) => k.includes(e.kind));
async function until(id, pred, label, who = as) {
  for (let i = 0; i < 6000; i++) {
    const s = await swap(id, who);
    if (s && s.id && pred(s)) return s;
    await sleep(120);
  }
  throw new Error("timed out: " + label);
}
async function idle() {
  for (let i = 0; i < 600; i++) {
    const [z, b] = await Promise.all([api("z", "/api/swaps"), api("b", "/api/swaps")]);
    if ([...z, ...b].every((s) => s.outcome)) return;
    await sleep(150);
  }
}
async function reset() {
  if (REAL) return idle();
  await api("z", "/api/_mock/reset", {});
}
async function shoot(name, { full = false, settle = 1800 } = {}) {
  await sleep(settle);
  const dir = ROOT + (as === "b" ? "b/" : "");
  for (const { width, page } of pages) {
    await page.screenshot({ path: `${dir}${name}-${width}.png`, fullPage: full });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) console.log(`  ! ${name}-${width}: horizontal overflow ${overflow}px`);
  }
  console.log("shot", (as === "b" ? "b/" : "") + name);
}
// Z sells to the first maker (Bram); B buys from Zoe, the mock's Z party as maker
const start = async (who = "z") => (await api(who, "/api/swaps", who === "b" ? { maker: "Zoe", zec_zat: 100000000 } : { zec_zat: 100000000 })).id;
const stall = (who, id) => api(who, `/api/swaps/${id}/fault`, { fault: "stall" });

// --- static pages
if (!REAL) {
  await reset();
  await goto("/");
  await shoot("01-landing", { settle: 2500 });
  // the landing reveals sections on scroll; scroll through once so the full page is drawn
  await each(async (p) => {
    const h = await p.evaluate(() => document.body.scrollHeight);
    for (let y = 0; y < h; y += 400) {
      await p.evaluate((y) => window.scrollTo(0, y), y);
      await new Promise((r) => setTimeout(r, 150));
    }
    await p.evaluate(() => window.scrollTo(0, 0));
  });
  await shoot("01-landing-full", { full: true, settle: 1200 });
  await goto("/how-it-works");
  await each(async (p) => {
    const h = await p.evaluate(() => document.body.scrollHeight);
    for (let y = 0; y < h; y += 400) {
      await p.evaluate((y) => window.scrollTo(0, y), y);
      await new Promise((r) => setTimeout(r, 150));
    }
    await p.evaluate(() => window.scrollTo(0, 0));
  });
  await shoot("02-how-it-works", { settle: 1500 });
  await shoot("02-how-it-works-full", { full: true, settle: 5500 });
  await goto("/help");
  await shoot("02-help-full", { full: true, settle: 800 });
}

// --- the app, empty and with a validation error
await reset();
await goto("/app");
await shoot("03-app-empty");
if (!REAL) {
  await each((p) => p.locator("input[inputmode=decimal]").fill("12"));
  await shoot("04-app-validation", { settle: 500 });
}

// --- story 1: a happy swap
await reset();
await goto("/app");
await each((p) => p.locator("input[inputmode=decimal]").fill("1.00"));
await main.locator("form button[type=submit]").click();
await main.waitForURL(/\/app\/swap\//);
const id1 = main.url().match(/swap\/([0-9a-f]+)/)[1];
await pages[1].page.goto(`${BASE}/app/swap/${id1}`);
await until(id1, (s) => has(s, "zec_lock_broadcast") && s.timeline.find((e) => e.kind === "zec_lock_broadcast").height != null, "in progress");
await shoot("05-swap-in-progress");
await shoot("05-swap-in-progress-full", { full: true, settle: 200 });
if (!REAL) {
  await goto("/inspect");
  await shoot("06-inspect-full", { full: true, settle: 2500 });
  await goto(`/app/swap/${id1}`);
}
await until(id1, (s) => s.outcome, "done");
await shoot("07-swap-done");
await shoot("07-swap-done-full", { full: true, settle: 200 });
await goto("/app/activity");
await shoot("08-app-with-swap");

// --- story 2: Z stalls, the swap is undone
await reset();
const id2 = await start();
await goto(`/app/swap/${id2}`);
await until(id2, (s) => s.state === "ZecLocked", "Z locked", "z");
await stall("z", id2);
await until(id2, (s) => has(s, "cancel_broadcast", "cancel_seen"), "cancel");
await shoot("09-swap-cancelling");
await until(id2, (s) => s.outcome, "refunded");
await shoot("10-swap-refunded");
await goto("/app/activity");
await shoot("11-app-refunded");

// --- story 3: B stalls after locking, Z is paid after the deadline
if (!REAL) {
  await reset();
  const id3 = await start();
  await goto(`/app/swap/${id3}`);
  await until(id3, (s) => s.state === "BtcLocked", "B locked", "b");
  await stall("b", id3);
  await until(id3, (s) => s.outcome, "punished");
  await shoot("12-swap-settled-after-deadline");

  // --- offline
  await each((p) => p.goto(DEAD + "/app"));
  await shoot("13-app-offline", { settle: 3500 });

  // --- buying ZEC: B takes from the mock Z maker, in progress, done and lost
  as = "b";
  await goto("/app");
  await reset();
  const b1 = await start("b");
  await goto(`/app/swap/${b1}`);
  await until(b1, (s) => has(s, "zec_confirmed"), "B saw ZEC");
  await shoot("05-swap-in-progress");
  await until(b1, (s) => s.outcome, "B done");
  await shoot("07-swap-done");
  await goto("/app/activity");
  await shoot("08-app-with-swap");
  await reset();
  const b3 = await start("b");
  await goto(`/app/swap/${b3}`);
  await until(b3, (s) => s.state === "BtcLocked", "B locked");
  await stall("b", b3);
  await until(b3, (s) => s.outcome, "lost");
  await shoot("12-swap-lost");
}

await browser.close();
cleanup();
process.exit(0);
