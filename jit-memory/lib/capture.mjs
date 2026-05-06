// Capture: agent-callable lesson-writing pipeline.
// Five kinds: quick_rule, domain_new, domain_update, disputed, alias_add.
//
// All return { status, summary, ... } where status ∈
//   ok | at_cap | invalid | conflict | not_found | invalid_setup
// `invalid` is the only resultType:failure for the SDK; everything else is a
// valid business outcome reported back to the model as success.

import { promises as fs } from "node:fs";
import {
  INSTRUCTIONS_MD,
  resolveDomainFile, isValidSlug
} from "./paths.mjs";
import {
  atomicWrite, withLock, readWithStatOrNull, casReplaceMarkers
} from "./atomic.mjs";
import { parse, stringify, validateMeta } from "./frontmatter.mjs";
import { syncNow } from "./sync.mjs";
import { routeFromDisk, invalidateRoutingCache } from "./router.mjs";

export const QR_BEGIN = "<!-- QR:BEGIN -->";
export const QR_END   = "<!-- QR:END -->";
const QR_CAP = 10;

// Managed marker tokens that must NEVER appear inside captured content,
// summaries, tags, or aliases. If they did, an attacker (or a careless agent)
// could break out of the QR/KB managed regions and inject arbitrary instructions
// that the parent CLI would treat as authoritative on the next session start.
//
// NOTE: this list is hard-coded and covers all managed regions known to the
// extension today (QR/KB own regions plus the efficiency-retro markers).
// If the user adds a new managed region in copilot-instructions.md, this list
// must be updated. A future improvement is to derive forbidden tokens from
// the live instructions file at startup.
const FORBIDDEN_MARKERS = [
  "<!-- QR:BEGIN -->", "<!-- QR:END -->",
  "<!-- KB:BEGIN -->", "<!-- KB:END -->",
  "<!-- efficiency-retro:managed-start", "<!-- efficiency-retro:managed-end"
];

function findForbiddenMarker(s) {
  if (typeof s !== "string") return null;
  const lower = s.toLowerCase();
  for (const m of FORBIDDEN_MARKERS) {
    if (lower.includes(m.toLowerCase())) return m;
  }
  return null;
}

// Walk every string field in args (recursively into arrays) and reject if any
// contains a managed marker token. Object keys are not inspected — only values.
function assertNoForbiddenMarkers(args) {
  const stack = [args];
  while (stack.length) {
    const cur = stack.pop();
    if (typeof cur === "string") {
      const hit = findForbiddenMarker(cur);
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
// `_syncFn` is a closure-bound reference so tests can swap it via
// _setSyncFnForTests when JITMEM_TEST_MODE=1. Gated by env var so production
// callers cannot accidentally repoint sync.
let _syncFn = syncNow;

export function _setSyncFnForTests(fn) {
  if (process.env.JITMEM_TEST_MODE !== "1") {
    throw new Error("_setSyncFnForTests is only available when JITMEM_TEST_MODE=1");
  }
  _syncFn = typeof fn === "function" ? fn : syncNow;
}

async function runPostWriteSync() {
  try {
    const r = await _syncFn();
    invalidateRoutingCache();
    return { ok: true, kbStatus: r?.kbStatus ?? "unknown" };
  } catch (e) {
    try { invalidateRoutingCache(); } catch {}
    return { ok: false, error: String(e?.message || e) };
  }
}

// ── public dispatcher ───────────────────────────────────────────────────────
export async function capture(args = {}) {
  const kind = args.kind;
  if (typeof args.content !== "string" || args.content.trim().length === 0) {
    return { status: "invalid", summary: "content (string) is required" };
  }
  const marker = assertNoForbiddenMarkers(args);
  if (marker) {
    return { status: "invalid", summary: `content contains a managed marker token (${marker}); refusing to capture` };
  }
  switch (kind) {
    case "quick_rule":    return await captureQuickRule(args);
    case "domain_new":    return await captureDomainNew(args);
    case "domain_update": return await captureDomainUpdate(args);
    case "disputed":      return await captureDisputed(args);
    case "alias_add":     return await captureAliasAdd(args);
    default:
      return { status: "invalid", summary: `kind must be one of quick_rule|domain_new|domain_update|disputed|alias_add (got ${JSON.stringify(kind)})` };
  }
}

// ── quick_rule ──────────────────────────────────────────────────────────────
async function captureQuickRule({ content, demote_target }) {
  const ruleLine = `- ${content.trim()}`;
  let outcome = null; // captured by the buildInner callback for the result message

  const r = await casReplaceMarkers(INSTRUCTIONS_MD, QR_BEGIN, QR_END, (_full, freshInner) => {
    const lines = freshInner.split("\n").map(l => l.trim()).filter(l => /^[-*]\s+\S/.test(l));

    if (lines.length >= QR_CAP) {
      if (!demote_target) {
        outcome = { status: "at_cap", existing: [...lines] };
        return null; // signals no-op
      }
      const idx = lines.findIndex(l => l.toLowerCase().includes(demote_target.toLowerCase()));
      if (idx < 0) {
        outcome = { status: "not_found", existing: [...lines] };
        return null;
      }
      lines.splice(idx, 1);
    }
    if (lines.length >= QR_CAP) {
      outcome = { status: "invalid_setup", overCap: lines.length };
      return null;
    }
    lines.push(ruleLine);
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
    case "ok":
      // CAS may still have failed even though the callback succeeded.
      if (!r.ok) return { status: r.status, summary: `instructions update ${r.status}` };
      return { status: "ok", summary: `Quick Rule added (${outcome.count}/${QR_CAP})` };
    default:
      return { status: "invalid_setup", summary: `unexpected internal state: ${JSON.stringify(outcome)}` };
  }
}

// ── domain_new ──────────────────────────────────────────────────────────────
async function captureDomainNew({ content, domain, summary, tags, aliases = [], see_also = [], section, kind_meta }) {
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

  const sectionHeader = pickSectionHeader(section);
  const body = [
    `# ${titleCase(domain)}`,
    "",
    summary,
    "",
    `## ${sectionHeader}`,
    "",
    `- ${content.trim()}`,
    "",
    "## Disputed",
    "",
    "<!-- Append-only. Format: `- [YYYY-MM-DD] tried X — got Y — workaround: Z` -->",
    ""
  ].join("\n");

  // Existence check + write inside the same lock. Without this, two concurrent
  // domain_new calls for the same slug both pass the existence check and one
  // silently clobbers the other.
  const lockResult = await withLock(target, async () => {
    try {
      await fs.access(target);
      return { conflict: true };
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    await atomicWrite(target, stringify(meta, body));
    return { conflict: false };
  });
  if (lockResult.conflict) return { status: "conflict", summary: `domain already exists: ${domain}` };

  const sync = await runPostWriteSync();
  return { status: "ok", summary: `Created knowledge/${domain}.md`, file: target, sync };
}

// ── domain_update ───────────────────────────────────────────────────────────
async function captureDomainUpdate({ content, domain, section = "working" }) {
  if (!isValidSlug(domain)) return { status: "invalid", summary: `invalid domain slug: ${domain}` };
  const target = resolveDomainFile(domain);

  // Read-modify-write inside the lock so a concurrent writer cannot land
  // between our read and our write.
  const result = await withLock(target, async () => {
    const fresh = await readWithStatOrNull(target);
    if (!fresh) return { status: "not_found", summary: `domain file not found: ${domain}.md` };

    let parsed;
    try { parsed = parse(fresh.content); }
    catch (e) { return { status: "invalid_setup", summary: `frontmatter parse: ${e.message}` }; }

    const header = pickSectionHeader(section);
    const body = parsed.body;
    const sectionRe = new RegExp(`(##\\s+${escapeRegex(header)}[^\\n]*\\n)([\\s\\S]*?)(?=\\n##\\s|$)`);
    const m = sectionRe.exec(body);
    let nextBody;
    if (m) {
      nextBody = body.slice(0, m.index + m[1].length) +
                 (m[2].endsWith("\n") ? m[2] : m[2] + "\n") +
                 `- ${content.trim()}\n` +
                 body.slice(m.index + m[0].length);
    } else {
      nextBody = body.replace(/\s*$/, "\n") + `\n## ${header}\n\n- ${content.trim()}\n`;
    }
    const nextMeta = { ...parsed.meta, verified: today() };
    await atomicWrite(target, stringify(nextMeta, nextBody));
    return { status: "ok", summary: `Appended to ## ${header} in ${domain}.md`, file: target };
  });

  if (result.status !== "ok") return result;
  const sync = await runPostWriteSync();
  return { ...result, sync };
}

// ── disputed ────────────────────────────────────────────────────────────────
async function captureDisputed({ content, domain }) {
  if (!isValidSlug(domain)) return { status: "invalid", summary: `invalid domain slug: ${domain}` };
  const target = resolveDomainFile(domain);

  return await withLock(target, async () => {
    const fresh = await readWithStatOrNull(target);
    if (!fresh) return { status: "not_found", summary: `domain file not found: ${domain}.md` };

    let parsed;
    try { parsed = parse(fresh.content); }
    catch (e) { return { status: "invalid_setup", summary: `frontmatter parse: ${e.message}` }; }

    const line = `- [${today()}] ${content.trim()}`;
    const body = parsed.body;
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
  const target = resolveDomainFile(domain);

  const result = await withLock(target, async () => {
    const fresh = await readWithStatOrNull(target);
    if (!fresh) return { status: "not_found", summary: `domain file not found: ${domain}.md` };

    let parsed;
    try { parsed = parse(fresh.content); }
    catch (e) { return { status: "invalid_setup", summary: `frontmatter parse: ${e.message}` }; }

    const meta = parsed.meta;
    const beforeTags = new Set(meta.tags || []);
    const beforeAls  = new Set(meta.aliases || []);
    for (const t of tags)    if (typeof t === "string") beforeTags.add(t);
    for (const a of aliases) if (typeof a === "string") beforeAls.add(a);
    meta.tags    = [...beforeTags].slice(0, 12);
    meta.aliases = [...beforeAls].slice(0, 8);
    meta.verified = today();

    const v = validateMeta(meta);
    if (!v.ok) return { status: "invalid", summary: v.errors.join("; ") };

    await atomicWrite(target, stringify(meta, parsed.body));
    return {
      status: "ok",
      summary: `Updated ${domain}.md (tags=${meta.tags.length}, aliases=${meta.aliases.length})`,
      file: target,
      note: content.trim() ? `context: ${content.trim().slice(0,140)}` : undefined
    };
  });

  if (result.status !== "ok") return result;
  const sync = await runPostWriteSync();
  return { ...result, sync };
}

// ── helpers ─────────────────────────────────────────────────────────────────
function pickSectionHeader(s) {
  switch ((s || "working").toLowerCase()) {
    case "broken": return "❌ Broken / Don't try";
    case "gotcha": return "⚠️ Gotchas";
    case "working":
    default:       return "✅ Working";
  }
}

function titleCase(s) {
  return String(s).replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Optional debug entry for the route tool.
export async function debugRoute({ intent }) {
  if (typeof intent !== "string" || intent.length === 0) {
    return { status: "invalid", summary: "intent string required" };
  }
  const matches = await routeFromDisk(intent);
  return { status: "ok", count: matches.length, matches };
}
