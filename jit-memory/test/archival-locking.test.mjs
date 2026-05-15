// Item #6: archival respects per-file locks. A concurrent domain_update or
// alias_add holding alpha.md.lock blocks archival until the write completes;
// archival re-validates deprecation eligibility inside the lock, so a file
// that was un-deprecated by the concurrent write is not archived.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { open } from "node:fs/promises";
import { constants as fsc } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = await mkdtemp(join(tmpdir(), "jitmem-archival-"));
process.env.JITMEM_EXT_ROOT = tmp;
process.env.JITMEM_INSTRUCTIONS_MD = join(tmp, "copilot-instructions.md");
await mkdir(join(tmp, "knowledge"), { recursive: true });
await writeFile(process.env.JITMEM_INSTRUCTIONS_MD,
  "<!-- QR:BEGIN -->\n<!-- QR:END -->\n<!-- KB:BEGIN -->\n<!-- KB:END -->\n", "utf8");

// Seed a deprecated >30-days-ago file.
const long_ago = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
const seedMeta = {
  domain: "deprecated-x", kind: "fact", summary: "deprecated long ago",
  tags: ["deprecated-x", "alpha"], aliases: [], see_also: [],
  verified: long_ago, deprecated: long_ago
};
const seedFile = join(tmp, "knowledge", "deprecated-x.md");
await writeFile(seedFile,
  `---\n${JSON.stringify(seedMeta, null, 2)}\n---\n\n# Deprecated X\n\nbody\n`, "utf8");

const { audit } = await import("../lib/audit.mjs");

test("archival is skipped while another writer holds the per-file lock", async () => {
  // Simulate a concurrent writer by holding alpha.md.lock externally.
  const lockPath = seedFile + ".lock";
  const fh = await open(lockPath, fsc.O_CREAT | fsc.O_EXCL | fsc.O_WRONLY);
  await fh.write("test\n0\n");
  await fh.close();
  try {
    // Audit with a tight timeout so it doesn't wait long.
    const r = await audit({ archivalAllowed: true });
    // Either the archive entry was attempted-but-blocked (timeout error in
    // findings.frontmatterErrors), or no archive happened. Either way, the
    // source file must still exist (NOT archived under the held lock).
    await access(seedFile);
    // Detect that archival did NOT successfully move the file.
    assert.equal(r.archived.length, 0, `expected no archives while lock held; got ${JSON.stringify(r.archived)}`);
  } finally {
    // Release the lock so subsequent test runs are clean.
    try { await (await import("node:fs/promises")).unlink(lockPath); } catch {}
  }
});

test("after lock is released, archival succeeds", async () => {
  const r = await audit({ archivalAllowed: true });
  assert.ok(r.archived.length >= 1, `expected at least one archive; got ${JSON.stringify(r.archived)}`);
  // Original file gone, archived copy present.
  let originalGone = false;
  try { await access(seedFile); } catch { originalGone = true; }
  assert.equal(originalGone, true);
  await access(join(tmp, "knowledge", "_archive", "deprecated-x.md"));
});
