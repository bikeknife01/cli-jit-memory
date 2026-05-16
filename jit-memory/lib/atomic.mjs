// Atomic file writes, advisory file-locks, CAS marker replacement.
// Cross-platform: same-dir temp + rename, retry on EPERM/EACCES (Windows AV).
//
// Windows lock note: fs.open(<file>.lock, O_CREAT|O_EXCL) can return EPERM
// or EACCES (instead of the POSIX-standard EEXIST) when the lock file is
// currently held open by another process. withLock handles this by checking
// whether the lock file exists on EPERM/EACCES; if it does, the error is
// treated as lock-held and the normal stale/retry path runs.
//
// If the lock file does not exist on EPERM/EACCES, this is either a TOCTOU
// race (the lock was released between O_EXCL failing and the existence check)
// or a genuine permission error (the caller lacks write access to the
// directory). The code retries up to MAX_PERM_RETRIES times in that case;
// after that threshold the original error is re-thrown so genuine permission
// failures surface as the real error code rather than ELOCKBUSY.

import { promises as fs, constants as fsc } from "node:fs";
import { dirname, basename, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { classifyMarkerPair } from "./markers.mjs";

const LOCK_SUFFIX = ".lock";
const TEMP_PREFIX = ".tmp-";
const SHA_ALGO = "sha256";

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
  try { await fs.unlink(tmpPath); } catch { }
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
//
// On ENOENT (lock parent does not yet exist — e.g. a fresh-install audit run
// where knowledge/ has never been created), mkdir the parent recursively and
// retry. The mkdir is lazy to avoid changing relative timing for callers
// whose parent already exists (which is the common case).
//
// While the lock is held, a heartbeat refreshes the lock file's mtime every
// staleMs/3 so that slow operations (large EXDEV migration, EPERM-retry
// storm under AV) are not falsely classified as stale by another waiter
// (item #5). The heartbeat is best-effort; if a single touch fails the
// lock semantics are unaffected on the next successful touch.
export async function withLock(filePath, fn, { timeoutMs = 2000, staleMs = 30000 } = {}) {
  const lockPath = filePath + LOCK_SUFFIX;
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  let mkdirAttempted = false;
  // How many consecutive times EPERM/EACCES was seen with no lock file present.
  // Used to distinguish a TOCTOU race (small count, lock was briefly released)
  // from a genuine permission error (persistent count → re-throw).
  const MAX_PERM_RETRIES = 5;
  let permErrCount = 0;

  while (!acquired) {
    try {
      const fh = await fs.open(lockPath, fsc.O_CREAT | fsc.O_EXCL | fsc.O_WRONLY);
      try { await fh.write(`${process.pid}\n${Date.now()}\n`); }
      catch { /* ignore — content is informational only */ }
      await fh.close();
      acquired = true;
    } catch (e) {
      if (e.code === "ENOENT" && !mkdirAttempted) {
        // Lock parent doesn't exist yet — create it and retry.
        mkdirAttempted = true;
        await fs.mkdir(dirname(lockPath), { recursive: true });
        continue;
      }
      // EEXIST is the POSIX-standard response for O_CREAT|O_EXCL on an
      // existing file. On Windows, an existing lock file held open by another
      // process can yield EPERM or EACCES instead. Stat the lock path to
      // distinguish "lock held" from a genuine permission error.
      // TOCTOU note: if the lock was released between the EPERM and our
      // fs.access() check, lockExists will be false — continue to retry
      // the acquire rather than re-throwing EPERM as fatal.
      if (e.code !== "EEXIST") {
        if (e.code === "EPERM" || e.code === "EACCES") {
          let lockExists = false;
          try { await fs.access(lockPath); lockExists = true; } catch {}
          if (!lockExists) {
            // Either a TOCTOU race (lock just released) or a genuine
            // permission error. Retry up to MAX_PERM_RETRIES times; if the
            // error persists beyond that, surface the original EPERM/EACCES.
            if (++permErrCount > MAX_PERM_RETRIES) throw e;
            continue;
          }
          permErrCount = 0; // file confirmed held-open; reset counter
          // fall through to stale/retry
        } else {
          throw e;
        }
      }
      permErrCount = 0; // EEXIST: lock confirmed present; reset counter
      // Lock held — check if stale.
      let st;
      try { st = await fs.stat(lockPath); }
      catch (e2) { if (e2.code === "ENOENT") continue; throw e2; }
      if (Date.now() - st.mtimeMs > staleMs) {
        // Try to remove the stale lock. Race: if another process also tries,
        // one will fail with ENOENT — we just retry the acquire loop either way.
        try { await fs.unlink(lockPath); } catch { }
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

  // Heartbeat: refresh the lock's mtime well before staleMs elapses so
  // a slow holder is not falsely judged stale by a concurrent waiter.
  const heartbeatPeriod = Math.max(50, Math.floor(staleMs / 3));
  const heartbeat = setInterval(async () => {
    const now = new Date();
    try { await fs.utimes(lockPath, now, now); }
    catch { /* race: lock may already be gone after fn() finished */ }
  }, heartbeatPeriod);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
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
      const endIdx = fresh.content.indexOf(endMarker, startIdx + beginMarker.length);

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
      const after = fresh.content.slice(endIdx);
      const next = before + (newInner.startsWith("\n") ? newInner : `\n${newInner}`) +
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
