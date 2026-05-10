// Idempotency + drift detection regression tests.
// Run from jit-memory/: node --test test/idempotency-and-drift.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, stat, rename, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = await mkdtemp(join(tmpdir(), "jitmem-idem-test-"));
process.env.JITMEM_EXT_ROOT        = tmp;
process.env.JITMEM_INSTRUCTIONS_MD = join(tmp, "copilot-instructions.md");
process.env.JITMEM_TEST_MODE       = "1";

const KNOW = join(tmp, "knowledge");
const INSTR = join(tmp, "copilot-instructions.md");
const ROUTING = join(KNOW, "_routing.json");

await mkdir(join(KNOW, "_archive"), { recursive: true });
await writeFile(
  INSTR,
  "# header\n\n<!-- QR:BEGIN -->\n<!-- QR:END -->\n\n<!-- KB:BEGIN -->\n<!-- KB:END -->\n",
  "utf8"
);

function frontmatter(domain, opts = {}) {
  const meta = {
    domain,
    kind: "fact",
    summary: opts.summary || `${domain} summary`,
    tags: opts.tags || ["t1"],
    aliases: [],
    see_also: [],
    verified: "2026-04-01",
    deprecated: null
  };
  return `---\n${JSON.stringify(meta, null, 2)}\n---\n\n# ${domain}\n\nbody\n`;
}

await writeFile(join(KNOW, "alpha.md"), frontmatter("alpha", { tags: ["a"] }), "utf8");
await writeFile(join(KNOW, "beta.md"),  frontmatter("beta",  { tags: ["b"] }), "utf8");

const { syncNow } = await import("../lib/sync.mjs");
const { detectDrift } = await import("../lib/drift.mjs");
const { resetSyncScheduler } = await import("./support/test-hooks.mjs");

after(async () => { await rm(tmp, { recursive: true, force: true }); });

test("first sync writes routing + KB; second sync is a no-op", async () => {
  resetSyncScheduler();
  const r1 = await syncNow({ debounceMs: 0 });
  assert.equal(r1.domainsWritten, 2);
  assert.equal(r1.routingWritten, true,  "first pass must write routing");
  assert.equal(r1.kbStatus, "ok",        "first pass must write KB block");

  const routingMtime1 = (await stat(ROUTING)).mtimeMs;
  const instrMtime1   = (await stat(INSTR)).mtimeMs;

  // Sleep a tick so any rewrite would actually bump mtime.
  await new Promise(r => setTimeout(r, 25));

  resetSyncScheduler();
  const r2 = await syncNow({ debounceMs: 0 });
  assert.equal(r2.domainsWritten, 2);
  assert.equal(r2.routingWritten, false, "second pass must NOT rewrite routing");
  assert.equal(r2.kbStatus, "noop",      "second pass must NOT rewrite instructions");

  const routingMtime2 = (await stat(ROUTING)).mtimeMs;
  const instrMtime2   = (await stat(INSTR)).mtimeMs;
  assert.equal(routingMtime1, routingMtime2, "routing mtime stable across idempotent sync");
  assert.equal(instrMtime1,   instrMtime2,   "instructions mtime stable across idempotent sync");
});

test("detectDrift: no drift after a clean sync", async () => {
  const drift = await detectDrift({ markersResult: { kbInserted: false } });
  assert.equal(drift.drifted, false, `expected no drift, got: ${drift.reasons.join(",")}`);
});

test("detectDrift: old static KB table format triggers one-shot heal", async () => {
  const current = await readFile(INSTR, "utf8");
  const oldKb = [
    "_Last generated: 2026-04-01_",
    "",
    "| Tags | File | Summary |",
    "|---|---|---|",
    "| a | alpha.md | alpha summary |",
    "| b | beta.md | beta summary |"
  ].join("\n");
  const oldFormat = current.replace(
    /<!-- KB:BEGIN -->[\s\S]*?<!-- KB:END -->/,
    `<!-- KB:BEGIN -->\n${oldKb}\n<!-- KB:END -->`
  );
  await writeFile(INSTR, oldFormat, "utf8");

  const drift = await detectDrift();
  assert.equal(drift.drifted, true);
  assert.ok(drift.reasons.includes("kb_format_outdated"),
    `expected kb_format_outdated reason, got: ${drift.reasons.join(",")}`);

  resetSyncScheduler();
  const r = await syncNow({ debounceMs: 0 });
  assert.equal(r.kbStatus, "ok");
  const healed = await readFile(INSTR, "utf8");
  assert.match(healed, /\| Domain \| File \|/);
  assert.doesNotMatch(healed, /\| Tags \| File \| Summary \|/);

  const after = await detectDrift();
  assert.equal(after.drifted, false, `expected no drift after heal, got: ${after.reasons.join(",")}`);
});

test("detectDrift: KB date-only difference does not trigger format heal", async () => {
  const current = await readFile(INSTR, "utf8");
  const dateChanged = current.replace(/_Last generated: \d{4}-\d{2}-\d{2}_/, "_Last generated: 1999-01-01_");
  await writeFile(INSTR, dateChanged, "utf8");

  const drift = await detectDrift();
  assert.ok(!drift.reasons.includes("kb_format_outdated"),
    `unexpected kb_format_outdated reason: ${drift.reasons.join(",")}`);
});

test("detectDrift: kb_inserted forces drift even with stable files", async () => {
  const drift = await detectDrift({ markersResult: { kbInserted: true } });
  assert.equal(drift.drifted, true);
  assert.ok(drift.reasons.includes("kb_inserted"));
});

test("detectDrift: missing instructions does not force KB format heal", async () => {
  await rm(INSTR, { force: true });
  try {
    const drift = await detectDrift();
    assert.ok(!drift.reasons.includes("kb_format_outdated"),
      `unexpected kb_format_outdated reason: ${drift.reasons.join(",")}`);
  } finally {
    await writeFile(
      INSTR,
      "# header\n\n<!-- QR:BEGIN -->\n<!-- QR:END -->\n\n<!-- KB:BEGIN -->\n<!-- KB:END -->\n",
      "utf8"
    );
    resetSyncScheduler();
    await syncNow({ debounceMs: 0 });
  }
});

test("detectDrift: file removed (renamed to hidden) triggers heal", async () => {
  // Simulate the demo scenario: rename email.md -> _email.md
  await rename(join(KNOW, "alpha.md"), join(KNOW, "_alpha.md"));
  try {
    const drift = await detectDrift();
    assert.equal(drift.drifted, true);
    assert.ok(drift.reasons.includes("file_removed"),
      `expected file_removed reason, got: ${drift.reasons.join(",")}`);
  } finally {
    await rename(join(KNOW, "_alpha.md"), join(KNOW, "alpha.md"));
  }
});

test("detectDrift: new file triggers file_added", async () => {
  await writeFile(join(KNOW, "gamma.md"), frontmatter("gamma", { tags: ["g"] }), "utf8");
  try {
    const drift = await detectDrift();
    assert.equal(drift.drifted, true);
    assert.ok(drift.reasons.includes("file_added"),
      `expected file_added reason, got: ${drift.reasons.join(",")}`);
  } finally {
    await rm(join(KNOW, "gamma.md"), { force: true });
  }
});

test("detectDrift: modified file triggers file_modified", async () => {
  await new Promise(r => setTimeout(r, 25));
  // Touch alpha.md so its mtime exceeds routing.json mtime.
  const current = await readFile(join(KNOW, "alpha.md"), "utf8");
  await writeFile(join(KNOW, "alpha.md"), current + "\n# extra\n", "utf8");
  try {
    const drift = await detectDrift();
    assert.equal(drift.drifted, true);
    assert.ok(drift.reasons.includes("file_modified"),
      `expected file_modified reason, got: ${drift.reasons.join(",")}`);
  } finally {
    await writeFile(join(KNOW, "alpha.md"), current, "utf8");
  }
});

test("end-to-end: sync after rename heals routing", async () => {
  await rename(join(KNOW, "beta.md"), join(KNOW, "_beta.md"));
  resetSyncScheduler();
  const r = await syncNow({ debounceMs: 0 });
  assert.equal(r.domainsWritten, 1, "beta should have been removed from routing");
  assert.equal(r.routingWritten, true);

  const routing = JSON.parse(await readFile(ROUTING, "utf8"));
  assert.equal(routing.domains.length, 1);
  assert.equal(routing.domains[0].domain, "alpha");

  // Restore for any later tests.
  await rename(join(KNOW, "_beta.md"), join(KNOW, "beta.md"));
});
