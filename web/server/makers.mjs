// Maker directory for the UI servers (server/prod.mjs and the Vite dev server). Plain Node.
//
// The operator allowlists makers in FERRY_MAKERS. The server fetches each maker's public offer
// (GET <url>/peer/offer) itself, with a short timeout, a size cap and a cache, and the browser only
// ever names a maker by index or name: no URL from a client is ever fetched or handed to a daemon.
//
// FERRY_MAKERS is either JSON, [{"name": "Kestrel", "url": "http://maker:7112", "pair": "ZEC/BTC"}],
// or a comma list of name|url|pair entries (pair optional, default ZEC/BTC):
//   FERRY_MAKERS='Kestrel|http://10.0.0.5:7112|ZEC/BTC, Heron|https://heron.example/ferry'
import http from "node:http";
import https from "node:https";

export const MAX_MAKERS = 20;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,39}$/;
const PAIR = /^[A-Z]{2,5}\/[A-Z]{2,5}$/;
const OFFER_BYTES = 16 * 1024;

// Parse and validate the allowlist. Throws with a readable message on a bad entry, so a typo
// stops the server at startup instead of silently dropping a maker.
export function parseMakers(raw, fallbackUrl) {
  let entries;
  const text = (raw ?? "").trim();
  if (!text) {
    entries = fallbackUrl ? [{ name: "Demo maker", url: fallbackUrl, pair: "ZEC/BTC" }] : [];
  } else if (text.startsWith("[")) {
    try {
      entries = JSON.parse(text);
    } catch (e) {
      throw new Error(`FERRY_MAKERS is not valid JSON: ${e.message}`);
    }
    if (!Array.isArray(entries)) throw new Error("FERRY_MAKERS JSON must be an array");
  } else {
    entries = text
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const [name, url, pair] = s.split("|").map((p) => p.trim());
        return { name, url, pair };
      });
  }
  if (entries.length > MAX_MAKERS) throw new Error(`FERRY_MAKERS lists ${entries.length} makers; the limit is ${MAX_MAKERS}`);
  const seen = new Set();
  return entries.map((e, i) => {
    const name = String(e?.name ?? "").trim();
    if (!NAME.test(name)) throw new Error(`FERRY_MAKERS entry ${i}: name "${name}" must be 1-40 letters, digits, spaces or ._()-`);
    if (seen.has(name.toLowerCase())) throw new Error(`FERRY_MAKERS entry ${i}: duplicate name "${name}"`);
    seen.add(name.toLowerCase());
    let url;
    try {
      url = new URL(String(e?.url ?? ""));
    } catch {
      throw new Error(`FERRY_MAKERS entry ${i} (${name}): "${e?.url}" is not a URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`FERRY_MAKERS entry ${i} (${name}): only http and https URLs`);
    if (url.username || url.password || url.search || url.hash) throw new Error(`FERRY_MAKERS entry ${i} (${name}): no credentials, query or fragment in the URL`);
    const pair = String(e?.pair ?? "ZEC/BTC").trim().toUpperCase();
    if (!PAIR.test(pair)) throw new Error(`FERRY_MAKERS entry ${i} (${name}): pair "${pair}" must look like ZEC/BTC`);
    // the peer URL the daemon gets, without a trailing slash
    return { name, url: url.href.replace(/\/+$/, ""), pair };
  });
}

// GET <maker>/peer/offer: no redirects, a timeout on the whole exchange, at most OFFER_BYTES.
function fetchOffer(makerUrl, timeoutMs) {
  const target = new URL(makerUrl + "/peer/offer");
  const lib = target.protocol === "https:" ? https : http;
  return new Promise((ok, fail) => {
    const req = lib.request(target, { method: "GET", headers: { accept: "application/json" }, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return fail(new Error(`HTTP ${res.statusCode}`));
      }
      let size = 0;
      const chunks = [];
      res.on("data", (c) => {
        size += c.length;
        if (size > OFFER_BYTES) req.destroy(new Error("offer too large"));
        else chunks.push(c);
      });
      res.on("end", () => {
        try {
          ok(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          fail(new Error("bad JSON"));
        }
      });
      res.on("error", fail);
    });
    const deadline = setTimeout(() => req.destroy(new Error("timeout")), timeoutMs);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", fail);
    req.on("close", () => clearTimeout(deadline));
    req.end();
  });
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

// The public fields of one offer, and nothing else the maker sent.
function summarize(m, index, offer, now) {
  const rate = num(offer?.rate_sat_per_zec);
  const updated = num(offer?.rate_updated_at);
  const paused = offer?.paused === true;
  const making = offer?.making === true;
  // The offer says which coin the maker swaps (ferryd --chain); older makers leave it out.
  // An EVM maker (ferryd --counter evm) names its token instead.
  const token = offer?.counter === "evm" && /^[A-Za-z0-9]{1,11}$/.test(offer?.token_symbol ?? "") ? offer.token_symbol.toUpperCase() : null;
  const pair = token ? `ZEC/${token}` : offer?.coin === "ltc" ? "ZEC/LTC" : offer?.coin === "btc" ? "ZEC/BTC" : m.pair;
  return {
    index,
    name: m.name,
    pair,
    online: rate != null,
    // can take a swap right now
    available: rate != null && making && !paused,
    paused,
    role: offer?.role === "Z" || offer?.role === "B" ? offer.role : null,
    rate_sat_per_zec: rate,
    min_zat: num(offer?.min_zat),
    max_zat: num(offer?.max_zat),
    fee_sat: num(offer?.terms?.btc_fee),
    liquidity_zat: num(offer?.liquidity?.zec_zat),
    rate_source: typeof offer?.rate_source === "string" ? offer.rate_source.slice(0, 80) : null,
    rate_updated_at: updated,
    rate_age_s: updated != null ? Math.max(0, Math.round(now / 1000 - updated)) : null,
  };
}

function offline(m, index, error) {
  return {
    index,
    name: m.name,
    pair: m.pair,
    online: false,
    available: false,
    paused: false,
    role: null,
    rate_sat_per_zec: null,
    min_zat: null,
    max_zat: null,
    fee_sat: null,
    liquidity_zat: null,
    rate_source: null,
    rate_updated_at: null,
    rate_age_s: null,
    error,
  };
}

// One directory per server. `list()` answers from a cache of at most ttlMs (one fetch per maker
// per ttl, however many browsers ask: the server can't be used to flood a maker); `resolve(ref)`
// maps a client's maker reference to the allowlisted entry.
export function makerDirectory(makers, { timeoutMs = 2500, ttlMs = 10_000, fetcher = fetchOffer } = {}) {
  const cache = makers.map(() => ({ at: 0, offer: null, error: "not checked yet", pending: null }));

  async function refresh(i) {
    const c = cache[i];
    if (c.pending) return c.pending;
    c.pending = fetcher(makers[i].url, timeoutMs)
      .then((offer) => {
        c.offer = offer;
        c.error = null;
      })
      .catch((e) => {
        c.offer = null;
        c.error = e?.message === "timeout" ? "No answer" : "Unreachable";
      })
      .finally(() => {
        c.at = Date.now();
        c.pending = null;
      });
    return c.pending;
  }

  return {
    makers,
    async list() {
      const now = Date.now();
      await Promise.all(makers.map((_, i) => (now - cache[i].at >= ttlMs ? refresh(i) : null)));
      const at = Date.now();
      return makers.map((m, i) => (cache[i].offer ? summarize(m, i, cache[i].offer, at) : offline(m, i, cache[i].error)));
    },
    // undefined/null: the first maker. An integer (or its string): that index. Otherwise a name.
    resolve(ref) {
      if (ref === undefined || ref === null) return makers[0] ?? null;
      if (typeof ref === "number") return Number.isInteger(ref) ? makers[ref] ?? null : null;
      if (typeof ref !== "string") return null;
      const s = ref.trim();
      if (/^\d{1,3}$/.test(s)) return makers[Number(s)] ?? null;
      return makers.find((m) => m.name.toLowerCase() === s.toLowerCase()) ?? null;
    },
  };
}
