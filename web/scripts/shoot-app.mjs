// `pnpm shoot:app`: screenshots of the swap app at / (idle, in progress, done, refunded) at 390 and
// 1440 wide, light and dark, against the node mock. Saved into screenshots/app/ (AS=b: B's view, into
// screenshots/app/b/).
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const PORT = process.env.PORT ?? "5191";
const OUT = new URL(process.env.AS === "b" ? "../screenshots/app/b/" : "../screenshots/app/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const env = { ...process.env, MOCK_SPEED: process.env.MOCK_SPEED ?? "2", MOCK_Z_PORT: "7151", MOCK_B_PORT: "7152", FERRY_Z_URL: "http://127.0.0.1:7151", FERRY_B_URL: "http://127.0.0.1:7152", PORT };
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
const views = [
  { tag: "390", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: "light" },
  { tag: "1440", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "light" },
  { tag: "390-dark", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: "dark" },
  { tag: "1440-dark", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" },
];
const pages = [];
for (const v of views) {
  const ctx = await browser.newContext({ viewport: v.viewport, deviceScaleFactor: v.deviceScaleFactor, colorScheme: v.colorScheme });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && console.log(`[${v.tag}]`, m.text()));
  await page.goto(BASE + (process.env.AS ? `/?as=${process.env.AS}` : "/"));
  pages.push({ ...v, page });
}
const main = pages[0].page;
// the page's own party is polled; faults always stall Z, which drives B's refund too
const LOCAL = process.env.AS === "b" ? "b" : "z";
const api = (path, body, who = LOCAL) =>
  main.evaluate(
    async ([who, path, body]) => (await fetch(`/daemon/${who}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined)).json(),
    [who, path, body],
  );
const newest = async () => (await api("/api/swaps")).sort((x, y) => x.timeline[0].at.localeCompare(y.timeline[0].at)).at(-1);
async function until(pred, label) {
  for (let i = 0; i < 2000; i++) {
    const s = await newest();
    if (s && pred(s)) return s;
    await sleep(150);
  }
  throw new Error("timed out: " + label);
}
async function shoot(name, open = false) {
  await sleep(1500);
  for (const { tag, page } of pages) {
    if (open) await page.evaluate(() => document.querySelectorAll("details.sw-details").forEach((d) => (d.open = true)));
    await page.screenshot({ path: `${OUT}${name}-${tag}.png`, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) console.log(`  ! ${name}-${tag}: horizontal overflow ${overflow}px`);
  }
  console.log("shot", name);
}

await sleep(1500);
await shoot("01-idle");

await main.locator("button[type=submit]").click();
await until((s) => ["ZecLocked", "RedeemSigReceived", "ZecSeen", "RedeemSigSent"].includes(s.state), "in progress");
await shoot("02-in-progress");

await until((s) => s.outcome, "done");
await shoot("03-done");
await shoot("04-done-details", true);

// the other side finishes a little later (its sweep waits); a new swap needs both sides idle
for (let i = 0; i < 400; i++) {
  const [z, b] = await Promise.all([api("/api/swaps", null, "z"), api("/api/swaps", null, "b")]);
  if ([...z, ...b].every((s) => s.outcome)) break;
  await sleep(150);
}
const { id } = await api("/api/swaps", { maker: "http://127.0.0.1:7152", zec_zat: 100000000 }, "z");
for (let i = 0; i < 400; i++) {
  const z = await api(`/api/swaps/${id}`, null, "z");
  if (z.state === "ZecLocked") break;
  await sleep(150);
}
await api(`/api/swaps/${id}/fault`, { fault: "stall" }, "z");
await until((s) => s.id === id && s.timeline.some((e) => e.kind === "cancel_seen" || e.kind === "cancel_broadcast"), "cancel");
await shoot("05-unwinding");
await until((s) => s.id === id && s.outcome, "refunded");
await shoot("06-refunded");

await browser.close();
cleanup();
process.exit(0);
