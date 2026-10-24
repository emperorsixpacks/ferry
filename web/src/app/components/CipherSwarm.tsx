import { useEffect, useRef } from "react";

// SealPad's hero background: cipher-block particles drifting in a faked 3D field.
type Color = "empty" | "sealed" | "hot";
const RGBA: Record<Color, string> = { empty: "229, 231, 235", sealed: "24, 24, 24", hot: "255, 81, 0" };
const COUNT = 80;
const Z = 420;

export function CipherSwarm() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = 0;
    let h = 0;
    const resize = () => {
      w = canvas.offsetWidth;
      h = canvas.offsetHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const pick = (): Color => {
      const r = Math.random();
      return r < 0.1 ? "hot" : r < 0.28 ? "sealed" : "empty";
    };
    const ps = Array.from({ length: COUNT }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      z: Math.random() * 2 * Z - Z,
      vx: (Math.random() - 0.5) * 0.12,
      vy: (Math.random() - 0.5) * 0.12,
      vz: (Math.random() - 0.5) * 0.35,
      size: 5 + Math.random() * 22,
      color: pick(),
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.0035,
    }));
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      ps.sort((a, b) => a.z - b.z);
      for (const p of ps) {
        const t = (p.z + Z) / (2 * Z);
        const s = p.size * (0.35 + t * 0.85);
        const a = (p.color === "hot" ? 0.85 : p.color === "sealed" ? 0.65 : 0.5) * (0.2 + t * 0.8);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = `rgba(${RGBA[p.color]}, ${a.toFixed(3)})`;
        ctx.fillRect(-s / 2, -s / 2, s, s);
        ctx.restore();
      }
    };
    let raf = 0;
    const tick = () => {
      for (const p of ps) {
        p.x += p.vx;
        p.y += p.vy;
        p.z += p.vz;
        p.rot += p.vr;
        if (p.x < -40) p.x = w + 40;
        else if (p.x > w + 40) p.x = -40;
        if (p.y < -40) p.y = h + 40;
        else if (p.y > h + 40) p.y = -40;
        if (p.z < -Z) p.z = Z;
        else if (p.z > Z) p.z = -Z;
      }
      draw();
      raf = requestAnimationFrame(tick);
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) draw();
    else raf = requestAnimationFrame(tick);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);
  return <canvas ref={ref} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden />;
}
