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
| `dev` | Local dogfooding aggregation: `main` plus branches still in flight upstream. | By hand; reset rather than merged |
| `feature/*` | Real contributions. Cut from `main`, PR'd to **Sunstone-Partners/ensemble**, never merged here. | Contributors |

Install from an explicit ref — `ProgenyHealth450/ensemble#stable` for normal use,
`#dev` to dogfood work that has not merged upstream yet. Do not add the marketplace
without a ref; you would get this branch.

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
   a quiet day costs one API call. The gate clones with `core.symlinks=false`, the way a
   teammate's machine does, then checks that no path contains `:` and that
   `.claude-plugin/marketplace.json` parses as JSON. No npm install, so it finishes in
   about a minute.
3. **Advance `stable`** to exactly the commit the gate tested. Fast-forward only.

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
Windows clone materializes every one of them as a short text file. Four of them are
whole-directory mirrors, which is why the validator reports exactly four failures rather
than ninety-seven — the individually-linked ones still "exist" as files and pass a
plain existence check.

That is a real defect in the `ensemble-full` bundle on Windows and worth an upstream fix,
but it does not stop the marketplace installing, and gating `stable` on it would freeze
the ref indefinitely. This gate blocks only on what actually breaks installation.
