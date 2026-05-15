// Sync: regenerate _routing.json + KB block in copilot-instructions.md from
// the frontmatter of every domain file. Single-flight + dirty-flag coalescing.

import { promises as fs } from "node:fs";
import { join, relative } from "node:path";
import { KNOWLEDGE_ROOT, ROUTING_JSON, INSTRUCTIONS_MD, ARCHIVE_DIR } from "./paths.mjs";
import { atomicWrite, withLock, readWithStatOrNull, casReplaceMarkers } from "./atomic.mjs";
import { parse, validateMeta } from "./frontmatter.mjs";
import { invalidateRoutingCache } from "./router.mjs";
import { registerTestHooks } from "./test-hook-registry.mjs";
import { pruneUsageDomains, usageDomainsForFile } from "./usage.mjs";
import { logEvent } from "./jitlog.mjs";
import { pickMarkerPair } from "./markers.mjs";

export const KB_BEGIN = "<!-- KB:BEGIN -->";          // legacy, read-write supported
export const KB_END   = "<!-- KB:END -->";            // legacy, read-write supported
// Item #9: namespaced form for new installs.
export const KB_BEGIN_NS = "<!-- jit-memory:KB:BEGIN -->";
export const KB_END_NS   = "<!-- jit-memory:KB:END -->";

// Cross-process lock spanning the entire sync pass (list -> parse -> write
// routing -> write KB). Prevents two CLI sessions from racing each other and
// having an older snapshot win the final write.
const SYNC_LOCK = join(KNOWLEDGE_ROOT, "_sync.lock");

// ── single-flight + dirty-flag coalescing ───────────────────────────────────
let timer    = null;
let inFlight = null;
let dirty    = false;
let syncOnceImpl = _syncOnceReal;
let readRoutingFileImpl = path => fs.readFile(path, "utf8");
let lastRoutingReadFailureSignature = null;

export function requestSync(opts = {}) {
  // Fire-and-forget. Used by hooks. Errors swallowed at boundary.
  return _schedule(opts).catch(() => undefined);
}

export function syncNow(opts = {}) {
  // Awaitable. Used by tools/audit/cli.
  return _schedule(opts);
}

export async function drainSync({ maxPasses = 5 } = {}) {
  let passes = 0;
  let lastError = null;
  let lastPassOk = true;
  while (passes < maxPasses) {
    const pending = inFlight;
    if (!pending) {
      return {
        ok: !lastError,
        stalled: false,
        passes,
        lastPassOk,
        error: lastError ? String(lastError?.message || lastError) : undefined
      };
    }
    passes++;
    try {
      await pending;
      lastPassOk = true;
    } catch (e) {
      lastError = e;
      lastPassOk = false;
    }
    await Promise.resolve();
  }
  return {
    ok: false,
    stalled: !!inFlight,
    passes,
    lastPassOk,
    error: lastError ? String(lastError?.message || lastError) : undefined
  };
}

function _schedule(opts) {
  // Single-flight + dirty-flag coalescing. NEVER clear the timer once armed —
  // doing so without re-arming would orphan the inFlight promise. Late callers
  // simply set dirty=true; the do-while loop inside the timer body re-runs
  // _syncOnce until dirty drains.
  dirty = true;
  if (inFlight) return inFlight;
  inFlight = new Promise((resolve, reject) => {
    timer = setTimeout(async () => {
      timer = null;
      let needsContinuation = false;
      let guard = 0;
      try {
        let result;
        const MAX_LOOPS = 8; // safety: bound runaway dirty bumps within one pass
        do {
          dirty = false;
          guard++;
          result = await syncOnceImpl(opts);
          if (guard >= MAX_LOOPS) {
            // We bailed out of the loop. If dirty was set during this last
            // pass we have residual work; schedule a continuation rather than
            // silently dropping the signal.
            needsContinuation = dirty;
            break;
          }
        } while (dirty);
        resolve(result);
      } catch (e) {
        // Each pass clears dirty before running sync. If dirty is true here,
        // a fresh signal arrived during the failed pass. If guard > 1, this
        // failed pass was itself servicing an earlier dirty signal.
        needsContinuation = dirty || guard > 1;
        reject(e);
      } finally {
        inFlight = null;
        if (needsContinuation) {
          // Fire-and-forget continuation. queueMicrotask runs after this
          // finally completes and inFlight is null, so the new request will
          // arm a fresh timer cleanly.
          queueMicrotask(() => { requestSync(opts).catch(() => {}); });
        }
      }
    }, opts.debounceMs ?? 250);
  });
  return inFlight;
}

function resetSchedulerForTestHook() {
  if (timer) clearTimeout(timer);
  timer = null;
  inFlight = null;
  dirty = false;
  syncOnceImpl = _syncOnceReal;
  readRoutingFileImpl = path => fs.readFile(path, "utf8");
  lastRoutingReadFailureSignature = null;
}

function setSyncOnceForTestHook(fn) {
  syncOnceImpl = typeof fn === "function" ? fn : _syncOnceReal;
}

function setRoutingReadFileForTestHook(fn) {
  readRoutingFileImpl = typeof fn === "function" ? fn : (path => fs.readFile(path, "utf8"));
}

registerTestHooks("sync", {
  resetScheduler: resetSchedulerForTestHook,
  setSyncOnce: setSyncOnceForTestHook,
  setRoutingReadFile: setRoutingReadFileForTestHook
});

// ── one sync pass ───────────────────────────────────────────────────────────

export async function listDomainFiles() {
  const out = [];
  async function walk(dir, relPrefix = "") {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (e) { if (e.code === "ENOENT") return; throw e; }
    for (const ent of entries) {
      if (ent.name.startsWith("_")) continue;          // skip _archive/, _foo.md
      const full = join(dir, ent.name);
      const rel  = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await walk(full, rel);
      else if (ent.isFile() && ent.name.endsWith(".md")) out.push({ full, rel });
    }
  }
  await walk(KNOWLEDGE_ROOT);
  return out;
}

// Compare two KB block inner strings ignoring the "_Last generated:" line.
// The date stamp is volatile; rows-and-shape is what matters for drift.
export function kbBlockEquivalent(a, b) {
  const strip = s => String(s ?? "")
    .split(/\r?\n/)
    .filter(line => !/^_Last generated:.*_$/.test(line.trim()))
    .map(l => l.trimEnd())
    .join("\n")
    .trim();
  return strip(a) === strip(b);
}

async function readExistingRoutingTable() {
  let raw;
  try {
    raw = await readRoutingFileImpl(ROUTING_JSON);
  } catch (e) {
    if (e.code === "ENOENT") {
      lastRoutingReadFailureSignature = null;
      return { ok: true, canWrite: true, table: null };
    }
    const signature = `${e.code || "ERROR"}:${e.message || e}`;
    if (signature !== lastRoutingReadFailureSignature) {
      lastRoutingReadFailureSignature = signature;
      await logEvent("routing_read_failed", {
        code: e.code,
        path: ROUTING_JSON,
        error: e?.message || String(e)
      });
    }
    return { ok: false, canWrite: false, table: null, error: e };
  }

  try {
    const table = JSON.parse(raw);
    lastRoutingReadFailureSignature = null;
    return { ok: true, canWrite: true, table };
  } catch (e) {
    lastRoutingReadFailureSignature = null;
    await logEvent("routing_corrupt_overwrite", { error: e?.message || String(e) });
    return { ok: true, canWrite: true, table: null };
  }
}

async function _syncOnceReal() {
  // Make KNOWLEDGE_ROOT exist before withLock tries to create the lockfile in it.
  await fs.mkdir(KNOWLEDGE_ROOT, { recursive: true });
  // Item #28: sync may take longer than the default 2 s timeout when the KB
  // is large or the disk is slow (AV scanning, OneDrive). Allow up to 10 s
  // to acquire SYNC_LOCK, with a 60 s stale window. The heartbeat in
  // withLock keeps live holders from being falsely evicted.
  return await withLock(SYNC_LOCK, () => _syncOnceUnlocked(), { timeoutMs: 10_000, staleMs: 60_000 });
}

async function _syncOnceUnlocked() {
  const files = await listDomainFiles();
  const entries = [];
  const errors  = [];
  const usageActiveDomains = new Set();

  for (const { full, rel } of files) {
    for (const domain of usageDomainsForFile(rel)) usageActiveDomains.add(domain);
    let raw;
    try { raw = await fs.readFile(full, "utf8"); }
    catch (e) { errors.push({ file: rel, error: `read: ${e.message}` }); continue; }
    let meta;
    try { meta = parse(raw).meta; }
    catch (e) { errors.push({ file: rel, error: `frontmatter: ${e.message}` }); continue; }
    for (const domain of usageDomainsForFile(rel, meta)) usageActiveDomains.add(domain);
    const v = validateMeta(meta);
    if (!v.ok) { errors.push({ file: rel, error: `validate: ${v.errors.join("; ")}` }); continue; }
    entries.push({
      domain:     meta.domain,
      file_rel:   rel,
      kind:       meta.kind,
      summary:    meta.summary,
      tags:       meta.tags,
      aliases:    meta.aliases,
      see_also:   meta.see_also,
      verified:   meta.verified,
      deprecated: meta.deprecated
    });
  }

  // Deterministic sort.
  entries.sort((a, b) => a.domain.localeCompare(b.domain));

  // === Idempotent _routing.json write ===
  // Only rewrite when the domain rows actually changed; the `generated`
  // timestamp would otherwise force a write on every sync pass and cause
  // session-start auto-heal to thrash mtimes.
  let routingWritten = false;
  let routingReadSkipped = false;
  const existingRouting = await readExistingRoutingTable();
  const existingTable = existingRouting.table;

  const newDomainsJson = JSON.stringify({ version: 3, domains: entries });
  const oldDomainsJson = existingTable
    ? JSON.stringify({ version: existingTable.version, domains: existingTable.domains || [] })
    : null;

  if (!existingRouting.canWrite) {
    routingReadSkipped = true;
  } else if (oldDomainsJson !== newDomainsJson) {
    const table = {
      version:   3,
      generated: new Date().toISOString(),
      domains:   entries
    };
    await atomicWrite(ROUTING_JSON, JSON.stringify(table, null, 2));
    routingWritten = true;
    invalidateRoutingCache();
  }

  const usagePrune = await pruneUsageDomains(usageActiveDomains);

  // === Idempotent KB block write ===
  // casReplaceMarkers returns status "noop" when the build callback returns
  // null/undefined, and skips the file write entirely. Comparing against the
  // existing freshInner (date-stripped) means a rebuild with no row changes
  // never touches copilot-instructions.md.
  let kbStatus = "skipped_instructions_missing";
  const exists = await readWithStatOrNull(INSTRUCTIONS_MD);
  if (exists) {
    // Item #9: pick which marker pair the file is using (legacy vs namespaced).
    const kbPair = pickMarkerPair(exists.content, KB_BEGIN_NS, KB_END_NS, KB_BEGIN, KB_END);
    const r = await casReplaceMarkers(
      INSTRUCTIONS_MD, kbPair.begin, kbPair.end,
      (_freshContent, freshInner) => {
        const fresh = renderKbBlock(entries);
        if (kbBlockEquivalent(freshInner, fresh)) return null;
        return fresh;
      }
    );
    kbStatus = r.status;
  }

  return {
    domainsWritten: entries.length,
    validationErrors: errors,
    kbStatus,
    routingWritten,
    routingReadSkipped,
    usagePrunedCount: usagePrune.prunedCount,
    usagePrunedDomains: usagePrune.prunedDomains
  };
}

export function renderKbBlock(entries) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    `_Last generated: ${today}_`,
    "",
    "| Domain | File |",
    "|---|---|"
  ];
  // Markdown table cells must not contain newlines or stray pipes. Replace
  // both. CR is normalized to space too.
  const cellEscape = s => String(s ?? "")
    .replace(/\r\n?|\n/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
  for (const e of entries) {
    const domain = cellEscape(e.domain || "");
    const file   = cellEscape(e.file_rel || "");
    lines.push(`| ${domain} | ${file} |`);
  }
  if (entries.length === 0) lines.push("| _(no domains yet)_ | |");
  return lines.join("\n");
}
