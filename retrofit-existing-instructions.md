# Retrofit existing Copilot instructions into jit-memory

Use this prompt once after installing the `jit-memory` extension and restarting
Copilot CLI, when the user already has durable knowledge, preferences, or
operational notes in `~/.copilot/copilot-instructions.md`.

Do not treat every instruction as knowledge to migrate. Preserve agent behavior
instructions in `copilot-instructions.md`; migrate durable facts, lessons, and
old instruction-resident routing metadata that should now be routed or recalled
by `jit-memory`.

## Prompt

You are retrofitting an existing `~/.copilot/copilot-instructions.md` file into
the `jit-memory` extension system.

Follow this procedure:

1. Read `~/.copilot/copilot-instructions.md`.
2. Create a timestamped backup before making any captures or edits:
   `~/.copilot/copilot-instructions.backup-before-jit-memory-retrofit-YYYYMMDD-HHMMSS.md`.
3. Tell the user the exact backup path.
4. **Dry-run inventory FIRST.** Before calling any capture tool, identify candidate
   items and present them as a single grouped inventory the user can review:
   - **safe** — durable, generally non-sensitive lessons (tool versions, command
     usage, language conventions, public API quirks).
   - **needs-approval** — items that mention private context: account names,
     tenant IDs, internal hostnames, repo names, customer references, file
     paths under the user's home directory, or service-specific identifiers.
     The user must approve each before capture.
   - **skip-sensitive** — items containing tokens, secrets, credentials,
     passwords, private keys, JWTs, connection strings, or anything matching
     the deterministic redaction patterns enforced by `jit_memory_capture`.
     These are NEVER captured. Report them as skipped and do not include their
     content in the inventory output beyond a short reference.
   Wait for the user to approve, edit, or remove items from the inventory before
   proceeding to step 5.
5. Identify content that should be migrated into `jit-memory`:
   - Durable domain knowledge, such as tool-specific lessons, environment facts,
     account/repo conventions, service names, commands, known gotchas, and
     repeatable workflows.
   - Cross-cutting behavior rules only when they are truly universal and belong
     in Quick Rules.
   - Old instruction-resident routing metadata, including legacy `Tags | File |
     Summary` tables or similar domain/tag/alias inventories from earlier
     versions of this extension. Use these as migration input for the new source
     of truth: domain Markdown frontmatter captured through `jit_memory_capture`.
   - Missing routing terms that should become tags or aliases for a domain.
6. Do not migrate:
   - The `jit-memory` orchestration block itself.
   - Content inside generated or managed marker blocks owned by **other**
     extensions (for example `efficiency-retro:managed-start/end`,
     custom-cloud-agent regions, or any block that another tool advertises as
     "do not hand-edit"). Even when a managed region looks like durable
     knowledge, leave it intact and let its owner extension manage it.
     The single exception is **legacy jit-memory routing tables** (e.g. an
     older `## Tags | File | Summary` section that was the previous extension's
     own routing source) — those may be migrated into the new domain Markdown
     model via `jit_memory_capture`.
   - Session-start banners, identity metadata, formatting preferences, or other
     instructions that should remain as direct agent behavior.
   - One-off task notes, stale facts, secrets, credentials, or private data that
     should not be persisted.
7. For each migration item, call `jit_memory_capture` rather than editing
   knowledge files by hand:
   - Use `kind: "domain_new"` for a new durable topic with a clear domain name,
     summary, tags, aliases, and content.
   - Use `kind: "domain_update"` for a lesson that belongs in an existing
     domain, choosing `section: "working"`, `"broken"`, or `"gotcha"`.
   - Use `kind: "quick_rule"` only for universal cross-cutting rules.
   - Use `kind: "alias_add"` when the information is only a missing route term
     for an existing domain.
   - Use `kind: "disputed"` when a migrated item contradicts an existing domain
     fact and the contradiction cannot be reconciled safely.
   - Before capturing into `domain_new`, prefer `jit_memory_capture_preview`
     to surface any existing similar domain that should receive a `domain_update`
     or `alias_add` instead.
   - Never pass `confirm_redaction_skip:true` during retrofit. If the
     deterministic redaction scan flags an item as `needs_redaction`, treat it
     as **skip-sensitive**: report it back to the user and ask before doing
     anything further with it.
8. Ask the user before capture only when the normal `jit-memory` capture rules
   require it: Quick Rules are at cap and demotion is ambiguous, a contradiction
   has no clear reconciliation, the domain name is genuinely ambiguous, or the
   redaction scanner blocks an item.
9. After all approved captures are complete, present a cleanup plan and ask the
   user whether to apply each cleanup action:
   - Remove or shrink migrated source text from `copilot-instructions.md` so the
     durable knowledge is not duplicated in both static instructions and
     `jit-memory` domain files.
   - Remove legacy tags, aliases, summaries, or generated KB tables from the
     instructions now that routing metadata lives in domain frontmatter and
     generated `_routing.json`.
   - Preserve any direct behavior instructions, active managed regions owned
     by other extensions, and content the user declines to remove.
   - **Do not remove anything until every approved capture returned `ok`.** If
     any capture failed or was blocked by redaction, leave the source text in
     place until the user resolves the failed item.
10. Apply only the cleanup actions the user approves. Never remove secrets or
    sensitive content by migrating it; if found, report it as skipped and ask
    the user how they want to handle cleanup.
11. When finished, report:
    - The backup path.
    - Each migrated item, grouped by target domain or Quick Rules.
    - Any content intentionally left in `copilot-instructions.md` and why.
    - Any skipped content, including stale, ambiguous, sensitive, or one-off
      material.
    - Which cleanup actions were applied, declined, or still need a user decision.

If the `jit-memory` tools are unavailable, stop after creating the backup,
notify the user that migration could not be completed, and do not attempt to
edit knowledge files manually.
