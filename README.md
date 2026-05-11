# JIT-Memory for GitHub Copilot CLI

A dynamic, organically-growing operational knowledge base implemented as a
**GHCP CLI extension**. The agent automatically loads relevant lessons before
each prompt and captures new ones via tool calls. Zero human intervention
except for ambiguity, contradiction, Quick Rule demotion at cap, or accidental
sensitive-data capture.

## What this is

A single CLI extension at `~/.copilot/extensions/jit-memory/` that:

- **Routes deterministically** before every prompt via `onUserPromptSubmitted`
  — matches user intent against tags/aliases in the generated routing register
  and injects matched files as hidden context (≤4 KB hard cap). No LLM tag-scanning.
- **Captures lessons atomically** via the `jit_memory_capture` tool. Five
  kinds: universal Quick Rule, new domain, existing domain update, disputed
  fact, missing alias. The agent calls this when it sees a lesson that could
  plausibly recur. The user is consulted only for ambiguity, contradiction,
  Quick Rule demotion, or accidental sensitive-data capture.
- **Audits deterministically** via `onSessionStart` (read-only digest surfacing)
  and an optional headless `node audit.mjs` cron entry (write-side: archives
  deprecated >30 d).
- **Self-heals**: lock+CAS on shared file mutations, fail-open hooks,
  per-file error tolerance, stale-lock recovery, throttled error logs.

## Why an extension instead of PowerShell + markdown

The earlier prototype required an LLM to scan a tag table on every prompt and
shell out to `kb-route.ps1`. That cost ~500 tokens of permanent system prompt
and was unreliable across platforms. With the SDK's `onUserPromptSubmitted`
hook, routing becomes invisible infrastructure: the orchestration text in
`copilot-instructions.md` shrinks from ~80 lines to ~15.

## Package contents

```
cli-jit-memory/
├── README.md                          (this file — design rationale)
├── INSTALL.md                         step-by-step install
├── copilot-instructions.snippet.md    paste-into-instructions block (~15 lines)
├── retrofit-existing-instructions.md   one-time prompt for migrating old notes
└── jit-memory/                        ← copy this whole tree to ~/.copilot/extensions/jit-memory/
    ├── package.json
    ├── extension.mjs                  hooks + tools registration
    ├── audit.mjs                      headless CLI for optional scheduler
    ├── lib/
    │   ├── paths.mjs                  path resolution + slug validation
    │   ├── frontmatter.mjs            JSON frontmatter parse/stringify/validate
    │   ├── atomic.mjs                 atomicWrite, withLock, casReplaceMarkers
    │   ├── bootstrap.mjs              QR/KB marker auto-repair on session start
    │   ├── router.mjs                 intent → matches with confidence tiers
    │   ├── sync.mjs                   regenerate _routing.json + KB block
    │   ├── usage.mjs                  in-memory telemetry; lock-merge-write flush
    │   ├── context.mjs                4 KB UTF-8 context assembler
    │   ├── capture.mjs                5-kind capture state machine
    │   └── audit.mjs                  deterministic audit + digest renderer
    └── knowledge/
        ├── _routing.json              seed/generated cache (router reads)
        ├── _usage.json                seed/generated telemetry state
        ├── _jit-memory.log            local operational log (created at runtime)
        ├── _archive/                  retired domain files
        └── protocols/                 multi-step protocol files
```

## Design highlights

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

**Privacy and trust.** Usage telemetry persists only `{slug -> {hits, lastHit}}`: no prompt text or captured lesson bodies. Operational events are logged separately to `knowledge/_jit-memory.log`, rotated at 256 KB (previous contents move to `_jit-memory.log.1`; one generation is kept), and may include event names, reason codes, domain slugs, and error messages, but not prompt text or captured lesson bodies. Captured lessons are stored as local plaintext Markdown under `knowledge/` and can be injected into future prompts; redact sensitive data before capture. Treat `knowledge/` like trusted local code, and do not import, sync, or commit it to shared locations without review. If sensitive data is captured accidentally, stop and repair or remove the affected local knowledge file before continuing.

**Cross-platform.** Pure Node ESM. No PowerShell. Tested path:
`fs.promises.rename` for atomicity, `fs.open(<lock>, "wx")` for advisory
locking, same-directory temp files, EPERM/EACCES retry for Windows AV.

## Capture flow (agent's side)

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
{ "status": "at_cap", "summary": "Quick Rules at cap (10). Provide demote_target ..." }
```

The agent picks a rule to demote, retries with `demote_target`, or asks the
user if no clear demotion target exists.

## Prerequisites

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
