// Item #11: at_cap returns existing rules ranked oldest-first with
// addedAt metadata so the agent has a defensible demote target.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = await mkdtemp(join(tmpdir(), "jitmem-qr-rank-"));
process.env.JITMEM_EXT_ROOT = tmp;
process.env.JITMEM_INSTRUCTIONS_MD = join(tmp, "copilot-instructions.md");
await mkdir(join(tmp, "knowledge"), { recursive: true });
await writeFile(process.env.JITMEM_INSTRUCTIONS_MD,
  "<!-- jit-memory:QR:BEGIN -->\n<!-- jit-memory:QR:END -->\n<!-- jit-memory:KB:BEGIN -->\n<!-- jit-memory:KB:END -->\n", "utf8");

const { capture, refreshForbiddenMarkers } = await import("../lib/capture.mjs");
await refreshForbiddenMarkers();

test("at_cap returns existing rules with addedAt metadata, oldest-first", async () => {
  // Fill QR to cap (10).
  for (let i = 0; i < 10; i++) {
    const r = await capture({ kind: "quick_rule", content: `rule number ${i} unique-token-${i}` });
    assert.equal(r.status, "ok");
  }
  // Hand-edit one entry's addedAt back in time via the sidecar so we can
  // assert the rank order is by addedAt.
  const sidecarPath = join(tmp, "knowledge", "_qr-meta.json");
  const meta = JSON.parse(await readFile(sidecarPath, "utf8"));
  assert.ok(Array.isArray(meta.rules));
  assert.equal(meta.rules.length, 10);
  // Backdate the FIRST rule (rule number 0) to 2020-01-01.
  const oldest = meta.rules.find(r => r.hash.includes("rule number 0"));
  assert.ok(oldest);
  oldest.addedAt = "2020-01-01";
  await writeFile(sidecarPath, JSON.stringify(meta, null, 2));

  const r = await capture({ kind: "quick_rule", content: "11th rule that pushes us over cap" });
  assert.equal(r.status, "at_cap");
  assert.ok(Array.isArray(r.existing));
  assert.equal(r.existing.length, 10);
  // Each entry has rule + addedAt fields.
  for (const e of r.existing) {
    assert.ok(typeof e.rule === "string");
    assert.ok(e.addedAt === null || /^\d{4}-\d{2}-\d{2}$/.test(e.addedAt));
  }
  // Oldest is first.
  assert.equal(r.existing[0].addedAt, "2020-01-01");
  assert.match(r.existing[0].rule, /unique-token-0/);
});

test("successful capture stamps addedAt for the new rule and reports demoted line", async () => {
  // Pick demote_target = "unique-token-1" and add a 12th rule.
  const r = await capture({
    kind: "quick_rule",
    content: "12th rule replaces the demoted one",
    demote_target: "unique-token-1"
  });
  assert.equal(r.status, "ok");
  assert.match(r.demoted || "", /unique-token-1/);
  // Sidecar now has metadata for the newly-added 12th rule.
  const meta = JSON.parse(await readFile(join(tmp, "knowledge", "_qr-meta.json"), "utf8"));
  assert.ok(meta.rules.some(r => r.hash.includes("12th rule replaces")));
});
