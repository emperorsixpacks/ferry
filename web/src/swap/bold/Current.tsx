import { useEffect, useRef } from "react";

// The texture behind the bold page: lines of current running left to right across the whole
// stage. Left of the seam (Zcash) each line is drawn as a stream of ciphertext glyphs; right of
// it (Bitcoin) the same line is a plain stroke. Calm when idle, stronger while a swap runs, and a
// single accent pulse rides one line across the seam when the swap settles.

export interface CurrentPalette {
  // six-digit hex colours: the seam fade appends an alpha byte
  glyph: string; // ciphertext colour
  line: string; // plain current colour
  accent: string;
  font: string; // CSS font for the glyphs
}

export interface CurrentState {
  energy: number; // 0 calm … 1 swap under way
  sealed: boolean; // the Zcash side is locked: the glyphs churn faster and brighter
  settled: boolean; // done: the accent line holds steady
}

const GLYPHS = "0123456789abcdef#$%&*+=/<>";

export function Current({ palette, state }: { palette: CurrentPalette; state: CurrentState }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef(state);
  live.current = state;

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let w = 0;
    let h = 0;
    let energy = live.current.energy; // eased towards the target
    let last = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = (ms: number) => {
      const t = ms / 1000;
      const s = live.current;
      energy += (s.energy - energy) * 0.04;
      ctx.clearRect(0, 0, w, h);
      const rows = 26;
      const seam = w / 2;
      const band = 70;
      const cell = 15;
      const speed = 0.35 + energy * 0.9;
      const accentRow = Math.round(rows * 0.72); // runs in the clear band above the swap card
      ctx.font = palette.font;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";

      for (let i = 0; i < rows; i++) {
        const y0 = ((i + 0.5) / rows) * h;
        const amp = 7 + energy * 9 + (i % 3) * 2;
        const y = (x: number) =>
          y0 + amp * Math.sin(x * 0.006 + t * speed + i * 0.7) + amp * 0.5 * Math.sin(x * 0.017 - t * speed * 1.6 + i * 1.3);
        const isAccent = i === accentRow;
        // edge fade top and bottom so the field sits behind the type
        const edge = Math.min(1, Math.min(y0, h - y0) / (h * 0.22));

        // plain current on the Bitcoin side, fading in across the seam
        const on = isAccent && (s.settled || energy > 0.2);
        const colour = on ? palette.accent : palette.line;
        const grad = ctx.createLinearGradient(seam - band, 0, seam + band, 0);
        grad.addColorStop(0, `${colour}00`);
        grad.addColorStop(1, colour);
        ctx.beginPath();
        for (let x = seam - band; x <= w + 10; x += 8) {
          if (x === seam - band) ctx.moveTo(x, y(x));
          else ctx.lineTo(x, y(x));
        }
        ctx.strokeStyle = grad;
        ctx.globalAlpha = (on ? 0.95 : 0.24 + energy * 0.14) * edge;
        ctx.lineWidth = isAccent ? 2 : 1;
        ctx.stroke();

        // ciphertext current on the Zcash side
        const churn = s.sealed ? 14 : 4;
        for (let x = cell / 2 - ((t * speed * 40) % cell); x < seam + band; x += cell) {
          const k = Math.floor(x / cell);
          const fade = x < seam - band ? 1 : Math.max(0, 1 - (x - (seam - band)) / (band * 2));
          if (fade <= 0) continue;
          const n = Math.floor(t * churn + k * 7.3 + i * 13.1);
          const g = GLYPHS[Math.abs((n * 2654435761) >>> 0) % GLYPHS.length];
          const hot = s.sealed && ((k * 31 + i * 17 + Math.floor(t * 3)) % 23 === 0);
          ctx.fillStyle = hot || (isAccent && energy > 0.2) ? palette.accent : palette.glyph;
          ctx.globalAlpha = (s.sealed ? 0.55 : 0.32) * fade * edge * (0.75 + 0.25 * Math.sin(x * 0.02 + t));
          ctx.fillText(g, x, y(x));
        }
      }

      // the pulse that carries the swap across the seam
      if (energy > 0.2 && !s.settled && !still) {
        const p = (t * 0.22) % 1;
        const x = p * w;
        const i = accentRow;
        const y0 = ((i + 0.5) / rows) * h;
        const amp = 7 + energy * 9 + (i % 3) * 2;
        const y = y0 + amp * Math.sin(x * 0.006 + t * speed + i * 0.7) + amp * 0.5 * Math.sin(x * 0.017 - t * speed * 1.6 + i * 1.3);
        ctx.globalAlpha = 1;
        ctx.fillStyle = palette.accent;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const loop = (ms: number) => {
      if (ms - last > 33) {
        last = ms;
        draw(ms);
      }
      raf = requestAnimationFrame(loop);
    };
    if (still) draw(4000);
    else raf = requestAnimationFrame(loop);
    const onVis = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && !still) raf = requestAnimationFrame(loop);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [palette]);

  return <canvas ref={ref} className="bd-current" aria-hidden />;
}
