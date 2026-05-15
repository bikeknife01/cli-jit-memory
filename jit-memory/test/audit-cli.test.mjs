import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const { runAuditCli } = await import("../audit.mjs");

function streamCapture() {
  let text = "";
  return {
    stream: { write: chunk => { text += String(chunk); } },
    get text() { return text; }
  };
}

test("runAuditCli reports healthy success after drain", async () => {
  const stdout = streamCapture();
  const stderr = streamCapture();
  let drained = false;

  const code = await runAuditCli({
    auditFn: async () => ({ healthy: true }),
    drainFn: async () => { drained = true; },
    migrateFn: async () => ({ status: "skipped_override" }),
    stdout: stdout.stream,
    stderr: stderr.stream
  });

  assert.equal(code, 0);
  assert.equal(drained, true);
  assert.equal(stdout.text, "jit-memory: healthy\n");
  assert.equal(stderr.text, "");
});

test("runAuditCli reports digest success with archive count", async () => {
  const stdout = streamCapture();
  const code = await runAuditCli({
    auditFn: async () => ({ healthy: false, archived: [{ from: "old.md" }, { from: "older.md" }] }),
    drainFn: async () => {},
    migrateFn: async () => ({ status: "skipped_override" }),
    stdout: stdout.stream,
    stderr: streamCapture().stream
  });

  assert.equal(code, 0);
  assert.equal(stdout.text, "jit-memory: digest written; archived 2\n");
});

test("runAuditCli distinguishes audit failure from drain failure", async () => {
  const stdout = streamCapture();
  const stderr = streamCapture();

  const code = await runAuditCli({
    auditFn: async () => { throw new Error("frontmatter exploded"); },
    drainFn: async () => { throw new Error("must not run"); },
    migrateFn: async () => ({ status: "skipped_override" }),
    stdout: stdout.stream,
    stderr: stderr.stream
  });

  assert.equal(code, 1);
  assert.equal(stdout.text, "");
  assert.match(stderr.text, /jit-memory audit failed:/);
  assert.match(stderr.text, /frontmatter exploded/);
  assert.doesNotMatch(stderr.text, /post-audit sync drain/);
});

test("runAuditCli reports post-audit drain failure after audit succeeds", async () => {
  const stdout = streamCapture();
  const stderr = streamCapture();

  const code = await runAuditCli({
    auditFn: async () => ({ healthy: true }),
    drainFn: async () => { throw new Error("drain timeout"); },
    migrateFn: async () => ({ status: "skipped_override" }),
    stdout: stdout.stream,
    stderr: stderr.stream
  });

  assert.equal(code, 1);
  assert.equal(stdout.text, "");
  assert.match(stderr.text, /audit completed but post-audit sync drain failed/);
  assert.match(stderr.text, /drain timeout/);
  assert.doesNotMatch(stderr.text, /jit-memory audit failed:/);
});

test("runAuditCli refuses with code 2 when migration is blocked", async () => {
  const stdout = streamCapture();
  const stderr = streamCapture();
  let auditRan = false;
  const code = await runAuditCli({
    auditFn: async () => { auditRan = true; return { healthy: true }; },
    drainFn: async () => {},
    migrateFn: async () => ({ status: "collision", legacy: "/x", new: "/y" }),
    stdout: stdout.stream,
    stderr: stderr.stream
  });
  assert.equal(code, 2);
  assert.equal(auditRan, false);
  assert.match(stderr.text, /knowledge migration unresolved/);
  assert.match(stderr.text, /collision/);
});

test("audit.mjs production entry exits 0 and writes healthy output", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "jitmem-audit-cli-smoke-"));
  const instructions = join(tmp, "copilot-instructions.md");
  await mkdir(join(tmp, "knowledge"), { recursive: true });
  await writeFile(instructions, "<!-- QR:BEGIN -->\n<!-- QR:END -->\n<!-- KB:BEGIN -->\n<!-- KB:END -->\n", "utf8");

  try {
    const result = await spawnNodeAudit({
      JITMEM_EXT_ROOT: tmp,
      JITMEM_INSTRUCTIONS_MD: instructions,
      JITMEM_TEST_MODE: "1"
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /jit-memory: healthy/);
    assert.match(result.stderr, /path overrides active/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

async function spawnNodeAudit(env = {}) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [resolve("audit.mjs")], {
      cwd: resolve("."),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", code => resolvePromise({ code, stdout, stderr }));
  });
}
