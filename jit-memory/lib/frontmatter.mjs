// JSON frontmatter — strict format. File begins with:
//   ---\n
//   { ... JSON ... }\n
//   ---\n
// followed by markdown body. We chose JSON over YAML to eliminate the
// homegrown-parser footgun: JSON.parse is the authoritative parser.

import { isValidSlug } from "./paths.mjs";

const RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const KIND_VALUES = new Set(["fact", "protocol", "reference"]);

export function parse(text) {
  if (typeof text !== "string") throw new Error("frontmatter.parse: text must be a string");
  const m = RE.exec(text);
  if (!m) throw new Error("frontmatter.parse: missing or malformed --- delimiters at start of file");
  let meta;
  try {
    meta = JSON.parse(m[1]);
  } catch (e) {
    throw new Error(`frontmatter.parse: invalid JSON in frontmatter: ${e.message}`);
  }
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    throw new Error("frontmatter.parse: top-level frontmatter must be a JSON object");
  }
  const body = text.slice(m[0].length);
  return { meta, body };
}

export function stringify(meta, body = "") {
  // Pretty-print so humans can diff/inspect, but the parser only cares about JSON validity.
  const json = JSON.stringify(meta, null, 2);
  // Ensure body separation by exactly one newline after the closing fence.
  return `---\n${json}\n---\n${body.startsWith("\n") ? body.slice(1) : body}`;
}

// Validate the metadata object. Returns { ok, errors[] } — does NOT throw.
// Strict at write time (capture must call this). Sync may tolerate failures.
export function validateMeta(meta) {
  const errors = [];

  if (!meta || typeof meta !== "object") {
    return { ok: false, errors: ["meta must be an object"] };
  }

  if (!isValidSlug(meta.domain)) {
    errors.push(`domain must be a valid slug (${JSON.stringify(meta.domain)})`);
  }
  if (!KIND_VALUES.has(meta.kind)) {
    errors.push(`kind must be one of ${[...KIND_VALUES].join("|")} (got ${JSON.stringify(meta.kind)})`);
  }
  if (typeof meta.summary !== "string" || meta.summary.length === 0 || meta.summary.length > 200) {
    errors.push("summary must be a non-empty string ≤200 chars");
  }
  if (!Array.isArray(meta.tags) || meta.tags.length < 1 || meta.tags.length > 12) {
    errors.push("tags must be an array of 1–12 strings");
  } else {
    for (const t of meta.tags) {
      if (typeof t !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(t)) {
        errors.push(`tags entry invalid: ${JSON.stringify(t)} (lowercase, digits, hyphens, ≤40 chars)`);
      }
    }
  }
  if (!Array.isArray(meta.aliases) || meta.aliases.length > 8) {
    errors.push("aliases must be an array of 0–8 strings");
  } else {
    for (const a of meta.aliases) {
      if (typeof a !== "string" || a.length < 3 || a.length > 40) {
        errors.push(`alias invalid: ${JSON.stringify(a)} (3–40 chars)`);
      }
    }
  }
  if (!Array.isArray(meta.see_also) || meta.see_also.length > 4) {
    errors.push("see_also must be an array of 0–4 slugs");
  } else {
    for (const s of meta.see_also) {
      if (!isValidSlug(s)) errors.push(`see_also entry invalid slug: ${JSON.stringify(s)}`);
    }
  }
  if (typeof meta.verified !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(meta.verified)) {
    errors.push("verified must be ISO date string YYYY-MM-DD");
  }
  if (meta.deprecated !== null && (typeof meta.deprecated !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(meta.deprecated))) {
    errors.push("deprecated must be null or ISO date string YYYY-MM-DD");
  }

  return { ok: errors.length === 0, errors };
}

// Convenience: parse and validate. Returns { meta, body, valid: {ok, errors} }.
export function parseAndValidate(text) {
  const { meta, body } = parse(text);
  const valid = validateMeta(meta);
  return { meta, body, valid };
}
