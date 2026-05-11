// Regression test for fix #2: read-inside-lock in mutating capture kinds.
//
// Pre-fix behavior: domain_update read OUTSIDE withLock. Two concurrent
// updates would both read the same baseline, then serialize on the lock,
// and the second writer would clobber the first writer's append → lost
// update. This test fails on the old code and passes after the fix.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, open, unlink } from "node:fs/promises";
import { constants as fsc } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = await mkdtemp(join(tmpdir(), "jitmem-capture-test-"));
process.env.JITMEM_EXT_ROOT        = tmp;
process.env.JITMEM_INSTRUCTIONS_MD = join(tmp, "copilot-instructions.md");
process.env.JITMEM_TEST_MODE       = "1";

await mkdir(join(tmp, "knowledge"), { recursive: true });
await writeFile(
  join(tmp, "copilot-instructions.md"),
  "# Test\n\n<!-- QR:BEGIN -->\n<!-- QR:END -->\n\n<!-- KB:BEGIN -->\n<!-- KB:END -->\n",
  "utf8"
);

// Seed a domain file with a known baseline.
const SEED = `---
{"domain":"alpha","kind":"fact","summary":"seed","tags":["alpha"],"aliases":[],"see_also":[],"verified":"2026-04-24","deprecated":null}
---
# Alpha

seed

## ✅ Working

- baseline
`;
const ALPHA = join(tmp, "knowledge", "alpha.md");
await writeFile(ALPHA, SEED, "utf8");

const { capture } = await import("../lib/capture.mjs");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Hold a lock externally so all in-flight captures pile up at the same
// await-point before any of them can do their read-modify-write. This is
// what guarantees deterministic regression coverage: on the OLD (broken)
// code, captures performed their reads BEFORE entering withLock, so a
// pre-held lock would not stop them from all snapshotting the same
// baseline; on the FIXED code, they all block here.
async function holdLock(targetPath, ms) {
  const lockPath = targetPath + ".lock";
  const fh = await open(lockPath, fsc.O_CREAT | fsc.O_EXCL | fsc.O_WRONLY);
  await fh.write(`test\n${Date.now()}\n`);
  await fh.close();
  await sleep(ms);
  try { await unlink(lockPath); } catch { /* may have been evicted */ }
}

test("concurrent domain_update calls don't lose appends (deterministic via pre-held lock)", async () => {
  const N = 6;
  // Pre-hold the lock so all 6 captures await fs.open simultaneously.
  // Release after 200ms so all captures have reached the lock-acquire point
  // (read on OLD code, blocked on lock on FIXED code).
  const holding = holdLock(ALPHA, 200);

  const captures = Promise.all(
    Array.from({ length: N }, (_, i) =>
      capture({
        kind: "domain_update",
        domain: "alpha",
        section: "working",
        content: `parallel-line-${i}`
      })
    )
  );

  await holding;
  const results = await captures;

  for (const r of results) {
    assert.equal(r.status, "ok", `update failed: ${JSON.stringify(r)}`);
  }

  const final = await readFile(ALPHA, "utf8");
  for (let i = 0; i < N; i++) {
    assert.ok(
      final.includes(`parallel-line-${i}`),
      `expected parallel-line-${i} to survive concurrent writes; file:\n${final}`
    );
  }
  assert.ok(final.includes("- baseline"), "baseline line was clobbered");
});

test("concurrent disputed appends all land (deterministic)", async () => {
  const N = 4;
  const holding = holdLock(ALPHA, 150);
  const captures = Promise.all(
    Array.from({ length: N }, (_, i) =>
      capture({
        kind: "disputed",
        domain: "alpha",
        content: `dispute-${i}`
      })
    )
  );
  await holding;
  const results = await captures;
  for (const r of results) assert.equal(r.status, "ok");

  const final = await readFile(ALPHA, "utf8");
  for (let i = 0; i < N; i++) {
    assert.ok(final.includes(`dispute-${i}`), `lost dispute-${i}`);
  }
});

test("concurrent alias_add calls all land their tags (deterministic)", async () => {
  const N = 4;
  const holding = holdLock(ALPHA, 150);
  const captures = Promise.all(
    Array.from({ length: N }, (_, i) =>
      capture({
        kind: "alias_add",
        domain: "alpha",
        content: `adding tag-${i}`,
        tags: [`tag-${i}`]
      })
    )
  );
  await holding;
  const results = await captures;
  for (const r of results) assert.equal(r.status, "ok");

  const final = await readFile(ALPHA, "utf8");
  for (let i = 0; i < N; i++) {
    assert.ok(final.includes(`tag-${i}`), `lost tag-${i}; file:\n${final}`);
  }
});

test("concurrent domain_new for same slug: exactly one wins (deterministic via pre-held lock)", async () => {
  const N = 5;
  const target = join(tmp, "knowledge", "racecondition.md");
  const holding = holdLock(target, 200);

  const captures = Promise.all(
    Array.from({ length: N }, (_, i) =>
      capture({
        kind: "domain_new",
        domain: "racecondition",
        summary: `attempt ${i}`,
        content: `attempt ${i} body`,
        tags: ["xx"]
      })
    )
  );
  await holding;
  const results = await captures;

  const oks = results.filter(r => r.status === "ok");
  const conflicts = results.filter(r => r.status === "conflict");
  assert.equal(oks.length, 1, `expected exactly 1 ok; got ${oks.length}: ${JSON.stringify(results)}`);
  assert.equal(conflicts.length, N - 1, `expected ${N - 1} conflicts; got ${conflicts.length}`);
});
