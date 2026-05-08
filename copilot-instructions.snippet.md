<!--
  jit-memory orchestration block.
  Paste everything below this comment into ~/.copilot/copilot-instructions.md.
  Both marker blocks (QR and KB) must be preserved as empty pairs on first
  install — the extension fills them in via tool calls and sync.
-->

## Operational Knowledge Base (jit-memory)

The `jit-memory` CLI extension auto-loads relevant lessons before each prompt and exposes capture tools. **Do not edit knowledge files by hand.** If the `jit-memory` CLI extension fails or is unavailable, notify the user and proceed without loading additional lessons or capturing new ones until the tools are available.

### Capture rules

When you identify a repeatable failure or pattern, call `jit_memory_capture` immediately. Choose `kind` by the situation:

- Universal cross-cutting (no natural domain) → `kind: "quick_rule"`. If returned `at_cap`, pick a Quick Rule to demote and retry with `demote_target`.
- Lesson belongs to an existing domain → `kind: "domain_update"` with `domain` + `section` ("working" | "broken" | "gotcha").
- New domain warranted → `kind: "domain_new"` with `domain`, `summary`, 1–12 `tags`, 0–8 `aliases`.
- Contradicts an existing fact → `kind: "disputed"` with `domain`. Original fact preserved.
- Same fact applied but routing missed it → `kind: "alias_add"` with `domain` and the missing `tags` or `aliases`.

Ask the user only when:

- Quick Rules are at cap and demotion target is ambiguous, OR
- A new lesson contradicts an existing fact with no clear reconciliation, OR
- Domain naming is non-obvious (the lesson plausibly belongs to two existing domains).

The session-start digest (if present) lists items needing review.

### User-driven capture

When the user says "remember…", "note that…", "save this…", "capture…",
"add this to <domain>", or any equivalent phrasing — treat it as an
immediate capture intent. Pick the right `kind` yourself using the
Capture rules above, including creating a new domain (`kind: "domain_new"`)
when no existing domain fits. Do not ask the user to specify tool names,
kinds, domains, sections, tags, or schemas — translate their natural
language into the correct `jit_memory_capture` call based on the Capture
rules and current context. Confirm only when the Capture rules above
require it (Quick Rules are at cap and demotion target is ambiguous,
contradiction without clear reconciliation, or domain naming is genuinely
ambiguous).

### Quick Rules — managed by jit_memory_capture

<!-- QR:BEGIN -->
<!-- QR:END -->

### Generated KB index — managed by sync (do not edit between markers)

<!-- KB:BEGIN -->

| Tags               | File | Summary |
| ------------------ | ---- | ------- |
| _(no domains yet)_ |      |         |

<!-- KB:END -->
