// The user's own Ferry node, for the UI servers (server/prod.mjs and the Vite dev server). Plain Node.
//
// On a public demo the daemons behind the UI hold the operator's coins, so a visitor may start swaps
// but never say where coins go. On the user's own node (FERRY_OWN_NODE=1, which the node installer
// sets; `pnpm dev` counts as one) the person at the keyboard owns those coins, so the browser may:
//   - name where a swap's coins go: `payout_to` on a sell (Z: the coin you get), `sweep_to` on a buy
//     (B: the shielded ZEC you get), a private swap's `payout_to` (its second swap's coin), a NEAR
//     Intents buy's `sweep_to` and a NEAR-first private swap's `payout_to`;
//   - send coins out of the node: POST /api/withdraw {asset, amount, to} on any daemon it fronts;
//   - read GET /api/addresses (where to add funds) and GET /api/withdrawals.
// Still only through this server (the daemons' tokens stay here) and only to the daemons it was
// configured with. A node's port is published on loopback only, but a web page the person has open
// elsewhere could still try to reach it, so every request that moves coins must also:
//   - carry a loopback Host header (localhost, 127.0.0.0/8 or [::1]): a DNS-rebinding page has its
//     own name there;
//   - carry no Origin, or a loopback origin with the same port: a cross-site page's POST carries its
//     own origin (or "null");
//   - not say Sec-Fetch-Site: cross-site or same-site (another local port).
// The client's IP isn't checked: in a container the published port's connections come from the
// bridge, not from 127.0.0.1.

const LOOPBACK_NAME = /^(localhost|127(?:\.\d{1,3}){3}|::1)$/i;

export const isLoopback = (name) => typeof name === "string" && LOOPBACK_NAME.test(name.replace(/^\[|\]$/g, ""));

const defaultPort = (scheme) => (scheme === "https:" ? "443" : "80");

// "127.0.0.1:7865" → {name: "127.0.0.1", port: "7865"}; "[::1]" → {name: "::1", port: ""}
export function hostOf(header) {
  if (typeof header !== "string" || !header || header.length > 300) return null;
  try {
    const u = new URL(`http://${header}`);
    return { name: u.hostname.replace(/^\[|\]$/g, "").toLowerCase(), port: u.port };
  } catch {
    return null;
  }
}

// An Origin header the server's own pages send: PUBLIC_ORIGIN itself or, on the user's own node, the
// other loopback name for the same scheme and port (a node opened at http://127.0.0.1:7865 is also
// http://localhost:7865). Without PUBLIC_ORIGIN, any origin passes this check (as before).
export function originAllowed(origin, publicOrigin, own = false) {
  if (!origin || !publicOrigin || origin === publicOrigin) return true;
  if (!own) return false;
  try {
    const a = new URL(origin);
    const b = new URL(publicOrigin);
    return a.protocol === b.protocol && (a.port || defaultPort(a.protocol)) === (b.port || defaultPort(b.protocol)) && isLoopback(a.hostname) && isLoopback(b.hostname);
  } catch {
    return false;
  }
}

// Why this request may not move the node's coins (null: it may). `own`: FERRY_OWN_NODE=1.
export function ownProblem(req, own) {
  if (!own) return "This works on your own Ferry node only, not on this demo.";
  const host = hostOf(req.headers.host);
  if (!host || !isLoopback(host.name)) return "Open your Ferry node at http://127.0.0.1 or http://localhost to move its coins.";
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site !== "same-origin" && site !== "none") return "Only your Ferry node's own page can move its coins.";
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let o;
    try {
      o = new URL(String(origin));
    } catch {
      return "Only your Ferry node's own page can move its coins.";
    }
    const port = o.port || defaultPort(o.protocol);
    const hostPort = host.port || defaultPort(o.protocol);
    if (!isLoopback(o.hostname) || port !== hostPort) return "Only your Ferry node's own page can move its coins.";
  }
  return null;
}

// An address a browser names for a swap's coins: letters and digits only (every address Ferry pays
// is: bech32, base58, 0x-hex, unified), at most `max` characters. The daemon checks it for its chain
// and network before anything moves. null: not one.
export function receiveAddress(v, max = 600) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length >= 8 && t.length <= max && /^[A-Za-z0-9]+$/.test(t) ? t : null;
}

// The receive fields of a swap start, for a daemon on `side` ("sell": Z, "buy": B), as JSON members
// to append to the rebuilt body (",\"payout_to\":\"…\""), or {error}. Fields for the other side are
// dropped (the daemon would refuse them anyway).
export function receiveFields(body, side) {
  const name = side === "sell" ? "payout_to" : "sweep_to";
  const raw = body?.[name];
  if (raw == null || raw === "") return { json: "" };
  const to = receiveAddress(raw, side === "sell" ? 128 : 600);
  if (!to) return { error: side === "sell" ? "That address doesn't look right. Check it and try again." : "That shielded address doesn't look right. Check it and try again." };
  return { json: `,${JSON.stringify(name)}:${JSON.stringify(to)}` };
}

// What a node can send out: shielded ZEC, its counter coin (BTC, LTC), an EVM daemon's token, or its
// gas ETH. Amounts are base units: zatoshi and satoshi as JSON integers (as ferryd's own amounts),
// token units and wei as decimal strings (as its token_units and eth_wei).
export const WITHDRAW_ASSETS = ["zec", "btc", "token", "eth"];

// Rebuild a browser's POST /api/withdraw: {body} for the daemon, or {error}. `preview`: the daemon
// lists "withdraw_preview" in its features, so {"dry_run": true} asks for the fee without sending;
// a daemon that doesn't would ignore the field and send for real, so it never reaches one.
export function withdrawBody(body, { preview = false } = {}) {
  const asset = body?.asset;
  if (!WITHDRAW_ASSETS.includes(asset)) return { error: 'asset must be "zec", "btc", "token" or "eth"' };
  let amount = body?.amount;
  if (asset === "zec" || asset === "btc") {
    if (typeof amount === "string" && /^[1-9]\d{0,15}$/.test(amount)) amount = Number(amount);
    if (!Number.isSafeInteger(amount) || amount <= 0) return { error: "amount must be a positive whole number of the coin's smallest units" };
  } else {
    if (typeof amount === "number" && Number.isSafeInteger(amount) && amount > 0) amount = String(amount);
    if (typeof amount !== "string" || !/^[1-9]\d{0,77}$/.test(amount)) return { error: "amount must be a positive whole number of the coin's smallest units" };
  }
  const to = receiveAddress(body?.to);
  if (!to) return { error: "That address doesn't look right. Check it and try again." };
  const dry = body?.dry_run === true;
  if (dry && !preview) return { error: "Your Ferry node can't preview a send's fee.", status: 501 };
  return { body: { asset, amount, to, ...(dry ? { dry_run: true } : {}) } };
}
