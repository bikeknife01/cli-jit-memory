// Bootstrap repair: ensure copilot-instructions.md has the QR/KB markers
// jit-memory needs for capture (Quick Rules block) and sync (Domain Index
// block). If markers are absent, append minimal stub blocks so the
// first capture / first sync don't fail with status=invalid_setup.
//
// Conservative behavior:
//   - If INSTRUCTIONS_MD does not exist, do nothing (warn caller). Creating
//     the user's whole instructions file from this extension is out of scope.
//   - If a marker pair already exists (even with content between), leave it
//     alone.
//   - Inserts are append-only at end-of-file under named headings, so we never
//     touch existing content. Bootstrap restores markers, not the full snippet
//     prose. Idempotent: a second run is a no-op.
//   - Atomic write under withLock — safe vs concurrent capture/sync.

import { promises as fs } from "node:fs";
import { atomicWrite, withLock, readWithStatOrNull } from "./atomic.mjs";
import { INSTRUCTIONS_MD } from "./paths.mjs";
import { QR_BEGIN, QR_END } from "./capture.mjs";
import { KB_BEGIN, KB_END, renderKbBlock } from "./sync.mjs";
import { classifyMarkerPair } from "./markers.mjs";

const OKB_HEADING = "## Operational Knowledge Base (jit-memory)";
const QR_HEADING = "### Quick Rules — managed by jit_memory_capture";
const KB_HEADING = "### Domain Index";

const QR_SECTION = [
  QR_HEADING,
  "",
  "<!-- jit-memory managed: do not hand-edit between QR:BEGIN and QR:END -->",
  QR_BEGIN,
  QR_END,
  ""
].join("\n");

const KB_SECTION = [
  KB_HEADING,
  "",
  "<!-- jit-memory managed: do not hand-edit between KB:BEGIN and KB:END -->",
  KB_BEGIN,
  renderKbBlock([]),
  KB_END,
  ""
].join("\n");

function partialStub(content, section) {
  if (new RegExp(`^${OKB_HEADING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").test(content)) {
    return ["", section].join("\n");
  }
  return ["", OKB_HEADING, "", section].join("\n");
}

const COMBINED_STUB = [
  "",
  OKB_HEADING,
  "",
  QR_SECTION,
  KB_SECTION
].join("\n");

/**
 * Ensure QR + KB markers exist in INSTRUCTIONS_MD.
 * Returns { fileExists, qrInserted, kbInserted, qrState, kbState, error? }.
 *   qrState/kbState ∈ "ok" | "missing" | "malformed"
 * Never throws — caller (extension hook) is fail-open.
 *
 * Insert is performed only when state === "missing". A "malformed" state
 * (orphan BEGIN, orphan END, duplicates, nested, reversed) is reported via
 * `error` and the file is NOT modified — appending in those states could
 * produce a destructive marker range that capture/sync would later
 * overwrite.
 */
export async function ensureMarkers() {
  const result = { fileExists: false, qrInserted: false, kbInserted: false };
  let existing;
  try {
    existing = await readWithStatOrNull(INSTRUCTIONS_MD);
  } catch (e) {
    result.error = `read failed: ${e.message}`;
    return result;
  }
  if (!existing) {
    result.error = "instructions file not found";
    return result;
  }
  result.fileExists = true;

  result.qrState = classifyMarkerPair(existing.content, QR_BEGIN, QR_END);
  result.kbState = classifyMarkerPair(existing.content, KB_BEGIN, KB_END);

  const malformed = [];
  if (result.qrState === "malformed") malformed.push("QR");
  if (result.kbState === "malformed") malformed.push("KB");
  if (malformed.length > 0) {
    result.error = `malformed ${malformed.join("+")} marker state in copilot-instructions.md; manual repair required`;
    return result;
  }

  const needsQr = result.qrState === "missing";
  const needsKb = result.kbState === "missing";
  if (!needsQr && !needsKb) return result;

  try {
    await withLock(INSTRUCTIONS_MD, async () => {
      // Re-read inside the lock to avoid lost-update on concurrent writers.
      const cur = await fs.readFile(INSTRUCTIONS_MD, "utf8");
      const qrNow = classifyMarkerPair(cur, QR_BEGIN, QR_END);
      const kbNow = classifyMarkerPair(cur, KB_BEGIN, KB_END);
      // Reflect under-lock state in the result envelope so callers see the
      // final observed state, not the pre-lock snapshot.
      result.qrState = qrNow;
      result.kbState = kbNow;
      // Re-check malformed under the lock — a concurrent partial write could
      // have raced in. Bail without writing if so.
      if (qrNow === "malformed" || kbNow === "malformed") {
        result.error = `malformed marker state observed under lock; aborting bootstrap write`;
        return;
      }
      let next = cur;
      if (qrNow === "missing" && kbNow === "missing") {
        if (!next.endsWith("\n")) next += "\n";
        next += COMBINED_STUB;
        result.qrInserted = true;
        result.kbInserted = true;
      } else if (qrNow === "missing") {
        if (!next.endsWith("\n")) next += "\n";
        next += partialStub(next, QR_SECTION);
        result.qrInserted = true;
      } else if (kbNow === "missing") {
        if (!next.endsWith("\n")) next += "\n";
        next += partialStub(next, KB_SECTION);
        result.kbInserted = true;
      }
      if (next !== cur) {
        await atomicWrite(INSTRUCTIONS_MD, next);
      }
    });
  } catch (e) {
    result.error = `bootstrap write failed: ${e.message}`;
  }
  return result;
}
