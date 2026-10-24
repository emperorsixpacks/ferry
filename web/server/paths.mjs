// Which way a swap goes, for any coin on either side of the swap card: what runs and through whom,
// whether this server can run it (and if not, why, in one plain sentence), about how long it takes,
// what stays private and what the button says. Plain JavaScript, shared: the browser imports it
// (types in paths.d.mts) and server/paths.test.mjs tests it.
//
// A coin is "zec" (shielded ZEC), one of Ferry's pairs ("btc", "ltc", "usdc-base", ...) or a NEAR
// Intents asset ("near:<assetId>"). Every pair of coins resolves to one path:
//   zec  → pair   sell     one Ferry swap: shielded ZEC for the coin
//   pair → zec    buy      one Ferry swap: the coin for shielded ZEC
//   zec  → near   near-sell  Ferry sells the ZEC for a coin NEAR Intents takes, which carries it on
//   near → zec    near-buy   NEAR Intents delivers a coin to your own node, Ferry buys ZEC with it
//   pair → pair   route      a private swap: coin A → shielded ZEC → coin C, two Ferry swaps
//   pair → near   route-near a private swap whose second swap pays into a NEAR Intents deposit
//   near → pair   near-route NEAR Intents delivers coin A to your node, then a private swap A → C
//   near → near   near-near  both
// and the same coin on both sides is refused. Coin to coin goes through shielded ZEC: Ferry's promise
// is a cross-chain swap that leaves no trail, so the private route is the default. A person may opt
// out of it for two coins (near-only: NEAR Intents alone, faster, public), never by default.
//
// What this server runs (`ctx`):
//   ready     the server said which daemons it has and the page probed them; until then nothing
//             is ruled out (available: null)
//   sell/buy  the pairs it sells ZEC for (a Z daemon of yours) and buys ZEC with (a B daemon)
//   offline   {sell, buy}: of those, the pairs whose daemon that way isn't answering (it failed, or is
//             still silent after the page's first wait); a pair that comes back drops out of it
//   waiting   {sell, buy}: the pairs whose daemon hasn't answered yet, within that first wait
//   nets      {pair: "main" | "test" | "local"}: the kind of network each pair's daemons run on
//             (swapNet of their status), for the time a swap takes; a pair missing has no time
//   routes    the router's legs {from, to} (pairs a private swap starts from / ends in), or null
//   near      undefined while loading, null without NEAR Intents, else {
//               tokens: {assetId: {symbol, blockchain, ferry}},
//               runs: {sell, buy}       NEAR swaps start here (the operator's own mainnet node)
//               reason                  "demo" | "mainnet" | null: why they don't
//               vias: {sell, buy}       the coins a NEAR sell / buy can go through here
//               compose: {to, from, runs}  the coins a private swap can hand to NEAR Intents (to)
//                                       or take from it (from), and whether those run here
//             }

export const ZEC = "zec";
export const PAIRS = ["btc", "ltc", "usdc-base", "usdc-ethereum", "usdc-arbitrum", "usdc-optimism", "weth-base", "weth-ethereum", "weth-arbitrum", "weth-optimism"];

export const nearToken = (assetId) => `near:${assetId}`;
export const isNear = (t) => typeof t === "string" && t.startsWith("near:");
export const assetIdOf = (t) => (isNear(t) ? t.slice(5) : null);
export const isPair = (t) => PAIRS.includes(t);
export const isToken = (t) => t === ZEC || isPair(t) || (isNear(t) && t.length > 5);
const assetOf = (pair) => String(pair).split("-")[0];

const TICKERS = { btc: "BTC", ltc: "LTC", usdc: "USDC", weth: "WETH" };
export function tickerOf(t, ctx = null) {
  if (t === ZEC) return "ZEC";
  if (isNear(t)) return ctx?.near?.tokens?.[assetIdOf(t)]?.symbol ?? "this token";
  return TICKERS[assetOf(t)] ?? String(t).toUpperCase();
}

// What a coin is worth in, roughly: two ends in the same family carry about the same amount, which
// would link them (USDC to USDC, BTC to cbBTC, WETH to ETH)
const FAMILY = { wbtc: "btc", cbbtc: "btc", tbtc: "btc", weth: "eth", steth: "eth", wsteth: "eth", wnear: "near" };
export const symbolFamily = (symbol) => FAMILY[String(symbol).toLowerCase()] ?? String(symbol).toLowerCase();
export const familyOf = (t, ctx = null) => symbolFamily(t === ZEC ? "zec" : isNear(t) ? (ctx?.near?.tokens?.[assetIdOf(t)]?.symbol ?? assetIdOf(t)) : assetOf(t));

// ------------------------------------------------------------------------------------------------
// time

// The kind of network a daemon reports (chains.btc.network or chains.zec.network, as ferryd names
// them): "main" carries real value, "local" runs on this machine (regtest, anvil), anything else
// is a public test network (signet, testnet, base-sepolia...). null: not known.
const MAINNETS = new Set(["bitcoin", "main", "mainnet", "litecoin", "ethereum", "base", "arbitrum", "optimism"]);
export const netKind = (network) => (!network ? null : MAINNETS.has(network) ? "main" : network === "regtest" || network === "anvil" ? "local" : "test");
// A swap's network: the slower of its two chains' (a local chain against the real Zcash testnet
// waits for real Zcash blocks)
const SLOWER = ["local", "test", "main"];
export function swapNet(counterNetwork, zecNetwork) {
  const i = Math.max(SLOWER.indexOf(netKind(counterNetwork)), SLOWER.indexOf(netKind(zecNetwork)));
  return i < 0 ? null : SLOWER[i];
}

// One Ferry swap, start to done on both sides, in minutes [usually from, usually to], by coin and
// network. Confirmations are most of it: the counter-chain lock's, then 10 Zcash blocks on a main
// network (75 s each, so about 12.5 min, often 8-20) or 3 on a test one, then on Bitcoin and
// Litecoin the redeem's own. Measured and projected (docs/EVM.md):
//   Base mainnet   about 1 min of lock confirmations + the 10 Zcash blocks: 15-20 min (projected;
//                  a fork rehearsal with 3 s mock Zcash blocks took under 2 min)
//   Ethereum       64 blocks (about 13 min) for the lock, then the same: 25-35 min (projected)
//   Bitcoin        2 confirmations (about 20 min), the 10 Zcash blocks, the redeem's block: 45-60
//   Litecoin       8 confirmations (about 20 min) and the rest: 30-45 (no mainnet yet)
//   Base Sepolia   measured 2026-10-20: the seller done in 1 min 53 s, the buyer in 6 min 44 s, with
//                  3 Zcash blocks in 71 s (3.75 min on average): 2-10 min
//   signet         1 confirmation (about 10 min), 3 Zcash blocks, the redeem's block: 20-40 min
//   Litecoin test  2 confirmations (about 5 min) and the rest: 10-20 min
//   local          regtest or anvil, blocks every few seconds: 1-5 min
// Zcash's NU7 upgrade (25 s blocks; mainnet planned for 2026-11-05) would cut the Zcash part about
// threefold. Not counted here until it is live.
const FERRY_MIN = {
  btc: { main: [45, 60], test: [20, 40], local: [1, 5] },
  ltc: { main: [30, 45], test: [10, 20], local: [1, 5] },
  evm: { main: [15, 20], test: [2, 10], local: [1, 5] },
  "evm-ethereum": { main: [25, 35], test: [2, 10], local: [1, 5] },
};
const ferryKind = (pair) => (assetOf(pair) === "btc" ? "btc" : assetOf(pair) === "ltc" ? "ltc" : String(pair).endsWith("-ethereum") ? "evm-ethereum" : "evm");
// [from, to] minutes for one Ferry swap of `pair` on a `net` network ("main" when not given)
export const ferryMinutes = (pair, net = "main") => FERRY_MIN[ferryKind(pair)][FERRY_MIN.btc[net] ? net : "main"];
// the time of one Ferry swap of `pair` here, if this server knows its network
const ferryHere = (pair, ctx) => (ctx?.nets?.[pair] ? ferryMinutes(pair, ctx.nets[pair]) : null);
// NEAR Intents' part, roughly
export const NEAR_MIN = 5;
// a private swap, by its privacy pause: two swaps, the ZEC settling between them, and the pause
export const ROUTE_MIN = { off: [30, 45], standard: [35, 75], long: [90, 420] };

const hours = (m) => {
  const h = Math.round((m / 60) * 2) / 2;
  return `${Math.floor(h) || ""}${h % 1 ? "½" : ""}` || "½";
};
// "about 30 min", "about 35–75 min", "about 1½–7 hours"
export function aboutText([lo, hi]) {
  if (hi < 90) return lo === hi ? `about ${lo} min` : `about ${lo}–${hi} min`;
  if (lo < 90) return `about ${lo} min–${hours(hi)} hours`;
  return lo === hi ? `about ${hours(lo)} hours` : `about ${hours(lo)}–${hours(hi)} hours`;
}

// ------------------------------------------------------------------------------------------------
// words

const NO_ROUTER = "This server has no router, so coin-to-coin swaps aren't available here.";
const QUOTE_ONLY = {
  mainnet: "Quote only: NEAR Intents runs on mainnet, and this Ferry node is on a test network.",
  demo: "Quote only. NEAR Intents runs on mainnet and pays out to an address you choose, so it runs on your own Ferry node, not on this demo.",
};
const NEAR_TRUST = "The NEAR Intents part is public, and you trust NEAR Intents for it.";
const sameFamily = (a, c) => `${a} for ${c} would put about the same amount on both sides, which links them. Pick two different coins.`;

function privacyOf(kind, a, c) {
  switch (kind) {
    case "sell":
      return "Your ZEC stays shielded, and nothing on either chain links the two sides.";
    case "buy":
      return "Your ZEC arrives shielded, and nothing on either chain links the two sides.";
    case "near-sell":
      return `Your ZEC stays shielded and never goes to NEAR Intents. ${NEAR_TRUST}`;
    case "near-buy":
      return `Your ZEC arrives shielded, and no ZEC goes through NEAR Intents. ${NEAR_TRUST}`;
    case "route":
      return `No transaction links your ${a} to your ${c}: the ZEC between is shielded. Only the amounts and the timing could hint at a link.`;
    case "route-near":
    case "near-route":
    case "near-near":
      return `No transaction links your two Ferry swaps: the ZEC between is shielded, though amounts and timing could hint at a link. ${NEAR_TRUST}`;
    case "near-only":
      return "Faster, but public: anyone can link what you sold to what you got, and you trust NEAR Intents for all of it.";
    default:
      return "";
  }
}

// The opt-out from a private swap, for two coins: NEAR Intents alone, from your own wallet to your
// own address. Faster, and public end to end; never the default.
function nearAlone(sell, buy, ctx) {
  const near = ctx?.near;
  const path = { kind: "near-only", steps: [NEAR], minutes: [NEAR_MIN, NEAR_MIN * 3], private: false };
  if (near === undefined) return { ...path, available: null };
  if (!near) return { ...path, reason: "NEAR Intents isn't available on this server." };
  const idOf = (t) => (isNear(t) ? (near.tokens[assetIdOf(t)] ? assetIdOf(t) : null) : (Object.entries(near.tokens).find(([, v]) => v.ferry === t)?.[0] ?? null));
  const asset_in = idOf(sell);
  const asset_out = idOf(buy);
  if (!asset_in || !asset_out) return { ...path, reason: `NEAR Intents doesn't take ${tickerOf(asset_in ? buy : sell, ctx)} here.` };
  const runs = !!near.runs?.direct;
  return { ...path, asset_in, asset_out, available: true, runs, reason: runs ? null : (QUOTE_ONLY[near.reason] ?? QUOTE_ONLY.demo) };
}

// ------------------------------------------------------------------------------------------------
// resolve

// the steps, for the path line: Ferry, NEAR Intents, and the coin handed over between them
const FERRY = { by: "ferry" };
const NEAR = { by: "near" };
const HOP = { coin: ZEC };
const coinStep = (pair) => ({ coin: pair ?? null });

// One path for selling `sell` and getting `buy`. `opts.pause` ("off" | "standard" | "long") times a
// private swap; `opts.public` is the person's opt-out from it, for two coins: NEAR Intents alone.
export function resolvePath(sell, buy, ctx, opts = {}) {
  const pause = opts.pause && ROUTE_MIN[opts.pause] ? opts.pause : "standard";
  const a = tickerOf(sell, ctx);
  const c = tickerOf(buy, ctx);
  const base = { sell, buy, available: false, runs: false, reason: null, steps: [], minutes: [0, 0], private: false, via: [] };
  const done = (p) => {
    const out = { ...base, ...p };
    out.time = out.minutes[1] > 0 ? aboutText(out.minutes) : "";
    out.privacy = privacyOf(out.kind, a, c);
    out.button = buttonOf(out.kind, ctx, sell, buy);
    // nothing is ruled out until the server said what it runs
    if (out.available === false && !ctx?.ready && out.kind !== "same" && out.kind !== "none") out.available = null;
    return out;
  };

  if (!isToken(sell) || !isToken(buy)) return done({ kind: "none", reason: "Pick a coin on each side." });
  if (sell === buy) return done({ kind: "same", reason: "That's the same coin on both sides. Pick a different one." });
  const near = ctx?.near;
  const tokens = near?.tokens ?? {};
  const listed = (t) => !isNear(t) || !!tokens[assetIdOf(t)];
  const nearProblem = (t) => {
    if (!isNear(t)) return null;
    if (near === undefined) return "loading";
    if (!near) return "NEAR Intents isn't available on this server.";
    if (!listed(t)) return "NEAR Intents doesn't list this token right now.";
    if (tokens[assetIdOf(t)].blockchain === "zec") return "Ferry never sends ZEC through NEAR Intents: it swaps your ZEC itself, shielded.";
    return null;
  };
  const nearWait = (p) => (p === "loading" ? { available: null } : { reason: p });
  const quoteOnly = (runs) => (runs ? null : (QUOTE_ONLY[near?.reason] ?? QUOTE_ONLY.demo));

  // ---------------------------------------------------------------- one Ferry swap
  if (sell === ZEC && isPair(buy)) {
    const ok = !!ctx?.sell?.includes(buy);
    return done({ kind: "sell", dir: "sell", pair: buy, available: ok, runs: ok, reason: ok ? null : `Selling ZEC for ${c} isn't available on this server.`, steps: [FERRY], minutes: ferryHere(buy, ctx) ?? [0, 0] });
  }
  if (isPair(sell) && buy === ZEC) {
    const ok = !!ctx?.buy?.includes(sell);
    return done({ kind: "buy", dir: "buy", pair: sell, available: ok, runs: ok, reason: ok ? null : `Buying ZEC with ${a} isn't available on this server.`, steps: [FERRY], minutes: ferryHere(sell, ctx) ?? [0, 0] });
  }

  // ---------------------------------------------------------------- ZEC and NEAR Intents
  if (sell === ZEC || buy === ZEC) {
    const selling = sell === ZEC;
    const t = selling ? buy : sell;
    const kind = selling ? "near-sell" : "near-buy";
    const steps = selling ? [FERRY, coinStep(null), NEAR] : [NEAR, coinStep(null), FERRY];
    const p = nearProblem(t);
    if (familyOf(t, ctx) === "zec" && !p) return done({ kind, steps, reason: "Ferry never sends ZEC through NEAR Intents: it swaps your ZEC itself, shielded." });
    if (p) return done({ kind, steps, asset: assetIdOf(t), dir: selling ? "sell" : "buy", ...nearWait(p) });
    const via = (near.vias?.[selling ? "sell" : "buy"] ?? (selling ? ctx.sell : ctx.buy) ?? []).filter(isPair);
    steps[1] = coinStep(via[0]);
    // NEAR Intents runs on main networks: a Ferry part whose network isn't known yet counts as one
    const [flo, fhi] = via[0] ? (ferryHere(via[0], ctx) ?? ferryMinutes(via[0])) : ferryMinutes("btc");
    const m = [flo + NEAR_MIN, fhi + NEAR_MIN];
    if (!via.length) return done({ kind, steps, asset: assetIdOf(t), dir: selling ? "sell" : "buy", minutes: m, reason: `${selling ? "Selling" : "Buying"} ZEC through NEAR Intents isn't available on this server.` });
    const runs = !!near.runs?.[selling ? "sell" : "buy"];
    return done({ kind, dir: selling ? "sell" : "buy", asset: assetIdOf(t), via, steps, minutes: m, available: true, runs, reason: quoteOnly(runs) });
  }

  // ---------------------------------------------------------------- coin to coin: through shielded ZEC
  const routes = ctx?.routes ?? null;
  const [lo, hi] = ROUTE_MIN[pause];
  const front = isNear(sell);
  const back = isNear(buy);
  const kind = front && back ? "near-near" : front ? "near-route" : back ? "route-near" : "route";
  const steps = [...(front ? [NEAR, coinStep(null)] : []), FERRY, HOP, FERRY, ...(back ? [coinStep(null), NEAR] : [])];
  const nearParts = (front ? 1 : 0) + (back ? 1 : 0);
  const minutes = [lo + nearParts * NEAR_MIN, hi + nearParts * NEAR_MIN];
  const path = { kind, steps, minutes, private: true };
  if (front || back) Object.assign(path, { from: front ? null : sell, to: back ? null : buy, asset_in: assetIdOf(sell), asset_out: assetIdOf(buy) });
  else Object.assign(path, { from: sell, to: buy });

  const p = nearProblem(sell) ?? nearProblem(buy);
  if (p === "loading") return done({ ...path, available: null });
  if (p) return done({ ...path, reason: p });
  if (familyOf(sell, ctx) === familyOf(buy, ctx)) return done({ ...path, reason: sameFamily(a, c) });
  // the person opted out of the private swap, for these two coins
  if (opts.public) return done(nearAlone(sell, buy, ctx));
  if (!routes) return done({ ...path, reason: NO_ROUTER });
  if (!front && !routes.from.includes(sell)) return done({ ...path, reason: `Private swaps can't start from ${a} on this server.` });
  if (!back && !routes.to.includes(buy)) return done({ ...path, reason: `Private swaps can't end in ${c} on this server.` });
  if (kind === "route") return done({ ...path, available: true, runs: true });

  // NEAR Intents at one end or both: the coins it hands over, and the private swaps between them
  const compose = near.compose ?? null;
  const starts = front ? (compose?.from ?? []).filter((x) => isPair(x) && routes.from.includes(x)) : [sell];
  const ends = back ? (compose?.to ?? []).filter((x) => isPair(x) && routes.to.includes(x)) : [buy];
  const pairs = starts.flatMap((x) => ends.filter((y) => assetOf(x) !== assetOf(y)).map((y) => [x, y]));
  if (!pairs.length) {
    const reason = front && back ? `No private swap here can take ${a} from NEAR Intents and hand ${c} back to it.` : front ? `No private swap here can take ${a} from NEAR Intents to ${c}.` : `No private swap here goes from ${a} to a coin NEAR Intents takes.`;
    return done({ ...path, reason });
  }
  const [x, y] = pairs[0];
  if (front) path.steps[1] = coinStep(x);
  if (back) path.steps[path.steps.length - 2] = coinStep(y);
  const runs = !!compose?.runs;
  return done({ ...path, via: pairs, available: true, runs, reason: quoteOnly(runs) });
}

function buttonOf(kind, ctx, sell, buy) {
  switch (kind) {
    case "sell":
      return "Sell ZEC";
    case "buy":
      return "Buy ZEC";
    case "near-sell":
      return `Sell ZEC for ${tickerOf(buy, ctx)}`;
    case "near-buy":
      return `Buy ZEC with ${tickerOf(sell, ctx)}`;
    case "route":
    case "route-near":
    case "near-route":
    case "near-near":
      return "Swap privately";
    case "near-only":
      return "Swap through NEAR Intents";
    default:
      return "Swap";
  }
}

// The words of a path line: "Ferry → shielded ZEC → Ferry", "Ferry → BTC → NEAR Intents"
export function stepWords(steps, ctx = null) {
  return steps
    .map((s) => (s.by === "ferry" ? "Ferry" : s.by === "near" ? "NEAR Intents" : s.coin === ZEC ? "shielded ZEC" : s.coin ? tickerOf(s.coin, ctx) : null))
    .filter(Boolean)
    .join(" → ");
}

// ------------------------------------------------------------------------------------------------
// the card's first coins

// whether this server does anything with a pair: swaps it either way, or routes through it
export const present = (ctx, pair) => !!(ctx?.sell?.includes(pair) || ctx?.buy?.includes(pair) || ctx?.routes?.from?.includes(pair) || ctx?.routes?.to?.includes(pair));

// Sell ZEC for the first coin this server sells it for; if it sells none, buy ZEC with the first
// coin it buys ZEC with; else ZEC for the first coin it knows at all. A coin whose daemon is offline
// (ctx.offline) gives way to the next one that answers, so one stuck daemon doesn't make the card
// open on it; one that hasn't answered yet (ctx.waiting) is waited for, since it may answer in a
// moment: null until it does, or until the page stops waiting for it. With every daemon offline, the
// first coin all the same, and the card says it is offline.
export function defaultPick(ctx) {
  const first = (dir) => {
    for (const p of PAIRS) {
      if (!ctx?.[dir]?.includes(p) || ctx?.offline?.[dir]?.includes(p)) continue;
      return ctx?.waiting?.[dir]?.includes(p) ? undefined : p;
    }
    return null;
  };
  const sell = first("sell");
  if (sell === undefined) return null;
  if (sell) return { sell: ZEC, buy: sell };
  const buy = first("buy");
  if (buy === undefined) return null;
  if (buy) return { sell: buy, buy: ZEC };
  const anySell = PAIRS.find((p) => ctx?.sell?.includes(p));
  if (anySell) return { sell: ZEC, buy: anySell };
  const anyBuy = PAIRS.find((p) => ctx?.buy?.includes(p));
  if (anyBuy) return { sell: anyBuy, buy: ZEC };
  return { sell: ZEC, buy: PAIRS.find((p) => present(ctx, p)) ?? "btc" };
}

// Picking `token` on `side`: the other side's coin swaps the two (as the arrow does), else it takes
// that side.
export function pickOn(pick, side, token) {
  const other = side === "sell" ? pick.buy : pick.sell;
  if (token === other) return { sell: pick.buy, buy: pick.sell };
  return side === "sell" ? { sell: token, buy: pick.buy } : { sell: pick.sell, buy: token };
}
