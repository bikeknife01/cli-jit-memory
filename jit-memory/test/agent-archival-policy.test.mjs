// Item #7: agent-callable jit_memory_audit must never archive. The schema no
// longer accepts an `archival` argument, and the handler hardcodes
// archivalAllowed=false. Even if a malicious caller passes
// {archival:true}, it must be ignored. Verified at the source-shape level:
// the handler call site cannot reference args.archival.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const src  = await readFile(join(root, "extension.mjs"), "utf8");

test("AUDIT_SCHEMA does not declare an `archival` parameter", () => {
  // Pull out the AUDIT_SCHEMA literal.
  const m = /const\s+AUDIT_SCHEMA\s*=\s*\{[\s\S]*?\};/.exec(src);
  assert.ok(m, "could not find AUDIT_SCHEMA in extension.mjs");
  assert.doesNotMatch(m[0], /archival/i,
    "AUDIT_SCHEMA must not advertise an `archival` parameter to agents (item #7)");
});

test("agent jit_memory_audit handler hardcodes archivalAllowed:false", () => {
  // Match the audit tool registration block.
  const block = /name:\s*"jit_memory_audit"[\s\S]*?\}\s*,\s*\n\s*\{/.exec(src);
  assert.ok(block, "could not find jit_memory_audit tool block");
  assert.match(block[0], /archivalAllowed:\s*false/);
  assert.doesNotMatch(block[0], /args\.archival/);
});
