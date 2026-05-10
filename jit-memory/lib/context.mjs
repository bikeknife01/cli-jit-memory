// Build the additionalContext payload from router matches.
// Hard 4 KB UTF-8 budget. Skip per-file failures. Tier-aware truncation.

import { promises as fs } from "node:fs";
import { parse } from "./frontmatter.mjs";
import { assertRoutableKnowledgeFile } from "./paths.mjs";
import { utf8ByteLength as utf8len, truncateUtf8 } from "./utf8.mjs";

const BUDGET_BYTES        = 4096;
const PER_FILE_HIGH_BYTES = 1500;
const PER_FILE_MED_BYTES  = 600;
const OVERHEAD_BYTES      = 64;

function strip(body) {
  // Trim leading whitespace; collapse runs of blank lines.
  return String(body || "").replace(/^\s+/, "").replace(/\n{3,}/g, "\n\n");
}

// XML-escape for content rendered inside <memory> blocks. Prevents captured
// content with `</memory>` or `</jit-memory>` (or stray `&`/`<`) from breaking
// out of the additionalContext payload structure.
function xmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function xmlEscapeAttr(s) {
  return xmlEscape(s).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function blockOpen(m) {
  const attrs = [
    `slug="${xmlEscapeAttr(m.slug)}"`,
    `confidence="${xmlEscapeAttr(m.confidence)}"`,
    `verified="${xmlEscapeAttr(m.verified || "")}"`,
    `stale="${m.stale ? "true" : "false"}"`
  ].join(" ");
  return `<memory ${attrs}>`;
}

// Per-file builder. Returns {ok, text} or {ok:false} on error.
async function buildBlock(match) {
  try {
    // Defense-in-depth: even though the router already validates these
    // paths, re-assert before any filesystem read so a corrupted match
    // object passed in directly cannot escape KNOWLEDGE_ROOT.
    const safePath = assertRoutableKnowledgeFile(match.file);
    const raw = await fs.readFile(safePath, "utf8");
    const { body } = parse(raw);
    const cleanBody = xmlEscape(strip(body));
    const open  = blockOpen(match);
    const close = `</memory>`;
    const summary = `Summary: ${xmlEscape(match.summary)}`;

    if (match.confidence === "high") {
      const cap = PER_FILE_HIGH_BYTES;
      const overhead = utf8len(open) + utf8len(close) + utf8len(summary) + 8;
      const room = Math.max(0, cap - overhead);
      const excerpt = truncateUtf8(cleanBody, room);
      const text = `${open}\n${summary}\n${excerpt}\n${close}`;
      return { ok: true, text };
    }
    if (match.confidence === "medium") {
      const cap = PER_FILE_MED_BYTES;
      const overhead = utf8len(open) + utf8len(close) + utf8len(summary) + 8;
      const room = Math.max(0, cap - overhead);
      // Take first 1–2 short paragraphs of body, capped.
      const excerpt = truncateUtf8(cleanBody.split(/\n\n/).slice(0, 2).join("\n\n"), room);
      const text = `${open}\n${summary}\n${excerpt}\n${close}`;
      return { ok: true, text };
    }
    // Low — summary + path only.
    const text = `${open}\n${summary}\n${close}`;
    return { ok: true, text };
  } catch {
    return { ok: false };
  }
}

// Assemble the full payload. Returns string or null if all blocks failed.
export async function assembleContext(matches) {
  if (!matches || matches.length === 0) return null;
  const header = `<jit-memory budget="${BUDGET_BYTES}">`;
  const footer = `</jit-memory>`;
  let used = utf8len(header) + utf8len(footer) + OVERHEAD_BYTES;
  const blocks = [];

  for (const m of matches) {
    const b = await buildBlock(m);
    if (!b.ok) continue;
    const cost = utf8len(b.text) + 1; // newline
    if (used + cost > BUDGET_BYTES) {
      // Try a low-form fallback (summary only) before giving up.
      if (m.confidence !== "low") {
        const lowOpen  = blockOpen({ ...m, confidence: "low" });
        const lowClose = "</memory>";
        const lowText  = `${lowOpen}\nSummary: ${xmlEscape(m.summary)}\n${lowClose}`;
        const lowCost  = utf8len(lowText) + 1;
        if (used + lowCost <= BUDGET_BYTES) {
          blocks.push(lowText);
          used += lowCost;
        }
      }
      continue;
    }
    blocks.push(b.text);
    used += cost;
  }

  if (blocks.length === 0) return null;
  return `${header}\n${blocks.join("\n")}\n${footer}`;
}
