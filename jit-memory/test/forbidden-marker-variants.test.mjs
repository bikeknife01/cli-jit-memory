// Item #3: capture must reject HTML-comment marker variants whose normalised
// inner label matches a known managed marker, not just exact static strings.
// Otherwise content like `<!--QR:BEGIN-->` (no spaces) gets accepted at write
// time but later flagged malformed by classifyMarkerPair, locking the QR/KB
// block and refusing all future captures into it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = await mkdtemp(join(tmpdir(), "jitmem-marker-variants-"));
process.env.JITMEM_EXT_ROOT = tmp;
process.env.JITMEM_INSTRUCTIONS_MD = join(tmp, "copilot-instructions.md");
await mkdir(join(tmp, "knowledge"), { recursive: true });
await writeFile(process.env.JITMEM_INSTRUCTIONS_MD,
  "<!-- QR:BEGIN -->\n<!-- QR:END -->\n<!-- KB:BEGIN -->\n<!-- KB:END -->\n", "utf8");

const { capture, refreshForbiddenMarkers } = await import("../lib/capture.mjs");
await refreshForbiddenMarkers();

const VARIANTS = [
  // No internal whitespace.
  "<!--QR:BEGIN-->",
  "<!--QR:END-->",
  "<!--KB:BEGIN-->",
  "<!--KB:END-->",
  // Lowercase / mixed case.
  "<!-- qr:begin -->",
  "<!-- Qr:Begin -->",
  // Extra whitespace including newlines.
  "<!--   QR:BEGIN   -->",
  "<!--\nQR:BEGIN\n-->",
  // efficiency-retro variants.
  "<!--efficiency-retro:managed-start-->",
  "<!-- efficiency-retro:managed-end attr=foo -->"
];

for (const variant of VARIANTS) {
  test(`capture rejects forbidden marker variant: ${JSON.stringify(variant)}`, async () => {
    const r = await capture({
      kind: "domain_new",
      domain: "test-marker-variant-domain",
      summary: "test",
      tags: ["alpha", "beta"],
      content: `lesson body containing ${variant} should be rejected`
    });
    assert.equal(r.status, "invalid", `expected invalid for variant ${variant}, got ${r.status}: ${r.summary}`);
    assert.match(r.summary || "", /forbidden marker|managed.*marker/i,
      `expected forbidden-marker summary, got: ${r.summary}`);
  });
}

test("capture rejects forbidden marker variant inside tags array", async () => {
  const r = await capture({
    kind: "domain_new",
    domain: "another-test-domain",
    summary: "test",
    tags: ["alpha", "<!--KB:END-->"],
    content: "clean body"
  });
  assert.equal(r.status, "invalid");
});

test("capture still accepts plain content with no markers", async () => {
  const r = await capture({
    kind: "domain_new",
    domain: "clean-test-domain",
    summary: "test",
    tags: ["alpha", "gamma"],
    content: "completely clean lesson body without any HTML comments"
  });
  assert.equal(r.status, "ok", `unexpected status: ${r.status} / ${r.summary}`);
});
