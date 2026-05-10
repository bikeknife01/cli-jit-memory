import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, access, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = await mkdtemp(join(tmpdir(), "jitmem-symlink-root-test-"));
process.env.JITMEM_EXT_ROOT = tmp;
process.env.JITMEM_TEST_MODE = "1";
process.env.JITMEM_INSTRUCTIONS_MD = join(tmp, "copilot-instructions.md");

const outside = join(tmp, "outside-knowledge");

const { capture } = await import("../lib/capture.mjs");
const { KNOWLEDGE_ROOT } = await import("../lib/paths.mjs");

test("capture refuses when knowledge root itself is a dangling symlink", async (t) => {
  try {
    await symlink(outside, KNOWLEDGE_ROOT, "dir");
  } catch (e) {
    t.skip(`symlink creation unavailable: ${e.code || e.message}`);
    return;
  }

  const r = await capture({
    kind: "domain_new",
    domain: "rootlink",
    summary: "root symlink",
    tags: ["rootlink"],
    content: "should not write through symlinked knowledge root"
  });
  assert.equal(r.status, "invalid_setup");
  assert.match(r.summary, /symlink not allowed/i);
  await assert.rejects(() => access(outside));
});
