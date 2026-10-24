// How long the UI servers (server/prod.mjs and the Vite dev server) wait for a daemon or the router
// before they answer for it. Plain Node.
//
// One daemon that hangs instead of failing (a lock held through slow work, a node still loading its
// block index, a slow RPC) must not hold up the page, which asks every pair's daemons for their
// status. So every request through the proxies gets an answer in bounded time: past its limit the
// browser gets a 504 {"error": "...", "code": "timeout"}, and the request to the daemon is destroyed,
// which closes its socket, so nothing is left waiting on either side.
//
//   READ_MS   10 s for a read (GET, HEAD), headers and body. ferryd answers its reads from memory (its
//             status is cached, GET /api/swaps copies its list), in milliseconds, so a read still
//             unanswered after seconds means the daemon is stuck. 10 s is the bound prod.mjs's own
//             status checks use (daemonJson), and ferryd's on its calls to its partner; the page asks
//             again only once its last ask is answered, so a stuck daemon never has more than one of
//             the page's polls waiting on it.
//   An event stream (GET /api/events, text/event-stream) gets READ_MS to answer, and no limit after
//             that: it is long-lived by design.
//   START_MS  120 s for anything else: a POST, i.e. a swap start (or a withdrawal on the person's own
//             node, or a fault). ferryd bounds each wait of a start on someone else, its partner's
//             offer (10 s) and the partner's Accept (60 s, PROPOSE_TIMEOUT), so a start it will finish
//             answers well inside 120 s, which is also what ferry-route gives its own starts on the
//             daemons. Past it the daemon is stuck on its own wallet or state, and giving up there is
//             safe: ferryd saves a swap before anything moves funds (its words: a caller that gives up
//             on this request can't orphan it) and records a withdrawal before it broadcasts it.

export const READ_MS = 10_000;
export const START_MS = 120_000;

export const TIMEOUT_TEXT = "The daemon didn't answer in time.";
export const ROUTER_TIMEOUT_TEXT = "The private swap service didn't answer in time.";

// The limit for a request: READ_MS for a read, START_MS for anything else.
export const limitFor = (method, { read = READ_MS, start = START_MS } = {}) => (method === "GET" || method === "HEAD" ? read : start);

// The 504 itself, as plain JSON (prod.mjs adds its security headers through its own `answer`).
export function timeoutAnswer(error = TIMEOUT_TEXT) {
  return (res) => {
    res.writeHead(504, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error, code: "timeout" }));
  };
}

// The error the request to the daemon is destroyed with: one line, for the dev server's log.
function timeoutError(ms) {
  const e = new Error(`the daemon didn't answer within ${ms} ms; answered 504`);
  e.code = "FERRY_TIMEOUT";
  e.stack = `Error: ${e.message}`;
  return e;
}

// Gives `up`, the request to the daemon (an http.ClientRequest), `ms` to finish; `res` is the
// browser's response. Past it: `answer(res)` (the 504) when nothing was sent yet, else the response is
// cut short, as a daemon dying mid-answer cuts it; and `up` is destroyed (its socket closes), with
// `up.ferryTimedOut` set so the proxy's error handler knows the browser has had its answer. An event
// stream stops the clock once its headers arrive. Returns a function that stops the clock.
export function deadline(up, res, { ms, answer = timeoutAnswer() }) {
  let timer = setTimeout(() => {
    timer = null;
    up.ferryTimedOut = true;
    if (!res.headersSent) answer(res);
    else if (!res.writableEnded) res.destroy();
    up.destroy(timeoutError(ms));
  }, ms);
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  up.on("response", (r) => {
    if (String(r.headers["content-type"] ?? "").startsWith("text/event-stream")) stop();
    else r.on("end", stop);
  });
  up.on("close", stop);
  res.on("close", stop);
  return stop;
}
