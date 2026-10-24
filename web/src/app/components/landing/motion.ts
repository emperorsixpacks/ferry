import { useEffect, useState, type RefObject } from "react";

// The landing's motion plumbing: reduced motion, "is this on screen and is the tab visible" (so
// every animation stops when nobody can see it), and the blur-to-sharp reveal of its text.

const REDUCE = "(prefers-reduced-motion: reduce)";

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia(REDUCE).matches);
  useEffect(() => {
    const m = window.matchMedia(REDUCE);
    const on = () => setReduced(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return reduced;
}

// True while `ref` is (near) on screen and the tab is visible.
export function useOnScreen(ref: RefObject<Element>, rootMargin = "0px"): boolean {
  const [inView, setInView] = useState(false);
  const [shown, setShown] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, rootMargin]);
  useEffect(() => {
    const on = () => setShown(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return inView && shown;
}

// Elements marked `data-parallax="0.12"` under `ref` drift against the scroll by that share of
// their distance from the middle of the screen (written to --lp-py; the CSS moves them). Off with
// reduced motion.
export function useParallax(ref: RefObject<HTMLElement>) {
  useEffect(() => {
    const root = ref.current;
    if (!root || window.matchMedia(REDUCE).matches) return;
    const els = [...root.querySelectorAll<HTMLElement>("[data-parallax]")];
    let queued = false;
    const update = () => {
      queued = false;
      const mid = window.innerHeight / 2;
      // on a phone things are stacked, and drifting would make them overlap
      const still = window.innerWidth < 768;
      for (const el of els) {
        if (still) {
          el.style.removeProperty("--lp-py");
          continue;
        }
        // measured on the parent, which the drift doesn't move
        const r = (el.parentElement ?? el).getBoundingClientRect();
        if (r.bottom < -200 || r.top > window.innerHeight + 200) continue;
        const f = Number(el.dataset.parallax) || 0;
        el.style.setProperty("--lp-py", `${((r.top + r.height / 2 - mid) * -f).toFixed(1)}px`);
      }
    };
    const on = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    return () => {
      window.removeEventListener("scroll", on);
      window.removeEventListener("resize", on);
    };
  }, [ref]);
}

// Text marked `data-reveal` under `ref` eases from blurred to sharp the first time it scrolls into
// view. The hidden state only applies once this has run (the root gets `lp-reveal`), so nothing
// stays hidden without it; reduced motion shows everything at once (landing.css).
export function useReveal(ref: RefObject<HTMLElement>) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          (e.target as HTMLElement).dataset.shown = "";
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.1 },
    );
    root.querySelectorAll("[data-reveal]").forEach((el) => io.observe(el));
    root.classList.add("lp-reveal");
    return () => io.disconnect();
  }, [ref]);
}
