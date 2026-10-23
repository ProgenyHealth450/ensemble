---
name: git-town
description: Use when creating feature branches, stacked branches, syncing, proposing PRs, or shipping with the git-town CLI. Covers the commands Ensemble workflows call and repo conventions.
version: 2.0.0
---

# Git Town

Verified against git-town 24.0.0. Ensemble requires >= 14.0.0.

## Toolchain Capability

`git-town` is also the `git-town` **workflow** adapter in the capability toolchain (TRD-039): `packages/git/skills/adapter-workflow-git-town/` maps `workflow.branch-create`/`workflow.sync`/`workflow.propose`/`workflow.ship` onto the `hack`/`sync`/`propose`/`ship` commands documented below, plus plain `git commit`/`git push`/`git status --porcelain` for the generic `workflow.commit`/`workflow.push`/`workflow.status` primitives every `workflow`-category adapter must implement (git-town itself has no standalone subcommand for those three). Commands should call these capabilities via `toolchain-cli` rather than invoke `git town`/`git` directly; the vocabulary below documents what each capability resolves to.

## Preflight

`scripts/validate-git-town.sh` checks install, version and that the cwd is a git repo. Exit codes: 0 ok, 1 not installed, 2 not configured (non-fatal: git-town falls back to the git main branch), 3 version < 14, 4 not a git repo. `implement-trd-beads`, `beads-build` and `implement-bead` feed the code to `trd-cli resolve-sdlc`, which falls back to plain `git` when git-town is unavailable.

## Commands used by Ensemble

Always pass `--non-interactive` where supported; never rely on prompts.

| Need | Command |
|---|---|
| New branch off main | `git town hack <branch>` |
| New branch stacked on current branch | `git town append <branch>` |
| Sync current branch with ancestors and remote | `git town sync` (`--dry-run` previews) |
| Open PR against the parent branch | `git town propose --title <t> --body <b>` (`--stack` proposes the whole stack, `--no-browser` suppresses the browser) |
| Ship into parent | `git town ship` (`--strategy` overrides the configured `ship-strategy`; direct children of main only unless `--to-parent`) |
| Re-parent a branch | `git town set-parent` (`--none` makes it perennial) |
| Show parent / config | `git town config get-parent`, `git town config` |

`hack`/`append` also take `--prototype` (branch not synced with its parent), `--no-sync`, `--propose`, `-m` (commit stashed changes) and `--stash`/`--no-stash`.

After a conflict during `sync`/`ship`, resolve files, `git add`, then `git town continue`; `git town undo` reverts the last git-town command. Both exist in 24.0.0 (`git town --help`).

## Stacked PRs

Each `### PR N:` TRD section is one branch: `hack` for PR 1, `append` for each later PR so git-town records parentage. Merge PRs in order; once PR 1 merges, git-town retargets PR 2 to its new parent on the next `sync`/`propose`. Creating branches with plain `git switch -c` records no parent, so `sync`/`propose` cannot retarget. See `docs/guides/stacked-prs.md`.

## Config conventions

- Main branch is `main` (`git config git-town.main-branch`); `dev` is stacked on `main` here, and feature branches record `dev` as parent. Use `git town set-parent` when a branch was created without git-town.
- Config lives in git config (`git-town.*`); `git town init` is interactive, so agents must set keys with `git config` instead.
- `propose` on self-hosted forges needs `git config git-town.forge-type <github|gitlab|gitea|bitbucket>`.
- `ship` deletes the tracking branch unless `ship-delete-tracking-branch` is disabled; disable it if the remote auto-deletes shipped branches.

## Gotchas

- `propose` syncs first; commit or stash before running it.
- `ship` into a non-main parent is refused without `--to-parent`; ship or delete ancestors first.
- `git town` is a git subcommand of the `git-town` binary; either spelling works in 24.0.0.
