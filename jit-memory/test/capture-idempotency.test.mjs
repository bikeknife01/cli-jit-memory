// Item #4: capture is idempotent for quick_rule, domain_update, and
// disputed. A retry of the same content returns ok with unchanged:true and
// does not duplicate a line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = await mkdtemp(join(tmpdir(), "jitmem-idempotent-"));
process.env.JITMEM_EXT_ROOT = tmp;
process.env.JITMEM_INSTRUCTIONS_MD = join(tmp, "copilot-instructions.md");
await mkdir(join(tmp, "knowledge"), { recursive: true });
await writeFile(process.env.JITMEM_INSTRUCTIONS_MD,
  "<!-- QR:BEGIN -->\n<!-- QR:END -->\n<!-- KB:BEGIN -->\n<!-- KB:END -->\n", "utf8");

const { capture, refreshForbiddenMarkers } = await import("../lib/capture.mjs");
await refreshForbiddenMarkers();

test("quick_rule retry is idempotent (unchanged:true, no duplicate)", async () => {
  const r1 = await capture({ kind: "quick_rule", content: "tabs vs spaces: tabs cause yaml issues -> always use spaces" });
  assert.equal(r1.status, "ok");
  assert.notEqual(r1.unchanged, true);
  const r2 = await capture({ kind: "quick_rule", content: "tabs vs spaces: tabs cause yaml issues -> always use spaces" });
  assert.equal(r2.status, "ok");
  assert.equal(r2.unchanged, true, `expected unchanged:true on retry, got ${JSON.stringify(r2)}`);
  // Only one rule line in instructions file.
  const txt = await readFile(process.env.JITMEM_INSTRUCTIONS_MD, "utf8");
  const rule = "tabs vs spaces: tabs cause yaml issues -> always use spaces";
  const occurrences = txt.split(rule).length - 1;
  assert.equal(occurrences, 1, `expected exactly 1 occurrence, got ${occurrences}`);
});

test("quick_rule retry is case-insensitive duplicate detection", async () => {
  const r1 = await capture({ kind: "quick_rule", content: "FOO bar baz qux distinct rule" });
  assert.equal(r1.status, "ok");
  const r2 = await capture({ kind: "quick_rule", content: "foo BAR baz qux distinct rule" });
  assert.equal(r2.status, "ok");
  assert.equal(r2.unchanged, true);
});

test("domain_update retry is idempotent", async () => {
  const seedDomain = "idempotent-domain";
  await capture({
    kind: "domain_new",
    domain: seedDomain,
    summary: "test",
    tags: ["alpha", "beta"],
    content: "first lesson"
  });
  const r1 = await capture({ kind: "domain_update", domain: seedDomain, section: "working", content: "second lesson body unique" });
  assert.equal(r1.status, "ok");
  assert.notEqual(r1.unchanged, true);
  const r2 = await capture({ kind: "domain_update", domain: seedDomain, section: "working", content: "second lesson body unique" });
  assert.equal(r2.status, "ok");
  assert.equal(r2.unchanged, true);
  const file = join(tmp, "knowledge", `${seedDomain}.md`);
  const body = await readFile(file, "utf8");
  const occurrences = body.split("second lesson body unique").length - 1;
  assert.equal(occurrences, 1);
});

test("disputed retry is idempotent (matches content ignoring date)", async () => {
  const seedDomain = "disputed-idem-domain";
  await capture({
    kind: "domain_new",
    domain: seedDomain,
    summary: "test",
    tags: ["alpha", "beta"],
    content: "seed"
  });
  const r1 = await capture({ kind: "disputed", domain: seedDomain, content: "tried X got Y workaround Z" });
  assert.equal(r1.status, "ok");
  assert.notEqual(r1.unchanged, true);
  const r2 = await capture({ kind: "disputed", domain: seedDomain, content: "tried X got Y workaround Z" });
  assert.equal(r2.status, "ok");
  assert.equal(r2.unchanged, true);
  const file = join(tmp, "knowledge", `${seedDomain}.md`);
  const body = await readFile(file, "utf8");
  const occurrences = body.split("tried X got Y workaround Z").length - 1;
  assert.equal(occurrences, 1);
});
