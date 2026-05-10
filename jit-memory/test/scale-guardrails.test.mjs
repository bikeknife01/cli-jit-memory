import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = await mkdtemp(join(tmpdir(), "jitmem-scale-test-"));
process.env.JITMEM_EXT_ROOT = tmp;
process.env.JITMEM_TEST_MODE = "1";
process.env.JITMEM_INSTRUCTIONS_MD = join(tmp, "copilot-instructions.md");

const paths = await import("../lib/paths.mjs");
const { audit } = await import("../lib/audit.mjs");

beforeEach(async () => {
  await rm(paths.KNOWLEDGE_ROOT, { recursive: true, force: true });
  await mkdir(paths.KNOWLEDGE_ROOT, { recursive: true });
  await rm(paths.DIGEST_MD, { force: true });
});

test("small knowledge base has no scale warnings and remains healthy", async () => {
  await writeFile(join(paths.KNOWLEDGE_ROOT, "small.md"), domainFile("small"), "utf8");
  const r = await audit({ archivalAllowed: false });
  assert.equal(r.healthy, true);
  assert.deepEqual(r.findings.scaleWarnings, []);
});

test("domain count over guardrail creates scale warning and digest section", async () => {
  for (let i = 0; i < 76; i++) {
    const slug = `scale-domain-${i}`;
    await writeFile(join(paths.KNOWLEDGE_ROOT, `${slug}.md`), domainFile(slug), "utf8");
  }

  const r = await audit({ archivalAllowed: false });
  assert.equal(r.healthy, false);
  assert.ok(r.findings.scaleWarnings.some(w => w.kind === "domain_count"));
  assert.match(r.digest, /Scale guardrails/);
});

test("large static KB block creates scale warning", async () => {
  // Keep domain count under DOMAIN_COUNT_WARN; long nested file_rel values alone
  // should make the compact static signpost exceed KB_BLOCK_BYTES_WARN.
  const subdir = join(
    paths.KNOWLEDGE_ROOT,
    "long-static-signpost-segment",
    "another-long-static-signpost-segment",
    "third-long-static-signpost-segment"
  );
  await mkdir(subdir, { recursive: true });
  for (let i = 0; i < 40; i++) {
    const slug = `kb-heavy-${String(i).padStart(3, "0")}`;
    await writeFile(
      join(subdir, `${slug}.md`),
      domainFile(slug, { summary: "x".repeat(200) }),
      "utf8"
    );
  }

  const r = await audit({ archivalAllowed: false });
  assert.ok(r.findings.scaleWarnings.some(w => w.kind === "kb_block_bytes"));
  assert.ok(!r.findings.scaleWarnings.some(w => w.kind === "domain_count"));
  assert.match(r.digest, /kb_block_bytes/);
});

test("large routing table creates scale warning", async () => {
  await writeFile(join(paths.KNOWLEDGE_ROOT, "routeactive.md"), domainFile("routeactive"), "utf8");
  await writeFile(paths.ROUTING_JSON, JSON.stringify({
    version: 3,
    domains: [{ domain: "routeactive", file_rel: "routeactive.md", tags: ["routeactive"], summary: "x".repeat(132_000) }]
  }), "utf8");

  const r = await audit({ archivalAllowed: false });
  assert.ok(r.findings.scaleWarnings.some(w => w.kind === "routing_json_bytes"));
  assert.match(r.digest, /routing_json_bytes/);
});

function domainFile(domain, opts = {}) {
  const meta = {
    domain,
    kind: "fact",
    summary: opts.summary || `${domain} summary`,
    tags: [domain],
    aliases: [],
    see_also: [],
    verified: "2026-05-09",
    deprecated: null
  };
  return `---\n${JSON.stringify(meta, null, 2)}\n---\n# ${domain}\n`;
}
