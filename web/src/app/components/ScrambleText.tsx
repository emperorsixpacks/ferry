import { useCallback, useEffect, useRef, useState } from "react";

// SealPad's ScrambleText: "settle" scrambles then reveals once; "live" keeps cycling (the
// encrypted look). Reduced motion shows the plain text.

const DEFAULT_CHARS = "▓░█◆◇▢◯X$#@01ABCDEF";
const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function scramble(text: string, chars: string, revealed = 0) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    out += i < revealed || ch === " " ? ch : chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

export function ScrambleText({
  text,
  mode = "settle",
  duration = 1200,
  speed = 70,
  delay = 0,
  chars = DEFAULT_CHARS,
  className,
}: {
  text: string;
  mode?: "settle" | "live";
  duration?: number;
  speed?: number;
  delay?: number;
  chars?: string;
  className?: string;
}) {
  const [display, setDisplay] = useState(() => (mode === "settle" ? scramble(text, chars) : text));
  const raf = useRef<number | null>(null);

  useEffect(() => {
    if (mode !== "live") return;
    if (reduced()) return setDisplay(text);
    const id = setInterval(() => setDisplay(scramble(text, chars)), speed);
    return () => clearInterval(id);
  }, [mode, text, speed, chars]);

  const settle = useCallback(() => {
    if (reduced()) return setDisplay(text);
    const start = performance.now();
    const tick = () => {
      const t = Math.min((performance.now() - start) / duration, 1);
      if (t >= 1) return setDisplay(text);
      setDisplay(scramble(text, chars, Math.floor(t * text.length)));
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }, [text, duration, chars]);

  useEffect(() => {
    if (mode !== "settle") return;
    const id = setTimeout(settle, delay);
    return () => {
      clearTimeout(id);
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [mode, delay, settle]);

  return (
    <span className={className} style={{ whiteSpace: "pre-wrap" }}>
      {display}
    </span>
  );
}
