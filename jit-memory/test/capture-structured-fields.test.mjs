// Item 3: Tests for structured capture fields: `context` and `failed_attempt`.
// Also tests the generalised redaction scan over all string fields.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = await mkdtemp(join(tmpdir(), "jitmem-structured-"));
process.env.JITMEM_EXT_ROOT = tmp;
process.env.JITMEM_INSTRUCTIONS_MD = join(tmp, "copilot-instructions.md");
await mkdir(join(tmp, "knowledge"), { recursive: true });
await writeFile(
  process.env.JITMEM_INSTRUCTIONS_MD,
  "<!-- QR:BEGIN -->\n<!-- QR:END -->\n<!-- KB:BEGIN -->\n<!-- KB:END -->\n",
  "utf8"
);

const { capture, refreshForbiddenMarkers } = await import("../lib/capture.mjs");
await refreshForbiddenMarkers();

// ── domain_new with context ────────────────────────────────────────────────

test("domain_new: context field rendered as italicized paragraph", async () => {
  const r = await capture({
    kind: "domain_new",
    domain: "ctx-only-domain",
    summary: "context test summary",
    tags: ["ctx"],
    content: "always use TLS",
    context: "Production deployments only"
  });
  assert.equal(r.status, "ok");
  const text = await readFile(r.file, "utf8");
  assert.match(text, /_Production deployments only_/, "context should be italic paragraph");
  // context must appear before Working section
  const ctxIdx = text.indexOf("_Production deployments only_");
  const wrkIdx = text.indexOf("## ✅ Working");
  assert.ok(ctxIdx < wrkIdx, "context paragraph should precede ## Working section");
});

// ── domain_new with failed_attempt ────────────────────────────────────────

test("domain_new: failed_attempt field written to Broken section", async () => {
  const r = await capture({
    kind: "domain_new",
    domain: "broken-new-domain",
    summary: "broken field test",
    tags: ["broken"],
    content: "use mutex for concurrency",
    failed_attempt: "spinlock caused deadlock under high contention"
  });
  assert.equal(r.status, "ok");
  const text = await readFile(r.file, "utf8");
  assert.match(text, /## ❌ Broken \/ Don't try/, "Broken section header should exist");
  assert.match(text, /spinlock caused deadlock under high contention/);
  // Broken section must appear after Working section
  const brokenIdx = text.indexOf("## ❌ Broken");
  const wrkIdx = text.indexOf("## ✅ Working");
  assert.ok(wrkIdx < brokenIdx, "Working section should precede Broken section");
  // Disputed should still be present and after Broken
  const dispIdx = text.indexOf("## Disputed");
  assert.ok(dispIdx > brokenIdx, "Disputed section should follow Broken section");
});

// ── domain_new with both context and failed_attempt ───────────────────────

test("domain_new: context and failed_attempt together produce correct structure", async () => {
  const r = await capture({
    kind: "domain_new",
    domain: "both-fields-domain",
    summary: "both structured fields",
    tags: ["full"],
    content: "prefer streaming over buffered reads",
    context: "Large file processing (>100MB)",
    failed_attempt: "reading entire file into memory caused OOM"
  });
  assert.equal(r.status, "ok");
  const text = await readFile(r.file, "utf8");
  assert.match(text, /_Large file processing/);
  assert.match(text, /prefer streaming over buffered reads/);
  assert.match(text, /## ❌ Broken/);
  assert.match(text, /reading entire file into memory caused OOM/);
  const order = [
    text.indexOf("_Large file processing"),
    text.indexOf("## ✅ Working"),
    text.indexOf("## ❌ Broken"),
    text.indexOf("## Disputed")
  ];
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i] > order[i - 1], `section ${i} out of order`);
  }
});

// ── domain_new without structured fields (backward compat) ────────────────

test("domain_new: omitting context and failed_attempt works as before", async () => {
  const r = await capture({
    kind: "domain_new",
    domain: "compat-domain",
    summary: "backward compat check",
    tags: ["compat"],
    content: "use explicit error types"
  });
  assert.equal(r.status, "ok");
  const text = await readFile(r.file, "utf8");
  assert.match(text, /## ✅ Working/);
  assert.match(text, /use explicit error types/);
  // No Broken section injected if not provided
  assert.doesNotMatch(text, /## ❌ Broken/, "Broken section should not appear without failed_attempt");
});

// ── domain_update with failed_attempt ─────────────────────────────────────

test("domain_update: failed_attempt appended to Broken section atomically", async () => {
  // Seed a domain (no Broken section yet)
  const r0 = await capture({
    kind: "domain_new",
    domain: "update-broken-domain",
    summary: "update broken field test",
    tags: ["upd"],
    content: "initial working lesson"
  });
  assert.equal(r0.status, "ok");

  const r1 = await capture({
    kind: "domain_update",
    domain: "update-broken-domain",
    content: "second working lesson",
    failed_attempt: "using raw SQL without parameterization caused injection"
  });
  assert.equal(r1.status, "ok");
  assert.match(r1.summary, /failed_attempt/);

  const text = await readFile(r1.file, "utf8");
  assert.match(text, /## ❌ Broken/);
  assert.match(text, /using raw SQL without parameterization caused injection/);
  assert.match(text, /second working lesson/);
});

test("domain_update: failed_attempt appended to existing Broken section", async () => {
  // Seed a domain WITH an existing Broken section
  const r0 = await capture({
    kind: "domain_new",
    domain: "update-existing-broken",
    summary: "domain with pre-existing broken",
    tags: ["upd"],
    content: "initial lesson",
    failed_attempt: "first failed attempt"
  });
  assert.equal(r0.status, "ok");

  const r1 = await capture({
    kind: "domain_update",
    domain: "update-existing-broken",
    content: "second lesson",
    failed_attempt: "second failed attempt"
  });
  assert.equal(r1.status, "ok");

  const text = await readFile(r1.file, "utf8");
  assert.match(text, /first failed attempt/);
  assert.match(text, /second failed attempt/);
  // Both bullets in same Broken section
  const brokenIdx = text.indexOf("## ❌ Broken");
  const afterBroken = text.slice(brokenIdx);
  assert.match(afterBroken, /first failed attempt[\s\S]*second failed attempt/);
});

test("domain_update: omitting failed_attempt leaves Broken section untouched", async () => {
  const r0 = await capture({
    kind: "domain_new",
    domain: "update-no-broken",
    summary: "no broken on update",
    tags: ["upd"],
    content: "initial lesson"
  });
  assert.equal(r0.status, "ok");

  const r1 = await capture({
    kind: "domain_update",
    domain: "update-no-broken",
    content: "second lesson"
  });
  assert.equal(r1.status, "ok");
  const text = await readFile(r1.file, "utf8");
  assert.doesNotMatch(text, /## ❌ Broken/);
});

test("domain_update: new failed_attempt is NOT dropped when content is dup", async () => {
  const r0 = await capture({
    kind: "domain_new",
    domain: "dup-content-new-failed",
    summary: "dup content + new failed edge case",
    tags: ["edge"],
    content: "use explicit types"
  });
  assert.equal(r0.status, "ok");

  // Same content as above (dup), but a new failed_attempt
  const r1 = await capture({
    kind: "domain_update",
    domain: "dup-content-new-failed",
    content: "use explicit types",
    failed_attempt: "implicit types caused runtime errors in prod"
  });
  assert.equal(r1.status, "ok");
  assert.notEqual(r1.unchanged, true, "should NOT be unchanged — failed_attempt was new");

  const text = await readFile(r1.file, "utf8");
  assert.match(text, /## ❌ Broken/);
  assert.match(text, /implicit types caused runtime errors in prod/);
  // Content bullet should appear only once
  const contentCount = (text.match(/use explicit types/g) || []).length;
  assert.equal(contentCount, 1);
});

test("domain_update: unchanged when both content and failed_attempt are dups", async () => {
  const r0 = await capture({
    kind: "domain_new",
    domain: "all-dup-domain",
    summary: "all dup test",
    tags: ["dup"],
    content: "use explicit types",
    failed_attempt: "implicit types failed"
  });
  assert.equal(r0.status, "ok");

  const r1 = await capture({
    kind: "domain_update",
    domain: "all-dup-domain",
    content: "use explicit types",
    failed_attempt: "implicit types failed"
  });
  assert.equal(r1.status, "ok");
  assert.equal(r1.unchanged, true, "both fields dup — should be unchanged");
});

test("domain_update: repeated failed_attempt is idempotent (no duplicate bullet)", async () => {
  const r0 = await capture({
    kind: "domain_new",
    domain: "update-idem-broken",
    summary: "idempotency test for failed_attempt",
    tags: ["idem"],
    content: "initial lesson"
  });
  assert.equal(r0.status, "ok");

  const r1 = await capture({
    kind: "domain_update",
    domain: "update-idem-broken",
    content: "second lesson",
    failed_attempt: "tried approach X, got error Y"
  });
  assert.equal(r1.status, "ok");

  // Same failed_attempt again — should not duplicate
  const r2 = await capture({
    kind: "domain_update",
    domain: "update-idem-broken",
    content: "third lesson",
    failed_attempt: "tried approach X, got error Y"
  });
  assert.equal(r2.status, "ok");

  const text = await readFile(r1.file, "utf8");
  const count = (text.match(/tried approach X, got error Y/g) || []).length;
  assert.equal(count, 1, `failed_attempt should appear exactly once, got ${count}`);
});



test("redaction: context field containing token is blocked", async () => {
  const r = await capture({
    kind: "domain_new",
    domain: "redact-context-domain",
    summary: "clean summary",
    tags: ["sec"],
    content: "clean content",
    context: "Use token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA for auth"
  });
  assert.equal(r.status, "needs_redaction", `expected needs_redaction, got ${r.status}`);
});

test("redaction: failed_attempt field containing password is blocked", async () => {
  const r = await capture({
    kind: "domain_new",
    domain: "redact-failed-domain",
    summary: "clean summary",
    tags: ["sec"],
    content: "clean content",
    failed_attempt: "tried Password=hunter2 in the connection string"
  });
  assert.equal(r.status, "needs_redaction", `expected needs_redaction, got ${r.status}`);
});
