// Deterministic audit: stale, cap, disputed, collisions, zero-hit, bloat,
// deprecated archival, frontmatter errors, marker presence.
// Read-only by default. archivalAllowed=true permits moving deprecated >30d to _archive/.

import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import {
  KNOWLEDGE_ROOT, ARCHIVE_DIR, INSTRUCTIONS_MD, DIGEST_MD
} from "./paths.mjs";
import { atomicWrite, readWithStatOrNull } from "./atomic.mjs";
import { parse, validateMeta } from "./frontmatter.mjs";
import { loadUsage } from "./usage.mjs";
import { QR_BEGIN, QR_END } from "./capture.mjs";
import { KB_BEGIN, KB_END, syncNow } from "./sync.mjs";

const STALE_WARN_DAYS  = 30;
const STALE_ACT_DAYS   = 90;
const ZERO_HIT_DAYS    = 60;
const DEPRECATED_DAYS  = 30;
const BLOAT_H2_COUNT   = 40;
const QR_CAP           = 10;
const COLLISION_THRESHOLD = 3;
const DIGEST_BUDGET    = 2048;

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
    markersMissing: { qr: false, kb: false }
  };
  const archived = [];

  // 1. Frontmatter pass.
  const files = await listDomainFiles();
  const parsedFiles = []; // { file, meta, body, mtimeMs }
  for (const { full, rel } of files) {
    let raw, st;
    try { raw = await fs.readFile(full, "utf8"); st = await fs.stat(full); }
    catch (e) { findings.frontmatterErrors.push({ file: rel, error: `read: ${e.message}` }); continue; }
    let meta, body;
    try { ({ meta, body } = parse(raw)); }
    catch (e) { findings.frontmatterErrors.push({ file: rel, error: `parse: ${e.message}` }); continue; }
    const v = validateMeta(meta);
    if (!v.ok) findings.frontmatterErrors.push({ file: rel, error: v.errors.join("; ") });
    parsedFiles.push({ rel, full, meta, body, mtimeMs: st.mtimeMs });
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
    findings.markersMissing.qr = inst.content.indexOf(QR_BEGIN) < 0 || inst.content.indexOf(QR_END) < 0;
    findings.markersMissing.kb = inst.content.indexOf(KB_BEGIN) < 0 || inst.content.indexOf(KB_END) < 0;

    // Quick Rules count.
    const start = inst.content.indexOf(QR_BEGIN);
    const end   = inst.content.indexOf(QR_END, start + (start >= 0 ? QR_BEGIN.length : 0));
    if (start >= 0 && end >= 0) {
      const inner = inst.content.slice(start + QR_BEGIN.length, end);
      const count = (inner.match(/^[ \t]*[-*]\s+\S/gm) || []).length;
      if (count > QR_CAP) findings.quickRulesOver = { count, cap: QR_CAP };
    }
  }

  // 9. Archival (write side, scheduler only).
  if (archivalAllowed) {
    for (const dep of findings.deprecated) {
      if (!dep.eligible) continue;
      const src = join(KNOWLEDGE_ROOT, dep.file);
      const dst = join(ARCHIVE_DIR, dep.file);
      try {
        await fs.mkdir(dirname(dst), { recursive: true });
        await fs.rename(src, dst);
        archived.push({ from: dep.file, to: `_archive/${dep.file}` });
      } catch (e) {
        findings.frontmatterErrors.push({ file: dep.file, error: `archive: ${e.message}` });
      }
    }
    if (archived.length > 0) {
      await syncNow();
    }
  }

  const digest = renderDigest(findings, archived);
  const healthy = digest === null;

  if (healthy) {
    try { await fs.unlink(DIGEST_MD); } catch {}
  } else {
    await atomicWrite(DIGEST_MD, digest);
  }

  return { healthy, digest, findings, archived };
}

function push(map, key, val) {
  let s = map.get(key);
  if (!s) { s = new Set(); map.set(key, s); }
  s.add(val);
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
  if (Buffer.byteLength(out, "utf8") > DIGEST_BUDGET) {
    // Truncate at last full line under budget.
    const buf = Buffer.from(out, "utf8");
    const cut = buf.subarray(0, DIGEST_BUDGET).toString("utf8");
    const lastNl = cut.lastIndexOf("\n");
    out = (lastNl > 0 ? cut.slice(0, lastNl) : cut) + "\n\n_(truncated)_\n";
  }
  return out;
}
