// Capture: agent-callable lesson-writing pipeline.
// Five kinds: quick_rule, domain_new, domain_update, disputed, alias_add.
//
// All return { status, summary, ... } where status ∈
//   ok | at_cap | invalid | conflict | not_found | invalid_setup
// `invalid` is the only resultType:failure for the SDK; everything else is a
// valid business outcome reported back to the model as success.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  INSTRUCTIONS_MD, KNOWLEDGE_ROOT,
  resolveDomainFile, isValidSlug, assertNoKnowledgeSymlink, KnowledgeSymlinkError
} from "./paths.mjs";
import {
  atomicWrite, withLock, readWithStatOrNull, casReplaceMarkers
} from "./atomic.mjs";
import {
  parse, stringify, validateMeta,
  TAG_CAP, ALIAS_CAP, TAG_RE, ALIAS_MIN_CHARS, ALIAS_MAX_CHARS
} from "./frontmatter.mjs";
import { syncNow } from "./sync.mjs";
import { routeFromDisk, invalidateRoutingCache, loadRouting } from "./router.mjs";
import { registerTestHooks } from "./test-hook-registry.mjs";
import { pickMarkerPair } from "./markers.mjs";
import { scanRedactable } from "./redaction.mjs";

export const QR_BEGIN = "<!-- QR:BEGIN -->";          // legacy, read-write supported
export const QR_END = "<!-- QR:END -->";            // legacy, read-write supported
// Item #9: namespaced form is preferred for new installs to avoid
// collisions with other extensions that might use generic QR:BEGIN.
export const QR_BEGIN_NS = "<!-- jit-memory:QR:BEGIN -->";
export const QR_END_NS = "<!-- jit-memory:QR:END -->";
const QR_CAP = 10;
const QR_MAX_CHARS = 280;

// Managed marker tokens that must NEVER appear inside captured content,
// summaries, tags, or aliases. If they did, an attacker (or a careless agent)
// could break out of managed regions and inject arbitrary instructions that
// the parent CLI would treat as authoritative on the next session start.
const STATIC_FORBIDDEN_MARKERS = [
  "<!-- QR:BEGIN -->", "<!-- QR:END -->",
  "<!-- KB:BEGIN -->", "<!-- KB:END -->",
  "<!-- jit-memory:QR:BEGIN -->", "<!-- jit-memory:QR:END -->",
  "<!-- jit-memory:KB:BEGIN -->", "<!-- jit-memory:KB:END -->",
  "<!-- efficiency-retro:managed-start", "<!-- efficiency-retro:managed-end"
];

// Normalised label form of every static forbidden marker, used to catch
// whitespace/case variants like `<!--QR:BEGIN-->` or `<!--  qr:begin  -->`
// that the exact-substring scan would miss but `classifyMarkerPair()` would
// later flag as malformed (locking the QR/KB block).
const STATIC_FORBIDDEN_LABELS = new Set([
  "qr:begin", "qr:end", "kb:begin", "kb:end",
  "jit-memory:qr:begin", "jit-memory:qr:end",
  "jit-memory:kb:begin", "jit-memory:kb:end",
  "efficiency-retro:managed-start", "efficiency-retro:managed-end"
]);

let dynamicForbiddenMarkers = [];
let dynamicForbiddenLabels = new Set();

function isManagedMarkerComment(inner) {
  const trimmed = inner.trim();
  if (/\bmanaged-(?:start|end)\b/i.test(trimmed)) return true;
  // BEGIN/END markers are intentionally canonical uppercase; normalised
  // lowercase variants are caught by findForbiddenMarker via label matching.
  return /^[A-Z][A-Z0-9_-]*:(?:BEGIN|END)$/.test(trimmed);
}

// Extract the normalised inner-text label of an HTML-comment marker, e.g.
// `<!-- QR:BEGIN -->` → `qr:begin`. Returns null if the input is not an
// HTML-comment-shaped string.
function markerInnerLabel(marker) {
  if (typeof marker !== "string") return null;
  const m = /^<!--([\s\S]*?)-->/.exec(marker);
  if (!m) return null;
  return m[1].trim().toLowerCase();
}

function discoverManagedMarkerComments(content) {
  const found = [];
  const seen = new Set();
  const re = /<!--([\s\S]*?)-->/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    if (!isManagedMarkerComment(match[1])) continue;
    const token = match[0];
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(token);
  }
  return found;
}

// Dynamic discovery is a startup/session snapshot. Known current markers remain
// protected by STATIC_FORBIDDEN_MARKERS if discovery cannot read instructions.
export async function refreshForbiddenMarkers({ instructionsPath = INSTRUCTIONS_MD } = {}) {
  try {
    const content = await fs.readFile(instructionsPath, "utf8");
    dynamicForbiddenMarkers = discoverManagedMarkerComments(content);
    dynamicForbiddenLabels = new Set(
      dynamicForbiddenMarkers.map(markerInnerLabel).filter(Boolean)
    );
    return { ok: true, discoveredCount: dynamicForbiddenMarkers.length, markers: [...dynamicForbiddenMarkers] };
  } catch (e) {
    if (e?.code === "ENOENT") {
      dynamicForbiddenMarkers = [];
      dynamicForbiddenLabels = new Set();
      return {
        ok: false,
        discoveredCount: 0,
        markers: [],
        error: "instructions file not found"
      };
    }
    return {
      ok: false,
      discoveredCount: dynamicForbiddenMarkers.length,
      markers: [...dynamicForbiddenMarkers],
      error: String(e?.message || e)
    };
  }
}

function findForbiddenMarker(s, dynamicMarkers = dynamicForbiddenMarkers, dynamicLabels = dynamicForbiddenLabels) {
  if (typeof s !== "string") return null;
  // Step 1: exact substring match against the canonical static + dynamic list.
  // Catches the common case and preserves precise reporting of the offending
  // marker token.
  const lower = s.toLowerCase();
  for (const m of [...STATIC_FORBIDDEN_MARKERS, ...dynamicMarkers]) {
    if (lower.includes(m.toLowerCase())) return m;
  }
  // Step 2: scan every HTML comment in the input and reject any whose
  // normalised inner label matches a known managed marker. This catches
  // whitespace and case variants like `<!--QR:BEGIN-->`, `<!--  qr:begin  -->`,
  // `<!--\nKB:END\n-->`, etc., which `classifyMarkerPair()` would later flag
  // as malformed and lock the managed block (item #3).
  const re = /<!--([\s\S]*?)-->/g;
  let match;
  while ((match = re.exec(s)) !== null) {
    const label = match[1].trim().toLowerCase();
    if (!label) continue;
    if (STATIC_FORBIDDEN_LABELS.has(label)) return match[0];
    if (dynamicLabels.has(label)) return match[0];
    // efficiency-retro markers may carry attributes after the label; guard
    // the prefix form too.
    if (label.startsWith("efficiency-retro:managed-start") ||
      label.startsWith("efficiency-retro:managed-end")) return match[0];
  }
  return null;
}

// Walk every string field in args (recursively into arrays) and reject if any
// contains a managed marker token. Object keys are not inspected — only values.
function assertNoForbiddenMarkers(args, dynamicMarkers) {
  const stack = [args];
  while (stack.length) {
    const cur = stack.pop();
    if (typeof cur === "string") {
      const hit = findForbiddenMarker(cur, dynamicMarkers);
      if (hit) return hit;
    } else if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
    } else if (cur && typeof cur === "object") {
      for (const v of Object.values(cur)) stack.push(v);
    }
  }
  return null;
}

const today = () => new Date().toISOString().slice(0, 10);

// Post-write side effects (sync routing/KB + cache invalidation). Never throws —
// returns a sync-status sub-object so the caller can preserve the capture's
// business `status` (the data IS already on disk) even if downstream sync fails.
//
// `_syncFn` is a closure-bound reference so tests can swap it through the
// dedicated test-hook module without exporting test seams from this module.
let _syncFn = syncNow;

function setSyncFnForTestHook(fn) {
  _syncFn = typeof fn === "function" ? fn : syncNow;
}

registerTestHooks("capture", { setSyncFn: setSyncFnForTestHook });

async function runPostWriteSync() {
  try {
    const r = await _syncFn({ debounceMs: 0 });
    invalidateRoutingCache();
    return { ok: true, kbStatus: r?.kbStatus ?? "unknown" };
  } catch (e) {
    try { invalidateRoutingCache(); } catch { }
    return { ok: false, error: String(e?.message || e) };
  }
}

async function symlinkPolicyFailure(target) {
  try {
    await assertNoKnowledgeSymlink(target);
    return null;
  } catch (e) {
    if (e instanceof KnowledgeSymlinkError) {
      return { status: "invalid_setup", summary: `knowledge symlink policy: ${e.message}; manual repair required` };
    }
    return { status: "invalid_setup", summary: `knowledge path check failed: ${e.message}` };
  }
}

// ── helpers (item #4: idempotency) ──────────────────────────────────────────

// Extract the textual content of a Markdown bullet-list line (`- foo` /
// `* foo`). Returns the trimmed remainder, or null if the line is not a
// bullet-list item.
function bulletContent(line) {
  const m = /^[-*]\s+(.*)$/.exec(String(line).trim());
  return m ? m[1].trim() : null;
}

// Extract the content portion of a `## Disputed` line of the form
// `- [YYYY-MM-DD] body`. Returns the trimmed body, or null if the line is
// not a dated disputed bullet.
function disputedContent(line) {
  const m = /^[-*]\s+\[\d{4}-\d{2}-\d{2}\]\s+(.*)$/.exec(String(line).trim());
  return m ? m[1].trim() : null;
}

// ── public dispatcher ───────────────────────────────────────────────────────
export async function capture(args = {}) {
  const kind = args.kind;
  if (typeof args.content !== "string" || args.content.trim().length === 0) {
    return { status: "invalid", summary: "content (string) is required" };
  }
  const discovery = await refreshForbiddenMarkers();
  const marker = assertNoForbiddenMarkers(args, discovery.markers);
  if (marker) {
    return { status: "invalid", summary: `content contains a managed marker token (${marker}); refusing to capture` };
  }
  // Item #14: deterministic redaction scan. Block by default; allow override
  // via `confirm_redaction_skip:true`. Scan ALL string fields (including new
  // structured fields like failed_attempt and context) so a leak in any field
  // is surfaced without needing to maintain an explicit field list.
  if (!args.confirm_redaction_skip) {
    const allStrings = Object.values(args)
      .flatMap(v => Array.isArray(v) ? v : [v])
      .filter(s => typeof s === "string");
    const r = scanRedactable(allStrings.join("\n"));
    if (r.findings.length > 0) {
      return {
        status: "needs_redaction",
        summary: `Possible secrets/PII detected (${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}); redact and retry, or pass {confirm_redaction_skip:true} to override`,
        findings: r.findings
      };
    }
  }
  // Item #28: convert lock-busy errors into a friendly busy status so the
  // agent can retry instead of seeing a generic invalid result.
  try {
    switch (kind) {
      case "quick_rule": return await captureQuickRule(args);
      case "domain_new": return await captureDomainNew(args);
      case "domain_update": return await captureDomainUpdate(args);
      case "disputed": return await captureDisputed(args);
      case "alias_add": return await captureAliasAdd(args);
      default:
        return { status: "invalid", summary: `kind must be one of quick_rule|domain_new|domain_update|disputed|alias_add (got ${JSON.stringify(kind)})` };
    }
  } catch (e) {
    if (e?.code === "ELOCKBUSY") {
      return { status: "busy", summary: `another writer is holding the file lock; retry in a moment (${e.message})` };
    }
    throw e;
  }
}

// ── quick_rule ──────────────────────────────────────────────────────────────
async function captureQuickRule({ content, demote_target }) {
  const trimmedContent = content.trim();
  if (trimmedContent.length > QR_MAX_CHARS) {
    return {
      status: "invalid",
      summary: `Quick Rule content exceeds ${QR_MAX_CHARS} characters (${trimmedContent.length}); shorten before capture`
    };
  }
  const ruleLine = `- ${trimmedContent}`;
  let outcome = null; // captured by the buildInner callback for the result message

  // Item #9: pick which marker pair the file is using (legacy vs namespaced).
  let qrPair;
  try {
    const fresh = await readWithStatOrNull(INSTRUCTIONS_MD);
    qrPair = pickMarkerPair(fresh?.content ?? "", QR_BEGIN_NS, QR_END_NS, QR_BEGIN, QR_END);
  } catch {
    qrPair = { begin: QR_BEGIN_NS, end: QR_END_NS, form: "default-namespaced" };
  }

  // Item #11: load QR metadata sidecar so at_cap can rank existing rules
  // oldest-first and the agent has a defensible demote target.
  let qrMeta;
  try { qrMeta = await loadQrMeta(); } catch { qrMeta = { rules: [] }; }

  let demotedRule = null;   // populated when an existing rule is removed by demote_target
  let addedRule = null;   // populated when ruleLine is appended

  const r = await casReplaceMarkers(INSTRUCTIONS_MD, qrPair.begin, qrPair.end, (_full, freshInner) => {
    const rows = freshInner.split("\n").map(l => l.trim());
    const unknownLines = rows.filter(l => l && !/^[-*]\s+\S/.test(l));
    if (unknownLines.length > 0) {
      outcome = { status: "non_list", unknownLines: unknownLines.length };
      return null;
    }
    const lines = rows.filter(l => /^[-*]\s+\S/.test(l));

    // Idempotency (item #4): if an existing rule normalizes to the same
    // content as the incoming rule, return ok with unchanged:true. Avoids
    // duplicate appends from agent/transport retries.
    const incomingNorm = trimmedContent.toLowerCase();
    const dupHit = lines.some(l => {
      const c = bulletContent(l);
      return c && c.toLowerCase() === incomingNorm;
    });
    if (dupHit) {
      outcome = { status: "unchanged", count: lines.length };
      return null;
    }

    if (lines.length >= QR_CAP) {
      if (!demote_target) {
        // Item #11: return rules ranked oldest-first so the agent has a
        // defensible demote target. Existing rules without metadata sort
        // to the top (treated as oldest).
        outcome = { status: "at_cap", existing: rankExistingRules(lines, qrMeta) };
        return null; // signals no-op
      }
      const idx = lines.findIndex(l => l.toLowerCase().includes(demote_target.toLowerCase()));
      if (idx < 0) {
        outcome = { status: "not_found", existing: rankExistingRules(lines, qrMeta) };
        return null;
      }
      demotedRule = lines[idx];
      lines.splice(idx, 1);
    }
    if (lines.length >= QR_CAP) {
      outcome = { status: "invalid_setup", overCap: lines.length };
      return null;
    }
    lines.push(ruleLine);
    addedRule = ruleLine;
    outcome = { status: "ok", count: lines.length };
    return `\n${lines.join("\n")}\n`;
  });

  // Preflight: make sure markers exist and are well-formed before considering
  // business outcomes. "malformed" → manual repair required; do not write.
  if (r.status === "missing") {
    return { status: "invalid_setup", summary: "QR:BEGIN/QR:END markers not found in instructions" };
  }
  if (r.status === "malformed") {
    return { status: "invalid_setup", summary: "QR:BEGIN/QR:END markers are malformed (orphan, duplicate, or reversed) in instructions; manual repair required" };
  }
  if (!outcome && r.status !== "ok") {
    // Read failed before the callback could run (e.g. file missing).
    if (r.status === "build_error") return { status: "invalid_setup", summary: r.error };
    return { status: r.status, summary: `instructions update ${r.status}` };
  }

  // Map callback-recorded outcome to the public result envelope.
  switch (outcome.status) {
    case "at_cap":
      return {
        status: "at_cap",
        summary: `Quick Rules at cap (${QR_CAP}). Provide demote_target (substring of an existing rule to remove) and retry.`,
        existing: outcome.existing
      };
    case "not_found":
      return {
        status: "not_found",
        summary: `demote_target not found in Quick Rules: ${JSON.stringify(demote_target)}`,
        existing: outcome.existing
      };
    case "invalid_setup":
      return { status: "invalid_setup", summary: `Quick Rules block already over cap (${outcome.overCap}); manual cleanup required.` };
    case "non_list":
      return { status: "invalid_setup", summary: `Quick Rules block contains non-list content (${outcome.unknownLines} line(s)); manual cleanup required.` };
    case "unchanged":
      return { status: "ok", unchanged: true, summary: `Quick Rule already present (${outcome.count}/${QR_CAP}); no change` };
    case "ok":
      // CAS may still have failed even though the callback succeeded.
      if (!r.ok) return { status: r.status, summary: `instructions update ${r.status}` };
      // Item #11: persist sidecar metadata for the new rule. If a demote
      // happened, drop the demoted rule's metadata too.
      try {
        const stamp = today();
        const upserts = [];
        if (addedRule) {
          const c = bulletContent(addedRule);
          if (c) upserts.push({ hash: qrHash(c), addedAt: stamp });
        }
        // We just upsert the new entry; demoted rules age out naturally if
        // their hash no longer matches the active set on the next save.
        if (upserts.length > 0) await saveQrMeta(upserts);
      } catch { /* best-effort sidecar */ }
      return { status: "ok", summary: `Quick Rule added (${outcome.count}/${QR_CAP})${demotedRule ? `; demoted "${demotedRule}"` : ""}`, demoted: demotedRule || undefined };
    default:
      return { status: "invalid_setup", summary: `unexpected internal state: ${JSON.stringify(outcome)}` };
  }
}

// ── domain_new ──────────────────────────────────────────────────────────────
async function captureDomainNew({ content, domain, summary, tags, aliases = [], see_also = [], section, kind_meta, context, failed_attempt }) {
  const fileKind = kind_meta || "fact";
  const meta = {
    domain,
    kind: fileKind,
    summary: summary || "",
    tags: Array.isArray(tags) ? tags : [],
    aliases: Array.isArray(aliases) ? aliases : [],
    see_also: Array.isArray(see_also) ? see_also : [],
    verified: today(),
    deprecated: null
  };
  const v = validateMeta(meta);
  if (!v.ok) return { status: "invalid", summary: v.errors.join("; ") };

  let target;
  try { target = resolveDomainFile(domain); }
  catch (e) { return { status: "invalid", summary: e.message }; }
  {
    const symlinkFailure = await symlinkPolicyFailure(target);
    if (symlinkFailure) return symlinkFailure;
  }
  await fs.mkdir(KNOWLEDGE_ROOT, { recursive: true });
  {
    const symlinkFailure = await symlinkPolicyFailure(target);
    if (symlinkFailure) return symlinkFailure;
  }

  const sectionHeader = pickSectionHeader(section);
  const bodyLines = [
    `# ${titleCase(domain)}`,
    "",
    summary,
    ""
  ];
  // Structured field: context — when/why this lesson applies.
  if (context && typeof context === "string" && context.trim()) {
    bodyLines.push(`_${context.trim()}_`, "");
  }
  bodyLines.push(
    `## ${sectionHeader}`,
    "",
    `- ${content.trim()}`,
    ""
  );
  // Structured field: failed_attempt — what was tried and didn't work.
  if (failed_attempt && typeof failed_attempt === "string" && failed_attempt.trim()) {
    bodyLines.push(
      `## ${pickSectionHeader("broken")}`,
      "",
      `- ${failed_attempt.trim()}`,
      ""
    );
  }
  bodyLines.push(
    "## Disputed",
    "",
    "<!-- Append-only. Format: `- [YYYY-MM-DD] tried X — got Y — workaround: Z` -->",
    ""
  );
  const body = bodyLines.join("\n");

  // Existence check + write inside the same lock. Without this, two concurrent
  // domain_new calls for the same slug both pass the existence check and one
  // silently clobbers the other.
  const lockResult = await withLock(target, async () => {
    const symlinkFailure = await symlinkPolicyFailure(target);
    if (symlinkFailure) return symlinkFailure;
    try {
      await fs.access(target);
      return { conflict: true };
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    await atomicWrite(target, stringify(meta, body));
    return { conflict: false };
  });
  if (lockResult.status === "invalid_setup") return lockResult;
  if (lockResult.conflict) return { status: "conflict", summary: `domain already exists: ${domain}` };

  const sync = await runPostWriteSync();
  return { status: "ok", summary: `Created knowledge/${domain}.md`, file: target, sync };
}

// ── domain_update ───────────────────────────────────────────────────────────
async function captureDomainUpdate({ content, domain, section = "working", failed_attempt }) {
  if (!isValidSlug(domain)) return { status: "invalid", summary: `invalid domain slug: ${domain}` };
  const target = resolveDomainFile(domain);
  {
    const symlinkFailure = await symlinkPolicyFailure(target);
    if (symlinkFailure) return symlinkFailure;
  }

  // Read-modify-write inside the lock so a concurrent writer cannot land
  // between our read and our write.
  const result = await withLock(target, async () => {
    const symlinkFailure = await symlinkPolicyFailure(target);
    if (symlinkFailure) return symlinkFailure;
    const fresh = await readWithStatOrNull(target);
    if (!fresh) return { status: "not_found", summary: `domain file not found: ${domain}.md` };

    let parsed;
    try { parsed = parse(fresh.content); }
    catch (e) { return { status: "invalid_setup", summary: `frontmatter parse: ${e.message}` }; }

    const header = pickSectionHeader(section);
    let body = parsed.body;
    const sectionRe = new RegExp(`(##\\s+${escapeRegex(header)}[^\\n]*\\n)([\\s\\S]*?)(?=\\n##\\s|$)`);
    const m = sectionRe.exec(body);
    // Idempotency (item #4): track whether the content bullet is a dup so we
    // can still process failed_attempt even when content itself is unchanged.
    let contentChanged = true;
    if (m) {
      const incomingNorm = content.trim().toLowerCase();
      const isDup = m[2].split("\n").some(l => {
        const c = bulletContent(l);
        return c && c.toLowerCase() === incomingNorm;
      });
      if (isDup) contentChanged = false;
    }
    let nextBody;
    if (contentChanged) {
      if (m) {
        nextBody = body.slice(0, m.index + m[1].length) +
          (m[2].endsWith("\n") ? m[2] : m[2] + "\n") +
          `- ${content.trim()}\n` +
          body.slice(m.index + m[0].length);
      } else {
        nextBody = body.replace(/\s*$/, "\n") + `\n## ${header}\n\n- ${content.trim()}\n`;
      }
    } else {
      nextBody = body;
    }

    // Structured field: failed_attempt — also append to the broken section in
    // the same atomic write so the two updates are never split across files.
    let addedFailedAttempt = false;
    if (failed_attempt && typeof failed_attempt === "string" && failed_attempt.trim()) {
      const brokenHeader = pickSectionHeader("broken");
      const brokenRe = new RegExp(`(##\\s+${escapeRegex(brokenHeader)}[^\\n]*\\n)([\\s\\S]*?)(?=\\n##\\s|$)`);
      const bm = brokenRe.exec(nextBody);
      if (bm) {
        // Idempotency: skip if bullet already present in Broken section.
        const failedNorm = failed_attempt.trim().toLowerCase();
        const alreadyPresent = bm[2].split("\n").some(l => {
          const c = bulletContent(l);
          return c && c.toLowerCase() === failedNorm;
        });
        if (!alreadyPresent) {
          nextBody = nextBody.slice(0, bm.index + bm[1].length) +
            (bm[2].endsWith("\n") ? bm[2] : bm[2] + "\n") +
            `- ${failed_attempt.trim()}\n` +
            nextBody.slice(bm.index + bm[0].length);
          addedFailedAttempt = true;
        }
      } else {
        // Insert broken section before ## Disputed (or at end).
        const dispIdx = /\n##\s+Disputed/i.exec(nextBody)?.index ?? -1;
        if (dispIdx >= 0) {
          nextBody = nextBody.slice(0, dispIdx) +
            `\n\n## ${brokenHeader}\n\n- ${failed_attempt.trim()}\n` +
            nextBody.slice(dispIdx);
        } else {
          nextBody = nextBody.replace(/\s*$/, "\n") + `\n## ${brokenHeader}\n\n- ${failed_attempt.trim()}\n`;
        }
        addedFailedAttempt = true;
      }
    }

    // If nothing changed at all, return unchanged without a write.
    if (!contentChanged && !addedFailedAttempt) {
      return { status: "ok", unchanged: true, summary: `Already present in ## ${header} of ${domain}.md; no change`, file: target };
    }

    const nextMeta = { ...parsed.meta, verified: today() };
    const v = validateMeta(nextMeta);
    if (!v.ok) return { status: "invalid_setup", summary: `frontmatter validate (manual repair required): ${v.errors.join("; ")}` };
    await atomicWrite(target, stringify(nextMeta, nextBody));
    const parts = [];
    if (contentChanged) parts.push(`Appended to ## ${header} in ${domain}.md`);
    if (addedFailedAttempt) parts.push("also added failed_attempt to broken section");
    return { status: "ok", summary: parts.join("; "), file: target };
  });

  if (result.status !== "ok") return result;
  // Skip post-write sync when the call was a no-op.
  if (result.unchanged) return { ...result, sync: { ok: true, skipped: true } };
  const sync = await runPostWriteSync();
  return { ...result, sync };
}

// ── disputed ────────────────────────────────────────────────────────────────
async function captureDisputed({ content, domain }) {
  if (!isValidSlug(domain)) return { status: "invalid", summary: `invalid domain slug: ${domain}` };
  const target = resolveDomainFile(domain);
  {
    const symlinkFailure = await symlinkPolicyFailure(target);
    if (symlinkFailure) return symlinkFailure;
  }

  return await withLock(target, async () => {
    const symlinkFailure = await symlinkPolicyFailure(target);
    if (symlinkFailure) return symlinkFailure;
    const fresh = await readWithStatOrNull(target);
    if (!fresh) return { status: "not_found", summary: `domain file not found: ${domain}.md` };

    let parsed;
    try { parsed = parse(fresh.content); }
    catch (e) { return { status: "invalid_setup", summary: `frontmatter parse: ${e.message}` }; }

    const line = `- [${today()}] ${content.trim()}`;
    const body = parsed.body;
    // Idempotency (item #4): match by content body (ignoring the date
    // prefix), so a retry on a later day still recognises a prior capture
    // of the same dispute.
    const incomingNorm = content.trim().toLowerCase();
    const dispMatch = /##\s+Disputed[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i.exec(body);
    if (dispMatch) {
      const isDup = dispMatch[1].split("\n").some(l => {
        const c = disputedContent(l);
        return c && c.toLowerCase() === incomingNorm;
      });
      if (isDup) {
        return { status: "ok", unchanged: true, summary: `Already in ## Disputed of ${domain}.md; no change`, file: target, sync: { ok: true, skipped: true } };
      }
    }
    let nextBody;
    if (/##\s+Disputed/i.test(body)) {
      nextBody = body.replace(/(##\s+Disputed[^\n]*\n(?:[ \t]*\n)*(?:<!--[\s\S]*?-->\s*\n?)?)/i, (full) => `${full}\n${line}\n`);
      if (nextBody === body) {
        nextBody = body.replace(/\s*$/, "\n") + `\n${line}\n`;
      }
    } else {
      nextBody = body.replace(/\s*$/, "\n") + `\n## Disputed\n\n${line}\n`;
    }
    await atomicWrite(target, stringify(parsed.meta, nextBody));
    // No sync needed — disputes don't change tags/aliases. Return a sync stub
    // so callers see a consistent shape across all capture kinds.
    return { status: "ok", summary: `Disputed entry added to ${domain}.md`, file: target, sync: { ok: true, skipped: true } };
  });
}

// ── alias_add ───────────────────────────────────────────────────────────────
async function captureAliasAdd({ content, domain, tags = [], aliases = [] }) {
  if (!isValidSlug(domain)) return { status: "invalid", summary: `invalid domain slug: ${domain}` };
  const requested = normalizeAliasAddRequest(tags, aliases);
  if (!requested.ok) {
    return {
      status: "invalid",
      summary: `invalid alias_add request: ${requested.errors.join("; ")}`,
      invalid: requested.invalid
    };
  }
  const target = resolveDomainFile(domain);
  {
    const symlinkFailure = await symlinkPolicyFailure(target);
    if (symlinkFailure) return symlinkFailure;
  }

  const result = await withLock(target, async () => {
    const symlinkFailure = await symlinkPolicyFailure(target);
    if (symlinkFailure) return symlinkFailure;
    const fresh = await readWithStatOrNull(target);
    if (!fresh) return { status: "not_found", summary: `domain file not found: ${domain}.md` };

    let parsed;
    try { parsed = parse(fresh.content); }
    catch (e) { return { status: "invalid_setup", summary: `frontmatter parse: ${e.message}` }; }

    const meta = parsed.meta;
    const existingValid = validateExistingAliasAddMeta(meta);
    if (!existingValid.ok) {
      return { status: "invalid_setup", summary: `frontmatter validate (manual repair required): ${existingValid.errors.join("; ")}` };
    }

    const existingTags = meta.tags || [];
    const existingAliases = meta.aliases || [];
    const beforeTags = new Set(existingTags);
    const beforeAls = new Set(existingAliases);
    const mergedTags = new Set(existingTags);
    const mergedAliases = new Set(existingAliases);
    for (const t of requested.tags) mergedTags.add(t);
    for (const a of requested.aliases) mergedAliases.add(a);

    if (existingValid.overCap.tags || existingValid.overCap.aliases) {
      return aliasAddAtCapResult({
        domain,
        field: capField(existingValid.overCap.tags, existingValid.overCap.aliases),
        existingTags,
        existingAliases,
        requested
      });
    }

    const nextTags = [...mergedTags];
    const nextAliases = [...mergedAliases];
    const tagsOverCap = nextTags.length > TAG_CAP;
    const aliasesOverCap = nextAliases.length > ALIAS_CAP;
    if (tagsOverCap || aliasesOverCap) {
      return aliasAddAtCapResult({
        domain,
        field: capField(tagsOverCap, aliasesOverCap),
        existingTags,
        existingAliases,
        requested
      });
    }

    if (mergedTags.size === beforeTags.size && mergedAliases.size === beforeAls.size) {
      return {
        status: "ok",
        summary: `No routing terms changed for ${domain}.md`,
        file: target,
        unchanged: true,
        sync: { ok: true, skipped: true }
      };
    }

    const nextMeta = { ...meta, tags: nextTags, aliases: nextAliases, verified: today() };
    const v = validateMeta(nextMeta);
    if (!v.ok) return { status: "invalid_setup", summary: `frontmatter validate (manual repair required): ${v.errors.join("; ")}` };

    await atomicWrite(target, stringify(nextMeta, parsed.body));
    return {
      status: "ok",
      summary: `Updated ${domain}.md (tags=${nextMeta.tags.length}, aliases=${nextMeta.aliases.length})`,
      file: target,
      note: content.trim() ? `context: ${content.trim().slice(0, 140)}` : undefined
    };
  });

  if (result.status !== "ok") return result;
  if (result.sync?.skipped) return result;
  const sync = await runPostWriteSync();
  return { ...result, sync };
}

// ── helpers ─────────────────────────────────────────────────────────────────
function pickSectionHeader(s) {
  switch ((s || "working").toLowerCase()) {
    case "broken": return "❌ Broken / Don't try";
    case "gotcha": return "⚠️ Gotchas";
    case "working":
    default: return "✅ Working";
  }
}

function titleCase(s) {
  return String(s).replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function normalizeAliasAddRequest(tags, aliases) {
  const requestedTags = [];
  const requestedAliases = [];
  const invalidTags = [];
  const invalidAliases = [];
  const tagInputs = Array.isArray(tags) ? tags : [];
  const aliasInputs = Array.isArray(aliases) ? aliases : [];

  for (const raw of tagInputs) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim().toLowerCase();
    if (!isValidTag(tag)) invalidTags.push(raw);
    else if (!requestedTags.includes(tag)) requestedTags.push(tag);
  }
  for (const raw of aliasInputs) {
    if (typeof raw !== "string") continue;
    const alias = raw.trim();
    if (!isValidAlias(alias)) invalidAliases.push(raw);
    else if (!requestedAliases.includes(alias)) requestedAliases.push(alias);
  }

  const errors = [];
  if (invalidTags.length) errors.push(`invalid tags: ${invalidTags.map(JSON.stringify).join(", ")}`);
  if (invalidAliases.length) errors.push(`invalid aliases: ${invalidAliases.map(JSON.stringify).join(", ")}`);
  return {
    ok: errors.length === 0,
    errors,
    invalid: { tags: invalidTags, aliases: invalidAliases },
    tags: requestedTags,
    aliases: requestedAliases
  };
}

function validateExistingAliasAddMeta(meta) {
  const v = validateMeta(meta);
  if (v.ok) return { ok: true, errors: [], overCap: { tags: false, aliases: false } };

  const tagArray = Array.isArray(meta?.tags);
  const aliasArray = Array.isArray(meta?.aliases);
  const tagsOverCap = tagArray && meta.tags.length > TAG_CAP;
  const aliasesOverCap = aliasArray && meta.aliases.length > ALIAS_CAP;
  const tagEntriesValid = tagArray && meta.tags.length >= 1 && meta.tags.every(isValidTag);
  const aliasEntriesValid = aliasArray && meta.aliases.every(isValidAlias);
  const capProbe = {
    ...meta,
    tags: tagsOverCap ? meta.tags.slice(0, TAG_CAP) : meta.tags,
    aliases: aliasesOverCap ? meta.aliases.slice(0, ALIAS_CAP) : meta.aliases
  };

  if ((tagsOverCap || aliasesOverCap) && tagEntriesValid && aliasEntriesValid && validateMeta(capProbe).ok) {
    return { ok: true, errors: [], overCap: { tags: tagsOverCap, aliases: aliasesOverCap } };
  }
  return { ok: false, errors: v.errors, overCap: { tags: false, aliases: false } };
}

function aliasAddAtCapResult({ domain, field, existingTags, existingAliases, requested }) {
  return {
    status: "at_cap",
    summary: `alias_add would exceed ${field} cap for ${domain}.md; prioritize existing routing terms before retrying.`,
    field,
    cap: { tags: TAG_CAP, aliases: ALIAS_CAP },
    existing: { tags: [...existingTags], aliases: [...existingAliases] },
    requested: { tags: [...requested.tags], aliases: [...requested.aliases] }
  };
}

function capField(tagsOverCap, aliasesOverCap) {
  if (tagsOverCap && aliasesOverCap) return "both";
  return tagsOverCap ? "tags" : "aliases";
}

function isValidTag(value) {
  return typeof value === "string" && TAG_RE.test(value);
}

function isValidAlias(value) {
  return typeof value === "string" && value.length >= ALIAS_MIN_CHARS && value.length <= ALIAS_MAX_CHARS;
}

// Optional debug entry for the route tool.
export async function debugRoute({ intent }) {
  if (typeof intent !== "string" || intent.length === 0) {
    return { status: "invalid", summary: "intent string required" };
  }
  const matches = await routeFromDisk(intent);
  return { status: "ok", count: matches.length, matches };
}

// Item #10: capture preview — return existing candidate matches WITHOUT
// writing, so the agent can choose between domain_new and domain_update
// (or confirm there is no near-match before persisting). Read-only.
//
// Inputs are the same shape as `capture()` but only `tags`, `aliases`,
// `domain`, `kind` are inspected. Returns:
//   { status: "ok",
//     candidates: [{ slug, source, sharedTags, sharedAliases, confidence }],
//     suggestedKind: "domain_new" | "domain_update" | "alias_add" }
export async function previewCapture({ kind, domain, tags = [], aliases = [] } = {}) {
  const candidates = [];
  // Slug match → strong signal that domain_update is the right kind.
  if (typeof domain === "string" && isValidSlug(domain)) {
    try {
      await fs.access(resolveDomainFile(domain));
      candidates.push({ slug: domain, source: "slug", sharedTags: [], sharedAliases: [], confidence: "high" });
    } catch { /* file does not exist — fine */ }
  }
  // Tag/alias overlap with the routing table.
  const tagSet = new Set((Array.isArray(tags) ? tags : []).filter(t => typeof t === "string"));
  const aliasSet = new Set((Array.isArray(aliases) ? aliases : []).filter(a => typeof a === "string").map(a => a.toLowerCase()));
  if (tagSet.size > 0 || aliasSet.size > 0) {
    let table;
    try { table = await loadRouting(); } catch { table = null; }
    for (const e of table?.domains || []) {
      if (e.deprecated) continue;
      const sharedTags = (e.tags || []).filter(t => tagSet.has(t));
      const sharedAliases = (e.aliases || []).filter(a => aliasSet.has(String(a).toLowerCase()));
      if (sharedTags.length === 0 && sharedAliases.length === 0) continue;
      // Skip slug-matched entry (already added).
      if (candidates.some(c => c.slug === e.domain && c.source === "slug")) continue;
      candidates.push({
        slug: e.domain,
        source: "overlap",
        sharedTags, sharedAliases,
        confidence: (sharedTags.length + sharedAliases.length) >= 2 ? "high" : "medium"
      });
    }
  }
  // Disambiguation hint for the agent.
  const slugHit = candidates.find(c => c.source === "slug");
  let suggestedKind;
  if (slugHit) suggestedKind = "domain_update";
  else if (candidates.length > 0 && (kind === "domain_new" || !kind))
    suggestedKind = "alias_add";
  else suggestedKind = kind || "domain_new";
  return { status: "ok", candidates, suggestedKind };
}
// Mark a domain file's frontmatter as deprecated:<today>. The router skips
// deprecated entries on the next prompt; the headless audit eventually
// archives any file deprecated >30 days. This is the graceful retire path
// for a domain that should no longer route but whose history is worth
// keeping in place.
export async function deprecate({ domain }) {
  if (!isValidSlug(domain)) return { status: "invalid", summary: `invalid domain slug: ${domain}` };
  const target = resolveDomainFile(domain);
  {
    const symlinkFailure = await symlinkPolicyFailure(target);
    if (symlinkFailure) return symlinkFailure;
  }
  const result = await withLock(target, async () => {
    const symlinkFailure = await symlinkPolicyFailure(target);
    if (symlinkFailure) return symlinkFailure;
    const fresh = await readWithStatOrNull(target);
    if (!fresh) return { status: "not_found", summary: `domain file not found: ${domain}.md` };
    let parsed;
    try { parsed = parse(fresh.content); }
    catch (e) { return { status: "invalid_setup", summary: `frontmatter parse: ${e.message}` }; }
    if (parsed.meta.deprecated) {
      return { status: "ok", unchanged: true, summary: `Already deprecated: ${parsed.meta.deprecated}`, file: target, deprecatedAt: parsed.meta.deprecated };
    }
    const stamp = today();
    const nextMeta = { ...parsed.meta, deprecated: stamp };
    const v = validateMeta(nextMeta);
    if (!v.ok) return { status: "invalid_setup", summary: `frontmatter validate: ${v.errors.join("; ")}` };
    await atomicWrite(target, stringify(nextMeta, parsed.body));
    return { status: "ok", summary: `Marked ${domain}.md deprecated:${stamp}`, file: target, deprecatedAt: stamp };
  });
  if (result.status !== "ok") return result;
  if (result.unchanged) return { ...result, sync: { ok: true, skipped: true } };
  const sync = await runPostWriteSync();
  return { ...result, sync };
}

// ── QR metadata sidecar (item #11) ──────────────────────────────────────────
// Quick Rules live as Markdown bullets inside the QR managed block, with no
// in-band place to store per-rule metadata like capture date. We keep a
// sidecar JSON at ${KNOWLEDGE_ROOT}/_qr-meta.json keyed by the lower-cased
// trimmed rule body. On at_cap, we return existing rules sorted oldest-
// first so the agent has a defensible demote target.

const QR_META_FILE = "_qr-meta.json";

async function loadQrMeta() {
  try {
    const raw = await fs.readFile(join(KNOWLEDGE_ROOT, QR_META_FILE), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.rules)) return { rules: [] };
    const seen = new Map();
    for (const r of parsed.rules) {
      if (!r || typeof r !== "object") continue;
      if (typeof r.hash !== "string") continue;
      if (typeof r.addedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.addedAt)) continue;
      seen.set(r.hash, { hash: r.hash, addedAt: r.addedAt });
    }
    return { rules: [...seen.values()] };
  } catch (e) {
    if (e.code === "ENOENT") return { rules: [] };
    return { rules: [] };
  }
}

async function saveQrMeta(rulesToUpsert) {
  const path = join(KNOWLEDGE_ROOT, QR_META_FILE);
  await fs.mkdir(KNOWLEDGE_ROOT, { recursive: true });
  await withLock(path, async () => {
    const fresh = await loadQrMeta();
    const seen = new Map(fresh.rules.map(r => [r.hash, r]));
    for (const r of rulesToUpsert) seen.set(r.hash, r);
    await atomicWrite(path, JSON.stringify({ rules: [...seen.values()] }, null, 2));
  });
}

function qrHash(text) {
  return String(text || "").trim().toLowerCase();
}

// Annotate the existing-rules list returned on at_cap with addedAt
// metadata. Sorted oldest-first; rules with no metadata are treated as
// oldest (best demotion candidate).
function rankExistingRules(existingLines, meta) {
  const byHash = new Map((meta.rules || []).map(r => [r.hash, r]));
  return existingLines.map(line => {
    const c = bulletContent(line);
    const h = c ? qrHash(c) : "";
    const m = byHash.get(h);
    return { rule: line, addedAt: m?.addedAt || null };
  }).sort((a, b) => {
    const aKey = a.addedAt || "0000-00-00";
    const bKey = b.addedAt || "0000-00-00";
    return aKey.localeCompare(bKey);
  });
}

// ── status (item #13) ───────────────────────────────────────────────────────
// Read-only health snapshot. Reports routing freshness, domain count, usage
// totals, and the last migration result so a user can see at a glance
// whether the extension is doing useful work.
export async function status() {
  const { ROUTING_JSON, USAGE_JSON } = await import("./paths.mjs");
  const { isMigrationBlocked, migrationLastResult } = await import("./migrate.mjs");
  const out = {
    status: "ok",
    knowledgeRoot: KNOWLEDGE_ROOT,
    routing: { exists: false, ageHours: null, domainCount: 0 },
    usage: { exists: false, totalDomains: 0, totalHits: 0 },
    migration: migrationLastResult(),
    blocked: isMigrationBlocked(),
    issues: []
  };
  try {
    const st = await fs.stat(ROUTING_JSON);
    out.routing.exists = true;
    out.routing.ageHours = Math.round((Date.now() - st.mtimeMs) / 3_600_000 * 10) / 10;
    const table = await loadRouting();
    out.routing.domainCount = table?.domains?.length || 0;
  } catch (e) {
    if (e.code !== "ENOENT") out.issues.push(`routing read error: ${e.message}`);
  }
  try {
    const raw = await fs.readFile(USAGE_JSON, "utf8");
    const u = JSON.parse(raw);
    out.usage.exists = true;
    out.usage.totalDomains = Object.keys(u.domains || {}).length;
    out.usage.totalHits = Object.values(u.domains || {}).reduce((a, v) => a + (Number.isFinite(v?.hits) ? v.hits : 0), 0);
  } catch (e) {
    if (e.code !== "ENOENT") out.issues.push(`usage read error: ${e.message}`);
  }
  // Heuristic alerts.
  if (out.blocked) out.issues.push(`knowledge migration blocked (${out.migration?.status || "unknown"}); writes refused until resolved`);
  if (out.routing.exists && out.routing.ageHours !== null && out.routing.ageHours > 24 * 7) {
    out.issues.push(`routing.json is ${Math.round(out.routing.ageHours / 24)} days old; run jit_memory_audit or capture a lesson to refresh`);
  }
  if (out.routing.exists && out.routing.domainCount === 0 && !out.blocked) {
    out.issues.push("routing.json is present but contains no domains; try capturing a domain_new lesson");
  }
  return out;
}
// Immediately retire a domain by moving its file to _archive/. The agent
// MUST pass `confirm:true`; otherwise we return a needs_confirm preview.
// Routing stops including the file on the next prompt (post-write sync).
//
// (The "deprecate (item #8)" header label above is for grouping; this is
// actually `deleteDomain`. The graceful `deprecate` is defined earlier.)
export async function deleteDomain({ domain, confirm = false }) {
  if (!isValidSlug(domain)) return { status: "invalid", summary: `invalid domain slug: ${domain}` };
  const target = resolveDomainFile(domain);
  {
    const symlinkFailure = await symlinkPolicyFailure(target);
    if (symlinkFailure) return symlinkFailure;
  }
  const result = await withLock(target, async () => {
    const symlinkFailure = await symlinkPolicyFailure(target);
    if (symlinkFailure) return symlinkFailure;
    const fresh = await readWithStatOrNull(target);
    if (!fresh) return { status: "not_found", summary: `domain file not found: ${domain}.md` };
    if (!confirm) {
      return {
        status: "needs_confirm",
        summary: `Will move knowledge/${domain}.md to knowledge/_archive/${domain}.md. Re-call with confirm:true to proceed.`,
        file: target
      };
    }
    const archiveDir = join(KNOWLEDGE_ROOT, "_archive");
    await fs.mkdir(archiveDir, { recursive: true });
    let dst = join(archiveDir, `${domain}.md`);
    // Avoid overwriting an existing archived file with the same slug.
    try {
      await fs.access(dst);
      const ts = today() + "-" + Date.now().toString(36);
      dst = join(archiveDir, `${domain}.${ts}.md`);
    } catch { /* ENOENT — fine */ }
    await fs.rename(target, dst);
    return { status: "ok", summary: `Archived ${domain}.md → ${dst}`, file: target, archivedTo: dst };
  });
  if (result.status !== "ok") return result;
  const sync = await runPostWriteSync();
  return { ...result, sync };
}
