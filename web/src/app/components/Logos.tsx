import type { ReactElement } from "react";
import type { ChainId, PairId } from "@/api";
import { pairChain, pairCoin } from "@/api";
import { cn } from "../lib/utils";

// Coin and chain marks, drawn inline (no fetches): each in its own colours, after the official
// marks. A token on an EVM chain wears that chain's mark as a small badge on its corner.

export type TokenId = "zec" | "btc" | "ltc" | "usdc" | "weth" | "eth";
export type ChainMarkId = "bitcoin" | "litecoin" | ChainId;

type Mark = { viewBox: string; body: ReactElement };

const ETH_GLYPH = (
  <g fill="#fff">
    <path fillOpacity=".602" d="M16.498 4v8.87l7.497 3.35z" />
    <path d="M16.498 4L9 16.22l7.498-3.35z" />
    <path fillOpacity=".602" d="M16.498 21.968v6.027L24 17.616z" />
    <path d="M16.498 27.995v-6.028L9 17.616z" />
    <path fillOpacity=".2" d="M16.498 20.573l7.497-4.353-7.497-3.348z" />
    <path fillOpacity=".602" d="M9 16.22l7.498 4.353v-7.701z" />
  </g>
);

const TOKENS: Record<TokenId, Mark> = {
  zec: {
    viewBox: "0 0 32 32",
    body: (
      <>
        <circle cx="16" cy="16" r="16" fill="#F4B728" />
        <path fill="#231F20" d="M14.6 6h2.8v3h4.1v2.6l-7.1 8.8h7.1V23h-4.1v3h-2.8v-3h-4.1v-2.6l7.1-8.8h-7.1V9h4.1z" />
      </>
    ),
  },
  btc: {
    viewBox: "0 0 64 64",
    body: (
      <>
        <path
          fill="#F7931A"
          d="m63.04 39.741c-4.274 17.143-21.638 27.575-38.783 23.301-17.138-4.274-27.571-21.638-23.295-38.78 4.272-17.145 21.635-27.579 38.775-23.305 17.144 4.274 27.576 21.64 23.302 38.784z"
        />
        <path
          fill="#fff"
          d="m46.11 27.441c0.636-4.258-2.606-6.547-7.039-8.074l1.438-5.768-3.512-0.875-1.4 5.616c-0.922-0.23-1.87-0.447-2.812-0.662l1.41-5.653-3.509-0.875-1.439 5.766c-0.764-0.174-1.514-0.346-2.242-0.527l0.004-0.018-4.842-1.209-0.934 3.75s2.605 0.597 2.55 0.634c1.422 0.355 1.679 1.296 1.636 2.042l-1.638 6.571c0.098 0.025 0.225 0.061 0.365 0.117-0.117-0.029-0.242-0.061-0.371-0.092l-2.296 9.205c-0.174 0.432-0.615 1.08-1.609 0.834 0.035 0.051-2.552-0.637-2.552-0.637l-1.743 4.019 4.569 1.139c0.85 0.213 1.683 0.436 2.503 0.646l-1.453 5.834 3.507 0.875 1.439-5.772c0.958 0.26 1.888 0.5 2.798 0.726l-1.434 5.745 3.511 0.875 1.453-5.823c5.987 1.133 10.489 0.676 12.384-4.739 1.527-4.36-0.076-6.875-3.226-8.515 2.294-0.529 4.022-2.038 4.483-5.155zm-8.022 11.249c-1.085 4.36-8.426 2.003-10.806 1.412l1.928-7.729c2.38 0.594 10.012 1.77 8.878 6.317zm1.086-11.312c-0.99 3.966-7.1 1.951-9.082 1.457l1.748-7.01c1.982 0.494 8.365 1.416 7.334 5.553z"
        />
      </>
    ),
  },
  ltc: {
    viewBox: "0 0 32 32",
    body: (
      <>
        <circle cx="16" cy="16" r="16" fill="#345D9D" />
        <path fill="#fff" d="M10.427 19.214L9 19.768l.688-2.759 1.444-.58L13.213 8h5.129l-1.519 6.196 1.41-.571-.68 2.75-1.427.571-.848 3.483H23L22.127 24H9.252z" />
      </>
    ),
  },
  usdc: {
    viewBox: "0 0 2000 2000",
    body: (
      <>
        <path d="M1000 2000c554.17 0 1000-445.83 1000-1000S1554.17 0 1000 0 0 445.83 0 1000s445.83 1000 1000 1000z" fill="#2775CA" />
        <path
          fill="#fff"
          d="M1275 1158.33c0-145.83-87.5-195.83-262.5-216.66-125-16.67-150-50-150-108.34s41.67-95.83 125-95.83c75 0 116.67 25 137.5 87.5 4.17 12.5 16.67 20.83 29.17 20.83h66.66c16.67 0 29.17-12.5 29.17-29.16v-4.17c-16.67-91.67-91.67-162.5-187.5-170.83v-100c0-16.67-12.5-29.17-33.33-33.34h-62.5c-16.67 0-29.17 12.5-33.34 33.34v95.83c-125 16.67-204.16 100-204.16 204.17 0 137.5 83.33 191.66 258.33 212.5 116.67 20.83 154.17 45.83 154.17 112.5s-58.34 112.5-137.5 112.5c-108.34 0-145.84-45.84-158.34-108.34-4.16-16.66-16.66-25-29.16-25h-70.84c-16.66 0-29.16 12.5-29.16 29.17v4.17c16.66 104.16 83.33 179.16 220.83 200v100c0 16.66 12.5 29.16 33.33 33.33h62.5c16.67 0 29.17-12.5 33.34-33.33v-100c125-20.84 208.33-108.34 208.33-220.84z"
        />
        <path
          fill="#fff"
          d="M787.5 1595.83c-325-116.66-491.67-479.16-370.83-800 62.5-175 200-308.33 370.83-370.83 16.67-8.33 25-20.83 25-41.67V325c0-16.67-8.33-29.17-25-33.33-4.17 0-12.5 0-16.67 4.16-395.83 125-612.5 545.84-487.5 941.67 75 233.33 254.17 412.5 487.5 487.5 16.67 8.33 33.34 0 37.5-16.67 4.17-4.16 4.17-8.33 4.17-16.66v-58.34c0-12.5-12.5-29.16-25-37.5zM1229.17 295.83c-16.67-8.33-33.34 0-37.5 16.67-4.17 4.17-4.17 8.33-4.17 16.67v58.33c0 16.67 12.5 33.33 25 41.67 325 116.66 491.67 479.16 370.83 800-62.5 175-200 308.33-370.83 370.83-16.67 8.33-25 20.83-25 41.67V1700c0 16.67 8.33 29.17 25 33.33 4.17 0 12.5 0 16.67-4.16 395.83-125 612.5-545.84 487.5-941.67-75-237.5-258.34-416.67-487.5-491.67z"
        />
      </>
    ),
  },
  eth: {
    viewBox: "0 0 32 32",
    body: (
      <>
        <circle cx="16" cy="16" r="16" fill="#627EEA" />
        {ETH_GLYPH}
      </>
    ),
  },
  // wrapped ether: ether's mark inside a ring, the usual sign of a wrapped coin
  weth: {
    viewBox: "0 0 32 32",
    body: (
      <>
        <circle cx="16" cy="16" r="16" fill="#4F63C9" />
        <circle cx="16" cy="16" r="13.2" fill="#627EEA" stroke="#fff" strokeOpacity=".85" strokeWidth="1.3" />
        <g transform="translate(3.6 3.4) scale(.78)">{ETH_GLYPH}</g>
      </>
    ),
  },
};

const CHAINS: Record<ChainMarkId, Mark> = {
  bitcoin: TOKENS.btc,
  litecoin: TOKENS.ltc,
  ethereum: TOKENS.eth,
  // Base: a blue disc with a bar cut in from the left
  base: {
    viewBox: "0 0 111 111",
    body: (
      <path
        fill="#0052FF"
        d="M54.921 110.034C85.359 110.034 110.034 85.402 110.034 55.017C110.034 24.6319 85.359 0 54.921 0C26.0432 0 2.35281 22.1714 0 50.3923H72.8467V59.6416H3.9565e-07C2.35281 87.8625 26.0432 110.034 54.921 110.034Z"
      />
    ),
  },
  // Arbitrum: navy, with the white strokes and the light-blue one of its mark
  arbitrum: {
    viewBox: "0 0 32 32",
    body: (
      <>
        <circle cx="16" cy="16" r="16" fill="#213147" />
        <path d="M16 5.6l8.9 5.15v10.5L16 26.4l-8.9-5.15v-10.5z" fill="none" stroke="#9DCCED" strokeOpacity=".55" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M17.3 11.2l5 9.2-1.9 1.1-5-9.2z" fill="#12AAFF" />
        <path d="M14.3 9.4h2.5l-5.6 12.6-2-1.2zM18.4 9.4h2.5l-5 11.1-1.3-2.5z" fill="#fff" />
      </>
    ),
  },
  // Optimism: red disc, white "OP"
  optimism: {
    viewBox: "0 0 32 32",
    body: (
      <>
        <circle cx="16" cy="16" r="16" fill="#FF0420" />
        <ellipse cx="11.3" cy="16" rx="3.3" ry="4.3" fill="none" stroke="#fff" strokeWidth="2.1" />
        <path d="M17.2 20.6V11.4h3.6c2 0 3.3 1.15 3.3 2.95s-1.3 2.95-3.3 2.95h-1.5v3.3z" fill="#fff" />
        <path d="M19.3 13.2v2.3h1.3c.8 0 1.3-.45 1.3-1.15s-.5-1.15-1.3-1.15z" fill="#FF0420" />
      </>
    ),
  },
};

function Svg({ mark, size, className, label }: { mark: Mark; size: number; className?: string; label?: string }) {
  return (
    <svg
      viewBox={mark.viewBox}
      width={size}
      height={size}
      className={cn("shrink-0", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {mark.body}
    </svg>
  );
}

export const TokenLogo = ({ id, size = 32, className, label }: { id: TokenId; size?: number; className?: string; label?: string }) => (
  <Svg mark={TOKENS[id]} size={size} className={className} label={label} />
);

export const ChainLogo = ({ id, size = 16, className, label }: { id: ChainMarkId; size?: number; className?: string; label?: string }) => (
  <Svg mark={CHAINS[id]} size={size} className={className} label={label} />
);

// ------------------------------------------------------------------------------------------------
// NEAR Intents' assets: Ferry's own marks where there is one (BTC, LTC, USDC, ETH, WETH, ZEC), else
// a monogram in the coin's own colour; the chain's mark as a badge when the token lives on a chain
// other than its home one (USDC on Solana, ETH on Base).

const OWN: Record<string, TokenId> = { BTC: "btc", LTC: "ltc", USDC: "usdc", ETH: "eth", WETH: "weth", ZEC: "zec" };
const BRAND: Record<string, string> = {
  SOL: "#9945FF",
  USDT: "#26A17B",
  wNEAR: "#111111",
  NEAR: "#111111",
  XRP: "#23292F",
  DOGE: "#C2A633",
  TRX: "#EB0029",
  BNB: "#F0B90B",
  TON: "#0098EA",
  SUI: "#4DA2FF",
  ADA: "#0033AD",
  AVAX: "#E84142",
  POL: "#8247E5",
  XLM: "#14182B",
  APT: "#111111",
  DAI: "#F5AC37",
  ARB: "#213147",
  OP: "#FF0420",
  BCH: "#0AC18E",
  DASH: "#008CE7",
  cbBTC: "#0052FF",
  WBTC: "#F09242",
};
// a token's home chain: no badge there
const HOME: Record<string, string> = { BTC: "btc", LTC: "ltc", ETH: "eth", SOL: "sol", wNEAR: "near", NEAR: "near", XRP: "xrp", DOGE: "doge", TRX: "tron", TON: "ton", SUI: "sui", ADA: "cardano", APT: "aptos", XLM: "stellar", AVAX: "avax", POL: "pol", BNB: "bsc", BCH: "bch", DASH: "dash", ZEC: "zec" };
const CHAIN_MARK: Record<string, ChainMarkId> = { btc: "bitcoin", ltc: "litecoin", eth: "ethereum", base: "base", arb: "arbitrum", op: "optimism" };
const CHAIN_SYMBOL: Record<string, string> = { sol: "SOL", near: "NEAR", bsc: "BNB", tron: "TRX", xrp: "XRP", doge: "DOGE", ton: "TON", sui: "SUI", aptos: "APT", cardano: "ADA", stellar: "XLM", avax: "AVAX", pol: "POL", bch: "BCH", dash: "DASH" };

function hue(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

// a disc with up to three letters of the symbol
export function Monogram({ symbol, size = 32, className }: { symbol: string; size?: number; className?: string }) {
  const text = symbol.replace(/^w(?=[A-Z])/, "").slice(0, symbol.length > 4 ? 3 : 4);
  const fill = BRAND[symbol] ?? `hsl(${hue(symbol)} 45% 42%)`;
  const font = text.length >= 4 ? 8.5 : text.length === 3 ? 10.5 : 13;
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} className={cn("shrink-0", className)} aria-hidden>
      <circle cx="16" cy="16" r="16" fill={fill} />
      <text x="16" y="16.5" textAnchor="middle" dominantBaseline="middle" fill="#fff" fontSize={font} fontWeight={700} fontFamily="Inter, system-ui, sans-serif" letterSpacing="-0.02em">
        {text}
      </text>
    </svg>
  );
}

function ChainBadge({ chain, size }: { chain: string; size: number }) {
  const mark = CHAIN_MARK[chain];
  if (mark) return <ChainLogo id={mark} size={size} />;
  return <Monogram symbol={CHAIN_SYMBOL[chain] ?? chain.toUpperCase()} size={size} />;
}

export function NearTokenLogo({ symbol, chain, size = 32, className }: { symbol: string; chain: string; size?: number; className?: string }) {
  const own = OWN[symbol];
  const badge = Math.round(size * 0.46);
  const showBadge = HOME[symbol] !== chain;
  return (
    <span className={cn("relative inline-flex shrink-0", className)} style={{ width: size, height: size }}>
      {own ? <TokenLogo id={own} size={size} /> : <Monogram symbol={symbol} size={size} />}
      {showBadge ? (
        <span className="absolute -right-1 -bottom-1 inline-flex rounded-full bg-white p-[1.5px]" aria-hidden>
          <ChainBadge chain={chain} size={badge} />
        </span>
      ) : null}
    </span>
  );
}

// NEAR Intents, as a small mark: an N on an ink tile (not its logo), so it follows the theme
export function NearMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} className={cn("shrink-0", className)} aria-hidden>
      <rect width="32" height="32" rx="9" className="fill-slate-900" />
      <path d="M10 23V9h2.6l6.8 9.6V9H22v14h-2.6l-6.8-9.6V23z" className="fill-white" />
    </svg>
  );
}

// What a pair pays out, with its chain's badge for a token: USDC on Base, ETH on Arbitrum.
export function PairLogo({ pair, size = 32, className }: { pair: PairId | "zec"; size?: number; className?: string }) {
  if (pair === "zec") return <TokenLogo id="zec" size={size} className={className} />;
  const coin = pairCoin(pair);
  const chain = pairChain(pair);
  const badge = Math.round(size * 0.46);
  return (
    <span className={cn("relative inline-flex shrink-0", className)} style={{ width: size, height: size }}>
      <TokenLogo id={coin} size={size} />
      {chain ? (
        <span className="absolute -right-1 -bottom-1 inline-flex rounded-full bg-white p-[1.5px]" aria-hidden>
          <ChainLogo id={chain} size={badge} />
        </span>
      ) : null}
    </span>
  );
}
