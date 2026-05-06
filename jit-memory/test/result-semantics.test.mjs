// Regression tests for fix #6: capture result semantics — separate the
// capture business `status` (which reflects whether the data was written to
// disk) from the post-write `sync` side-effect status. A successful capture
// followed by a sync that throws must NOT report failure to the model.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = await mkdtemp(join(tmpdir(), "jitmem-result-test-"));
process.env.JITMEM_EXT_ROOT  = tmp;
process.env.JITMEM_TEST_MODE = "1";
process.env.JITMEM_INSTRUCTIONS_MD = join(tmp, "copilot-instructions.md");

await mkdir(join(tmp, "knowledge"), { recursive: true });
await writeFile(
  process.env.JITMEM_INSTRUCTIONS_MD,
  "# header\n<!-- QR:BEGIN -->\n<!-- QR:END -->\n<!-- KB:BEGIN -->\n<!-- KB:END -->\n",
  "utf8"
);

const { capture } = await import("../lib/capture.mjs");
const sync = await import("../lib/sync.mjs");

function fmFile(meta, body = "body\n") {
  return `---\n${JSON.stringify(meta, null, 2)}\n---\n${body}`;
}

// ── happy path: shape contract ───────────────────────────────────────────────

test("domain_new returns status=ok with sync.ok=true on success", async () => {
  const r = await capture({
    kind: "domain_new",
    domain: "shape1",
    content: "First lesson.",
    summary: "shape test 1",
    tags: ["s1"]
  });
  assert.equal(r.status, "ok");
  assert.ok(r.file);
  assert.ok(r.sync, "sync sub-object must be present");
  assert.equal(r.sync.ok, true, "sync should succeed");
});

test("domain_update returns status=ok with sync.ok=true on success", async () => {
  // Pre-create a domain via JSON frontmatter
  const file = join(tmp, "knowledge", "shape2.md");
  await writeFile(file, fmFile({
    domain: "shape2", kind: "fact", summary: "ok",
    tags: ["t1"], aliases: [], see_also: [],
    verified: "2026-04-26", deprecated: null
  }, "# Shape2\n\n## ✅ Working\n\n- existing\n"), "utf8");

  const r = await capture({
    kind: "domain_update",
    domain: "shape2",
    content: "another lesson",
    section: "working"
  });
  assert.equal(r.status, "ok");
  assert.equal(r.sync?.ok, true);
});

test("disputed returns status=ok with sync.skipped=true (no sync needed)", async () => {
  // Reuse shape2.md from previous test
  const r = await capture({
    kind: "disputed",
    domain: "shape2",
    content: "tried X — failed Y"
  });
  assert.equal(r.status, "ok");
  assert.ok(r.sync, "sync stub present even when skipped");
  assert.equal(r.sync.skipped, true, "disputes should mark sync as skipped");
});

test("alias_add returns status=ok with sync sub-object on success", async () => {
  const r = await capture({
    kind: "alias_add",
    domain: "shape2",
    content: "noticed alias usage",
    aliases: ["shape-2-alias"]
  });
  assert.equal(r.status, "ok");
  assert.equal(r.sync?.ok, true);
});

// ── critical contract: capture-ok-but-sync-throws must NOT report failure ────

test("domain_new with sync failure: status=ok, sync.ok=false, file persists", async () => {
  const { _setSyncFnForTests } = await import("../lib/capture.mjs");
  _setSyncFnForTests(async () => { throw new Error("simulated sync failure"); });
  try {
    const r = await capture({
      kind: "domain_new",
      domain: "syncfail1",
      content: "captured before sync fails",
      summary: "sync fail test",
      tags: ["sf1"]
    });
    const file = join(tmp, "knowledge", "syncfail1.md");
    const content = await readFile(file, "utf8");
    assert.ok(content.includes("syncfail1"), "file must persist on disk");
    assert.equal(r.status, "ok", "capture status must remain ok when data is on disk");
    assert.ok(r.sync, "sync sub-object must be present");
    assert.equal(r.sync.ok, false, "sync.ok must be false when sync threw");
    assert.match(r.sync.error, /simulated sync failure/);
  } finally {
    _setSyncFnForTests(null); // restore real syncNow
  }
});

test("conflict (file already exists) returns status=conflict and NO sync ran", async () => {
  // Pre-create file via direct write so test is independent of order.
  const file = join(tmp, "knowledge", "conflict-target.md");
  await writeFile(file, fmFile({
    domain: "conflict-target", kind: "fact", summary: "pre",
    tags: ["c"], aliases: [], see_also: [],
    verified: "2026-04-26", deprecated: null
  }), "utf8");

  const r = await capture({
    kind: "domain_new",
    domain: "conflict-target",
    content: "duplicate attempt",
    summary: "dup",
    tags: ["d"]
  });
  assert.equal(r.status, "conflict");
  assert.equal(r.sync, undefined, "sync should not run on conflict");
});

test("invalid input returns status=invalid and NO sync ran", async () => {
  const r = await capture({
    kind: "domain_new",
    domain: "bad slug with spaces",
    content: "x",
    summary: "x",
    tags: ["t"]
  });
  assert.equal(r.status, "invalid");
  assert.equal(r.sync, undefined);
});

test("domain_update with sync failure: status=ok, sync.ok=false, file persists", async () => {
  // Pre-create a domain file the update will mutate.
  const file = join(tmp, "knowledge", "updatesync.md");
  await writeFile(file, fmFile({
    domain: "updatesync", kind: "fact", summary: "ok",
    tags: ["u"], aliases: [], see_also: [],
    verified: "2026-04-26", deprecated: null
  }, "# Updatesync\n\n## ✅ Working\n\n- existing line\n"), "utf8");

  const { _setSyncFnForTests } = await import("../lib/capture.mjs");
  _setSyncFnForTests(async () => { throw new Error("simulated update sync failure"); });
  try {
    const r = await capture({
      kind: "domain_update",
      domain: "updatesync",
      content: "newly appended",
      section: "working"
    });
    assert.equal(r.status, "ok", "update status remains ok when data persisted");
    assert.equal(r.sync?.ok, false);
    assert.match(r.sync.error, /simulated update sync failure/);
    const after = await readFile(file, "utf8");
    assert.ok(after.includes("newly appended"), "update text persisted on disk");
  } finally {
    _setSyncFnForTests(null);
  }
});
