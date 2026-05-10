const encoder = new TextEncoder();

export function utf8ByteLength(value) {
  return encoder.encode(String(value ?? "")).length;
}

export function truncateUtf8(value, maxBytes) {
  const limit = Math.max(0, Number(maxBytes) || 0);
  const text = String(value ?? "");
  if (utf8ByteLength(text) <= limit) return text;

  // Array.from iterates code points, not grapheme clusters. This guarantees we
  // do not split surrogate pairs, but may still split combined emoji/diacritics.
  const codePoints = Array.from(text);
  let lo = 0;
  let hi = codePoints.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (utf8ByteLength(codePoints.slice(0, mid).join("")) <= limit) lo = mid;
    else hi = mid - 1;
  }
  return codePoints.slice(0, lo).join("");
}

export function truncateUtf8AtLineBoundary(value, maxBytes, { suffix = "\n\n_(truncated)_\n" } = {}) {
  const limit = Math.max(0, Number(maxBytes) || 0);
  const text = String(value ?? "");
  if (utf8ByteLength(text) <= limit) return text;

  const suffixText = String(suffix ?? "");
  const suffixBytes = utf8ByteLength(suffixText);
  if (suffixBytes > limit) return truncateUtf8(suffixText, limit);

  const room = limit - suffixBytes;
  let body = truncateUtf8(text, room);
  const lastNewline = body.lastIndexOf("\n");
  if (lastNewline > 0) body = body.slice(0, lastNewline);
  return `${body}${suffixText}`;
}
