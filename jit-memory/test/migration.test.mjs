// Tests for lib/migrate.mjs.
//
// Strategy: most scenarios call `_runMigrationForTests({ legacy, newPath, dataRoot })`
// directly with temp dirs so we can exercise every state machine branch
// without touching the real homedir. A small set of scenarios spawns a child
// node process with HOME/USERPROFILE overridden and the JITMEM env vars
// unset, to verify that `migrateKnowledgeIfNeeded()` honours the production
// resolution rules end-to-end.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, lstat, symlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { promises as fsp, constants as fsc } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PATHS_MJS_URL   = pathToFileURL(join(__filename, "..", "..", "lib", "paths.mjs")).href;
const MIGRATE_MJS_URL = pathToFileURL(join(__filename, "..", "..", "lib", "migrate.mjs")).href;

// We'll set JITMEM_EXT_ROOT early so paths.mjs is happy when migrate.mjs
// loads (paths.mjs imports occur during migrate.mjs import). The migrator's
// internal _runMigrationForTests path takes explicit roots and is unaffected.
const _shim = await mkdtemp(join(tmpdir(), "jitmem-migrate-shim-"));
process.env.JITMEM_EXT_ROOT = _shim;
process.env.JITMEM_INSTRUCTIONS_MD = join(_shim, "copilot-instructions.md");
await mkdir(join(_shim, "knowledge"), { recursive: true });

const {
  _runMigrationForTests,
  _setMigrateTestHooks,
  hasUserContent,
  findStagingDirs,
  removeInfraOnly,
  isMigrationBlockingResult
} = await import("../lib/migrate.mjs");

async function makeRoots() {
  const root = await mkdtemp(join(tmpdir(), "jitmem-mig-"));
  const data = join(root, "data");          // ~/.copilot/jit-memory/
  const newPath = join(data, "knowledge");  // new KNOWLEDGE_ROOT
  const ext  = join(root, "ext");           // ~/.copilot/extensions/jit-memory/
  const legacy = join(ext, "knowledge");    // LEGACY_KNOWLEDGE_ROOT
  await mkdir(data, { recursive: true });
  await mkdir(ext,  { recursive: true });
  return { root, dataRoot: data, newPath, legacy, ext };
}

async function exists(p) {
  try { await stat(p); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; }
}

async function seedLegacy(legacy, files = { "git.md": "---\ndomain: git\n---\nbody\n" }) {
  await mkdir(legacy, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const full = join(legacy, name);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }
}

// ─── classifier ─────────────────────────────────────────────────────────────

test("hasUserContent: missing → false", async () => {
  const r = await mkdtemp(join(tmpdir(), "jitmem-empty-"));
  await rm(r, { recursive: true });
  assert.equal(await hasUserContent(r), false);
});

test("hasUserContent: empty dir → false", async () => {
  const r = await mkdtemp(join(tmpdir(), "jitmem-empty-"));
  assert.equal(await hasUserContent(r), false);
});

test("hasUserContent: only infra files → false", async () => {
  const r = await mkdtemp(join(tmpdir(), "jitmem-infra-"));
  await writeFile(join(r, "_routing.json"), "{}");
  await writeFile(join(r, "_jit-memory.log"), "");
  await writeFile(join(r, "MIGRATED.txt"), "");
  await writeFile(join(r, "_curator-digest.md"), "");
  await writeFile(join(r, "_routing.json.lock"), "");
  await writeFile(join(r, ".tmp-_routing.json.123"), "");
  await writeFile(join(r, ".DS_Store"), "");
  assert.equal(await hasUserContent(r), false);
});

test("hasUserContent: a single .md → true", async () => {
  const r = await mkdtemp(join(tmpdir(), "jitmem-user-"));
  await writeFile(join(r, "git.md"), "---\ndomain: git\n---\n");
  assert.equal(await hasUserContent(r), true);
});

test("hasUserContent: nested .md under protocols/ → true", async () => {
  const r = await mkdtemp(join(tmpdir(), "jitmem-proto-"));
  await mkdir(join(r, "protocols"), { recursive: true });
  await writeFile(join(r, "protocols", "x.md"), "---\ndomain: x\n---\n");
  assert.equal(await hasUserContent(r), true);
});

test("hasUserContent: empty protocols/ + empty _archive/ + log only → false", async () => {
  const r = await mkdtemp(join(tmpdir(), "jitmem-emptysubs-"));
  await mkdir(join(r, "protocols"), { recursive: true });
  await mkdir(join(r, "_archive"),  { recursive: true });
  await writeFile(join(r, "_jit-memory.log"), "");
  assert.equal(await hasUserContent(r), false);
});

// ─── findStagingDirs ────────────────────────────────────────────────────────

test("findStagingDirs returns sorted matching dirs", async () => {
  const data = await mkdtemp(join(tmpdir(), "jitmem-stage-"));
  await mkdir(join(data, "knowledge.migrating-2-foo"));
  await mkdir(join(data, "knowledge.migrating-1-bar"));
  await mkdir(join(data, "other"));
  const found = await findStagingDirs(data);
  assert.equal(found.length, 2);
  assert.ok(found[0].endsWith("knowledge.migrating-1-bar"));
});

test("findStagingDirs ENOENT returns []", async () => {
  const data = join(tmpdir(), "jitmem-staging-doesnotexist-" + Date.now());
  assert.deepEqual(await findStagingDirs(data), []);
});

// ─── removeInfraOnly ────────────────────────────────────────────────────────

test("removeInfraOnly clears infra files and empty subdirs and rmdirs root", async () => {
  const r = await mkdtemp(join(tmpdir(), "jitmem-removeInfra-"));
  await mkdir(join(r, "protocols"));
  await mkdir(join(r, "_archive"));
  await writeFile(join(r, "_routing.json"), "{}");
  await writeFile(join(r, "_jit-memory.log"), "");
  await removeInfraOnly(r);
  assert.equal(await exists(r), false);
});

test("removeInfraOnly preserves user content and leaves dir alive", async () => {
  const r = await mkdtemp(join(tmpdir(), "jitmem-removeInfra-keep-"));
  await writeFile(join(r, "_routing.json"), "{}");
  await writeFile(join(r, "git.md"), "---\ndomain: git\n---\n");
  await removeInfraOnly(r);
  assert.equal(await exists(r), true);
  assert.equal(await exists(join(r, "_routing.json")), false);
  assert.equal(await exists(join(r, "git.md")), true);
});

// ─── _runMigrationForTests scenarios ────────────────────────────────────────

test("scenario: legacy populated, new missing → migrated; idempotent on re-run; breadcrumb written", async () => {
  const { dataRoot, newPath, legacy, ext } = await makeRoots();
  await seedLegacy(legacy, { "git.md": "g", "protocols/p.md": "p" });
  const r1 = await _runMigrationForTests({ legacy, newPath, dataRoot });
  assert.equal(r1.status, "migrated");
  assert.equal(r1.fileCount, 2);
  assert.equal(await exists(join(newPath, "git.md")), true);
  assert.equal(await exists(join(newPath, "protocols", "p.md")), true);
  assert.equal(await exists(legacy), false);
  // Breadcrumb sibling under the legacy parent.
  assert.equal(await exists(join(ext, "knowledge.MIGRATED.txt")), true);
  // Idempotent
  const r2 = await _runMigrationForTests({ legacy, newPath, dataRoot });
  assert.equal(r2.status, "already_migrated");
});

test("scenario: new populated, legacy empty → already_migrated", async () => {
  const { dataRoot, newPath, legacy } = await makeRoots();
  await mkdir(newPath, { recursive: true });
  await writeFile(join(newPath, "git.md"), "g");
  const r = await _runMigrationForTests({ legacy, newPath, dataRoot });
  assert.equal(r.status, "already_migrated");
});

test("scenario: both populated → collision; blocking", async () => {
  const { dataRoot, newPath, legacy } = await makeRoots();
  await seedLegacy(legacy, { "old.md": "o" });
  await mkdir(newPath, { recursive: true });
  await writeFile(join(newPath, "new.md"), "n");
  const r = await _runMigrationForTests({ legacy, newPath, dataRoot });
  assert.equal(r.status, "collision");
  assert.equal(isMigrationBlockingResult(r), true);
  assert.equal(await exists(join(newPath, "new.md")), true);
  assert.equal(await exists(join(legacy, "old.md")), true);
});

test("scenario: neither exists → nothing_to_migrate; new dir created", async () => {
  const { dataRoot, newPath, legacy } = await makeRoots();
  const r = await _runMigrationForTests({ legacy, newPath, dataRoot });
  assert.equal(r.status, "nothing_to_migrate");
  assert.equal(await exists(newPath), true);
});

test("scenario: new infra-only (log file) + legacy populated → migrated", async () => {
  const { dataRoot, newPath, legacy } = await makeRoots();
  await mkdir(newPath, { recursive: true });
  await writeFile(join(newPath, "_jit-memory.log"), "");
  await seedLegacy(legacy, { "git.md": "g" });
  const r = await _runMigrationForTests({ legacy, newPath, dataRoot });
  assert.equal(r.status, "migrated");
  assert.equal(await exists(join(newPath, "git.md")), true);
});

test("scenario: new infra-only with empty protocols/ and _archive/ + legacy populated → migrated", async () => {
  const { dataRoot, newPath, legacy } = await makeRoots();
  await mkdir(join(newPath, "protocols"), { recursive: true });
  await mkdir(join(newPath, "_archive"),  { recursive: true });
  await writeFile(join(newPath, "_jit-memory.log"), "");
  await seedLegacy(legacy, { "git.md": "g" });
  const r = await _runMigrationForTests({ legacy, newPath, dataRoot });
  assert.equal(r.status, "migrated");
});

test("scenario: leftover .tmp-_routing.json file in new + legacy populated → migrated", async () => {
  const { dataRoot, newPath, legacy } = await makeRoots();
  await mkdir(newPath, { recursive: true });
  await writeFile(join(newPath, ".tmp-_routing.json.12345.deadbe"), "");
  await seedLegacy(legacy, { "git.md": "g" });
  const r = await _runMigrationForTests({ legacy, newPath, dataRoot });
  assert.equal(r.status, "migrated");
});

test("scenario: pre-existing knowledge.migrating-stale dir → staging_present (blocking)", async () => {
  const { dataRoot, newPath, legacy } = await makeRoots();
  await mkdir(join(dataRoot, "knowledge.migrating-stale"), { recursive: true });
  await seedLegacy(legacy, { "git.md": "g" });
  const r = await _runMigrationForTests({ legacy, newPath, dataRoot });
  assert.equal(r.status, "staging_present");
  assert.equal(isMigrationBlockingResult(r), true);
  assert.equal(await exists(join(dataRoot, "knowledge.migrating-stale")), true);
  assert.equal(await exists(join(legacy, "git.md")), true);
});

test("scenario: legacy is a symlink → unsupported_topology", async () => {
  // Symlink creation can require admin on some Windows systems; skip if unsupported.
  const { dataRoot, newPath, legacy } = await makeRoots();
  const realDir = join(dataRoot, "_real");
  await mkdir(realDir, { recursive: true });
  try { await symlink(realDir, legacy, "dir"); }
  catch (e) {
    if (process.platform === "win32" && (e.code === "EPERM" || e.code === "EACCES" || e.code === "UNKNOWN")) {
      // Skip when the test runner lacks symlink privilege.
      return;
    }
    throw e;
  }
  const r = await _runMigrationForTests({ legacy, newPath, dataRoot });
  assert.equal(r.status, "unsupported_topology");
});

test("scenario: concurrent migration calls → exactly one performs", async () => {
  const { dataRoot, newPath, legacy } = await makeRoots();
  await seedLegacy(legacy, { "a.md": "a", "b.md": "b" });
  const [r1, r2] = await Promise.all([
    _runMigrationForTests({ legacy, newPath, dataRoot }),
    _runMigrationForTests({ legacy, newPath, dataRoot })
  ]);
  const statuses = [r1.status, r2.status].sort();
  // One performed, the other observed already-migrated state.
  assert.deepEqual(statuses, ["already_migrated", "migrated"]);
  assert.equal(await exists(join(newPath, "a.md")), true);
});

// ─── EXDEV (cross-device) coverage via test hook ────────────────────────────

test("EXDEV: rename rejects EXDEV → copy + verify + preserve legacy succeeds", async () => {
  const { dataRoot, newPath, legacy, ext } = await makeRoots();
  await seedLegacy(legacy, { "git.md": "g", "protocols/p.md": "p" });
  let renameCalls = 0;
  _setMigrateTestHooks({
    rename: async (from, to) => {
      renameCalls++;
      // Only the first rename (legacy → staging) fails with EXDEV.
      if (renameCalls === 1) {
        const e = new Error("simulated cross-device link"); e.code = "EXDEV"; throw e;
      }
    }
  });
  try {
    const r = await _runMigrationForTests({ legacy, newPath, dataRoot });
    assert.equal(r.status, "migrated");
    assert.equal(r.method, "copy");
    assert.equal(await exists(join(newPath, "git.md")), true);
    assert.equal(await exists(join(newPath, "protocols", "p.md")), true);
    // Legacy preserved aside (not deleted).
    const siblings = await readdir(ext);
    assert.ok(siblings.some(n => n.startsWith("knowledge.migrated-")), `expected preserved legacy among ${siblings.join(",")}`);
  } finally {
    _setMigrateTestHooks({});
  }
});

test("EXDEV: copy verification failure → staging removed, legacy intact, retry works", async () => {
  const { dataRoot, newPath, legacy } = await makeRoots();
  await seedLegacy(legacy, { "git.md": "g" });
  _setMigrateTestHooks({
    rename: async () => {
      const e = new Error("simulated EXDEV"); e.code = "EXDEV"; throw e;
    },
    copyDir: async (src, dst) => {
      // Simulate a corrupt copy: copy the dir then truncate the file.
      await fsp.cp(src, dst, { recursive: true });
      await fsp.writeFile(join(dst, "git.md"), "DIFFERENT");
    }
  });
  try {
    const r = await _runMigrationForTests({ legacy, newPath, dataRoot });
    assert.equal(r.status, "verify_failed");
    // Legacy left intact.
    assert.equal(await exists(join(legacy, "git.md")), true);
    // Staging cleaned up.
    const stagings = await findStagingDirs(dataRoot);
    assert.equal(stagings.length, 0);
  } finally {
    _setMigrateTestHooks({});
  }
  // Retry without the hook should succeed.
  const r2 = await _runMigrationForTests({ legacy, newPath, dataRoot });
  assert.equal(r2.status, "migrated");
});

test("EXDEV: pre-existing preserved-legacy sibling does not block migration", async () => {
  const { dataRoot, newPath, legacy, ext } = await makeRoots();
  await seedLegacy(legacy, { "git.md": "g" });
  // Pre-existing preserved-legacy directory at the predictable name.
  const ts = "fixed";
  // Create both the timestamped and a -2 sibling to force uniquePath through retry.
  await mkdir(join(ext, "knowledge.migrated-occupied"), { recursive: true });
  _setMigrateTestHooks({
    rename: async (from, to) => {
      // Force EXDEV on first call only.
      if (!from.includes("knowledge.migrating-")) {
        const e = new Error("simulated EXDEV"); e.code = "EXDEV"; throw e;
      }
    }
  });
  try {
    const r = await _runMigrationForTests({ legacy, newPath, dataRoot });
    assert.equal(r.status, "migrated");
    // Pre-existing sibling untouched.
    assert.equal(await exists(join(ext, "knowledge.migrated-occupied")), true);
  } finally {
    _setMigrateTestHooks({});
  }
});

test("post-staging error includes staging path for recovery", async () => {
  const { dataRoot, newPath, legacy } = await makeRoots();
  await seedLegacy(legacy, { "git.md": "g" });
  let renameCalls = 0;
  _setMigrateTestHooks({
    rename: async (from, to) => {
      renameCalls++;
      // 1st: legacy → staging (let real rename happen).
      // 2nd: staging → newPath (final). Throw a non-race error to simulate.
      if (renameCalls === 2) {
        const e = new Error("simulated final rename failure"); e.code = "EIO"; throw e;
      }
    }
  });
  try {
    const r = await _runMigrationForTests({ legacy, newPath, dataRoot });
    assert.equal(r.status, "error");
    assert.match(r.error || "", /final rename/);
    assert.ok(r.staging, `expected staging path in error result: ${JSON.stringify(r)}`);
  } finally {
    _setMigrateTestHooks({});
  }
});

// ─── path precedence (child-process tests) ──────────────────────────────────

function nodeWith(envExtra, scriptBody) {
  const env = { ...process.env, ...envExtra };
  // Strip overrides that we want to test the absence of.
  for (const k of Object.keys(envExtra)) {
    if (envExtra[k] === undefined) delete env[k];
  }
  // Build a script that imports paths.mjs and prints JSON.
  const script = `
    import("${PATHS_MJS_URL}")
      .then(m => process.stdout.write(JSON.stringify({
        EXT_ROOT: m.EXT_ROOT,
        KNOWLEDGE_ROOT: m.KNOWLEDGE_ROOT,
        JITMEM_DATA_ROOT: m.JITMEM_DATA_ROOT,
        LEGACY_KNOWLEDGE_ROOT: m.LEGACY_KNOWLEDGE_ROOT,
        PATH_OVERRIDES_ACTIVE: m.PATH_OVERRIDES_ACTIVE
      })))
      .catch(e => { process.stderr.write(String(e)); process.exit(2); });
    ${scriptBody || ""}
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env,
    encoding: "utf8"
  });
  if (r.status !== 0) throw new Error(`child failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test("precedence: JITMEM_KNOWLEDGE_ROOT wins over JITMEM_EXT_ROOT", async () => {
  const fakeKb = await mkdtemp(join(tmpdir(), "jitmem-prec-kb-"));
  const fakeExt = await mkdtemp(join(tmpdir(), "jitmem-prec-ext-"));
  const out = nodeWith({
    JITMEM_KNOWLEDGE_ROOT: fakeKb,
    JITMEM_EXT_ROOT: fakeExt,
    JITMEM_INSTRUCTIONS_MD: undefined
  });
  assert.equal(out.KNOWLEDGE_ROOT, fakeKb);
  assert.equal(out.PATH_OVERRIDES_ACTIVE, true);
});

test("precedence: JITMEM_EXT_ROOT maps KNOWLEDGE_ROOT to ${EXT_ROOT}/knowledge", async () => {
  const fakeExt = await mkdtemp(join(tmpdir(), "jitmem-prec-ext2-"));
  const out = nodeWith({
    JITMEM_KNOWLEDGE_ROOT: undefined,
    JITMEM_EXT_ROOT: fakeExt,
    JITMEM_INSTRUCTIONS_MD: undefined
  });
  assert.equal(out.KNOWLEDGE_ROOT, join(fakeExt, "knowledge"));
  assert.equal(out.PATH_OVERRIDES_ACTIVE, true);
});

test("precedence: neither override → ${HOME}/.copilot/jit-memory/knowledge", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "jitmem-prec-home-"));
  const out = nodeWith({
    JITMEM_KNOWLEDGE_ROOT: undefined,
    JITMEM_EXT_ROOT: undefined,
    JITMEM_INSTRUCTIONS_MD: undefined,
    HOME: fakeHome,
    USERPROFILE: fakeHome
  });
  assert.equal(out.KNOWLEDGE_ROOT, join(fakeHome, ".copilot", "jit-memory", "knowledge"));
  assert.equal(out.PATH_OVERRIDES_ACTIVE, false);
});

test("migrateKnowledgeIfNeeded skipped under JITMEM_EXT_ROOT", async () => {
  const fakeExt = await mkdtemp(join(tmpdir(), "jitmem-skip-ext-"));
  const env = {
    ...process.env,
    JITMEM_EXT_ROOT: fakeExt,
    JITMEM_INSTRUCTIONS_MD: join(fakeExt, "i.md")
  };
  delete env.JITMEM_KNOWLEDGE_ROOT;
  const script = `
    const m = await import("${MIGRATE_MJS_URL}");
    const r = await m.migrateKnowledgeIfNeeded();
    process.stdout.write(JSON.stringify(r));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.status, "skipped_override");
});
