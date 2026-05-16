// jit-memory — operational knowledge base for GitHub Copilot CLI.
//
// Hooks (all fail-open via safe()):
//   onSessionStart        : surface curator digest if <24h old
//   onUserPromptSubmitted : route → assemble context (≤4 KB) → bump usage
//   onSessionEnd          : await final usage flush
//
// Tools:
//   jit_memory_capture     : agent-driven lesson writing (5 kinds)
//   jit_memory_audit       : on-demand deterministic audit
//   jit_memory_debug_route : inspect routing for an intent

import { joinSession } from "@github/copilot-sdk/extension";
import { promises as fs } from "node:fs";

import { routeFromDisk, loadRouting, consumeInvalidEntryCount } from "./lib/router.mjs";
import { assembleContext } from "./lib/context.mjs";
import { capture as doCapture, debugRoute, refreshForbiddenMarkers, deprecate as doDeprecate, deleteDomain as doDelete, previewCapture as doPreview, status as doStatus } from "./lib/capture.mjs";
import { audit as doAudit } from "./lib/audit.mjs";
import { UsageTracker } from "./lib/usage.mjs";
import { DIGEST_MD } from "./lib/paths.mjs";
import { ensureMarkers } from "./lib/bootstrap.mjs";
import { detectDrift } from "./lib/drift.mjs";
import { syncNow, drainSync, requestSync } from "./lib/sync.mjs";
import { logEvent } from "./lib/jitlog.mjs";
import { withTimeout } from "./lib/timeout.mjs";
import { truncateUtf8AtLineBoundary } from "./lib/utf8.mjs";
import {
  migrateKnowledgeIfNeeded, migrationReady, isMigrationBlocked, migrationLastResult
} from "./lib/migrate.mjs";

// ── timeouts ────────────────────────────────────────────────────────────────
const ROUTE_TIMEOUT_MS = 500;
const PRE_SESSION_WARN_LIMIT = 20;

// ── throttled session.log helper ────────────────────────────────────────────
function warnToSession(session, msg) {
  try { session.log(`jit-memory: ${msg}`, { level: "warning", ephemeral: true }); }
  catch { }
}

function makeThrottledWarn(session, intervalMs = 5 * 60 * 1000) {
  let last = 0;
  return msg => {
    const now = Date.now();
    if (now - last < intervalMs) return;
    last = now;
    warnToSession(session, msg);
  };
}

function makePreSessionWarnBuffer(limit = PRE_SESSION_WARN_LIMIT) {
  const messages = [];
  let overflowed = false;
  return {
    warn(msg) {
      if (messages.length < limit) messages.push(msg);
      else overflowed = true;
    },
    flush(session) {
      for (const msg of messages) warnToSession(session, msg);
      if (overflowed) warnToSession(session, "startup: dropped additional pre-session warnings");
      messages.length = 0;
      overflowed = false;
    }
  };
}

// ── digest reader ───────────────────────────────────────────────────────────
async function readFreshDigest() {
  try {
    const st = await fs.stat(DIGEST_MD);
    const ageMs = Date.now() - st.mtimeMs;
    if (ageMs > 24 * 60 * 60 * 1000) return null;
    const raw = await fs.readFile(DIGEST_MD, "utf8");
    return truncateUtf8AtLineBoundary(raw, 1024, { suffix: "\n_(truncated)_\n" });
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

// ── tool result normalizer ──────────────────────────────────────────────────
function normalizeToolResult(result) {
  if (typeof result === "string") return { textResultForLlm: result, resultType: "success" };
  const status = result?.status;
  // `invalid` is execution failure. Everything else (ok/at_cap/conflict/not_found/invalid_setup)
  // is a valid business outcome the agent should reason about.
  const resultType = status === "invalid" ? "failure" : "success";
  return { textResultForLlm: JSON.stringify(result), resultType };
}

// ── safe wrappers ───────────────────────────────────────────────────────────
function safeHook(name, warn, fn) {
  return async (input, invocation) => {
    try {
      return await fn(input, invocation);
    } catch (e) {
      warn(`hook ${name} failed: ${e.message}`);
      return undefined;
    }
  };
}

function safeTool(name, warn, fn) {
  return async (args, invocation) => {
    try {
      const r = await fn(args, invocation);
      // Operator visibility: if a capture succeeded but downstream sync failed,
      // surface it via the throttled session log (the result envelope already
      // carries r.sync.error for the model).
      if (r && typeof r === "object" && r.sync && r.sync.ok === false) {
        warn(`capture: post-write sync failed: ${r.sync.error || "unknown"}`);
      }
      return normalizeToolResult(r);
    } catch (e) {
      return {
        textResultForLlm: JSON.stringify({ status: "invalid", summary: `${name}: ${e.message}` }),
        resultType: "failure"
      };
    }
  };
}

// ── tool schemas ────────────────────────────────────────────────────────────
const CAPTURE_SCHEMA = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["quick_rule", "domain_new", "domain_update", "disputed", "alias_add"],
      description:
        "What to capture. quick_rule: universal cross-cutting lesson (max 10). " +
        "domain_new: create new domain file (requires domain, summary, tags). " +
        "domain_update: append lesson to existing domain (requires domain, section). " +
        "disputed: append contradiction to ## Disputed (requires domain). " +
        "alias_add: add tag/alias so future routing matches (requires domain, tags or aliases)."
    },
    content: { type: "string", description: "The lesson, ideally '<topic>: <what fails> → <what works>'. For quick_rule, ≤280 chars." },
    domain: { type: "string", description: "Slug ^[a-z0-9][a-z0-9_-]{0,63}$. Required for all kinds except quick_rule." },
    summary: { type: "string", description: "≤200 chars. Required for domain_new." },
    tags: { type: "array", items: { type: "string" }, description: "1–12 lowercase tokens, each 2–40 chars. Required for domain_new; for alias_add, supply tags and/or aliases." },
    aliases: { type: "array", items: { type: "string" }, description: "0–8 multi-word phrases (3–40 chars each). For alias_add, supply tags and/or aliases." },
    see_also: { type: "array", items: { type: "string" }, description: "0–4 related domain slugs." },
    section: { type: "string", enum: ["working", "broken", "gotcha"], description: "Required for domain_update." },
    demote_target: { type: "string", description: "If kind=quick_rule and at_cap, substring of an existing rule to remove." },
    kind_meta: { type: "string", enum: ["fact", "protocol", "reference"], description: "Optional. Default 'fact'. Used only for domain_new." },
    context: { type: "string", description: "Optional. When/why this lesson applies (e.g. 'Windows only', 'production deployments'). Rendered as an italicized prefatory note in the domain file. Used for domain_new." },
    failed_attempt: { type: "string", description: "Optional. What was tried and didn't work — rendered into the '❌ Broken / Don't try' section alongside the working lesson. Used for domain_new and domain_update." },
    confirm_redaction_skip: { type: "boolean", description: "If true, bypass the deterministic redaction scan. Use only after manual review (item #14)." }
  },
  required: ["kind", "content"]
};

const AUDIT_SCHEMA = {
  type: "object",
  properties: {}
};

const ROUTE_SCHEMA = {
  type: "object",
  properties: { intent: { type: "string" } },
  required: ["intent"]
};

const DEPRECATE_SCHEMA = {
  type: "object",
  properties: {
    domain: { type: "string", description: "Slug of the domain to mark deprecated. Routing skips deprecated entries on the next prompt." }
  },
  required: ["domain"]
};

const PREVIEW_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["quick_rule", "domain_new", "domain_update", "disputed", "alias_add"], description: "Optional. Tentative kind being considered." },
    domain: { type: "string", description: "Slug to check for an existing domain file." },
    tags: { type: "array", items: { type: "string" }, description: "Tags to check for overlap with existing domains." },
    aliases: { type: "array", items: { type: "string" }, description: "Aliases to check for overlap with existing domains." }
  }
};

const DELETE_SCHEMA = {
  type: "object",
  properties: {
    domain: { type: "string", description: "Slug of the domain to retire by moving to knowledge/_archive/." },
    confirm: { type: "boolean", description: "Must be true to actually move the file. Without confirm, returns a needs_confirm preview." }
  },
  required: ["domain"]
};

// ── boot ────────────────────────────────────────────────────────────────────
// SDK contract: hooks and tools MUST be passed via joinSession() options.
// `session.rpc.registerHooks` / `registerTool` do NOT exist on CopilotSession
// — calling them silently fails (the .catch() swallows the TypeError) and
// the extension appears loaded but registers nothing. Late-bind `warn` so
// hook closures can use it once the session is available.

let session;
const preSessionWarn = makePreSessionWarnBuffer();
let warn = preSessionWarn.warn;
const usage = new UsageTracker({ onFlushError: e => warn(`telemetry flush: ${e.message}`) });
const lateWarn = msg => warn(msg);
let noticesShown = new Set();

function noticeOnce(key, msg) {
  if (noticesShown.has(key)) return;
  noticesShown.add(key);
  if (session) warnToSession(session, msg);
  else warn(msg);
}

function formatDriftReasons(reasons = []) {
  const picked = reasons.slice(0, 2);
  const suffix = reasons.length > picked.length ? ", ..." : "";
  return picked.length ? ` (${picked.join(", ")}${suffix})` : "";
}

// Item #27: dedup'd route-failure logging. A burst of identical failures
// (e.g. a corrupt _routing.json) writes one log line, then suppresses
// duplicates until either 5 minutes pass or the failure signature changes.
let _lastRouteFailSig = null;
let _lastRouteFailAt = 0;
function noteRouteFailure(err) {
  const sig = `${err?.code || "ERROR"}:${(err?.message || String(err)).slice(0, 100)}`;
  const now = Date.now();
  if (sig === _lastRouteFailSig && now - _lastRouteFailAt < 5 * 60 * 1000) return;
  _lastRouteFailSig = sig;
  _lastRouteFailAt = now;
  // Fire-and-forget; logEvent never throws.
  void logEvent("route_failed", { code: err?.code, error: err?.message || String(err) });
}

// Bootstrap-readiness gate. Resolved before tools can mutate marker-backed
// state, so the very first capture/audit doesn't race a missing-marker
// situation. Reset on each onSessionStart.
let markersReady = Promise.resolve();

// Combined startup gate: awaits BOTH the knowledge migration and the marker
// bootstrap before letting a tool run. When `write:true`, the gate also
// refuses if migration left the new KB in an ambiguous/blocked state. If the
// last migration was a transient `migration_in_progress` (concurrent session
// still copying), the gate re-attempts migration once before deciding.
function gateOnReady(handler, { write = false } = {}) {
  return async (args, invocation) => {
    try { await migrationReady(); } catch { /* migrator returns a result, never throws */ }
    let r = migrationLastResult();
    if (write && r?.status === "migration_in_progress") {
      try { r = await migrateKnowledgeIfNeeded(); } catch { /* swallowed; r unchanged */ }
    }
    try { await markersReady; } catch { /* ensureMarkers never throws; defensive */ }
    if (write && isMigrationBlocked()) {
      r = migrationLastResult() || { status: "error" };
      const stagingNote = r.staging ? ` (your data is in ${r.staging})` : "";
      const detail = r.status === "collision"
        ? `both legacy (${r.legacy}) and new (${r.new}) knowledge roots contain user data; merge manually then restart`
        : r.status === "staging_present"
          ? `unresolved migration staging directories present: ${(r.paths || []).join(", ")}; resolve manually then restart`
          : r.status === "verify_failed"
            ? `migration verification failed: ${r.details || "unknown"}${stagingNote}; resolve manually then restart`
            : r.status === "race_aborted"
              ? `migration was aborted by a concurrent write; staging at ${r.staging || "<unknown>"}; resolve manually then restart`
              : r.status === "unsupported_topology"
                ? `unsupported topology (symlink) at ${r.path || "<unknown>"}${stagingNote}; replace with a real directory then restart`
                : `migration failed: ${r.error || r.status}${stagingNote}`;
      return { status: "invalid_setup", summary: `jit-memory migration unresolved: ${detail}` };
    }
    if (write && r?.status === "migration_in_progress") {
      return { status: "invalid_setup", summary: `jit-memory: another session is migrating the knowledge base; retry in a moment` };
    }
    return handler(args, invocation);
  };
}

const hooks = {
  onSessionStart: safeHook("onSessionStart", lateWarn, async () => {
    noticesShown = new Set();
    // Migration FIRST: relocate legacy in-extension knowledge to the new
    // user-data home (~/.copilot/jit-memory/knowledge) before anything reads
    // or writes routing/log/marker state. On collision/failure, capture and
    // audit-write paths refuse via gateOnReady; routing reads still proceed.
    const mig = await migrateKnowledgeIfNeeded();
    if (mig.status === "migrated") {
      warnToSession(session, `kb migrated from ${mig.from || "<legacy>"} → ${mig.to || "<new>"} (${mig.fileCount ?? 0} files, ${mig.method})`);
    } else if (mig.status === "collision") {
      warnToSession(session, `migration BLOCKED — both legacy (${mig.legacy}) and new (${mig.new}) contain user content. Merge manually then restart.`);
    } else if (mig.status === "staging_present") {
      warnToSession(session, `migration BLOCKED — unresolved staging dir(s): ${(mig.paths || []).join(", ")}. Inspect/move/delete then restart.`);
    } else if (mig.status === "verify_failed") {
      warnToSession(session, `migration FAILED verification: ${mig.details || "unknown"}. Captures will be refused until resolved.`);
    } else if (mig.status === "race_aborted") {
      warnToSession(session, `migration aborted; staging at ${mig.staging || "<unknown>"}. Captures will be refused until resolved.`);
    } else if (mig.status === "unsupported_topology") {
      warnToSession(session, `migration cannot proceed — symlink at ${mig.path || "<unknown>"}. Replace with a real directory then restart.`);
    } else if (mig.status === "error") {
      warnToSession(session, `migration error: ${mig.error || "unknown"}. Captures will be refused until resolved.`);
    }
    // Warm routing cache off the critical path.
    void loadRouting()
      .then(() => {
        const dropped = consumeInvalidEntryCount();
        if (dropped <= 0) return;
        warn(`routing: dropped ${dropped} invalid entr${dropped === 1 ? "y" : "ies"} from _routing.json during load; scheduling regeneration`);
        requestSync({ debounceMs: 0 });
      })
      .catch(e => warn(`routing warmup: ${e?.message || e}`));
    // Bootstrap repair: insert QR/KB markers if missing in instructions.
    // ensureMarkers() is documented to never throw, but a terminal .catch()
    // keeps the fire-and-forget contract local even if that contract regresses.
    // The handler returns the bootstrap result so the drift-heal task below
    // can force a sync when KB markers were just inserted (empty block must
    // be populated even when no knowledge files changed).
    markersReady = ensureMarkers()
      .then(async r => {
        if (r.error) warn(`bootstrap: ${r.error}`);
        else if (r.qrInserted || r.kbInserted) {
          const parts = [];
          if (r.qrInserted) parts.push("QR");
          if (r.kbInserted) parts.push("KB");
          warn(`bootstrap: inserted missing ${parts.join("+")} marker block(s) in copilot-instructions.md`);
        }
        const discovery = await refreshForbiddenMarkers();
        if (!discovery.ok) warn(`forbidden-marker discovery: ${discovery.error || "failed"}`);
        return r;
      })
      .catch(e => {
        warn(`bootstrap: unexpected failure: ${e?.message || e}`);
        return { error: e?.message || String(e) };
      });

    // Drift heal: if the on-disk knowledge files have diverged from
    // _routing.json since the last sync (manual edit, rename, deletion),
    // regenerate routing + KB block. Off the critical path; logged silently
    // to knowledge/_jit-memory.log only — never surfaced to the session.
    // Note: the static KB block is loaded into the system prompt BEFORE
    // extension hooks fire, so any update here applies to session N+1, not
    // the current session. Item #24: persist the result to a sidecar so
    // the NEXT session start can include it in additionalContext (drift heal
    // runs asynchronously after this session's digest is computed).
    // Skip entirely when migration is blocked: drift heal would write infra
    // files (logs, _routing.json) into the new KB before the user resolves
    // the migration.
    if (isMigrationBlocked()) { /* skip drift heal */ }
    else void markersReady.then(async (markersResult) => {
      if (markersResult?.error) return;
      try {
        const drift = await detectDrift({ markersResult });
        if (!drift.drifted) return;
        const result = await syncNow({ debounceMs: 0 })
          .then(r => ({ ok: true, ...r }))
          .catch(e => ({ ok: false, error: e?.message || String(e) }));
        await logEvent("drift_heal", {
          reasons: drift.reasons,
          sync: result.ok ? "ok" : "failed",
          error: result.error,
          kbStatus: result.kbStatus,
          domainsWritten: result.domainsWritten,
          routingWritten: result.routingWritten
        });
        const kbRefresh = result.kbStatus === "ok" || markersResult?.kbInserted;
        if (result.ok && (result.routingWritten || kbRefresh)) {
          const reasons = formatDriftReasons(drift.reasons);
          // Compose from the artifacts that actually changed. kbStatus "ok"
          // means the KB block was rewritten; kbInserted means bootstrap changed
          // static instructions before this heal pass.
          const changed = [];
          if (result.routingWritten) changed.push("routing (applies to later prompts in this session)");
          if (kbRefresh) changed.push("KB instructions (refresh on the next session)");
          const message = `drift-heal:notice refreshed ${changed.join(" and ")}${reasons}`;
          noticeOnce("drift-heal", message);
          // Persist for the NEXT session-start additionalContext. The
          // current session has already returned its digest by the time
          // this async task runs.
          try {
            const { writeLastDriftNote } = await import("./lib/drift.mjs");
            await writeLastDriftNote({ message, ts: new Date().toISOString() });
          } catch { /* best-effort */ }
        }
      } catch (e) {
        await logEvent("drift_heal_error", { error: e?.message || String(e) });
      }
    }).catch(() => undefined);

    // Item #13: surface a health summary at session start when something is
    // wrong (blocked migration, very stale routing, empty KB after captures
    // were attempted). Combined with the curator digest into one block when
    // both are present.
    const digest = await readFreshDigest();
    let healthBlock = "";
    let driftBlock = "";
    try {
      const { status: doStatus } = await import("./lib/capture.mjs");
      const s = await doStatus();
      if (s?.issues?.length) {
        healthBlock = `<jit-memory-health>\n` +
          s.issues.map(x => `- ${x}`).join("\n") +
          `\n</jit-memory-health>`;
      }
    } catch { /* status is best-effort */ }
    // Item #24: include the previous session's drift-heal note (if any)
    // since drift-heal runs asynchronously and never makes it into its own
    // session's digest.
    try {
      const { readLastDriftNote, clearLastDriftNote } = await import("./lib/drift.mjs");
      const note = await readLastDriftNote();
      if (note?.message) {
        driftBlock = `<jit-memory-drift-heal>\n- ${note.message} (at ${note.ts})\n</jit-memory-drift-heal>`;
        await clearLastDriftNote();
      }
    } catch { /* best-effort */ }
    if (!digest && !healthBlock && !driftBlock) return undefined;
    const parts = [];
    if (digest) parts.push(`<jit-memory-digest>\n${digest}\n</jit-memory-digest>`);
    if (healthBlock) parts.push(healthBlock);
    if (driftBlock) parts.push(driftBlock);
    return { additionalContext: parts.join("\n") };
  }),

  onUserPromptSubmitted: safeHook("onUserPromptSubmitted", lateWarn, async (input) => {
    usage.notePrompt();
    let matches;
    try {
      matches = await withTimeout(ROUTE_TIMEOUT_MS, routeFromDisk(input.prompt), "route");
    } catch (e) {
      // Item #27: persistent route failures (timeout, parse, IO) leave a
      // dedup'd trail in _jit-memory.log so a user investigating later can
      // see the pattern. The throttled session warn still fires for the
      // current session.
      noteRouteFailure(e);
      warn(`routing: ${e?.message || e}`);
      if (usage.shouldFlush()) usage.flush();
      return undefined;
    }
    // Defense-in-depth for direct-table route() drops; startup loadRouting()
    // handles persisted _routing.json invalid rows before normal prompts.
    const dropped = consumeInvalidEntryCount();
    if (dropped > 0) warn(`routing: dropped ${dropped} invalid entr${dropped === 1 ? "y" : "ies"} from _routing.json`);
    if (!matches || matches.length === 0) {
      if (usage.shouldFlush()) usage.flush();
      return undefined;
    }
    const ctx = await assembleContext(matches);
    if (!ctx) {
      if (usage.shouldFlush()) usage.flush();
      return undefined;
    }
    for (const m of matches) usage.bump(m.slug);
    if (usage.shouldFlush()) usage.flush();
    return { additionalContext: ctx };
  }),

  onSessionEnd: safeHook("onSessionEnd", lateWarn, async () => {
    const r = await usage.flushFinal();
    if (r.stalled) lateWarn(`telemetry final flush stalled: ${r.deltasRemaining} deltas remain after ${r.passes} pass(es)`);
    const s = await drainSync();
    if (s.stalled) lateWarn(`sync final drain stalled after ${s.passes} pass(es)${s.error ? `: ${s.error}` : ""}`);
    else if (!s.ok && s.lastPassOk) lateWarn(`sync final drain completed after transient sync error: ${s.error || "unknown"}`);
    else if (!s.ok) lateWarn(`sync final drain ended after sync error: ${s.error || "unknown"}`);
  })
};

const tools = [
  {
    name: "jit_memory_capture",
    description: "Atomically capture a lesson into the jit-memory knowledge base. Call immediately when a lesson could plausibly recur; a single concrete failure is enough when it shows what failed -> what worked. After non-trivial tool errors or workarounds, capture if it could recur or you are unsure. Do not edit knowledge files by hand.",
    parameters: CAPTURE_SCHEMA,
    handler: safeTool("jit_memory_capture", lateWarn, gateOnReady(doCapture, { write: true }))
  },
  {
    name: "jit_memory_audit",
    description: "Run the deterministic audit (stale, cap, disputed, collisions, zero-hit, bloat, deprecated, frontmatter). Returns a digest or 'healthy'. Read-only — write-side archival of deprecated >30d is performed only by the headless `node audit.mjs` CLI runner, not by this tool.",
    parameters: AUDIT_SCHEMA,
    handler: safeTool("jit_memory_audit", lateWarn, gateOnReady(async () => {
      // Item #7: archival is intentionally NOT exposed to the agent surface;
      // only the headless audit.mjs CLI passes archivalAllowed=true.
      const r = await doAudit({ archivalAllowed: false });
      return { status: "ok", healthy: r.healthy, archived: r.archived, digest: r.digest };
    }, { write: true }))
  },
  {
    name: "jit_memory_debug_route",
    description: "Inspect routing for a given intent string. Debugging only; the onUserPromptSubmitted hook routes automatically.",
    parameters: ROUTE_SCHEMA,
    handler: safeTool("jit_memory_debug_route", lateWarn, gateOnReady(debugRoute))
  },
  {
    name: "jit_memory_deprecate",
    description: "Graceful retire: mark a domain as deprecated:<today>. Routing skips it on the next prompt; the headless audit eventually archives any file deprecated >30 days. Use this when a lesson should no longer route but its history is worth keeping. Idempotent.",
    parameters: DEPRECATE_SCHEMA,
    handler: safeTool("jit_memory_deprecate", lateWarn, gateOnReady(doDeprecate, { write: true }))
  },
  {
    name: "jit_memory_delete",
    description: "Immediate retire: move a domain file to knowledge/_archive/ now. Routing stops including it on the next prompt. Requires {confirm:true} to actually move; without confirm returns a needs_confirm preview. Use this for accidental sensitive captures or other immediate-removal scenarios.",
    parameters: DELETE_SCHEMA,
    handler: safeTool("jit_memory_delete", lateWarn, gateOnReady(doDelete, { write: true }))
  },
  {
    name: "jit_memory_capture_preview",
    description: "Read-only check before capture. Given a candidate {kind, domain, tags, aliases}, returns existing domain candidates (slug match + tag/alias overlap) and a suggestedKind so you can decide between domain_new vs domain_update vs alias_add without writing.",
    parameters: PREVIEW_SCHEMA,
    handler: safeTool("jit_memory_capture_preview", lateWarn, gateOnReady(doPreview))
  },
  {
    name: "jit_memory_status",
    description: "Read-only health snapshot. Reports knowledgeRoot, routing freshness (age in hours, domain count), usage totals, last migration result, and any active issues (blocked migration, stale routing, empty KB). Use to confirm the extension is healthy when something seems off.",
    parameters: { type: "object", properties: {} },
    handler: safeTool("jit_memory_status", lateWarn, gateOnReady(doStatus))
  }
];

try {
  session = await joinSession({ hooks, tools });
} catch (e) {
  process.stderr.write(`jit-memory: failed to initialize extension session: ${e?.message || e}\n`);
  throw e;
}
warn = makeThrottledWarn(session);
preSessionWarn.flush(session);
