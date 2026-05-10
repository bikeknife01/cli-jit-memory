import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = await mkdtemp(join(tmpdir(), "jitmem-utf8-test-"));
process.env.JITMEM_EXT_ROOT = tmp;
process.env.JITMEM_TEST_MODE = "1";
process.env.JITMEM_INSTRUCTIONS_MD = join(tmp, "copilot-instructions.md");

await mkdir(join(tmp, "knowledge"), { recursive: true });

const { utf8ByteLength, truncateUtf8, truncateUtf8AtLineBoundary } = await import("../lib/utf8.mjs");
const paths = await import("../lib/paths.mjs");
const { audit } = await import("../lib/audit.mjs");

test("truncateUtf8 stays within budget without replacement characters", () => {
  const text = "é😀漢字".repeat(20);
  for (let budget = 0; budget < 80; budget++) {
    const out = truncateUtf8(text, budget);
    assert.ok(utf8ByteLength(out) <= budget, `budget ${budget} exceeded`);
    assert.ok(!out.includes("\uFFFD"), `replacement char at budget ${budget}`);
  }
  assert.equal(truncateUtf8("é", 1), "");
});

test("truncateUtf8AtLineBoundary preserves small inputs and line boundary truncates large inputs", () => {
  assert.equal(truncateUtf8AtLineBoundary("small 😀", 20), "small 😀");
  const text = `line one 😀😀😀\nline two 😀😀😀\nline three 😀😀😀`;
  const out = truncateUtf8AtLineBoundary(text, 38);
  assert.ok(utf8ByteLength(out) <= 38);
  assert.ok(out.endsWith("\n\n_(truncated)_\n"));
  assert.ok(!out.includes("line two"), "should cut back to the last full line that fits");
  assert.ok(!out.includes("\uFFFD"));
});

test("truncateUtf8AtLineBoundary handles suffix larger than budget safely", () => {
  const out = truncateUtf8AtLineBoundary("abcdef", 5, { suffix: "😀😀" });
  assert.ok(utf8ByteLength(out) <= 5);
  assert.ok(!out.includes("\uFFFD"));
});

test("audit digest truncation is UTF-8 safe and budget bounded", async () => {
  for (let i = 0; i < 90; i++) {
    const file = join(tmp, "knowledge", `frontmatter-error-😀-${i}.md`);
    await writeFile(file, "---\n{\"domain\": \n---\n", "utf8");
  }
  await rm(paths.DIGEST_MD, { force: true });

  const r = await audit({ archivalAllowed: false });
  assert.equal(r.healthy, false);
  assert.ok(r.digest.includes("_(truncated)_"));
  assert.ok(utf8ByteLength(r.digest) <= 2048);
  assert.ok(!r.digest.includes("\uFFFD"));

  const persisted = await readFile(paths.DIGEST_MD, "utf8");
  assert.equal(persisted, r.digest);
});
