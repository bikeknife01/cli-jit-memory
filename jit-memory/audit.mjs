#!/usr/bin/env node
// Headless CLI entry — for optional Task Scheduler / cron invocation.
// Performs deterministic audit AND archival of deprecated >30d.
// Exit code 0 unless an internal error occurs. A non-empty digest is content,
// not a failure — users can monitor _curator-digest.md mtime/content.

import { audit } from "./lib/audit.mjs";
import { drainSync } from "./lib/sync.mjs";
import { withTimeout } from "./lib/timeout.mjs";
import { logEvent } from "./lib/jitlog.mjs";
import { migrateKnowledgeIfNeeded, isMigrationBlockingResult } from "./lib/migrate.mjs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export const SYNC_DRAIN_TIMEOUT_MS = 30_000;

export async function drainAfterAudit() {
  try {
    const r = await withTimeout(SYNC_DRAIN_TIMEOUT_MS, drainSync(), "audit sync drain");
    if (r.stalled) {
      throw new Error(`sync drain stalled after ${r.passes} pass(es)${r.error ? `: ${r.error}` : ""}`);
    }
    if (!r.ok) {
      throw new Error(`sync drain ended after sync error${r.error ? `: ${r.error}` : ""}`);
    }
  } catch (e) {
    await logEvent("audit_sync_drain_failed", { error: e?.message || String(e) });
    throw e;
  }
}

function write(stream, text) {
  stream.write(text);
}

export async function runAuditCli({
  auditFn = audit,
  drainFn = drainAfterAudit,
  migrateFn = migrateKnowledgeIfNeeded,
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  try {
    const mig = await migrateFn();
    if (isMigrationBlockingResult(mig)) {
      write(stderr, `jit-memory: knowledge migration unresolved (status=${mig.status}); refusing to audit. Resolve manually then re-run.\n`);
      return 2;
    }
    const r = await auditFn({ archivalAllowed: true });
    try {
      await drainFn();
    } catch (e) {
      write(stderr, `jit-memory: audit completed but post-audit sync drain failed: ${e?.message || e}\n`);
      return 1;
    }
    if (r.healthy) {
      write(stdout, "jit-memory: healthy\n");
    } else {
      const archived = r.archived?.length ?? 0;
      write(stdout, `jit-memory: digest written; archived ${archived}\n`);
    }
    return 0;
  } catch (e) {
    write(stderr, `jit-memory audit failed: ${e?.stack || e?.message || e}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runAuditCli();
}
