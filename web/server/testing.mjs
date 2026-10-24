// Helpers for the server tests that run real HTTP: a fake daemon (or maker), a request with its
// timing, and prod.mjs itself as a child process. Not a test file itself.
//
// Ports: the OS picks them, unless TEST_PORT_BASE names the first of a range, e.g.
// TEST_PORT_BASE=7530 pnpm test:server; each test file then takes its own ten from `offset`.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the next port for this test file: 0 (the OS picks) without TEST_PORT_BASE
export function ports(offset) {
  const base = Number(process.env.TEST_PORT_BASE) || 0;
  let next = base + offset;
  return () => (base ? next++ : 0);
}

// A fake daemon: `routes[method + " " + path](req, res)`; a route that never answers holds the request.
// It keeps every connection it was given, to see which are still open.
export function fakeDaemon(routes, port = () => 0) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const route = routes[`${req.method} ${new URL(req.url, "http://x").pathname}`];
    if (route) route(req, res);
    else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":"not found"}');
    }
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return new Promise((ok) =>
    server.listen(port(), "127.0.0.1", () => ok({ url: `http://127.0.0.1:${server.address().port}`, open: () => sockets.size, close: () => (server.closeAllConnections(), server.close()) })),
  );
}

// the request body as JSON (null if it isn't)
export function bodyOf(req) {
  return new Promise((ok) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      try {
        ok(JSON.parse(text));
      } catch {
        ok(null);
      }
    });
  });
}

// A request, with how long its answer took; `stream` keeps reading an event stream for `ms`.
export function get(url, { method = "GET", body, headers = {}, stream } = {}) {
  const t0 = Date.now();
  return new Promise((ok, fail) => {
    const req = http.request(url, { method, headers: { ...headers, ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}) } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      const done = () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        ok({ status: res.statusCode, type: res.headers["content-type"], text, json, ms: Date.now() - t0 });
      };
      if (stream) {
        setTimeout(() => {
          done();
          req.destroy();
        }, stream);
        res.on("error", () => {});
      } else {
        res.on("end", done);
        res.on("error", fail);
      }
    });
    req.on("error", fail);
    req.end(body);
  });
}

// waits up to `ms` for `fn()` to be true
export async function until(fn, ms = 2000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(20)) if (fn()) return true;
  return fn();
}

// prod.mjs as a child process with `env` (no NEAR Intents, an empty dist), on its own port
export async function prodServer(env, port = () => 0) {
  const dist = mkdtempSync(join(tmpdir(), "ferry-dist-"));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./prod.mjs", import.meta.url))], {
    env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: String(port()), DIST: dist, FERRY_NEAR_QUOTES: "0", ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const url = await new Promise((ok, fail) => {
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
      const m = out.match(/ferry-ui on (http:\/\/[\d.]+:\d+)/);
      if (m) ok(m[1]);
    });
    child.on("exit", (code) => fail(new Error(`prod.mjs exited (${code})`)));
  });
  return {
    url,
    // this child only, by its handle; a SIGKILL if it hasn't gone in a second
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const gone = new Promise((ok) => child.on("exit", ok));
        child.kill("SIGTERM");
        const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
        await gone;
        clearTimeout(kill);
      }
      rmSync(dist, { recursive: true, force: true });
    },
  };
}
