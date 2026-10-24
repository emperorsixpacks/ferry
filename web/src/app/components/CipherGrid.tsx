import { useEffect, useState } from "react";

// SealPad's cipher-block grid: small cells in three states, one flips every ~1.2s.
const COLS = 32;
const ROWS = 2;
type State = "empty" | "sealed" | "hot";
const FLIP: State[] = ["empty", "empty", "empty", "empty", "sealed", "sealed", "hot"];

function initial(): State[] {
  const g: State[] = new Array(COLS * ROWS).fill("empty");
  for (const i of [4, 11, 17, 23, 27, 36, 41, 49, 54, 60]) g[i] = "sealed";
  for (const i of [8, 21, 33, 47, 58]) g[i] = "hot";
  return g;
}

export function CipherGrid({ cols = COLS }: { cols?: number }) {
  const [grid, setGrid] = useState<State[]>(initial);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => {
      setGrid((g) => {
        const n = [...g];
        n[Math.floor(Math.random() * n.length)] = FLIP[Math.floor(Math.random() * FLIP.length)];
        return n;
      });
    }, 1200);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }} aria-hidden>
      {grid.slice(0, cols * ROWS).map((s, i) => (
        <div key={i} className={`aspect-square transition-colors duration-500 ${s === "hot" ? "bg-slate-500" : s === "sealed" ? "bg-slate-900" : "bg-slate-200"}`} />
      ))}
    </div>
  );
}
