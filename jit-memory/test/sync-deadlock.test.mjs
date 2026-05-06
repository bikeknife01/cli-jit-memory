// Regression test for sync.mjs scheduler deadlock.
//
// Bug: a second _schedule() call arriving inside the debounce window cleared
// the only pending timer and then returned the existing inFlight promise
// without re-arming, so the promise never resolved.
//
// Run from jit-memory/: node --test test/sync-deadlock.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the extension at a fresh tmp tree BEFORE importing any lib module.
const tmp = await mkdtemp(join(tmpdir(), "jitmem-sync-test-"));
process.env.JITMEM_EXT_ROOT        = tmp;
process.env.JITMEM_INSTRUCTIONS_MD = join(tmp, "copilot-instructions.md");
process.env.JITMEM_TEST_MODE       = "1"; // unlocks _resetSchedulerForTests

await mkdir(join(tmp, "knowledge"), { recursive: true });
await mkdir(join(tmp, "knowledge", "_archive"), { recursive: true });
await writeFile(
  join(tmp, "copilot-instructions.md"),
  "<!-- KB:BEGIN -->\n<!-- KB:END -->\n",
  "utf8"
);

const { syncNow, _resetSchedulerForTests } = await import("../lib/sync.mjs");

after(async () => { await rm(tmp, { recursive: true, force: true }); });

test("two consecutive syncNow() calls both resolve (deadlock regression)", async () => {
  _resetSchedulerForTests();
  const a = syncNow({ debounceMs: 50 });
  const b = syncNow({ debounceMs: 50 });
  assert.equal(a, b, "second syncNow should return the same in-flight promise");
  const result = await Promise.race([
    Promise.all([a, b]),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("DEADLOCK: syncNow did not resolve within 3s")), 3000)
    )
  ]);
  assert.ok(Array.isArray(result), "expected both promises to resolve");
  assert.equal(result.length, 2);
  assert.equal(result[0], result[1], "both awaiters should observe the same result object");
});

test("burst of N calls all resolve and share the same result", async () => {
  _resetSchedulerForTests();
  const promises = [];
  for (let i = 0; i < 5; i++) promises.push(syncNow({ debounceMs: 30 }));
  const results = await Promise.race([
    Promise.all(promises),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("DEADLOCK: burst did not resolve within 3s")), 3000)
    )
  ]);
  assert.equal(results.length, 5);
  for (const r of results) assert.equal(r, results[0], "all callers should share the same result");
});

test("sequential syncNow() after one completes still works", async () => {
  _resetSchedulerForTests();
  await syncNow({ debounceMs: 20 });
  await syncNow({ debounceMs: 20 });
  // No assertion needed — if either hangs the test runner times out.
});
