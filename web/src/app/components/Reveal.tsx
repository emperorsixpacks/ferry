import { useEffect, useRef, useState, type ReactNode } from "react";

// SealPad's scroll reveal: travel in 24px and fade, once.
const from = { up: "opacity-0 translate-y-6", fade: "opacity-0" } as const;

export function Reveal({ children, delay = 0, direction = "up", duration = 700, className = "" }: { children: ReactNode; delay?: number; direction?: keyof typeof from; duration?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -50px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ transitionDelay: `${delay}ms`, transitionDuration: `${duration}ms` }} className={`transition-all ease-out ${seen ? "translate-y-0 opacity-100" : from[direction]} ${className}`}>
      {children}
    </div>
  );
}
