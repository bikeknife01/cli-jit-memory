// Regression test for item #2: audit() on a fresh install with no
// knowledge/ directory used to throw ENOENT because withLock opened
// _usage.json.lock before the parent directory existed. The fix is in
// lib/atomic.mjs: withLock now mkdir's the lock parent before O_EXCL.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = await mkdtemp(join(tmpdir(), "jitmem-empty-kb-"));
process.env.JITMEM_EXT_ROOT = tmp;
process.env.JITMEM_INSTRUCTIONS_MD = join(tmp, "copilot-instructions.md");
await writeFile(process.env.JITMEM_INSTRUCTIONS_MD,
  "<!-- QR:BEGIN -->\n<!-- QR:END -->\n<!-- KB:BEGIN -->\n<!-- KB:END -->\n", "utf8");
// IMPORTANT: do NOT pre-create knowledge/ — that's the bug condition.

const { audit } = await import("../lib/audit.mjs");
const { withLock } = await import("../lib/atomic.mjs");

test("audit() succeeds when knowledge/ does not yet exist (item #2)", async () => {
  // Pre-flight: confirm knowledge/ truly doesn't exist for this run.
  const knowledgeDir = join(tmp, "knowledge");
  await rm(knowledgeDir, { recursive: true, force: true });
  const r = await audit({ archivalAllowed: false });
  assert.equal(r.healthy, true, "expected empty KB to be healthy");
});

test("withLock creates lock parent directory if missing (item #2)", async () => {
  const lockTarget = join(tmp, "deep", "nested", "thing.json");
  let ran = false;
  await withLock(lockTarget, async () => { ran = true; });
  assert.equal(ran, true);
});
