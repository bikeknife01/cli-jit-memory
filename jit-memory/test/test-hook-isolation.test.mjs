import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

process.env.JITMEM_TEST_MODE = "1";

test("production modules expose only their intended public API", async () => {
  const [sync, capture, router, registry] = await Promise.all([
    import("../lib/sync.mjs"),
    import("../lib/capture.mjs"),
    import("../lib/router.mjs"),
    import("../lib/test-hook-registry.mjs")
  ]);

  assert.deepEqual(Object.keys(sync).sort(), [
    "KB_BEGIN",
    "KB_END",
    "drainSync",
    "kbBlockEquivalent",
    "listDomainFiles",
    "renderKbBlock",
    "requestSync",
    "syncNow"
  ]);
  assert.deepEqual(Object.keys(capture).sort(), [
    "QR_BEGIN",
    "QR_END",
    "capture",
    "debugRoute",
    "refreshForbiddenMarkers"
  ]);
  assert.deepEqual(Object.keys(router).sort(), [
    "consumeInvalidEntryCount",
    "invalidateRoutingCache",
    "loadRouting",
    "route",
    "routeFromDisk"
  ]);
  assert.deepEqual(Object.keys(registry).sort(), [
    "getTestHooks",
    "registerTestHooks"
  ]);
});

test("test support module exposes hook helpers", async () => {
  const hooks = await import("./support/test-hooks.mjs");
  assert.equal(typeof hooks.resetSyncScheduler, "function");
  assert.equal(typeof hooks.setSyncOnce, "function");
  assert.equal(typeof hooks.setCaptureSyncFn, "function");
  assert.equal(typeof hooks.resetRouterInvalidEntryCount, "function");
});

test("lib modules do not import test hook accessors or test support", async () => {
  const libRoot = new URL("../lib/", import.meta.url);
  const files = await listMjsFiles(libRoot);
  for (const file of files) {
    const raw = await readFile(file, "utf8");
    const isRegistry = file.endsWith("test-hook-registry.mjs");
    if (!isRegistry) {
      assert.ok(!raw.includes("getTestHooks"), `${file} must not import getTestHooks`);
    }
    assert.ok(!raw.includes("../test/"), `${file} must not import test modules`);
    assert.ok(!raw.includes("/test/"), `${file} must not import test modules`);
    const registryImports = raw.match(/import\s*\{([^}]+)\}\s*from\s*["'][^"']*test-hook-registry\.mjs["']/g) || [];
    for (const stmt of registryImports) {
      assert.ok(/\bregisterTestHooks\b/.test(stmt), `${file} may only import registerTestHooks`);
      assert.ok(!/\bgetTestHooks\b/.test(stmt), `${file} must not import getTestHooks`);
    }
  }
});

async function listMjsFiles(dirUrl) {
  const out = [];
  for (const entry of await readdir(dirUrl, { withFileTypes: true })) {
    const child = new URL(entry.name, dirUrl);
    if (entry.isDirectory()) {
      out.push(...await listMjsFiles(new URL(`${entry.name}/`, dirUrl)));
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      out.push(fileURLToPath(child));
    }
  }
  return out;
}
