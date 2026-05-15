// One-shot migration of the legacy in-extension knowledge folder
// (${EXT_ROOT}/knowledge) to the new user-data home
// (${homedir()}/.copilot/jit-memory/knowledge). See lib/paths.mjs for the
// resolution rules.
//
// Goals:
//   * Idempotent. Safe under concurrent CLI sessions (advisory lock on
//     ${JITMEM_DATA_ROOT}/migrate).
//   * Never destroys user data on its own. Cross-device copy preserves the
//     source by renaming legacy to ${legacy}.migrated-<timestamp>/.
//   * Never writes infrastructure files (logs, routing cache) into the new
//     KNOWLEDGE_ROOT before successful migration — doing so would prevent
//     future runs from detecting that legacy still owns the user content.
//   * On collision/failure, sets `migrationBlocked` so capture/audit-write
//     paths refuse with a clear `invalid_setup` until manual repair.
//   * Routing/read paths remain fail-open even when blocked.
//
// Public surface:
//   migrateKnowledgeIfNeeded()        async — performs (or skips) migration
//   isMigrationBlocked()              boolean
//   isMigrationBlockingResult(result) boolean
//   migrationReady()                  Promise of the last result
//   _runMigrationForTests({ legacy, newPath, dataRoot })  for unit tests
//   _resetMigrationStateForTests()    for unit tests

import { promises as fs } from "node:fs";
import { join, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import {
  KNOWLEDGE_ROOT, LEGACY_KNOWLEDGE_ROOT, JITMEM_DATA_ROOT, PATH_OVERRIDES_ACTIVE
} from "./paths.mjs";
import { withLock } from "./atomic.mjs";
import { logEvent } from "./jitlog.mjs";

const STAGING_PREFIX = "knowledge.migrating-";

// Files we own under KNOWLEDGE_ROOT that don't count as user content.
const INFRA_NAMES = new Set([
  "_routing.json",
  "_usage.json",
  "_jit-memory.log",
  "_jit-memory.log.1",
  "_curator-digest.md",
  "_qr-meta.json",
  "_drift-note.json",
  "MIGRATED.txt",
  // Common OS sync detritus — ignore so OneDrive/iCloud-synced KBs don't
  // trigger phantom user content.
  ".DS_Store",
  "desktop.ini",
  "Thumbs.db"
]);

function isInfraName(name) {
  if (INFRA_NAMES.has(name)) return true;
  if (name.endsWith(".lock")) return true;
  if (name.startsWith(".tmp-")) return true;        // atomic temp leftovers
  return false;
}

// Recursively check whether `rootPath` contains any file that is not
// infrastructure. Empty/missing/infra-only → false.
export async function hasUserContent(rootPath) {
  let entries;
  try {
    entries = await fs.readdir(rootPath, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return false;
    throw e;
  }
  for (const e of entries) {
    if (isInfraName(e.name)) continue;
    if (e.isDirectory()) {
      // Recurse — protocols/, _archive/, or any user-created subdir.
      if (await hasUserContent(join(rootPath, e.name))) return true;
    } else if (e.isFile() || e.isSymbolicLink()) {
      return true;
    }
  }
  return false;
}

// Look for `knowledge.migrating-*` directories under dataRoot. Returns sorted
// absolute paths. ENOENT on dataRoot yields [].
export async function findStagingDirs(dataRoot) {
  let entries;
  try {
    entries = await fs.readdir(dataRoot, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return [];
    throw e;
  }
  return entries
    .filter(e => e.isDirectory() && e.name.startsWith(STAGING_PREFIX))
    .map(e => join(dataRoot, e.name))
    .sort();
}

// Recursively unlink infra files and rmdir empty directories. After this,
// `rootPath` itself is rmdir'd if it is empty. Best-effort: ENOENT swallowed,
// other errors propagate so callers can decide.
export async function removeInfraOnly(rootPath) {
  let entries;
  try {
    entries = await fs.readdir(rootPath, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return;
    throw e;
  }
  for (const e of entries) {
    const p = join(rootPath, e.name);
    if (e.isDirectory()) {
      await removeInfraOnly(p);                     // recurse
      // Only rmdir if now empty
      try { await fs.rmdir(p); } catch { /* not empty or vanished */ }
    } else if (isInfraName(e.name)) {
      try { await fs.unlink(p); } catch { /* race */ }
    }
  }
  try { await fs.rmdir(rootPath); } catch { /* not empty or vanished */ }
}

// Best-effort recursive remove; never throws.
async function rmrfBestEffort(path) {
  try { await fs.rm(path, { recursive: true, force: true }); }
  catch { /* swallow */ }
}

// Recursive copy. Uses fs.cp (Node 20+).
async function copyDirectoryTree(src, dst) {
  await fs.cp(src, dst, { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true });
}

async function sha256OfFile(path) {
  const h = createHash("sha256");
  const buf = await fs.readFile(path);
  h.update(buf);
  return { sha: h.digest("hex"), size: buf.length };
}

// Walk a directory tree, returning relative file paths (forward-slash
// normalized) for every regular file. Symlinks/directories themselves not
// listed; nested files inside directories are.
async function walkRelativeFiles(rootPath, prefix = "") {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(rootPath, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return out;
    throw e;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push(...await walkRelativeFiles(join(rootPath, e.name), rel));
    } else if (e.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

// Verify a copy by hashing every regular file in src and dst and comparing.
async function verifyCopy(src, dst) {
  const srcFiles = (await walkRelativeFiles(src)).sort();
  const dstFiles = (await walkRelativeFiles(dst)).sort();
  if (srcFiles.length !== dstFiles.length) {
    return { ok: false, fileCount: dstFiles.length, bytes: 0,
             details: `file count mismatch: src=${srcFiles.length} dst=${dstFiles.length}` };
  }
  for (let i = 0; i < srcFiles.length; i++) {
    if (srcFiles[i] !== dstFiles[i]) {
      return { ok: false, fileCount: dstFiles.length, bytes: 0,
               details: `path mismatch at index ${i}: src=${srcFiles[i]} dst=${dstFiles[i]}` };
    }
  }
  let totalBytes = 0;
  for (const rel of srcFiles) {
    const a = await sha256OfFile(join(src, rel));
    const b = await sha256OfFile(join(dst, rel));
    if (a.sha !== b.sha || a.size !== b.size) {
      return { ok: false, fileCount: srcFiles.length, bytes: totalBytes,
               details: `content mismatch: ${rel}` };
    }
    totalBytes += b.size;
  }
  return { ok: true, fileCount: srcFiles.length, bytes: totalBytes };
}

async function scanCount(rootPath) {
  const files = await walkRelativeFiles(rootPath);
  let bytes = 0;
  for (const rel of files) {
    try { bytes += (await fs.stat(join(rootPath, rel))).size; } catch {}
  }
  return { fileCount: files.length, bytes };
}

function timestamp(d = new Date()) {
  const pad = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}` +
         `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

// Generate a path that does not currently exist by appending a suffix on
// collision. Used so the EXDEV-preserved legacy directory never overwrites
// an existing sibling from a previous attempt.
async function uniquePath(base) {
  if (!(await exists(base))) return base;
  for (let i = 2; i < 1000; i++) {
    const cand = `${base}-${i}`;
    if (!(await exists(cand))) return cand;
  }
  return `${base}-${process.pid}-${Date.now()}`;
}

async function exists(p) {
  try { await fs.access(p); return true; }
  catch (e) { if (e.code === "ENOENT") return false; throw e; }
}

async function isSymlink(p) {
  try { return (await fs.lstat(p)).isSymbolicLink(); }
  catch (e) { if (e.code === "ENOENT") return false; throw e; }
}

// Test seam: allow simulating fs.rename / fs.cp failures from unit tests.
// Hooks are reset between tests via _setMigrateTestHooks({}).
const _testHooks = {
  rename: null,    // (from, to) => Promise — return a rejection to simulate
  copyDir: null    // (src, dst) => Promise — return a rejection to simulate
};
export function _setMigrateTestHooks(hooks = {}) {
  _testHooks.rename  = hooks.rename  ?? null;
  _testHooks.copyDir = hooks.copyDir ?? null;
}
async function hookedRename(from, to) {
  if (_testHooks.rename) await _testHooks.rename(from, to);
  return await fs.rename(from, to);
}
async function hookedCopyDir(src, dst) {
  if (_testHooks.copyDir) await _testHooks.copyDir(src, dst);
  return await copyDirectoryTree(src, dst);
}

// ─── module state ───────────────────────────────────────────────────────────

const _state = {
  ready:   Promise.resolve({ status: "not_run" }),
  result:  null,
  blocked: false
};

export function isMigrationBlocked() { return _state.blocked; }
export function migrationLastResult() { return _state.result; }
export function migrationReady()      { return _state.ready; }

// A migration result is "blocking" iff it leaves the new KNOWLEDGE_ROOT in an
// ambiguous or known-bad state. Capture/audit-write paths must refuse while
// any of these are the most recent result.
const BLOCKING_STATUSES = new Set([
  "collision",
  "verify_failed",
  "race_aborted",
  "staging_present",
  "unsupported_topology",
  "error"
]);

export function isMigrationBlockingResult(result) {
  return !!(result && BLOCKING_STATUSES.has(result.status));
}

export function _resetMigrationStateForTests() {
  _state.ready   = Promise.resolve({ status: "not_run" });
  _state.result  = null;
  _state.blocked = false;
}

// ─── core algorithm ─────────────────────────────────────────────────────────

async function _runUnderLock({ legacy, newPath, dataRoot }) {
  // Re-lstat under lock — topology may have changed.
  for (const p of [legacy, newPath]) {
    if (await isSymlink(p)) {
      return { status: "unsupported_topology", path: p };
    }
  }
  // Rescan staging — pre-lock observation was a hint only.
  const staging = await findStagingDirs(dataRoot).catch(() => []);
  if (staging.length > 0) {
    return { status: "staging_present", paths: staging };
  }

  const newHasUser    = await hasUserContent(newPath);
  const legacyHasUser = await hasUserContent(legacy);

  if (newHasUser && legacyHasUser) {
    return { status: "collision", legacy, new: newPath };
  }
  if (newHasUser && !legacyHasUser) {
    return { status: "already_migrated" };
  }
  if (!newHasUser && !legacyHasUser) {
    await fs.mkdir(newPath, { recursive: true });
    return { status: "nothing_to_migrate" };
  }

  // Migrate path: !newHasUser && legacyHasUser.
  const startMs = Date.now();
  const ts = timestamp();
  const stagingPath = join(dataRoot, `${STAGING_PREFIX}${process.pid}-${ts}`);

  // Step 1: stage the legacy data.
  let method = null;
  let fileCount = 0;
  let bytes = 0;

  try {
    try {
      await hookedRename(legacy, stagingPath);
      method = "rename";
    } catch (e) {
      if (e.code !== "EXDEV") {
        return { status: "error", error: `legacy→staging rename failed: ${e.message}` };
      }
      // Cross-device: copy legacy → staging, verify, then rename-aside legacy.
      try {
        await hookedCopyDir(legacy, stagingPath);
      } catch (ce) {
        await rmrfBestEffort(stagingPath);
        return { status: "verify_failed", details: `copy failed: ${ce.message}` };
      }
      const v = await verifyCopy(legacy, stagingPath);
      if (!v.ok) {
        await rmrfBestEffort(stagingPath);
        return { status: "verify_failed", details: v.details };
      }
      // Preserve legacy by rename-aside. Use uniquePath so a pre-existing
      // sibling from a previous attempt does not block the rename.
      const preservedLegacy = await uniquePath(`${legacy}.migrated-${ts}`);
      try { await fs.rename(legacy, preservedLegacy); }
      catch (re) {
        await rmrfBestEffort(stagingPath);
        return { status: "error", error: `preserve legacy rename failed: ${re.message}`, staging: stagingPath };
      }
      method = "copy";
      fileCount = v.fileCount;
      bytes = v.bytes;
    }
  } catch (e) {
    return { status: "error", error: `staging step failed: ${e.message}`, staging: stagingPath };
  }

  // After this point staging exists and contains the user data. Any failure
  // result MUST include `staging` so the user can recover.
  if (method === "rename") {
    try {
      const c = await scanCount(stagingPath);
      fileCount = c.fileCount;
      bytes = c.bytes;
    } catch (e) {
      return { status: "error", error: `staging scan failed: ${e.message}`, staging: stagingPath };
    }
  }

  // Step 2: clean infra-only state from the new root so the final rename
  // succeeds (Windows: rename onto an existing dir throws even if empty).
  try { await removeInfraOnly(newPath); }
  catch (e) {
    return { status: "error", error: `cleanup new root: ${e.message}`, staging: stagingPath };
  }
  if (await hasUserContent(newPath)) {
    // Race: someone wrote user content between classify and clean. Leave
    // staging in place for manual recovery.
    return { status: "race_aborted", staging: stagingPath };
  }
  // Re-lstat new path right before final rename.
  if (await isSymlink(newPath)) {
    return { status: "unsupported_topology", path: newPath, staging: stagingPath };
  }
  // Step 3: final rename. Same-volume by construction (staging shares parent).
  try {
    await hookedRename(stagingPath, newPath);
  } catch (e) {
    if (e.code === "EEXIST" || e.code === "ENOTEMPTY" || e.code === "EPERM") {
      return { status: "race_aborted", staging: stagingPath };
    }
    return { status: "error", error: `final rename: ${e.message}`, staging: stagingPath };
  }

  // Step 4: breadcrumb (best-effort) — only if the legacy parent still exists.
  try {
    const breadcrumbDir = dirname(legacy);
    await fs.access(breadcrumbDir);
    const breadcrumb = join(breadcrumbDir, `${basename(legacy)}.MIGRATED.txt`);
    const body = `Knowledge files migrated to: ${newPath}\nAt: ${new Date().toISOString()}\nMethod: ${method}\n`;
    await fs.writeFile(breadcrumb, body, "utf8");
  } catch { /* best-effort */ }

  // Step 5: now safe to write into the new root — it contains the full data.
  await logEvent("kb_migration", {
    from: legacy, to: newPath, method, durationMs: Date.now() - startMs,
    fileCount, bytes
  });

  return {
    status: "migrated",
    method,
    from: legacy, to: newPath,
    durationMs: Date.now() - startMs,
    fileCount, bytes
  };
}

// Internal entry point taking explicit paths — used by tests and by the
// public wrapper.
export async function _runMigrationForTests({ legacy, newPath, dataRoot }) {
  // Pre-lock topology check.
  for (const p of [legacy, newPath]) {
    try {
      const st = await fs.lstat(p);
      if (st.isSymbolicLink()) return { status: "unsupported_topology", path: p };
    } catch (e) {
      if (e.code !== "ENOENT") {
        return { status: "error", error: `pre-lock lstat ${p}: ${e.message}` };
      }
    }
  }
  // Pre-lock staging hint.
  const stagingHint = await findStagingDirs(dataRoot).catch(() => []);
  // Pre-lock fast path: only safe if no staging AND new has user content AND legacy doesn't.
  if (stagingHint.length === 0) {
    const preNew    = await hasUserContent(newPath);
    const preLegacy = await hasUserContent(legacy);
    if (preNew && !preLegacy) return { status: "already_migrated" };
  }

  // Ensure dataRoot exists for the lock.
  await fs.mkdir(dataRoot, { recursive: true });

  return await withLock(
    join(dataRoot, "migrate"),
    () => _runUnderLock({ legacy, newPath, dataRoot }),
    { timeoutMs: 60_000, staleMs: 5 * 60_000 }
  );
}

export async function migrateKnowledgeIfNeeded() {
  if (PATH_OVERRIDES_ACTIVE) {
    const r = { status: "skipped_override" };
    _state.result = r;
    _state.blocked = false;
    _state.ready = Promise.resolve(r);
    return r;
  }
  const work = (async () => {
    let r;
    try {
      r = await _runMigrationForTests({
        legacy:   LEGACY_KNOWLEDGE_ROOT,
        newPath:  KNOWLEDGE_ROOT,
        dataRoot: JITMEM_DATA_ROOT
      });
    } catch (e) {
      // withLock timeout → another session is migrating; classify as transient
      // and recoverable. gateOnReady will retry on the next tool call.
      if (e?.code === "ELOCKBUSY") {
        r = { status: "migration_in_progress", lockMessage: e.message };
      } else {
        r = { status: "error", error: e?.message || String(e) };
      }
    }
    _state.result  = r;
    _state.blocked = isMigrationBlockingResult(r);
    return r;
  })();
  _state.ready = work;
  return await work;
}
