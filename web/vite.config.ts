import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// The UI talks to two ferryd daemons. In dev and preview they are proxied under /daemon/z and
// /daemon/b: the proxy adds each daemon's API token (FERRY_Z_TOKEN, FERRY_B_TOKEN; infra/demo.sh
// writes them to .demo/env), so the token never reaches the browser and EventSource, which can't
// set headers, still authenticates. The browser's Origin header is passed through unchanged, so
// ferryd's --ui-origin allowlist keeps applying.
const Z_URL = process.env.FERRY_Z_URL ?? "http://127.0.0.1:7101";
const B_URL = process.env.FERRY_B_URL ?? "http://127.0.0.1:7102";

function daemon(prefix: string, target: string, token: string | undefined): ProxyOptions {
  return {
    target,
    changeOrigin: true,
    rewrite: (p: string) => p.replace(prefix, ""),
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

const proxy = {
  "/daemon/z": daemon("/daemon/z", Z_URL, process.env.FERRY_Z_TOKEN),
  "/daemon/b": daemon("/daemon/b", B_URL, process.env.FERRY_B_TOKEN),
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  define: {
    // The maker URL is handed to Z's daemon, so it must be reachable from Z, not from the browser.
    __FERRY_MAKER_URL__: JSON.stringify(process.env.FERRY_MAKER_URL ?? B_URL),
    // The party the swap app at / belongs to (z or b).
    __FERRY_LOCAL__: JSON.stringify(process.env.FERRY_LOCAL ?? "z"),
  },
  server: { port: Number(process.env.PORT ?? 5180), strictPort: true, proxy },
  preview: { port: Number(process.env.PORT ?? 5180), strictPort: true, proxy },
});
