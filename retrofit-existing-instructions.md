# Retrofit existing Copilot instructions into jit-memory

Use this prompt once after installing the `jit-memory` extension and restarting
Copilot CLI, when the user already has durable knowledge, preferences, or
operational notes in `~/.copilot/copilot-instructions.md`.

Do not treat every instruction as knowledge to migrate. Preserve agent behavior
instructions in `copilot-instructions.md`; migrate only durable facts or
lessons that should be routed or recalled by `jit-memory`.

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
   - Missing routing terms that should become tags or aliases for a domain.
5. Do not migrate:
   - The `jit-memory` orchestration block itself.
   - Content inside generated or managed marker blocks, including `QR`, `KB`, or
     `efficiency-retro` regions, except when explicitly using the provided
     capture tools to preserve a durable non-generated lesson.
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
8. Do not delete or rewrite the original instruction content unless the user
   explicitly asks for cleanup after reviewing the migration list.
9. When finished, report:
   - The backup path.
   - Each migrated item, grouped by target domain or Quick Rules.
   - Any content intentionally left in `copilot-instructions.md` and why.
   - Any skipped content, including stale, ambiguous, sensitive, or one-off
     material.
   - Any follow-up actions the user must decide, such as ambiguous domain names
     or optional cleanup of duplicated source text.

If the `jit-memory` tools are unavailable, stop after creating the backup,
notify the user that migration could not be completed, and do not attempt to
edit knowledge files manually.
