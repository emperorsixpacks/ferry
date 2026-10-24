import test from "node:test";
import assert from "node:assert/strict";
import { sseTransform } from "./sse.mjs";

test("messages pass whole, rewritten by name, and dropped ones leave nothing", () => {
  const t = sseTransform({ rewrite: { status: (s) => ({ ...s, max: Math.min(s.max, 5) }) }, drop: ["withdrawal"] });
  const stream =
    ": connected\n\n" +
    'event: status\ndata: {"max":9}\n\n' +
    'event: withdrawal\ndata: {"to":"u1secret","amount":"5"}\n\n' +
    'event: swap\ndata: {"id":"ab"}\n\n';
  // fed in awkward pieces, as a socket would
  let out = "";
  for (let i = 0; i < stream.length; i += 7) out += t(stream.slice(i, i + 7));
  assert.equal(out, ': connected\n\nevent: status\ndata: {"max":5}\n\nevent: swap\ndata: {"id":"ab"}\n\n');
  assert.ok(!out.includes("u1secret"));
});

test("a message is held until it ends, and CRLF streams work", () => {
  const t = sseTransform({ drop: ["withdrawal"] });
  assert.equal(t("event: withdrawal\r\ndata: {}"), "");
  assert.equal(t("\r\n\r\nevent: status\r\n"), "");
  assert.equal(t('data: {"a":1}\r\n\r\n'), 'event: status\ndata: {"a":1}\n\n');
});

test("nothing dropped: the stream as it was", () => {
  const t = sseTransform();
  const s = 'event: withdrawal\ndata: {"id":"w1"}\n\n: ping\n\n';
  assert.equal(t(s), s);
});
