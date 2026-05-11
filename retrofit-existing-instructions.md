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
4. Identify content that should be migrated into `jit-memory`:
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
5. Do not migrate:
   - The `jit-memory` orchestration block itself.
   - Content inside generated or managed marker blocks, including `QR`, `KB`, or
     `efficiency-retro` regions, except when explicitly using the provided
     capture tools to preserve durable knowledge, Quick Rules, or legacy
     routing metadata that should survive in the new model.
   - Session-start banners, identity metadata, formatting preferences, or other
     instructions that should remain as direct agent behavior.
   - One-off task notes, stale facts, secrets, credentials, or private data that
     should not be persisted.
6. For each migration item, call `jit_memory_capture` rather than editing
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
7. Ask the user before capture only when the normal `jit-memory` capture rules
   require it: Quick Rules are at cap and demotion is ambiguous, a contradiction
   has no clear reconciliation, or the domain name is genuinely ambiguous.
8. After all captures are complete, present a cleanup plan and ask the user
   whether to apply each cleanup action:
   - Remove or shrink migrated source text from `copilot-instructions.md` so the
     durable knowledge is not duplicated in both static instructions and
     `jit-memory` domain files.
   - Remove legacy tags, aliases, summaries, or generated KB tables from the
     instructions now that routing metadata lives in domain frontmatter and
     generated `_routing.json`.
   - Preserve any direct behavior instructions, active managed regions, and
     content the user declines to remove.
9. Apply only the cleanup actions the user approves. Never remove secrets or
   sensitive content by migrating it; if found, report it as skipped and ask the
   user how they want to handle cleanup.
10. When finished, report:
   - The backup path.
   - Each migrated item, grouped by target domain or Quick Rules.
   - Any content intentionally left in `copilot-instructions.md` and why.
   - Any skipped content, including stale, ambiguous, sensitive, or one-off
     material.
   - Which cleanup actions were applied, declined, or still need a user decision.

If the `jit-memory` tools are unavailable, stop after creating the backup,
notify the user that migration could not be completed, and do not attempt to
edit knowledge files manually.
