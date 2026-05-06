// Append-only log for jit-memory operational events (drift heal, etc).
// Writes to knowledge/_jit-memory.log. Underscore prefix means
// listDomainFiles() ignores it. Best-effort: never throws.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { KNOWLEDGE_ROOT } from "./paths.mjs";

const LOG_PATH = join(KNOWLEDGE_ROOT, "_jit-memory.log");
const MAX_BYTES = 256 * 1024;     // rotate at 256KB
const ROTATED   = LOG_PATH + ".1";

function fmtField(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string")         return JSON.stringify(v);
  if (Array.isArray(v))              return JSON.stringify(v);
  return JSON.stringify(v);
}

export async function logEvent(event, fields = {}) {
  try {
    await fs.mkdir(KNOWLEDGE_ROOT, { recursive: true });
    // Cheap rotation check.
    try {
      const s = await fs.stat(LOG_PATH);
      if (s.size > MAX_BYTES) {
        try { await fs.rename(LOG_PATH, ROTATED); } catch { /* ignore */ }
      }
    } catch { /* file may not exist yet */ }

    const ts    = new Date().toISOString();
    const parts = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${fmtField(v)}`);
    const line  = `${ts} ${event}${parts.length ? " " + parts.join(" ") : ""}\n`;
    await fs.appendFile(LOG_PATH, line, "utf8");
  } catch { /* swallow */ }
}

export const _LOG_PATH_FOR_TESTS = LOG_PATH;
