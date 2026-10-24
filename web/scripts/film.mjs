// `pnpm film`: records the demo video against running ferryd daemons and edits it with ffmpeg.
//
//   cd web && source ../.demo/env && pnpm film      real daemons from infra/demo.sh (UI on :5180,
//                                                   the origin demo.sh allows)
//   pnpm film --mock                                the node mock instead, for working on the film
//
// One continuous Playwright recording (1440x900) is cut into segments by timestamps taken while
// the story plays. Waiting on chains is sped up to a fixed on-screen length, so the edit and the
// captions come out the same length on every run. Title cards and lower thirds are an HTML overlay
// injected into the page, drawn in the UI's own type and colours.
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
// overlay: title cards, lower thirds and a click ring, in the UI's design language

const OVERLAY = String.raw`
(() => {
  const css = ${"`"}
  .film-card { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center;
    background: var(--paper); opacity: 0; pointer-events: none; transition: opacity .6s cubic-bezier(.45,0,.2,1); }
  .film-card.on { opacity: 1; }
  .film-card-inner { width: 980px; }
  .film-card .wm { font: italic 600 132px/1 var(--serif); letter-spacing: -.02em; color: var(--ink); }
  .film-card .kicker { font: italic 400 34px/1.2 var(--serif); color: var(--ink); }
  .film-card .thesis { font: 400 30px/1.4 var(--sans); color: var(--ink-2); margin-top: 22px; }
  .film-card .route { display: flex; align-items: center; gap: 18px; margin-top: 46px;
    font: 600 18px var(--sans); color: var(--ink); }
  .film-card .route i { flex: 1; height: 0; border-top: 3px dashed var(--magenta); }
  .film-card ol { list-style: none; margin: 34px 0 0; padding: 0; display: grid; gap: 22px; }
  .film-card li { display: grid; grid-template-columns: 40px 1fr; gap: 18px; align-items: baseline;
    font: 400 26px/1.4 var(--sans); color: var(--ink-2); }
  .film-card li b { display: block; font: italic 600 30px/1.2 var(--serif); color: var(--ink); margin-bottom: 4px; }
  .film-card li span.n { width: 34px; height: 34px; border-radius: 50%; background: var(--magenta);
    color: var(--paper); display: grid; place-items: center; font: 600 16px var(--sans); transform: translateY(-4px); }
  .film-lower { position: fixed; left: 50%; bottom: 30px; z-index: 90; width: 660px; pointer-events: none;
    transform: translate(-50%, 14px); opacity: 0; transition: opacity .45s, transform .45s cubic-bezier(.45,0,.2,1);
    background: var(--paper); border: 1px solid var(--ink); border-top: 3px solid var(--ink);
    box-shadow: 0 10px 30px rgba(19,36,58,.16); padding: 16px 22px 18px;
    display: grid; grid-template-columns: auto 1fr; column-gap: 16px; align-items: start; }
  .film-lower.on { opacity: 1; transform: translate(-50%, 0); }
  .film-lower.magic { border-top-color: var(--magenta); }
  .film-lower.abort { border-top-color: var(--abort); }
  .film-lower .n { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center;
    font: 600 14px var(--sans); background: var(--magenta); color: var(--paper); margin-top: 3px; }
  .film-lower.abort .n { background: var(--abort); }
  .film-lower .n:empty { display: none; }
  .film-lower .t { font: italic 600 25px/1.2 var(--serif); color: var(--ink); }
  .film-lower.magic .t { color: var(--magenta); }
  .film-lower .b { font: 400 18px/1.45 var(--sans); color: var(--ink-2); margin-top: 4px; }
  .film-ring { position: fixed; z-index: 95; width: 54px; height: 54px; margin: -27px 0 0 -27px;
    border: 3px solid var(--magenta); border-radius: 50%; pointer-events: none;
    animation: film-ring .8s cubic-bezier(.2,.6,.3,1) forwards; }
  @keyframes film-ring { from { transform: scale(.4); opacity: 1 } to { transform: scale(1.5); opacity: 0 } }
  .film-mark { outline: 3px solid var(--magenta); outline-offset: 6px; border-radius: 2px;
    transition: outline-color .4s; }
  ${"`"};
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  const card = document.createElement("div");
  card.className = "film-card";
  const lower = document.createElement("div");
  lower.className = "film-lower";
  lower.innerHTML = '<span class="n"></span><div><div class="t"></div><div class="b"></div></div>';
  document.body.append(card, lower);
  window.__film = {
    card(html) { card.innerHTML = '<div class="film-card-inner">' + html + "</div>"; card.classList.add("on"); },
    hideCard() { card.classList.remove("on"); },
    lower({ n = "", title, body, tone = "" }) {
      const show = () => {
        lower.className = "film-lower " + tone;
        lower.querySelector(".n").textContent = n;
        lower.querySelector(".t").textContent = title;
        lower.querySelector(".b").textContent = body;
        requestAnimationFrame(() => lower.classList.add("on"));
      };
      if (lower.classList.contains("on")) { lower.classList.remove("on"); setTimeout(show, 380); } else show();
    },
    hideLower() { lower.classList.remove("on"); },
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
  colorScheme: "light",
  recordVideo: { dir: WORK, size: { width: W, height: H } },
});
const page = await context.newPage();
const t0 = Date.now(); // the recording starts with the page
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
await page.goto(BASE + "/how-it-works");
await page.evaluate(OVERLAY);
await sleep(2500); // fonts, first SSE events

const marks = {};
const mark = (name) => (marks[name] = (Date.now() - t0) / 1000);
const film = (fn, arg) => page.evaluate(([fn, arg]) => window.__film[fn](arg), [fn, arg]);
const lower = (o) => film("lower", o);

async function clickWithRing(locator) {
  const box = await locator.boundingBox();
  await page.evaluate(([x, y]) => window.__film.ring(x, y), [box.x + box.width / 2, box.y + box.height / 2]);
  await sleep(350);
  await locator.click();
}

const api = (who, path) =>
  page.evaluate(async ([who, path]) => (await fetch(`/daemon/${who}${path}`)).json(), [who, path]);
const newest = (list) => list.sort((x, y) => (x.timeline[0]?.at ?? "").localeCompare(y.timeline[0]?.at ?? "")).at(-1);
const has = (v, kind) => !!v?.timeline.some((e) => e.kind === kind);

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
const TARGET = { h0: 6, h1: 6, h2: 6, h3: 5, magicEnd: 6, r0: 6, r2: 8, r3: 7 };
async function hold(from) {
  const left = marks[from] + TARGET[from] - (Date.now() - t0) / 1000;
  if (left > 0) await sleep(left * 1000);
}

// The story. Each lower third is also one caption cue; `cue` records which segment it spans.
const cues = [];
const cue = (from, to, text) => cues.push({ from, to, text });

// 1. title card (cut in once it has faded up)
await film(
  "card",
  `<div class="wm">Ferry</div>
   <div class="thesis">Shielded ZEC ⇄ BTC. No bridge. No custodian. Nothing unshielded.</div>
   <div class="route"><span>Zcash</span><i></i><span>Bitcoin</span></div>`,
);
await sleep(800);
mark("title");
await sleep(4000);
mark("titleEnd");
await film("hideCard");
await sleep(700);

// 2. idle
mark("idle");
await lower({ title: "Two parties, two chains", body: "Z holds shielded ZEC and wants BTC. B holds BTC and wants ZEC. Nobody sits in between." });
await sleep(4800);
mark("idleEnd");

// 3. the happy swap
await lower({ n: "1", title: "B locks BTC first", body: "Into a Taproot output that needs both parties to spend, with a timelocked way back for B." });
await clickWithRing(page.locator("button[type=submit]"));
mark("h0");
await until((z, b) => has(b, "btc_lock_broadcast"), "tx_lock");
await hold("h0");
mark("h1");
await lower({ n: "2", title: "Z locks shielded ZEC", body: "Ironwood to Ironwood, to an address whose spend key is split in two: z + b. Neither side can spend it alone." });
await until((z) => has(z, "zec_lock_broadcast"), "ZEC lock");
await hold("h1");
mark("h2");
await lower({ n: "3", title: "B hands Z an adaptor signature", body: "Once the note is confirmed, B signs the redeem, encrypted so that only Z's secret z can complete it." });
await until((z) => has(z, "redeem_adaptor_received"), "redeem adaptor");
await hold("h2");
mark("h3");
await lower({ n: "4", title: "Z redeems the BTC", body: "One MuSig2 key-path signature. Completing it is what puts z on chain." });
await until((z, b) => has(b, "secret_extracted"), "z extracted");
await hold("h3");
mark("magic");
// With a key-path redeem, B often reads z within a second of the redeem, while the previous lower
// third is still up. Redraw the arc and the callout as the magic-moment caption arrives.
await page.evaluate(() =>
  document.querySelectorAll(".reveal path, .magic").forEach((el) =>
    el.getAnimations().forEach((a) => {
      a.currentTime = 0;
      a.play();
    }),
  ),
);
await lower({ title: "B reads z from Z's signature", body: "s − s′ = z. With z + b, B now holds the spend key of the joint Ironwood note.", tone: "magic" });
await sleep(5200);
mark("magicEnd");
await lower({ n: "5", title: "B sweeps the ZEC home", body: "After a random delay, into B's own shielded notes. The swap is done; neither side ever trusted the other." });
await until((z, b) => z?.outcome && b?.outcome, "happy outcome");
await sleep(1800);
await hold("magicEnd");
mark("swept");
cue("title", "titleEnd", "Ferry. Atomic swaps between shielded ZEC and Bitcoin.");
cue("idle", "idleEnd", "Two parties. Z holds shielded ZEC, B holds bitcoin. Nobody in between.");
cue("h0", "h1", "B locks BTC first: a Taproot output that needs both keys, with a timelocked way back.");
cue("h1", "h2", "Z locks ZEC, Ironwood to Ironwood, to an address whose spend key is split: z plus b.");
cue("h2", "h3", "B signs the redeem as an adaptor signature. Only Z's secret, z, can complete it.");
cue("h3", "magic", "Z completes it and claims the BTC. One key-path signature.");
cue("magic", "magicEnd", "That signature is the key. B subtracts its adaptor and recovers z.");
cue("magicEnd", "swept", "After a random delay, B sweeps the note into its own shielded wallet. Done.");

// 4. what each chain sees
await film("hideLower");
mark("obs");
await scrollTo(".observer");
await sleep(1200);
await page.evaluate(() => {
  const li = [...document.querySelectorAll(".obs-btc li")].find((l) => /key-path/.test(l.textContent ?? ""));
  li?.classList.add("film-mark");
});
await lower({ title: "What each chain sees", body: "Bitcoin: Taproot payments with single signatures. Zcash: encrypted actions. Nothing joins the two." });
await sleep(8800);
mark("obsEnd");
cue("obs", "obsEnd", "What did the chains see? Bitcoin: a Taproot output and a single-signature spend, like any payment. Zcash: encrypted actions. Nothing links them.");
await page.evaluate(() => document.querySelectorAll(".film-mark").forEach((e) => e.classList.remove("film-mark")));

// 5. the refund story
await film("hideLower");
await film("card", `<div class="kicker">What if Z disappears halfway?</div>
  <div class="thesis">A second swap. Z locks its ZEC, then stops responding.</div>`);
await scrollTo(null);
mark("rCard");
await sleep(3600);
mark("rCardEnd");
await film("hideCard");
await sleep(600);
await lower({ n: "1", title: "A second swap starts", body: "B locks BTC, Z locks ZEC, exactly as before.", tone: "abort" });
await clickWithRing(page.locator("button[type=submit]"));
mark("r0");
await until((z) => z?.state === "ZecLocked" && has(z, "zec_lock_broadcast"), "Z locked");
await hold("r0");
mark("r1");
await lower({ n: "2", title: "Z goes silent", body: "For the demo we stall Z's daemon. B never gets a redeem.", tone: "abort" });
await clickWithRing(page.getByRole("button", { name: "Make Z stall" }));
await sleep(2600);
mark("r2");
await lower({ n: "3", title: "After T1, B cancels and refunds", body: "Both abort transactions were presigned. B's refund signature puts b on chain.", tone: "abort" });
await until((z, b) => has(b, "refund_broadcast"), "refund");
await hold("r2");
mark("r3");
await lower({ n: "4", title: "Z takes its ZEC back", body: "Z reads b from the refund, so Z now holds z + b and sweeps the note home. Nobody lost anything.", tone: "abort" });
await until((z, b) => z?.outcome && b?.outcome, "refund outcome");
await sleep(2000);
await hold("r3");
mark("r4");
cue("rCard", "rCardEnd", "Now, what if Z vanishes?");
cue("r0", "r1", "Same start: B locks bitcoin, Z locks shielded ZEC.");
cue("r1", "r2", "Then Z goes silent.");
cue("r2", "r3", "After timelock T1, B cancels and takes its bitcoin back. The refund signature reveals b.");
cue("r3", "r4", "Z reads b from the refund and sweeps its ZEC home. Nobody loses a coin.");

// 6. end card
await film("hideLower");
await film(
  "card",
  `<div class="wm" style="font-size:84px">Ferry</div>
   <ol>
     <li><span class="n">1</span><div><b>No custodian</b>Two parties, two chains, and timelocks. No bridge, no committee, no federation.</div></li>
     <li><span class="n">2</span><div><b>ZEC never leaves the shielded pool</b>Ironwood to Ironwood to Ironwood. No transparent address, nothing in valueBalance.</div></li>
     <li><span class="n">3</span><div><b>On Bitcoin, a swap looks like any payment</b>The lock is a plain Taproot output; the redeem is one key-path signature.</div></li>
   </ol>`,
);
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
  ["h3", "magic"],
  ["magic", "magicEnd"],
  ["magicEnd", "swept"],
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
