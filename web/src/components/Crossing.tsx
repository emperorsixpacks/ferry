import type { Crossing as CrossingModel, Leg } from "../derive";
import { btcShort, coin, zec } from "../format";

type Pt = [number, number];

// Two layouts of the same chart: shores left/right on wide screens, top/bottom on phones.
// Z's shore (Zcash) is always the first one, B's shore (Bitcoin) the second.
interface Geometry {
  w: number;
  h: number;
  landA: string;
  landB: string;
  btc: { zShore: Pt; lock: Pt; cancel: Pt; bShore: Pt };
  zec: { zShore: Pt; joint: Pt; bShore: Pt };
  reclaimOffset: Pt;
  shoreA: { name: Pt; party: Pt };
  shoreB: { name: Pt; party: Pt };
  labels: { lock: Pt; joint: Pt; cancel: Pt; lockAnchor: "start" | "middle"; jointAnchor: "middle" | "end"; cancelAnchor: "start" | "middle" };
  revealZ: { from: Pt; ctrl: Pt; label: Pt; anchor: "start" | "middle" | "end" };
  revealB: { from: Pt; ctrl: Pt; label: Pt; anchor: "start" | "middle" | "end" };
}

const WIDE: Geometry = {
  w: 720,
  h: 400,
  landA: "M0 0 H118 C130 40 110 72 124 112 C136 150 114 184 126 222 C138 262 116 302 128 340 C134 366 122 384 126 400 H0 Z",
  landB: "M720 0 H602 C590 40 610 72 596 112 C584 150 606 184 594 222 C582 262 604 302 592 340 C586 366 598 384 594 400 H720 Z",
  btc: { zShore: [184, 120], lock: [360, 120], cancel: [360, 200], bShore: [536, 120] },
  zec: { zShore: [184, 280], joint: [360, 280], bShore: [536, 280] },
  reclaimOffset: [0, 18],
  shoreA: { name: [16, 34], party: [58, 200] },
  shoreB: { name: [704, 34], party: [662, 200] },
  labels: { lock: [360, 84], joint: [360, 338], cancel: [360, 230], lockAnchor: "middle", jointAnchor: "middle", cancelAnchor: "middle" },
  revealZ: { from: [272, 130], ctrl: [262, 236], label: [284, 172], anchor: "start" },
  revealB: { from: [452, 172], ctrl: [460, 250], label: [470, 214], anchor: "start" },
};

const NARROW: Geometry = {
  w: 360,
  h: 600,
  landA: "M0 0 V82 C40 96 70 76 110 88 C150 100 184 78 222 90 C262 102 300 80 330 92 C344 96 352 88 360 90 V0 Z",
  landB: "M0 600 V518 C40 504 70 524 110 512 C150 500 184 522 222 510 C262 498 300 520 330 508 C344 504 352 512 360 510 V600 Z",
  btc: { zShore: [74, 140], lock: [74, 300], cancel: [130, 400], bShore: [74, 460] },
  zec: { zShore: [286, 140], joint: [286, 300], bShore: [286, 460] },
  reclaimOffset: [-20, 0],
  shoreA: { name: [16, 28], party: [334, 34] },
  shoreB: { name: [16, 548], party: [334, 566] },
  labels: { lock: [118, 296], joint: [266, 346], cancel: [148, 404], lockAnchor: "start", jointAnchor: "end", cancelAnchor: "start" },
  revealZ: { from: [84, 222], ctrl: [190, 196], label: [180, 180], anchor: "middle" },
  revealB: { from: [102, 436], ctrl: [330, 440], label: [196, 482], anchor: "middle" },
};

const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];

type TrackState = "planned" | "mempool" | "done" | "hidden";

function Track({ from, to, state, abort, n }: { from: Pt; to: Pt; state: TrackState; abort?: boolean; n?: number }) {
  if (state === "hidden") return null;
  const m = mid(from, to);
  return (
    <g className={`track track-${state}${abort ? " track-abort" : ""}`}>
      <line x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]} />
      {n != null && state !== "planned" ? (
        <g className="track-n" transform={`translate(${m[0]} ${m[1]})`}>
          <circle r={9} />
          <text dy="0.35em">{n}</text>
        </g>
      ) : null}
    </g>
  );
}

function trackState(leg: Leg | undefined, fallback: TrackState = "planned"): TrackState {
  if (!leg) return fallback;
  return leg.status === "pending" ? "planned" : leg.status;
}

function Token({ kind, at, pending, stuck, label }: { kind: "btc" | "zec"; at: Pt; pending: boolean; stuck?: boolean; label: string }) {
  return (
    <g className={`token token-${kind}${pending ? " token-pending" : ""}${stuck ? " token-stuck" : ""}`} style={{ transform: `translate(${at[0]}px, ${at[1]}px)` }}>
      <rect x={-34} y={-15} width={68} height={30} rx={15} className="token-hull" />
      {kind === "zec" ? <rect x={-34} y={-15} width={68} height={30} rx={15} fill="url(#hatch)" className="token-hatch" /> : null}
      <text className="token-sym" dy="0.36em">{kind === "zec" ? "ZEC" : coin().ticker}</text>
      <text className="token-amt" y={30}>{label}</text>
    </g>
  );
}

function Buoy({ at, held }: { at: Pt; held: boolean }) {
  return (
    <g className={`buoy${held ? " buoy-held" : ""}`} transform={`translate(${at[0]} ${at[1]})`}>
      <circle r={10} />
      <circle r={3.5} className="buoy-core" />
    </g>
  );
}

function Label({ at, title, sub, anchor = "middle", tone, land }: { at: Pt; title: string; sub?: string | string[]; anchor?: "start" | "middle" | "end"; tone?: "abort" | "magic"; land?: boolean }) {
  return (
    <text className={`chart-label${land ? " chart-label-land" : ""}${tone ? ` chart-label-${tone}` : ""}`} x={at[0]} y={at[1]} textAnchor={anchor}>
      <tspan className="chart-label-title">{title}</tspan>
      {(Array.isArray(sub) ? sub : sub ? [sub] : []).map((line, i) => (
        <tspan key={i} className="chart-label-sub" x={at[0]} dy={i ? "1.25em" : "1.45em"}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

export function CrossingChart({
  model,
  amounts,
  heights,
  narrow,
}: {
  model: CrossingModel | null;
  amounts: { zec_zat: number; btc_sat: number };
  heights: { btc: number | null; zec: number | null };
  narrow: boolean;
}) {
  const g = narrow ? NARROW : WIDE;
  const legs = model?.legs ?? [];
  const byTitle = (prefix: string) => legs.find((l) => l.title.startsWith(prefix));
  const path = model?.path ?? "happy";
  const aborted = path !== "happy";
  // EVM: no cancel transaction or output; refund and punish are calls on FerryLock itself
  const evm = coin().kind === "evm";
  const abortFrom = evm ? g.btc.lock : g.btc.cancel;
  // abort routes only appear on the chart once a cancel actually happens
  const spare: TrackState = "hidden";

  const btcAt = model ? { "b-shore": g.btc.bShore, lock: g.btc.lock, cancel: g.btc.cancel, "z-shore": g.btc.zShore }[model.btc.at] : g.btc.bShore;
  const zecAt = model ? { "z-shore": g.zec.zShore, joint: g.zec.joint, "b-shore": g.zec.bShore }[model.zec.at] : g.zec.zShore;
  const reveal = model?.reveal;
  const jointOpen = !!reveal;

  const rz = g.revealZ;
  const rb = g.revealB;
  // arrowheads stop at the edge of the token sitting on the joint buoy
  const jointEdge: Pt = narrow ? [g.zec.joint[0] - 38, g.zec.joint[1] - 4] : [g.zec.joint[0] - 14, g.zec.joint[1] - 19];
  const jointEdgeB: Pt = narrow ? [g.zec.joint[0] + 14, g.zec.joint[1] + 20] : [g.zec.joint[0] + 14, g.zec.joint[1] - 19];

  return (
    <svg className="chart" viewBox={`0 0 ${g.w} ${g.h}`} role="img" aria-label={`Swap crossing between the Zcash and ${coin().name} chains`}>
      <defs>
        <pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="5" className="hatch-line" />
        </pattern>
        <marker id="arrow-magic" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" className="arrow-magic" />
        </marker>
      </defs>

      <rect width={g.w} height={g.h} className="water" />
      <path d={g.landA} className="land land-zec" />
      <path d={g.landB} className="land" />

      <g className="shore-zec">
        <Label at={g.shoreA.name} title="Zcash" sub={["Ironwood pool", heights.zec != null ? `height ${heights.zec}` : ""]} anchor="start" land />
      </g>
      <Label at={g.shoreB.name} title={coin().name} sub={[coin().kind === "evm" ? "FerryLock" : "Taproot", heights.btc != null ? `height ${heights.btc}` : ""]} anchor={narrow ? "start" : "end"} land />
      <g className="party-flag" transform={`translate(${g.shoreA.party[0]} ${g.shoreA.party[1]})`}>
        <circle r={17} />
        <text dy="0.36em">Z</text>
      </g>
      <g className="party-flag" transform={`translate(${g.shoreB.party[0]} ${g.shoreB.party[1]})`}>
        <circle r={17} />
        <text dy="0.36em">B</text>
      </g>

      {/* abort routes */}
      {evm ? null : <Track from={g.btc.lock} to={g.btc.cancel} state={aborted ? trackState(byTitle("Cancel")) : spare} abort n={3} />}
      <Track from={abortFrom} to={g.btc.bShore} state={path === "refund" ? trackState(byTitle("B refunds")) : path === "punish" ? "hidden" : spare} abort n={4} />
      <Track from={abortFrom} to={g.btc.zShore} state={path === "punish" ? trackState(byTitle("Z punishes")) : path === "refund" ? "hidden" : spare} abort n={4} />
      {path === "refund" && byTitle("Z reclaims") ? (
        <Track from={add(g.zec.joint, g.reclaimOffset)} to={add(g.zec.zShore, g.reclaimOffset)} state={trackState(byTitle("Z reclaims"))} abort n={5} />
      ) : null}

      {/* happy routes */}
      <Track from={g.btc.bShore} to={g.btc.lock} state={trackState(byTitle("B locks"))} n={1} />
      <Track from={g.zec.zShore} to={g.zec.joint} state={trackState(byTitle("Z locks"))} n={2} />
      <Track from={g.btc.lock} to={g.btc.zShore} state={aborted ? "hidden" : trackState(byTitle("Z redeems") ?? byTitle("Z claims"))} n={3} />
      <Track from={g.zec.joint} to={g.zec.bShore} state={aborted ? "hidden" : trackState(byTitle("B sweeps"))} n={4} />

      <Buoy at={g.btc.lock} held={model?.btc.at === "lock"} />
      <Buoy at={g.zec.joint} held={model?.zec.at === "joint"} />
      {aborted && !evm ? <Buoy at={g.btc.cancel} held={model?.btc.at === "cancel"} /> : null}

      {coin().kind === "evm" ? (
        <Label at={g.labels.lock} title="FerryLock" sub={narrow ? "refund after t1" : "claim before t1, refund after"} anchor={g.labels.lockAnchor} />
      ) : (
        <Label at={g.labels.lock} title="Taproot lock" sub={narrow ? "cancel after T1" : "redeem, or cancel after T1"} anchor={g.labels.lockAnchor} />
      )}
      <Label
        at={g.labels.joint}
        title="Joint Ironwood note"
        anchor={g.labels.jointAnchor}
        sub={jointOpen ? (reveal?.learner === "B" ? "B knows z + b: spendable by B" : "Z knows z + b: spendable by Z") : model?.zec.stuck ? "locked for good" : "spendable only with z + b"}
        tone={jointOpen ? "magic" : undefined}
      />
      {aborted && !evm ? <Label at={g.labels.cancel} title="Cancel output" sub={narrow ? "refund or punish" : "refund, or punish after T2"} anchor={g.labels.cancelAnchor} tone="abort" /> : null}

      {reveal?.learner === "B" ? (
        <g className="reveal" key="rz">
          <path d={`M${rz.from[0]} ${rz.from[1]} Q${rz.ctrl[0]} ${rz.ctrl[1]} ${jointEdge[0]} ${jointEdge[1]}`} markerEnd="url(#arrow-magic)" pathLength={1} />
          <Label at={rz.label} title="z read from Z's" sub={coin().kind === "evm" ? "claim" : "redeem signature"} anchor={rz.anchor} tone="magic" />
        </g>
      ) : null}
      {reveal?.learner === "Z" ? (
        <g className="reveal" key="rb">
          <path d={`M${rb.from[0]} ${rb.from[1]} Q${rb.ctrl[0]} ${rb.ctrl[1]} ${jointEdgeB[0]} ${jointEdgeB[1]}`} markerEnd="url(#arrow-magic)" pathLength={1} />
          <Label at={rb.label} title="b read from B's" sub={coin().kind === "evm" ? "refund" : "refund signature"} anchor={rb.anchor} tone="magic" />
        </g>
      ) : null}

      <Token kind="zec" at={zecAt} pending={!!model?.zec.pending} stuck={model?.zec.stuck} label={`${zec(amounts.zec_zat)} ZEC`} />
      <Token kind="btc" at={btcAt} pending={!!model?.btc.pending} label={`${btcShort(amounts.btc_sat)} ${coin().ticker}`} />
    </svg>
  );
}
