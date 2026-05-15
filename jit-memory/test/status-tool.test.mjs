// Item #13: jit_memory_status returns a health snapshot.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = await mkdtemp(join(tmpdir(), "jitmem-status-"));
process.env.JITMEM_EXT_ROOT = tmp;
process.env.JITMEM_INSTRUCTIONS_MD = join(tmp, "copilot-instructions.md");
await mkdir(join(tmp, "knowledge"), { recursive: true });
await writeFile(process.env.JITMEM_INSTRUCTIONS_MD,
  "<!-- jit-memory:QR:BEGIN -->\n<!-- jit-memory:QR:END -->\n<!-- jit-memory:KB:BEGIN -->\n<!-- jit-memory:KB:END -->\n", "utf8");

const { capture, status, refreshForbiddenMarkers } = await import("../lib/capture.mjs");
await refreshForbiddenMarkers();

test("status: no routing yet, fresh KB", async () => {
  const s = await status();
  assert.equal(s.status, "ok");
  assert.equal(s.routing.exists, false);
  assert.equal(s.routing.domainCount, 0);
  assert.equal(s.usage.exists, false);
  assert.equal(s.blocked, false);
});

test("status: after a domain_new, routing exists with one domain", async () => {
  await capture({ kind: "domain_new", domain: "x", summary: "x", tags: ["xx", "yy"], aliases: [], content: "seed" });
  const s = await status();
  assert.equal(s.routing.exists, true);
  assert.equal(s.routing.domainCount, 1);
  assert.ok(s.routing.ageHours !== null && s.routing.ageHours >= 0);
  assert.equal(s.blocked, false);
});

test("status: includes 'issues' array (may be empty for healthy state)", async () => {
  const s = await status();
  assert.ok(Array.isArray(s.issues));
});
