// `pnpm shoot:app`: screenshots of the swap app at / in every state, at 1440 and 1280 wide,
// against the node mock. Saved into screenshots/app/ (AS=b: B's mirror view, into screenshots/app/b/).
//
// Z: idle, validation error, in progress (+ details), done (+ details), unwinding, refunded,
//    settled (B stalls, Z is paid after T2), offline.
// B: idle, in progress, done, unwinding, refunded, lost (B stalls and is punished).
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const AS = process.env.AS === "b" ? "b" : "z";
// --real: against running ferryd daemons (FERRY_Z_URL, FERRY_B_URL, FERRY_MAKER_URL and the
// tokens from the demo env), into screenshots/app/real/; no offline shot.
const REAL = process.argv.includes("--real");
const PORT = process.env.PORT ?? "5191";
const OUT = new URL(`../screenshots/app/${REAL ? "real/" : ""}${AS === "b" ? "b/" : ""}`, import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const env = REAL
  ? { ...process.env, PORT }
  : { ...process.env, MOCK_SPEED: process.env.MOCK_SPEED ?? "2", MOCK_Z_PORT: "7151", MOCK_B_PORT: "7152", FERRY_Z_URL: "http://127.0.0.1:7151", FERRY_B_URL: "http://127.0.0.1:7152", PORT };
const MAKER = REAL ? env.FERRY_MAKER_URL ?? env.FERRY_B_URL : "http://127.0.0.1:7152";
// a second UI whose daemons don't exist, for the offline state
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
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && console.log(`[${width}]`, m.text()));
  await page.goto(BASE + (AS === "b" ? "/?as=b" : "/"));
  pages.push({ width, page });
}
const main = pages[0].page;
const api = (who, path, body) =>
  main.evaluate(
    async ([who, path, body]) =>
      (await fetch(`/daemon/${who}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined)).json(),
    [who, path, body],
  );
const newest = async (who = AS) => (await api(who, "/api/swaps")).sort((x, y) => x.timeline[0].at.localeCompare(y.timeline[0].at)).at(-1);
const has = (s, ...k) => s.timeline.some((e) => k.includes(e.kind));
async function until(pred, label, who = AS) {
  for (let i = 0; i < 6000; i++) {
    const s = await newest(who);
    if (s && pred(s)) return s;
    await sleep(120);
  }
  throw new Error("timed out: " + label);
}
async function idleBoth() {
  for (let i = 0; i < 600; i++) {
    const [z, b] = await Promise.all([api("z", "/api/swaps"), api("b", "/api/swaps")]);
    if ([...z, ...b].every((s) => s.outcome)) return;
    await sleep(150);
  }
}
const each = async (fn) => {
  for (const { page } of pages) await fn(page);
};
async function shoot(name, settle = 2400) {
  await sleep(settle);
  for (const { width, page } of pages) {
    await page.screenshot({ path: `${OUT}${name}-${width}.png` });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) console.log(`  ! ${name}-${width}: horizontal overflow ${overflow}px`);
  }
  console.log("shot", name);
}
const details = (open) =>
  each(async (p) => {
    const b = p.locator(".bd-card .bd-link").first();
    if ((await b.count()) && (await b.getAttribute("aria-expanded")) !== String(open)) await b.click();
  });
const again = () => each((p) => p.locator(".bd-card .bd-go").click());
const start = () => main.locator(".bd-card button[type=submit]").click();
const stall = (who, id) => api(who, `/api/swaps/${id}/fault`, { fault: "stall" });

await sleep(1500);
await shoot("01-idle");

if (AS === "z") {
  await each((p) => p.locator(".bd-field input").fill("12"));
  await shoot("02-validation", 600);
  await each((p) => p.locator(".bd-field input").fill("1.00"));
}

// happy swap
await start();
await until((s) => (AS === "z" ? has(s, "zec_lock_broadcast") && s.timeline.find((e) => e.kind === "zec_lock_broadcast").height != null : has(s, "zec_confirmed")), "in progress");
await shoot("03-in-progress");
await details(true);
await shoot("04-in-progress-details", 800);
await until((s) => s.outcome, "done");
await details(false);
await shoot("05-done");
await details(true);
await shoot("06-done-details", 800);

// Z stalls: unwinding, then refunded
await idleBoth();
await again();
const r = await api("z", "/api/swaps", { maker: MAKER, zec_zat: 100000000 });
await until((s) => s.id === r.id && s.state === "ZecLocked", "Z locked", "z");
await stall("z", r.id);
await until((s) => s.id === r.id && has(s, "cancel_broadcast", "cancel_seen"), "cancel");
await shoot("07-unwinding");
await until((s) => s.id === r.id && s.outcome, "refunded");
await shoot("08-refunded");

// B stalls: Z is paid after T2 (settled), B loses (lost)
await idleBoth();
await again();
const q = await api("z", "/api/swaps", { maker: MAKER, zec_zat: 100000000 });
await until((s) => s.id === q.id && s.state === "BtcLocked", "B locked", "b");
await stall("b", q.id);
await until((s) => s.id === q.id && s.outcome, "punished");
await shoot(AS === "z" ? "09-settled" : "09-lost");

if (AS === "z" && !REAL) {
  await each((p) => p.goto(DEAD + "/"));
  await shoot("10-offline", 3500);
}

await browser.close();
cleanup();
process.exit(0);
