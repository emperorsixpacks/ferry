// The proxies' time limits (upstream.mjs): the helper on its own, then prod.mjs itself, run as a child
// process in front of a fake daemon (testing.mjs; TEST_PORT_BASE+0 on for its ports, when set).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fakeDaemon as fake, get, ports, prodServer as prod, until } from "./testing.mjs";
import { READ_MS, START_MS, deadline, limitFor, timeoutAnswer } from "./upstream.mjs";

const port = ports(0);
const LIMIT = 300;
const fakeDaemon = (routes) => fake(routes, port);

// ------------------------------------------------------------------------------------------------
// the helper

// A proxy in front of `target` with the deadline, as prod.mjs and the dev server use it.
function proxyTo(target, ms) {
  const server = http.createServer((req, res) => {
    const up = http.request(new URL(req.url, target), { method: req.method }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    deadline(up, res, { ms: ms ?? limitFor(req.method, { read: LIMIT, start: LIMIT * 4 }), answer: timeoutAnswer() });
    up.on("error", () => {
      if (up.ferryTimedOut) return;
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    res.on("close", () => up.destroy());
    up.end();
  });
  return new Promise((ok) => server.listen(port(), "127.0.0.1", () => ok({ url: `http://127.0.0.1:${server.address().port}`, close: () => (server.closeAllConnections(), server.close()) })));
}

test("the limits: reads 10 s, everything else 120 s", () => {
  assert.equal(READ_MS, 10_000);
  assert.equal(START_MS, 120_000);
  assert.equal(limitFor("GET"), READ_MS);
  assert.equal(limitFor("HEAD"), READ_MS);
  assert.equal(limitFor("POST"), START_MS);
  assert.equal(limitFor("GET", { read: 5 }), 5);
});

test("a daemon that never answers: 504 within the limit, and its socket is closed", async () => {
  const daemon = await fakeDaemon({ "GET /api/status": () => {} });
  const proxy = await proxyTo(daemon.url);
  after(() => (proxy.close(), daemon.close()));
  const r = await get(proxy.url + "/api/status");
  assert.equal(r.status, 504);
  assert.deepEqual(r.json, { error: "The daemon didn't answer in time.", code: "timeout" });
  assert.ok(r.ms >= LIMIT - 20 && r.ms < LIMIT + 1000, `answered in ${r.ms} ms`);
  assert.ok(await until(() => daemon.open() === 0), "the socket to the daemon is closed");
});

test("an answer in time passes, and one that stalls mid-body is cut", async () => {
  const daemon = await fakeDaemon({
    "GET /api/swaps": (_, res) => setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end("[]"), LIMIT / 2),
    "GET /api/status": (_, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"role":');
    },
  });
  const proxy = await proxyTo(daemon.url);
  after(() => (proxy.close(), daemon.close()));
  const ok = await get(proxy.url + "/api/swaps");
  assert.equal(ok.status, 200);
  assert.equal(ok.text, "[]");
  await assert.rejects(get(proxy.url + "/api/status"), "a body that stops coming is cut, as a daemon dying mid-answer cuts it");
  assert.ok(await until(() => daemon.open() === 0), "the socket to the daemon is closed");
});

test("an event stream has the limit to start, and none once it has", async () => {
  const daemon = await fakeDaemon({
    "GET /api/events": (_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      setTimeout(() => res.write("event: status\ndata: {}\n\n"), LIMIT * 3);
    },
    "GET /api/stuck": () => {},
  });
  const proxy = await proxyTo(daemon.url);
  after(() => (proxy.close(), daemon.close()));
  const live = await get(proxy.url + "/api/events", { stream: LIMIT * 4 });
  assert.equal(live.status, 200);
  assert.match(live.text, /event: status/, "still open past the limit, and the event arrived");
  const stuck = await get(proxy.url + "/api/stuck");
  assert.equal(stuck.status, 504);
});

test("a POST gets the longer limit", async () => {
  const daemon = await fakeDaemon({ "POST /api/swaps": (_, res) => setTimeout(() => res.writeHead(201, { "content-type": "application/json" }).end('{"id":"ab"}'), LIMIT * 2) });
  const proxy = await proxyTo(daemon.url);
  after(() => (proxy.close(), daemon.close()));
  const r = await get(proxy.url + "/api/swaps", { method: "POST" });
  assert.equal(r.status, 201, "a start slower than a read's limit is not cut");
});

// ------------------------------------------------------------------------------------------------
// prod.mjs: its daemon and router proxies, with the guard in front

// prod.mjs with short limits: reads LIMIT, starts four times that
const prodServer = (env) => prod({ FERRY_READ_TIMEOUT_MS: String(LIMIT), FERRY_START_TIMEOUT_MS: String(LIMIT * 4), ...env }, port);

test("prod.mjs: a hung daemon's reads get 504 in time, its sockets close, and streams and starts still work", async () => {
  let swapsAsked = 0;
  const daemon = await fakeDaemon({
    "GET /api/status": () => {},
    "GET /api/swaps": () => swapsAsked++,
    "GET /api/events": (_, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": connected\n\n");
      setTimeout(() => res.write('event: status\ndata: {"offer":{"max_zat":900000000}}\n\n'), LIMIT * 2);
    },
    "POST /api/swaps": (req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () =>
        setTimeout(() => {
          const zat = JSON.parse(body).zec_zat;
          // the busy mapping still applies: ferryd's 409 busy, said as the browser says it
          if (zat === 20_000_000) res.writeHead(409, { "content-type": "application/json" }).end('{"error":"busy: full","code":"busy"}');
          else res.writeHead(201, { "content-type": "application/json" }).end('{"id":"ab"}');
        }, LIMIT * 2),
      );
    },
  });
  const ui = await prodServer({ FERRY_Z_URL: daemon.url, FERRY_B_URL: daemon.url, DEMO_MAX_ZAT: "50000000" });
  after(async () => (await ui.close(), daemon.close()));

  const status = await get(ui.url + "/daemon/z/api/status");
  assert.equal(status.status, 504);
  assert.equal(status.json.code, "timeout");
  assert.equal(status.json.error, "The daemon didn't answer in time.");
  assert.ok(status.ms >= LIMIT - 20 && status.ms < LIMIT + 1000, `answered in ${status.ms} ms`);
  const swaps = await get(ui.url + "/daemon/b/api/swaps");
  assert.equal(swaps.status, 504);
  assert.equal(swapsAsked, 1);
  assert.ok(await until(() => daemon.open() === 0), "no socket to the daemon is left open");

  // the event stream outlives the limit, with the demo's cap on the offer (clampOffer)
  const events = await get(ui.url + "/daemon/z/api/events", { stream: LIMIT * 4 });
  assert.equal(events.status, 200);
  assert.match(events.text, /"max_zat":50000000/);

  // a swap start slower than a read's limit goes through; busy is still said plainly
  const start = await get(ui.url + "/daemon/z/api/swaps", { method: "POST", body: '{"zec_zat":10000000}' });
  assert.equal(start.status, 201);
  const busy = await get(ui.url + "/daemon/z/api/swaps", { method: "POST", body: '{"zec_zat":20000000}' });
  assert.equal(busy.status, 409);
  assert.equal(busy.json.code, "busy");
  assert.match(busy.json.error, /^Every partner is busy right now/);

  // the guard is in front of all of it: the demo's cap, and no withdrawals or addresses on a public demo
  const big = await get(ui.url + "/daemon/z/api/swaps", { method: "POST", body: '{"zec_zat":60000000}' });
  assert.equal(big.status, 400);
  assert.equal((await get(ui.url + "/daemon/z/api/addresses")).status, 403);
  assert.equal((await get(ui.url + "/daemon/z/api/withdraw", { method: "POST", body: "{}" })).status, 403);
});

test("prod.mjs: a stream that never starts, and a start that never ends, get 504", async () => {
  const daemon = await fakeDaemon({ "GET /api/events": () => {}, "POST /api/swaps": () => {} });
  const ui = await prodServer({ FERRY_Z_URL: daemon.url, FERRY_B_URL: daemon.url });
  after(async () => (await ui.close(), daemon.close()));
  const events = await get(ui.url + "/daemon/z/api/events");
  assert.equal(events.status, 504);
  assert.ok(events.ms < LIMIT + 1000);
  const start = await get(ui.url + "/daemon/z/api/swaps", { method: "POST", body: '{"zec_zat":10000000}' });
  assert.equal(start.status, 504);
  assert.ok(start.ms >= LIMIT * 4 - 20 && start.ms < LIMIT * 4 + 1000, `a start waits its own, longer limit (${start.ms} ms)`);
  assert.ok(await until(() => daemon.open() === 0), "no socket to the daemon is left open");
});

test("prod.mjs: the router's reads get the same limit", async () => {
  const router = await fakeDaemon({ "GET /api/routes": () => {}, "GET /api/status": (_, res) => res.writeHead(200, { "content-type": "application/json" }).end("{}") });
  const daemon = await fakeDaemon({});
  const ui = await prodServer({ FERRY_Z_URL: daemon.url, FERRY_B_URL: daemon.url, FERRY_ROUTER_URL: router.url });
  after(async () => (await ui.close(), daemon.close(), router.close()));
  const r = await get(ui.url + "/router/api/routes");
  assert.equal(r.status, 504);
  assert.equal(r.json.error, "The private swap service didn't answer in time.");
  assert.ok(await until(() => router.open() === 0));
});
