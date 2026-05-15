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
import { QR_BEGIN, QR_END, QR_BEGIN_NS, QR_END_NS } from "./capture.mjs";
import { KB_BEGIN, KB_END, KB_BEGIN_NS, KB_END_NS, renderKbBlock } from "./sync.mjs";
import { classifyMarkerPair, pickMarkerPair } from "./markers.mjs";

const OKB_HEADING = "## Operational Knowledge Base (jit-memory)";
const QR_HEADING = "### Quick Rules — managed by jit_memory_capture";
const KB_HEADING = "### Domain Index";
const OKB_HEADING_RE = /^#{1,6}\s+Operational Knowledge Base \(jit-memory\)\s*$/im;
const QR_HEADING_RE = /^#{1,6}\s+Quick Rules\b.*jit_memory_capture\s*$/im;
const KB_HEADING_RE = /^#{1,6}\s+Domain Index\s*$/im;

// Item #9: stub sections render with whichever marker form (namespaced or
// legacy) is appropriate for this file. We keep both regions consistent
// within a single file: if the file's other region uses legacy markers,
// the missing region is added in legacy too; otherwise namespaced.
function labelOf(marker) {
  const m = /^<!--\s*(\S.*?)\s*-->$/.exec(marker);
  return m ? m[1] : "";
}

function makeQrSection(pair) {
  return [
    QR_HEADING,
    "",
    `<!-- jit-memory managed: do not hand-edit between ${labelOf(pair.begin)} and ${labelOf(pair.end)} -->`,
    pair.begin,
    pair.end,
    ""
  ].join("\n");
}

function makeKbSection(pair) {
  return [
    KB_HEADING,
    "",
    `<!-- jit-memory managed: do not hand-edit between ${labelOf(pair.begin)} and ${labelOf(pair.end)} -->`,
    pair.begin,
    renderKbBlock([]),
    pair.end,
    ""
  ].join("\n");
}

function hasJitMemoryHeading(content) {
  return OKB_HEADING_RE.test(content) || QR_HEADING_RE.test(content) || KB_HEADING_RE.test(content);
}

function stubWithOptionalHeading(content, sections) {
  if (hasJitMemoryHeading(content)) {
    return ["", sections].join("\n");
  }
  return ["", OKB_HEADING, "", sections].join("\n");
}

function partialStub(content, section) {
  return stubWithOptionalHeading(content, section);
}

function combinedStub(content, sections) {
  return stubWithOptionalHeading(content, sections);
}

// Decide which marker form to insert when a region is missing. If the OTHER
// region already uses a known form, match it for file consistency. Otherwise
// default to the namespaced form.
function chooseInsertForm(otherPair) {
  if (otherPair.form === "legacy") return "legacy";
  return "namespaced";
}

function pairForForm(form, ns_begin, ns_end, legacy_begin, legacy_end) {
  return form === "legacy"
    ? { begin: legacy_begin, end: legacy_end, form: "legacy" }
    : { begin: ns_begin,     end: ns_end,     form: "namespaced" };
}

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

  // Item #9: classify against whichever marker pair the file actually uses.
  const qrPair = pickMarkerPair(existing.content, QR_BEGIN_NS, QR_END_NS, QR_BEGIN, QR_END);
  const kbPair = pickMarkerPair(existing.content, KB_BEGIN_NS, KB_END_NS, KB_BEGIN, KB_END);
  result.qrState = classifyMarkerPair(existing.content, qrPair.begin, qrPair.end);
  result.kbState = classifyMarkerPair(existing.content, kbPair.begin, kbPair.end);

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
      const qrPairNow = pickMarkerPair(cur, QR_BEGIN_NS, QR_END_NS, QR_BEGIN, QR_END);
      const kbPairNow = pickMarkerPair(cur, KB_BEGIN_NS, KB_END_NS, KB_BEGIN, KB_END);
      const qrNow = classifyMarkerPair(cur, qrPairNow.begin, qrPairNow.end);
      const kbNow = classifyMarkerPair(cur, kbPairNow.begin, kbPairNow.end);
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
        // Both missing: choose namespaced for consistency in fresh installs.
        const qrInsertPair = pairForForm("namespaced", QR_BEGIN_NS, QR_END_NS, QR_BEGIN, QR_END);
        const kbInsertPair = pairForForm("namespaced", KB_BEGIN_NS, KB_END_NS, KB_BEGIN, KB_END);
        next += combinedStub(next, [makeQrSection(qrInsertPair), makeKbSection(kbInsertPair)].join("\n"));
        result.qrInserted = true;
        result.kbInserted = true;
      } else if (qrNow === "missing") {
        if (!next.endsWith("\n")) next += "\n";
        const qrForm = chooseInsertForm(kbPairNow);
        const qrInsertPair = pairForForm(qrForm, QR_BEGIN_NS, QR_END_NS, QR_BEGIN, QR_END);
        next += partialStub(next, makeQrSection(qrInsertPair));
        result.qrInserted = true;
      } else if (kbNow === "missing") {
        if (!next.endsWith("\n")) next += "\n";
        const kbForm = chooseInsertForm(qrPairNow);
        const kbInsertPair = pairForForm(kbForm, KB_BEGIN_NS, KB_END_NS, KB_BEGIN, KB_END);
        next += partialStub(next, makeKbSection(kbInsertPair));
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
