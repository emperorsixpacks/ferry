import { useEffect, useRef, type RefObject } from "react";
import { HUE, Mark, type MarkId } from "./marks";
import { useOnScreen, useReducedMotion } from "./motion";

// The hero: the Shield Gate. A glowing hexagonal gate with Zcash's emblem at its gold core, an aura
// that pulses, rings and a band of ciphertext turning around it. Coins stream in from the left on
// comet trails in their own colours, pass through the gate in a flash and a burst of scrambling
// glyphs, and fly out on the right as other coins on new trails. Many are in flight at once.
//
// Everything is drawn on one 2D canvas: the coin marks are the app's own SVGs, rasterised once.
// The loop runs only while the hero is on screen and the tab is visible, draws at no more than
// 1.5 times the CSS pixel size and caps its particles. `anchor` is an empty element the page places
// where the gate should stand (below the text on wide screens, above it on phones). Reduced
// motion: the same scene, frozen at a busy moment.

const GOLD = "#F4B728";
const GOLD_HI = "#FFE7A3";
const VIOLET = "#8B5CF6";
const CYAN = "#22D3EE";
const MAGENTA = "#E879F9";
const GLYPHS = "░▒▓█#%&@$01<>/=+*";

const COINS: MarkId[] = ["btc", "ltc", "usdc", "eth", "sol", "doge", "xrp"];
// how often each coin shows up: Ferry's own more often than the ones NEAR Intents reaches
const WEIGHT: Record<string, number> = { btc: 3, eth: 3, usdc: 3, ltc: 2, sol: 1, doge: 1, xrp: 1 };
// sprite colours: every coin's hue, then gold and the three glows
const PALETTE: string[] = [...COINS.map((c) => HUE[c]), GOLD, VIOLET, CYAN, MAGENTA];
const C_GOLD = COINS.length;
const hueIndex = (c: MarkId) => COINS.indexOf(c);

const MAX_PARTICLES = 320;
// a comet's tail, as a share of its path
const TRAIL = 0.45;

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
const rgbOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgba = (hex: string, a: number) => `rgba(${rgbOf(hex).join(",")},${a})`;
const lighten = (hex: string, t: number) => "#" + rgbOf(hex).map((v) => Math.round(v + (255 - v) * t).toString(16).padStart(2, "0")).join("");

type P = [number, number];
// a quadratic curve
type Q = [P, P, P];
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
// a point along a hexagon's outline, 0..1
function hexPoint(x: number, y: number, r: number, s: number): P {
  const f = (((s % 1) + 1) % 1) * 6;
  const i = Math.floor(f);
  const a0 = -Math.PI / 2 + (i * Math.PI) / 3;
  const a1 = a0 + Math.PI / 3;
  const t = f - i;
  return [x + r * (Math.cos(a0) + (Math.cos(a1) - Math.cos(a0)) * t), y + r * (Math.sin(a0) + (Math.sin(a1) - Math.sin(a0)) * t)];
}

// --- the scene's state -----------------------------------------------------------------------------
interface Geo {
  W: number;
  H: number;
  gx: number;
  gy: number;
  R: number;
  k: number;
  narrow: boolean;
}

interface Traveller {
  born: number;
  a: MarkId;
  b: MarkId;
  qin: Q;
  qout: Q;
  din: number; // seconds to the gate
  dout: number; // seconds out
  passed: boolean;
  out: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  glyph: number;
  c0: number;
  c1: number;
}

interface Sim {
  t: number;
  geo: Geo | null;
  dpr: number;
  rand: () => number;
  travellers: Traveller[];
  parts: Particle[];
  waves: { age: number; c: string }[];
  flash: number;
  nextSpawn: number;
  slot: number;
  stars: { x: number; y: number; r: number; p: number }[];
  ring: number[];
  glyphs: HTMLCanvasElement[][];
  dots: HTMLCanvasElement[];
  coins: Partial<Record<MarkId, HTMLCanvasElement>>;
}

// in: from lower-left round to upper-left; out: from upper-right round to lower-right. On phones,
// where the gate sits above the text, they pour in from above and leave to either side, low,
// before the text starts (and anything lower fades out).
function angles(narrow: boolean) {
  return narrow ? { inn: [205, 335], out: [8, 40] } : { inn: [148, 218], out: [-36, 32] };
}

function pathFrom(g: Geo, deg: number, bend: number, outward: boolean): Q {
  const a = (deg * Math.PI) / 180;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  // how far to the edge of the hero along this direction, and a little beyond
  const tx = dx > 0 ? (g.W - g.gx) / dx : dx < 0 ? -g.gx / dx : Infinity;
  const ty = dy > 0 ? (g.H - g.gy) / dy : dy < 0 ? -g.gy / dy : Infinity;
  const far = Math.min(tx, ty) + 70 * g.k;
  const edge: P = [g.gx + dx * far, g.gy + dy * far];
  const gate: P = [g.gx, g.gy];
  // a gentle bend: the control point pushed sideways from the middle
  const mid: P = [(edge[0] + gate[0]) / 2 - dy * far * bend, (edge[1] + gate[1]) / 2 + dx * far * bend];
  return outward ? [gate, mid, edge] : [edge, mid, gate];
}

function pick(rand: () => number, not?: MarkId): MarkId {
  const pool = COINS.filter((c) => c !== not);
  const total = pool.reduce((n, c) => n + WEIGHT[c], 0);
  let r = rand() * total;
  for (const c of pool) if ((r -= WEIGHT[c]) < 0) return c;
  return pool[0];
}

function spawn(s: Sim) {
  const g = s.geo!;
  const { inn, out } = angles(g.narrow);
  // spread the arrivals over the whole fan: walk through it in a shuffled order of slots
  const slots = 7;
  const order = [0, 4, 2, 6, 1, 5, 3];
  const u = (order[s.slot % slots] + s.rand() * 0.8) / slots;
  const v = (order[(s.slot + 3) % slots] + s.rand() * 0.8) / slots;
  s.slot++;
  const qin = pathFrom(g, inn[0] + (inn[1] - inn[0]) * u, (s.rand() - 0.5) * 0.36, false);
  const deg = out[0] + (out[1] - out[0]) * v;
  // on a phone, half leave to the left
  const qout = pathFrom(g, g.narrow && s.rand() < 0.5 ? 180 - deg : deg, (s.rand() - 0.5) * 0.36, true);
  // px/s: slower on a phone, where the paths are short
  const speed = (g.narrow ? 330 + s.rand() * 150 : 560 + s.rand() * 260) * g.k;
  const a = pick(s.rand);
  s.travellers.push({ born: s.t, a, b: pick(s.rand, a), qin, qout, din: qLen(qin) / speed, dout: qLen(qout) / (speed * 1.1), passed: false, out: false });
}

function addParticle(s: Sim, p: Particle) {
  if (s.parts.length >= MAX_PARTICLES) s.parts.shift();
  s.parts.push(p);
}

// the coin goes through: a flash, a shock wave, and its glyphs thrown out the far side
function burst(s: Sim, tr: Traveller) {
  const g = s.geo!;
  s.flash = Math.min(1.4, s.flash + 0.7);
  s.waves.push({ age: 0, c: HUE[tr.a] });
  const n = g.narrow ? 16 : 26;
  const [ex, ey] = qAt(tr.qout, 0.12);
  const base = Math.atan2(ey - g.gy, ex - g.gx);
  for (let j = 0; j < n; j++) {
    const ang = base + (s.rand() - 0.5) * 2.4;
    const sp = (120 + s.rand() * 300) * g.k;
    addParticle(s, {
      x: g.gx + Math.cos(ang) * g.R * 0.3,
      y: g.gy + Math.sin(ang) * g.R * 0.3,
      vx: Math.cos(ang) * sp,
      vy: Math.sin(ang) * sp,
      age: 0,
      life: 0.7 + s.rand() * 0.7,
      size: (9 + s.rand() * 8) * g.k,
      glyph: Math.floor(s.rand() * GLYPHS.length),
      c0: hueIndex(tr.a),
      c1: s.rand() < 0.5 ? C_GOLD : hueIndex(tr.b),
    });
  }
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
    const rand = rng(11);
    const s: Sim = {
      t: 0,
      geo: null,
      dpr: 1,
      rand,
      travellers: [],
      parts: [],
      waves: [],
      flash: 0,
      nextSpawn: 0,
      slot: 0,
      stars: Array.from({ length: 150 }, () => ({ x: rand(), y: rand(), r: 0.5 + rand() * 1.2, p: rand() * 6.28 })),
      ring: Array.from({ length: 44 }, () => Math.floor(rand() * GLYPHS.length)),
      glyphs: glyphSprites(),
      dots: PALETTE.map(dotSprite),
      coins: {},
    };
    document.fonts?.load('700 24px "JetBrains Mono"').then(() => void (s.glyphs = glyphSprites()));

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
        const x = c.getContext("2d")!;
        x.drawImage(img, 0, 0, 128, 128);
        // a fine light rim, so dark marks still read on the night
        if (id !== "zec") {
          x.strokeStyle = "rgba(255,255,255,0.35)";
          x.lineWidth = 3;
          x.beginPath();
          x.arc(64, 64, 62, 0, Math.PI * 2);
          x.stroke();
        }
        s.coins[id] = c;
        if (--pending === 0) redraw();
      };
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(svg));
    });

    const frame = (dt: number) => {
      const g = s.geo;
      if (!g) return;
      s.t += dt;
      const { W, H, gx, gy, R, k } = g;
      ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // new travellers
      while (s.t >= s.nextSpawn) {
        spawn(s);
        s.nextSpawn += (g.narrow ? 0.34 : 0.3) * (0.75 + s.rand() * 0.5);
      }

      // stars
      for (const st of s.stars) {
        ctx.fillStyle = `rgba(205,212,255,${0.18 + 0.4 * (0.5 + 0.5 * Math.sin(s.t * 1.4 + st.p))})`;
        ctx.fillRect(st.x * W, st.y * H, st.r, st.r);
      }

      ctx.globalCompositeOperation = "lighter";
      const pulse = 0.82 + 0.18 * Math.sin(s.t * 2.1);
      const glow = pulse + s.flash * 0.6;

      // the shield's field: hexagons widening out from the gate and fading
      ctx.lineWidth = 1;
      for (let i = 0; i < 5; i++) {
        const f = (s.t * 0.12 + i / 5) % 1;
        hexPath(ctx, gx, gy, R * (2.1 + f * 5));
        ctx.strokeStyle = rgba(VIOLET, 0.16 * (1 - f));
        ctx.stroke();
      }

      // the aura
      let gr = ctx.createRadialGradient(gx, gy, 0, gx, gy, R * 4.2);
      gr.addColorStop(0, rgba(GOLD, 0.34 * glow));
      gr.addColorStop(0.25, rgba(GOLD, 0.16 * glow));
      gr.addColorStop(0.5, rgba(VIOLET, 0.12 * glow));
      gr.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = gr;
      ctx.fillRect(gx - R * 4.2, gy - R * 4.2, R * 8.4, R * 8.4);

      // the travellers: comets in, through the gate, comets out
      const alive: Traveller[] = [];
      const heads: { x: number; y: number; c: MarkId; sc: number; o: number }[] = [];
      for (const tr of s.travellers) {
        const age = s.t - tr.born;
        const total = tr.din + 0.12 + tr.dout;
        if (age > total + 0.5) continue;
        alive.push(tr);
        // in: speeding up into the gate
        const pin = Math.pow(clamp(age / tr.din, 0, 1.6), 1.45);
        if (pin < 1.5) comet(ctx, tr.qin, Math.max(0, pin - TRAIL), Math.min(1, pin), HUE[tr.a], k);
        if (pin < 1) heads.push({ ...xy(qAt(tr.qin, pin)), c: tr.a, sc: 1 - 0.6 * smooth(0.86, 1, pin), o: smooth(0, 0.05, pin) * (1 - smooth(0.93, 1, pin)) });
        if (!tr.passed && age >= tr.din) {
          tr.passed = true;
          burst(s, tr);
        }
        // out: launched from the gate, easing off
        const ao = age - tr.din - 0.12;
        if (ao > 0) {
          const x = clamp(ao / tr.dout, 0, 1.5);
          const pout = 1 - Math.pow(1 - Math.min(x, 1), 1.35) + Math.max(0, x - 1);
          comet(ctx, tr.qout, Math.max(0, pout - TRAIL), Math.min(1, pout), HUE[tr.b], k);
          if (pout < 1) heads.push({ ...xy(qAt(tr.qout, pout)), c: tr.b, sc: 0.4 + 0.6 * smooth(0, 0.14, pout), o: smooth(0, 0.06, pout) });
        }
      }
      s.travellers = alive;

      // coins: a halo of their own colour, then the mark
      const cs = (g.narrow ? 42 : 60) * (k < 1 && !g.narrow ? 0.9 : 1);
      for (const h of heads) {
        if (h.o < 0.02) continue;
        const hs = cs * 2.8 * h.sc;
        ctx.globalAlpha = 0.65 * h.o;
        ctx.drawImage(s.dots[hueIndex(h.c)], h.x - hs / 2, h.y - hs / 2, hs, hs);
      }
      ctx.globalCompositeOperation = "source-over";
      for (const h of heads) {
        const img = s.coins[h.c];
        if (!img || h.o < 0.02) continue;
        const sz = cs * h.sc;
        ctx.globalAlpha = h.o;
        ctx.drawImage(img, h.x - sz / 2, h.y - sz / 2, sz, sz);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "lighter";

      // the gate: the band of ciphertext, the turning arcs, the outer ring
      const ringR = R * 1.58;
      ctx.save();
      ctx.translate(gx, gy);
      ctx.rotate(s.t * 0.14);
      for (let i = 0; i < s.ring.length; i++) {
        if (rand() < 0.04) s.ring[i] = Math.floor(rand() * GLYPHS.length);
        const a = (i / s.ring.length) * Math.PI * 2;
        const gs = 11 * Math.max(k, 0.75);
        ctx.save();
        ctx.rotate(a);
        ctx.translate(0, -ringR);
        ctx.globalAlpha = 0.5 + 0.5 * Math.sin(s.t * 3 + i);
        ctx.drawImage(s.glyphs[i % 7 === 0 ? C_GOLD + 2 : C_GOLD][s.ring[i]], -gs, -gs, gs * 2, gs * 2);
        ctx.restore();
      }
      ctx.restore();
      ctx.globalAlpha = 1;
      for (const [i, col] of [VIOLET, CYAN, MAGENTA].entries()) {
        const a0 = -s.t * 0.42 + (i * Math.PI * 2) / 3;
        for (const [w, al] of [
          [9, 0.18],
          [2, 0.9],
        ]) {
          ctx.strokeStyle = rgba(col, al * pulse);
          ctx.lineWidth = w;
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.arc(gx, gy, R * 1.3, a0, a0 + 1.15);
          ctx.stroke();
        }
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(GOLD_HI, 0.18);
      ctx.beginPath();
      ctx.arc(gx, gy, R * 1.95, 0, Math.PI * 2);
      ctx.stroke();
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2 + s.t * 0.05;
        const r0 = R * (i % 6 === 0 ? 1.86 : 1.9);
        ctx.beginPath();
        ctx.moveTo(gx + Math.cos(a) * r0, gy + Math.sin(a) * r0);
        ctx.lineTo(gx + Math.cos(a) * R * 1.98, gy + Math.sin(a) * R * 1.98);
        ctx.stroke();
      }

      // the hexagon: its gold core, then its frame of light
      const r = R * (1 + 0.025 * Math.sin(s.t * 2.1) + 0.04 * s.flash);
      ctx.globalCompositeOperation = "source-over";
      hexPath(ctx, gx, gy, r);
      gr = ctx.createRadialGradient(gx, gy - r * 0.15, 0, gx, gy, r);
      gr.addColorStop(0, "#3a2c0c");
      gr.addColorStop(0.55, "#1c1530");
      gr.addColorStop(1, "#0d0b22");
      ctx.fillStyle = gr;
      ctx.fill();
      ctx.globalCompositeOperation = "lighter";
      hexPath(ctx, gx, gy, r);
      gr = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
      gr.addColorStop(0, rgba(GOLD_HI, 0.55 * glow));
      gr.addColorStop(0.45, rgba(GOLD, 0.3 * glow));
      gr.addColorStop(1, rgba(GOLD, 0.04));
      ctx.fillStyle = gr;
      ctx.fill();
      ctx.lineJoin = "round";
      for (const [w, col, al] of [
        [16, GOLD, 0.16],
        [7, GOLD, 0.4],
        [2.5, GOLD_HI, 1],
      ] as const) {
        hexPath(ctx, gx, gy, r);
        ctx.strokeStyle = rgba(col, Math.min(1, al * glow));
        ctx.lineWidth = w * Math.max(k, 0.7);
        ctx.stroke();
      }
      // light running round the frame
      for (let j = 0; j < 2; j++) {
        const [px, py] = hexPoint(gx, gy, r, s.t * 0.22 + j / 2);
        const ds = R * 0.9;
        ctx.drawImage(s.dots[C_GOLD], px - ds / 2, py - ds / 2, ds, ds);
      }
      // Zcash's emblem at the heart
      const z = s.coins.zec;
      if (z) {
        const zs = R * 1.02 * (1 + 0.04 * s.flash);
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
        ctx.drawImage(z, gx - zs / 2, gy - zs / 2, zs, zs);
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.35 + 0.4 * s.flash;
        ctx.drawImage(s.dots[C_GOLD], gx - zs, gy - zs, zs * 2, zs * 2);
        ctx.globalAlpha = 1;
      }

      // shock waves: hexagons thrown off by each pass
      s.waves = s.waves.filter((w) => (w.age += dt) < 0.9);
      for (const w of s.waves) {
        const p = w.age / 0.9;
        hexPath(ctx, gx, gy, R * (1.05 + p * 1.6));
        ctx.strokeStyle = rgba(lighten(w.c, 0.4), 0.8 * (1 - p));
        ctx.lineWidth = 3 * (1 - p) + 0.5;
        ctx.stroke();
      }

      // glyphs: thrown out, slowing, scrambling as they go
      const live: Particle[] = [];
      for (const p of s.parts) {
        p.age += dt;
        if (p.age >= p.life) continue;
        p.vx *= 1 - 1.8 * dt;
        p.vy *= 1 - 1.8 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        live.push(p);
        const life = p.age / p.life;
        if (rand() < 0.12) p.glyph = Math.floor(rand() * GLYPHS.length);
        ctx.globalAlpha = Math.min(1, p.age * 10) * (1 - smooth(0.55, 1, life));
        ctx.drawImage(s.glyphs[life < 0.4 ? p.c0 : p.c1][p.glyph], p.x - p.size, p.y - p.size, p.size * 2, p.size * 2);
      }
      s.parts = live;
      ctx.globalAlpha = 1;
      // on a phone, everything fades out below the gate, where the text is
      if (g.narrow) {
        const y0 = gy + R * 1.7;
        ctx.globalCompositeOperation = "destination-out";
        gr = ctx.createLinearGradient(0, y0, 0, y0 + 150);
        gr.addColorStop(0, "rgba(0,0,0,0)");
        gr.addColorStop(1, "rgba(0,0,0,0.96)");
        ctx.fillStyle = gr;
        ctx.fillRect(0, y0, W, H - y0);
      }
      ctx.globalCompositeOperation = "source-over";
      s.flash = Math.max(0, s.flash - dt * 2.2);
    };

    const layout = () => {
      const W = box.clientWidth;
      const H = box.clientHeight;
      const a = anchor.current?.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      const narrow = W < 640;
      const k = narrow ? 0.7 : W < 1024 ? 0.85 : 1;
      const gx = a ? a.left - b.left + a.width / 2 : W / 2;
      const gy = a ? a.top - b.top + a.height / 2 : H * 0.68;
      const R = narrow ? 54 : clamp(Math.min(W * 0.07, (a?.height ?? 300) * 0.23), 66, 104);
      return { W, H, gx, gy, R, k, narrow };
    };
    // run the scene on from nothing, so the first frame is already full of crossings
    const preroll = (secs: number) => {
      s.t = 0;
      s.nextSpawn = 0;
      s.slot = 0;
      s.travellers = [];
      s.parts = [];
      s.waves = [];
      for (let n = 0; n < secs * 30; n++) frame(1 / 30);
    };
    function redraw() {
      if (reduced) preroll(6.3);
      else frame(0);
    }
    const resize = () => {
      const W = box.clientWidth;
      const H = box.clientHeight;
      // soft light needs no more than 1.5 device pixels per CSS pixel, and it saves a lot of filling
      s.dpr = Math.min(1.5, window.devicePixelRatio || 1);
      cv.width = Math.round(W * s.dpr);
      cv.height = Math.round(H * s.dpr);
      const fresh = !s.geo;
      s.geo = layout();
      // paths depend on the size: start the crossings over for the new one
      if (fresh || reduced) preroll(reduced ? 6.3 : 4);
      else {
        s.travellers = [];
        s.nextSpawn = s.t;
        for (let n = 0; n < 60; n++) frame(1 / 30);
      }
    };
    step.current = frame;
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(box);
    // the gate's spot moves when the text above it settles (web fonts), without the hero resizing
    if (anchor.current) ro.observe(anchor.current);
    return () => ro.disconnect();
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

// a comet: a trail from `from` to `to` along the curve, thick and faint behind, bright at the head
function comet(ctx: CanvasRenderingContext2D, q: Q, from: number, to: number, col: string, k: number) {
  if (to - from < 0.004) return;
  const glowCol = lighten(col, 0.2);
  const core = lighten(col, 0.6);
  for (const [share, w, c, a] of [
    [1, 26 * k, glowCol, 0.16],
    [0.75, 10 * k, glowCol, 0.45],
    [0.45, 3.2 * k + 0.5, core, 1],
  ] as const) {
    const f = to - (to - from) * share;
    const tail = qAt(q, f);
    const head = qAt(q, to);
    const g = ctx.createLinearGradient(tail[0], tail[1], head[0], head[1]);
    g.addColorStop(0, rgba(c, 0));
    g.addColorStop(1, rgba(c, a));
    ctx.strokeStyle = g;
    ctx.lineWidth = w;
    ctx.lineCap = "round";
    ctx.beginPath();
    const N = 16;
    for (let j = 0; j <= N; j++) {
      const [x, y] = qAt(q, f + ((to - f) * j) / N);
      if (j === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function glyphSprites() {
  const size = 32;
  return PALETTE.map((col) =>
    [...GLYPHS].map((ch) => {
      const c = document.createElement("canvas");
      c.width = c.height = size * 2;
      const x = c.getContext("2d")!;
      x.font = `700 ${size * 1.05}px "JetBrains Mono", ui-monospace, monospace`;
      x.textAlign = "center";
      x.textBaseline = "middle";
      x.shadowColor = col;
      x.shadowBlur = 12;
      x.fillStyle = lighten(col, 0.5);
      x.fillText(ch, size, size + 2);
      return c;
    }),
  );
}

function dotSprite(col: string) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,0.95)");
  g.addColorStop(0.18, rgba(col, 0.85));
  g.addColorStop(1, rgba(col, 0));
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  return c;
}
