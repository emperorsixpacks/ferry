// `node scripts/shoot-route.mjs`: private swaps (coin → shielded ZEC → coin) on /app, at 1440 and
// 390, against the node mock and its mock router (mock/router.mjs): the ZEC pill's picker turns the
// card into a private swap, the quote goes through both partners, the confirmation, the progress
// page in every part (swap 1, settling, the private pause, swap 2, done), a second swap called off
// so the route holds the ZEC and "Finish now" completes it, Activity with one row per private swap,
// and no route UI on a server without a router. Then the production server (server/prod.mjs, needs
// `pnpm build` first): GET /api/pairs, a route started by partner names, URLs never forwarded or
// shown, the read-only allowlist, one live route, and a direct swap refused while a route runs.
// Screenshots go to screenshots/app/route/ (SHOOT_OUT=dir to put them elsewhere; SHOOT_THEME=dark to
// take them in dark mode).
//
// Ports (override with SHOOT_PORT_BASE): mock Z base+31, B base+32, router base+33, Vite base+71,
// prod base+72.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { mockMakersEnv } from "../mock/makers.mjs";

const BASE_PORT = Number(process.env.SHOOT_PORT_BASE ?? 7800);
const Z = BASE_PORT + 31;
const B = BASE_PORT + 32;
const ROUTER = BASE_PORT + 33;
const VITE = BASE_PORT + 71;
const PROD = BASE_PORT + 72;
const OUT = (process.env.SHOOT_OUT ?? new URL("../screenshots/app/route/", import.meta.url).pathname).replace(/\/?$/, "/");
mkdirSync(OUT, { recursive: true });

const env = {
  ...process.env,
  MOCK_SPEED: "4",
  MOCK_Z_PORT: String(Z),
  MOCK_B_PORT: String(B),
  MOCK_ROUTE_PORT: String(ROUTER),
  // Standard's 5–30 min pause becomes 3–18 s at speed 4: long enough to see
  MOCK_ROUTE_PAUSE_SCALE: "0.04",
  FERRY_Z_URL: `http://127.0.0.1:${Z}`,
  FERRY_B_URL: `http://127.0.0.1:${B}`,
  FERRY_ROUTER_URL: `http://127.0.0.1:${ROUTER}`,
  FERRY_MAKERS: mockMakersEnv(B, Z, { routes: true }),
  FERRY_Z_TOKEN: "",
  FERRY_B_TOKEN: "",
};
const procs = [
  spawn(process.execPath, ["mock/server.mjs"], { env, stdio: "ignore" }),
  spawn("pnpm", ["exec", "vite", "--port", String(VITE), "--strictPort"], { env: { ...env, PORT: String(VITE) }, stdio: "ignore" }),
  spawn(process.execPath, ["server/prod.mjs"], { env: { ...env, PORT: String(PROD), HOST: "127.0.0.1", DEMO_MAX_ZAT: "200000000", DEMO_RATE_PER_HOUR: "3" }, stdio: "inherit" }),
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
const PRD = `http://127.0.0.1:${PROD}`;
const RT = `http://127.0.0.1:${ROUTER}`;
await Promise.all([up(DEV), up(PRD + "/healthz"), up(RT + "/api/status"), up(`http://127.0.0.1:${B}/m/egret/peer/offer`)]);

const check = (cond, msg) => {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("ok:", msg);
};
const post = (base, path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const reset = () => post(`http://127.0.0.1:${Z}`, "/api/_mock/reset", {});
const routes = async () => (await fetch(RT + "/api/routes")).json();
const routeOf = async (id) => (await fetch(`${RT}/api/routes/${id}`)).json();
// every mock swap over, on both sides (a partner finishes a moment after you)
async function idle() {
  for (let i = 0; i < 300; i++) {
    const lists = await Promise.all([Z, B].map(async (port) => (await fetch(`http://127.0.0.1:${port}/api/swaps`)).json()));
    if (lists.every((l) => l.every((s) => s.outcome))) return;
    await sleep(100);
  }
  throw new Error("the mock's swaps never finished");
}
async function until(id, pred, label, tries = 900) {
  for (let i = 0; i < tries; i++) {
    const v = await routeOf(id);
    if (pred(v)) return v;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify((await routeOf(id)).phase)}`);
}

const browser = await chromium.launch();
const shots = [];
async function page(width) {
  const p = await browser.newPage({ viewport: { width, height: width < 500 ? 844 : 900 }, colorScheme: process.env.SHOOT_THEME === "dark" ? "dark" : "light" });
  p.on("console", (m) => m.type() === "error" && !/Failed to load resource|EventSource/.test(m.text()) && console.log(`[${width}]`, m.text()));
  return p;
}
const shot = async (p, name, opts = {}) => {
  const path = OUT + name + ".png";
  await p.screenshot({ path, ...opts });
  shots.push(path);
};
const text = (p, s, timeout = 15_000) => p.waitForFunction((s) => document.body.innerText.includes(s), s, { timeout });
const noOverflow = async (p, what) => {
  const o = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(o <= 0, `no horizontal scroll at 390: ${what} (${o}px)`);
};
// buying ZEC (?dir=buy), shielded ZEC is on the Buy pill
const zecPill = (p) => p.getByRole("button", { name: /^You get shielded ZEC\. Choose another coin/ });
const settle = () => sleep(500);

// ------------------------------------------------------------------------------ the card
await reset();
const desk = await page(1440);
const phone = await page(390);
await desk.goto(DEV + "/app?dir=buy");
await text(desk, "1 ZEC = ");
check(await zecPill(desk).isVisible(), "with a router, the ZEC pill is a picker too");
await zecPill(desk).click();
const listbox = desk.getByRole("listbox", { name: "Tokens" });
await listbox.waitFor();
const options = await listbox.getByRole("option").evaluateAll((els) => els.map((e) => [e.textContent, e.getAttribute("aria-disabled")]));
const enabled = options.filter(([, off]) => off === "false").map(([t]) => t);
check(/^ZEC/.test(options[0][0]) && options[0][1] === "false", `ZEC is on top of the picker (${options[0][0]})`);
const priv = enabled.filter((t) => /privately/.test(t));
check(priv.length === 2 && priv.some((t) => /USD Coin · Base · privately/.test(t)) && priv.some((t) => /Litecoin · privately/.test(t)) && enabled.length === options.length, `from BTC, USDC on Base and LTC can be reached privately, and every coin can be picked (${priv.length} private of ${enabled.length})`);
check(options.some(([t, off]) => /^BTC/.test(t) && /switches the two sides/.test(t) && off === "false"), "BTC itself is listed: picking it swaps the two sides");
await settle();
await shot(desk, "01-picker-1440");
await listbox.getByRole("option", { name: /USD Coin · Base · privately/ }).click();
await desk.getByRole("button", { name: "Swap privately" }).waitFor();
// the path line: Ferry → shielded ZEC → Ferry, private, the default for two coins
await text(desk, "· private · about 35–75 min");
await desk.waitForFunction(() => /1 BTC ≈ [\d.]+ USDC · at least [\d.]+ USDC/.test(document.body.innerText), null, { timeout: 15_000 });
const amount = await desk.locator("input[inputmode=decimal]").inputValue();
check(amount === "0.0041", `the card starts at what about 1 ZEC costs, rounded down (${amount})`);
// 0.0041 BTC at Sandpiper's 413 800 sat/ZEC with 0.5% room: 0.985 ZEC; the second swap sells
// 0.9844 ZEC to Egret at 41.25 USDC
const out = await desk.locator("output").textContent();
const want = (Math.floor((98_440_000 * 41_250_000) / 1e8) / 1e6).toFixed(2);
check(out === want, `the quote goes through both partners' best prices (${out} USDC, want ${want})`);
await settle();
await shot(desk, "02-route-card-1440");

await desk.getByRole("button", { name: /^Settings: privacy pause/ }).click();
await desk.getByRole("radiogroup", { name: "Privacy pause" }).waitFor();
await text(desk, "Sandpiper sells you the ZEC");
await text(desk, "Egret buys it");
check((await desk.getByRole("radio", { name: /Standard/ }).getAttribute("aria-checked")) === "true", "settings: the Standard pause is the default, the partners differ");
await settle();
await shot(desk, "03-route-settings-1440");
await desk.getByRole("radio", { name: /^Off/ }).click();
await text(desk, "about 30–45 min");
await desk.getByRole("radio", { name: /^Standard/ }).click();
await desk.keyboard.press("Escape");

// the flip: USDC → BTC is a route the mock router runs too
await desk.getByRole("button", { name: "Switch direction" }).click();
await text(desk, "1 USDC ≈ ");
check((await desk.getByRole("button", { name: /You sell USDC/ }).count()) === 1, "Switch direction swaps the two coins of a private swap");
await desk.getByRole("button", { name: "Switch direction" }).click();
await text(desk, "1 BTC ≈ ");

// ZEC takes the card back to a plain swap: on the Sell side it would sell ZEC for USDC, which this
// server doesn't do; on the Buy side it buys ZEC with the BTC
await desk.getByRole("button", { name: /You sell BTC/ }).click();
check(/not with USDC here/.test(await desk.getByRole("listbox", { name: "Tokens" }).getByRole("option", { name: /^ZEC/ }).textContent()), "Sell ZEC for USDC: the picker says it isn't available here (no Ferry node sells ZEC for USDC here)");
await desk.keyboard.press("Escape");
await desk.getByRole("button", { name: /You get USDC/ }).click();
await desk.getByRole("listbox", { name: "Tokens" }).getByRole("option", { name: /^ZEC/ }).click();
await text(desk, "Buy ZEC");
check((await desk.getByRole("button", { name: "Swap privately" }).count()) === 0, "picking ZEC turns the card back into a plain swap (buy ZEC with BTC)");
await zecPill(desk).click();
await desk.getByRole("listbox", { name: "Tokens" }).getByRole("option", { name: /USD Coin · Base · privately/ }).click();
await desk.getByRole("button", { name: "Swap privately" }).waitFor();

// ------------------------------------------------------------------------------ confirm and start
await desk.getByRole("button", { name: "Swap privately" }).click();
const dialog = desk.getByRole("dialog", { name: "Swap privately" });
await dialog.waitFor();
for (const t of ["It takes longer", "Your coins pass through the shielded pool", "The waiting is on purpose", "Your money is never stuck"]) await text(desk, t);
check(true, "the confirmation says what's different, in four plain points");
await settle();
await shot(desk, "04-confirm-1440");
await dialog.getByRole("button", { name: "Start private swap" }).click();
await desk.waitForURL(/\/app\/route\/r[0-9a-f]+$/);
const id = desk.url().split("/").pop();
let v = await routeOf(id);
check(v.from === "btc" && v.to === "usdc-base" && v.amounts.zec_zat === 98_500_000 && v.amounts.in_max === 410_000, `the route asks for 0.985 ZEC, paying at most 0.0041 BTC (${v.amounts.zec_zat}, ${v.amounts.in_max})`);
check(v.legs[0].maker === "Sandpiper" && /\/m\/sandpiper$/.test(v.legs[0].maker_url), "leg 1's partner was named, and the server sent its allowlisted URL");
check(v.privacy.delay_secs[0] === 300 && v.privacy.delay_secs[1] === 1800, "the Standard pause reached the router as 5–30 min");
check(Math.abs(v.amounts.out_min - Math.floor(98_440_000 * 41_250_000 * 0.98 / 1e8)) <= 1, `leg 2's minimum is 2% under today's price (${v.amounts.out_min})`);

// ------------------------------------------------------------------------------ progress
await phone.goto(`${DEV}/app/route/${id}`);
const phase = async (name, state, wanted) => {
  await until(id, (r) => r.state === state, state);
  await Promise.all([text(desk, wanted), text(phone, wanted)]);
  await settle();
  await shot(desk, `05-${name}-1440`);
  await shot(phone, `05-${name}-390`);
};
await phase("a-swap1", "leg1", "Swap 1 of 2 is buying shielded ZEC");
check((await desk.locator('[aria-current="step"]').textContent()).includes("Swap 1: BTC → shielded ZEC"), "swap 1 is the current part");
await phase("b-settling", "settling", "so far, about");
await phase("c-pause", "pausing", "is resting in your shielded wallet");
check(await desk.getByRole("button", { name: "Skip the pause" }).isVisible(), "the pause can be skipped, with a warning");
await phase("d-swap2", "leg2", "Swap 2 of 2 is selling your ZEC");
await noOverflow(phone, "progress");
await phase("e-done", "done", "You received");
v = await routeOf(id);
check(v.outcome === "swapped" && v.legs[1].maker === "Egret", `done: Egret bought the ZEC (${v.legs[1].counter_units} USDC units)`);
await text(desk, "Swap again");

// ------------------------------------------------------------------------------ holding, Finish now
await idle();
await post(RT, "/api/_mock/fault", { leg2: "refund" });
await desk.goto(DEV + "/app");
await desk.getByRole("button", { name: "Swap privately" }).waitFor();
check(true, "the card remembers the private swap");
await desk.getByRole("button", { name: /^Settings: privacy pause/ }).click();
await desk.getByRole("radio", { name: /^Off/ }).click();
await desk.keyboard.press("Escape");
await desk.locator("input[inputmode=decimal]").fill("0.002");
await text(desk, "· private · about 30–45 min");
await desk.getByRole("button", { name: "Swap privately" }).click();
await text(desk, "You turned the pause off");
await desk.getByRole("dialog", { name: "Swap privately" }).getByRole("button", { name: "Start private swap" }).click();
await desk.waitForURL(/\/app\/route\/r[0-9a-f]+$/);
const id2 = desk.url().split("/").pop();
check(id2 !== id, "a second private swap starts");
await phone.goto(`${DEV}/app/route/${id2}`);
await until(id2, (r) => r.state === "holding", "holding");
await Promise.all([text(desk, "Finish now"), text(phone, "Finish now")]);
await text(desk, "The second swap was called off and undone");
await settle();
await shot(desk, "06-holding-1440");
await shot(phone, "06-holding-390");
v = await routeOf(id2);
check(v.outcome === "holding_zec" && v.legs[1].outcome === "refunded", "swap 2 called off and refunded: the route holds the ZEC");
await desk.getByRole("button", { name: "Finish now" }).click();
await until(id2, (r) => r.state === "done", "done after Finish now");
await text(desk, "You received");
v = await routeOf(id2);
check(v.legs[1].earlier_swaps.length === 1 && v.legs[1].label === `${id2}/2-2`, "Finish now ran swap 2 again under a new label, and it finished");

// ------------------------------------------------------------------------------ Activity
for (const p of [desk, phone]) {
  await p.goto(DEV + "/app/activity");
  await text(p, "Private swap");
}
const rows = await desk.locator("main ul > li").evaluateAll((els) => els.map((e) => e.textContent));
check(rows.length === 2 && rows.every((t) => /Private swap/.test(t) && /Done/.test(t)), `Activity: one row per private swap, their four swaps not listed on their own (${rows.length} rows)`);
await settle();
await shot(desk, "07-activity-1440");
await shot(phone, "07-activity-390");
await noOverflow(phone, "activity");

// ------------------------------------------------------------------------------ phone card + confirm
// a link can name a private swap: ?from=&to=
await phone.goto(DEV + "/app?from=btc&to=usdc-base");
await phone.getByRole("button", { name: "Swap privately" }).waitFor();
await phone.waitForFunction(() => /1 BTC ≈/.test(document.body.innerText), null, { timeout: 15_000 });
await settle();
await shot(phone, "02-route-card-390");
await noOverflow(phone, "route card");
await phone.getByRole("button", { name: "Swap privately" }).click();
await phone.getByRole("dialog", { name: "Swap privately" }).waitFor();
await settle();
await shot(phone, "04-confirm-390");
await phone.keyboard.press("Escape");
await phone.getByRole("button", { name: /You sell BTC/ }).click();
await phone.getByRole("listbox", { name: "Tokens" }).waitFor();
await settle();
await shot(phone, "01-picker-390");
await phone.keyboard.press("Escape");

// ------------------------------------------------------------------------------ no router, no route UI
const plain = await page(1440);
await plain.route("**/api/pairs", async (r) => {
  const body = await (await r.fetch()).json();
  await r.fulfill({ json: { ...body, routes: null } });
});
await plain.addInitScript(() => localStorage.setItem("ferry.route", "btc>usdc-base"));
await plain.goto(DEV + "/app?dir=buy");
await text(plain, "1 ZEC = ");
check((await plain.getByRole("button", { name: "Swap privately" }).count()) === 0, "without a router: no private swap, even one remembered");
await zecPill(plain).click();
const noRouter = await plain.getByRole("listbox", { name: "Tokens" }).getByRole("option").evaluateAll((els) => els.map((e) => e.textContent).filter((t) => !/not available here/.test(t)));
check(noRouter.length === 2 && /^ZEC/.test(noRouter[0]) && /^BTC/.test(noRouter[1]), `without a router: the picker has ZEC and BTC, the other coins not available here (${noRouter.length})`);
await plain.keyboard.press("Escape");
await plain.goto(DEV + "/app/activity");
await text(plain, "Activity");
await sleep(800);
check(!(await plain.evaluate(() => [...document.querySelectorAll("main li")].some((li) => li.textContent.includes("Private swap")))), "without a router: Activity lists no private swaps");
await plain.close();

// ------------------------------------------------------------------------------ production server
await reset();
await sleep(400);
const pairs = await (await fetch(PRD + "/api/pairs")).json();
check(JSON.stringify(pairs.routes) === JSON.stringify({ from: ["btc", "usdc-base"], to: ["btc", "ltc", "usdc-base"] }), `prod /api/pairs lists the routes the router runs (${JSON.stringify(pairs.routes)})`);
const body = { from: "btc", to: "usdc-base", zec_zat: 50_000_000, maker1: "Sandpiper", maker2: ["Ibis"], max_in: 220_000, min_out: 19_000_000, pause: "standard" };
let r = await post(PRD, "/router/api/routes", { ...body, maker1: `http://127.0.0.1:${Z}/m/sandpiper` });
check(r.status === 400 && /Unknown partner/.test((await r.json()).error), "prod: a raw partner URL is refused");
r = await post(PRD, "/router/api/routes", { ...body, zec_zat: 300_000_000 });
check(r.status === 400 && /limited to 2.00 ZEC/.test((await r.json()).error), "prod: the demo's per-swap cap applies to routes");
r = await post(PRD, "/router/api/routes", { ...body, from: "usdc-base", to: "usdc-base" });
check(r.status === 400, "prod: a route from a coin to itself is refused");
r = await fetch(PRD + "/router/api/status");
check(r.status === 403, "prod: the router's status (route counts) isn't public");
r = await fetch(PRD + "/routerx/api/routes");
check(r.status !== 200 || !String(r.headers.get("content-type")).includes("json"), "prod: /routerx is not the router");
r = await post(PRD, "/router/api/routes", { ...body, sweep_to: "uregtest1attacker" });
const created = await r.json();
check(r.status === 201 && created.legs[0].maker === "Sandpiper", `prod: a route starts by partner names (${r.status} ${created.error ?? ""})`);
check(created.legs.every((l) => !("maker_url" in l)), "prod: the view carries no partner URL");
const raw = await routeOf(created.id);
check(raw.legs[0].maker_url.endsWith("/m/sandpiper") && raw.privacy.delay_secs[1] === 1800, "prod: the router got the allowlisted URL and the pause");
check(raw.amounts.out_min === 19_000_000 && raw.amounts.in_max === 220_000, "prod: the price limits as asked");
const list = await (await fetch(PRD + "/router/api/routes")).json();
check(list.length === 1 && list.every((x) => x.legs.every((l) => !("maker_url" in l))), "prod: GET /router/api/routes, without URLs");
r = await post(PRD, "/router/api/routes", { ...body, to: "ltc", maker2: ["Avocet"] });
check(r.status === 409, `prod: one live route at a time (${r.status})`);
r = await post(PRD, `/router/api/routes/${created.id}/continue`, { maker2: ["http://evil"], min_out: 1 });
check(r.status === 409, "prod: continue is forwarded with no body of the browser's (the router refuses it during swap 1)");
// between its two swaps no swap runs on any daemon, but the route's ZEC waits on one: nothing may spend it
await until(created.id, (x) => x.state === "pausing", "the prod route's pause");
r = await post(PRD, "/daemon/z/api/swaps", { maker: "Kestrel", zec_zat: 20_000_000 });
check(r.status === 409 && /private swap/.test((await r.json()).error), `prod: no direct swap while a route is between its swaps (${r.status})`);
// SSE: the stream's routes carry no URL either
const ctl = new AbortController();
const es = await fetch(PRD + "/router/api/events", { signal: ctl.signal });
const reader = es.body.getReader();
let sse = "";
while (!/data: \{.*\}\n/.test(sse)) sse += new TextDecoder().decode((await reader.read()).value);
ctl.abort();
check(/^event: route/m.test(sse) && !sse.includes("maker_url"), "prod: the event stream's routes carry no URL");
await until(created.id, (x) => x.state === "done" || x.state === "holding", "the prod route to end", 1500);
await idle();
r = await post(PRD, "/router/api/routes", { ...body, to: "ltc", maker2: ["Avocet"], max_in: 230_000, min_out: 22_000_000 });
check(r.status === 429, `prod: a route counts as two swap starts against the per-IP limit (${r.status})`);

await browser.close();
console.log(shots.join("\n"));
process.exit(0);
