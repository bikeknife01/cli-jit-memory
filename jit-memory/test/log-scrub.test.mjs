// Item #26: log paths are scrubbed to relative form so absolute home
// paths don't leak into _jit-memory.log.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const tmp = await mkdtemp(join(tmpdir(), "jitmem-logscrub-"));
process.env.JITMEM_EXT_ROOT = tmp;
process.env.JITMEM_INSTRUCTIONS_MD = join(tmp, "copilot-instructions.md");
await mkdir(join(tmp, "knowledge"), { recursive: true });

const { _scrubPathForTests, logEvent, _LOG_PATH_FOR_TESTS } = await import("../lib/jitlog.mjs");

test("scrubPath converts a path under KNOWLEDGE_ROOT to <knowledge>/...", () => {
  const r = _scrubPathForTests(join(tmp, "knowledge", "foo.md"));
  assert.match(r, /^<knowledge>[\\/]+foo\.md$/);
});

test("scrubPath converts a path under HOME to <home>/...", () => {
  const r = _scrubPathForTests(join(homedir(), "some-other-folder", "x"));
  assert.ok(r.startsWith("<home>"), `got ${r}`);
});

test("scrubPath leaves non-absolute strings alone", () => {
  assert.equal(_scrubPathForTests("just text"), "just text");
});

test("logEvent writes scrubbed paths into the log", async () => {
  await logEvent("test_event", {
    file: join(tmp, "knowledge", "thing.md"),
    home: join(homedir(), "anything"),
    plain: "no-path-here"
  });
  const log = await readFile(_LOG_PATH_FOR_TESTS, "utf8");
  assert.match(log, /file=/);
  assert.match(log, /<knowledge>/);
  assert.doesNotMatch(log, new RegExp(tmp.replace(/[\\/]/g, "[\\\\/]")));  // raw tmp not present
});
