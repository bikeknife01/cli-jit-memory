// Test-only access to internal hooks. Set JITMEM_TEST_MODE=1 before importing
// this module or any lib module under test.

import "../../lib/sync.mjs";
import "../../lib/capture.mjs";
import "../../lib/router.mjs";
import { getTestHooks } from "../../lib/test-hook-registry.mjs";

export function resetSyncScheduler() {
  return getTestHooks("sync").resetScheduler();
}

export function setSyncOnce(fn) {
  return getTestHooks("sync").setSyncOnce(fn);
}

export function setRoutingReadFile(fn) {
  return getTestHooks("sync").setRoutingReadFile(fn);
}

export function setCaptureSyncFn(fn) {
  return getTestHooks("capture").setSyncFn(fn);
}

export function resetRouterInvalidEntryCount() {
  return getTestHooks("router").resetInvalidEntryCount();
}
