// Item #8: jit_memory_deprecate (graceful) and jit_memory_delete (immediate).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = await mkdtemp(join(tmpdir(), "jitmem-retire-"));
process.env.JITMEM_EXT_ROOT = tmp;
process.env.JITMEM_INSTRUCTIONS_MD = join(tmp, "copilot-instructions.md");
await mkdir(join(tmp, "knowledge"), { recursive: true });
await writeFile(process.env.JITMEM_INSTRUCTIONS_MD,
  "<!-- QR:BEGIN -->\n<!-- QR:END -->\n<!-- KB:BEGIN -->\n<!-- KB:END -->\n", "utf8");

const { capture, deprecate, deleteDomain, refreshForbiddenMarkers } = await import("../lib/capture.mjs");
await refreshForbiddenMarkers();

async function seed(slug) {
  const r = await capture({
    kind: "domain_new", domain: slug, summary: `${slug} summary`,
    tags: [slug, "alpha"], aliases: [], content: "seed body"
  });
  assert.equal(r.status, "ok", `seed ${slug} failed: ${JSON.stringify(r)}`);
}

test("deprecate: invalid slug rejected", async () => {
  const r = await deprecate({ domain: "BAD SLUG" });
  assert.equal(r.status, "invalid");
});

test("deprecate: not_found when file missing", async () => {
  const r = await deprecate({ domain: "missing-domain-xyz" });
  assert.equal(r.status, "not_found");
});

test("deprecate: marks file deprecated:<today> and re-call is unchanged", async () => {
  await seed("d-graceful");
  const r1 = await deprecate({ domain: "d-graceful" });
  assert.equal(r1.status, "ok");
  assert.match(r1.deprecatedAt, /^\d{4}-\d{2}-\d{2}$/);
  const body = await readFile(join(tmp, "knowledge", "d-graceful.md"), "utf8");
  assert.match(body, /"deprecated":\s*"\d{4}-\d{2}-\d{2}"/);
  const r2 = await deprecate({ domain: "d-graceful" });
  assert.equal(r2.status, "ok");
  assert.equal(r2.unchanged, true);
});

test("delete: invalid slug rejected", async () => {
  const r = await deleteDomain({ domain: "BAD" });
  assert.equal(r.status, "invalid");
});

test("delete: not_found when file missing", async () => {
  const r = await deleteDomain({ domain: "no-such-domain", confirm: true });
  assert.equal(r.status, "not_found");
});

test("delete: needs_confirm without confirm:true; file untouched", async () => {
  await seed("d-immediate");
  const r = await deleteDomain({ domain: "d-immediate" });
  assert.equal(r.status, "needs_confirm");
  await access(join(tmp, "knowledge", "d-immediate.md"));
});

test("delete: confirm:true moves file to _archive/", async () => {
  // (continues from previous test — d-immediate still exists)
  const r = await deleteDomain({ domain: "d-immediate", confirm: true });
  assert.equal(r.status, "ok");
  assert.match(r.archivedTo, /_archive[\\/]+d-immediate(\..*)?\.md$/);
  let originalGone = false;
  try { await access(join(tmp, "knowledge", "d-immediate.md")); } catch { originalGone = true; }
  assert.equal(originalGone, true);
  await access(r.archivedTo);
});

test("delete: collision in _archive/ generates a unique timestamped name", async () => {
  await seed("d-collide");
  await deleteDomain({ domain: "d-collide", confirm: true });
  await seed("d-collide");
  const r = await deleteDomain({ domain: "d-collide", confirm: true });
  assert.equal(r.status, "ok");
  assert.notEqual(r.archivedTo, join(tmp, "knowledge", "_archive", "d-collide.md"));
  assert.match(r.archivedTo, /d-collide\..*\.md$/);
});
