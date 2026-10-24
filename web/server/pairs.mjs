// The local party's daemons for each pair and direction, for the UI servers (server/prod.mjs and
// the Vite dev server). Plain Node.
//
// A ferryd swaps ZEC against one coin (--chain btc|ltc), or one ERC-20 on one EVM chain
// (--counter evm), in one role: a Z daemon sells shielded ZEC, a B daemon buys it. So one UI that
// offers several pairs, both ways, talks to up to two daemons per pair:
//   FERRY_Z_URL                                         the main pair's Z daemon: sells ZEC
//   FERRY_B_URL                                         the main pair's B daemon: buys ZEC
//   FERRY_BTC_URL, FERRY_LTC_URL                        another pair's Z daemon (sells ZEC for it)
//   FERRY_USDC_BASE_URL, FERRY_WETH_ARBITRUM_URL, ...   ... a token on a chain: USDC or WETH on
//                                                       BASE, ETHEREUM, ARBITRUM or OPTIMISM
//   FERRY_BTC_B_URL, FERRY_USDC_BASE_B_URL, ...         another pair's B daemon (buys ZEC with it)
//   FERRY_<PAIR>_TOKEN / _TOKEN_FILE, FERRY_<PAIR>_B_TOKEN / _B_TOKEN_FILE   their API tokens
// The main daemons are proxied at /daemon/z and /daemon/b, the others at /daemon/<pair> (btc, ltc,
// usdc-base, weth-arbitrum, ...) and /daemon/b-<pair>. GET /api/pairs says which daemons exist, so
// the swap page offers each pair in the directions it can swap (see pairsBody).

const TOKENS = ["usdc", "weth"];
const CHAINS = ["base", "ethereum", "arbitrum", "optimism"];
export const PAIR_IDS = ["btc", "ltc", ...TOKENS.flatMap((t) => CHAINS.map((c) => `${t}-${c}`))];
// "usdc-base" -> "USDC_BASE", as in FERRY_USDC_BASE_URL
export const envName = (id) => id.toUpperCase().replace("-", "_");
// the proxy key of a pair's buy-side (B) daemon: /daemon/b-btc, /daemon/b-usdc-base. No pair id
// starts with "b-", and the proxies match keys exactly, so neither /daemon/b nor /daemon/btc can
// catch it.
export const buyKey = (id) => `b-${id}`;
// FERRY_BTC_B_URL's stem: "BTC_B"
export const buyEnvName = (id) => `${envName(id)}_B`;

function urlsFrom(env, nameOf) {
  return PAIR_IDS.flatMap((id) => {
    const name = `FERRY_${nameOf(id)}_URL`;
    const raw = env[name]?.trim();
    if (!raw) return [];
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`${name}: "${raw}" is not a URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${name}: only http and https URLs`);
    return [{ id, url: url.href.replace(/\/+$/, "") }];
  });
}

// [{ id, url }] for the other pairs' Z (sell-side) daemons this env configures. Throws on a URL
// that doesn't parse, so a typo stops the server at startup.
export function pairDaemons(env) {
  return urlsFrom(env, envName);
}

// [{ id, url }] for the other pairs' B (buy-side) daemons: FERRY_<PAIR>_B_URL.
export function buyDaemons(env) {
  return urlsFrom(env, buyEnvName);
}

// Every daemon the UI server fronts besides the main two: [{ key, id, side, url, tokenName }],
// tokenName being the stem of its FERRY_<stem>_TOKEN(_FILE).
export function extraDaemons(env) {
  return [
    ...pairDaemons(env).map((p) => ({ key: p.id, id: p.id, side: "sell", url: p.url, tokenName: envName(p.id) })),
    ...buyDaemons(env).map((p) => ({ key: buyKey(p.id), id: p.id, side: "buy", url: p.url, tokenName: buyEnvName(p.id) })),
  ];
}

// GET /api/pairs. `pairs` keeps its old meaning (the other pairs' Z daemons, so an older page
// still finds them); `buy` lists the other pairs with a B daemon; `main` says which of the main
// daemons the page may start swaps on: Z sells ZEC, B buys it (whatever pair they run, which the
// page learns from their status).
export function pairsBody(extras, { mainSell = true, mainBuy = true } = {}) {
  return {
    pairs: extras.filter((d) => d.side === "sell").map((d) => d.id),
    buy: extras.filter((d) => d.side === "buy").map((d) => d.id),
    main: { sell: mainSell, buy: mainBuy },
  };
}

// The daemons that hold the same pair as `key`: a start on one waits for every swap on both
// (in a local demo, one is the other's maker).
export function samePair(key, extras) {
  if (key === "z" || key === "b") return ["z", "b"];
  const d = extras.find((x) => x.key === key);
  return d ? extras.filter((x) => x.id === d.id).map((x) => x.key) : [key];
}
