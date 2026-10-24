import type { Deadlines as D, Path } from "../derive";
import { coin } from "../format";

// The two relative timelocks as a chart scale bar in Bitcoin block heights.
export function Deadlines({ d, height, path, t1Blocks, t2Blocks }: { d: D | null; height: number | null; path: Path; t1Blocks: number; t2Blocks: number }) {
  if (!d || height == null) {
    return (
      <div className="deadlines deadlines-empty">
        <p>
          Deadlines start when B's tx_lock confirms. Cancel becomes possible <b>{t1Blocks} blocks</b> later (T1), and punish{" "}
          <b>{t2Blocks} blocks</b> after the cancel confirms (T2).
        </p>
      </div>
    );
  }

  const start = d.lock - 1;
  // the bar spans the deadlines only; long after a swap the needle just rests at the end
  const end = d.t2 + 6;
  const span = end - start;
  const pct = (h: number) => `${((h - start) / span) * 100}%`;
  const blocks = Array.from({ length: span }, (_, i) => start + i);
  const phase = height >= d.t2 ? "punish" : height >= d.t1 ? "refund" : "redeem";

  return (
    <div className="deadlines">
      <div className="zones" aria-hidden>
        <div className={`zone${phase === "redeem" ? " zone-now" : ""}`} style={{ left: pct(d.lock), width: `calc(${pct(d.t1)} - ${pct(d.lock)})` }}>
          <span>Z can redeem</span>
        </div>
        <div className={`zone zone-abort${phase === "refund" ? " zone-now" : ""}`} style={{ left: pct(d.t1), width: `calc(${pct(d.t2)} - ${pct(d.t1)})` }}>
          <span>{path === "happy" ? "Cancel, then B can refund" : "B can refund"}</span>
        </div>
        <div className={`zone zone-abort${phase === "punish" ? " zone-now" : ""}`} style={{ left: pct(d.t2), right: 0 }}>
          <span>Z can punish</span>
        </div>
      </div>

      <div className="scale" role="img" aria-label={`${coin().name} height ${height}. T1 at ${d.t1}, T2 at ${d.t2}.`}>
        {blocks.map((h) => (
          <i key={h} className={h <= height ? (h % 2 ? "b-past b-odd" : "b-past") : h % 2 ? "b-odd" : undefined} />
        ))}
        <div className="needle" style={{ left: pct(Math.min(height + 1, end)) }} />
      </div>

      <div className="marks">
        <Mark at={pct(d.lock)} title="Lock" h={d.lock} />
        <Mark at={pct(d.t1)} title="T1" h={d.t1} />
        <Mark at={pct(d.t2)} title={d.t2Projected ? "T2, earliest" : "T2"} h={d.t2} end />
      </div>
      <p className="deadlines-now">
        {coin().name} height <span className="mono">{height}</span>
        {height < d.t1 ? <> with <span className="mono">{d.t1 - height}</span> blocks to T1</> : null}
        {height >= d.t1 && height < d.t2 ? <> with <span className="mono">{d.t2 - height}</span> blocks to T2</> : null}
      </p>
    </div>
  );
}

// the last mark hangs to the left of its tick so it never runs past the bar
function Mark({ at, title, h, end }: { at: string; title: string; h: number; end?: boolean }) {
  return (
    <div className={`mark${end ? " mark-end" : ""}`} style={{ left: at }}>
      <span className="mark-title">{title}</span>
      <span className="mono">{h}</span>
    </div>
  );
}
