<!--
  jit-memory orchestration block.
  Paste everything below this comment into ~/.copilot/copilot-instructions.md.
  Preserve both marker blocks. The extension fills QR via capture and rewrites
  the KB block via sync.

  Marker compatibility: this snippet uses the namespaced marker form
  (`jit-memory:QR:BEGIN`/`jit-memory:KB:BEGIN`) to avoid collisions with
  other extensions. The extension also recognizes the legacy form
  (`QR:BEGIN`/`KB:BEGIN`) for back-compat with older installs — if your
  instructions file already has those, leave them; jit-memory will keep
  using whichever pair is present.
-->

## Operational Knowledge Base (jit-memory)

The `jit-memory` extension routes relevant local lessons before prompts and exposes capture tools. **Do not edit knowledge files by hand.** If the extension is unavailable, notify the user and continue without capturing.

Call `jit_memory_capture` proactively when a lesson could plausibly recur; a single concrete failure is enough. After non-trivial tool errors, failed commands, rejected edits, dead ends, or workarounds, capture if it could recur or if you are unsure before the next substantive tool batch. Redact secrets, credentials, customer data, private hostnames, unnecessary personal data, and unneeded absolute paths.

Use the capture tool schema to choose `kind`: quick rules for universal behavior, domain updates for existing topics, new domains when none fits, disputed for contradictions, and alias/tag additions when routing missed. On `at_cap`, retry with `demote_target` unless the demotion choice is unclear.

To remove a lesson cleanly, prefer `jit_memory_deprecate {domain}` (graceful — routing skips it on the next prompt; archived after 30 days) or `jit_memory_delete {domain, confirm:true}` (immediate — moves the file into `_archive/`).

For user "remember/save/capture/note" requests, translate the request into `jit_memory_capture` yourself; do not ask for tool names, kinds, domains, sections, tags, or schemas unless one of these gates applies: ambiguous domain choice, unresolved contradiction, unclear Quick Rule demotion, or accidental sensitive capture.

### Quick Rules — managed by jit_memory_capture

<!-- jit-memory managed: do not hand-edit between jit-memory:QR:BEGIN and jit-memory:QR:END -->
<!-- jit-memory:QR:BEGIN -->
<!-- jit-memory:QR:END -->

### Domain Index

<!-- jit-memory managed: do not hand-edit between jit-memory:KB:BEGIN and jit-memory:KB:END -->
<!-- jit-memory:KB:BEGIN -->

| Domain | File |
|---|---|
| _(no domains yet)_ | |

<!-- jit-memory:KB:END -->
