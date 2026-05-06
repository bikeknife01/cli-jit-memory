// Sync: regenerate _routing.json + KB block in copilot-instructions.md from
// the frontmatter of every domain file. Single-flight + dirty-flag coalescing.

import { promises as fs } from "node:fs";
import { join, relative } from "node:path";
import { KNOWLEDGE_ROOT, ROUTING_JSON, INSTRUCTIONS_MD, ARCHIVE_DIR } from "./paths.mjs";
import { atomicWrite, withLock, readWithStatOrNull, casReplaceMarkers } from "./atomic.mjs";
import { parse, validateMeta } from "./frontmatter.mjs";
import { invalidateRoutingCache } from "./router.mjs";

export const KB_BEGIN = "<!-- KB:BEGIN -->";
export const KB_END   = "<!-- KB:END -->";

// Cross-process lock spanning the entire sync pass (list -> parse -> write
// routing -> write KB). Prevents two CLI sessions from racing each other and
// having an older snapshot win the final write.
const SYNC_LOCK = join(KNOWLEDGE_ROOT, "_sync.lock");

// ── single-flight + dirty-flag coalescing ───────────────────────────────────
let timer    = null;
let inFlight = null;
let dirty    = false;

export function requestSync(opts = {}) {
  // Fire-and-forget. Used by hooks. Errors swallowed at boundary.
  return _schedule(opts).catch(() => undefined);
}

export function syncNow(opts = {}) {
  // Awaitable. Used by tools/audit/cli.
  return _schedule(opts);
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
      try {
        let result;
        let guard = 0;
        const MAX_LOOPS = 8; // safety: bound runaway dirty bumps within one pass
        do {
          dirty = false;
          result = await _syncOnce(opts);
          if (++guard >= MAX_LOOPS) {
            // We bailed out of the loop. If dirty was set during this last
            // pass we have residual work; schedule a continuation rather than
            // silently dropping the signal.
            needsContinuation = dirty;
            break;
          }
        } while (dirty);
        resolve(result);
      } catch (e) {
        // If a dirty signal arrived during a failing pass, preserve it for the
        // next caller so the work isn't lost when they retry.
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

// Test/diagnostic helper. Gated behind JITMEM_TEST_MODE=1 to prevent
// production callers from accidentally orphaning an in-flight sync.
export function _resetSchedulerForTests() {
  if (process.env.JITMEM_TEST_MODE !== "1") {
    throw new Error("_resetSchedulerForTests is test-only; set JITMEM_TEST_MODE=1");
  }
  if (timer) clearTimeout(timer);
  timer = null;
  inFlight = null;
  dirty = false;
}

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
function kbBlockEquivalent(a, b) {
  const strip = s => String(s ?? "")
    .split(/\r?\n/)
    .filter(line => !/^_Last generated:.*_$/.test(line.trim()))
    .map(l => l.trimEnd())
    .join("\n")
    .trim();
  return strip(a) === strip(b);
}

async function _syncOnce() {
  // Make KNOWLEDGE_ROOT exist before withLock tries to create the lockfile in it.
  await fs.mkdir(KNOWLEDGE_ROOT, { recursive: true });
  return await withLock(SYNC_LOCK, () => _syncOnceUnlocked());
}

async function _syncOnceUnlocked() {
  const files = await listDomainFiles();
  const entries = [];
  const errors  = [];

  for (const { full, rel } of files) {
    let raw;
    try { raw = await fs.readFile(full, "utf8"); }
    catch (e) { errors.push({ file: rel, error: `read: ${e.message}` }); continue; }
    let meta;
    try { meta = parse(raw).meta; }
    catch (e) { errors.push({ file: rel, error: `frontmatter: ${e.message}` }); continue; }
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
  let existingTable  = null;
  try {
    const raw = await fs.readFile(ROUTING_JSON, "utf8");
    existingTable = JSON.parse(raw);
  } catch (e) { /* missing or corrupted -> we'll write */ }

  const newDomainsJson = JSON.stringify({ version: 3, domains: entries });
  const oldDomainsJson = existingTable
    ? JSON.stringify({ version: existingTable.version, domains: existingTable.domains || [] })
    : null;

  if (oldDomainsJson !== newDomainsJson) {
    const table = {
      version:   3,
      generated: new Date().toISOString(),
      domains:   entries
    };
    await atomicWrite(ROUTING_JSON, JSON.stringify(table, null, 2));
    routingWritten = true;
    invalidateRoutingCache();
  }

  // === Idempotent KB block write ===
  // casReplaceMarkers returns status "noop" when the build callback returns
  // null/undefined, and skips the file write entirely. Comparing against the
  // existing freshInner (date-stripped) means a rebuild with no row changes
  // never touches copilot-instructions.md.
  let kbStatus = "skipped";
  const exists = await readWithStatOrNull(INSTRUCTIONS_MD);
  if (exists) {
    const r = await casReplaceMarkers(
      INSTRUCTIONS_MD, KB_BEGIN, KB_END,
      (_freshContent, freshInner) => {
        const fresh = renderKbBlock(entries);
        if (kbBlockEquivalent(freshInner, fresh)) return null;
        return fresh;
      }
    );
    kbStatus = r.status;
  }

  return { domainsWritten: entries.length, validationErrors: errors, kbStatus, routingWritten };
}

export function renderKbBlock(entries) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    `_Last generated: ${today}_`,
    "",
    "| Tags | File | Summary |",
    "|---|---|---|"
  ];
  // Markdown table cells must not contain newlines or stray pipes. Replace
  // both. CR is normalized to space too.
  const cellEscape = s => String(s ?? "")
    .replace(/\r\n?|\n/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
  for (const e of entries) {
    const tags = (e.tags || []).map(cellEscape).join(", ");
    const sum  = cellEscape(e.summary || "");
    const file = cellEscape(e.file_rel || "");
    lines.push(`| ${tags} | ${file} | ${sum} |`);
  }
  if (entries.length === 0) lines.push("| _(no domains yet)_ | | |");
  return lines.join("\n");
}
