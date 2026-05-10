// Regression test for fix #3: casReplaceMarkers rebuilds via callback on
// each retry. Pre-fix behavior: caller built `newInner` from a stale
// snapshot; on stat-mismatch retry, the stale newInner was written anyway,
// silently clobbering whatever changed between read and write.
//
// This test directly exercises the CAS retry path by mutating the file
// between the first read and the final stat-check, forcing one retry, and
// asserting that the callback was invoked TWICE — once for the original
// content and once for the post-mutation content — and that the final
// written content reflects the post-mutation state, not the original.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = await mkdtemp(join(tmpdir(), "jitmem-cas-rebuild-test-"));
process.env.JITMEM_TEST_MODE = "1";

const { casReplaceMarkers } = await import("../lib/atomic.mjs");

const BEGIN = "<!-- TEST:BEGIN -->";
const END   = "<!-- TEST:END -->";

test("buildInner is called fresh on every retry", async () => {
  const path = join(tmp, "doc.md");
  await writeFile(path, `before\n${BEGIN}\noriginal\n${END}\nafter\n`, "utf8");

  const observedInners = [];
  let callCount = 0;

  const r = await casReplaceMarkers(path, BEGIN, END, async (_content, inner) => {
    observedInners.push(inner.trim());
    callCount++;
    // On the FIRST call, mutate the file underneath us so the post-callback
    // stat check fails and triggers a retry.
    if (callCount === 1) {
      await writeFile(path, `before\n${BEGIN}\nintervening-edit\n${END}\nafter\n`, "utf8");
    }
    // Append based on what the callback CURRENTLY sees.
    return `\n${inner.trim()}\nappended-${callCount}\n`;
  });

  assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
  assert.equal(r.status, "ok");
  assert.ok(callCount >= 2, `expected callback to run at least twice (got ${callCount})`);

  // First call saw "original"; a later call saw the intervening edit.
  assert.equal(observedInners[0], "original");
  assert.ok(
    observedInners.slice(1).some(s => s === "intervening-edit"),
    `expected a later observation of "intervening-edit"; got ${JSON.stringify(observedInners)}`
  );

  // Final file contents must reflect the post-mutation baseline + last append,
  // NOT a clobber based on the stale "original" snapshot.
  const final = await readFile(path, "utf8");
  assert.ok(final.includes("intervening-edit"), `lost intervening edit:\n${final}`);
  assert.ok(final.includes(`appended-${callCount}`), `final append missing:\n${final}`);
  assert.ok(!final.includes("\noriginal\nappended-1\n"), `clobbered with stale snapshot:\n${final}`);
});

test("buildInner returning null is a no-op (status:noop) and skips writes", async () => {
  const path = join(tmp, "doc-noop.md");
  await writeFile(path, `${BEGIN}\nbase\n${END}\n`, "utf8");
  const before = await readFile(path, "utf8");

  const r = await casReplaceMarkers(path, BEGIN, END, () => null);
  assert.equal(r.ok, true);
  assert.equal(r.status, "noop");

  const after = await readFile(path, "utf8");
  assert.equal(after, before, "noop must not modify the file");
});

test("missing markers return status:missing without invoking callback", async () => {
  const path = join(tmp, "doc-nomarkers.md");
  await writeFile(path, "no markers here\n", "utf8");
  let called = false;
  const r = await casReplaceMarkers(path, BEGIN, END, () => { called = true; return "x"; });
  assert.equal(r.ok, false);
  assert.equal(r.status, "missing");
  assert.equal(called, false, "callback must not run when markers absent");
});

test("marker whitespace variants return malformed without invoking callback", async () => {
  const path = join(tmp, "doc-marker-variants.md");
  await writeFile(path, `before\n${BEGIN}\nbase\n<!-- TEST:END  -->\nafter\n`, "utf8");
  let called = false;
  const r = await casReplaceMarkers(path, BEGIN, END, () => { called = true; return "x"; });
  assert.equal(r.ok, false);
  assert.equal(r.status, "malformed");
  assert.equal(called, false, "callback must not run when marker variants are present");
});

test("buildInner throwing surfaces as build_error (no write)", async () => {
  const path = join(tmp, "doc-throws.md");
  await writeFile(path, `${BEGIN}\nbase\n${END}\n`, "utf8");
  const before = await readFile(path, "utf8");
  const r = await casReplaceMarkers(path, BEGIN, END, () => { throw new Error("boom"); });
  assert.equal(r.ok, false);
  assert.equal(r.status, "build_error");
  assert.match(r.error, /boom/);
  const after = await readFile(path, "utf8");
  assert.equal(after, before, "build_error must not modify the file");
});

test("concurrent CAS callers serialize via withLock — no lost appends", async () => {
  const path = join(tmp, "doc-concurrent.md");
  await writeFile(path, `before\n${BEGIN}\n${END}\nafter\n`, "utf8");

  const N = 8;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      casReplaceMarkers(path, BEGIN, END, (_content, inner) => {
        // Append a unique marker to whatever's currently between markers.
        const trimmed = inner.replace(/^\s+|\s+$/g, "");
        return trimmed
          ? `\n${trimmed}\nappend-${i}\n`
          : `\nappend-${i}\n`;
      })
    )
  );

  for (const r of results) {
    assert.equal(r.ok, true, `CAS failed: ${JSON.stringify(r)}`);
    assert.equal(r.status, "ok");
  }

  const final = await readFile(path, "utf8");
  for (let i = 0; i < N; i++) {
    assert.ok(final.includes(`append-${i}`), `lost append-${i}; file:\n${final}`);
  }
});
