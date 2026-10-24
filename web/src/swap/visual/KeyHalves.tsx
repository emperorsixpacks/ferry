import { progress, type VisualProps } from "./Visual";

// Direction B: two vaults and a key in two halves. Each vault only opens with the whole key.
// You hold one half, they hold the other. Using your half to open the Bitcoin vault shows it to
// them, so their key is complete and the ZEC vault opens for them. That is the adaptor signature,
// told as an object.

const W = 960;
const H = 560;

export function KeyHalves({ scene, amounts }: VisualProps) {
  const p = progress(scene);
  const z = scene.role === "Z";
  // ZEC vault on the left for Z (it's theirs to give), on the right for B
  const zecLeft = z;
  const vaults = [
    { kind: "zec" as const, x: zecLeft ? 180 : 780, locked: (z ? p.mineLocked : p.theirsLocked) && !p.undone, open: p.done && !p.undone },
    { kind: "btc" as const, x: zecLeft ? 780 : 180, locked: (z ? p.theirsLocked : p.mineLocked) && !p.undone, open: p.claiming && !p.undone },
  ];
  // where the halves are: apart, joined in the middle, then into the vault that opens last
  const joined = p.claiming || p.done;
  const yourX = p.done ? (zecLeft ? -261 : 261) : joined ? (z ? 261 : -261) : -24;
  const theirX = p.done ? (zecLeft ? -261 : 261) : joined ? (z ? 261 : -261) : 24;

  return (
    <svg className="xb" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={scene.caption}>
      <defs>
        <radialGradient id="xb-glow" cx="50%" cy="46%" r="60%">
          <stop offset="0" className="xb-glow-in" />
          <stop offset="1" className="xb-glow-out" />
        </radialGradient>
        <linearGradient id="xb-steel" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" className="xb-steel-a" />
          <stop offset="1" className="xb-steel-b" />
        </linearGradient>
        <linearGradient id="xb-brass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="xb-brass-a" />
          <stop offset="1" className="xb-brass-b" />
        </linearGradient>
        <pattern id="xb-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="7" className="xb-hatch-line" />
        </pattern>
      </defs>

      <rect width={W} height={H} rx="28" className="xb-bg" />
      <rect width={W} height={H} rx="28" fill="url(#xb-glow)" />

      {vaults.map((v) => (
        <Vault key={v.kind} {...v} amount={v.kind === "zec" ? `${amounts.zec} ZEC` : `${amounts.btc} BTC`} owner={(v.kind === "zec") === z ? "yours" : "theirs"} />
      ))}

      {/* the key: two halves that only work together */}
      <g className={`xb-key${joined ? " xb-joined" : ""}${p.done ? " xb-used" : ""}`} transform="translate(480 228) scale(1.15)">
        <g className="xb-half xb-half-yours" style={{ transform: `translate(${yourX}px, 0px)` }}>
          <path d={HALF_YOURS} className="xb-key-shape" />
          <circle cx="-62" cy="0" r="13" className="xb-key-hole" />
        </g>
        <g className="xb-half xb-half-theirs" style={{ transform: `translate(${theirX}px, 0px)` }}>
          <path d={HALF_THEIRS} className="xb-key-shape xb-key-theirs" />
        </g>
        <g className="xb-key-labels" style={{ opacity: joined ? 0 : 1 }}>
          <text x="-74" y="70" textAnchor="middle" className="xb-key-label">
            your half
          </text>
          <text x="74" y="70" textAnchor="middle" className="xb-key-label">
            their half
          </text>
        </g>
      </g>

      {/* what you end up holding */}
      <g className={`xb-wallet${p.done ? " xb-on" : ""}`} transform={`translate(${W / 2} 500)`}>
        <rect x="-150" y="-26" width="300" height="52" rx="26" className="xb-wallet-bg" />
        <text y="7" textAnchor="middle" className="xb-wallet-text">
          + {z ? `${amounts.btc} BTC` : `${amounts.zec} ZEC`} in your wallet
        </text>
      </g>
    </svg>
  );
}

// A key lying flat, cut in two along a jagged seam at x = 0: the bow on the left, the bit on the right.
const HALF_YOURS =
  "M-6 -10 L-28 -10 C-34 -30 -52 -40 -70 -40 C-96 -40 -112 -22 -112 0 C-112 22 -96 40 -70 40 C-52 40 -34 30 -28 10 L-6 10 L2 4 L-8 0 L2 -5 Z";
const HALF_THEIRS =
  "M-6 -10 L2 -5 L-8 0 L2 4 L-6 10 L60 10 L60 30 L76 30 L76 10 L88 10 L88 24 L104 24 L104 10 L118 10 L118 -10 Z";

function Vault({ kind, x, locked, open, amount, owner }: { kind: "zec" | "btc"; x: number; locked: boolean; open: boolean; amount: string; owner: "yours" | "theirs" }) {
  return (
    <g className={`xb-vault xb-vault-${kind}${locked ? " xb-locked" : ""}${open ? " xb-open" : ""}`} transform={`translate(${x} 228)`}>
      <ellipse cx="0" cy="150" rx="150" ry="16" className="xb-floor" />
      <rect x="-130" y="-130" width="260" height="260" rx="32" className="xb-vault-body" />
      {kind === "zec" ? <rect x="-130" y="-130" width="260" height="260" rx="32" fill="url(#xb-hatch)" className="xb-veil" /> : null}
      <rect x="-106" y="-106" width="212" height="212" rx="20" className="xb-door" />
      {/* coins inside, seen when the door swings open */}
      <g className="xb-coins">
        {[34, 14, -6].map((y) => (
          <ellipse key={y} cx="0" cy={y} rx="46" ry="14" className="xb-coin" />
        ))}
      </g>
      <g className="xb-dial">
        <circle r="48" className="xb-dial-ring" />
        <circle r="8" className="xb-dial-hub" />
        {[0, 60, 120, 180, 240, 300].map((a) => (
          <line key={a} x1="0" y1="-36" x2="0" y2="-44" transform={`rotate(${a})`} className="xb-dial-tick" />
        ))}
      </g>
      <g className="xb-padlock" transform="translate(-15 -152)">
        <path d="M6 14V9a9 9 0 0118 0v5" className="xb-shackle" />
        <rect x="0" y="14" width="30" height="24" rx="5" className="xb-padlock-body" />
      </g>
      <text y="186" textAnchor="middle" className="xb-vault-kind">
        {amount}
      </text>
      <text y="212" textAnchor="middle" className="xb-vault-owner">
        {kind === "zec" ? "Zcash, shielded" : "Bitcoin"}, {owner}
      </text>
    </g>
  );
}
