# jit-memory

`jit-memory` keeps a small operational knowledge base for GitHub Copilot CLI and routes relevant lessons into future prompts just in time.

Markdown files under `knowledge/` are the source of truth. The default
production location is `~/.copilot/jit-memory/knowledge/` (a path independent
of the extension code folder, so re-installing the extension never destroys
your data). Generated files such as `knowledge/_routing.json`,
`knowledge/_usage.json`, and the compact domain/file KB signpost in
`copilot-instructions.md` are rebuilt from those source files.

## Features

- Captures universal Quick Rules and domain-specific lessons through `jit_memory_capture`.
- Routes relevant domain memories automatically on user prompts.
- Audits stale, malformed, disputed, bloated, and deprecated knowledge with `jit_memory_audit`.
- Debugs routing decisions with `jit_memory_debug_route`.

## Safety and privacy

- Quick Rules are capped at 280 characters and at 10 active rules to avoid prompt bloat.
- Captured lessons are local plaintext Markdown under `knowledge/` and may be routed into future prompts. Redact secrets, tokens, credentials, customer data, personal data not required for the lesson, absolute user paths when not needed, and private/internal hostnames unless essential.
- Captured content is rejected if it contains managed-region markers, including dynamically discovered sibling markers from `copilot-instructions.md`.
- Knowledge files are trusted prompt context. Do not import, sync, or commit `knowledge/` to shared locations without review.
- If sensitive data is captured accidentally, stop and repair or remove the affected local knowledge file before continuing.
- Quick Rule managed blocks fail closed if they contain comments or prose instead of list items, so unknown text is not silently discarded.
- Marker whitespace variants are treated as malformed and require manual repair instead of automatic rewriting.
- Symlinks under `knowledge/` are refused for routing and capture paths.
- Routing tables are validated on load; invalid rows are dropped and regeneration is scheduled.
- Usage telemetry is local and content-free: it records domain usage counts, not prompt or memory content.
- Operational events are logged to `knowledge/_jit-memory.log` and rotated at 256 KB (previous contents move to `_jit-memory.log.1`; one generation is kept). Logs may include event names, reason codes, domain slugs, and error messages, but not prompt text or captured lesson bodies.

## Drift heal timing

At session start, the extension checks whether knowledge files and generated routing/KB output have drifted, including stale static KB formats from older releases. If drift is found, it regenerates `_routing.json` and/or the KB block after extension hooks begin.

Copilot CLI loads static `copilot-instructions.md` text before extension hooks run. That means a healed KB block is visible in the next session. Regenerated routing can still affect later prompts in the current session after the heal completes. When drift heal changes generated state, the extension emits a one-time warning-level session notice prefixed `jit-memory: drift-heal:notice` with the reason summary.

If `copilot-instructions.md` is absent, capture and sync can still update knowledge files and routing. Static KB block updates are skipped and reported as `skipped_instructions_missing`.

## Scale guardrails

There is no hard cap on domain files, but `jit_memory_audit` warns when the domain count, static KB signpost, or generated routing table grows large. Tags, aliases, summaries, and see-also metadata live in `_routing.json`; the static KB block is only a domain/file signpost and routed memory context is still capped to 4 KB per prompt.

If audit reports scale warnings, prefer concise summaries and tags, archive deprecated domains, resolve zero-hit candidates, and split broad domains only when it improves routing precision.

## Development

- Node.js 20 or newer is required for the package test script.
- `npm test` runs the Node built-in test suite.
- `npm run audit` runs the deterministic knowledge-base audit CLI.
