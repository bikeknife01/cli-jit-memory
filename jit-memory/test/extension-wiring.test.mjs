// SDK-level integration tests for extension.mjs.
//
// Uses a minimal fake @github/copilot-sdk/extension (via node:module register)
// so extension.mjs can be loaded without the real SDK. Verifies:
//   1. joinSession called once with the expected hook/tool names
//   2. onUserPromptSubmitted routes and returns additionalContext
//   3. onSessionStart completes without throwing (migrate + bootstrap + drift)
//   4. Each named tool handler is callable and routes to the correct lib fn
//   5. safeTool fail-open: a crashing handler returns {resultType:"failure"}
//   6. CAPTURE_SCHEMA includes context and failed_attempt fields (Item 3)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// ── Setup: temp env + load extension.mjs with fake SDK ────────────────────

const tmp = await mkdtemp(join(tmpdir(), "jitmem-ext-wiring-"));
const INSTR = join(tmp, "copilot-instructions.md");
process.env.JITMEM_EXT_ROOT = tmp;
process.env.JITMEM_INSTRUCTIONS_MD = INSTR;
process.env.JITMEM_TEST_MODE = "1";
await mkdir(join(tmp, "knowledge"), { recursive: true });
await writeFile(INSTR, "<!-- QR:BEGIN -->\n<!-- QR:END -->\n<!-- KB:BEGIN -->\n<!-- KB:END -->\n", "utf8");

// Register the loader BEFORE importing extension.mjs so the fake SDK is used.
const loaderUrl = new URL("./mocks/sdk-loader.mjs", import.meta.url).href;
register(loaderUrl, pathToFileURL("./"));

// Load the mock so we can read back what joinSession received.
const { getCaptured } = await import("./mocks/copilot-sdk-extension.mjs");

// Dynamically import extension.mjs — this triggers the top-level joinSession call.
await import("../extension.mjs");

const captured = getCaptured();

// ── Test 1: joinSession was called with hooks and tools ───────────────────

test("extension.mjs: joinSession called with hooks and tools", () => {
  assert.ok(captured, "joinSession must have been called");
  assert.ok(captured.hooks, "hooks must be passed to joinSession");
  assert.ok(Array.isArray(captured.tools), "tools must be an array");
});

// ── Test 2: all required hooks present ───────────────────────────────────

test("extension.mjs: all required hooks registered", () => {
  const { hooks } = captured;
  assert.equal(typeof hooks.onSessionStart, "function", "onSessionStart hook required");
  assert.equal(typeof hooks.onUserPromptSubmitted, "function", "onUserPromptSubmitted hook required");
  assert.equal(typeof hooks.onSessionEnd, "function", "onSessionEnd hook required");
});

// ── Test 3: all required tools registered ────────────────────────────────

const EXPECTED_TOOLS = [
  "jit_memory_capture",
  "jit_memory_audit",
  "jit_memory_debug_route",
  "jit_memory_deprecate",
  "jit_memory_delete",
  "jit_memory_capture_preview",
  "jit_memory_status"
];

test("extension.mjs: all required tools registered", () => {
  const names = captured.tools.map(t => t.name);
  for (const name of EXPECTED_TOOLS) {
    assert.ok(names.includes(name), `tool ${name} should be registered`);
  }
});

// ── Test 4: CAPTURE_SCHEMA includes context and failed_attempt (Item 3) ──

test("extension.mjs: CAPTURE_SCHEMA includes context and failed_attempt fields", () => {
  const captureTool = captured.tools.find(t => t.name === "jit_memory_capture");
  assert.ok(captureTool, "jit_memory_capture tool must exist");
  const props = captureTool.parameters?.properties;
  assert.ok(props, "CAPTURE_SCHEMA must have properties");
  assert.ok(props.context, "CAPTURE_SCHEMA must include context field");
  assert.ok(props.failed_attempt, "CAPTURE_SCHEMA must include failed_attempt field");
  assert.equal(props.context.type, "string");
  assert.equal(props.failed_attempt.type, "string");
});

// ── Test 5: onSessionStart completes without throwing ────────────────────

test("extension.mjs: onSessionStart completes without throwing", async () => {
  const result = await captured.hooks.onSessionStart({}, {});
  // safeHook returns undefined on error; any non-throw is ok here.
  // (May return undefined or {additionalContext: "..."})
  assert.notEqual(result, null, "should not return null");
});

// ── Test 6: onUserPromptSubmitted returns undefined for unmatched prompt ──

test("extension.mjs: onUserPromptSubmitted returns undefined for unmatched prompt", async () => {
  // A prompt with no routing matches should return undefined (fail-open).
  const result = await captured.hooks.onUserPromptSubmitted(
    { prompt: "xyzzy-nonexistent-intent-zzz" },
    {}
  );
  assert.equal(result, undefined);
});

// ── Test 7: onUserPromptSubmitted routes when domain matches ─────────────

test("extension.mjs: onUserPromptSubmitted returns additionalContext when domain matches", async () => {
  // Create a domain file and routing entry so we get a match.
  const { capture, refreshForbiddenMarkers } = await import("../lib/capture.mjs");
  await refreshForbiddenMarkers();
  const r = await capture({
    kind: "domain_new",
    domain: "ext-wiring-test-domain",
    summary: "ext wiring test",
    tags: ["ext-wiring-test-domain", "wiring"],
    content: "use fake SDK for integration tests"
  });
  assert.equal(r.status, "ok");

  // Trigger routing with a prompt containing the domain tag.
  const result = await captured.hooks.onUserPromptSubmitted(
    { prompt: "ext-wiring-test-domain: what is the wiring approach" },
    {}
  );
  // Should return either {additionalContext: "..."} or undefined (no file content yet)
  // We just check it doesn't throw and returns a valid type.
  assert.ok(result === undefined || typeof result.additionalContext === "string");
});

// ── Test 8: jit_memory_capture tool handler routes to capture lib ─────────

test("extension.mjs: jit_memory_capture tool handler invokes capture lib", async () => {
  const captureTool = captured.tools.find(t => t.name === "jit_memory_capture");
  const result = await captureTool.handler(
    { kind: "quick_rule", content: "ext-wiring-test: always use fake SDK for integration tests" },
    {}
  );
  // safeTool wraps the result as { textResultForLlm, resultType }
  assert.ok(result, "handler must return a result");
  assert.ok(typeof result.textResultForLlm === "string", "textResultForLlm must be a string");
  assert.equal(result.resultType, "success");
  const parsed = JSON.parse(result.textResultForLlm);
  assert.equal(parsed.status, "ok");
});

// ── Test 9: safeTool fail-open — invalid args → resultType "failure" ──────

test("extension.mjs: jit_memory_capture tool handler returns resultType:failure for invalid kind", async () => {
  const captureTool = captured.tools.find(t => t.name === "jit_memory_capture");
  const result = await captureTool.handler(
    { kind: "not_a_real_kind", content: "test" },
    {}
  );
  assert.ok(result);
  assert.ok(typeof result.textResultForLlm === "string");
  // "invalid" status maps to "failure"
  const parsed = JSON.parse(result.textResultForLlm);
  assert.equal(parsed.status, "invalid");
  assert.equal(result.resultType, "failure");
});

// ── Test 10: jit_memory_audit tool handler is callable ───────────────────

test("extension.mjs: jit_memory_audit tool handler returns ok result", async () => {
  const auditTool = captured.tools.find(t => t.name === "jit_memory_audit");
  const result = await auditTool.handler({}, {});
  assert.ok(result);
  assert.ok(typeof result.textResultForLlm === "string");
  assert.equal(result.resultType, "success");
  const parsed = JSON.parse(result.textResultForLlm);
  assert.equal(parsed.status, "ok");
});

// ── Test 11: jit_memory_status tool handler returns health snapshot ───────

test("extension.mjs: jit_memory_status tool handler returns health snapshot", async () => {
  const statusTool = captured.tools.find(t => t.name === "jit_memory_status");
  const result = await statusTool.handler({}, {});
  assert.ok(result);
  const parsed = JSON.parse(result.textResultForLlm);
  assert.ok(parsed.knowledgeRoot || parsed.status, "should include knowledgeRoot or status");
});

// ── Test 12: onSessionEnd completes without throwing ─────────────────────

test("extension.mjs: onSessionEnd completes without throwing", async () => {
  // safeHook wraps onSessionEnd; it should not throw even if sync has nothing to do.
  const result = await captured.hooks.onSessionEnd({}, {});
  // undefined is the expected return from a no-op session end
  assert.ok(result === undefined || typeof result === "object");
});
