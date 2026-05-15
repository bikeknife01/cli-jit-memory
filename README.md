# JIT-Memory for GitHub Copilot CLI

A dynamic, organically-growing operational knowledge base implemented as a
**GHCP CLI extension**. The agent automatically loads relevant lessons before
each prompt and captures new ones via tool calls.

> **Privacy in 2 lines.** `jit-memory` saves lessons as plain-text Markdown
> files on your local disk and may include them in future Copilot prompts.
> **Do not capture passwords, tokens, customer data, private hostnames, or
> sensitive personal details.** A deterministic redaction scan blocks the
> obvious cases at capture time, but you are the final line of defense.

## Should I install this?

Install if you use Copilot CLI a lot and find yourself repeatedly explaining
the same operational quirks (your environment, your tools, your project
conventions). After install:
- Useful lessons get saved automatically as you work.
- The relevant ones get re-injected into future prompts when they apply.
- You don't have to manage tags, files, or routing tables by hand.

Skip if you only use Copilot CLI occasionally, or if you're uncomfortable
with an agent writing local plain-text files based on conversation context.

**Install in 5 minutes:** see [INSTALL.md](INSTALL.md).

## What you'll notice after installing

You keep using Copilot normally. The extension is mostly invisible.

- When something useful happens that may matter again, Copilot may save a
  short local memory by calling its `jit_memory_capture` tool. You'll see
  the tool call in the chat transcript.
- Memories live in `~/.copilot/jit-memory/knowledge/` as plain Markdown
  files. **You can open and read them at any time.**
- Quick Rules (universal cross-cutting rules) appear in your
  `~/.copilot/copilot-instructions.md` between the
  `<!-- jit-memory:QR:BEGIN -->` and `<!-- jit-memory:QR:END -->` markers.
- To remove a bad memory, ask Copilot to use `jit_memory_delete {domain, confirm:true}`
  (immediate; moves the file to `_archive/`) or `jit_memory_deprecate {domain}`
  (graceful; routing skips it on the next prompt). You can also delete or
  edit knowledge files manually under `~/.copilot/jit-memory/knowledge/` —
  the next sync regenerates routing automatically.
- To see what's stored and whether the extension is healthy, ask Copilot:
  "Run `jit_memory_status`."

## Where your data lives

**User knowledge (your captured lessons) lives outside the extension folder so
that re-installing or replacing the extension never destroys it.**

- **Production default:**
  - Windows: `C:\Users\<your-name>\.copilot\jit-memory\knowledge\`
  - macOS / Linux: `~/.copilot/jit-memory/knowledge/`

- **The extension code** lives at `~/.copilot/extensions/jit-memory/`
  (Windows: `C:\Users\<your-name>\.copilot\extensions\jit-memory\`). You can
  delete and re-copy this folder during upgrades — your knowledge data is
  untouched.

**Upgrading from earlier builds.** Earlier versions stored knowledge inside
the extension folder at `~/.copilot/extensions/jit-memory/knowledge/`. On the
next session start the extension automatically migrates that data to the new
location. After a successful migration you'll see a one-time session message
like `kb migrated from <legacy> → <new> (N files, rename)` and a breadcrumb
file `~/.copilot/extensions/jit-memory/knowledge.MIGRATED.txt` is written so
the move is visible in your file browser. The legacy folder is renamed in
place and never deleted; if you used a cross-volume layout it is preserved as
`knowledge.migrated-<timestamp>/` next to the original location.

**Migration safety.** If both the legacy and the new location contain user
data (rare, generally only after a manual install attempt), capture is
refused and a session warning explains how to merge. If anything else looks
wrong (an interrupted previous attempt, a symlink in the way, etc.), the
extension fails closed for writes and surfaces a clear message naming the
exact path you need to inspect — read paths are unaffected.

## Tools the extension exposes

| Tool | Purpose |
|---|---|
| `jit_memory_capture`         | Write a lesson (5 kinds: quick_rule, domain_new, domain_update, disputed, alias_add). Idempotent on retry. Refuses to write content matching deterministic redaction patterns unless `confirm_redaction_skip:true`. |
| `jit_memory_capture_preview` | Read-only check before capture: returns existing candidates (slug + tag/alias overlap) and a suggested kind, so the agent can pick `domain_update` over `domain_new` when appropriate. |
| `jit_memory_deprecate`       | Graceful retire: mark a domain `deprecated:<today>`. Routing skips it on the next prompt; the headless audit eventually archives any file deprecated >30 days. |
| `jit_memory_delete`          | Immediate retire: move a domain file to `knowledge/_archive/` now. Requires `{confirm:true}` to actually move. |
| `jit_memory_audit`           | Read-only deterministic audit (stale, cap, disputed, collisions, zero-hit, bloat, deprecated, frontmatter, marker presence). Write-side archival of deprecated >30 days runs only from the headless `node audit.mjs` CLI. |
| `jit_memory_status`          | Health snapshot: routing freshness, domain count, usage totals, migration status, active issues. |
| `jit_memory_debug_route`     | Inspect routing for a given intent string. Debugging only. |

## How it works (one screen)

- **Routes deterministically** before every prompt via `onUserPromptSubmitted`
  — matches user intent against tags/aliases in the generated routing register
  and injects matched files as hidden context (≤4 KB hard cap). No LLM tag-scanning.
- **Captures lessons atomically** via the `jit_memory_capture` tool. The agent
  calls this when it sees a lesson that could plausibly recur. The user is
  consulted only for ambiguity, contradiction, Quick Rule demotion at cap,
  redaction-blocked content, or accidental sensitive-data capture.
- **Audits deterministically** via `onSessionStart` (read-only digest surfacing)
  and an optional headless `node audit.mjs` cron entry (write-side: archives
  deprecated >30 d).
- **Self-heals**: lock+CAS on shared file mutations, fail-open hooks,
  per-file error tolerance, stale-lock recovery (with heartbeat to avoid
  evicting slow live holders), throttled error logs.

## Package contents

```
cli-jit-memory/
├── README.md                          (this file)
├── INSTALL.md                         step-by-step install
├── copilot-instructions.snippet.md    paste-into-instructions block (~15 lines)
├── retrofit-existing-instructions.md   one-time prompt for migrating old notes
└── jit-memory/                        ← copy this whole tree to ~/.copilot/extensions/jit-memory/
    ├── package.json
    ├── extension.mjs                  hooks + tools registration
    ├── audit.mjs                      headless CLI for optional scheduler
    ├── lib/
    │   ├── paths.mjs                  path resolution + slug validation
    │   ├── migrate.mjs                one-shot relocation of legacy in-extension knowledge
    │   ├── frontmatter.mjs            JSON frontmatter parse/stringify/validate
    │   ├── atomic.mjs                 atomicWrite, withLock, casReplaceMarkers
    │   ├── bootstrap.mjs              QR/KB marker auto-repair on session start
    │   ├── router.mjs                 intent → matches with confidence tiers
    │   ├── sync.mjs                   regenerate _routing.json + KB block
    │   ├── usage.mjs                  in-memory telemetry; lock-merge-write flush
    │   ├── context.mjs                4 KB UTF-8 context assembler
    │   ├── capture.mjs                5-kind capture state machine
    │   └── audit.mjs                  deterministic audit + digest renderer
    └── knowledge/                     **runtime data lives here** at
                                        `~/.copilot/jit-memory/knowledge/`,
                                        NOT inside the extension folder
        ├── _routing.json              seed/generated cache (router reads)
        ├── _usage.json                seed/generated telemetry state
        ├── _jit-memory.log            local operational log (created at runtime)
        ├── _archive/                  retired domain files
        └── protocols/                 multi-step protocol files
```

## Design notes

These are background details for contributors and curious users. Not needed to
install or use the extension.

### Why an extension instead of PowerShell + markdown

The earlier prototype required an LLM to scan a tag table on every prompt and
shell out to `kb-route.ps1`. That cost ~500 tokens of permanent system prompt
and was unreliable across platforms. With the SDK's `onUserPromptSubmitted`
hook, routing becomes invisible infrastructure: the orchestration text in
`copilot-instructions.md` shrinks from ~80 lines to ~15.

### Design highlights

**Frontmatter is JSON, not YAML.** Eliminates parser footguns. Strict subset:
required `domain`, `kind`, `summary`, `tags`, `aliases`, `see_also`,
`verified`, `deprecated`. `JSON.parse` is the authoritative validator.
Tags must be 2-40 characters; upgrade any older one-character tags before
expecting those files to route.

**Single source of truth = the domain files.** `_routing.json`, the compact KB
signpost in instructions, and `_usage.json` are all generated artifacts. Sync is
single-flight + dirty-flag coalesced — concurrent captures collapse to one
sync.

**`verified` is NOT bumped on routing.** It's bumped only on capture-time
edits (a deliberate "this lesson was just confirmed correct" signal).
`_usage.json` tracks routing hits separately for zero-hit demotion candidates.

**4 KB UTF-8 context budget** with confidence tiers:

- `high` (alias substring match)  → file content excerpt (≤1.5 KB)
- `medium` (tag word-boundary)    → summary + first paragraph (≤600 B)
- `low` (see-also expansion only) → summary line only

**Privacy and trust.** Usage telemetry persists only `{slug -> {hits, lastHit}}`: no prompt text or captured lesson bodies. Operational events are logged separately to `knowledge/_jit-memory.log`, rotated at 256 KB (previous contents move to `_jit-memory.log.1`; one generation is kept), and may include event names, reason codes, domain slugs, and error messages, but not prompt text or captured lesson bodies. Captured lessons are stored as local plaintext Markdown under `knowledge/` and can be injected into future prompts; redact sensitive data before capture. Treat `knowledge/` like trusted local code, and do not import, sync, or commit it to shared locations without review. If sensitive data is captured accidentally, stop and repair or remove the affected local knowledge file before continuing — or use `jit_memory_delete {domain, confirm:true}` to do it through the agent.

**Cross-platform.** Pure Node ESM. No PowerShell. Tested path:
`fs.promises.rename` for atomicity, `fs.open(<lock>, "wx")` for advisory
locking, same-directory temp files, EPERM/EACCES retry for Windows AV.

### Capture flow (agent's side)

When the agent identifies a lesson that could plausibly recur:

```js
jit_memory_capture({
  kind: "domain_new",
  domain: "email",
  summary: "Outlook COM is the only working email method...",
  tags: ["email", "outlook", "graph-api"],
  aliases: ["send mail", "send an email"],
  content: "Email: Graph API requires admin consent -> use Outlook COM via PowerShell"
});
```

The tool atomically writes the file, regenerates the routing cache, and
returns `{status: "ok"}`. Next prompt that mentions "email" will route to it.
Tags, aliases, summaries, and see-also metadata stay in `_routing.json`; the
static instructions block only shows the compact domain/file signpost.

If a Quick Rule capture finds the cap is full:

```json
{ "status": "at_cap", "summary": "Quick Rules at cap (10). Provide demote_target ...", "existing": [{ "rule": "- ...", "addedAt": "2025-01-15" }] }
```

The agent picks a rule to demote (oldest-first is a defensible default —
addedAt metadata is provided), retries with `demote_target`, or asks the
user if no clear demotion target exists.

### Prerequisites

- **GitHub Copilot CLI v1.0.36 or later.** The extension uses
  `joinSession({ hooks, tools })` from `@github/copilot-sdk/extension`, which
  is verified on 1.0.36. Earlier 1.0.x versions may work but are not tested.
  Run `copilot --version` to check.
- **Node.js 20 or newer.** Required for the package test script, optional
  headless audit scheduler, native `fs.promises`, `node:test`, and ESM module
  syntax.
- **Experimental features enabled.** As of the current Copilot CLI version,
  extensions are available only when experimental features are turned on.
  Check status, enabled features, and available features from inside Copilot CLI
  with `/experimental`. Turn experimental mode on either by launching once with
  `copilot --experimental` or by running `/experimental` and enabling it there.
  The setting is persisted after it is enabled.

  Experimental features are still in development and may change, break, or be
  removed without the same compatibility guarantees as stable features. Use them
  with that risk in mind, and expect to revisit setup after CLI updates.

That's it. **Zero npm dependencies.** The extension imports only Node built-ins
(`node:fs`, `node:path`, `node:crypto`, `node:os`, `node:url`) and the
copilot-sdk module that ships with the CLI itself. There is no `npm install`
step.

## License / status

Authoring template — adapt freely.
