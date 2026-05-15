// Item #25: single-word aliases use word-boundary matching like tags.

import { test } from "node:test";
import assert from "node:assert/strict";
import { route } from "../lib/router.mjs";

const table = {
  domains: [
    { domain: "app", tags: [], aliases: ["app"] },
    { domain: "git", tags: [], aliases: ["git rebase"] }
  ]
};

test("single-word alias does NOT match inside a longer word", () => {
  // "app" in "happy" should not match.
  const matches = route("I am happy today", table);
  assert.equal(matches.length, 0, `expected no match; got ${JSON.stringify(matches)}`);
});

test("single-word alias matches when whole-word", () => {
  const matches = route("the app is broken", table);
  assert.ok(matches.some(m => m.slug === "app"));
});

test("multi-word alias still matches as substring", () => {
  const matches = route("how do I git rebase quickly", table);
  assert.ok(matches.some(m => m.slug === "git"));
});
