// Item #14: deterministic redaction scanner blocks captures containing
// obvious secrets/PII unless confirm_redaction_skip:true is set.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = await mkdtemp(join(tmpdir(), "jitmem-redact-"));
process.env.JITMEM_EXT_ROOT = tmp;
process.env.JITMEM_INSTRUCTIONS_MD = join(tmp, "copilot-instructions.md");
await mkdir(join(tmp, "knowledge"), { recursive: true });
await writeFile(process.env.JITMEM_INSTRUCTIONS_MD,
  "<!-- jit-memory:QR:BEGIN -->\n<!-- jit-memory:QR:END -->\n<!-- jit-memory:KB:BEGIN -->\n<!-- jit-memory:KB:END -->\n", "utf8");

const { scanRedactable } = await import("../lib/redaction.mjs");
const { capture, refreshForbiddenMarkers } = await import("../lib/capture.mjs");
await refreshForbiddenMarkers();

test("scanRedactable: clean content has no findings", () => {
  const r = scanRedactable("a normal lesson about how to use git rebase safely");
  assert.equal(r.findings.length, 0);
});

test("scanRedactable: GitHub token detected", () => {
  const r = scanRedactable("set GITHUB_TOKEN=ghp_abcdefghijklmnopqrst1234567890ABCD please");
  assert.ok(r.findings.find(f => f.kind === "github-token"));
});

test("scanRedactable: AWS access key detected", () => {
  const r = scanRedactable("env AKIAIOSFODNN7EXAMPLE works");
  assert.ok(r.findings.find(f => f.kind === "aws-access-key"));
});

test("scanRedactable: Bearer header detected", () => {
  const r = scanRedactable("Authorization: Bearer abc123def456ghi789jkl012mno345pqr678");
  assert.ok(r.findings.find(f => f.kind === "bearer-header"));
});

test("scanRedactable: Windows user path detected", () => {
  const r = scanRedactable("the file is at C:\\Users\\anmontg\\.copilot\\foo");
  assert.ok(r.findings.find(f => f.kind === "windows-user-path"));
});

test("scanRedactable: private IPv4 detected", () => {
  const r = scanRedactable("connect to 10.0.42.17 for the database");
  assert.ok(r.findings.find(f => f.kind === "ipv4-private"));
});

test("scanRedactable: high-entropy hex catches generic token-like strings", () => {
  const r = scanRedactable("session id 0123456789abcdef0123456789abcdef0123 is the issue");
  assert.ok(r.findings.find(f => f.kind === "high-entropy-string"));
});

test("capture refuses (needs_redaction) when content has a secret", async () => {
  const r = await capture({
    kind: "domain_new",
    domain: "secrets-test",
    summary: "test",
    tags: ["alpha", "beta"],
    content: "use ghp_abcdefghijklmnopqrst1234567890ABCD to authenticate"
  });
  assert.equal(r.status, "needs_redaction");
  assert.ok(Array.isArray(r.findings));
  assert.ok(r.findings.length > 0);
});

test("capture override: confirm_redaction_skip:true bypasses the scan", async () => {
  const r = await capture({
    kind: "domain_new",
    domain: "secrets-override",
    summary: "test",
    tags: ["alpha", "beta"],
    content: "use ghp_abcdefghijklmnopqrst1234567890ABCD to authenticate",
    confirm_redaction_skip: true
  });
  assert.equal(r.status, "ok");
});
