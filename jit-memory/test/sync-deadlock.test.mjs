// Regression test for sync.mjs scheduler deadlock.
//
// Bug: a second _schedule() call arriving inside the debounce window cleared
// the only pending timer and then returned the existing inFlight promise
// without re-arming, so the promise never resolved.
//
// Run from jit-memory/: node --test test/sync-deadlock.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the extension at a fresh tmp tree BEFORE importing any lib module.
const tmp = await mkdtemp(join(tmpdir(), "jitmem-sync-test-"));
process.env.JITMEM_EXT_ROOT        = tmp;
process.env.JITMEM_INSTRUCTIONS_MD = join(tmp, "copilot-instructions.md");
process.env.JITMEM_TEST_MODE       = "1";

await mkdir(join(tmp, "knowledge"), { recursive: true });
await mkdir(join(tmp, "knowledge", "_archive"), { recursive: true });
await writeFile(
  join(tmp, "copilot-instructions.md"),
  "<!-- KB:BEGIN -->\n<!-- KB:END -->\n",
  "utf8"
);

const { syncNow, requestSync, drainSync } = await import("../lib/sync.mjs");
const { resetSyncScheduler, setSyncOnce } = await import("./support/test-hooks.mjs");

after(async () => { await rm(tmp, { recursive: true, force: true }); });

test("two consecutive syncNow() calls both resolve (deadlock regression)", async () => {
  resetSyncScheduler();
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
  resetSyncScheduler();
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
  resetSyncScheduler();
  await syncNow({ debounceMs: 20 });
  await syncNow({ debounceMs: 20 });
  // No assertion needed — if either hangs the test runner times out.
});

test("syncNow reports skipped_instructions_missing while routing still updates", async () => {
  resetSyncScheduler();
  const domainFile = join(tmp, "knowledge", "missing_instructions.md");
  await writeFile(
    domainFile,
    `---\n${JSON.stringify({
      domain: "missing_instructions",
      kind: "fact",
      summary: "missing instructions test",
      tags: ["missing-instructions"],
      aliases: [],
      see_also: [],
      verified: "2026-05-09",
      deprecated: null
    }, null, 2)}\n---\n# Missing Instructions\n`,
    "utf8"
  );
  await rm(process.env.JITMEM_INSTRUCTIONS_MD, { force: true });

  const r = await syncNow({ debounceMs: 0 });
  assert.equal(r.kbStatus, "skipped_instructions_missing");
  assert.equal(r.routingWritten, true);
  await assert.rejects(() => access(process.env.JITMEM_INSTRUCTIONS_MD));
  const routing = await readFile(join(tmp, "knowledge", "_routing.json"), "utf8");
  assert.match(routing, /missing_instructions/);

  await writeFile(
    process.env.JITMEM_INSTRUCTIONS_MD,
    "<!-- KB:BEGIN -->\n<!-- KB:END -->\n",
    "utf8"
  );
});

test("dirty signal during failed sync schedules a continuation", async () => {
  resetSyncScheduler();
  const sequence = [];
  const secondInvocation = deferred();
  let calls = 0;

  try {
    setSyncOnce(async () => {
      calls++;
      if (calls === 1) {
        sequence.push("mock1");
        syncNow({ debounceMs: 0 }).catch(() => {});
        throw new Error("first failure");
      }
      sequence.push("mock2");
      secondInvocation.resolve();
      return { ok: true };
    });

    await assert.rejects(
      () => syncNow({ debounceMs: 0 }),
      error => {
        sequence.push("rejected");
        return error.message === "first failure";
      }
    );

    await Promise.race([
      secondInvocation.promise,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("continuation did not run within 3s")), 3000)
      )
    ]);

    assert.equal(calls, 2);
    assert.deepEqual(sequence, ["mock1", "rejected", "mock2"]);
  } finally {
    setSyncOnce(null);
    resetSyncScheduler();
  }
});

test("dirty signal is preserved when the retry iteration fails", async () => {
  resetSyncScheduler();
  const sequence = [];
  const continuation = deferred();
  let calls = 0;

  try {
    setSyncOnce(async () => {
      calls++;
      if (calls === 1) {
        sequence.push("mock1");
        syncNow({ debounceMs: 0 }).catch(() => {});
        return { ok: true };
      }
      if (calls === 2) {
        sequence.push("mock2");
        throw new Error("retry failure");
      }
      sequence.push("mock3");
      continuation.resolve();
      return { ok: true };
    });

    await assert.rejects(
      () => syncNow({ debounceMs: 0 }),
      error => {
        sequence.push("rejected");
        return error.message === "retry failure";
      }
    );

    await Promise.race([
      continuation.promise,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("continuation did not run within 3s")), 3000)
      )
    ]);

    assert.equal(calls, 3);
    assert.deepEqual(sequence, ["mock1", "mock2", "rejected", "mock3"]);
  } finally {
    setSyncOnce(null);
    resetSyncScheduler();
  }
});

test("drainSync is a no-op when no sync is pending", async () => {
  resetSyncScheduler();
  const r = await drainSync();
  assert.equal(r.ok, true);
  assert.equal(r.stalled, false);
  assert.equal(r.passes, 0);
});

test("drainSync waits for a pending debounced sync", async () => {
  resetSyncScheduler();
  let calls = 0;
  try {
    setSyncOnce(async () => {
      calls++;
      return { ok: true };
    });
    const pending = syncNow({ debounceMs: 20 });
    const r = await drainSync();
    await pending;
    assert.equal(calls, 1);
    assert.equal(r.ok, true);
    assert.equal(r.stalled, false);
    assert.equal(r.passes, 1);
  } finally {
    setSyncOnce(null);
    resetSyncScheduler();
  }
});

test("drainSync reports first-pass sync error without continuation", async () => {
  resetSyncScheduler();
  let calls = 0;
  try {
    setSyncOnce(async () => {
      calls++;
      throw new Error("single failure");
    });
    syncNow({ debounceMs: 0 }).catch(() => {});
    const r = await drainSync();
    assert.equal(calls, 1);
    assert.equal(r.ok, false);
    assert.equal(r.stalled, false);
    assert.equal(r.passes, 1);
    assert.equal(r.lastPassOk, false);
    assert.match(r.error, /single failure/);
  } finally {
    setSyncOnce(null);
    resetSyncScheduler();
  }
});

test("drainSync waits for queued continuation after failed retry", async () => {
  resetSyncScheduler();
  const sequence = [];
  let calls = 0;
  try {
    setSyncOnce(async () => {
      calls++;
      if (calls === 1) {
        sequence.push("mock1");
        requestSync({ debounceMs: 0 });
        return { ok: true };
      }
      if (calls === 2) {
        sequence.push("mock2");
        throw new Error("retry failure");
      }
      sequence.push("mock3");
      return { ok: true };
    });

    syncNow({ debounceMs: 0 }).catch(() => {});
    const r = await drainSync({ maxPasses: 3 });

    assert.equal(calls, 3);
    assert.deepEqual(sequence, ["mock1", "mock2", "mock3"]);
    assert.equal(r.ok, false);
    assert.equal(r.stalled, false);
    assert.equal(r.passes, 2);
    assert.equal(r.lastPassOk, true);
    assert.match(r.error, /retry failure/);
  } finally {
    setSyncOnce(null);
    resetSyncScheduler();
  }
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
