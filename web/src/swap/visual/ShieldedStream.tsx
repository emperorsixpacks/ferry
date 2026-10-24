import { useEffect, useRef, useState } from "react";
import { progress, type VisualProps } from "./Visual";

// Direction C: the privacy story told in type. On the Zcash side your amount dissolves into
// ciphertext the moment it is locked, and stays that way: that is all the chain ever shows. On the
// Bitcoin side the amount resolves into plain digits as it lands.

// plain ASCII, so every glyph has the monospace width and the text never jitters
const GLYPHS = "abcdef0123456789#$%&*+=/<>?@";
const rnd = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Text that is either plain or sealed. Sealing scrambles it left to right and keeps it churning;
// unsealing resolves it left to right.
export function CipherText({
  text,
  sealed,
  className,
  resolveOnMount,
  glyphs = GLYPHS,
}: {
  text: string;
  sealed: boolean;
  className?: string;
  resolveOnMount?: boolean;
  glyphs?: string;
}) {
  const [shown, setShown] = useState(text);
  const front = useRef(sealed || resolveOnMount ? text.length : 0); // characters currently scrambled

  useEffect(() => {
    if (reduced()) {
      setShown(sealed ? text.replace(/\S/g, "•") : text);
      return;
    }
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      if (t - last > 55) {
        last = t;
        const target = sealed ? text.length : 0;
        if (front.current < target) front.current = Math.min(target, front.current + 1);
        if (front.current > target) front.current = Math.max(target, front.current - 1);
        const n = front.current;
        setShown(
          [...text]
            .map((c, i) => {
              if (c === " ") return " ";
              // sealing eats the text from the left; unsealing gives it back from the left too
              if (sealed ? i < n : i >= text.length - n) return glyphs[Math.floor(Math.random() * glyphs.length)];
              return c;
            })
            .join(""),
        );
        // plain and settled: stop the loop
        if (!sealed && front.current === 0) return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, sealed, glyphs]);

  return (
    <span className={className} aria-label={sealed ? "encrypted" : text}>
      {shown}
    </span>
  );
}

// A block of churning ciphertext: the Zcash lock as an observer sees it.
function CipherField({ rows, cols, live }: { rows: number; cols: number; live: boolean }) {
  const [grid, setGrid] = useState(() => Array.from({ length: rows }, () => Array.from({ length: cols }, rnd).join("")));
  useEffect(() => {
    if (!live || reduced()) return;
    const id = setInterval(() => {
      setGrid((g) =>
        g.map((row) =>
          [...row]
            .map((c) => (Math.random() < 0.08 ? rnd() : c))
            .join(""),
        ),
      );
    }, 90);
    return () => clearInterval(id);
  }, [live]);
  return (
    <div className={`xc-field${live ? " xc-live" : ""}`} aria-hidden>
      {grid.map((r, i) => (
        <div key={i}>{r}</div>
      ))}
    </div>
  );
}

export function ShieldedStream({ scene, amounts }: VisualProps) {
  const p = progress(scene);
  const z = scene.role === "Z";
  const zecLocked = (z ? p.mineLocked : p.theirsLocked) && !p.undone;
  const btcLocked = (z ? p.theirsLocked : p.mineLocked) && !p.undone;
  const landed = p.done && !p.undone;
  const flowing = p.agreeing && !p.done && !p.undone;

  return (
    <div className={`xc${flowing ? " xc-flowing" : ""}${landed ? " xc-landed" : ""}`} role="img" aria-label={scene.caption}>
      <section className={`xc-side xc-zec${zecLocked ? " xc-sealed" : ""}`}>
        <header>
          <span className="xc-chain">Zcash</span>
          <span className="xc-who">{z ? "you send" : "you receive"}</span>
        </header>
        <div className="xc-amount">
          <CipherText text={amounts.zec} sealed={zecLocked} className="xc-num" />
          <span className="xc-unit">ZEC</span>
        </div>
        <p className="xc-note">{zecLocked ? "Sealed. The chain sees only ciphertext." : "Only you can see this amount."}</p>
        <CipherField rows={7} cols={30} live={zecLocked} />
      </section>

      <div className="xc-stream" aria-hidden>
        <i className="xc-rail" />
        {Array.from({ length: 5 }, (_, i) => (
          <span key={i} style={{ animationDelay: `${i * 0.4}s` }} />
        ))}
      </div>

      <section className={`xc-side xc-btc${btcLocked ? " xc-held" : ""}${(z ? p.claiming : p.done) ? " xc-resolved" : ""}`}>
        <header>
          <span className="xc-chain">Bitcoin</span>
          <span className="xc-who">{z ? "you receive" : "you pay"}</span>
        </header>
        <div className="xc-amount">
          {btcLocked || landed ? (
            <CipherText text={amounts.btc} sealed={false} resolveOnMount className="xc-num" />
          ) : (
            <span className="xc-num xc-pending">{amounts.btc}</span>
          )}
          <span className="xc-unit">BTC</span>
        </div>
        <p className="xc-note">
          {landed ? (z ? "In your wallet. An ordinary payment to anyone watching." : "Paid. An ordinary payment to anyone watching.") : btcLocked ? "Locked in the open, waiting for the swap." : "Appears once the other side locks it."}
        </p>
        <ol className="xc-ledger">
          {["tx", "tx", "tx"].map((_, i) => (
            <li key={i} className={btcLocked && i === 0 ? "xc-row-on" : landed && i === 1 ? "xc-row-on" : ""}>
              <span>{i === 0 ? "locked" : i === 1 ? "paid" : "…"}</span>
              <span className="xc-dots" />
              <span>{i < 2 ? `${amounts.btc} BTC` : ""}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
