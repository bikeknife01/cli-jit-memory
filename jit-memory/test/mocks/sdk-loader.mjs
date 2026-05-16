// Custom ESM loader hook: redirects @github/copilot-sdk/extension imports
// to the local test mock so integration tests can load extension.mjs without
// the real SDK installed.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_URL = new URL("file://" + join(__dirname, "copilot-sdk-extension.mjs").replace(/\\/g, "/")).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@github/copilot-sdk/extension") {
    return { shortCircuit: true, url: MOCK_URL };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  return nextLoad(url, context);
}
