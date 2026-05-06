# Installation

## Quickstart (5 minutes, non-technical)

If you just want it working:

1. **Check you have the right version.** Open a terminal and run:
   ```
   copilot --version
   ```
   You should see `1.0.36` or higher. If not, run `copilot update`.

2. **Copy the extension folder.** Find the `jit-memory` folder inside this
   download package. Copy it (the whole folder) into:
   - **Windows:** `C:\Users\<your-username>\.copilot\extensions\`
   - **Mac/Linux:** `~/.copilot/extensions/`

   Create the `extensions` folder first if it doesn't exist. When you're
   done, this file should exist:
   `~/.copilot/extensions/jit-memory/extension.mjs`

3. **Add the snippet to your instructions file.** Open
   `~/.copilot/copilot-instructions.md` in any text editor (create it if it
   doesn't exist). Open `copilot-instructions.snippet.md` from this package,
   copy everything in it, and paste it at the bottom of your instructions
   file. Save.

4. **Restart Copilot CLI.** Close it completely and start it again. Look at
   the startup banner — it should say something like
   `Environment loaded: ... 1 extension ...`. That's it.

You're done. No `npm install`, no admin privileges, no extra software. The
detailed install instructions below cover edge cases, scheduling the audit
job, and troubleshooting.

---

The extension lives at `~/.copilot/extensions/jit-memory/`. You drop the
`jit-memory/` directory in place and add ~15 lines to your global instructions.
That's the entire install.

## Dependencies

- **GitHub Copilot CLI v1.0.36 or later.** Verified on 1.0.36. Earlier 1.0.x
  versions may work but are not tested.
- **Node.js ≥18.** The CLI bundles its own Node, so you usually do not need a
  separate Node install.
- **No `--experimental` flag required.** Extensions are a stable feature.
- **Zero npm packages.** The extension imports only Node built-ins (`node:fs`,
  `node:path`, `node:crypto`, `node:os`, `node:url`) and
  `@github/copilot-sdk/extension`, which is provided by the CLI. There is no
  `npm install` step and no `node_modules/` folder.

## 1. Install the extension

You can either copy the folder by hand or run a one-liner. Either way the goal
is identical: the `jit-memory/` directory from this package ends up at
`~/.copilot/extensions/jit-memory/` (so that
`~/.copilot/extensions/jit-memory/extension.mjs` exists).

The CLI auto-discovers extensions in `~/.copilot/extensions/<name>/` on next
startup — there is **no** registration command to run.

### Option A — manual copy (any OS)

1. Open the unpacked `jitmemdist/` folder.
2. Copy the `jit-memory/` folder (the one containing `extension.mjs`).
3. Paste it into `~/.copilot/extensions/`. Create that folder if it doesn't
   exist. The final path must be `~/.copilot/extensions/jit-memory/extension.mjs`.

### Option B — Windows PowerShell one-liner

Open PowerShell (any working directory is fine — the script uses an absolute
path) and run, replacing `<path-to-jitmemdist>` with where you unpacked this
package:

```powershell
$src = 'C:\path\to\jitmemdist\jit-memory'           # ← the source folder containing extension.mjs
$dst = Join-Path $env:USERPROFILE '.copilot\extensions\jit-memory'
New-Item -ItemType Directory -Force -Path (Split-Path $dst -Parent) | Out-Null
Copy-Item -Recurse -Force $src $dst
```

Or, if you've already `cd`'d into the unpacked `jitmemdist` folder (so
`Get-ChildItem` shows `jit-memory`, `INSTALL.md`, `README.md`):

```powershell
# Run from inside the jitmemdist folder.
$dst = Join-Path $env:USERPROFILE '.copilot\extensions\jit-memory'
New-Item -ItemType Directory -Force -Path (Split-Path $dst -Parent) | Out-Null
Copy-Item -Recurse -Force .\jit-memory $dst
```

### Option C — macOS / Linux one-liner

Run from inside the unpacked `jitmemdist/` folder:

```bash
mkdir -p "$HOME/.copilot/extensions"
cp -R jit-memory "$HOME/.copilot/extensions/jit-memory"
```

### Verify the copy

```powershell
# Windows
Test-Path "$env:USERPROFILE\.copilot\extensions\jit-memory\extension.mjs"   # → True
```

```bash
# macOS / Linux
test -f "$HOME/.copilot/extensions/jit-memory/extension.mjs" && echo OK
```

## 2. Add the orchestration snippet to `copilot-instructions.md`

Open `~/.copilot/copilot-instructions.md` (create the file if it doesn't
exist) and paste the contents of `copilot-instructions.snippet.md` near the
**bottom**, after any user-context or project-preference sections.

The snippet contains:
- 5 capture-rule bullets (~10 lines of agent guidance)
- An empty `<!-- QR:BEGIN/END -->` block (Quick Rules — managed by the extension)
- An empty `<!-- KB:BEGIN/END -->` block (regenerated KB index — managed by the extension)

Both marker blocks should be present. If the extension finds the markers
missing on session start it will append empty pairs automatically (the
bootstrap step). It will only refuse to mutate them — and return
`invalid_setup` — if the markers are **malformed** (orphaned, duplicated, or
reversed END-before-BEGIN). For a fresh install, paste the snippet verbatim
and you'll be in the auto-repair-friendly state.

## 3. Verify

Restart the CLI (close and relaunch the application) so the extension is
discovered. Look at the startup banner — it should show
`Environment loaded: ... 1 extension ...` (the count includes any other
extensions you have).

Try a prompt that has no associated knowledge yet (e.g., "what's 2+2?"):
- Behind the scenes the extension's `onUserPromptSubmitted` hook fires,
  routes against the empty knowledge base, and returns no additional context.
- The prompt completes normally.
- This is the expected first-run state.

Capture a smoke-test lesson via the agent:

> Tell the agent: "Capture this lesson: 'tabs vs spaces: tabs cause whitespace
> issues in YAML → always use spaces.' Make it a Quick Rule."

The agent should call `jit_memory_capture({kind:"quick_rule", ...})`. After the
call, open `~/.copilot/copilot-instructions.md` — the rule should appear inside
the `<!-- QR:BEGIN/END -->` markers.

## 4. Optional: schedule the headless audit

The extension's `onSessionStart` hook surfaces digests that are <24 h old. For
typical interactive use, that's enough — you don't need a scheduler.

Schedule `node audit.mjs` only if you want **write-side maintenance** (archival
of files marked `deprecated:` >30 days ago). The session-start hook is
deliberately read-only.

### Windows Task Scheduler
```powershell
$ext = Join-Path $env:USERPROFILE '.copilot\extensions\jit-memory'
$node = (Get-Command node.exe).Source
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$ext\audit.mjs`""
$trigger = New-ScheduledTaskTrigger -Daily -At 6:00am
Register-ScheduledTask -TaskName 'JIT-Memory Audit' -Action $action -Trigger $trigger -Description 'Deterministic KB audit + archival'
```

### macOS / Linux (cron)
```cron
0 6 * * *  /usr/bin/env node "$HOME/.copilot/extensions/jit-memory/audit.mjs"
```

`audit.mjs` exits 0 unless an internal error occurs. A non-empty digest at
`~/.copilot/extensions/jit-memory/knowledge/_curator-digest.md` is **content**,
not a failure — monitor that file's mtime/content if you want notifications.

## 5. Troubleshooting

**The extension didn't load.**
Check the startup banner for an error or a 0-extension count. Restart the CLI
to see initial-load errors (the `safeHook`/`safeTool` wrappers throttle warnings
during normal operation, so the cleanest diagnostic is a fresh launch).

**`onUserPromptSubmitted` is slow.**
The router has a hard 500 ms timeout. Slow networked home directories or
antivirus on Windows can push routing close to the limit. The hook fails open —
your prompt always proceeds.

**Quick Rule capture returns `invalid_setup`.**
The `<!-- QR:BEGIN/END -->` markers are malformed in
`copilot-instructions.md` — orphaned (BEGIN without END or vice versa),
duplicated (more than one of either), or reversed (END appears before BEGIN).
Open the file and ensure exactly one matching pair, with BEGIN before END.
**Missing markers self-heal** on the next session start; only malformed states
require manual repair.

**Routing matches the wrong file.**
Tag substring matching uses word boundaries (`\b<tag>\b`). Aliases use plain
substring (≥3 chars). If a tag is too generic, edit the domain file's
frontmatter to make it more specific or call `jit_memory_capture` with
`kind: "alias_add"` to add a more specific alias.

**Where do I edit a captured lesson?**
Open the relevant file in `~/.copilot/extensions/jit-memory/knowledge/` and edit
freely. The next sync (triggered by any subsequent `jit_memory_capture` or
`jit_memory_audit`) will regenerate the routing cache.

**Restart required after edits?**
No — the router cache invalidates on `_routing.json` mtime change. The KB
table inside `copilot-instructions.md` is regenerated on the next sync; that
text is loaded once at session start, so the **agent's view** of the KB
table only refreshes next session. The router itself is always live.

## Uninstall

```powershell
# Windows
Remove-Item -Recurse -Force "$env:USERPROFILE\.copilot\extensions\jit-memory"
```

```bash
# macOS / Linux
rm -rf "$HOME/.copilot/extensions/jit-memory"
```

Then remove the snippet block from `~/.copilot/copilot-instructions.md` and
the scheduled task (if you created one). Nothing else is touched.
