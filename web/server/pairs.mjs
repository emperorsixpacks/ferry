// The local party's daemons for each pair, for the UI servers (server/prod.mjs and the Vite dev
// server). Plain Node.
//
// A ferryd swaps ZEC against one coin (--chain btc|ltc, --counter evm for USDC), so one UI that
// offers several pairs talks to one daemon per pair. FERRY_Z_URL (or FERRY_B_URL for a B-side UI)
// stays the main daemon, whatever pair it runs; each other pair is optional:
//   FERRY_BTC_URL, FERRY_LTC_URL, FERRY_USDC_URL     the daemon's control API
//   FERRY_<PAIR>_TOKEN / FERRY_<PAIR>_TOKEN_FILE     its API token (<data-dir>/api-token)
// They are proxied at /daemon/btc, /daemon/ltc and /daemon/usdc, and GET /api/pairs lists the ones
// configured, so the swap page can offer them.

export const PAIR_IDS = ["btc", "ltc", "usdc"];

// [{ id, url }] for the pairs this env configures. Throws on a URL that doesn't parse, so a typo
// stops the server at startup.
export function pairDaemons(env) {
  return PAIR_IDS.flatMap((id) => {
    const raw = env[`FERRY_${id.toUpperCase()}_URL`]?.trim();
    if (!raw) return [];
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`FERRY_${id.toUpperCase()}_URL: "${raw}" is not a URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`FERRY_${id.toUpperCase()}_URL: only http and https URLs`);
    return [{ id, url: url.href.replace(/\/+$/, "") }];
  });
}
