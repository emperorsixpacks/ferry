// `pnpm film`: records the demo video against running ferryd daemons and edits it with ffmpeg.
//
//   cd web && source ../.demo/env && pnpm film      real daemons from infra/demo.sh (UI on :5180,
//                                                   the origin demo.sh allows)
//   pnpm film --mock                                the node mock instead, for working on the film
//
// One continuous Playwright recording (1440x900) is cut into segments by timestamps taken while
// the story plays. Waiting on chains is sped up to a fixed on-screen length, so the edit and the
// captions come out the same length on every run. Title cards and the caption band are an HTML
// overlay injected into the page, drawn in Ferry's own type and colours.
//
// The story: the swap app at / from the user's side, the protocol view of the same swap at
// /inspect, then a refund story back in the app.
//
// Writes film/ferry-demo.mp4 and film/captions.srt (one cue per lower third, for the voiceover).
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const MOCK = process.argv.includes("--mock");
const OUT = new URL("../film/", import.meta.url).pathname;
const WORK = join(OUT, ".work");
const W = 1440;
const H = 900;
const FPS = 30;

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

// ------------------------------------------------------------------------------------------------
// servers

const PORT = MOCK ? "5187" : process.env.PORT ?? "5180";
const env = MOCK
  ? { ...process.env, MOCK_Z_PORT: "7141", MOCK_B_PORT: "7142", FERRY_Z_URL: "http://127.0.0.1:7141", FERRY_B_URL: "http://127.0.0.1:7142", PORT }
  : { ...process.env, PORT };
if (!MOCK && !(env.FERRY_Z_TOKEN && env.FERRY_B_TOKEN)) {
  console.error("Real daemons need their API tokens: run `source ../.demo/env` first (or use --mock).");
  process.exit(1);
}
const procs = [spawn("pnpm", ["exec", "vite"], { env, stdio: "ignore" })];
if (MOCK) procs.push(spawn(process.execPath, ["mock/server.mjs"], { env, stdio: "ignore" }));
const cleanup = () => procs.forEach((p) => p.kill("SIGTERM"));
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = `http://localhost:${PORT}`;
for (let i = 0; ; i++) {
  try {
    if ((await fetch(BASE)).ok) break;
  } catch {}
  if (i > 100) throw new Error(`UI did not start on ${BASE} (is the port taken?)`);
  await sleep(200);
}

// ------------------------------------------------------------------------------------------------
// overlay: title cards, a caption band and a click ring, in Ferry's identity (ink, paper,
// ultramarine; Instrument Serif and Sans, Fragment Mono)

const OVERLAY = String.raw`
(() => {
  const css = ${"`"}
  .film-card { position: fixed; inset: 0; z-index: 100; display: grid; grid-template-columns: 1fr 1fr;
    opacity: 0; pointer-events: none; transition: opacity .7s cubic-bezier(.45,0,.2,1); }
  .film-card.on { opacity: 1; }
  .film-card::before { content: ""; background: #0e1030; }
  .film-card::after { content: ""; background: #ece8de; }
  .film-card-inner { position: absolute; inset: 0; display: grid; grid-template-columns: 1fr 1fr; align-items: center; }
  .film-card .l, .film-card .r { padding: 0 72px 0 96px; }
  .film-card .l { color: #ece8de; }
  .film-card .r { color: #101218; }
  .film-card .wm { font: italic 400 190px/0.9 "Instrument Serif", serif; letter-spacing: -.02em; }
  .film-card .meta { font: 400 13px/1.9 "Fragment Mono", monospace; letter-spacing: .18em; text-transform: uppercase; }
  .film-card .wm + .meta { margin-top: 34px; }
  .film-card .say { font: italic 400 64px/1.02 "Instrument Serif", serif; letter-spacing: -.015em; }
  .film-card ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 30px; }
  .film-card li { display: grid; grid-template-columns: 54px 1fr; align-items: baseline;
    font: italic 400 44px/1.08 "Instrument Serif", serif; }
  .film-card li span { font: 400 13px "Fragment Mono", monospace; letter-spacing: .14em; color: #2b3bff; }
  .film-band { position: fixed; left: 0; right: 0; bottom: 0; height: 76px; z-index: 90; pointer-events: none;
    background: #101218; color: #ece8de; display: flex; align-items: center; gap: 22px; padding: 0 48px;
    transform: translateY(100%); transition: transform .5s cubic-bezier(.2,.8,.2,1); }
  .film-band.on { transform: none; }
  .film-band .n { flex: none; min-width: 30px; height: 30px; padding: 0 9px; border-radius: 999px; background: #2b3bff;
    color: #fff; display: grid; place-items: center; font: 400 12px "Fragment Mono", monospace; letter-spacing: .1em; }
  .film-band .n:empty { display: none; }
  .film-band.quiet .n { background: #ece8de; color: #101218; }
  .film-band .t { font: italic 400 30px/1 "Instrument Serif", serif; white-space: nowrap; }
  .film-band .b { font: 400 17px/1.35 "Instrument Sans", sans-serif; color: #b9b6ae; }
  .film-band .x { transition: opacity .3s; }
  .bd { min-height: calc(100vh - 76px) !important; }
  .film-ring { position: fixed; z-index: 95; width: 58px; height: 58px; margin: -29px 0 0 -29px;
    border: 2px solid #2b3bff; border-radius: 50%; pointer-events: none;
    animation: film-ring .8s cubic-bezier(.2,.6,.3,1) forwards; }
  @keyframes film-ring { from { transform: scale(.4); opacity: 1 } to { transform: scale(1.5); opacity: 0 } }
  .film-mark { outline: 2px solid #2b3bff; outline-offset: 6px; }
  ${"`"};
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  const card = document.createElement("div");
  card.className = "film-card";
  const band = document.createElement("div");
  band.className = "film-band";
  band.innerHTML = '<span class="n"></span><span class="t"></span><span class="b"></span>';
  document.body.append(card, band);
  window.__film = {
    card(html) { card.innerHTML = '<div class="film-card-inner">' + html + "</div>"; card.classList.add("on"); },
    hideCard() { card.classList.remove("on"); },
    lower({ n = "", title, body, tone = "" }) {
      band.className = "film-band on " + tone;
      band.querySelector(".n").textContent = n;
      band.querySelector(".t").textContent = title;
      band.querySelector(".b").textContent = body;
    },
    hideLower() { band.classList.remove("on"); },
    ring(x, y) {
      const r = document.createElement("div");
      r.className = "film-ring";
      r.style.left = x + "px";
      r.style.top = y + "px";
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 900);
    },
  };
})();
`;

// ------------------------------------------------------------------------------------------------
// recording

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: WORK, size: { width: W, height: H } },
});
const page = await context.newPage();
const t0 = Date.now(); // the recording starts with the page
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
await page.goto(BASE + "/");
await page.evaluate(OVERLAY);
await sleep(2500); // fonts, first SSE events
// a daemon that has swapped before shows its last result; clear it so the film opens on the form
if (!(await page.locator(".bd-card button[type=submit]").count()) && (await page.locator(".bd-card .bd-go").count())) {
  await page.locator(".bd-card .bd-go").click();
  await page.mouse.move(4, 4);
  await sleep(500);
}

const marks = {};
const mark = (name) => (marks[name] = (Date.now() - t0) / 1000);
const film = (fn, arg) => page.evaluate(([fn, arg]) => window.__film[fn](arg), [fn, arg]);
const lower = (o) => film("lower", o);

async function clickWithRing(locator) {
  const box = await locator.boundingBox();
  await page.evaluate(([x, y]) => window.__film.ring(x, y), [box.x + box.width / 2, box.y + box.height / 2]);
  await sleep(350);
  await locator.click();
  await page.mouse.move(4, 4); // don't leave a hover state on the button
}

const api = (who, path, body) =>
  page.evaluate(
    async ([who, path, body]) =>
      (await fetch(`/daemon/${who}${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined)).json(),
    [who, path, body],
  );
const newest = (list) => list.sort((x, y) => (x.timeline[0]?.at ?? "").localeCompare(y.timeline[0]?.at ?? "")).at(-1);
const has = (v, kind) => !!v?.timeline.some((e) => e.kind === kind);
const confirmed = (v, kind) => !!v?.timeline.some((e) => e.kind === kind && e.height != null);

async function until(pred, label, minutes = 8) {
  const end = Date.now() + minutes * 60_000;
  while (Date.now() < end) {
    const [z, b] = await Promise.all([api("z", "/api/swaps"), api("b", "/api/swaps")]);
    if (pred(newest(z), newest(b))) return;
    await sleep(120);
  }
  throw new Error("timed out waiting for " + label);
}

const scrollTo = (selector, offset = 24) =>
  page.evaluate(
    ([sel, off]) => {
      const top = sel ? document.querySelector(sel).getBoundingClientRect().top + window.scrollY - off : 0;
      window.scrollTo({ top, behavior: "smooth" });
    },
    [selector, offset],
  );

// On-screen seconds for the segments that wait on chains, keyed by the mark that starts them.
// A step that finishes early is held in real time until it has filled its slot, so the edit never
// freezes a frame; a step that runs long is sped up to fit.
const TARGET = { h0: 6, h1: 6, h2: 6, h3: 6, r0: 6, r2: 8, r3: 7 };
async function hold(from) {
  const left = marks[from] + TARGET[from] - (Date.now() - t0) / 1000;
  if (left > 0) await sleep(left * 1000);
}

// The story. Each caption is also one cue; `cue` records which segment it spans.
const cues = [];
const cue = (from, to, text) => cues.push({ from, to, text });

// 1. title card (cut in once it has faded up)
await film(
  "card",
  `<div class="l"><div class="wm">Ferry</div><div class="meta">Shielded ZEC to Bitcoin</div></div>
   <div class="r"><div class="say">Goes in shielded.<br>Comes out Bitcoin.</div><div class="meta" style="margin-top:28px">No bridge / No custodian / Nothing unshielded</div></div>`,
);
await sleep(900);
mark("title");
await sleep(4000);
mark("titleEnd");
await film("hideCard");
await sleep(800);

// 2. the app at rest
mark("idle");
await lower({ title: "Your side of the swap", body: "You hold shielded ZEC and want bitcoin. On the other side is a stranger. No one in between." });
await sleep(5000);
mark("idleEnd");

// 3. the happy swap, from the user's side
await lower({ n: "1", title: "Bitcoin is locked first", body: "The other side locks theirs in a Taproot output before you risk anything." });
await clickWithRing(page.locator(".bd-card button[type=submit]"));
mark("h0");
await until((z) => has(z, "btc_lock_seen"), "BTC locked");
await hold("h0");
mark("h1");
await lower({ n: "2", title: "Your ZEC goes in shielded", body: "To an Ironwood address only this swap can open. On chain it is ciphertext." });
await until((z) => confirmed(z, "zec_lock_broadcast"), "ZEC locked");
await hold("h1");
mark("h2");
await lower({ n: "3", title: "You claim the bitcoin", body: "One signature. Claiming it is what hands the other side their key to the ZEC." });
await until((z) => has(z, "btc_redeem_broadcast"), "redeem");
await hold("h2");
mark("h3");
await lower({ n: "4", title: "Done", body: "Bitcoin in your wallet. To anyone watching it is an ordinary payment." });
await until((z, b) => z?.outcome && b?.outcome, "happy outcome");
await sleep(1500);
await hold("h3");
mark("swept");
cue("idle", "idleEnd", "Your side of the swap. You hold shielded ZEC and want bitcoin. No one in between.");
cue("h0", "h1", "The other side locks their bitcoin first, in a Taproot output.");
cue("h1", "h2", "Your ZEC goes in shielded, to an address only this swap can open.");
cue("h2", "h3", "You claim the bitcoin with one signature, and that hands them their key to the ZEC.");
cue("h3", "swept", "Done. To anyone watching, an ordinary bitcoin payment.");

// 4. underneath: the protocol view of the same swap
await film("hideLower");
// the developers' view of the same swap (the app links it from Details; jump straight there)
await page.evaluate(() => {
  window.history.pushState(null, "", "/inspect");
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
});
await sleep(1200);
mark("under");
await lower({ title: "Underneath", body: "The other side read z from your signature. With z and b, the joint note was theirs to sweep.", tone: "quiet" });
await sleep(6500);
mark("underEnd");
await scrollTo(".observer");
await sleep(1200);
await page.evaluate(() => {
  const li = [...document.querySelectorAll(".obs-btc li")].find((l) => /key-path/.test(l.textContent ?? ""));
  li?.classList.add("film-mark");
});
mark("obs");
await lower({ title: "What each chain saw", body: "Bitcoin: a Taproot payment with one signature. Zcash: encrypted actions. Nothing links them.", tone: "quiet" });
await sleep(8000);
mark("obsEnd");
cue("under", "underEnd", "Underneath, the other side read z from your signature, and with z and b swept the shielded note.");
cue("obs", "obsEnd", "What each chain saw: on Bitcoin, one-signature Taproot payments; on Zcash, ciphertext. Nothing links them.");

// 5. the refund story, back in the app
await film("hideLower");
await film("card", `<div class="l"><div class="say">And if the other side vanishes?</div></div><div class="r"><div class="meta">A second swap / one daemon stops responding</div></div>`);
await page.evaluate(() => window.scrollTo(0, 0));
await page.locator(".back-link").click();
await sleep(600);
mark("rCard");
await sleep(3400);
mark("rCardEnd");
await film("hideCard");
await sleep(500);
// a finished swap shows its result; start the next one from the result card
const againBtn = page.locator(".bd-card .bd-go");
if (await againBtn.count()) await againBtn.click();
await page.mouse.move(4, 4);
await sleep(500);
await lower({ n: "1", title: "A second swap", body: "Bitcoin locked, your ZEC sealed, exactly as before.", tone: "quiet" });
await clickWithRing(page.locator(".bd-card button[type=submit]"));
mark("r0");
await until((z) => z?.state === "ZecLocked" && confirmed(z, "zec_lock_broadcast"), "Z locked");
await hold("r0");
mark("r1");
await lower({ n: "2", title: "Then silence", body: "For the demo, one daemon stops responding. The claim never comes.", tone: "quiet" });
const zs = newest(await api("z", "/api/swaps"));
await api("z", `/api/swaps/${zs.id}/fault`, { fault: "stall" });
await sleep(3000);
mark("r2");
await lower({ n: "3", title: "The deadline passes", body: "The swap is called off. Both ways back were signed before anything was locked.", tone: "quiet" });
await until((z, b) => has(b, "refund_broadcast"), "refund");
await hold("r2");
mark("r3");
await lower({ n: "4", title: "Your ZEC comes back", body: "Automatically, into your shielded wallet. Nothing changed hands; nobody lost a coin.", tone: "quiet" });
await until((z, b) => z?.outcome && b?.outcome, "refund outcome");
await sleep(1800);
await hold("r3");
mark("r4");
cue("rCard", "rCardEnd", "And if the other side vanishes?");
cue("r0", "r1", "A second swap: bitcoin locked, your ZEC sealed, as before.");
cue("r1", "r2", "Then silence. The claim never comes.");
cue("r2", "r3", "The deadline passes and the swap is called off. Both ways back were signed in advance.");
cue("r3", "r4", "Your ZEC comes back to your shielded wallet. Nobody lost a coin.");

// 6. end card
await film("hideLower");
await film(
  "card",
  `<div class="l"><div class="wm" style="font-size:150px">Ferry</div><div class="meta">Shielded ZEC to Bitcoin</div></div>
   <div class="r"><ol>
     <li><span>01</span>No custodian.</li>
     <li><span>02</span>ZEC never leaves the shielded pool.</li>
     <li><span>03</span>On Bitcoin, a swap looks like any payment.</li>
   </ol></div>`,
);
await sleep(900);
mark("end");
await sleep(7000);
mark("endEnd");
cue("end", "endEnd", "No custodian. ZEC never leaves the shielded pool. And when it succeeds, the Bitcoin side looks like any other payment.");

await context.close(); // finalizes the video
await browser.close();
const webm = readdirSync(WORK).find((f) => f.endsWith(".webm"));
if (!webm) throw new Error("no recording");
const SRC = join(WORK, webm);
writeFileSync(join(WORK, "marks.json"), JSON.stringify(marks, null, 2));

// ------------------------------------------------------------------------------------------------
// edit: [from mark, to mark, on-screen seconds from TARGET]; `null` keeps real time

const EDL = [
  ["title", "titleEnd"],
  ["idle", "idleEnd"],
  ["h0", "h1"],
  ["h1", "h2"],
  ["h2", "h3"],
  ["h3", "swept"],
  ["under", "underEnd"],
  ["obs", "obsEnd"],
  ["rCard", "rCardEnd"],
  ["r0", "r1"],
  ["r1", "r2"],
  ["r2", "r3"],
  ["r3", "r4"],
  ["end", "endEnd"],
].map(([from, to]) => [from, to, TARGET[from] ?? null]);

const ff = (args) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("ffmpeg failed: " + args.join(" "));
};

const parts = [];
const timeline = {}; // mark -> output seconds, for the captions
let at = 0;
EDL.forEach(([from, to, target], i) => {
  const a = marks[from];
  const b = marks[to];
  const real = b - a;
  const speed = target ? Math.max(1, real / target) : 1;
  const out = target ?? real;
  const pad = Math.max(0, out - real / speed);
  const part = join(WORK, `part${String(i).padStart(2, "0")}.mp4`);
  ff([
    "-ss", a.toFixed(3), "-to", b.toFixed(3), "-i", SRC,
    "-vf", `setpts=(PTS-STARTPTS)/${speed.toFixed(4)},fps=${FPS},tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)},format=yuv420p`,
    "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-t", out.toFixed(3), part,
  ]);
  parts.push(part);
  timeline[from] = at;
  at += out;
  timeline[to] = at;
  console.log(`${from.padEnd(9)} → ${to.padEnd(9)} ${real.toFixed(1).padStart(5)}s real  x${speed.toFixed(2)}  ${out.toFixed(1)}s on screen`);
});

writeFileSync(join(WORK, "parts.txt"), parts.map((p) => `file '${p}'`).join("\n"));
const MP4 = join(OUT, "ferry-demo.mp4");
ff(["-f", "concat", "-safe", "0", "-i", join(WORK, "parts.txt"), "-c", "copy", "-movflags", "+faststart", MP4]);

const srtTime = (s) => {
  const ms = Math.round(s * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
const srt = cues
  .map((c, i) => `${i + 1}\n${srtTime(timeline[c.from])} --> ${srtTime(timeline[c.to])}\n${c.text}\n`)
  .join("\n");
writeFileSync(join(OUT, "captions.srt"), srt);
console.log(`\n${MP4}  ${at.toFixed(1)}s\n${join(OUT, "captions.srt")}  ${cues.length} cues`);

cleanup();
process.exit(0);
