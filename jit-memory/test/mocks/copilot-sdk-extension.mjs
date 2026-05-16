// Minimal fake @github/copilot-sdk/extension for integration tests.
// The joinSession function captures its argument so tests can inspect
// hooks/tools, then returns a minimal session stub.
let _captured = null;

export function joinSession(opts) {
  _captured = opts;
  return {
    log() { /* no-op */ },
    rpc: {}
  };
}

/** Return the last captured joinSession argument. */
export function getCaptured() { return _captured; }

/** Reset captured state (use between test files if re-using same process). */
export function reset() { _captured = null; }
