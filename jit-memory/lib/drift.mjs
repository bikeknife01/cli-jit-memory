// Drift detection: compare on-disk knowledge files against _routing.json.
// Runs at session start (off the critical path) to decide whether to call
// syncNow(). Catches the cases that mtime-only checks miss:
//   - file added (no row in routing yet)
//   - file removed or renamed to hidden (`_email.md`, moved to `_archive/`)
//   - file modified after _routing.json was written
//   - routing.json missing entirely
//   - markers were just (re)inserted by bootstrap
//   - generated KB block format/content is stale

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { INSTRUCTIONS_MD, ROUTING_JSON, KNOWLEDGE_ROOT } from "./paths.mjs";
import { readWithStatOrNull, atomicWrite } from "./atomic.mjs";
import { classifyMarkerPair, pickMarkerPair } from "./markers.mjs";
import { KB_BEGIN, KB_END, KB_BEGIN_NS, KB_END_NS, kbBlockEquivalent, listDomainFiles, renderKbBlock } from "./sync.mjs";

export async function detectDrift({ markersResult } = {}) {
  const reasons = [];

  // If bootstrap just inserted KB markers, the block is empty and must be
  // populated even if no knowledge files changed.
  if (markersResult?.kbInserted) reasons.push("kb_inserted");

  // Routing file presence + parse.
  let routingTable = null;
  let routingStat  = null;
  try {
    routingStat  = await fs.stat(ROUTING_JSON);
    const raw    = await fs.readFile(ROUTING_JSON, "utf8");
    routingTable = JSON.parse(raw);
  } catch (e) {
    if (e.code === "ENOENT") reasons.push("routing_missing");
    else reasons.push("routing_unreadable");
  }

  const files   = await listDomainFiles();
  const fileSet = new Set(files.map(f => f.rel));

  if (routingTable) {
    const routedSet = new Set((routingTable.domains || []).map(d => d.file_rel));

    // Files referenced by routing but no longer on disk (deletion / hide).
    for (const r of routedSet) {
      if (!fileSet.has(r)) { reasons.push("file_removed"); break; }
    }
    // Files on disk that routing doesn't yet know about (addition).
    for (const f of fileSet) {
      if (!routedSet.has(f)) { reasons.push("file_added"); break; }
    }

    // Files modified after routing was written (content edit, no rename).
    if (routingStat) {
      for (const f of files) {
        try {
          const s = await fs.stat(f.full);
          if (s.mtimeMs > routingStat.mtimeMs) { reasons.push("file_modified"); break; }
        } catch { /* ignore — file vanished mid-scan; covered by file_removed */ }
      }
    }

    const instructions = await readWithStatOrNull(INSTRUCTIONS_MD);
    if (instructions) {
      const kbPair = pickMarkerPair(instructions.content, KB_BEGIN_NS, KB_END_NS, KB_BEGIN, KB_END);
      if (classifyMarkerPair(instructions.content, kbPair.begin, kbPair.end) === "ok") {
        const start = instructions.content.indexOf(kbPair.begin);
        const end = instructions.content.indexOf(kbPair.end, start + kbPair.begin.length);
        const inner = instructions.content.slice(start + kbPair.begin.length, end);
        const expected = renderKbBlock(routingTable.domains || []);
        if (!kbBlockEquivalent(inner, expected)) reasons.push("kb_format_outdated");
      }
    }
  }

  return { drifted: reasons.length > 0, reasons };
}

// Item #24: persist a single drift-heal note that the next session-start
// hook can include in additionalContext. Drift heal runs asynchronously
// after the current session's digest has been computed, so without this
// the message is only visible via the throttled session.log warning.
const DRIFT_NOTE_FILE = "_drift-note.json";

export async function writeLastDriftNote(note) {
  const path = join(KNOWLEDGE_ROOT, DRIFT_NOTE_FILE);
  try {
    await fs.mkdir(KNOWLEDGE_ROOT, { recursive: true });
    await atomicWrite(path, JSON.stringify(note, null, 2));
  } catch { /* best-effort */ }
}

export async function readLastDriftNote() {
  const path = join(KNOWLEDGE_ROOT, DRIFT_NOTE_FILE);
  try {
    const raw = await fs.readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.message === "string") return parsed;
  } catch { /* no note */ }
  return null;
}

export async function clearLastDriftNote() {
  try { await fs.unlink(join(KNOWLEDGE_ROOT, DRIFT_NOTE_FILE)); }
  catch { /* not present */ }
}
