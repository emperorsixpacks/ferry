import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The UI talks to two ferryd daemons. In dev and preview they are proxied under
// /daemon/z and /daemon/b so real daemons don't need CORS headers.
const Z_URL = process.env.FERRY_Z_URL ?? "http://127.0.0.1:7101";
const B_URL = process.env.FERRY_B_URL ?? "http://127.0.0.1:7102";

const proxy = {
  "/daemon/z": { target: Z_URL, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/daemon\/z/, "") },
  "/daemon/b": { target: B_URL, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/daemon\/b/, "") },
};

export default defineConfig({
  plugins: [react()],
  define: {
    // The maker URL is handed to Z's daemon, so it must be reachable from Z, not from the browser.
    __FERRY_MAKER_URL__: JSON.stringify(process.env.FERRY_MAKER_URL ?? B_URL),
  },
  server: { port: Number(process.env.PORT ?? 5180), strictPort: true, proxy },
  preview: { port: Number(process.env.PORT ?? 5180), strictPort: true, proxy },
});
