// Item #10: jit_memory_capture_preview returns existing candidates without
// writing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = await mkdtemp(join(tmpdir(), "jitmem-preview-"));
process.env.JITMEM_EXT_ROOT = tmp;
process.env.JITMEM_INSTRUCTIONS_MD = join(tmp, "copilot-instructions.md");
await mkdir(join(tmp, "knowledge"), { recursive: true });
await writeFile(process.env.JITMEM_INSTRUCTIONS_MD,
  "<!-- jit-memory:QR:BEGIN -->\n<!-- jit-memory:QR:END -->\n<!-- jit-memory:KB:BEGIN -->\n<!-- jit-memory:KB:END -->\n", "utf8");

const { capture, previewCapture, refreshForbiddenMarkers } = await import("../lib/capture.mjs");
await refreshForbiddenMarkers();

await capture({ kind: "domain_new", domain: "git", summary: "git lessons", tags: ["git", "rebase", "merge"], aliases: ["git rebase", "merge conflict"], content: "seed" });
await capture({ kind: "domain_new", domain: "node-test", summary: "node test runner", tags: ["node", "testing", "runner"], aliases: ["node test"], content: "seed" });

test("preview: empty inputs return suggestedKind:domain_new and no candidates", async () => {
  const r = await previewCapture({});
  assert.equal(r.status, "ok");
  assert.equal(r.candidates.length, 0);
  assert.equal(r.suggestedKind, "domain_new");
});

test("preview: existing slug returns slug-match candidate and suggests domain_update", async () => {
  const r = await previewCapture({ kind: "domain_new", domain: "git", tags: ["unrelated"] });
  assert.ok(r.candidates.find(c => c.source === "slug" && c.slug === "git"));
  assert.equal(r.suggestedKind, "domain_update");
});

test("preview: tag overlap surfaces an overlap candidate and suggests alias_add", async () => {
  const r = await previewCapture({ kind: "domain_new", domain: "new-thing", tags: ["git", "rebase"] });
  const m = r.candidates.find(c => c.slug === "git" && c.source === "overlap");
  assert.ok(m, `expected overlap candidate for git, got ${JSON.stringify(r.candidates)}`);
  assert.deepEqual(m.sharedTags.sort(), ["git", "rebase"]);
  assert.equal(m.confidence, "high");
  assert.equal(r.suggestedKind, "alias_add");
});

test("preview: alias overlap (case-insensitive)", async () => {
  const r = await previewCapture({ aliases: ["MERGE conflict"] });
  const m = r.candidates.find(c => c.slug === "git");
  assert.ok(m, `expected git via alias match, got ${JSON.stringify(r.candidates)}`);
  assert.deepEqual(m.sharedAliases, ["merge conflict"]);
});

test("preview does not write any files", async () => {
  // Verify the routing table still has only the seeded domains.
  const { loadRouting } = await import("../lib/router.mjs");
  const before = (await loadRouting()).domains?.length ?? 0;
  await previewCapture({ domain: "would-be-new", tags: ["a", "b"] });
  const after = (await loadRouting()).domains?.length ?? 0;
  assert.equal(after, before);
});
