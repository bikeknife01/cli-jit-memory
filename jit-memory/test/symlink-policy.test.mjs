import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = await mkdtemp(join(tmpdir(), "jitmem-symlink-test-"));
process.env.JITMEM_EXT_ROOT = tmp;
process.env.JITMEM_TEST_MODE = "1";
process.env.JITMEM_INSTRUCTIONS_MD = join(tmp, "copilot-instructions.md");

const knowledge = join(tmp, "knowledge");
const outside = join(tmp, "outside");
await mkdir(knowledge, { recursive: true });
await mkdir(outside, { recursive: true });
await writeFile(
  process.env.JITMEM_INSTRUCTIONS_MD,
  "# header\n<!-- QR:BEGIN -->\n<!-- QR:END -->\n<!-- KB:BEGIN -->\n<!-- KB:END -->\n",
  "utf8"
);

const { capture } = await import("../lib/capture.mjs");
const { route } = await import("../lib/router.mjs");
const { assertRoutableKnowledgeFile, assertRoutableKnowledgeFileAsync } = await import("../lib/paths.mjs");

function fmFile(meta, body = "body\n") {
  return `---\n${JSON.stringify(meta, null, 2)}\n---\n${body}`;
}

async function trySymlink(target, path, type, t) {
  try {
    await symlink(target, path, type);
    return true;
  } catch (e) {
    t.skip(`symlink creation unavailable: ${e.code || e.message}`);
    return false;
  }
}

test("routing and capture refuse a symlinked markdown file under knowledge", async (t) => {
  const outsideFile = join(outside, "linked.md");
  const linkPath = join(knowledge, "linked.md");
  const original = fmFile({
    domain: "linked", kind: "fact", summary: "outside",
    tags: ["linked"], aliases: [], see_also: [], verified: "2026-05-09", deprecated: null
  }, "# Outside\n\n## Working\n\n- original\n");
  await writeFile(outsideFile, original, "utf8");
  if (!await trySymlink(outsideFile, linkPath, "file", t)) return;

  assert.throws(
    () => assertRoutableKnowledgeFile(linkPath),
    /symlink not allowed under knowledge root/i
  );
  await assert.rejects(
    () => assertRoutableKnowledgeFileAsync(linkPath),
    /symlink not allowed under knowledge root/i
  );

  const r = await capture({
    kind: "domain_update",
    domain: "linked",
    section: "working",
    content: "should not write through symlink"
  });
  assert.equal(r.status, "invalid_setup");
  assert.match(r.summary, /symlink not allowed/i);
  assert.equal(await readFile(outsideFile, "utf8"), original);
});

test("routing refuses paths below a symlinked parent directory under knowledge", async (t) => {
  const outsideDir = join(outside, "linked-parent");
  const linkDir = join(knowledge, "linked-parent");
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(outsideDir, "outside.md"), "outside\n", "utf8");
  if (!await trySymlink(outsideDir, linkDir, "dir", t)) return;

  assert.throws(
    () => assertRoutableKnowledgeFile(join(linkDir, "outside.md")),
    /symlink not allowed under knowledge root/i
  );
  await assert.rejects(
    () => assertRoutableKnowledgeFileAsync(join(linkDir, "outside.md")),
    /symlink not allowed under knowledge root/i
  );

  const table = {
    version: 3,
    domains: [
      { domain: "parentlink", file_rel: "linked-parent/outside.md", tags: ["parentlink"], summary: "bad" }
    ]
  };
  assert.deepEqual(route("parentlink", table), []);
});

test("routing refuses symlinks even when the target stays inside knowledge", async (t) => {
  const realFile = join(knowledge, "real.md");
  const linkFile = join(knowledge, "inside-link.md");
  await writeFile(realFile, "real\n", "utf8");
  if (!await trySymlink(realFile, linkFile, "file", t)) return;

  assert.throws(
    () => assertRoutableKnowledgeFile(linkFile),
    /symlink not allowed under knowledge root/i
  );
  await assert.rejects(
    () => assertRoutableKnowledgeFileAsync(linkFile),
    /symlink not allowed under knowledge root/i
  );

  const r = await capture({
    kind: "domain_update",
    domain: "inside-link",
    section: "working",
    content: "should not write through internal symlink"
  });
  assert.equal(r.status, "invalid_setup");
  assert.match(r.summary, /symlink not allowed/i);
});
