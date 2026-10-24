import { progress, type VisualProps } from "./Visual";

// Direction A: an illustrated crossing. Your shore on the left, theirs on the right. The Bitcoin
// lane is open water in daylight; the Zcash lane runs under a bank of mist, so the ZEC boat is only
// ever a veiled shape. Each boat sails to the middle, waits at a moored lock, then crosses.

const W = 960;
const H = 560;
const LANE = { btc: 280, zec: 476 };
const X = { you: 248, lockYou: 392, lockThem: 568, them: 712 };

export function Crossing({ scene, amounts }: VisualProps) {
  const p = progress(scene);
  const zecFromYou = scene.role === "Z";
  // where each boat is: home → lock → across
  const zecHome = zecFromYou ? X.you : X.them;
  const zecFar = zecFromYou ? X.them : X.you;
  const btcHome = zecFromYou ? X.them : X.you;
  const btcFar = zecFromYou ? X.you : X.them;
  const zecLocked = zecFromYou ? p.mineLocked : p.theirsLocked;
  const btcLocked = zecFromYou ? p.theirsLocked : p.mineLocked;
  const crossed = p.claiming || p.done;

  const zecX = p.undone ? zecHome : crossed ? zecFar : zecLocked ? (zecFromYou ? X.lockYou : X.lockThem) : zecHome;
  const btcX = p.undone ? btcHome : crossed ? btcFar : btcLocked ? (zecFromYou ? X.lockThem : X.lockYou) : btcHome;
  // the ZEC only leaves the lock once the BTC has landed
  const zecLate = crossed && !p.done;

  return (
    <svg className="xa" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={scene.caption}>
      <defs>
        <linearGradient id="xa-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="xa-sky-top" />
          <stop offset="1" className="xa-sky-low" />
        </linearGradient>
        <linearGradient id="xa-btc-water" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="xa-bw-top" />
          <stop offset="1" className="xa-bw-low" />
        </linearGradient>
        <linearGradient id="xa-zec-water" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="xa-zw-top" />
          <stop offset="1" className="xa-zw-low" />
        </linearGradient>
        <filter id="xa-blur" x="-30%" y="-60%" width="160%" height="220%">
          <feGaussianBlur stdDeviation="16" />
        </filter>
        <filter id="xa-veil" x="-20%" y="-40%" width="140%" height="180%">
          <feGaussianBlur stdDeviation="2.4" />
        </filter>
        <pattern id="xa-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(40)">
          <line x1="0" y1="0" x2="0" y2="6" className="xa-hatch-line" />
        </pattern>
        <clipPath id="xa-zec-lane">
          <rect x="0" y="360" width={W} height={H - 360} />
        </clipPath>
      </defs>

      {/* sky and the far hills */}
      <rect width={W} height="200" fill="url(#xa-sky)" />
      <circle cx="770" cy="92" r="34" className="xa-sun" />
      <path d="M0 190 C120 150 210 172 300 158 C390 144 470 170 560 160 C650 150 760 136 860 156 C910 166 940 160 960 156 V200 H0 Z" className="xa-hills" />

      {/* Bitcoin lane: open water */}
      <rect y="196" width={W} height="168" fill="url(#xa-btc-water)" />
      <g className="xa-waves">
        {[222, 252, 286, 320, 348].map((y, i) => (
          <path key={y} d={wave(y, 6 + (i % 2) * 3)} className="xa-wave" style={{ animationDelay: `${-i * 1.7}s` }} />
        ))}
      </g>
      <text x="226" y="352" className="xa-lane-label">
        Bitcoin, in the open
      </text>

      {/* Zcash lane: under the mist */}
      <rect y="364" width={W} height={H - 364} fill="url(#xa-zec-water)" />
      <g clipPath="url(#xa-zec-lane)">
        {[392, 426, 462, 500, 534].map((y, i) => (
          <path key={y} d={wave(y, 5)} className="xa-wave xa-wave-dim" style={{ animationDelay: `${-i * 2.3}s` }} />
        ))}
      </g>
      <line x1="0" x2={W} y1="364" y2="364" className="xa-bar" />
      <text x="226" y="540" className="xa-lane-label xa-lane-label-zec">
        Zcash, shielded
      </text>

      {/* the moorings in the middle of each lane */}
      <g className={`xa-mooring${p.agreeing ? " xa-on" : ""}`}>
        <Mooring x={W / 2} y={LANE.btc + 18} locked={btcLocked && !crossed && !p.undone} />
        <Mooring x={W / 2} y={LANE.zec + 18} locked={zecLocked && !p.done && !p.undone} />
      </g>

      {/* shores: you on the left, them on the right */}
      <Shore side="left" label="You" />
      <Shore side="right" label="Them" />

      {/* the boats */}
      <g className="xa-boat-pos" style={{ transform: `translate(${btcX}px, ${LANE.btc}px)` }}>
        <Boat kind="btc" label={`${amounts.btc} BTC`} landed={(p.done || p.claiming) && btcX === btcFar} />
      </g>
      <g className={`xa-boat-pos${zecLate ? " xa-late" : ""}`} style={{ transform: `translate(${zecLate ? (zecFromYou ? X.lockYou : X.lockThem) : zecX}px, ${LANE.zec}px)` }}>
        <Boat kind="zec" label={`${amounts.zec} ZEC`} landed={false} />
      </g>

      {/* the mist rolls over the Zcash lane, in front of the boat */}
      <g className="xa-mist" clipPath="url(#xa-zec-lane)">
        <ellipse cx="180" cy="430" rx="260" ry="52" />
        <ellipse cx="560" cy="470" rx="300" ry="60" />
        <ellipse cx="860" cy="420" rx="240" ry="48" />
        <ellipse cx="380" cy="520" rx="280" ry="50" />
      </g>
    </svg>
  );
}

function wave(y: number, amp: number) {
  let d = `M-120 ${y}`;
  for (let x = -120; x < W + 120; x += 60) d += ` q15 ${-amp} 30 0 t30 0`;
  return d;
}

function Mooring({ x, y, locked }: { x: number; y: number; locked: boolean }) {
  return (
    <g transform={`translate(${x} ${y})`} className={`xa-buoy${locked ? " xa-buoy-locked" : ""}`}>
      <line x1="0" y1="-30" x2="0" y2="-4" className="xa-buoy-pole" />
      <ellipse cx="0" cy="0" rx="13" ry="6" className="xa-buoy-body" />
      <g transform="translate(-8 -50)" className="xa-lock">
        <path d="M3 8V5.5a5 5 0 0110 0V8" className="xa-lock-shackle" />
        <rect x="0" y="8" width="16" height="12" rx="2.5" className="xa-lock-body" />
      </g>
    </g>
  );
}

function Shore({ side, label }: { side: "left" | "right"; label: string }) {
  const left = side === "left";
  const land = left
    ? "M0 190 H150 C176 230 160 270 182 312 C204 356 176 402 196 448 C214 494 186 528 200 560 H0 Z"
    : "M960 190 H810 C784 230 800 270 778 312 C756 356 784 402 764 448 C746 494 774 528 760 560 H960 Z";
  const dockX = left ? 150 : 760;
  return (
    <g className="xa-shore">
      <path d={land} className="xa-land" />
      {[LANE.btc + 22, LANE.zec + 22].map((y) => (
        <rect key={y} x={dockX} y={y} width="50" height="7" rx="2" className="xa-dock" />
      ))}
      <g transform={`translate(${left ? 70 : 890} 300)`}>
        <path d="M-26 0 L0 -22 L26 0 V30 H-26 Z" className="xa-house" />
        <rect x="-7" y="12" width="14" height="18" className="xa-door" />
      </g>
      <text x={left ? 70 : 890} y="364" textAnchor="middle" className="xa-shore-label">
        {label}
      </text>
    </g>
  );
}

function Boat({ kind, label, landed }: { kind: "btc" | "zec"; label: string; landed: boolean }) {
  return (
    <g className={`xa-boat xa-boat-${kind}${landed ? " xa-landed" : ""}`} transform="scale(1.3)">
      <g className="xa-bob">
        <path d="M-58 -2 H58 L44 22 H-44 Z" className="xa-hull" />
        <rect x="-30" y="-34" width="60" height="32" rx="4" className="xa-crate" />
        {kind === "zec" ? <rect x="-30" y="-34" width="60" height="32" rx="4" fill="url(#xa-hatch)" /> : null}
        <text y="-13" textAnchor="middle" className="xa-crate-label">
          {kind.toUpperCase()}
        </text>
      </g>
      <g className="xa-tag" transform="translate(0 -52)">
        <rect x="-56" y="-15" width="112" height="24" rx="12" className="xa-tag-bg" />
        <text y="2" textAnchor="middle" className="xa-tag-text">
          {label}
        </text>
      </g>
    </g>
  );
}
