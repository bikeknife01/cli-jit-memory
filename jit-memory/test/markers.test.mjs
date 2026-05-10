import { test } from "node:test";
import assert from "node:assert/strict";

const { classifyMarkerPair } = await import("../lib/markers.mjs");

test("classifyMarkerPair preserves exact-only semantics for non-comment markers", () => {
  assert.equal(classifyMarkerPair("x\n<<<BEGIN>>>\nbody\n<<<END>>>\n", "<<<BEGIN>>>", "<<<END>>>"), "ok");
  assert.equal(classifyMarkerPair("x\n<<<BEGIN>>>\nbody\n", "<<<BEGIN>>>", "<<<END>>>"), "malformed");
});

test("classifyMarkerPair treats zero-whitespace marker comments as malformed variants", () => {
  assert.equal(
    classifyMarkerPair("x\n<!--QR:BEGIN-->\nbody\n<!-- QR:END -->\n", "<!-- QR:BEGIN -->", "<!-- QR:END -->"),
    "malformed"
  );
  assert.equal(
    classifyMarkerPair("x\n<!--\nQR:BEGIN\n-->\nbody\n<!-- QR:END -->\n", "<!-- QR:BEGIN -->", "<!-- QR:END -->"),
    "malformed"
  );
});

test("classifyMarkerPair rejects reversed exact markers", () => {
  assert.equal(
    classifyMarkerPair("x\n<!-- TEST:END -->\nbody\n<!-- TEST:BEGIN -->\n", "<!-- TEST:BEGIN -->", "<!-- TEST:END -->"),
    "malformed"
  );
});
