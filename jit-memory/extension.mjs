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
import { capture as doCapture, debugRoute, refreshForbiddenMarkers } from "./lib/capture.mjs";
import { audit as doAudit }      from "./lib/audit.mjs";
import { UsageTracker }          from "./lib/usage.mjs";
import { DIGEST_MD }             from "./lib/paths.mjs";
import { ensureMarkers }         from "./lib/bootstrap.mjs";
import { detectDrift }           from "./lib/drift.mjs";
import { syncNow, drainSync, requestSync } from "./lib/sync.mjs";
import { logEvent }              from "./lib/jitlog.mjs";
import { withTimeout }           from "./lib/timeout.mjs";
import { truncateUtf8AtLineBoundary } from "./lib/utf8.mjs";

// ── timeouts ────────────────────────────────────────────────────────────────
const ROUTE_TIMEOUT_MS = 500;
const PRE_SESSION_WARN_LIMIT = 20;

// ── throttled session.log helper ────────────────────────────────────────────
function warnToSession(session, msg) {
  try { session.log(`jit-memory: ${msg}`, { level: "warning", ephemeral: true }); }
  catch {}
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
    content:       { type: "string", description: "The lesson, ideally '<topic>: <what fails> → <what works>'. For quick_rule, ≤280 chars." },
    domain:        { type: "string", description: "Slug ^[a-z0-9][a-z0-9_-]{0,63}$. Required for all kinds except quick_rule." },
    summary:       { type: "string", description: "≤200 chars. Required for domain_new." },
    tags:          { type: "array",  items: { type: "string" }, description: "1–12 lowercase tokens, each 2–40 chars. Required for domain_new; for alias_add, supply tags and/or aliases." },
    aliases:       { type: "array",  items: { type: "string" }, description: "0–8 multi-word phrases (3–40 chars each). For alias_add, supply tags and/or aliases." },
    see_also:      { type: "array",  items: { type: "string" }, description: "0–4 related domain slugs." },
    section:       { type: "string", enum: ["working", "broken", "gotcha"], description: "Required for domain_update." },
    demote_target: { type: "string", description: "If kind=quick_rule and at_cap, substring of an existing rule to remove." },
    kind_meta:     { type: "string", enum: ["fact", "protocol", "reference"], description: "Optional. Default 'fact'. Used only for domain_new." }
  },
  required: ["kind", "content"]
};

const AUDIT_SCHEMA = {
  type: "object",
  properties: {
    archival: { type: "boolean", description: "If true, perform write-side archival of deprecated >30d. Default false." }
  }
};

const ROUTE_SCHEMA = {
  type: "object",
  properties: { intent: { type: "string" } },
  required: ["intent"]
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

// Bootstrap-readiness gate. Resolved before tools can mutate marker-backed
// state, so the very first capture/audit doesn't race a missing-marker
// situation. Reset on each onSessionStart.
let markersReady = Promise.resolve();

function gateOnMarkers(handler) {
  return async (args, invocation) => {
    try { await markersReady; } catch { /* ensureMarkers never throws; defensive */ }
    return handler(args, invocation);
  };
}

const hooks = {
  onSessionStart: safeHook("onSessionStart", lateWarn, async () => {
    noticesShown = new Set();
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
    // the current session.
    void markersReady.then(async (markersResult) => {
      if (markersResult?.error) return;
      try {
        const drift = await detectDrift({ markersResult });
        if (!drift.drifted) return;
        const result = await syncNow({ debounceMs: 0 })
          .then(r => ({ ok: true, ...r }))
          .catch(e => ({ ok: false, error: e?.message || String(e) }));
        await logEvent("drift_heal", {
          reasons:        drift.reasons,
          sync:           result.ok ? "ok" : "failed",
          error:          result.error,
          kbStatus:       result.kbStatus,
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
        }
      } catch (e) {
        await logEvent("drift_heal_error", { error: e?.message || String(e) });
      }
    }).catch(() => undefined);

    const digest = await readFreshDigest();
    if (!digest) return undefined;
    return { additionalContext: `<jit-memory-digest>\n${digest}\n</jit-memory-digest>` };
  }),

  onUserPromptSubmitted: safeHook("onUserPromptSubmitted", lateWarn, async (input) => {
    usage.notePrompt();
    const matches = await withTimeout(ROUTE_TIMEOUT_MS, routeFromDisk(input.prompt), "route");
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
    handler: safeTool("jit_memory_capture", lateWarn, gateOnMarkers(doCapture))
  },
  {
    name: "jit_memory_audit",
    description: "Run the deterministic audit (stale, cap, disputed, collisions, zero-hit, bloat, deprecated, frontmatter). Returns a digest or 'healthy'. Pass {archival:true} only from the scheduled CLI runner.",
    parameters: AUDIT_SCHEMA,
    handler: safeTool("jit_memory_audit", lateWarn, gateOnMarkers(async (args = {}) => {
      const r = await doAudit({ archivalAllowed: !!args.archival });
      return { status: "ok", healthy: r.healthy, archived: r.archived, digest: r.digest };
    }))
  },
  {
    name: "jit_memory_debug_route",
    description: "Inspect routing for a given intent string. Debugging only; the onUserPromptSubmitted hook routes automatically.",
    parameters: ROUTE_SCHEMA,
    handler: safeTool("jit_memory_debug_route", lateWarn, debugRoute)
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
