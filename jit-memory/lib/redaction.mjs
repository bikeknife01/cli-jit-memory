// Item #14: deterministic redaction scanner.
//
// Catches obvious secrets, tokens, IPs, and absolute home paths in capture
// content BEFORE it lands in a knowledge file. Returns a list of findings
// that the capture pipeline maps to status "needs_redaction" unless the
// caller passes `confirm_redaction_skip: true` to override.
//
// This is heuristic and intentionally conservative: a finding is a
// "consider redacting" signal, not a hard block. The agent (or user) can
// override by re-calling with confirm_redaction_skip:true.

const PATTERNS = [
  // Well-known secret prefixes
  { kind: "github-token",        re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g },
  { kind: "github-app-jwt",      re: /\beyJ[A-Za-z0-9._-]{20,}\b/g },
  { kind: "openai-key",          re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { kind: "stripe-live-key",     re: /\b(sk|pk|rk)_live_[A-Za-z0-9]{16,}\b/g },
  { kind: "aws-access-key",      re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "slack-bot-token",     re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "google-api-key",      re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { kind: "azure-shared-key",    re: /\b[A-Za-z0-9+/]{43}=\b/g, label: "base64 88-bit shared key" },
  { kind: "private-key-block",   re: /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED |DSA |PGP )?PRIVATE KEY-----/g },
  { kind: "bearer-header",       re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g },

  // Network identifiers
  { kind: "ipv4-private",        re: /\b(?:10|127|169\.254|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g },
  { kind: "ipv6-link-local",     re: /\bfe80::[A-Fa-f0-9:]+\b/g },

  // Absolute user paths (likely to leak username/repo layout)
  { kind: "windows-user-path",   re: /\b[A-Za-z]:\\Users\\[^\\\s"']+/g },
  { kind: "mac-user-path",       re: /\/Users\/[A-Za-z0-9_.-]+/g },
  { kind: "linux-home-path",     re: /\/home\/[A-Za-z0-9_.-]+/g }
];

// High-entropy / long hex string heuristic (>=32 hex chars). This is a
// generic "looks like a token" catch.
const HEX_RE = /\b[a-f0-9]{32,}\b/gi;
// Generic long base64-ish strings (>=40 chars of [A-Za-z0-9+/_-]).
const BASE64_LIKE_RE = /\b[A-Za-z0-9+/_-]{40,}\b/g;

function clip(s, n = 24) {
  if (s.length <= n) return s;
  return s.slice(0, n - 3) + "...";
}

// Heuristic: a run of repeated characters has near-zero entropy and is
// almost never a token. Skip matches whose distinct-character count is low.
function looksLikeRandomToken(s, minDistinct = 8) {
  const set = new Set(s);
  return set.size >= minDistinct;
}

export function scanRedactable(text) {
  if (typeof text !== "string" || text.length === 0) return { findings: [] };
  const findings = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text)) !== null) {
      findings.push({ kind: p.kind, snippet: clip(m[0]) });
      if (m.index === p.re.lastIndex) p.re.lastIndex++;
    }
  }
  // Generic high-entropy fallback. Skip strings already matched by a named
  // pattern at the same offset, and skip low-entropy runs (repeated chars).
  const seenSpans = new Set();
  for (const re of [HEX_RE, BASE64_LIKE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const key = `${m.index}:${m[0].length}`;
      if (seenSpans.has(key)) continue;
      seenSpans.add(key);
      if (!looksLikeRandomToken(m[0])) continue;            // skip "xxxx..." style
      // Skip if already captured by a named pattern (same start index).
      if (findings.some(f => text.indexOf(f.snippet.replace(/\.{3}$/, "")) === m.index)) continue;
      findings.push({ kind: "high-entropy-string", snippet: clip(m[0]) });
    }
  }
  // Deduplicate by (kind, snippet)
  const seen = new Set();
  const dedup = [];
  for (const f of findings) {
    const k = `${f.kind}:${f.snippet}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(f);
  }
  return { findings: dedup };
}
