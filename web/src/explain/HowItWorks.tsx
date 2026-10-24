import { useEffect, useRef, useState, type ReactNode } from "react";
import "@fontsource/instrument-serif/latin-400";
import "@fontsource/instrument-serif/latin-400-italic";
import "@fontsource/instrument-sans/latin-400";
import "@fontsource/instrument-sans/latin-500";
import "@fontsource/instrument-sans/latin-600";
import "@fontsource/fragment-mono/latin-400";
import { Link } from "../router";
import { Current } from "../swap/bold/Current";
import { CipherText } from "../swap/visual/ShieldedStream";
import "./explain.css";

// /how-it-works: the plain-language story of a Ferry swap in five short sections, each with one
// small demo. No protocol vocabulary here; /inspect has that, for developers.

const NUMS = "0123456789#%$&";
const PALETTE = { glyph: "#6f78e6", line: "#11131a", accent: "#2b3bff", font: "400 12px 'Fragment Mono', monospace" };
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// true once the element has scrolled into view (demos start then, and run once)
function useSeen<T extends Element>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setSeen(true), { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, seen] as const;
}

// a step counter that advances every `ms` while `on`, and loops
function useTicker(on: boolean, steps: number, ms: number) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!on || reduced()) return;
    const id = setInterval(() => setI((x) => (x + 1) % steps), ms);
    return () => clearInterval(id);
  }, [on, steps, ms]);
  return i;
}

export default function HowItWorks() {
  return (
    <div className="hx">
      <header className="hx-top">
        <Link to="/" className="hx-word">
          Ferry
        </Link>
        <Link to="/" className="hx-pill">
          Back to the app
        </Link>
      </header>

      <section className="hx-hero">
        <Current palette={PALETTE} state={{ energy: 0, sealed: false, settled: false }} />
        <div className="hx-hero-l">
          <span className="hx-meta">How it works / five short steps</span>
          <h1>How Ferry works</h1>
        </div>
        <div className="hx-hero-r">
          <p>
            Ferry lets you swap shielded ZEC for bitcoin with a stranger. You never trust them, nobody holds your coins in between, and your ZEC never
            leaves the shielded pool.
          </p>
        </div>
      </section>

      <Section n="01" kicker="The problem" title="Swapping today means giving something up." demo={<Problem />}>
        To trade ZEC for bitcoin you either hand your coins to someone in the middle, an exchange or a bridge, and hope they hand back the other
        side, or your ZEC has to leave the shielded pool, where its amount and addresses become public.
      </Section>

      <Section n="02" kicker="One key, cut in two" title="Your ZEC goes somewhere only two halves can open." demo={<Halves />}>
        Your ZEC moves to a fresh shielded address made just for this swap. Spending from it takes a key that exists only in two halves: you hold
        one, the other side holds the other. Neither half opens it alone.
      </Section>

      <Section n="03" kicker="Bitcoin makes it fair" title="Taking the bitcoin hands over your half." demo={<Fair />}>
        The other side locks their bitcoin first, in a way only you can claim. But claiming it means showing your half of the key in public, and
        that is exactly what lets them open the ZEC. Nobody can take without giving.
      </Section>

      <Section n="04" kicker="If anyone disappears" title="A deadline sends everyone's coins home." demo={<Deadline />}>
        Before anything is locked, both sides sign the way back. If the swap isn't finished by a deadline, it is called off and each side's coins
        return automatically. Going quiet after that only hurts the one who went quiet.
      </Section>

      <Section n="05" kicker="What the world sees" title="Two chains, nothing that ties them together." demo={<Seen />}>
        On Zcash, the swap is ciphertext: no amounts, no addresses. On Bitcoin, it looks like an ordinary payment from one wallet to another.
        Nothing on one chain points to the other.
      </Section>

      <footer className="hx-end">
        <p className="hx-end-say">That's the whole idea.</p>
        <Link to="/" className="hx-go">
          Try a swap →
        </Link>
        <Link to="/inspect" className="hx-dev">
          For developers: watch the protocol live
        </Link>
      </footer>
    </div>
  );
}

function Section({ n, kicker, title, demo, children }: { n: string; kicker: string; title: string; demo: ReactNode; children: ReactNode }) {
  const [ref, seen] = useSeen<HTMLElement>();
  return (
    <section ref={ref} className={`hx-sec${seen ? " hx-in-view" : ""}`}>
      <div className="hx-text">
        <span className="hx-meta">
          {n} / {kicker}
        </span>
        <h2>{title}</h2>
        <p>{children}</p>
      </div>
      <div className="hx-demo">{seen ? demo : null}</div>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------
// 01: a middleman holds your coins, or unshielding makes them public

function Problem() {
  const t = useTicker(true, 2, 2600);
  return (
    <div className="hx-problem">
      <div className="hx-card">
        <span className="hx-meta">Option A / a middleman</span>
        <div className="hx-flow">
          <span className="hx-coin">ZEC</span>
          <span className={`hx-arrow${t ? " hx-on" : ""}`} />
          <span className={`hx-box${t ? " hx-held" : ""}`}>
            <span className="hx-coin hx-coin-in">ZEC</span>
          </span>
        </div>
        <p className="hx-cap">Someone else holds your coins. You hope they send the bitcoin back.</p>
      </div>
      <div className="hx-card hx-card-ink">
        <span className="hx-meta">Option B / leave the shielded pool</span>
        <div className="hx-public">
          <CipherText text="1.00" sealed={!t} glyphs={NUMS} className="hx-big" />
          <span className="hx-addr">{t ? "from zoe's wallet → exchange" : ""}</span>
        </div>
        <p className="hx-cap">The amount and the addresses become public, for good.</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// 02: the shielded spot opens only with both halves

function Halves() {
  const [mine, setMine] = useState(true);
  const [theirs, setTheirs] = useState(false);
  const open = mine && theirs;
  return (
    <div className="hx-halves">
      <div className={`hx-safe${open ? " hx-open" : ""}`}>
        <span className="hx-meta">Shielded address, made for this swap</span>
        <CipherText text="1.00" sealed={!open} glyphs={NUMS} className="hx-big" />
        <span className="hx-unit">ZEC</span>
        <p className="hx-cap">{open ? "Both halves: it opens." : mine || theirs ? "One half isn't enough." : "Locked. Needs both halves."}</p>
      </div>
      <div className="hx-keys">
        <button type="button" className={`hx-half hx-half-l${mine ? " hx-in" : ""}`} onClick={() => setMine((v) => !v)} aria-pressed={mine}>
          <Half side="l" />
          <span>Your half</span>
        </button>
        <button type="button" className={`hx-half hx-half-r${theirs ? " hx-in" : ""}`} onClick={() => setTheirs((v) => !v)} aria-pressed={theirs}>
          <Half side="r" />
          <span>Their half</span>
        </button>
      </div>
      <p className="hx-try">Tap the halves to try.</p>
    </div>
  );
}

function Half({ side }: { side: "l" | "r" }) {
  // a round key bow on the left half, the teeth on the right; the cut between them is jagged
  return side === "l" ? (
    <svg viewBox="0 0 120 60" className="hx-key">
      <path d="M118 22 H40 C36 8 26 2 18 2 C8 2 2 14 2 30 C2 46 8 58 18 58 C26 58 36 52 40 38 H118 L110 33 L118 30 L110 26 Z" />
      <circle cx="20" cy="30" r="8" className="hx-hole" />
    </svg>
  ) : (
    <svg viewBox="0 0 120 60" className="hx-key">
      <path d="M2 22 L10 26 L2 30 L10 33 L2 38 H78 V52 H92 V38 H100 V48 H112 V38 H118 V22 Z" />
    </svg>
  );
}

// ------------------------------------------------------------------------------------------------
// 03: claiming the bitcoin reveals your half, which opens the ZEC for them

const FAIR_STEPS = [
  "The other side locks bitcoin that only you can claim.",
  "You claim it. Doing that shows your half of the key in public.",
  "They pick up your half and put it with theirs.",
  "Now the ZEC opens for them. You got the bitcoin, they got the ZEC.",
];

function Fair() {
  const [i, setI] = useState(0);
  const playing = useRef(false);
  const play = () => {
    if (playing.current) return;
    playing.current = true;
    setI(0);
    [1, 2, 3].forEach((s, k) => setTimeout(() => setI(s), 1400 * (k + 1)));
    setTimeout(() => (playing.current = false), 1400 * 3 + 200);
  };
  useEffect(() => {
    const id = setTimeout(play, 600);
    return () => clearTimeout(id);
  }, []);
  return (
    <div className={`hx-fair hx-fair-${i}`}>
      <div className="hx-fair-zec">
        <span className="hx-meta">Zcash</span>
        <CipherText text="1.00" sealed={i < 3} glyphs={NUMS} className="hx-mid" />
        <span className="hx-unit">ZEC {i < 3 ? "locked" : "theirs now"}</span>
        <span className="hx-fair-key">
          <Half side="r" />
        </span>
      </div>
      <div className="hx-fair-btc">
        <span className="hx-meta">Bitcoin</span>
        <span className="hx-mid">0.0041</span>
        <span className="hx-unit">BTC {i < 1 ? "locked for you" : "yours"}</span>
        <span className="hx-fair-shown">
          <Half side="l" />
          <span>your half, shown in public</span>
        </span>
      </div>
      <span className="hx-fair-travel" aria-hidden>
        <Half side="l" />
      </span>
      <div className="hx-fair-foot">
        <ol className="hx-dots">
          {FAIR_STEPS.map((_, k) => (
            <li key={k} className={k <= i ? "hx-on" : ""} />
          ))}
        </ol>
        <p className="hx-cap" aria-live="polite">
          {FAIR_STEPS[i]}
        </p>
        <button type="button" className="hx-replay" onClick={play}>
          Play again
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// 04: the deadline: a clock runs out and both coins go home

function Deadline() {
  const [run, setRun] = useState(0); // bump to replay
  const [t, setT] = useState(0); // 0..1 along the timeline
  useEffect(() => {
    if (reduced()) {
      setT(1);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const v = Math.min(1, (now - start) / 5200);
      setT(v);
      if (v < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [run]);
  const DEAD = 0.72;
  const past = t >= DEAD;
  return (
    <div className={`hx-deadline${past ? " hx-past" : ""}`}>
      <div className="hx-home">
        <div className="hx-shore">
          <span className="hx-meta">You</span>
          <span className={`hx-coin hx-coin-zec${past ? " hx-back" : ""}`}>ZEC</span>
        </div>
        <div className="hx-middle">
          <span className="hx-meta">{past ? "Called off" : "Locked for the swap"}</span>
        </div>
        <div className="hx-shore">
          <span className="hx-meta">Them</span>
          <span className={`hx-coin hx-coin-btc${past ? " hx-back" : ""}`}>BTC</span>
        </div>
      </div>
      <div className="hx-line">
        <span className="hx-mark" style={{ left: "0%" }}>
          Swap starts
        </span>
        <span className="hx-mark hx-mark-dead" style={{ left: `${DEAD * 100}%` }}>
          Deadline
        </span>
        <i className="hx-fill" style={{ width: `${t * 100}%` }} />
        <i className="hx-now" style={{ left: `${t * 100}%` }} />
      </div>
      <div className="hx-dead-foot">
        <p className="hx-cap" aria-live="polite">
          {past ? "The other side went silent. At the deadline, both coins went home." : "The other side has gone silent. The clock keeps running."}
        </p>
        <button type="button" className="hx-replay" onClick={() => setRun((r) => r + 1)}>
          Play again
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// 05: what each chain shows

function Seen() {
  const [grid, setGrid] = useState(() => Array.from({ length: 6 }, () => Array.from({ length: 26 }, () => NUMS[Math.floor(Math.random() * 10)]).join("")));
  useEffect(() => {
    if (reduced()) return;
    const G = "0123456789abcdef#$%&*+=/<>";
    const id = setInterval(
      () => setGrid((g) => g.map((r) => [...r].map((c) => (Math.random() < 0.1 ? G[Math.floor(Math.random() * G.length)] : c)).join(""))),
      100,
    );
    return () => clearInterval(id);
  }, []);
  return (
    <div className="hx-seen">
      <div className="hx-seen-zec">
        <span className="hx-meta">What Zcash shows</span>
        <div className="hx-field" aria-label="encrypted">
          {grid.map((r, i) => (
            <div key={i}>{r}</div>
          ))}
        </div>
        <p className="hx-cap">No amounts. No addresses. Only ciphertext.</p>
      </div>
      <div className="hx-nolink" aria-hidden>
        <i />
        <span>no link</span>
        <i />
      </div>
      <div className="hx-seen-btc">
        <span className="hx-meta">What Bitcoin shows</span>
        <ul className="hx-ledger">
          <li>
            <span>bc1p…7f2q</span>
            <span>0.0712 BTC</span>
          </li>
          <li className="hx-ours">
            <span>bc1p…a91x</span>
            <span>0.0041 BTC</span>
          </li>
          <li>
            <span>bc1q…3k8d</span>
            <span>1.2300 BTC</span>
          </li>
        </ul>
        <p className="hx-cap">One of these is your swap. It looks like every other payment.</p>
      </div>
    </div>
  );
}
