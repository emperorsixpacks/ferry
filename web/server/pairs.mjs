// The local party's daemons for each pair, for the UI servers (server/prod.mjs and the Vite dev
// server). Plain Node.
//
// A ferryd swaps ZEC against one coin (--chain btc|ltc), or one ERC-20 on one EVM chain
// (--counter evm), so one UI that offers several pairs talks to one daemon per pair. FERRY_Z_URL
// (or FERRY_B_URL for a B-side UI) stays the main daemon, whatever pair it runs; each other pair
// is optional:
//   FERRY_BTC_URL, FERRY_LTC_URL                       a Bitcoin / Litecoin daemon's control API
//   FERRY_USDC_BASE_URL, FERRY_WETH_ARBITRUM_URL, ...  a token on a chain: USDC or WETH on BASE,
//                                                      ETHEREUM, ARBITRUM or OPTIMISM
//   FERRY_<PAIR>_TOKEN / FERRY_<PAIR>_TOKEN_FILE       its API token (<data-dir>/api-token)
// They are proxied at /daemon/<pair> (btc, ltc, usdc-base, weth-arbitrum, ...), and GET /api/pairs
// lists the ones configured, so the swap page can offer them.

const TOKENS = ["usdc", "weth"];
const CHAINS = ["base", "ethereum", "arbitrum", "optimism"];
export const PAIR_IDS = ["btc", "ltc", ...TOKENS.flatMap((t) => CHAINS.map((c) => `${t}-${c}`))];
// "usdc-base" -> "USDC_BASE", as in FERRY_USDC_BASE_URL
export const envName = (id) => id.toUpperCase().replace("-", "_");

// [{ id, url }] for the pairs this env configures. Throws on a URL that doesn't parse, so a typo
// stops the server at startup.
export function pairDaemons(env) {
  return PAIR_IDS.flatMap((id) => {
    const raw = env[`FERRY_${envName(id)}_URL`]?.trim();
    if (!raw) return [];
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`FERRY_${envName(id)}_URL: "${raw}" is not a URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`FERRY_${envName(id)}_URL: only http and https URLs`);
    return [{ id, url: url.href.replace(/\/+$/, "") }];
  });
}
