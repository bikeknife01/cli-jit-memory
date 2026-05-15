# Installation

> **Privacy in 2 lines.** `jit-memory` saves lessons as plain-text Markdown files
> on your local disk and may include them in future Copilot prompts. **Do not
> capture passwords, tokens, customer data, private hostnames, or sensitive
> personal details.** The extension also runs a deterministic redaction scan
> at capture time, but you are the final line of defense.

## Quickstart (5 minutes, non-technical)

If you just want it working:

0. **Get the files.** Download or clone this repository to your computer:
   - **Easiest (no git needed):** open
     `https://github.com/bikeknife01/cli-jit-memory` in a browser, click
     **Code → Download ZIP**, unzip the file, and open the unzipped
     `cli-jit-memory` folder. You should see `INSTALL.md`, `README.md`,
     `copilot-instructions.snippet.md`, and a folder named `jit-memory`.
   - **With git:** `git clone https://github.com/bikeknife01/cli-jit-memory`
     and `cd cli-jit-memory`.

1. **Check you have the right version.** Open a terminal and run:
   ```
   copilot --version
   ```
   You should see `1.0.36` or higher. If the number is lower, try
   `copilot update`. If `copilot update` does not work for your install
   (managed by Homebrew, npm, your IT team, etc.), update Copilot CLI the
   same way you originally installed it, then re-open the terminal and
   re-check the version.

2. **Enable experimental features.** Extensions currently require
   experimental mode in Copilot CLI. Easiest path for non-technical users:
   ```
   copilot --experimental
   ```
   Launching once with this flag enables experimental mode and persists the
   setting. (If you prefer to do it from inside Copilot, start `copilot`
   normally and type `/experimental` at the Copilot prompt — that's a
   slash-command typed INSIDE Copilot, not a terminal command.)

   Experimental features are still in development and may change, break, or
   be removed without the same compatibility guarantees as stable features.

3. **Copy the extension folder.** From the unzipped/cloned `cli-jit-memory`
   folder you opened in step 0, copy the inner `jit-memory` folder (the one
   that contains `extension.mjs`) into:
   - **Windows:** `C:\Users\<your-username>\.copilot\extensions\`
     (paste `%USERPROFILE%\.copilot\extensions` into Explorer's address
     bar to navigate there. If `extensions` doesn't exist, create it.)
   - **macOS / Linux:** `~/.copilot/extensions/`

   When you're done, this exact file should exist:
   `~/.copilot/extensions/jit-memory/extension.mjs` (Windows:
   `C:\Users\<you>\.copilot\extensions\jit-memory\extension.mjs`).

4. **Add the snippet to your instructions file.** Use a **plain-text editor**
   (Windows Notepad and VS Code are fine; on macOS, if you use TextEdit,
   choose **Format → Make Plain Text** before saving — never save as `.rtf`).
   Open `~/.copilot/copilot-instructions.md` (create the file if it doesn't
   exist). Then open `copilot-instructions.snippet.md` from this package,
   **select all (Ctrl+A or ⌘+A) → copy → paste at the bottom** of your
   instructions file → save. It is fine to include the leading
   `<!-- jit-memory orchestration block ... -->` comment when you copy.

5. **Restart Copilot CLI.** Close it completely and start it again. Look at
   the startup banner — it should mention `... 1 extension ...` (or
   `2 extensions`, etc., if you have other extensions installed). Anything
   non-zero is healthy. If the banner says `0 extensions`, see Troubleshooting.

6. **Optional: retrofit existing notes.** If your instructions file already
   contains durable knowledge you want `jit-memory` to route and recall,
   open `retrofit-existing-instructions.md`, copy the text under `## Prompt`,
   paste it into Copilot CLI as one message, and press Enter. It creates a
   backup, presents a dry-run inventory you can approve, captures the
   approved items, and reports what moved. Skip this step if you don't have
   anything to migrate.

You're done. No `npm install`, no admin privileges, no extra software. The
detailed install instructions below cover edge cases, scheduling the audit
job, and troubleshooting.

---

The extension code lives at `~/.copilot/extensions/jit-memory/`. You drop
the `jit-memory/` directory in place and add ~15 lines to your global
instructions. That's the entire install.

**Where your data lives.** Captured knowledge files live OUTSIDE the
extension folder, at `~/.copilot/jit-memory/knowledge/` (Windows:
`C:\Users\<your-name>\.copilot\jit-memory\knowledge\`), so re-installing or
upgrading the extension never touches your data. If you are upgrading from
an older build that stored knowledge at `~/.copilot/extensions/jit-memory/knowledge/`,
the extension migrates the data on the next session start; you'll see a
one-time `kb migrated from ... → ...` notice.

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

## Dependencies

- **GitHub Copilot CLI v1.0.36 or later.** Verified on 1.0.36. Earlier 1.0.x
  versions may work but are not tested.
- **Node.js 20 or newer.** The CLI bundles its own Node for extension runtime,
  so you usually do not need a separate Node install unless you run development
  commands or the optional headless audit scheduler yourself.
- **Experimental features enabled.** Extensions currently require experimental
  mode. Run `/experimental` inside Copilot CLI to check status, see enabled or
  available experimental features, and enable or disable experimental mode. You
  can also turn it on by launching once with `copilot --experimental`; the
  setting is persisted afterward.
- **Zero npm packages.** The extension imports only Node built-ins (`node:fs`,
  `node:path`, `node:crypto`, `node:os`, `node:url`) and
  `@github/copilot-sdk/extension`, which is provided by the CLI. There is no
  `npm install` step and no `node_modules/` folder.

## 1. Install the extension

You can either copy the folder by hand or run a one-liner. Either way the goal
is identical: the `jit-memory/` directory from this package ends up at
`~/.copilot/extensions/jit-memory/` (so that
`~/.copilot/extensions/jit-memory/extension.mjs` exists).

The root package files (`README.md`, `INSTALL.md`,
`copilot-instructions.snippet.md`, and `retrofit-existing-instructions.md`) are
for setup and reference. They stay in the downloaded package/repository; only
the `jit-memory/` folder becomes the active extension.

When experimental features are enabled, the CLI auto-discovers extensions in
`~/.copilot/extensions/<name>/` on next startup — there is **no** registration
command to run.

### Option A — manual copy (any OS)

1. Open the cloned repository or downloaded package folder.
2. Copy the `jit-memory/` folder (the one containing `extension.mjs`).
3. Paste it into `~/.copilot/extensions/`. Create that folder if it doesn't
   exist. The final path must be `~/.copilot/extensions/jit-memory/extension.mjs`.

### Option B — Windows PowerShell one-liner

Open PowerShell (any working directory is fine — the script uses an absolute
path) and run, replacing `<path-to-cli-jit-memory>` with where you cloned or
unpacked this package:

```powershell
$src = 'C:\path\to\cli-jit-memory\jit-memory'       # ← the source folder containing extension.mjs
$dst = Join-Path $env:USERPROFILE '.copilot\extensions\jit-memory'
New-Item -ItemType Directory -Force -Path (Split-Path $dst -Parent) | Out-Null
Copy-Item -Recurse -Force $src $dst
```

Or, if you've already `cd`'d into the cloned repository or package folder (so
`Get-ChildItem` shows `jit-memory`, `INSTALL.md`, `README.md`):

```powershell
# Run from inside the repository/package folder.
$dst = Join-Path $env:USERPROFILE '.copilot\extensions\jit-memory'
New-Item -ItemType Directory -Force -Path (Split-Path $dst -Parent) | Out-Null
Copy-Item -Recurse -Force .\jit-memory $dst
```

### Option C — macOS / Linux one-liner

Run from inside the repository/package folder:

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
- A compact capture-guidance block
- An empty `<!-- QR:BEGIN/END -->` block (Quick Rules — managed by the extension)
- A `<!-- KB:BEGIN/END -->` block (domain/file signpost — regenerated by the extension)

Both marker blocks should be present. If the extension finds the markers
missing on session start it will append managed stubs automatically (the
bootstrap step). It will only refuse to mutate them — and return
`invalid_setup` — if the markers are **malformed** (orphaned, duplicated, or
reversed END-before-BEGIN). For a fresh install, paste the snippet verbatim
and you'll be in the auto-repair-friendly state.

## 3. Verify

Restart the CLI (close and relaunch the application) so the extension is
discovered. Scroll up to the startup banner near the top of the new session. It
should include a line like:

```text
Environment loaded: ... 1 extension ...
```

The count includes any other extensions you have, so `2 extensions` is also OK
if another extension is installed.

If the extension count is 0, run `/experimental` inside Copilot CLI and confirm
experimental mode is enabled, then restart again.

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
deliberately read-only. Scheduled jobs need a system-wide Node.js 20 or newer;
if you do not have one, skip this section.

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

`audit.mjs` exits 0 unless an internal error or sync-drain timeout occurs;
it exits 2 if knowledge migration is unresolved. A non-empty digest at
`~/.copilot/jit-memory/knowledge/_curator-digest.md` is **content**,
not a failure — monitor that file's mtime/content if you want notifications.

## 5. Troubleshooting

**The extension didn't load.**
Check the startup banner for an error or a 0-extension count. Run
`/experimental` to confirm experimental mode is enabled and to see which
experimental features are enabled or available. Restart the CLI to see
initial-load errors (the `safeHook`/`safeTool` wrappers throttle warnings during
normal operation, so the cleanest diagnostic is a fresh launch).

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
Tags must be 2-40 characters; if you upgrade from an older build that allowed
one-character tags, edit those tags to longer values so the files continue to
route.

**Where do I edit a captured lesson?**
Open the relevant file in `~/.copilot/jit-memory/knowledge/` and edit
freely. The next sync (triggered by any subsequent `jit_memory_capture` or
`jit_memory_audit`) will regenerate the routing cache.

**Restart required after edits?**
No — the router cache invalidates on `_routing.json` mtime change. The compact
domain/file signpost inside `copilot-instructions.md` is regenerated on the
next sync; that text is loaded once at session start, so the **agent's view** of
the signpost only refreshes next session. The router itself is always live.

## Uninstall

```powershell
# Windows: remove the extension code and (optionally) the data
Remove-Item -Recurse -Force "$env:USERPROFILE\.copilot\extensions\jit-memory"
# Optional — also delete your captured knowledge (this is your data, not code):
Remove-Item -Recurse -Force "$env:USERPROFILE\.copilot\jit-memory"
```

```bash
# macOS / Linux
rm -rf "$HOME/.copilot/extensions/jit-memory"
# Optional — also delete your captured knowledge:
rm -rf "$HOME/.copilot/jit-memory"
```

Then remove the snippet block from `~/.copilot/copilot-instructions.md` and
the scheduled task (if you created one). If you created a Task Scheduler job:

```powershell
Unregister-ScheduledTask -TaskName 'JIT-Memory Audit' -Confirm:$false
```

If you added a cron entry, edit your crontab with `crontab -e` and remove the
`jit-memory` line.
