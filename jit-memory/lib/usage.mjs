// Telemetry: in-memory delta tracking; lock-merge-write on flush.
// Privacy: no prompt content, no tags. Only date | slug | hits.

import { promises as fs } from "node:fs";
import { basename } from "node:path";
import { USAGE_JSON, isValidSlug } from "./paths.mjs";
import { atomicWrite, withLock } from "./atomic.mjs";

const FLUSH_EVERY_PROMPTS = 10;
const FLUSH_EVERY_MS      = 5 * 60 * 1000;

export function normalizeUsage(input) {
  const parsed = input && typeof input === "object" ? input : {};
  const sourceDomains = parsed.domains && typeof parsed.domains === "object" && !Array.isArray(parsed.domains)
    ? parsed.domains
    : {};
  const domains = {};
  for (const [slug, value] of Object.entries(sourceDomains)) {
    if (!isValidSlug(slug) || !value || typeof value !== "object" || Array.isArray(value)) continue;
    domains[slug] = {
      hits: Number.isFinite(value.hits) ? Math.max(0, value.hits) : 0,
      lastHit: Number.isFinite(value.lastHit) ? Math.max(0, value.lastHit) : 0
    };
  }
  return {
    version: 1,
    generated: parsed.generated ?? null,
    domains
  };
}

export function usageDomainsForFile(rel, meta = null) {
  const out = new Set();
  const fallback = basename(String(rel || ""), ".md");
  if (isValidSlug(fallback)) out.add(fallback);
  if (meta && isValidSlug(meta.domain)) out.add(meta.domain);
  return out;
}

export async function pruneUsageDomains(activeDomains, { now = new Date() } = {}) {
  const active = new Set([...activeDomains].filter(isValidSlug));
  return await withLock(USAGE_JSON, async () => {
    let parsed;
    try {
      const raw = await fs.readFile(USAGE_JSON, "utf8");
      parsed = JSON.parse(raw);
    } catch (e) {
      if (e.code === "ENOENT") {
        return { ok: true, prunedCount: 0, prunedDomains: [], written: false };
      }
      throw e;
    }

    const normalized = normalizeUsage(parsed);
    const domains = {};
    const prunedDomains = [];
    for (const [slug, value] of Object.entries(normalized.domains)) {
      if (active.has(slug)) domains[slug] = value;
      else prunedDomains.push(slug);
    }

    const next = { version: 1, generated: normalized.generated, domains };
    const normalizationChanged = !isAlreadyNormalized(parsed, normalized);
    if (prunedDomains.length === 0 && !normalizationChanged) {
      return { ok: true, prunedCount: 0, prunedDomains: [], written: false };
    }

    next.generated = now.toISOString();
    await atomicWrite(USAGE_JSON, JSON.stringify(next, null, 2));
    return {
      ok: true,
      prunedCount: prunedDomains.length,
      prunedDomains,
      written: true
    };
  });
}

function isAlreadyNormalized(parsed, normalized) {
  if (!parsed || typeof parsed !== "object") return false;
  if (parsed.version !== normalized.version) return false;
  if ((parsed.generated ?? null) !== normalized.generated) return false;
  if (!parsed.domains || typeof parsed.domains !== "object" || Array.isArray(parsed.domains)) return false;
  const parsedKeys = Object.keys(parsed.domains).sort();
  const normalizedKeys = Object.keys(normalized.domains).sort();
  if (parsedKeys.length !== normalizedKeys.length) return false;
  for (let i = 0; i < parsedKeys.length; i++) {
    if (parsedKeys[i] !== normalizedKeys[i]) return false;
    const a = parsed.domains[parsedKeys[i]];
    const b = normalized.domains[normalizedKeys[i]];
    if (!a || typeof a !== "object" || Array.isArray(a)) return false;
    if (a.hits !== b.hits || a.lastHit !== b.lastHit) return false;
  }
  return true;
}

export class UsageTracker {
  constructor({ onFlushError } = {}) {
    this.deltas = new Map();      // slug → { hits, lastHit }
    // Per-prompt counter. Incremented exactly once per prompt by notePrompt().
    // bump() is called once PER ROUTED MATCH, so a single prompt can produce
    // multiple bumps; using bumps as the prompt-count would fire the flush
    // threshold ~3× more often than intended.
    this.promptsSinceFlush = 0;
    this.lastFlushAt = Date.now();
    this.onFlushError = onFlushError || (() => {});
    this._inFlight = null;
  }

  // Per-match: increments hit count for a slug. Called once per routed match.
  bump(slug) {
    if (!slug) return;
    const cur = this.deltas.get(slug) || { hits: 0, lastHit: 0 };
    cur.hits += 1;
    cur.lastHit = Date.now();
    this.deltas.set(slug, cur);
  }

  // Per-prompt: call exactly once per onUserPromptSubmitted invocation,
  // regardless of match count (or even if there were zero matches).
  notePrompt() {
    this.promptsSinceFlush += 1;
  }

  shouldFlush() {
    if (this.deltas.size === 0 && this.promptsSinceFlush === 0) return false;
    if (this.promptsSinceFlush >= FLUSH_EVERY_PROMPTS) return true;
    if (Date.now() - this.lastFlushAt >= FLUSH_EVERY_MS) return true;
    return false;
  }

  async flush() {
    if (this._inFlight) return this._inFlight;
    if (this.deltas.size === 0) {
      // No data to write, but consider this a logical flush so we don't
      // re-fire shouldFlush() on every subsequent zero-match prompt.
      this.promptsSinceFlush = 0;
      this.lastFlushAt = Date.now();
      return { ok: true, empty: true };
    }

    // Snapshot deltas WITHOUT clearing — clear only after successful write.
    // Deep-copy value objects: bump() mutates the existing { hits, lastHit }
    // object in place, so a shallow `new Map(this.deltas)` would share refs
    // and a same-slug bump during the in-flight write would mutate the
    // snapshot too, causing the subtraction step to subtract the late bump
    // as if it had been written. Deep-copy ensures snapshot is immutable.
    const snapshot = new Map(
      [...this.deltas].map(([slug, d]) => [slug, { hits: d.hits, lastHit: d.lastHit }])
    );

    this._inFlight = (async () => {
      try {
        await withLock(USAGE_JSON, async () => {
          // Read current.
          let current = { version: 1, generated: null, domains: {} };
          try {
            const raw = await fs.readFile(USAGE_JSON, "utf8");
            const parsed = JSON.parse(raw);
            current = normalizeUsage(parsed);
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
          // Merge: sum hits, max lastHit.
          for (const [slug, d] of snapshot.entries()) {
            const prior = current.domains[slug] || { hits: 0, lastHit: 0 };
            current.domains[slug] = {
              hits:    prior.hits + d.hits,
              lastHit: Math.max(prior.lastHit, d.lastHit)
            };
          }
          current.generated = new Date().toISOString();
          await atomicWrite(USAGE_JSON, JSON.stringify(current, null, 2));
        });

        // Subtract snapshot from deltas (don't clobber concurrent bumps).
        for (const [slug, d] of snapshot.entries()) {
          const cur = this.deltas.get(slug);
          if (!cur) continue;
          cur.hits -= d.hits;
          if (cur.hits <= 0) this.deltas.delete(slug);
          else this.deltas.set(slug, cur);
        }
        this.promptsSinceFlush = 0;
        this.lastFlushAt = Date.now();
        return { ok: true };
      } catch (e) {
        try { this.onFlushError(e); } catch {}
        // Deltas preserved — will retry next flush.
        return { ok: false, error: e };
      } finally {
        this._inFlight = null;
      }
    })();

    return this._inFlight;
  }

  // Final drain on session end: waits for any in-flight flush, then loops
  // until deltas are empty or a flush() call returns { ok: false }. Bounded
  // by maxPasses to prevent unbounded retry on transient races. Stops on
  // the first failed pass — session-end drain is one-shot, and spinning on
  // a failing disk/lock won't help. Concurrent bumps during a flush are
  // preserved (flush() snapshots immutably) and drained on the next pass.
  // Progress is detected from flush()'s explicit ok/fail return value, not
  // from delta-map size, which can be unchanged after a legitimate
  // successful flush in some implementations.
  async flushFinal({ maxPasses = 5 } = {}) {
    if (this._inFlight) {
      try { await this._inFlight; } catch {}
    }
    for (let pass = 0; pass < maxPasses; pass++) {
      if (this.deltas.size === 0) {
        return { passes: pass, deltasRemaining: 0, stalled: false };
      }
      const r = await this.flush();
      if (r && r.ok === false) {
        return { passes: pass + 1, deltasRemaining: this.deltas.size, stalled: true };
      }
    }
    return { passes: maxPasses, deltasRemaining: this.deltas.size, stalled: this.deltas.size > 0 };
  }
}

// Read-only loader for audit.
export async function loadUsage() {
  try {
    const raw = await fs.readFile(USAGE_JSON, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeUsage(parsed);
  } catch (e) {
    if (e.code === "ENOENT") return { version: 1, generated: null, domains: {} };
    throw e;
  }
}
