// Item #12: routing scoring weights multi-term tag hits and alias
// specificity, so a more-specific match outranks a single-token generic
// hit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { route } from "../lib/router.mjs";

const table = {
  version: 3,
  domains: [
    { domain: "git",     file_rel: "git.md",     tags: ["git"], aliases: [] },
    { domain: "git-rebase", file_rel: "git-rebase.md", tags: ["git", "rebase", "interactive"], aliases: ["interactive rebase"] },
    { domain: "alpha",   file_rel: "alpha.md",   tags: ["alpha"], aliases: [] }
  ]
};

test("multi-tag match outranks single-tag match", () => {
  const matches = route("how do I git rebase interactive squash", table);
  assert.ok(matches.length >= 2);
  // git-rebase has 3 tag hits + alias bonus; git has only 1 tag hit.
  assert.equal(matches[0].slug, "git-rebase",
    `expected git-rebase first; got ${JSON.stringify(matches.map(m => m.slug))}`);
});

test("alias bonus boosts longer phrases above shorter generic tag", () => {
  const matches = route("interactive rebase saves the day", table);
  assert.equal(matches[0].slug, "git-rebase",
    `expected git-rebase first; got ${JSON.stringify(matches.map(m => m.slug))}`);
  assert.equal(matches[0].confidence, "high");
});

test("no match returns empty", () => {
  const matches = route("totally unrelated content", table);
  assert.equal(matches.length, 0);
});
