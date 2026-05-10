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
const { setCaptureSyncFn } = await import("./support/test-hooks.mjs");

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

test("domain_new succeeds and reports skipped_instructions_missing when instructions are absent", async () => {
  await rm(process.env.JITMEM_INSTRUCTIONS_MD, { force: true });
  const r = await capture({
    kind: "domain_new",
    domain: "noinstructions",
    content: "created while instructions are absent",
    summary: "instructions absent",
    tags: ["noinstructions"]
  });
  assert.equal(r.status, "ok");
  assert.equal(r.sync?.ok, true);
  assert.equal(r.sync?.kbStatus, "skipped_instructions_missing");
  assert.ok(await readFile(join(tmp, "knowledge", "noinstructions.md"), "utf8"));
  await writeFile(
    process.env.JITMEM_INSTRUCTIONS_MD,
    "# header\n<!-- QR:BEGIN -->\n<!-- QR:END -->\n<!-- KB:BEGIN -->\n<!-- KB:END -->\n",
    "utf8"
  );
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

test("domain_update rejects invalid existing metadata without writing", async () => {
  const file = join(tmp, "knowledge", "badmeta-update.md");
  const before = fmFile({
    domain: "badmeta-update", kind: "fact", summary: "",
    tags: ["badmeta"], aliases: [], see_also: [],
    verified: "2000-01-01", deprecated: null
  }, "# Badmeta\n\n## ✅ Working\n\n- existing\n");
  await writeFile(file, before, "utf8");

  const r = await capture({
    kind: "domain_update",
    domain: "badmeta-update",
    content: "should not write",
    section: "working"
  });

  const after = await readFile(file, "utf8");
  assert.equal(r.status, "invalid_setup");
  assert.match(r.summary, /frontmatter validate .*manual repair required/);
  assert.equal(r.sync, undefined);
  assert.equal(after, before, "invalid metadata must not be rewritten or stamped fresh");
  assert.ok(!after.includes("should not write"));
  assert.ok(after.includes('"verified": "2000-01-01"'));
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
  const file = join(tmp, "knowledge", "shape2.md");
  await writeFile(file, fmFile({
    domain: "shape2", kind: "fact", summary: "ok",
    tags: ["t1"], aliases: [], see_also: [],
    verified: "2026-04-26", deprecated: null
  }, "# Shape2\n\n## ✅ Working\n\n- existing\n"), "utf8");

  const r = await capture({
    kind: "alias_add",
    domain: "shape2",
    content: "noticed alias usage",
    aliases: ["shape-2-alias"]
  });
  assert.equal(r.status, "ok");
  assert.equal(r.sync?.ok, true);
});

test("alias_add rejects invalid existing metadata without writing", async () => {
  const file = join(tmp, "knowledge", "badmeta-alias.md");
  const before = fmFile({
    domain: "badmeta-alias", kind: "fact", summary: "",
    tags: ["badmeta"], aliases: [], see_also: [],
    verified: "2000-01-01", deprecated: null
  }, "# Badmeta Alias\n\n## ✅ Working\n\n- existing\n");
  await writeFile(file, before, "utf8");

  const r = await capture({
    kind: "alias_add",
    domain: "badmeta-alias",
    content: "noticed alias gap"
  });

  const after = await readFile(file, "utf8");
  assert.equal(r.status, "invalid_setup");
  assert.match(r.summary, /frontmatter validate .*manual repair required/);
  assert.equal(r.sync, undefined);
  assert.equal(after, before, "invalid metadata must not be rewritten or stamped fresh");
  assert.ok(after.includes('"verified": "2000-01-01"'));
});

test("alias_add returns at_cap when alias cap would overflow and preserves file", async () => {
  const file = join(tmp, "knowledge", "aliascap.md");
  const aliases = Array.from({ length: 8 }, (_, i) => `alias-${i}`);
  const before = fmFile({
    domain: "aliascap", kind: "fact", summary: "ok",
    tags: ["aliascap"], aliases, see_also: [],
    verified: "2000-01-01", deprecated: null
  }, "# Aliascap\n\n## ✅ Working\n\n- existing\n");
  await writeFile(file, before, "utf8");

  const r = await capture({
    kind: "alias_add",
    domain: "aliascap",
    content: "new alias",
    aliases: ["alias-new"]
  });

  assert.equal(r.status, "at_cap");
  assert.equal(r.field, "aliases");
  assert.deepEqual(r.cap, { tags: 12, aliases: 8 });
  assert.deepEqual(r.existing.aliases, aliases);
  assert.deepEqual(r.requested.aliases, ["alias-new"]);
  assert.equal(await readFile(file, "utf8"), before);
});

test("alias_add returns at_cap when tag cap would overflow and preserves file", async () => {
  const file = join(tmp, "knowledge", "tagcap.md");
  const tags = Array.from({ length: 12 }, (_, i) => `tag-${i}`);
  const before = fmFile({
    domain: "tagcap", kind: "fact", summary: "ok",
    tags, aliases: [], see_also: [],
    verified: "2000-01-01", deprecated: null
  }, "# Tagcap\n\n## ✅ Working\n\n- existing\n");
  await writeFile(file, before, "utf8");

  const r = await capture({
    kind: "alias_add",
    domain: "tagcap",
    content: "new tag",
    tags: ["tag-new"]
  });

  assert.equal(r.status, "at_cap");
  assert.equal(r.field, "tags");
  assert.deepEqual(r.existing.tags, tags);
  assert.deepEqual(r.requested.tags, ["tag-new"]);
  assert.equal(await readFile(file, "utf8"), before);
});

test("alias_add reports both fields when merged tags and aliases exceed caps", async () => {
  const file = join(tmp, "knowledge", "bothcap.md");
  const tags = Array.from({ length: 12 }, (_, i) => `both-${i}`);
  const aliases = Array.from({ length: 8 }, (_, i) => `both-alias-${i}`);
  const before = fmFile({
    domain: "bothcap", kind: "fact", summary: "ok",
    tags, aliases, see_also: [],
    verified: "2000-01-01", deprecated: null
  }, "# Bothcap\n\n## ✅ Working\n\n- existing\n");
  await writeFile(file, before, "utf8");

  const r = await capture({
    kind: "alias_add",
    domain: "bothcap",
    content: "new routing terms",
    tags: ["both-new"],
    aliases: ["both-alias-new"]
  });

  assert.equal(r.status, "at_cap");
  assert.equal(r.field, "both");
  assert.deepEqual(r.requested, { tags: ["both-new"], aliases: ["both-alias-new"] });
  assert.equal(await readFile(file, "utf8"), before);
});

test("alias_add duplicate at exact cap is unchanged and preserves file", async () => {
  const file = join(tmp, "knowledge", "aliasdup.md");
  const before = fmFile({
    domain: "aliasdup", kind: "fact", summary: "ok",
    tags: ["aliasdup"], aliases: Array.from({ length: 8 }, (_, i) => `dup-alias-${i}`), see_also: [],
    verified: "2000-01-01", deprecated: null
  }, "# Aliasdup\n\n## ✅ Working\n\n- existing\n");
  await writeFile(file, before, "utf8");

  const r = await capture({
    kind: "alias_add",
    domain: "aliasdup",
    content: "duplicate alias",
    aliases: ["dup-alias-3"]
  });

  assert.equal(r.status, "ok");
  assert.equal(r.unchanged, true);
  assert.deepEqual(r.sync, { ok: true, skipped: true });
  assert.equal(await readFile(file, "utf8"), before);
});

test("alias_add invalid requested value wins even when another value is duplicate", async () => {
  const file = join(tmp, "knowledge", "aliasinvalid.md");
  const before = fmFile({
    domain: "aliasinvalid", kind: "fact", summary: "ok",
    tags: ["aliasinvalid"], aliases: ["known-alias"], see_also: [],
    verified: "2000-01-01", deprecated: null
  }, "# Aliasinvalid\n\n## ✅ Working\n\n- existing\n");
  await writeFile(file, before, "utf8");

  const r = await capture({
    kind: "alias_add",
    domain: "aliasinvalid",
    content: "bad tag",
    tags: ["aliasinvalid", ""]
  });

  assert.equal(r.status, "invalid");
  assert.match(r.summary, /invalid tags/);
  assert.equal(await readFile(file, "utf8"), before);
});

test("alias_add normalizes uppercase requested tags before writing", async () => {
  const file = join(tmp, "knowledge", "aliasnormalize.md");
  await writeFile(file, fmFile({
    domain: "aliasnormalize", kind: "fact", summary: "ok",
    tags: ["aliasnormalize"], aliases: [], see_also: [],
    verified: "2000-01-01", deprecated: null
  }, "# Aliasnormalize\n\n## ✅ Working\n\n- existing\n"), "utf8");

  const r = await capture({
    kind: "alias_add",
    domain: "aliasnormalize",
    content: "uppercase tag",
    tags: ["New-Tag"]
  });

  assert.equal(r.status, "ok");
  const after = await readFile(file, "utf8");
  assert.ok(after.includes('"new-tag"'));
});

test("alias_add existing over-cap aliases returns at_cap without truncating", async () => {
  const file = join(tmp, "knowledge", "aliasovercap.md");
  const aliases = Array.from({ length: 9 }, (_, i) => `over-alias-${i}`);
  const before = fmFile({
    domain: "aliasovercap", kind: "fact", summary: "ok",
    tags: ["aliasovercap"], aliases, see_also: [],
    verified: "2000-01-01", deprecated: null
  }, "# Aliasovercap\n\n## ✅ Working\n\n- existing\n");
  await writeFile(file, before, "utf8");

  const r = await capture({
    kind: "alias_add",
    domain: "aliasovercap",
    content: "new tag while aliases over cap",
    tags: ["safe-tag"]
  });

  assert.equal(r.status, "at_cap");
  assert.equal(r.field, "aliases");
  assert.deepEqual(r.requested.tags, ["safe-tag"]);
  assert.deepEqual(r.existing.aliases, aliases);
  assert.equal(await readFile(file, "utf8"), before);
});

test("alias_add existing over-cap plus duplicate-only request still returns at_cap", async () => {
  const file = join(tmp, "knowledge", "aliasoverdup.md");
  const aliases = Array.from({ length: 9 }, (_, i) => `overdup-${i}`);
  const before = fmFile({
    domain: "aliasoverdup", kind: "fact", summary: "ok",
    tags: ["aliasoverdup"], aliases, see_also: [],
    verified: "2000-01-01", deprecated: null
  }, "# Aliasoverdup\n\n## ✅ Working\n\n- existing\n");
  await writeFile(file, before, "utf8");

  const r = await capture({
    kind: "alias_add",
    domain: "aliasoverdup",
    content: "duplicate while over cap",
    aliases: ["overdup-1"]
  });

  assert.equal(r.status, "at_cap");
  assert.equal(r.field, "aliases");
  assert.equal(await readFile(file, "utf8"), before);
});

// ── critical contract: capture-ok-but-sync-throws must NOT report failure ────

test("domain_new with sync failure: status=ok, sync.ok=false, file persists", async () => {
  setCaptureSyncFn(async () => { throw new Error("simulated sync failure"); });
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
    setCaptureSyncFn(null); // restore real syncNow
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

  setCaptureSyncFn(async () => { throw new Error("simulated update sync failure"); });
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
    setCaptureSyncFn(null);
  }
});
