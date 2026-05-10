import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";

import { withTimeout } from "../lib/timeout.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test("withTimeout resolves when the promise settles before timeout", async () => {
  const result = await withTimeout(50, Promise.resolve("ok"), "route");
  assert.equal(result, "ok");
});

test("withTimeout rejects with the original error before timeout", async () => {
  const original = new Error("route failed");
  await assert.rejects(
    () => withTimeout(50, Promise.reject(original), "route"),
    error => error === original
  );
});

test("withTimeout timeout error includes label and timeout duration", async () => {
  await assert.rejects(
    () => withTimeout(10, sleep(100), "route"),
    /timeout: route \(10ms\)/
  );
});

test("withTimeout consumes late rejection after timeout", async () => {
  const lateDelay = 20;
  const observed = [];
  const listener = reason => observed.push(reason);
  process.on("unhandledRejection", listener);
  try {
    await assert.rejects(
      () => withTimeout(5, sleep(lateDelay).then(() => { throw new Error("late rejection"); }), "route"),
      /timeout: route \(5ms\)/
    );
    await sleep(lateDelay + 50);
    await tick();
    await tick();
    assert.deepEqual(observed, []);
  } finally {
    process.off("unhandledRejection", listener);
  }
});
