// Routing: intent string → matched domain entries with confidence tiers.
//
// Confidence:
//   high   — alias substring match (aliases are explicit phrases ≥3 chars)
//   medium — tag word-boundary match (no alias hit on same domain)
//   low    — included via see-also expansion only
//
// Cap: 3 primary matches; up to 2 see-also extras (deduped, depth=1).
// Skips entries with `deprecated` set.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { ROUTING_JSON, KNOWLEDGE_ROOT, assertRoutableKnowledgeFile, assertRoutableKnowledgeFileAsync, isValidSlug } from "./paths.mjs";
import { registerTestHooks } from "./test-hook-registry.mjs";

const STALE_DAYS = 90;

// In-memory cache, keyed by mtimeMs+size of _routing.json.
let cache = null; // { key: "<mtimeMs>:<size>", table }

// Counter for invalid routing entries dropped by route(). Caller (extension)
// reads + resets this via consumeInvalidEntryCount() to emit throttled warnings
// when a corrupted/hand-edited routing.json starts dropping entries silently.
let _invalidEntryCount = 0;

export function invalidateRoutingCache() { cache = null; }

export function consumeInvalidEntryCount() {
  const n = _invalidEntryCount;
  _invalidEntryCount = 0;
  return n;
}

function resetInvalidEntryCountForTestHook() {
  _invalidEntryCount = 0;
}

registerTestHooks("router", { resetInvalidEntryCount: resetInvalidEntryCountForTestHook });

async function sanitizeRoutingTable(table) {
  if (!table || typeof table !== "object") {
    return { version: 3, domains: [] };
  }
  if (!Array.isArray(table.domains)) {
    return { ...table, domains: [] };
  }
  const domains = [];
  let dropped = 0;
  for (const e of table.domains) {
    if (!e || typeof e !== "object" || !isValidSlug(e.domain)) {
      dropped++;
      continue;
    }
    if (e.file_rel !== undefined && typeof e.file_rel !== "string") {
      dropped++;
      continue;
    }
    const rel = e.file_rel || `${e.domain}.md`;
    try {
      await assertRoutableKnowledgeFileAsync(join(KNOWLEDGE_ROOT, rel));
      domains.push(e);
    } catch {
      dropped++;
    }
  }
  if (dropped > 0) _invalidEntryCount += dropped;
  return { ...table, domains };
}

export async function loadRouting({ force = false } = {}) {
  if (!force && cache) {
    try {
      const st = await fs.stat(ROUTING_JSON);
      const key = `${st.mtimeMs}:${st.size}`;
      if (key === cache.key) return cache.table;
    } catch (e) {
      if (e.code === "ENOENT") { cache = null; return { version: 3, domains: [] }; }
      throw e;
    }
  }
  let raw;
  try {
    raw = await fs.readFile(ROUTING_JSON, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { version: 3, domains: [] };
    throw e;
  }
  let table;
  try { table = JSON.parse(raw); }
  catch { return { version: 3, domains: [] }; }
  table = await sanitizeRoutingTable(table);
  const st = await fs.stat(ROUTING_JSON);
  cache = { key: `${st.mtimeMs}:${st.size}`, table };
  return table;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Match a tag with word boundaries. Tag = lowercase, hyphens allowed.
// Hyphen IS a word boundary in JS \b, so "auth-token" needs custom handling.
// Approach: lookbehind/ahead for non-[a-z0-9-] (or string anchors).
function tagRegex(tag) {
  const safe = escapeRegExp(tag);
  return new RegExp(`(?:^|[^a-z0-9-])${safe}(?:[^a-z0-9-]|$)`, "i");
}

function isStale(verifiedISO) {
  if (!verifiedISO) return true;
  const t = Date.parse(verifiedISO);
  if (Number.isNaN(t)) return true;
  return (Date.now() - t) / 86_400_000 > STALE_DAYS;
}

// Pure routing: takes a normalized intent and a routing table, returns matches.
// Exposed for testing without filesystem.
export function route(intent, table) {
  const text = String(intent || "").toLowerCase();
  if (!text) return [];

  const primary = []; // { entry, matched, confidence }
  for (const e of table.domains || []) {
    if (e.deprecated) continue;
    const hits = new Set();
    let confidence = null;

    // Aliases first — substring match (aliases are explicit phrases).
    for (const a of e.aliases || []) {
      if (typeof a !== "string" || a.length < 3) continue;
      if (text.includes(a.toLowerCase())) {
        hits.add(a);
        confidence = "high";
      }
    }

    // Tags — word-boundary match. Skip if alias already matched.
    if (confidence !== "high") {
      for (const t of e.tags || []) {
        if (typeof t !== "string" || t.length < 2) continue;
        if (tagRegex(t).test(text)) {
          hits.add(t);
          confidence = "medium";
        }
      }
    } else {
      // Still record matched tags for transparency, but don't change confidence.
      for (const t of e.tags || []) {
        if (typeof t !== "string" || t.length < 2) continue;
        if (tagRegex(t).test(text)) hits.add(t);
      }
    }

    if (confidence) {
      primary.push({
        entry: e,
        matched: [...hits],
        confidence
      });
    }
  }

  // Sort: high before medium; then by slug for stability.
  primary.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === "high" ? -1 : 1;
    return (a.entry.domain || "").localeCompare(b.entry.domain || "");
  });

  // Cap primary to 3.
  const primaryCapped = primary.slice(0, 3);
  const primarySlugs = new Set(primaryCapped.map(m => m.entry.domain));

  // See-also expansion: depth=1, max 2 unique additions.
  const extras = [];
  for (const m of primaryCapped) {
    for (const slug of m.entry.see_also || []) {
      if (extras.length >= 2) break;
      if (primarySlugs.has(slug)) continue;
      const target = (table.domains || []).find(d => d.domain === slug && !d.deprecated);
      if (!target) continue;
      if (extras.find(x => x.entry.domain === slug)) continue;
      extras.push({
        entry: target,
        matched: [`see_also:${m.entry.domain}`],
        confidence: "low"
      });
    }
    if (extras.length >= 2) break;
  }

  // Build output: absolute paths, kind, summary, stale flag.
  // Each path is validated with assertRoutableKnowledgeFile — any entry whose
  // file_rel escapes KNOWLEDGE_ROOT, isn't .md, or lives under _archive/ is
  // dropped silently. This guards against a corrupted/hand-edited routing.json.
  const out = [];
  for (const m of [...primaryCapped, ...extras]) {
    const rel  = m.entry.file_rel || `${m.entry.domain}.md`;
    const abs  = join(KNOWLEDGE_ROOT, rel);
    let safe;
    try { safe = assertRoutableKnowledgeFile(abs); }
    catch { _invalidEntryCount++; continue; }
    out.push({
      slug: m.entry.domain,
      file: safe,
      matched: m.matched,
      confidence: m.confidence,
      see_also: m.entry.see_also || [],
      kind: m.entry.kind,
      summary: m.entry.summary || "",
      verified: m.entry.verified || null,
      stale: isStale(m.entry.verified)
    });
  }
  return out;
}

// Convenience: load + route + return.
export async function routeFromDisk(intent) {
  const table = await loadRouting();
  return route(intent, table);
}
