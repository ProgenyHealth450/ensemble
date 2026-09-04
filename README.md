# ProgenyHealth450/ensemble

A **distribution mirror** of [Sunstone-Partners/ensemble](https://github.com/Sunstone-Partners/ensemble),
not a place where ensemble is developed. Contributions go upstream; this fork exists so the
ProgenyHealth team has a ref it controls to install plugins from.

You are on `automation`, the default branch, which holds only this README and the sync workflow.
The interesting refs are below.

## Refs

| Ref | What it is | Who touches it |
|---|---|---|
| `stable` | What the team's plugin marketplace clones. Byte-identical to some vetted upstream commit. | The sync workflow, only after the Windows gate passes |
| `main` | Byte-pure mirror of upstream `main`. Base for `feature/*` branches. | The sync workflow (fast-forward only) — **never commit here** |
| `dev` | Dogfooding: `main` plus every open PR, **rebuilt** each run. | The sync workflow — **never commit here**, a rebuild discards it |
| `feature/*` | Real contributions. Cut from `main`, PR'd to **Sunstone-Partners/ensemble**, never merged here. | Contributors |

**Installing or updating the plugins? See [TEAM-SETUP.md](TEAM-SETUP.md)** — the steps
everyone should follow. The reasoning behind the ref topology lives here; that file is
just the procedure.

Install from an explicit ref — `#stable` for normal use, `#dev` only for deliberate
dogfooding of work that has not merged upstream. Do not add the marketplace without a
ref; you would get this branch, which carries no plugins.

## Why `automation` is the default branch

GitHub only fires `schedule:` triggers from a repository's default branch, so the sync
cron has to live on whichever branch is default. It cannot be `main`: that branch is a
byte-pure mirror, and any file added to it would ride along on every `feature/*` branch
cut from it and appear in the diff of every PR sent upstream. So the default branch is
this small one instead, and `main` stays clean.

## What the sync workflow does

Daily at 07:17 UTC, and on demand via **Actions → Sync from upstream → Run workflow**:

1. **Fast-forward `main`** from upstream, unconditionally. Uses GitHub's `merge-upstream`
   API, which refuses to clobber a diverged fork, then asserts `main == upstream/main`
   afterwards rather than trusting the response.
2. **Gate the commit on `windows-latest`** — but only if `stable` is actually behind, so
   a quiet day never starts the Windows runner. The gate clones with `core.symlinks=false`, the way a
   teammate's machine does, then checks that no path contains `:` and that
   `.claude-plugin/marketplace.json` parses as JSON. No npm install, so it finishes in
   about fifteen seconds.
3. **Advance `stable`** to exactly the commit the gate tested. Fast-forward only.
4. **Rebuild `dev`** as `main` + every open PR authored by the maintainer, in parallel with
   the gate — dev is for dogfooding, so it tracks `main` even on a commit `stable` is not
   allowed to have. Pushes only if the resulting tree actually differs.

If the gate fails, `stable` is left where it is and the run fails, which emails whoever
last edited the cron. `main` still moves — it is a mirror, and nothing installs from it.

## Why the gate exists

Both checks encode a bug that actually shipped:

- **Colon paths** — upstream once had 38 files under `SessionLogs/` with `:` in the name.
  Those cannot exist on NTFS, so `git clone` aborted on every Windows machine and the
  marketplace was uninstallable org-wide. Fixed upstream in PR #13.
- **The manifest as a symlink** — upstream briefly made `.claude-plugin/marketplace.json`
  a symlink to `../marketplace.json` to make version drift structurally impossible. On a
  `core.symlinks=false` checkout that becomes a 19-byte text file containing the literal
  string `../marketplace.json`, so Claude Code reads it instead of JSON and the entire
  marketplace fails to load. Fixed upstream in PR #51, which also added an `lstat` guard
  to `validate-all.js` so CI catches a recurrence.

Upstream CI runs on Linux, where both problems are invisible. That is the gap this gate
covers, and it is the reason `stable` is a separate ref from `main` at all.

## What the gate deliberately does not check

`npm run validate` is not run here. Upstream CI already runs it on ubuntu, and the only
Windows-specific thing it adds is a `packages/full/skills/` check that is permanently red
on a `core.symlinks=false` checkout: **97 paths under `packages/full/` are symlinks**, so a
Windows clone materializes every one of them as a short text file.

The validator nonetheless reports only **four** failures, which understates the damage
rather than bounding it. Most skills have an individually-named entry under
`packages/full/skills/`, and a text file still satisfies a plain existence check, so they
pass spuriously. The four that fail — `dotnet-framework`, `framework-detector`,
`test-detector`, `git-town` — are the only ones reachable *solely* through one of the 13
whole-package mirrors (`packages/full/skills/core -> ../../core/skills` and friends), and
you cannot traverse into a text file. Read "4 errors" as "the symlinks are broken", not as
"4 skills are broken".

That is a real defect in the `ensemble-full` bundle on Windows and worth an upstream fix,
but it does not stop the marketplace installing, and gating `stable` on it would freeze
the ref indefinitely. This gate blocks only on what actually breaks installation.

## Why `dev` is rebuilt rather than merged

`dev` is not a mirror, so it cannot be fast-forwarded: it is `main` plus whatever is
still in flight. The tempting approach is to keep merging `main` into it, and that is
what rots. Work merges upstream under a *different SHA* than the copy already sitting on
`dev`, so `dev` ends up holding duplicate-content commits that re-conflict on every later
merge — which is exactly how it had to be steamrolled by hand on 2026-08-23.

Rebuilding removes the failure mode by construction. `dev` is recomputed from `main` plus
the currently-open PRs, so a PR merging upstream simply drops off the list and its content
arrives via `main` instead. Nothing accumulates.

**The trade: `dev` is disposable.** Anything you want on it has to exist as a branch or an
open PR. Commit to `dev` directly and the next run throws it away.

If an open PR conflicts with the rebuild, `dev` is left exactly where it was and the run
fails naming the PR. Fix it by rebasing that PR, or close the PR to drop it from `dev`.
`main` and `stable` are unaffected either way — the rebuild is a separate job.

## Do not click "Sync fork"

That button syncs the repository's **default branch**, which is this one. On
2026-08-23 it was used here and overwrote the sync workflow with a copy of upstream
`main`, taking the automation out until it was restored by hand. `automation` now has
branch protection to make that fail loudly instead of silently.

Nobody needs it: the workflow already keeps `main`, `stable`, and `dev` current, and it
runs on demand from **Actions → Sync from upstream → Run workflow**.

## If the sync goes quiet

GitHub disables scheduled workflows after **60 days without repository activity**, with a
warning email first. That is the first thing to check if the refs start drifting and no
runs appear — it fails silently in the sense that nothing goes red; the cron simply stops.
Re-enable it from the Actions tab.

## What a sync cannot refresh

The workflow moves refs on GitHub. It never touches anyone's machine, so every kind of
derived state is refreshed locally or not at all. There are only two, and they affect
different people.

**The plugin cache**, under `~/.claude/plugins/cache/`. This is what everyone has, and
TEAM-SETUP.md's Update section is the whole procedure: `marketplace update`, then
`/ensemble:reinstall-plugins`, then restart. Note that `claude plugin update` is not a
substitute — it gates on the plugin's declared version, so when upstream changes a
command's content without bumping that number, it reports success and installs nothing.
That is the failure this mirror exists to make visible, and it is why the update step is
an uninstall-and-reinstall.

One sharp edge: uninstalling a plugin can leave its cache directory behind. Claude Code
keeps reading it, so the plugin's agents and commands stay available even though
`claude plugin list` does not mention it — and then disappear the moment something prunes
the directory. An agent that exists in one session and not the next, surviving a restart,
is almost always this. TEAM-SETUP.md carries a check.

**Compiled output**, which only matters if you cloned the repo. `dist/` is gitignored, so
`git pull` never refreshes it. Exactly one script in the monorepo executes anything from a
gitignored build directory — `packages/pi`'s `generate` runs `node dist/index.js` — and
until upstream PR #64 lands it does not build first. A stale `dist/` there fails silently
and plausibly: on 2026-09-03 a nine-day-old build ran against current sources and wrote 44
files into a namespace upstream had deleted, then bumped a version off that output. It
exits 0. `packages/opencode` also compiles, but nothing ever runs its `dist/`, so it needs
no pre-build.

Dependencies are the ordinary third case: when a pull moves `package-lock.json`,
`node_modules` is stale, and the symptom is test failures that look unrelated to the pull.
