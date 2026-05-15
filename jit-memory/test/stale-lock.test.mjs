// Item #5: a slow live holder of withLock must not have its lock evicted by
// another process's stale-removal scan. The heartbeat keeps mtime fresh.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = await mkdtemp(join(tmpdir(), "jitmem-stale-lock-"));
process.env.JITMEM_EXT_ROOT = tmp;
process.env.JITMEM_INSTRUCTIONS_MD = join(tmp, "copilot-instructions.md");
await mkdir(join(tmp, "knowledge"), { recursive: true });

const { withLock } = await import("../lib/atomic.mjs");

test("slow live holder past staleMs is NOT evicted by waiter (heartbeat refresh)", async () => {
  const target = join(tmp, "lock-target");
  const holderRanFor = 600;     // ms
  const staleMs = 200;          // intentionally < holderRanFor
  let holderFinished = false;
  let waiterEnteredCriticalAt = null;

  const holder = withLock(target, async () => {
    // Hold for longer than staleMs; heartbeat must keep us alive.
    await new Promise(r => setTimeout(r, holderRanFor));
    holderFinished = true;
  }, { timeoutMs: 5000, staleMs });

  // Give the holder a moment to acquire.
  await new Promise(r => setTimeout(r, 50));

  const waiter = withLock(target, async () => {
    waiterEnteredCriticalAt = Date.now();
  }, { timeoutMs: 5000, staleMs });

  await Promise.all([holder, waiter]);

  // Waiter must have entered ONLY after holder finished, never before.
  assert.equal(holderFinished, true);
  assert.ok(waiterEnteredCriticalAt !== null, "waiter should eventually run");
});

test("truly stale lock (no heartbeat refresher) IS evicted after staleMs", async () => {
  const target = join(tmp, "lock-target-stale");
  const lockPath = target + ".lock";
  // Manually create a stale lock without the heartbeat wrapper.
  const fs = await import("node:fs/promises");
  await fs.writeFile(lockPath, "0\n0\n");
  // Force its mtime to be old.
  const past = new Date(Date.now() - 10_000);
  await fs.utimes(lockPath, past, past);
  let ran = false;
  await withLock(target, async () => { ran = true; }, { timeoutMs: 2000, staleMs: 200 });
  assert.equal(ran, true);
});
