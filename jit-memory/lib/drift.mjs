// Drift detection: compare on-disk knowledge files against _routing.json.
// Runs at session start (off the critical path) to decide whether to call
// syncNow(). Catches the cases that mtime-only checks miss:
//   - file added (no row in routing yet)
//   - file removed or renamed to hidden (`_email.md`, moved to `_archive/`)
//   - file modified after _routing.json was written
//   - routing.json missing entirely
//   - markers were just (re)inserted by bootstrap

import { promises as fs } from "node:fs";
import { ROUTING_JSON } from "./paths.mjs";
import { listDomainFiles } from "./sync.mjs";

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
  }

  return { drifted: reasons.length > 0, reasons };
}
