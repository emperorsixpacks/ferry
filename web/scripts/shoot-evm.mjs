// `pnpm shoot:evm`: the app and the inspector against a running EVM demo (infra/evm-demo.sh up;
// source .demo-evm/env first), at 1440 and 390, into screenshots/app/evm/. Runs a happy swap
// (Z's and B's views, the inspector mid-swap) and a refund (Z stalls; anvil time is jumped to
// t1 with `cast`), so every USDC-specific screen is covered.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright";

// Without the env sourced, read the demo's env file directly.
const ENV_FILE = new URL("../../.demo-evm/env", import.meta.url).pathname;
if (!process.env.FERRY_Z_TOKEN && existsSync(ENV_FILE)) {
  for (const m of readFileSync(ENV_FILE, "utf8").matchAll(/^export (\w+)=(.*)$/gm)) process.env[m[1]] = m[2];
}

const PORT = process.env.PORT ?? "7990";
const RPC = process.env.FERRY_EVM_RPC ?? "http://127.0.0.1:18545";
const CAST = process.env.CAST ?? `${process.env.HOME}/.foundry/bin/cast`;
const ROOT = new URL("../screenshots/app/evm/", import.meta.url).pathname;
mkdirSync(ROOT + "b", { recursive: true });

const vite = spawn("pnpm", ["exec", "vite"], { env: { ...process.env, PORT }, stdio: "ignore" });
const cleanup = () => vite.kill("SIGTERM");
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
for (const width of [1440, 390]) {
  const page = await browser.newPage({ viewport: { width, height: width > 500 ? 900 : 844 } });
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && console.log(`[${width}]`, m.text()));
  pages.push({ width, page });
}
const main = pages[0].page;
let as = "z";
const each = (fn) => Promise.all(pages.map(({ page }) => fn(page)));
const goto = (path) => each((p) => p.goto(BASE + path + (as === "b" ? (path.includes("?") ? "&" : "?") + "as=b" : "")));

await main.goto(BASE + "/app");
const api = (who, path, body) =>
  main.evaluate(
    async ([who, path, body]) =>
      (await fetch(`/daemon/${who}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined)).json(),
    [who, path, body],
  );
const swap = (id, who = as) => api(who, `/api/swaps/${id}`);
const has = (s, ...k) => s.timeline.some((e) => k.includes(e.kind));
async function until(id, pred, label, who = as) {
  for (let i = 0; i < 2000; i++) {
    const s = await swap(id, who);
    if (s && s.id && pred(s)) return s;
    await sleep(150);
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
async function shoot(name, { full = false, settle = 1500 } = {}) {
  await sleep(settle);
  const dir = ROOT + (as === "b" ? "b/" : "");
  for (const { width, page } of pages) {
    await page.screenshot({ path: `${dir}${name}-${width}.png`, fullPage: full });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) console.log(`  ! ${name}-${width}: horizontal overflow ${overflow}px`);
  }
  console.log("shot", (as === "b" ? "b/" : "") + name);
}
const warp = (t) => {
  execFileSync(CAST, ["rpc", "evm_setNextBlockTimestamp", String(t), "--rpc-url", RPC]);
  execFileSync(CAST, ["rpc", "evm_mine", "--rpc-url", RPC]);
};

// --- the form, quoting USDC
await idle();
await goto("/app");
await each((p) => p.locator("input[inputmode=decimal]").fill("1.00"));
await shoot("01-app-form");

// --- a happy swap
await main.locator("form button[type=submit]").click();
await main.waitForURL(/\/app\/swap\//);
const id1 = main.url().match(/swap\/([0-9a-f]+)/)[1];
await pages[1].page.goto(`${BASE}/app/swap/${id1}`);
await until(id1, (s) => has(s, "zec_lock_broadcast"), "Z locked ZEC");
await shoot("02-swap-in-progress", { full: true });
await goto("/inspect");
await shoot("03-inspect-mid", { full: true, settle: 1200 });
await until(id1, (s) => s.outcome, "Z done");
await until(id1, (s) => s.outcome && s.observer.zec.length > 0, "B done", "b");
await shoot("04-inspect-done", { full: true, settle: 2500 });
await goto(`/app/swap/${id1}`);
await shoot("05-swap-done", { full: true });
as = "b";
await goto(`/app/swap/${id1}`);
await shoot("05-swap-done", { full: true });
as = "z";

// --- refund: Z stalls after locking ZEC, B refunds at t1, Z reclaims
await idle();
await goto("/app");
const id2 = (await api("z", "/api/swaps", { zec_zat: 100000000 })).id;
await goto(`/app/swap/${id2}`);
const zl = await until(id2, (s) => s.state === "ZecLocked", "Z locked", "z");
await api("z", `/api/swaps/${id2}/fault`, { fault: "stall" });
await until(id2, (s) => s.state === "ReadySent", "B signed ready", "b");
warp(zl.deadlines.t1_unix);
await until(id2, (s) => has(s, "cancel_seen"), "called off", "b");
await until(id2, (s) => s.state === "ZecReclaiming" || s.outcome, "Z reclaiming");
await shoot("06-swap-unwinding", { full: true, settle: 600 });
await until(id2, (s) => s.outcome, "refunded");
await shoot("07-swap-refunded", { full: true });
await goto("/inspect");
await shoot("08-inspect-refund", { full: true, settle: 2500 });
await goto("/app");
await shoot("09-app-with-swaps", { full: true });

await browser.close();
cleanup();
process.exit(0);
