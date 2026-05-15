// Path constants and safe path resolution for jit-memory.
// Every filesystem write goes through resolveUnderKnowledge() to prevent
// path traversal even with a misbehaving model.

import { fileURLToPath } from "node:url";
import { dirname, resolve, join, sep, normalize, isAbsolute, relative } from "node:path";
import { homedir } from "node:os";
import { promises as fs, lstatSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// Path resolution for jit-memory.
//
// In production (no env overrides), user knowledge data lives OUTSIDE the
// extension folder so a "delete and re-copy" upgrade does not destroy it:
//
//   ${homedir()}/.copilot/jit-memory/knowledge/
//
// Legacy installs co-located knowledge under the extension folder
// (${EXT_ROOT}/knowledge); the migrator at lib/migrate.mjs moves that data
// into the new home on first run.
//
// Resolution precedence (highest first):
//   1. JITMEM_KNOWLEDGE_ROOT — direct override of KNOWLEDGE_ROOT (for tests
//      and advanced users). Migrator is skipped.
//   2. JITMEM_EXT_ROOT — extension-root override (existing test-only env var).
//      KNOWLEDGE_ROOT is computed as ${EXT_ROOT}/knowledge so existing tests
//      continue to operate on co-located data. Migrator is skipped.
//   3. (production default) ${homedir()}/.copilot/jit-memory/knowledge/.
//
// A stderr warning fires whenever any override is active so it's never silent
// in production.
const _EXT_ROOT_OVERRIDE = process.env.JITMEM_EXT_ROOT
  ? resolve(process.env.JITMEM_EXT_ROOT)
  : null;
const _KNOWLEDGE_ROOT_OVERRIDE = process.env.JITMEM_KNOWLEDGE_ROOT
  ? resolve(process.env.JITMEM_KNOWLEDGE_ROOT)
  : null;
const _INSTRUCTIONS_OVERRIDE = process.env.JITMEM_INSTRUCTIONS_MD
  ? resolve(process.env.JITMEM_INSTRUCTIONS_MD)
  : null;
if (_EXT_ROOT_OVERRIDE || _KNOWLEDGE_ROOT_OVERRIDE || _INSTRUCTIONS_OVERRIDE) {
  // stderr is safe — the SDK only reserves stdout for JSON-RPC.
  process.stderr.write(
    `[jit-memory] WARNING: path overrides active ` +
    `(JITMEM_EXT_ROOT=${_EXT_ROOT_OVERRIDE ?? "<unset>"}, ` +
    `JITMEM_KNOWLEDGE_ROOT=${_KNOWLEDGE_ROOT_OVERRIDE ?? "<unset>"}, ` +
    `JITMEM_INSTRUCTIONS_MD=${_INSTRUCTIONS_OVERRIDE ?? "<unset>"}). ` +
    `These are test-only — unset them in production environments.\n`
  );
}

export const EXT_ROOT       = _EXT_ROOT_OVERRIDE ?? resolve(__dirname, "..");

// Production data root: ~/.copilot/jit-memory/.
// Legacy data lived inside the extension folder.
function _resolveKnowledgeRoot() {
  if (_KNOWLEDGE_ROOT_OVERRIDE) return _KNOWLEDGE_ROOT_OVERRIDE;
  if (_EXT_ROOT_OVERRIDE)       return join(_EXT_ROOT_OVERRIDE, "knowledge");
  return join(homedir(), ".copilot", "jit-memory", "knowledge");
}
export const KNOWLEDGE_ROOT      = _resolveKnowledgeRoot();
export const JITMEM_DATA_ROOT    = dirname(KNOWLEDGE_ROOT);
export const LEGACY_KNOWLEDGE_ROOT = join(EXT_ROOT, "knowledge");

// True when neither knowledge-root override is set, i.e. production resolution
// is in effect and the migrator may run. The migrator MUST consult this; tests
// using JITMEM_EXT_ROOT or JITMEM_KNOWLEDGE_ROOT do not perform migration.
export const PATH_OVERRIDES_ACTIVE = !!(_EXT_ROOT_OVERRIDE || _KNOWLEDGE_ROOT_OVERRIDE);

export const ARCHIVE_DIR    = join(KNOWLEDGE_ROOT, "_archive");
export const PROTOCOLS_DIR  = join(KNOWLEDGE_ROOT, "protocols");

export const ROUTING_JSON = join(KNOWLEDGE_ROOT, "_routing.json");
export const USAGE_JSON   = join(KNOWLEDGE_ROOT, "_usage.json");
export const DIGEST_MD    = join(KNOWLEDGE_ROOT, "_curator-digest.md");

// User's instructions file. Resolvable cross-platform via os.homedir().
export const INSTRUCTIONS_MD = _INSTRUCTIONS_OVERRIDE ?? join(homedir(), ".copilot", "copilot-instructions.md");

// Slug = lowercase letters/digits/underscore/hyphen, 1–64 chars, leading alnum.
// Lowercase only — eliminates case-sensitivity surprises across platforms.
export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Windows reserved device names. Case-insensitive. Reject as slugs.
const WIN_RESERVED = new Set([
  "con","prn","aux","nul",
  "com1","com2","com3","com4","com5","com6","com7","com8","com9",
  "lpt1","lpt2","lpt3","lpt4","lpt5","lpt6","lpt7","lpt8","lpt9"
]);

export function isValidSlug(slug) {
  if (typeof slug !== "string") return false;
  if (!SLUG_RE.test(slug)) return false;
  if (WIN_RESERVED.has(slug)) return false;
  return true;
}

// Build the absolute path for a domain file, given a slug. Validates slug.
// Optional subdir (must be one of "" or "protocols"). No traversal possible.
export function resolveDomainFile(slug, { subdir = "" } = {}) {
  if (!isValidSlug(slug)) {
    throw new Error(`invalid slug: ${JSON.stringify(slug)}`);
  }
  if (subdir && subdir !== "protocols") {
    throw new Error(`invalid subdir: ${JSON.stringify(subdir)}`);
  }
  const base = subdir ? join(KNOWLEDGE_ROOT, subdir) : KNOWLEDGE_ROOT;
  const target = join(base, `${slug}.md`);
  assertUnderKnowledge(target);
  return target;
}

// Throws unless absPath is strictly within KNOWLEDGE_ROOT.
export function assertUnderKnowledge(absPath) {
  if (!isAbsolute(absPath)) {
    throw new Error(`not absolute: ${absPath}`);
  }
  const norm = normalize(absPath);
  const root = normalize(KNOWLEDGE_ROOT) + sep;
  // Allow exact KNOWLEDGE_ROOT match too (e.g., when listing).
  if (norm !== normalize(KNOWLEDGE_ROOT) && !norm.startsWith(root)) {
    throw new Error(`path escapes knowledge root: ${absPath}`);
  }
  return norm;
}

function knowledgePathParts(absPath) {
  const norm = assertUnderKnowledge(absPath);
  const root = normalize(KNOWLEDGE_ROOT);
  const rel = relative(root, norm);
  const parts = rel ? rel.split(/[\\/]+/).filter(Boolean) : [];
  return { norm, root, parts };
}

export class KnowledgeSymlinkError extends Error {
  constructor(path) {
    super(`symlink not allowed under knowledge root: ${path}`);
    this.name = "KnowledgeSymlinkError";
    this.code = "ERR_KNOWLEDGE_SYMLINK";
    this.path = path;
  }
}

function symlinkError(path) {
  return new KnowledgeSymlinkError(path);
}

export async function assertNoKnowledgeSymlink(absPath) {
  const { norm, root, parts } = knowledgePathParts(absPath);
  let cur = root;
  for (const part of ["", ...parts]) {
    if (part) cur = join(cur, part);
    let st;
    try { st = await fs.lstat(cur); }
    catch (e) {
      if (e.code === "ENOENT") return norm;
      throw e;
    }
    if (st.isSymbolicLink()) throw symlinkError(cur);
  }
  return norm;
}

export function assertNoKnowledgeSymlinkSync(absPath) {
  const { norm, root, parts } = knowledgePathParts(absPath);
  let cur = root;
  for (const part of ["", ...parts]) {
    if (part) cur = join(cur, part);
    let st;
    try { st = lstatSync(cur); }
    catch (e) {
      if (e.code === "ENOENT") return norm;
      throw e;
    }
    if (st.isSymbolicLink()) throw symlinkError(cur);
  }
  return norm;
}

// Strict validation for paths fed by the routing table (which is generated by
// sync but could be hand-edited or corrupted). Rejects anything that is not a
// plain `.md` file under KNOWLEDGE_ROOT, and refuses paths under `_archive/`
// (deprecated entries should never be routed).
//
// Returns the normalized path on success; throws on rejection.
function assertRoutablePathShape(absPath) {
  const norm = assertUnderKnowledge(absPath);
  if (!norm.toLowerCase().endsWith(".md")) {
    throw new Error(`not a markdown file: ${absPath}`);
  }
  // Case-insensitive containment check for _archive — on Windows/macOS file
  // systems, "_ARCHIVE\foo.md" resolves to the same directory and must also
  // be rejected. Lowercasing both sides is safe because legitimate domain
  // slugs are constrained to lowercase by SLUG_RE.
  const archivePrefix = (normalize(ARCHIVE_DIR) + sep).toLowerCase();
  if (norm.toLowerCase().startsWith(archivePrefix)) {
    throw new Error(`refusing to route archived file: ${absPath}`);
  }
  return norm;
}

export async function assertRoutableKnowledgeFileAsync(absPath) {
  const norm = assertRoutablePathShape(absPath);
  await assertNoKnowledgeSymlink(norm);
  return norm;
}

export function assertRoutableKnowledgeFile(absPath) {
  const norm = assertRoutablePathShape(absPath);
  assertNoKnowledgeSymlinkSync(norm);
  return norm;
}
