// `node scripts/shoot-hang.mjs`: one pair's daemon hangs instead of failing, and the rest of /app
// doesn't wait for it. Against the node mock (mock/server.mjs): Z for BTC (the main pair), B, Z again
// as an LTC daemon and a USDC-on-Base node, with MOCK_HANG=ltc, behind the Vite dev server and then the
// production server (server/prod.mjs, needs `pnpm build` first). On each:
//   - with LTC's daemon hanging, the swap card shows within a few seconds, on BTC, with Recent activity
//   - the token picker says "Partner offline" on LTC, and not on BTC or USDC
//   - the UI server answers for the hung daemon with 504 {"code": "timeout"} in about 10 s
//   - a link to LTC opens the card on LTC within a few seconds, and it says "Partner offline"
//   - once LTC's daemon answers again, the card and the picker are back to normal by themselves
//   - when the main daemon (BTC) hangs, a fresh page opens the card on the next coin that answers (LTC)
// Screenshots (the picker and the card, light and dark) into screenshots/app/hang/ (SHOOT_OUT=dir
// for elsewhere). `--dev` or `--prod` runs one server only.
//
// Ports (SHOOT_PORT_BASE, default 7520): mock Z base+1, B base+2, LTC base+3, USDC base+4, Vite base+5,
// prod base+6. Only the processes this script starts are stopped, by their own handles.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { mockMakersEnv } from "../mock/makers.mjs";

const WEB = new URL("..", import.meta.url).pathname;
const BASE_PORT = Number(process.env.SHOOT_PORT_BASE ?? 7520);
const [Z, B, LTC, USDC, VITE, PROD] = [1, 2, 3, 4, 5, 6].map((n) => BASE_PORT + n);
const OUT = (process.env.SHOOT_OUT ?? new URL("../screenshots/app/hang/", import.meta.url).pathname).replace(/\/?$/, "/");
mkdirSync(OUT, { recursive: true });
const only = process.argv.includes("--dev") ? "dev" : process.argv.includes("--prod") ? "prod" : null;
// the card's first wait for a silent daemon (src/app/lib/pairs.ts FIRST_WAIT_MS), and "a few seconds"
const FIRST_WAIT_MS = 3000;
const FEW_S = 6000;

const env = {
  ...process.env,
  MOCK_SPEED: "4",
  MOCK_Z_PORT: String(Z),
  MOCK_B_PORT: String(B),
  MOCK_Z_LTC_PORT: String(LTC),
  MOCK_USDC_PORT: String(USDC),
  MOCK_HANG: "ltc",
  FERRY_Z_URL: `http://127.0.0.1:${Z}`,
  FERRY_B_URL: `http://127.0.0.1:${B}`,
  FERRY_LTC_URL: `http://127.0.0.1:${LTC}`,
  FERRY_USDC_BASE_URL: `http://127.0.0.1:${USDC}`,
  // the mock's partners, with the ones for LTC and USDC
  FERRY_MAKERS: mockMakersEnv(B, Z, { routes: true }),
  FERRY_Z_TOKEN: "",
  FERRY_B_TOKEN: "",
  FERRY_NEAR_QUOTES: "0",
};
delete env.FERRY_ROUTER_URL;
delete env.FERRY_NEAR_URL;
const procs = [spawn(process.execPath, ["mock/server.mjs"], { cwd: WEB, env, stdio: "ignore" })];
if (only !== "prod") procs.push(spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", String(VITE), "--strictPort"], { cwd: WEB, env: { ...env, PORT: String(VITE) }, stdio: "ignore" }));
if (only !== "dev") procs.push(spawn(process.execPath, ["server/prod.mjs"], { cwd: WEB, env: { ...env, PORT: String(PROD), HOST: "127.0.0.1" }, stdio: "ignore" }));
const cleanup = () => procs.forEach((p) => p.exitCode === null && p.kill("SIGTERM"));
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
await Promise.all([up(`http://127.0.0.1:${B}/peer/offer`), ...(only !== "prod" ? [up(DEV)] : []), ...(only !== "dev" ? [up(PRD + "/healthz")] : [])]);

const check = (cond, msg) => {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("ok:", msg);
};
// a daemon of the mock hangs, or answers again (asked of one that answers)
async function hang(daemon, on) {
  const r = await fetch(`http://127.0.0.1:${daemon === "z" ? B : Z}/api/_mock/hang`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ daemon, hang: on }) });
  if (!r.ok) throw new Error(`hang ${daemon}: ${r.status}`);
}

const browser = await chromium.launch();
// after the sheet's opening animation
const shot = async (p, name) => {
  await sleep(400);
  await p.screenshot({ path: OUT + name + ".png" });
};
async function fresh(theme = "light") {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme });
  const p = await ctx.newPage();
  p.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && console.log("[page]", m.text()));
  // SHOOT_DEBUG=1: the page's requests still out, for pending(p)
  if (process.env.SHOOT_DEBUG) {
    p.out = new Map();
    p.on("request", (r) => p.out.set(r, Date.now()));
    p.on("requestfinished", (r) => p.out.delete(r));
    p.on("requestfailed", (r) => p.out.delete(r));
  }
  return p;
}
const pending = (p) => p.out && console.log("  out:", [...p.out].map(([r, at]) => `${new URL(r.url()).pathname} ${Date.now() - at} ms`).join(", "));
// ms until the swap card's amount box shows, from a page load
async function cardIn(p, url) {
  const t0 = Date.now();
  await p.goto(url);
  await p.locator('input[aria-label="ZEC to sell"]').waitFor({ timeout: 30_000 });
  return Date.now() - t0;
}
const youGet = (p, ticker) => p.locator(`output[aria-label="You get ${ticker}"]`);
const line = (p) => p.locator("[data-availability]").first();
// the picker opened from the coin you get, and one coin's row in it
const openPicker = (p) => p.getByRole("button", { name: /^You get .*Choose another coin$/ }).click();
const row = (p, ticker) => p.locator('[role="dialog"] [role="option"]').filter({ has: p.locator(`text="${ticker}"`) }).first();
const closePicker = (p) => p.keyboard.press("Escape");

async function run(name, BASE) {
  console.log(`\n${name}: ${BASE}`);
  await hang("ltc", true);
  await hang("z", false);

  // 1. LTC's daemon hangs: the card opens on the first coin, BTC, as soon as its daemon answers
  const p = await fresh();
  const ms = await cardIn(p, BASE + "/app");
  check(ms < FEW_S, `the card shows in ${ms} ms while LTC's daemon hangs`);
  check(await youGet(p, "BTC").isVisible(), "on BTC, the first coin");
  check(await p.locator("[data-recent]").isVisible(), "Recent activity shows beside it");

  // 2. the picker: LTC is offline once the first wait is over; BTC and USDC aren't
  await sleep(Math.max(0, FIRST_WAIT_MS + 500 - ms));
  await openPicker(p);
  await row(p, "LTC").filter({ hasText: "Partner offline" }).waitFor({ timeout: FEW_S });
  check(true, "the picker says LTC: Partner offline");
  check(!(await row(p, "BTC").innerText()).includes("Partner offline"), "BTC isn't offline");
  check(!(await row(p, "USDC").innerText()).includes("Partner offline"), "USDC isn't offline");
  check(/per ZEC/.test(await row(p, "BTC").innerText()) && !/per ZEC/.test(await row(p, "LTC").innerText()), "BTC has a rate, LTC none");
  if (name === "dev") await shot(p, "picker-ltc-offline");
  await closePicker(p);

  // 3. the UI server answers for the hung daemon: 504, in about its 10 s
  pending(p);
  const t = await p.evaluate(async () => {
    const t0 = performance.now();
    // no-store: not queued behind the page's own probe of the same URL (the browser's cache lock)
    const r = await fetch("/daemon/ltc/api/status", { cache: "no-store" });
    return { status: r.status, body: await r.json().catch(() => null), ms: Math.round(performance.now() - t0) };
  });
  check(t.status === 504 && t.body?.code === "timeout", `GET /daemon/ltc/api/status: ${t.status} ${JSON.stringify(t.body)}`);
  check(t.ms >= 9000 && t.ms < 12_500, `... after ${t.ms} ms (the limit is 10 s)`);
  check(await p.locator('input[aria-label="ZEC to sell"]').isEnabled(), "the card took input all along");

  // 4. a link to LTC: the card opens on it at once, and says its partner is offline
  const q = await fresh();
  const msLtc = await cardIn(q, BASE + "/app?sell=zec&buy=ltc");
  check(msLtc < FEW_S, `a link to LTC opens the card in ${msLtc} ms`);
  check(await youGet(q, "LTC").isVisible(), "on LTC");
  await q.waitForFunction(() => document.querySelector("[data-availability]")?.textContent === "Partner offline", null, { timeout: FEW_S + 2000 });
  check(true, "the card says Partner offline");
  if (name === "dev") await shot(q, "card-ltc-offline");

  // 5. LTC's daemon answers again: the card and the picker come back by themselves
  await hang("ltc", false);
  const t1 = Date.now();
  await q.waitForFunction(() => document.querySelector("[data-availability]")?.textContent !== "Partner offline", null, { timeout: 20_000 });
  check(true, `the card is back ${Date.now() - t1} ms after LTC's daemon answers: "${await line(q).innerText().catch(() => "")}"`);
  await openPicker(q);
  await q.waitForFunction(() => {
    const rows = [...document.querySelectorAll('[role="dialog"] [role="option"]')];
    const ltc = rows.find((r) => r.textContent?.includes("LTC"));
    return !!ltc && !ltc.textContent?.includes("Partner offline");
  }, null, { timeout: 20_000 });
  check(true, "the picker's LTC row is back");
  if (name === "dev") await shot(q, "picker-ltc-back");
  await closePicker(q);
  await q.context().close();

  // 6. the main daemon (BTC) hangs: a fresh page opens the card on the next coin that answers
  await hang("z", true);
  const r = await fresh();
  const msMain = await cardIn(r, BASE + "/app");
  check(msMain < FIRST_WAIT_MS + FEW_S, `with BTC's daemon hanging, the card shows in ${msMain} ms`);
  check(await youGet(r, "LTC").isVisible(), "on LTC, the next coin that answers");
  await hang("z", false);
  await r.context().close();
  await p.context().close();
}

// dark mode: the picker and the card with LTC offline
async function dark(BASE) {
  await hang("ltc", true);
  const p = await fresh("dark");
  await cardIn(p, BASE + "/app?sell=zec&buy=ltc");
  await p.waitForFunction(() => document.querySelector("[data-availability]")?.textContent === "Partner offline", null, { timeout: FEW_S + 2000 });
  await shot(p, "card-ltc-offline-dark");
  await openPicker(p);
  await row(p, "LTC").filter({ hasText: "Partner offline" }).waitFor({ timeout: FEW_S });
  await shot(p, "picker-ltc-offline-dark");
  await p.context().close();
  await hang("ltc", false);
}

try {
  if (only !== "prod") {
    // Vite builds its modules on the first load: not part of what is timed
    const warm = await fresh();
    await cardIn(warm, DEV + "/app");
    await warm.context().close();
    await run("dev", DEV);
    await dark(DEV);
  }
  if (only !== "dev") await run("prod", PRD);
  console.log(`\nall checks passed; screenshots in ${OUT}`);
} finally {
  await browser.close();
}
process.exit(0);
