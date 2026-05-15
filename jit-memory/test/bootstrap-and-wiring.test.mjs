// Regression tests for fix #7: bootstrap repair (insert QR/KB markers if
// missing in copilot-instructions.md) and verify extension.mjs registers
// hooks/tools via the supported joinSession({hooks, tools}) options path.
//
// The hook-wiring smoke test stubs @github/copilot-sdk/extension via a
// custom import-map style: we import bootstrap.mjs directly (unit), and
// verify by source-string assertion that extension.mjs contains the
// joinSession({hooks, tools}) shape and does NOT call session.rpc.register*.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const tmp = await mkdtemp(join(tmpdir(), "jitmem-bootstrap-test-"));
process.env.JITMEM_EXT_ROOT  = tmp;
process.env.JITMEM_TEST_MODE = "1";
process.env.JITMEM_INSTRUCTIONS_MD = join(tmp, "copilot-instructions.md");

await mkdir(join(tmp, "knowledge"), { recursive: true });

const { ensureMarkers } = await import("../lib/bootstrap.mjs");
const { casReplaceMarkers } = await import("../lib/atomic.mjs");
const { capture } = await import("../lib/capture.mjs");

const INSTR = process.env.JITMEM_INSTRUCTIONS_MD;

async function withInstructions(content, fn) {
  await writeFile(INSTR, content, "utf8");
  try { return await fn(); }
  finally { await rm(INSTR, { force: true }); }
}

// ── ensureMarkers: file missing ─────────────────────────────────────────────

test("ensureMarkers reports fileExists=false when instructions absent", async () => {
  await rm(INSTR, { force: true });
  const r = await ensureMarkers();
  assert.equal(r.fileExists, false);
  assert.equal(r.qrInserted, false);
  assert.equal(r.kbInserted, false);
  assert.match(r.error, /not found/);
});

// ── ensureMarkers: both present, no-op ──────────────────────────────────────

test("ensureMarkers no-ops when both QR and KB markers present", async () => {
  await withInstructions(
    "# header\n<!-- QR:BEGIN -->\nfoo\n<!-- QR:END -->\n<!-- KB:BEGIN -->\nbar\n<!-- KB:END -->\n",
    async () => {
      const before = await readFile(INSTR, "utf8");
      const r = await ensureMarkers();
      const after = await readFile(INSTR, "utf8");
      assert.equal(r.fileExists, true);
      assert.equal(r.qrInserted, false);
      assert.equal(r.kbInserted, false);
      assert.equal(after, before, "file content unchanged");
    }
  );
});

// ── ensureMarkers: only QR missing ──────────────────────────────────────────

test("ensureMarkers inserts only QR when only QR missing", async () => {
  await withInstructions(
    "# header\n\n<!-- KB:BEGIN -->\n<!-- KB:END -->\n",
    async () => {
      const r = await ensureMarkers();
      assert.equal(r.qrInserted, true);
      assert.equal(r.kbInserted, false);
      const after = await readFile(INSTR, "utf8");
      assert.match(after, /## Operational Knowledge Base \(jit-memory\)/);
      assert.match(after, /### Quick Rules — managed by jit_memory_capture/);
      assert.match(after, /<!-- QR:BEGIN -->/);
      assert.match(after, /<!-- QR:END -->/);
      // KB block unchanged & not duplicated.
      assert.equal((after.match(/<!-- KB:BEGIN -->/g) || []).length, 1);
    }
  );
});

test("ensureMarkers inserts only QR subsection when OKB heading already exists", async () => {
  await withInstructions(
    "# header\n\n## Operational Knowledge Base (jit-memory)\n\n### Domain Index\n\n<!-- KB:BEGIN -->\n<!-- KB:END -->\n",
    async () => {
      const r = await ensureMarkers();
      assert.equal(r.qrInserted, true);
      assert.equal(r.kbInserted, false);
      const after = await readFile(INSTR, "utf8");
      assert.equal((after.match(/## Operational Knowledge Base \(jit-memory\)/g) || []).length, 1);
      assert.match(after, /### Quick Rules — managed by jit_memory_capture/);
      assert.equal((after.match(/<!-- KB:BEGIN -->/g) || []).length, 1);
    }
  );
});

test("ensureMarkers does not duplicate OKB heading with case or whitespace variation", async () => {
  await withInstructions(
    "# header\n\n## operational knowledge base (jit-memory)   \n\n### Domain Index\n\n<!-- KB:BEGIN -->\n<!-- KB:END -->\n",
    async () => {
      const r = await ensureMarkers();
      assert.equal(r.qrInserted, true);
      assert.equal(r.kbInserted, false);
      const after = await readFile(INSTR, "utf8");
      assert.equal((after.match(/^#{1,6}\s+operational knowledge base \(jit-memory\)\s*$/gim) || []).length, 1);
      assert.match(after, /### Quick Rules — managed by jit_memory_capture/);
      assert.equal((after.match(/<!-- KB:BEGIN -->/g) || []).length, 1);
    }
  );
});

// ── ensureMarkers: only KB missing ──────────────────────────────────────────

test("ensureMarkers inserts only KB when only KB missing", async () => {
  await withInstructions(
    "# header\n\n<!-- QR:BEGIN -->\n<!-- QR:END -->\n",
    async () => {
      const r = await ensureMarkers();
      assert.equal(r.qrInserted, false);
      assert.equal(r.kbInserted, true);
      const after = await readFile(INSTR, "utf8");
      assert.match(after, /## Operational Knowledge Base \(jit-memory\)/);
      assert.match(after, /### Domain Index/);
      assert.match(after, /<!-- KB:BEGIN -->/);
      assert.match(after, /<!-- KB:END -->/);
      assert.match(after, /\| Domain \| File \|/);
      assert.equal((after.match(/<!-- QR:BEGIN -->/g) || []).length, 1);
    }
  );
});

test("ensureMarkers inserts only KB subsection when OKB heading already exists", async () => {
  await withInstructions(
    "# header\n\n## Operational Knowledge Base (jit-memory)\n\n### Quick Rules — managed by jit_memory_capture\n\n<!-- QR:BEGIN -->\n<!-- QR:END -->\n",
    async () => {
      const r = await ensureMarkers();
      assert.equal(r.qrInserted, false);
      assert.equal(r.kbInserted, true);
      const after = await readFile(INSTR, "utf8");
      assert.equal((after.match(/## Operational Knowledge Base \(jit-memory\)/g) || []).length, 1);
      assert.match(after, /### Domain Index/);
      assert.match(after, /\| Domain \| File \|/);
      assert.equal((after.match(/<!-- QR:BEGIN -->/g) || []).length, 1);
    }
  );
});

// ── ensureMarkers: both missing ─────────────────────────────────────────────

test("ensureMarkers inserts both when both missing (namespaced form for fresh installs)", async () => {
  await withInstructions(
    "# user instructions\n\nSome content.\n",
    async () => {
      const r = await ensureMarkers();
      assert.equal(r.qrInserted, true);
      assert.equal(r.kbInserted, true);
      const after = await readFile(INSTR, "utf8");
      assert.equal((after.match(/## Operational Knowledge Base \(jit-memory\)/g) || []).length, 1);
      assert.match(after, /### Quick Rules — managed by jit_memory_capture/);
      assert.match(after, /### Domain Index/);
      assert.match(after, /<!-- jit-memory:QR:BEGIN -->/);
      assert.match(after, /<!-- jit-memory:QR:END -->/);
      assert.match(after, /<!-- jit-memory:KB:BEGIN -->/);
      assert.match(after, /<!-- jit-memory:KB:END -->/);
      assert.match(after, /<!-- jit-memory:QR:END -->\n\n### Domain Index/);
      // Original content preserved at top.
      assert.ok(after.startsWith("# user instructions\n"), "original prefix preserved");
    }
  );
});

test("ensureMarkers inserts both marker sections under an edited OKB heading (namespaced)", async () => {
  await withInstructions(
    "# header\n\n# Operational Knowledge Base (jit-memory)   \n\nExisting notes.\n",
    async () => {
      const r = await ensureMarkers();
      assert.equal(r.qrInserted, true);
      assert.equal(r.kbInserted, true);
      const after = await readFile(INSTR, "utf8");
      assert.equal((after.match(/^#{1,6}\s+Operational Knowledge Base \(jit-memory\)\s*$/gim) || []).length, 1);
      assert.match(after, /### Quick Rules — managed by jit_memory_capture/);
      assert.match(after, /### Domain Index/);
      assert.match(after, /<!-- jit-memory:QR:BEGIN -->/);
      assert.match(after, /<!-- jit-memory:KB:BEGIN -->/);
    }
  );
});

// ── ensureMarkers: idempotency ──────────────────────────────────────────────

test("ensureMarkers is idempotent (second run inserts nothing)", async () => {
  await withInstructions(
    "# header\nbody\n",
    async () => {
      await ensureMarkers();
      const afterFirst = await readFile(INSTR, "utf8");
      const r2 = await ensureMarkers();
      const afterSecond = await readFile(INSTR, "utf8");
      assert.equal(r2.qrInserted, false);
      assert.equal(r2.kbInserted, false);
      assert.equal(afterSecond, afterFirst, "second run leaves file unchanged");
    }
  );
});

// ── ensureMarkers: file lacks trailing newline ──────────────────────────────

test("ensureMarkers handles file without trailing newline", async () => {
  await withInstructions("# header\nno trailing newline", async () => {
    const r = await ensureMarkers();
    assert.equal(r.qrInserted, true);
    const after = await readFile(INSTR, "utf8");
    assert.ok(after.includes("# header\nno trailing newline\n"), "preserves original then appends");
    assert.match(after, /<!-- jit-memory:QR:BEGIN -->/);
  });
});

// ── ensureMarkers: tolerates partial marker pair (only BEGIN, no END) ────────

test("ensureMarkers refuses to write on malformed (orphan QR:BEGIN)", async () => {
  // Per fix #7 review: appending a fresh stub when an orphan BEGIN exists
  // would create a destructive marker range (orphan BEGIN paired with the
  // appended END), which capture/sync's casReplaceMarkers would later
  // overwrite. Bootstrap MUST refuse to write in this state and surface an
  // error for manual repair.
  const original =
    "# header\n<!-- QR:BEGIN -->\nstray content\n<!-- KB:BEGIN -->\n<!-- KB:END -->\n";
  await withInstructions(original, async () => {
    const r = await ensureMarkers();
    assert.equal(r.qrInserted, false);
    assert.equal(r.kbInserted, false);
    assert.equal(r.qrState, "malformed");
    assert.match(r.error, /malformed.*QR/);
    const after = await readFile(INSTR, "utf8");
    assert.equal(after, original, "file unchanged when malformed state detected");
  });
});

test("ensureMarkers refuses to write on duplicate KB markers", async () => {
  const original =
    "# header\n<!-- QR:BEGIN -->\n<!-- QR:END -->\n" +
    "<!-- KB:BEGIN -->\nfirst\n<!-- KB:END -->\n" +
    "<!-- KB:BEGIN -->\nsecond\n<!-- KB:END -->\n";
  await withInstructions(original, async () => {
    const r = await ensureMarkers();
    assert.equal(r.qrInserted, false);
    assert.equal(r.kbInserted, false);
    assert.equal(r.kbState, "malformed");
    assert.match(r.error, /malformed.*KB/);
    const after = await readFile(INSTR, "utf8");
    assert.equal(after, original, "file unchanged");
  });
});

test("ensureMarkers refuses to write on reversed markers (END before BEGIN)", async () => {
  const original =
    "# header\n<!-- QR:END -->\nstray\n<!-- QR:BEGIN -->\n" +
    "<!-- KB:BEGIN -->\n<!-- KB:END -->\n";
  await withInstructions(original, async () => {
    const r = await ensureMarkers();
    assert.equal(r.qrInserted, false);
    assert.equal(r.qrState, "malformed");
    assert.match(r.error, /malformed/);
  });
});

test("ensureMarkers refuses to append when QR markers use whitespace variants", async () => {
  const original =
    "# header\n<!--QR:BEGIN-->\nexisting\n<!-- QR:END  -->\n" +
    "<!-- KB:BEGIN -->\n<!-- KB:END -->\n";
  await withInstructions(original, async () => {
    const r = await ensureMarkers();
    assert.equal(r.qrInserted, false);
    assert.equal(r.kbInserted, false);
    assert.equal(r.qrState, "malformed");
    assert.match(r.error, /malformed.*QR/);
    const after = await readFile(INSTR, "utf8");
    assert.equal(after, original, "file unchanged when marker variants are present");
  });
});

// ── extension.mjs source-shape: joinSession({hooks, tools}) is used ─────────

test("extension.mjs registers hooks/tools via joinSession options", async () => {
  const src = await readFile(resolve("extension.mjs"), "utf8");
  // Must call joinSession with a config object containing hooks and tools.
  assert.match(src, /joinSession\(\s*\{\s*hooks\s*,\s*tools\s*\}\s*\)/);
  assert.match(src, /import\s+\{\s*syncNow,\s*drainSync,\s*requestSync\s*\}\s+from\s+"\.\/lib\/sync\.mjs"/);
  assert.match(src, /requestSync\(\{\s*debounceMs:\s*0\s*\}\)/);
  assert.match(src, /function\s+noticeOnce\s*\(/);
  assert.match(src, /drift-heal:notice/);
  assert.match(src, /result\.routingWritten\s*\|\|\s*kbRefresh/);
  // Must NOT use the non-existent rpc.register* APIs (call sites, not comments).
  assert.doesNotMatch(src, /^[^\/\n]*\bsession\.rpc\.registerHooks\s*\(/m);
  assert.doesNotMatch(src, /^[^\/\n]*\bsession\.rpc\.registerTool\s*\(/m);
  // Bootstrap must be wired in.
  assert.match(src, /ensureMarkers\s*\(/);
  // Session-end must drain pending sync work.
  assert.match(src, /import\s+\{\s*syncNow,\s*drainSync,\s*requestSync\s*\}\s+from\s+"\.\/lib\/sync\.mjs"/);
  assert.match(src, /onSessionEnd[\s\S]*?drainSync\s*\(/);
  // Bootstrap result is gated for marker-dependent tools (race fix from
  // rubber-duck review of fix #7); the gate now also awaits migration and
  // refuses writes when the migration is blocked (item #1).
  assert.match(src, /gateOnReady\s*\(/);
  // Fire-and-forget bootstrap must have a terminal .catch().
  assert.match(src, /ensureMarkers\(\)[\s\S]*?\.catch\s*\(/);
  // Startup diagnostics must not silently drop warnings before joinSession
  // binds a session logger, and initialization failure should be actionable.
  assert.match(src, /const\s+PRE_SESSION_WARN_LIMIT\s*=/);
  assert.match(src, /function\s+makePreSessionWarnBuffer\s*\(/);
  assert.match(src, /let\s+warn\s*=\s*preSessionWarn\.warn/);
  assert.match(src, /try\s*\{\s*session\s*=\s*await\s+joinSession\(\s*\{\s*hooks\s*,\s*tools\s*\}\s*\)/);
  assert.match(src, /process\.stderr\.write\(`jit-memory: failed to initialize extension session:/);
  assert.match(src, /preSessionWarn\.flush\(session\)/);
});

// ── casReplaceMarkers fail-closed on malformed (writer-side defense) ────────

test("casReplaceMarkers refuses to replace when 2 BEGIN / 1 END (duplicate)", async () => {
  const path = join(tmp, "cas-malformed-1.md");
  const original = "head\n<!-- M:BEGIN -->\nA\n<!-- M:END -->\n<!-- M:BEGIN -->\nB\n";
  await writeFile(path, original, "utf8");
  let called = false;
  const r = await casReplaceMarkers(path, "<!-- M:BEGIN -->", "<!-- M:END -->", () => {
    called = true;
    return "replacement";
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, "malformed");
  assert.equal(called, false, "buildInner must not be invoked on malformed state");
  const after = await readFile(path, "utf8");
  assert.equal(after, original, "file content unchanged");
});

test("casReplaceMarkers refuses on 1 BEGIN / 2 END", async () => {
  const path = join(tmp, "cas-malformed-2.md");
  const original = "head\n<!-- M:BEGIN -->\nA\n<!-- M:END -->\nstray\n<!-- M:END -->\n";
  await writeFile(path, original, "utf8");
  const r = await casReplaceMarkers(path, "<!-- M:BEGIN -->", "<!-- M:END -->", () => "x");
  assert.equal(r.status, "malformed");
  const after = await readFile(path, "utf8");
  assert.equal(after, original);
});

test("casReplaceMarkers refuses when END appears before BEGIN", async () => {
  const path = join(tmp, "cas-malformed-3.md");
  const original = "head\n<!-- M:END -->\nstray\n<!-- M:BEGIN -->\n";
  await writeFile(path, original, "utf8");
  const r = await casReplaceMarkers(path, "<!-- M:BEGIN -->", "<!-- M:END -->", () => "x");
  assert.equal(r.status, "malformed");
  const after = await readFile(path, "utf8");
  assert.equal(after, original);
});

test("casReplaceMarkers refuses on 2 BEGIN / 2 END (duplicate paired blocks)", async () => {
  const path = join(tmp, "cas-malformed-4.md");
  const original =
    "head\n<!-- M:BEGIN -->\nA\n<!-- M:END -->\n" +
    "<!-- M:BEGIN -->\nB\n<!-- M:END -->\n";
  await writeFile(path, original, "utf8");
  const r = await casReplaceMarkers(path, "<!-- M:BEGIN -->", "<!-- M:END -->", () => "x");
  assert.equal(r.status, "malformed", "even well-paired duplicates are malformed (only one managed block allowed)");
  const after = await readFile(path, "utf8");
  assert.equal(after, original);
});

test("casReplaceMarkers still works on a single well-formed pair", async () => {
  const path = join(tmp, "cas-ok.md");
  await writeFile(path, "head\n<!-- M:BEGIN -->\nold\n<!-- M:END -->\ntail\n", "utf8");
  const r = await casReplaceMarkers(path, "<!-- M:BEGIN -->", "<!-- M:END -->", () => "new");
  assert.equal(r.ok, true);
  assert.equal(r.status, "ok");
  const after = await readFile(path, "utf8");
  assert.match(after, /<!-- M:BEGIN -->\nnew\n<!-- M:END -->/);
});

// ── capture surfaces invalid_setup on malformed QR markers ──────────────────

test("capture(quick_rule) returns invalid_setup when QR markers are malformed", async () => {
  // Write malformed QR (orphan BEGIN with no END) into instructions; KB ok.
  await writeFile(
    INSTR,
    "# header\n<!-- QR:BEGIN -->\nstray\n<!-- KB:BEGIN -->\n<!-- KB:END -->\n",
    "utf8"
  );
  try {
    const r = await capture({ kind: "quick_rule", content: "test rule" });
    assert.equal(r.status, "invalid_setup");
    assert.match(r.summary, /QR.*malformed/);
    // File must NOT have been mutated by capture.
    const after = await readFile(INSTR, "utf8");
    assert.match(after, /<!-- QR:BEGIN -->\nstray\n/);
    // No QR:END inserted by capture.
    assert.equal((after.match(/<!-- QR:END -->/g) || []).length, 0);
  } finally {
    await rm(INSTR, { force: true });
  }
});
