import { useEffect, useRef, useState } from "react";

// Asks each of several daemons the same thing now and then, each on its own: one request in flight
// per daemon, the next `every` ms after its answer (`retry` ms after a failure, so one that was down
// is back on the page soon after it answers again), and each answer used as it arrives. So a daemon
// that is slow, or never answers (the UI server gives up on it after 10 s: server/upstream.mjs),
// holds up nothing but its own part of the page, and never has more than one of these requests
// waiting on it (a browser talks to one server over at most 6 connections without HTTP/2).

export interface Poll<T> {
  // each key's last answer, kept through a failure after it
  data: Record<string, T>;
  // the keys whose last ask failed, with why
  errors: Record<string, string>;
  // ask every key again now
  refresh: () => void;
}

const without = (x: Record<string, string>, k: string) => {
  if (!(k in x)) return x;
  const { [k]: _, ...rest } = x;
  void _;
  return rest;
};

export function usePoll<T>(keys: string[], load: (key: string) => Promise<T>, { every, retry = every, on = true }: { every: number; retry?: number; on?: boolean }): Poll<T> {
  const [data, setData] = useState<Record<string, T>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [kick, setKick] = useState(0);
  // the latest `load`, without restarting the polls when the caller makes a new one
  const loadRef = useRef(load);
  loadRef.current = load;
  // each key's ask still out: when the keys change (or React runs the effect again), a key still being
  // asked waits for that answer instead of asking again, so a stuck daemon never gets a second one
  const out = useRef(new Map<string, Promise<T>>());
  const key = keys.join(",");
  useEffect(() => {
    if (!on || !keys.length) return;
    let alive = true;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const once = (k: string): Promise<T> => {
      let p = out.current.get(k);
      if (!p) {
        const asked = loadRef.current(k);
        p = asked;
        out.current.set(k, asked);
        const done = () => {
          if (out.current.get(k) === asked) out.current.delete(k);
        };
        asked.then(done, done);
      }
      return p;
    };
    for (const k of keys) {
      const ask = () => {
        once(k).then(
          (v) => {
            if (!alive) return;
            setData((x) => ({ ...x, [k]: v }));
            setErrors((x) => without(x, k));
            timers.set(k, setTimeout(ask, every));
          },
          (e: Error) => {
            if (!alive) return;
            setErrors((x) => ({ ...x, [k]: e?.message ?? "failed" }));
            timers.set(k, setTimeout(ask, retry));
          },
        );
      };
      ask();
    }
    return () => {
      alive = false;
      for (const t of timers.values()) clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, on, every, retry, kick]);
  return { data, errors, refresh: () => setKick((n) => n + 1) };
}

// A time that passes once per `key`: false until `ms` after the key was first seen, then true, so a
// page can wait a moment for answers and then show what it has.
export function useWaited(key: string, ms: number): boolean {
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    if (!key) return;
    const t = setTimeout(() => setDone(key), ms);
    return () => clearTimeout(t);
  }, [key, ms]);
  return done === key;
}
