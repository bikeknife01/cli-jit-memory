// Append-only log for jit-memory operational events (drift heal, etc).
// Writes to knowledge/_jit-memory.log. Underscore prefix means
// listDomainFiles() ignores it. Best-effort: never throws.
//
// Item #26: paths are scrubbed to relative-to-KNOWLEDGE_ROOT or
// relative-to-HOME form before they appear in log lines, so the operational
// log never embeds the user's full home directory.

import { promises as fs } from "node:fs";
import { join, isAbsolute, relative, sep } from "node:path";
import { homedir } from "node:os";
import { KNOWLEDGE_ROOT } from "./paths.mjs";

const LOG_PATH = join(KNOWLEDGE_ROOT, "_jit-memory.log");
const MAX_BYTES = 256 * 1024;     // rotate at 256KB
const ROTATED   = LOG_PATH + ".1";

const HOME = homedir();

function scrubPath(s) {
  if (typeof s !== "string") return s;
  if (!isAbsolute(s)) return s;
  // Prefer knowledge-relative for paths under our KB.
  try {
    const relK = relative(KNOWLEDGE_ROOT, s);
    if (!relK.startsWith("..") && !relK.includes(`..${sep}`)) {
      return relK ? `<knowledge>${sep}${relK}` : "<knowledge>";
    }
  } catch { /* fall through */ }
  // Fall back to home-relative for anything under HOME.
  try {
    const relH = relative(HOME, s);
    if (!relH.startsWith("..") && !relH.includes(`..${sep}`)) {
      return `<home>${sep}${relH}`;
    }
  } catch { /* fall through */ }
  return s;
}

function fmtField(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string")         return JSON.stringify(scrubPath(v));
  if (Array.isArray(v))              return JSON.stringify(v.map(x => typeof x === "string" ? scrubPath(x) : x));
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
// Exported for unit tests of item #26.
export { scrubPath as _scrubPathForTests };
