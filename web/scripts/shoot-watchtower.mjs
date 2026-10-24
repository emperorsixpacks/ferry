// `pnpm shoot:watchtower`: the watchtower touches of the UI, against the daemons of
// `infra/demo-watchtower.sh up` (source its env first). Into screenshots/app/watchtower/:
//   safety-online   /safety, section 03 (stay online, or arm a watchtower)
//   swap-z, swap-b  a swap in progress with the "Watchtower armed" badge, as Z and as B
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright";

// Settings from the demo's env file unless already in the environment.
const ENV_FILE = process.env.FERRY_WT_ENV ?? new URL("../../.demo/watchtower/env", import.meta.url).pathname;
if (existsSync(ENV_FILE))
  for (const m of readFileSync(ENV_FILE, "utf8").matchAll(/^export (\w+)=(.*)$/gm)) process.env[m[1]] ??= m[2];

const PORT = process.env.PORT ?? "7741";
const BTC_RPC = process.env.FERRY_BTC_RPC ?? "http://127.0.0.1:18943";
const MAKER = process.env.FERRY_MAKER_URL;
if (!MAKER) throw new Error("source .demo/watchtower/env first (infra/demo-watchtower.sh up)");
const ROOT = new URL("../screenshots/app/watchtower/", import.meta.url).pathname;
mkdirSync(ROOT, { recursive: true });

const vite = spawn("pnpm", ["exec", "vite"], { env: { ...process.env, PORT }, stdio: "ignore" });
process.on("exit", () => vite.kill("SIGTERM"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = `http://localhost:${PORT}`;
for (let i = 0; ; i++) {
  try {
    if ((await fetch(BASE)).ok) break;
  } catch {}
  if (i > 100) throw new Error("UI did not start");
  await sleep(200);
}

const api = async (who, path, body) =>
  (
    await fetch(`${BASE}/daemon/${who}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined)
  ).json();
const mine = (n) =>
  fetch(BTC_RPC, {
    method: "POST",
    headers: { authorization: "Basic " + Buffer.from("ferry:ferry").toString("base64") },
    body: JSON.stringify({ jsonrpc: "1.0", id: "shoot", method: "generatetodescriptor", params: [n, "raw(51)"] }),
  });

const { id } = await api("z", "/api/swaps", { maker: MAKER, zec_zat: 100000000 });
if (!id) throw new Error("could not start a swap");
for (let i = 0; ; i++) {
  const [z, b] = await Promise.all([api("z", `/api/swaps/${id}`), api("b", `/api/swaps/${id}`)]);
  if (z.watchtower?.status === "armed" && b.watchtower?.status === "armed") break;
  if (i > 200) throw new Error("towers not armed: " + JSON.stringify([z.watchtower, b.watchtower]));
  await sleep(150);
}
await mine(2);
await sleep(2500);

const browser = await chromium.launch();
for (const width of [1440, 390]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && console.log(`[${width}]`, m.text()));
  const shot = async (name) => {
    await page.screenshot({ path: `${ROOT}${name}-${width}.png` });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) console.log(`  ! ${name}-${width}: horizontal overflow ${overflow}px`);
    console.log("shot", `${name}-${width}`);
  };
  await page.goto(`${BASE}/safety`);
  await sleep(800);
  await page.evaluate(() => {
    const el = document.getElementById("online");
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 90);
  });
  await sleep(600);
  await shot("safety-online");
  await page.evaluate(() => {
    const label = [...document.querySelectorAll("#online *")].find((n) => n.children.length === 0 && n.textContent === "A watchtower");
    label?.scrollIntoView({ block: "start" });
    window.scrollBy(0, -90);
  });
  await sleep(600);
  await shot("safety-watchtower");
  for (const who of ["z", "b"]) {
    await page.goto(`${BASE}/app/swap/${id}${who === "b" ? "?as=b" : ""}`);
    await sleep(2500);
    await shot(`swap-${who}`);
  }
  await page.close();
}
await browser.close();
process.exit(0);
