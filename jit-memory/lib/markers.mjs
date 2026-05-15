function countAll(s, needle) {
  let n = 0, i = 0;
  while ((i = s.indexOf(needle, i)) >= 0) { n++; i += needle.length; }
  return n;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function markerLabel(marker) {
  // Current managed labels are single tokens such as QR:BEGIN. If future
  // markers use multi-word labels, expand variant matching before using them.
  const m = /^<!--\s*(\S.*?)\s*-->$/.exec(marker);
  return m ? m[1] : null;
}

function countWhitespaceVariants(content, marker) {
  const label = markerLabel(marker);
  if (!label) return null;
  // Whitespace variants are still marker comments, even when the whitespace
  // includes newlines. Text examples are intentionally treated the same as live
  // markers, matching exact marker handling.
  const re = new RegExp(`<!--\\s*${escapeRegExp(label)}\\s*-->`, "g");
  return (content.match(re) || []).length;
}

export function classifyMarkerPair(content, beginMarker, endMarker) {
  if (!content) return "missing";
  if (beginMarker === endMarker) return "malformed";

  const beginCount = countAll(content, beginMarker);
  const endCount = countAll(content, endMarker);
  const beginVariantCount = countWhitespaceVariants(content, beginMarker);
  const endVariantCount = countWhitespaceVariants(content, endMarker);
  if ((beginVariantCount !== null && beginVariantCount !== beginCount) ||
      (endVariantCount !== null && endVariantCount !== endCount)) {
    return "malformed";
  }

  if (beginCount === 0 && endCount === 0) return "missing";
  if (beginCount === 1 && endCount === 1) {
    const b = content.indexOf(beginMarker);
    const e = content.indexOf(endMarker, b + beginMarker.length);
    if (e > b) return "ok";
  }
  return "malformed";
}

// Item #9: choose which marker pair (namespaced vs legacy) is active in this
// file. Existing users have legacy `<!-- QR:BEGIN -->` markers in their
// instructions; new installs get the namespaced form
// `<!-- jit-memory:QR:BEGIN -->` from the snippet. We never silently rewrite
// a user's chosen form.
//
// Detection is whitespace-tolerant: a malformed legacy variant like
// `<!--QR:BEGIN-->` is still recognised as legacy so classifyMarkerPair can
// later flag it malformed instead of bootstrap silently inserting a fresh
// namespaced pair alongside.
//
// Returns `{ begin, end, form }` where form is "namespaced" | "legacy" |
// "default-namespaced".
export function pickMarkerPair(content, namespacedBegin, namespacedEnd, legacyBegin, legacyEnd) {
  const text = content || "";
  const hasVariant = (marker) => {
    const label = markerLabel(marker);
    if (!label) return text.includes(marker);
    const re = new RegExp(`<!--\\s*${escapeRegExp(label)}\\s*-->`);
    return re.test(text);
  };
  if (hasVariant(namespacedBegin) || hasVariant(namespacedEnd)) {
    return { begin: namespacedBegin, end: namespacedEnd, form: "namespaced" };
  }
  if (hasVariant(legacyBegin) || hasVariant(legacyEnd)) {
    return { begin: legacyBegin, end: legacyEnd, form: "legacy" };
  }
  return { begin: namespacedBegin, end: namespacedEnd, form: "default-namespaced" };
}
