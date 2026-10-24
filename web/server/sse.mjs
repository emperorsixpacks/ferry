// Server-sent events through the UI server (server/prod.mjs), message by message. Plain Node.
//
// A daemon's or the router's stream is passed on with some messages' data rewritten (the demo's
// limits in a daemon's status, the router's views without partner URLs) and, for a browser that
// doesn't own the node, some dropped altogether: a daemon's `event: withdrawal` says what its owner
// sent and where, which a public demo's visitors must never see (server/own.mjs).
//
// sseTransform({rewrite: {name: fn}, drop: [names]}) returns a function that takes the stream's text
// as it arrives and returns what to pass on. A message (its lines up to a blank line) goes out
// whole once it has ended, so a dropped one leaves nothing behind; comments (": ping") pass as they
// are. Lines end in \n, \r\n or \r, as the SSE format allows; what goes out uses \n.
export function sseTransform({ rewrite = {}, drop = [] } = {}) {
  let buf = "";
  let lines = [];
  const flush = () => {
    const msg = lines;
    lines = [];
    const name = msg.find((l) => l.startsWith("event:"))?.slice(6).trim() ?? "message";
    if (drop.includes(name)) return "";
    const fn = rewrite[name];
    const out = fn
      ? msg.map((l) => {
          if (!l.startsWith("data:")) return l;
          try {
            return "data: " + JSON.stringify(fn(JSON.parse(l.slice(5))));
          } catch {
            return l;
          }
        })
      : msg;
    return out.join("\n") + "\n\n";
  };
  return (chunk) => {
    buf += chunk;
    let out = "";
    let m;
    while ((m = /\r\n|\n|\r(?!$)/.exec(buf))) {
      const line = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      if (line === "") out += lines.length ? flush() : "";
      else lines.push(line);
    }
    return out;
  };
}
