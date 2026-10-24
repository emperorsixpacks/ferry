import { defineConfig, type Connect, type Plugin, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { makerDirectory, parseMakers } from "./server/makers.mjs";
import { envName, pairDaemons } from "./server/pairs.mjs";

// The UI talks to two ferryd daemons. In dev and preview they are proxied under /daemon/z and
// /daemon/b: the proxy adds each daemon's API token (FERRY_Z_TOKEN, FERRY_B_TOKEN; infra/demo.sh
// writes them to .demo/env), so the token never reaches the browser and EventSource, which can't
// set headers, still authenticates. The browser's Origin header is passed through unchanged, so
// ferryd's --ui-origin allowlist keeps applying.
// The local party's daemons for other pairs (FERRY_LTC_URL, FERRY_USDC_BASE_URL, ..., with
// FERRY_<PAIR>_TOKEN) are proxied under /daemon/<pair>; see server/pairs.mjs.
const Z_URL = process.env.FERRY_Z_URL ?? "http://127.0.0.1:7101";
const B_URL = process.env.FERRY_B_URL ?? "http://127.0.0.1:7102";
const PAIRS: { id: string; url: string }[] = pairDaemons(process.env);
const TOKENS: Record<string, string | undefined> = {
  z: process.env.FERRY_Z_TOKEN,
  b: process.env.FERRY_B_TOKEN,
  ...Object.fromEntries(PAIRS.map((p) => [p.id, process.env[`FERRY_${envName(p.id)}_TOKEN`]])),
};
const TARGETS: Record<string, string> = { z: Z_URL, b: B_URL, ...Object.fromEntries(PAIRS.map((p) => [p.id, p.url])) };

// keyed by an exact pattern: a plain "/daemon/b" prefix would also catch /daemon/btc
function daemon(key: string, target: string, token: string | undefined): ProxyOptions {
  return {
    target,
    changeOrigin: true,
    rewrite: (p: string) => p.replace(`/daemon/${key}`, ""),
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    // When a daemon dies mid-stream the proxy would otherwise keep the browser's /api/events
    // response open forever, and the UI would never notice. End it so EventSource reconnects.
    configure: (proxy) => {
      proxy.on("proxyRes", (proxyRes, _req, res) => {
        proxyRes.on("close", () => {
          if (!res.writableEnded) res.destroy();
        });
      });
    },
  };
}

const proxy = Object.fromEntries(Object.entries(TARGETS).map(([key, url]) => [`^/daemon/${key}(/|$)`, daemon(key, url, TOKENS[key])]));

// The maker directory, as server/prod.mjs serves it: FERRY_MAKERS (or the one maker at
// FERRY_MAKER_URL), GET /api/makers, and swap starts that name a maker are rewritten to its
// allowlisted URL here, so the browser never sends one. The maker URL is handed to the daemon,
// so it must be reachable from the daemon, not from the browser.
function makers(): Plugin {
  const dir = makerDirectory(parseMakers(process.env.FERRY_MAKERS, process.env.FERRY_MAKER_URL ?? B_URL));
  const send = (res: Parameters<Connect.NextHandleFunction>[1], code: number, body: unknown) => {
    res.statusCode = code;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(body));
  };
  const handle: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url?.split("?")[0];
    if (url === "/api/pairs" && req.method === "GET") return send(res, 200, { pairs: PAIRS.map((p) => p.id) });
    if (url === "/api/makers" && req.method === "GET") {
      dir.list().then(
        (list) => send(res, 200, { makers: list }),
        () => send(res, 500, { error: "maker list failed" }),
      );
      return;
    }
    const m = url?.match(/^\/daemon\/([a-z-]+)\/api\/swaps$/);
    if (!m || !TARGETS[m[1]] || req.method !== "POST") return next();
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      let body: { maker?: unknown; zec_zat?: unknown };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        return send(res, 400, { error: "Send a JSON body like {\"zec_zat\": 10000000}" });
      }
      const maker = dir.resolve(body.maker);
      if (!maker) return send(res, 400, { error: "Unknown maker. Pick one from the list." });
      const headers: Record<string, string> = { "content-type": "application/json" };
      const token = TOKENS[m[1]];
      if (token) headers.authorization = `Bearer ${token}`;
      if (typeof req.headers.origin === "string") headers.origin = req.headers.origin;
      try {
        const up = await fetch(TARGETS[m[1]] + "/api/swaps", {
          method: "POST",
          headers,
          body: JSON.stringify({ maker: maker.url, zec_zat: body.zec_zat }),
          signal: AbortSignal.timeout(30_000),
        });
        res.statusCode = up.status;
        res.setHeader("content-type", up.headers.get("content-type") ?? "application/json");
        res.end(await up.text());
      } catch {
        send(res, 502, { error: "Can't reach the daemon. Is it running?" });
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
    // The party the swap app at / belongs to (z or b).
    __FERRY_LOCAL__: JSON.stringify(process.env.FERRY_LOCAL ?? "z"),
  },
  server: { port: Number(process.env.PORT ?? 5180), strictPort: true, proxy },
  preview: { port: Number(process.env.PORT ?? 5180), strictPort: true, proxy },
});
