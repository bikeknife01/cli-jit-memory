// Atomic file writes, advisory file-locks, CAS marker replacement.
// Cross-platform: same-dir temp + rename, retry on EPERM/EACCES (Windows AV).

import { promises as fs, constants as fsc } from "node:fs";
import { dirname, basename, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { classifyMarkerPair } from "./markers.mjs";

const LOCK_SUFFIX  = ".lock";
const TEMP_PREFIX  = ".tmp-";
const SHA_ALGO     = "sha256";

function sha256(data) {
  return createHash(SHA_ALGO).update(data).digest("hex");
}

function jitter(base, factor = 0.5) {
  return Math.floor(base * (1 - factor + Math.random() * factor * 2));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── atomicWrite ────────────────────────────────────────────────────────────
// Same-directory temp file → fsync → rename. Retries EPERM/EACCES (Windows
// antivirus / editor lock). Never falls back to copyFile+unlink — that's not
// atomic.
export async function atomicWrite(targetPath, content, { encoding = "utf8", retries = 5 } = {}) {
  const dir = dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  const tmpName = `${TEMP_PREFIX}${basename(targetPath)}.${process.pid}.${randomBytes(4).toString("hex")}`;
  const tmpPath = join(dir, tmpName);

  // Write + fsync.
  const fh = await fs.open(tmpPath, "w");
  try {
    await fh.writeFile(content, { encoding });
    try { await fh.sync(); } catch { /* ignore — best effort */ }
  } finally {
    await fh.close();
  }

  // Rename with retry. fs.rename replaces on Windows in modern Node.
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      await fs.rename(tmpPath, targetPath);
      return;
    } catch (e) {
      lastErr = e;
      if (e.code !== "EPERM" && e.code !== "EACCES" && e.code !== "EBUSY") break;
      await sleep(jitter(50 * (i + 1)));
    }
  }
  // Cleanup tmp on failure (best effort).
  try { await fs.unlink(tmpPath); } catch {}
  throw lastErr;
}

// ─── readWithStat ───────────────────────────────────────────────────────────
// Returns content + mtime + sha256 — used by CAS replace to detect changes.
export async function readWithStat(path, { encoding = "utf8" } = {}) {
  const stat = await fs.stat(path);
  const content = await fs.readFile(path, { encoding });
  return { content, mtimeMs: stat.mtimeMs, size: stat.size, sha256: sha256(content) };
}

export async function readWithStatOrNull(path, opts) {
  try { return await readWithStat(path, opts); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
}

// ─── withLock ───────────────────────────────────────────────────────────────
// Advisory file lock: fs.open(<file>.lock, "wx") — exclusive create.
// Stale lock removal: if mtime older than staleMs, force-unlink and retry.
// Bounded wait via timeoutMs.
export async function withLock(filePath, fn, { timeoutMs = 2000, staleMs = 30000 } = {}) {
  const lockPath = filePath + LOCK_SUFFIX;
  const deadline = Date.now() + timeoutMs;
  let acquired = false;

  while (!acquired) {
    try {
      const fh = await fs.open(lockPath, fsc.O_CREAT | fsc.O_EXCL | fsc.O_WRONLY);
      try { await fh.write(`${process.pid}\n${Date.now()}\n`); }
      catch { /* ignore — content is informational only */ }
      await fh.close();
      acquired = true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // Lock held — check if stale.
      let st;
      try { st = await fs.stat(lockPath); }
      catch (e2) { if (e2.code === "ENOENT") continue; throw e2; }
      if (Date.now() - st.mtimeMs > staleMs) {
        // Try to remove the stale lock. Race: if another process also tries,
        // one will fail with ENOENT — we just retry the acquire loop either way.
        try { await fs.unlink(lockPath); } catch {}
        continue;
      }
      if (Date.now() >= deadline) {
        const err = new Error(`withLock: timeout acquiring ${lockPath}`);
        err.code = "ELOCKBUSY";
        throw err;
      }
      await sleep(jitter(75));
    }
  }

  try {
    return await fn();
  } finally {
    try { await fs.unlink(lockPath); } catch { /* best effort */ }
  }
}

// ─── casReplaceMarkers ──────────────────────────────────────────────────────
// Replaces text between beginMarker and endMarker (markers preserved in place)
// using a callback that rebuilds the new inner content from FRESH file state
// on each attempt. The whole read-build-write cycle runs under withLock(path)
// so cooperative writers cannot race the final stat-check-then-rename. Non-
// cooperative writers (e.g. a user editing the file by hand) can still cause
// CAS retries; the callback rebuilds against their latest content correctly.
//
// Bounded retries; returns { ok, status } where status ∈
//   ok | conflict | missing | noop | build_error
//
// `buildInner(freshContent, freshInner)` MUST be a (sync or async) function
// that returns the new inner string, or returns null/undefined to signal a
// no-op (status: "noop").
//
// On success, atomic-writes the new file content.
export async function casReplaceMarkers(path, beginMarker, endMarker, buildInner, { retries = 3 } = {}) {
  if (typeof buildInner !== "function") {
    throw new TypeError("casReplaceMarkers: buildInner must be a (freshContent, freshInner) callback");
  }
  // Marker invariant: a managed block is delimited by EXACTLY one beginMarker
  // and EXACTLY one endMarker, with end positioned strictly after begin.
  // Any other shape — orphan, duplicate, nested, reversed — is unsafe to
  // replace because the first-BEGIN..first-END span could envelop unrelated
  // user content. Caller must repair manually (or via the bootstrap module
  // when the state is "missing").
  return await withLock(path, async () => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const fresh = await readWithStat(path);
      const state = classifyMarkerPair(fresh.content, beginMarker, endMarker);
      if (state === "missing") {
        return { ok: false, status: "missing" };
      }
      if (state === "malformed") {
        // Fail closed: do not attempt a partial replacement on a malformed
        // managed block. Caller surfaces this as invalid_setup.
        return { ok: false, status: "malformed" };
      }
      const startIdx = fresh.content.indexOf(beginMarker);
      const endIdx   = fresh.content.indexOf(endMarker, startIdx + beginMarker.length);

      const freshInner = fresh.content.slice(startIdx + beginMarker.length, endIdx);

      let newInner;
      try {
        newInner = await buildInner(fresh.content, freshInner);
      } catch (e) {
        return { ok: false, status: "build_error", error: e?.message || String(e) };
      }
      if (newInner === null || newInner === undefined) {
        return { ok: true, status: "noop" };
      }
      if (typeof newInner !== "string") {
        return { ok: false, status: "build_error", error: "buildInner must return a string or null/undefined" };
      }

      const before = fresh.content.slice(0, startIdx + beginMarker.length);
      const after  = fresh.content.slice(endIdx);
      const next   = before + (newInner.startsWith("\n") ? newInner : `\n${newInner}`) +
                     (newInner.endsWith("\n") ? "" : "\n") + after;

      // Final stat check immediately before write — catches non-cooperative
      // writers (e.g. user hand-editing) that don't honor the lock.
      const fresh2 = await readWithStat(path);
      if (fresh2.mtimeMs !== fresh.mtimeMs || fresh2.sha256 !== fresh.sha256) {
        if (attempt === retries) return { ok: false, status: "conflict" };
        await sleep(jitter(50 * (attempt + 1)));
        continue;
      }

      await atomicWrite(path, next);
      return { ok: true, status: "ok" };
    }
    return { ok: false, status: "conflict" };
  });
}
