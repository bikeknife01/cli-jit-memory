// Deterministic audit: stale, cap, disputed, collisions, zero-hit, bloat,
// deprecated archival, frontmatter errors, marker presence.
// Writes the digest and may prune stale usage telemetry. archivalAllowed=true
// additionally permits moving deprecated >30d to _archive/.

import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import {
  KNOWLEDGE_ROOT, ARCHIVE_DIR, INSTRUCTIONS_MD, DIGEST_MD, ROUTING_JSON
} from "./paths.mjs";
import { atomicWrite, readWithStatOrNull, withLock } from "./atomic.mjs";
import { parse, validateMeta } from "./frontmatter.mjs";
import { loadUsage, pruneUsageDomains, usageDomainsForFile } from "./usage.mjs";
import { QR_BEGIN, QR_END, QR_BEGIN_NS, QR_END_NS } from "./capture.mjs";
import { KB_BEGIN, KB_END, KB_BEGIN_NS, KB_END_NS, syncNow, renderKbBlock } from "./sync.mjs";
import { pickMarkerPair } from "./markers.mjs";
import { truncateUtf8AtLineBoundary, utf8ByteLength } from "./utf8.mjs";

const STALE_WARN_DAYS  = 30;
const STALE_ACT_DAYS   = 90;
const ZERO_HIT_DAYS    = 60;
const DEPRECATED_DAYS  = 30;
const BLOAT_H2_COUNT   = 40;
const QR_CAP           = 10;
const COLLISION_THRESHOLD = 3;
const DIGEST_BUDGET    = 2048;
// Soft scale guardrails. These are warnings, not hard caps.
const DOMAIN_COUNT_WARN = 75;           // Flat domain sets above this get hard to curate.
const KB_BLOCK_BYTES_WARN = 4 * 1024;   // Static KB index footprint in copilot-instructions.md.
const ROUTING_JSON_BYTES_WARN = 128 * 1024; // Generated table load/scan overhead.

const daysAgo = ms => (Date.now() - ms) / 86_400_000;

async function listDomainFiles() {
  const out = [];
  async function walk(dir, prefix = "") {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (e) { if (e.code === "ENOENT") return; throw e; }
    for (const ent of entries) {
      if (ent.name.startsWith("_")) continue;
      const full = join(dir, ent.name);
      const rel  = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await walk(full, rel);
      else if (ent.isFile() && ent.name.endsWith(".md")) out.push({ full, rel });
    }
  }
  await walk(KNOWLEDGE_ROOT);
  return out;
}

export async function audit({ archivalAllowed = false } = {}) {
  const findings = {
    staleAct: [],     // verified > 90d
    staleWarn: [],    // verified > 30d (and not act)
    quickRulesOver: null,
    disputed: [],     // [{file, lines}]
    collisions: [],   // [{token, kind, files}]
    zeroHit: [],      // never used in 60d (and >60d since file mtime)
    bloated: [],      // [{file, h2Count}]
    deprecated: [],   // [{file, daysSince}]
    frontmatterErrors: [],
    markersMissing: { qr: false, kb: false },
    scaleWarnings: [] // [{kind, value, threshold, summary}]
  };
  const archived = [];
  const maintenance = {
    usagePruned: { ok: true, prunedCount: 0, prunedDomains: [], written: false }
  };
  const usageActiveDomains = new Set();

  // 1. Frontmatter pass.
  const files = await listDomainFiles();
  const parsedFiles = []; // { file, meta, body, mtimeMs }
  for (const { full, rel } of files) {
    for (const domain of usageDomainsForFile(rel)) usageActiveDomains.add(domain);
    let raw, st;
    try { raw = await fs.readFile(full, "utf8"); st = await fs.stat(full); }
    catch (e) { findings.frontmatterErrors.push({ file: rel, error: `read: ${e.message}` }); continue; }
    let meta, body;
    try { ({ meta, body } = parse(raw)); }
    catch (e) { findings.frontmatterErrors.push({ file: rel, error: `parse: ${e.message}` }); continue; }
    for (const domain of usageDomainsForFile(rel, meta)) usageActiveDomains.add(domain);
    const v = validateMeta(meta);
    if (!v.ok) findings.frontmatterErrors.push({ file: rel, error: v.errors.join("; ") });
    parsedFiles.push({ rel, full, meta, body, mtimeMs: st.mtimeMs, valid: v.ok });
  }

  // 2. Stale.
  for (const f of parsedFiles) {
    const t = Date.parse(f.meta.verified || "");
    if (Number.isNaN(t)) continue;
    const age = daysAgo(t);
    if (age > STALE_ACT_DAYS)      findings.staleAct.push({ file: f.rel, age: Math.floor(age) });
    else if (age > STALE_WARN_DAYS) findings.staleWarn.push({ file: f.rel, age: Math.floor(age) });
  }

  // 3. Disputed.
  for (const f of parsedFiles) {
    const m = /##\s+Disputed[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i.exec(f.body);
    if (!m) continue;
    const lines = m[1].split("\n").filter(l => /^\s*-\s+\[\d{4}-\d{2}-\d{2}\]/.test(l)).map(l => l.trim());
    if (lines.length > 0) findings.disputed.push({ file: f.rel, lines });
  }

  // 4. Tag/alias collisions.
  const tagMap   = new Map();
  const aliasMap = new Map();
  for (const f of parsedFiles) {
    for (const t of f.meta.tags    || []) push(tagMap,   t, f.rel);
    for (const a of f.meta.aliases || []) push(aliasMap, a, f.rel);
  }
  for (const [token, files] of tagMap)   if (files.size >= COLLISION_THRESHOLD) findings.collisions.push({ token, kind: "tag",   files: [...files] });
  for (const [token, files] of aliasMap) if (files.size >= COLLISION_THRESHOLD) findings.collisions.push({ token, kind: "alias", files: [...files] });

  maintenance.usagePruned = await pruneUsageDomains(usageActiveDomains);

  // 5. Zero-hit / demotion candidates.
  const usage = await loadUsage();
  for (const f of parsedFiles) {
    const u = usage.domains?.[f.meta.domain];
    const lastHit = u?.lastHit || 0;
    const sinceHit = lastHit ? daysAgo(lastHit) : Infinity;
    const sinceCreate = daysAgo(f.mtimeMs);
    if (sinceHit > ZERO_HIT_DAYS && sinceCreate > ZERO_HIT_DAYS) {
      findings.zeroHit.push({ file: f.rel, hits: u?.hits || 0, daysSinceHit: Number.isFinite(sinceHit) ? Math.floor(sinceHit) : null });
    }
  }

  // 6. Bloat.
  for (const f of parsedFiles) {
    const h2 = (f.body.match(/^##\s+/gm) || []).length;
    if (h2 > BLOAT_H2_COUNT) findings.bloated.push({ file: f.rel, h2Count: h2 });
  }

  // 7. Deprecated.
  for (const f of parsedFiles) {
    if (!f.meta.deprecated) continue;
    const t = Date.parse(f.meta.deprecated);
    if (Number.isNaN(t)) continue;
    const age = daysAgo(t);
    findings.deprecated.push({ file: f.rel, daysSince: Math.floor(age), eligible: age > DEPRECATED_DAYS });
  }

  // 8. Marker presence.
  const inst = await readWithStatOrNull(INSTRUCTIONS_MD);
  if (inst) {
    // Item #9: accept either the namespaced or legacy marker form.
    const qrPair = pickMarkerPair(inst.content, QR_BEGIN_NS, QR_END_NS, QR_BEGIN, QR_END);
    const kbPair = pickMarkerPair(inst.content, KB_BEGIN_NS, KB_END_NS, KB_BEGIN, KB_END);
    findings.markersMissing.qr = inst.content.indexOf(qrPair.begin) < 0 || inst.content.indexOf(qrPair.end) < 0;
    findings.markersMissing.kb = inst.content.indexOf(kbPair.begin) < 0 || inst.content.indexOf(kbPair.end) < 0;

    // Quick Rules count.
    const start = inst.content.indexOf(qrPair.begin);
    const end   = inst.content.indexOf(qrPair.end, start + (start >= 0 ? qrPair.begin.length : 0));
    if (start >= 0 && end >= 0) {
      const inner = inst.content.slice(start + qrPair.begin.length, end);
      const count = (inner.match(/^[ \t]*[-*]\s+\S/gm) || []).length;
      if (count > QR_CAP) findings.quickRulesOver = { count, cap: QR_CAP };
    }
  }

  // 9. Scale guardrails.
  await addScaleWarnings(findings, parsedFiles);

  // 10. Archival (write side, scheduler only).
  if (archivalAllowed) {
    for (const dep of findings.deprecated) {
      if (!dep.eligible) continue;
      const src = join(KNOWLEDGE_ROOT, dep.file);
      const dst = join(ARCHIVE_DIR, dep.file);
      try {
        // Item #6: hold the per-file lock during the rename and re-validate
        // deprecation eligibility inside the lock. Without this, a concurrent
        // domain_update or alias_add touching the same file could land its
        // write between our snapshot and the rename, producing a duplicate
        // (active+archived) or a lost update.
        await withLock(src, async () => {
          const fresh = await readWithStatOrNull(src);
          if (!fresh) {
            // Source vanished between scan and lock — nothing to archive.
            return;
          }
          let parsed;
          try { parsed = parse(fresh.content); }
          catch (e) {
            // Frontmatter no longer parseable — skip and report.
            findings.frontmatterErrors.push({ file: dep.file, error: `archive re-parse: ${e.message}` });
            return;
          }
          if (!parsed?.meta?.deprecated) return;            // un-deprecated under us
          const t = Date.parse(parsed.meta.deprecated);
          if (!Number.isFinite(t)) return;
          if (daysAgo(t) <= DEPRECATED_DAYS) return;        // not eligible anymore
          await fs.mkdir(dirname(dst), { recursive: true });
          await fs.rename(src, dst);
          archived.push({ from: dep.file, to: `_archive/${dep.file}` });
        });
      } catch (e) {
        findings.frontmatterErrors.push({ file: dep.file, error: `archive: ${e.message}` });
      }
    }
    if (archived.length > 0) {
      const syncResult = await syncNow();
      maintenance.usagePruned = mergeUsagePruneResults(maintenance.usagePruned, {
        ok: true,
        prunedCount: syncResult.usagePrunedCount || 0,
        prunedDomains: syncResult.usagePrunedDomains || [],
        written: (syncResult.usagePrunedCount || 0) > 0
      });
    }
  }

  const digest = renderDigest(findings, archived);
  const healthy = digest === null;

  if (healthy) {
    try { await fs.unlink(DIGEST_MD); } catch {}
  } else {
    await atomicWrite(DIGEST_MD, digest);
  }

  return { healthy, digest, findings, archived, maintenance };
}

function mergeUsagePruneResults(a, b) {
  const domains = new Set([...(a.prunedDomains || []), ...(b.prunedDomains || [])]);
  return {
    ok: a.ok !== false && b.ok !== false,
    prunedCount: domains.size,
    prunedDomains: [...domains],
    written: !!(a.written || b.written)
  };
}

function push(map, key, val) {
  let s = map.get(key);
  if (!s) { s = new Set(); map.set(key, s); }
  s.add(val);
}

async function addScaleWarnings(findings, parsedFiles) {
  if (parsedFiles.length > DOMAIN_COUNT_WARN) {
    findings.scaleWarnings.push({
      kind: "domain_count",
      value: parsedFiles.length,
      threshold: DOMAIN_COUNT_WARN,
      summary: "consider archiving deprecated domains, resolving zero-hit candidates, or splitting only genuinely broad domains"
    });
  }

  const validEntries = parsedFiles
    .filter(f => f.valid)
    .map(f => ({
      domain: f.meta.domain,
      file_rel: f.rel
    }));
  const kbBytes = utf8ByteLength(renderKbBlock(validEntries));
  if (kbBytes > KB_BLOCK_BYTES_WARN) {
    findings.scaleWarnings.push({
      kind: "kb_block_bytes",
      value: kbBytes,
      threshold: KB_BLOCK_BYTES_WARN,
      summary: "static KB index in copilot-instructions.md is large; archive low-value domains"
    });
  }

  try {
    const st = await fs.stat(ROUTING_JSON);
    if (st.size > ROUTING_JSON_BYTES_WARN) {
      findings.scaleWarnings.push({
        kind: "routing_json_bytes",
        value: st.size,
        threshold: ROUTING_JSON_BYTES_WARN,
        summary: "generated routing table is large; prune or archive domains that no longer route useful context"
      });
    }
  } catch (e) {
    if (e.code !== "ENOENT") {
      findings.frontmatterErrors.push({ file: "_routing.json", error: `stat: ${e.message}` });
    }
  }
}

function renderDigest(f, archived) {
  const sections = [];
  if (f.staleAct.length)        sections.push(["Stale (act, >90d)",   f.staleAct.map(x => `- ${x.file} (${x.age}d)`)]);
  if (f.disputed.length)        sections.push(["Disputed entries",    f.disputed.flatMap(d => [`- ${d.file}:`, ...d.lines.map(l => `  ${l}`)])]);
  if (f.markersMissing.qr ||
      f.markersMissing.kb)      sections.push(["Markers missing",     [
                                  f.markersMissing.qr ? "- QR:BEGIN/END absent in copilot-instructions.md" : null,
                                  f.markersMissing.kb ? "- KB:BEGIN/END absent in copilot-instructions.md" : null
                                ].filter(Boolean)]);
  if (f.quickRulesOver)         sections.push(["Quick Rules over cap", [`- ${f.quickRulesOver.count}/${f.quickRulesOver.cap} — manual demotion required`]]);
  if (f.frontmatterErrors.length) sections.push(["Frontmatter errors", f.frontmatterErrors.map(x => `- ${x.file}: ${x.error}`)]);
  if (f.bloated.length)         sections.push(["Bloated files",        f.bloated.map(x => `- ${x.file} (${x.h2Count} H2 sections)`)]);
  if (f.staleWarn.length)       sections.push(["Stale (warn, >30d)",   f.staleWarn.map(x => `- ${x.file} (${x.age}d)`)]);
  if (f.zeroHit.length)         sections.push(["Demotion candidates (>60d unused)", f.zeroHit.map(x => `- ${x.file} (hits=${x.hits}, since=${x.daysSinceHit ?? "never"})`)]);
  if (f.collisions.length)      sections.push(["Token collisions (≥3 domains)", f.collisions.map(c => `- ${c.kind} "${c.token}" → ${c.files.join(", ")}`)]);
  if (f.deprecated.length)      sections.push(["Deprecated", f.deprecated.map(x => `- ${x.file} (${x.daysSince}d${x.eligible ? ", archive-eligible" : ""})`)]);
  if (f.scaleWarnings.length)   sections.push(["Scale guardrails", f.scaleWarnings.map(x => `- ${x.kind}: ${x.value} > ${x.threshold}; ${x.summary}`)]);
  if (archived.length)          sections.push(["Archived this run",   archived.map(a => `- ${a.from} → ${a.to}`)]);

  if (sections.length === 0) return null;

  const lines = [
    `# Curator digest — ${new Date().toISOString()}`,
    ""
  ];
  for (const [title, body] of sections) {
    lines.push(`## ${title}`, "", ...body, "");
  }
  let out = lines.join("\n");
  if (utf8ByteLength(out) > DIGEST_BUDGET) {
    out = truncateUtf8AtLineBoundary(out, DIGEST_BUDGET);
  }
  return out;
}
