#!/usr/bin/env node
// Headless CLI entry — for optional Task Scheduler / cron invocation.
// Performs deterministic audit AND archival of deprecated >30d.
// Exit code 0 unless an internal error occurs. A non-empty digest is content,
// not a failure — users can monitor _curator-digest.md mtime/content.

import { audit } from "./lib/audit.mjs";

(async () => {
  try {
    const r = await audit({ archivalAllowed: true });
    if (r.healthy) {
      process.stdout.write("jit-memory: healthy\n");
    } else {
      const archived = r.archived?.length ?? 0;
      process.stdout.write(`jit-memory: digest written; archived ${archived}\n`);
    }
    process.exit(0);
  } catch (e) {
    process.stderr.write(`jit-memory audit failed: ${e?.stack || e?.message || e}\n`);
    process.exit(1);
  }
})();
