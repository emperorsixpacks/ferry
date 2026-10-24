import { defineConfig, type Connect, type Plugin, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makerDirectory, parseMakers } from "./server/makers.mjs";
import { quoteDesk } from "./server/quotes.mjs";
import { extraDaemons, mainSide, pairsBody } from "./server/pairs.mjs";
import { buildRoute, routerLink } from "./server/routes.mjs";
import { ONE_CLICK_PUBKEY, ONE_CLICK_URL, nearDesk, nearRoutes, oneClick, ownDaemons, requestJson } from "./server/near.mjs";
import { ownProblem, receiveFields, withdrawBody } from "./server/own.mjs";
import { READ_MS, ROUTER_TIMEOUT_TEXT, START_MS, TIMEOUT_TEXT, deadline, limitFor, timeoutAnswer } from "./server/upstream.mjs";

// The UI talks to the user's ferryd daemons: Z sells ZEC, B buys it. In dev and preview the main
// two are proxied under /daemon/z and /daemon/b: the proxy adds each daemon's API token
// (FERRY_Z_TOKEN, FERRY_B_TOKEN; infra/demo.sh writes them to .demo/env), so the token never
// reaches the browser and EventSource, which can't set headers, still authenticates. The
// browser's Origin header is passed through unchanged, so ferryd's --ui-origin allowlist keeps
// applying.
// The daemons for other pairs (FERRY_LTC_URL, FERRY_USDC_BASE_URL, ... for selling ZEC,
// FERRY_LTC_B_URL, ... for buying it, with FERRY_<PAIR>_TOKEN / FERRY_<PAIR>_B_TOKEN) are
// proxied under /daemon/<pair> and /daemon/b-<pair>; see server/pairs.mjs. The page leaves out
// a main daemon that is a maker (the usual demo's B); FERRY_B_BUYS / FERRY_Z_SELLS = 0 or 1 say
// so explicitly.
const Z_URL = process.env.FERRY_Z_URL ?? "http://127.0.0.1:7101";
const B_URL = process.env.FERRY_B_URL ?? "http://127.0.0.1:7102";
const EXTRA = extraDaemons(process.env);
const PAIRS_BODY = pairsBody(EXTRA, { mainSell: mainSide(process.env.FERRY_Z_SELLS), mainBuy: mainSide(process.env.FERRY_B_BUYS) });
const TOKENS: Record<string, string | undefined> = {
  z: process.env.FERRY_Z_TOKEN,
  b: process.env.FERRY_B_TOKEN,
  ...Object.fromEntries(EXTRA.map((d) => [d.key, process.env[`FERRY_${d.tokenName}_TOKEN`]])),
};
const TARGETS: Record<string, string> = { z: Z_URL, b: B_URL, ...Object.fromEntries(EXTRA.map((d) => [d.key, d.url])) };
// How long the proxy waits for a daemon or the router, as server/prod.mjs: a read (and an event
// stream's start) FERRY_READ_TIMEOUT_MS (10 s), anything else FERRY_START_TIMEOUT_MS (120 s); then
// the browser gets 504 and the request to the daemon is closed (server/upstream.mjs). So one daemon
// that hangs instead of failing can't hold up the page.
const LIMITS = { read: Number(process.env.FERRY_READ_TIMEOUT_MS) || READ_MS, start: Number(process.env.FERRY_START_TIMEOUT_MS) || START_MS };

// keyed by an exact pattern: a plain "/daemon/b" prefix would also catch /daemon/btc and
// /daemon/b-btc
function daemon(key: string, target: string, token: string | undefined): ProxyOptions {
  return {
    target,
    changeOrigin: true,
    rewrite: (p: string) => p.replace(`/daemon/${key}`, ""),
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    // When a daemon dies mid-stream the proxy would otherwise keep the browser's /api/events
    // response open forever, and the UI would never notice. End it so EventSource reconnects.
    configure: (proxy) => {
      proxy.on("proxyReq", (proxyReq, req, res) => void deadline(proxyReq, res, { ms: limitFor(req.method, LIMITS), answer: timeoutAnswer(TIMEOUT_TEXT) }));
      proxy.on("proxyRes", (proxyRes, _req, res) => {
        proxyRes.on("close", () => {
          if (!res.writableEnded) res.destroy();
        });
      });
    },
  };
}

const proxy = Object.fromEntries(Object.entries(TARGETS).map(([key, url]) => [`^/daemon/${key}(/|$)`, daemon(key, url, TOKENS[key])]));

// The user's router for private swaps (ferry-route), when FERRY_ROUTER_URL is set: proxied under
// /router with FERRY_ROUTER_TOKEN (or the file FERRY_ROUTER_TOKEN_FILE names), as the daemons are.
// Route starts are rebuilt below, as swap starts are; server/routes.mjs.
const ROUTER_URL = process.env.FERRY_ROUTER_URL;
const routerToken = (): string | undefined => {
  if (process.env.FERRY_ROUTER_TOKEN) return process.env.FERRY_ROUTER_TOKEN;
  try {
    return process.env.FERRY_ROUTER_TOKEN_FILE ? readFileSync(process.env.FERRY_ROUTER_TOKEN_FILE, "utf8").trim() : undefined;
  } catch {
    return undefined;
  }
};
const ROUTER = ROUTER_URL ? routerLink({ url: ROUTER_URL, token: routerToken }) : null;
if (ROUTER_URL) {
  proxy["^/router(/|$)"] = {
    target: ROUTER_URL,
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/router/, ""),
    configure: (p) => {
      // read per request: the token file may change when the router restarts
      p.on("proxyReq", (proxyReq, req, res) => {
        const t = routerToken();
        if (t) proxyReq.setHeader("authorization", `Bearer ${t}`);
        deadline(proxyReq, res, { ms: limitFor(req.method, LIMITS), answer: timeoutAnswer(ROUTER_TIMEOUT_TEXT) });
      });
      p.on("proxyRes", (proxyRes, _req, res) => {
        proxyRes.on("close", () => {
          if (!res.writableEnded) res.destroy();
        });
      });
    },
  };
}

// The maker directory, as server/prod.mjs serves it: FERRY_MAKERS (or the one maker at
// FERRY_MAKER_URL), GET /api/makers, and swap starts that name a maker are rewritten to its
// allowlisted URL here, so the browser never sends one. The maker URL is handed to the daemon,
// so it must be reachable from the daemon, not from the browser. POST /api/quotes asks the makers
// for firm quotes (server/quotes.mjs), and a swap start may name one by id.
//
// NEAR Intents (server/near.mjs), as server/prod.mjs runs it: /api/near/... when FERRY_NEAR_URL is set
// (the mock's 1Click in `pnpm dev`) or FERRY_NEAR_QUOTES=1 (the real API: quotes only, unless
// FERRY_NEAR=1 on mainnet nodes). FERRY_NEAR_TESTNET=1 lets a loopback mock run swaps on test networks.
//
// The dev server is the person's own node (server/own.mjs): unless FERRY_OWN_NODE=0, a page opened
// on loopback may say where a swap's coins go and send coins out of the node, as prod.mjs allows
// with FERRY_OWN_NODE=1. FERRY_OWN_NODE=0 makes it behave like a public demo.
const OWN_NODE = process.env.FERRY_OWN_NODE !== "0";

function makers(): Plugin {
  const dir = makerDirectory(parseMakers(process.env.FERRY_MAKERS, process.env.FERRY_MAKER_URL ?? B_URL));
  const desk = quoteDesk(dir);
  const send = (res: Parameters<Connect.NextHandleFunction>[1], code: number, body: unknown, extra: Record<string, string> = {}) => {
    res.statusCode = code;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
    res.end(JSON.stringify(body));
  };
  const nearOn = !!process.env.FERRY_NEAR_URL || process.env.FERRY_NEAR_QUOTES === "1";
  const daemonCall = (key: string, method: string, path: string, body?: unknown) =>
    requestJson(new URL(path, TARGETS[key]), { method, headers: TOKENS[key] ? { authorization: `Bearer ${TOKENS[key]}` } : {}, body, timeoutMs: 30_000 });
  const mainSell = mainSide(process.env.FERRY_Z_SELLS);
  const mainBuy = mainSide(process.env.FERRY_B_BUYS);
  const near = nearOn
    ? nearDesk({
        link: oneClick({ url: process.env.FERRY_NEAR_URL || ONE_CLICK_URL, jwt: process.env.FERRY_NEAR_JWT ?? null }),
        directory: dir,
        quotes: desk,
        daemons: ownDaemons({
          sell: [...(mainSell !== false ? [{ key: "z", auto: mainSell === "auto" }] : []), ...EXTRA.filter((d) => d.side === "sell").map((d) => ({ key: d.key, pair: d.id }))],
          buy: [...(mainBuy !== false ? [{ key: "b", auto: mainBuy === "auto" }] : []), ...EXTRA.filter((d) => d.side === "buy").map((d) => ({ key: d.key, pair: d.id }))],
          call: daemonCall,
        }),
        call: daemonCall,
        execution: process.env.FERRY_NEAR === "1",
        testnet: process.env.FERRY_NEAR_TESTNET === "1",
        state: process.env.FERRY_NEAR_STATE ?? null,
        pubkey: process.env.FERRY_NEAR_PUBKEY || ONE_CLICK_PUBKEY,
        tickMs: Number(process.env.FERRY_NEAR_TICK_MS ?? 4000),
        statusEveryMs: Number(process.env.FERRY_NEAR_STATUS_MS ?? 5000),
        // private swaps with NEAR Intents at an end run through the router
        router: ROUTER,
      })
    : null;
  const readBody = (req: Connect.IncomingMessage, limit = 4096) =>
    new Promise<string>((ok, fail) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > limit) {
          fail(new Error("too large"));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
      req.on("error", fail);
    });
  const own = (req: Connect.IncomingMessage) => !ownProblem(req, OWN_NODE);
  const nearHttp = near ? nearRoutes(near, { send, readBody, own }) : null;
  const handle: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url?.split("?")[0];
    if (url?.startsWith("/api/near/")) {
      if (!nearHttp) return send(res, 404, { error: "NEAR Intents is off on this server" });
      nearHttp(req, res, url).catch(() => !res.headersSent && send(res, 500, { error: "near failed" }));
      return;
    }
    if (url === "/api/pairs" && req.method === "GET") {
      (ROUTER ? ROUTER.legs() : Promise.resolve(null)).then((routes) => send(res, 200, { ...PAIRS_BODY, routes, node: { own: own(req) } }));
      return;
    }
    // a private swap names its partners; they become allowlisted URLs here (routes.mjs)
    if (url === "/router/api/routes" && req.method === "POST" && ROUTER) {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          return send(res, 400, { error: 'Send a JSON body like {"from": "btc", "to": "usdc-base", ...}' });
        }
        const built = buildRoute(body, { list: await dir.list(), resolve: dir.resolve, legs: await ROUTER.legs(), payout: own(req) });
        if (built.error !== undefined) return send(res, built.status, { error: built.error });
        try {
          const up = await ROUTER.call("POST", "/api/routes", built.body);
          send(res, up.status, up.body ?? { error: "No answer from the router" });
        } catch {
          send(res, 502, { error: "Can't reach the private swap service. Is ferry-route running?" });
        }
      });
      return;
    }
    if (url === "/api/makers" && req.method === "GET") {
      dir.list().then(
        (list) => send(res, 200, { makers: list }),
        () => send(res, 500, { error: "maker list failed" }),
      );
      return;
    }
    if (url === "/api/quotes" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          return send(res, 400, { error: 'Send a JSON body like {"pair": "btc", "direction": "sell", "zec_zat": 10000000}' });
        }
        desk.request(body).then(
          (r) => send(res, r.status, r.body),
          () => send(res, 500, { error: "quotes failed" }),
        );
      });
      return;
    }
    // the node's addresses, what it sent out, and sending: its owner only (own.mjs)
    const w = url?.match(/^\/daemon\/([a-z-]+)\/api\/(withdraw|withdrawals|addresses)$/);
    if (w && TARGETS[w[1]]) {
      const no = ownProblem(req, OWN_NODE);
      if (no) return send(res, 403, { error: no });
      if (w[2] !== "withdraw") return next();
      if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
      readBody(req)
        .then(async (raw) => {
          let body: { dry_run?: unknown } | null;
          try {
            body = JSON.parse(raw || "{}");
          } catch {
            return send(res, 400, { error: 'Send a JSON body like {"asset": "zec", "amount": 10000000, "to": "u1…"}' });
          }
          // a fee preview only from a daemon that says it previews: any other would send for real
          let preview = false;
          if (body?.dry_run === true) {
            const s = await daemonCall(w[1], "GET", "/api/status").catch(() => null);
            const features = (s?.body as { features?: unknown } | null)?.features;
            preview = s?.status === 200 && Array.isArray(features) && features.includes("withdraw_preview");
          }
          const built = withdrawBody(body, { preview });
          if (built.error) return send(res, built.status ?? 400, { error: built.error });
          const up = await daemonCall(w[1], "POST", "/api/withdraw", built.body);
          send(res, up.status, up.body ?? { error: "No answer from the daemon" });
        })
        .catch(() => !res.headersSent && send(res, 502, { error: "Can't reach the daemon. Is it running?" }));
      return;
    }
    const m = url?.match(/^\/daemon\/([a-z-]+)\/api\/swaps$/);
    if (!m || !TARGETS[m[1]] || req.method !== "POST") return next();
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      let body: { maker?: unknown; zec_zat?: unknown; quote?: unknown; payout_to?: unknown; sweep_to?: unknown };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        return send(res, 400, { error: "Send a JSON body like {\"zec_zat\": 10000000}" });
      }
      const maker = dir.resolve(body.maker);
      if (!maker) return send(res, 400, { error: "Unknown maker. Pick one from the list." });
      // where the coins go, on the person's own node (own.mjs): payout_to on a sell, sweep_to on a buy
      const side = m[1] === "z" ? "sell" : m[1] === "b" ? "buy" : (EXTRA.find((d) => d.key === m[1])?.side ?? "sell");
      const receive = own(req) ? receiveFields(body, side) : { json: "" };
      if (receive.error) return send(res, 400, { error: receive.error });
      // a firm quote, named by id: the signed quote this server got from that maker itself, claimed
      // for this start alone (a fresh one if another start took it: server/quotes.mjs claim())
      const zat = Number(body.zec_zat);
      const quote = body.quote == null ? null : await desk.claim(dir.makers.indexOf(maker), body.quote, Number.isSafeInteger(zat) ? zat : 0);
      if (body.quote != null && !quote) return send(res, 400, { error: "That firm price has expired. Get a new one." });
      const headers: Record<string, string> = { "content-type": "application/json" };
      const token = TOKENS[m[1]];
      if (token) headers.authorization = `Bearer ${token}`;
      if (typeof req.headers.origin === "string") headers.origin = req.headers.origin;
      try {
        const up = await fetch(TARGETS[m[1]] + "/api/swaps", {
          method: "POST",
          headers,
          body: quote
            ? `{"maker":${JSON.stringify(maker.url)},"zec_zat":${JSON.stringify(body.zec_zat)},"quote":${quote.json}${receive.json}}`
            : `{"maker":${JSON.stringify(maker.url)},"zec_zat":${JSON.stringify(body.zec_zat)}${receive.json}}`,
          // a start's own limit, longer than ferryd's longest wait in one (server/upstream.mjs)
          signal: AbortSignal.timeout(LIMITS.start),
        });
        res.statusCode = up.status;
        res.setHeader("content-type", up.headers.get("content-type") ?? "application/json");
        const text = await up.text();
        // a start the daemon or its partner can't take now ("code": "busy"), said as server/prod.mjs says it
        let busy = false;
        try {
          busy = up.status === 409 && JSON.parse(text)?.code === "busy";
        } catch {
          /* not JSON */
        }
        res.end(busy ? JSON.stringify({ error: "Every partner is busy right now. Try again once one of their swaps finishes.", code: "busy" }) : text);
      } catch (e) {
        if ((e as Error).name === "TimeoutError") send(res, 504, { error: TIMEOUT_TEXT, code: "timeout" });
        else send(res, 502, { error: "Can't reach the daemon. Is it running?" });
      }
    });
  };
  return {
    name: "ferry-makers",
    configureServer: (server) => void server.middlewares.use(handle),
    configurePreviewServer: (server) => void server.middlewares.use(handle),
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), makers()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  define: {
    // The direction the swap page starts in until the viewer flips it: z sells ZEC, b buys it.
    __FERRY_LOCAL__: JSON.stringify(process.env.FERRY_LOCAL ?? "z"),
  },
  server: { port: Number(process.env.PORT ?? 5180), strictPort: true, proxy },
  preview: { port: Number(process.env.PORT ?? 5180), strictPort: true, proxy },
});
