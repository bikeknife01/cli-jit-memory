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

test("scanRedactable: connection-string Password= detected", () => {
  const r = scanRedactable("Server=myhost;Database=mydb;Password=S3cr3tP@ssword!;Trusted_Connection=False;");
  assert.ok(r.findings.find(f => f.kind === "conn-string-password"), `expected conn-string-password; got ${JSON.stringify(r.findings)}`);
});

test("scanRedactable: connection-string Pwd= detected", () => {
  const r = scanRedactable("mongodb://user:pass@host/db?Pwd=my-secret-pw-123");
  assert.ok(r.findings.find(f => f.kind === "conn-string-password"), `expected conn-string-password; got ${JSON.stringify(r.findings)}`);
});

test("scanRedactable: AccountKey= detected", () => {
  const r = scanRedactable("DefaultEndpointsProtocol=https;AccountName=mystorageacct;AccountKey=abc123def456ghi789jkl0mno;EndpointSuffix=core.windows.net");
  assert.ok(r.findings.find(f => f.kind === "conn-string-key"), `expected conn-string-key; got ${JSON.stringify(r.findings)}`);
});

test("scanRedactable: SharedAccessKey= detected", () => {
  const r = scanRedactable("Endpoint=sb://myns.servicebus.windows.net/;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=xyzAbcDef123456789");
  assert.ok(r.findings.find(f => f.kind === "conn-string-key"), `expected conn-string-key; got ${JSON.stringify(r.findings)}`);
});

test("scanRedactable: Password=<placeholder> is NOT flagged (doc-style)", () => {
  const r = scanRedactable("Set Password=<your-password> in the config");
  assert.ok(!r.findings.find(f => f.kind === "conn-string-password"), `should not flag placeholder; got ${JSON.stringify(r.findings)}`);
});

test("scanRedactable: internal hostname (.internal) detected", () => {
  const r = scanRedactable("connect to redis.internal:6379 for caching");
  assert.ok(r.findings.find(f => f.kind === "internal-hostname"), `expected internal-hostname; got ${JSON.stringify(r.findings)}`);
});

test("scanRedactable: internal hostname (.corp) detected", () => {
  const r = scanRedactable("the deploy target is api-gateway.corp");
  assert.ok(r.findings.find(f => f.kind === "internal-hostname"), `expected internal-hostname; got ${JSON.stringify(r.findings)}`);
});

test("scanRedactable: mDNS hostname (.local) detected", () => {
  const r = scanRedactable("postgres is running on db-server.local");
  assert.ok(r.findings.find(f => f.kind === "internal-hostname"), `expected internal-hostname; got ${JSON.stringify(r.findings)}`);
});

test("scanRedactable: plain word 'local' is NOT flagged as internal-hostname", () => {
  const r = scanRedactable("run this in a local dev environment, not production");
  assert.ok(!r.findings.find(f => f.kind === "internal-hostname"), `should not flag bare 'local'; got ${JSON.stringify(r.findings)}`);
});

test("scanRedactable: 'localhost' is NOT flagged as internal-hostname", () => {
  const r = scanRedactable("connect to localhost:5432 for local Postgres");
  assert.ok(!r.findings.find(f => f.kind === "internal-hostname"), `should not flag localhost; got ${JSON.stringify(r.findings)}`);
});

test("scanRedactable: internal hostname uppercase TLD (.INTERNAL) is detected", () => {
  const r = scanRedactable("connect to redis.INTERNAL for caching");
  assert.ok(r.findings.find(f => f.kind === "internal-hostname"), `expected internal-hostname for uppercase; got ${JSON.stringify(r.findings)}`);
});

test("scanRedactable: long Password= value is NOT double-reported as high-entropy-string", () => {
  const longPwd = "Password=xK9mP2qR5tN8wJ3vA6hL1cE4fB7sD0y";
  const r = scanRedactable(longPwd);
  const pwdFindings = r.findings.filter(f => f.kind === "conn-string-password");
  const entropyFindings = r.findings.filter(f => f.kind === "high-entropy-string");
  assert.equal(pwdFindings.length, 1, `expected exactly 1 conn-string-password; got ${JSON.stringify(r.findings)}`);
  assert.equal(entropyFindings.length, 0, `entropy scanner double-reported the password value; got ${JSON.stringify(r.findings)}`);
});
