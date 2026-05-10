// Test-only hook registry. Keep this module dependency-free so production
// modules can register closure-bound test hooks without creating ESM cycles.

const registry = new Map();

export function registerTestHooks(namespace, hooks) {
  if (process.env.JITMEM_TEST_MODE !== "1") return;
  if (typeof namespace !== "string" || namespace.trim() === "") {
    throw new Error("test hook namespace must be a non-empty string");
  }
  if (!hooks || typeof hooks !== "object") {
    throw new Error(`test hooks for ${namespace} must be an object`);
  }
  registry.set(namespace, hooks);
}

export function getTestHooks(namespace) {
  if (process.env.JITMEM_TEST_MODE !== "1") {
    throw new Error("test hooks are only available when JITMEM_TEST_MODE=1");
  }
  const hooks = registry.get(namespace);
  if (!hooks) {
    throw new Error(
      `test hook namespace ${JSON.stringify(namespace)} is not registered; ` +
      "set JITMEM_TEST_MODE=1 before importing modules under test"
    );
  }
  return hooks;
}
