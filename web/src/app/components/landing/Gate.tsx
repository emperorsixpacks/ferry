import { useEffect, useRef, type RefObject } from "react";
import { currentTheme, onThemeChange, type Theme } from "../../lib/theme";
import { Mark, type MarkId } from "./marks";
import { useOnScreen, useReducedMotion } from "./motion";

// The hero: the Shield Gate, on the page's canvas. A hexagon drawn in ink hairlines with a soft
// shadow, Zcash's emblem at its gold core, and a thin grey ring of ciphertext turning slowly round
// it. Coins (their own marks, the only colour here besides the gold) drift in from the left on thin
// grey trails, pass through the gate with a small gold pulse and a few grey glyphs scattering, and
// drift out on the right as other coins. Three or four are in flight at a time.
//
// One 2D canvas; the marks are the app's own SVGs, rasterised once. The loop runs only while the
// hero is on screen and the tab is visible, at no more than 1.5 device pixels per CSS pixel.
// `anchor` is an empty element the page places where the gate stands (below the text on wide
// screens, above it on phones). Reduced motion: the same scene, still.
//
// It follows the theme (app/lib/theme.ts): every frame takes its colours from the palette below,
// and a change of theme repaints at once, even when the scene is still. In dark mode the ink
// lines are near-white on the dark canvas, the gate's face is the card colour and the shadows are
// black; the gold and the coins stay as they are.

type RGB = [number, number, number];
interface Palette {
  ink: RGB; // the gate's hairlines and the faint field round it
  face: string; // the gate's face
  shadow: RGB; // under the gate and the coins
  shade: number; // how strong those shadows are, as a multiple of light mode's
  ring: string; // the ciphertext round the gate
  trail: RGB; // behind each coin
  glyph: RGB; // the glyphs scattering out of the gate
}
const PALETTES: Record<Theme, Palette> = {
  light: { ink: [24, 24, 27], face: "#fff", shadow: [24, 24, 27], shade: 1, ring: "#a1a1aa", trail: [161, 161, 170], glyph: [113, 113, 122] },
  dark: { ink: [232, 233, 236], face: "#16171b", shadow: [0, 0, 0], shade: 2.6, ring: "#5f626b", trail: [104, 107, 116], glyph: [138, 141, 150] },
};
const rgba = ([r, g, b]: RGB, a: number) => `rgba(${r},${g},${b},${a})`;
// Zcash gold (#F4B728) appears only at the core: its glow, the emblem, and the pulse as a coin passes
const GLYPHS = "░▒▓#%&@$01<>/=+*";

const COINS: MarkId[] = ["btc", "ltc", "usdc", "eth", "sol", "doge", "xrp"];
// Ferry's own coins come round more often than the ones NEAR Intents reaches
const WEIGHT: Record<string, number> = { btc: 3, eth: 3, usdc: 3, ltc: 2, sol: 1, doge: 1, xrp: 1 };
const TRAIL = 0.4; // a trail's length, as a share of its path
// the moment the reduced-motion still shows: coins spread out, one in, one through, one out
const STILL_AT = 8.6;

// --- small helpers ---------------------------------------------------------------------------------
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

type P = [number, number];
type Q = [P, P, P]; // a quadratic curve
const qAt = (q: Q, t: number): P => {
  const u = 1 - t;
  return [u * u * q[0][0] + 2 * u * t * q[1][0] + t * t * q[2][0], u * u * q[0][1] + 2 * u * t * q[1][1] + t * t * q[2][1]];
};
const qLen = (q: Q) => Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) + Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1]);

function hexPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 3;
    if (i === 0) ctx.moveTo(x + r * Math.cos(a), y + r * Math.sin(a));
    else ctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
  }
  ctx.closePath();
}

// --- the scene's state -----------------------------------------------------------------------------
interface Geo {
  W: number;
  H: number;
  gx: number;
  gy: number;
  R: number;
  narrow: boolean;
}

interface Traveller {
  born: number;
  a: MarkId;
  b: MarkId;
  qin: Q;
  qout: Q;
  din: number;
  dout: number;
  passed: boolean;
}

interface Glyph {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  ch: string;
}

interface Sim {
  t: number;
  geo: Geo | null;
  dpr: number;
  rand: () => number;
  travellers: Traveller[];
  glyphs: Glyph[];
  ring: string[];
  pulse: number;
  waves: number[];
  nextSpawn: number;
  slot: number;
  coins: Partial<Record<MarkId, HTMLCanvasElement>>;
}

// in: from lower-left round to upper-left; out: from upper-right round to lower-right. On phones,
// where the gate sits above the text, they come in from above and leave to either side, before the
// text starts (and anything lower fades out).
const angles = (narrow: boolean) => (narrow ? { inn: [208, 332], out: [6, 36] } : { inn: [150, 214], out: [-32, 30] });

function pathFrom(g: Geo, deg: number, bend: number, outward: boolean): Q {
  const a = (deg * Math.PI) / 180;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const tx = dx > 0 ? (g.W - g.gx) / dx : dx < 0 ? -g.gx / dx : Infinity;
  const ty = dy > 0 ? (g.H - g.gy) / dy : dy < 0 ? -g.gy / dy : Infinity;
  const far = Math.min(tx, ty) + 60;
  const edge: P = [g.gx + dx * far, g.gy + dy * far];
  const gate: P = [g.gx, g.gy];
  const mid: P = [(edge[0] + gate[0]) / 2 - dy * far * bend, (edge[1] + gate[1]) / 2 + dx * far * bend];
  return outward ? [gate, mid, edge] : [edge, mid, gate];
}

function pick(rand: () => number, not?: MarkId): MarkId {
  const pool = COINS.filter((c) => c !== not);
  let r = rand() * pool.reduce((n, c) => n + WEIGHT[c], 0);
  for (const c of pool) if ((r -= WEIGHT[c]) < 0) return c;
  return pool[0];
}

function spawn(s: Sim) {
  const g = s.geo!;
  const { inn, out } = angles(g.narrow);
  // walk the fans in a shuffled order, so arrivals spread out
  const order = [0, 3, 1, 4, 2];
  const u = (order[s.slot % 5] + 0.2 + s.rand() * 0.6) / 5;
  const v = (order[(s.slot + 2) % 5] + 0.2 + s.rand() * 0.6) / 5;
  s.slot++;
  const qin = pathFrom(g, inn[0] + (inn[1] - inn[0]) * u, (s.rand() - 0.5) * 0.3, false);
  const deg = out[0] + (out[1] - out[0]) * v;
  const qout = pathFrom(g, g.narrow && s.rand() < 0.5 ? 180 - deg : deg, (s.rand() - 0.5) * 0.3, true);
  // px/s: unhurried
  const speed = g.narrow ? 200 + s.rand() * 60 : 300 + s.rand() * 80;
  const a = pick(s.rand);
  s.travellers.push({ born: s.t, a, b: pick(s.rand, a), qin, qout, din: qLen(qin) / speed, dout: qLen(qout) / speed, passed: false });
}

export function Gate({ anchor }: { anchor: RefObject<HTMLElement> }) {
  const reduced = useReducedMotion();
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const sources = useRef<HTMLDivElement>(null);
  const running = useOnScreen(wrap) && !reduced;
  const step = useRef<(dt: number) => void>(() => {});

  useEffect(() => {
    const cv = canvas.current;
    const box = wrap.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !box || !ctx) return;
    const rand = rng(5);
    const s: Sim = {
      t: 0,
      geo: null,
      dpr: 1,
      rand,
      travellers: [],
      glyphs: [],
      ring: Array.from({ length: 36 }, () => GLYPHS[Math.floor(rand() * GLYPHS.length)]),
      pulse: 0,
      waves: [],
      nextSpawn: 0,
      slot: 0,
      coins: {},
    };

    // the coin marks, rasterised from the hidden SVGs below
    const marks = [...(sources.current?.querySelectorAll<HTMLElement>("[data-mark]") ?? [])];
    let pending = marks.length;
    marks.forEach((el) => {
      const id = el.dataset.mark as MarkId;
      const svg = el.querySelector("svg");
      if (!svg) return;
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = c.height = 128;
        c.getContext("2d")!.drawImage(img, 0, 0, 128, 128);
        s.coins[id] = c;
        if (--pending === 0) redraw();
      };
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(svg));
    });

    const mono = (px: number) => `500 ${px}px "JetBrains Mono", ui-monospace, monospace`;

    const frame = (dt: number) => {
      const g = s.geo;
      if (!g) return;
      const pal = PALETTES[currentTheme()];
      s.t += dt;
      const { W, H, gx, gy, R } = g;
      ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      while (s.t >= s.nextSpawn) {
        spawn(s);
        s.nextSpawn += (g.narrow ? 1.25 : 1.15) * (0.8 + s.rand() * 0.4);
      }

      // a faint field round the gate: hairline hexagons widening slowly
      ctx.lineWidth = 1;
      for (let i = 0; i < 3; i++) {
        const f = (s.t * 0.05 + i / 3) % 1;
        hexPath(ctx, gx, gy, R * (1.9 + f * 3));
        ctx.strokeStyle = rgba(pal.ink, 0.07 * (1 - f));
        ctx.stroke();
      }

      // trails and coins
      const alive: Traveller[] = [];
      const heads: { x: number; y: number; c: MarkId; sc: number; o: number }[] = [];
      for (const tr of s.travellers) {
        const age = s.t - tr.born;
        if (age > tr.din + 0.15 + tr.dout + 1) continue;
        alive.push(tr);
        // in: a little faster as it nears the gate
        const pin = Math.pow(clamp(age / tr.din, 0, 1.6), 1.25);
        if (pin < 1 + TRAIL) trail(ctx, tr.qin, Math.max(0, pin - TRAIL), Math.min(1, pin), pal.trail);
        if (pin < 1) heads.push({ ...xy(qAt(tr.qin, pin)), c: tr.a, sc: 1 - 0.55 * smooth(0.82, 1, pin), o: smooth(0, 0.06, pin) * (1 - smooth(0.9, 1, pin)) });
        if (!tr.passed && age >= tr.din) {
          tr.passed = true;
          through(s, tr);
        }
        // out: easing off as it leaves
        const ao = age - tr.din - 0.15;
        if (ao > 0) {
          const x = clamp(ao / tr.dout, 0, 1.6);
          const pout = 1 - Math.pow(1 - Math.min(x, 1), 1.25) + Math.max(0, x - 1);
          if (pout < 1 + TRAIL) trail(ctx, tr.qout, Math.max(0, pout - TRAIL), Math.min(1, pout), pal.trail);
          if (pout < 1) heads.push({ ...xy(qAt(tr.qout, pout)), c: tr.b, sc: 0.45 + 0.55 * smooth(0, 0.14, pout), o: smooth(0, 0.07, pout) });
        }
      }
      s.travellers = alive;

      // the coins, in their own colours, with a soft shadow; drawn under the gate, so they go in
      // behind its face and come out from under it
      const cs = g.narrow ? 38 : 50;
      ctx.save();
      ctx.shadowColor = rgba(pal.shadow, Math.min(1, 0.18 * pal.shade));
      ctx.shadowBlur = 14;
      ctx.shadowOffsetY = 5;
      for (const h of heads) {
        const img = s.coins[h.c];
        if (!img || h.o < 0.02) continue;
        const sz = cs * h.sc;
        ctx.globalAlpha = h.o;
        ctx.drawImage(img, h.x - sz / 2, h.y - sz / 2, sz, sz);
      }
      ctx.restore();
      ctx.globalAlpha = 1;

      // the gate's ring: a hairline and a band of grey ciphertext turning slowly
      ctx.strokeStyle = rgba(pal.ink, 0.12);
      ctx.beginPath();
      ctx.arc(gx, gy, R * 1.3, 0, Math.PI * 2);
      ctx.stroke();
      const ringR = R * 1.55;
      const gs = g.narrow ? 9 : 11;
      ctx.font = mono(gs);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = pal.ring;
      for (let i = 0; i < s.ring.length; i++) {
        if (rand() < 0.015) s.ring[i] = GLYPHS[Math.floor(rand() * GLYPHS.length)];
        const a = (i / s.ring.length) * Math.PI * 2 + s.t * 0.07;
        ctx.save();
        ctx.translate(gx + Math.cos(a) * ringR, gy + Math.sin(a) * ringR);
        ctx.rotate(a + Math.PI / 2);
        ctx.fillText(s.ring[i], 0, 0);
        ctx.restore();
      }

      // the hexagon: the paper's colour, a soft shadow, an ink hairline (warming to gold as a coin
      // passes)
      ctx.save();
      ctx.shadowColor = rgba(pal.shadow, Math.min(1, 0.16 * pal.shade));
      ctx.shadowBlur = 36;
      ctx.shadowOffsetY = 14;
      hexPath(ctx, gx, gy, R);
      ctx.fillStyle = pal.face;
      ctx.fill();
      ctx.restore();
      hexPath(ctx, gx, gy, R);
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.strokeStyle = mixInkGold(pal.ink, s.pulse > 0.02 ? s.pulse : 0);
      ctx.stroke();
      hexPath(ctx, gx, gy, R * 0.84);
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(pal.ink, 0.1);
      ctx.stroke();

      // the gold core: a soft glow, then Zcash's emblem
      const glow = ctx.createRadialGradient(gx, gy, 0, gx, gy, R * 0.85);
      glow.addColorStop(0, `rgba(244,183,40,${0.22 + 0.25 * s.pulse})`);
      glow.addColorStop(1, "rgba(244,183,40,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(gx, gy, R * 0.85, 0, Math.PI * 2);
      ctx.fill();
      const z = s.coins.zec;
      if (z) {
        const zs = R * 0.92 * (1 + 0.04 * s.pulse);
        ctx.drawImage(z, gx - zs / 2, gy - zs / 2, zs, zs);
      }

      // the pulse as a coin passes: a gold hexagon widening and fading
      s.waves = s.waves.map((w) => w + dt).filter((w) => w < 0.6);
      for (const w of s.waves) {
        const p = w / 0.6;
        hexPath(ctx, gx, gy, R * (1 + p * 0.35));
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = `rgba(244,183,40,${0.6 * (1 - p)})`;
        ctx.stroke();
      }

      // grey glyphs scattering out of the far side
      ctx.font = mono(g.narrow ? 10 : 12);
      const live: Glyph[] = [];
      for (const q of s.glyphs) {
        q.age += dt;
        if (q.age >= q.life) continue;
        q.vx *= 1 - 2.5 * dt;
        q.vy *= 1 - 2.5 * dt;
        q.x += q.vx * dt;
        q.y += q.vy * dt;
        if (rand() < 0.1) q.ch = GLYPHS[Math.floor(rand() * GLYPHS.length)];
        ctx.fillStyle = rgba(pal.glyph, 0.8 * (1 - smooth(0.4, 1, q.age / q.life)));
        ctx.fillText(q.ch, q.x, q.y);
        live.push(q);
      }
      s.glyphs = live;

      // on a phone, everything fades out below the gate, where the text starts
      if (g.narrow) {
        const y0 = gy + R * 2;
        ctx.globalCompositeOperation = "destination-out";
        const fade = ctx.createLinearGradient(0, y0, 0, y0 + 90);
        fade.addColorStop(0, "rgba(0,0,0,0)");
        fade.addColorStop(1, "rgba(0,0,0,1)");
        ctx.fillStyle = fade;
        ctx.fillRect(0, y0, W, H - y0);
        ctx.globalCompositeOperation = "source-over";
      }
      s.pulse = Math.max(0, s.pulse - dt * 3);
    };

    const layout = (): Geo => {
      const W = box.clientWidth;
      const H = box.clientHeight;
      const a = anchor.current?.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      const narrow = W < 640;
      const gx = a ? a.left - b.left + a.width / 2 : W / 2;
      const gy = a ? a.top - b.top + a.height / 2 : H * 0.68;
      const R = narrow ? 50 : clamp(Math.min(W * 0.06, (a?.height ?? 300) * 0.22), 58, 88);
      return { W, H, gx, gy, R, narrow };
    };
    // run the scene on from nothing, so the first frame already has coins in flight
    const preroll = (secs: number) => {
      s.t = 0;
      s.nextSpawn = 0;
      s.slot = 0;
      s.travellers = [];
      s.glyphs = [];
      s.waves = [];
      for (let n = 0; n < secs * 30; n++) frame(1 / 30);
    };
    function redraw() {
      if (reduced) preroll(STILL_AT);
      else frame(0);
    }
    const resize = () => {
      s.dpr = Math.min(1.5, window.devicePixelRatio || 1);
      cv.width = Math.round(box.clientWidth * s.dpr);
      cv.height = Math.round(box.clientHeight * s.dpr);
      const fresh = !s.geo;
      s.geo = layout();
      if (fresh || reduced) preroll(reduced ? STILL_AT : 5);
      else {
        // paths depend on the size: start the crossings over for the new one
        s.travellers = [];
        s.nextSpawn = s.t;
        for (let n = 0; n < 75; n++) frame(1 / 30);
      }
    };
    step.current = frame;
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(box);
    // the gate's spot moves when the text above it settles (web fonts), without the hero resizing
    if (anchor.current) ro.observe(anchor.current);
    // light or dark: repaint at once, whether the scene runs, stands still or waits off screen
    const off = onThemeChange(redraw);
    return () => {
      ro.disconnect();
      off();
    };
  }, [reduced, anchor]);

  useEffect(() => {
    if (!running) return;
    let last = performance.now();
    let id = requestAnimationFrame(function tick(now) {
      step.current(Math.min(0.05, (now - last) / 1000));
      last = now;
      id = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(id);
  }, [running]);

  return (
    <div ref={wrap} className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
      <div ref={sources} hidden>
        {[...COINS, "zec" as const].map((id) => (
          <span key={id} data-mark={id}>
            <Mark id={id} size={128} />
          </span>
        ))}
      </div>
    </div>
  );
}

const xy = ([x, y]: P) => ({ x, y });

// ink warming to gold, t 0..1
function mixInkGold(a: RGB, t: number) {
  const k = Math.min(1, t);
  const b = [244, 183, 40];
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(",")})`;
}

// a coin goes through: a small gold pulse, and a few grey glyphs out of the far side
function through(s: Sim, tr: Traveller) {
  const g = s.geo!;
  s.pulse = 1;
  s.waves.push(0);
  const [ex, ey] = qAt(tr.qout, 0.1);
  const base = Math.atan2(ey - g.gy, ex - g.gx);
  for (let j = 0; j < (g.narrow ? 5 : 7); j++) {
    const ang = base + (s.rand() - 0.5) * 1.6;
    const sp = 70 + s.rand() * 110;
    s.glyphs.push({
      x: g.gx + Math.cos(ang) * g.R * 0.9,
      y: g.gy + Math.sin(ang) * g.R * 0.9,
      vx: Math.cos(ang) * sp,
      vy: Math.sin(ang) * sp,
      age: 0,
      life: 0.6 + s.rand() * 0.4,
      ch: GLYPHS[Math.floor(s.rand() * GLYPHS.length)],
    });
  }
}

// a thin grey trail behind a coin, fading to nothing at its tail
function trail(ctx: CanvasRenderingContext2D, q: Q, from: number, to: number, grey: RGB) {
  if (to - from < 0.004) return;
  const tail = qAt(q, from);
  const head = qAt(q, to);
  const grad = ctx.createLinearGradient(tail[0], tail[1], head[0], head[1]);
  grad.addColorStop(0, rgba(grey, 0));
  grad.addColorStop(1, rgba(grey, 0.75));
  ctx.strokeStyle = grad;
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  ctx.beginPath();
  const N = 14;
  for (let j = 0; j <= N; j++) {
    const [x, y] = qAt(q, from + ((to - from) * j) / N);
    if (j === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}
