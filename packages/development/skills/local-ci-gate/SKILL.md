---
name: local-ci-gate
description: Run or check the local CI gate for a PR head. Runs ci:local in a clean clone at the exact head SHA via the runner, posts a signed commit status, and decides merge-readiness without waiting for hosted CI. Use before merging a PR in a repo with .ensemble/local-ci.yaml; not for hosted-CI debugging.
---

# Local CI Gate

Order the steps of the local CI gate for one PR head and report the outcome.
This skill only sequences, calls `local-ci-cli.js` and reports. It never runs
CI, never checks out or edits the working tree and never grades results: the
runner (`local-ci-runner.js`, driven by the CLI) owns the clean clone, the CI
run and its cleanup, and the CLI computes every verdict. Editable approval set
and trusted command list: `.ensemble/local-ci.yaml` as committed at the PR's base
branch ref (never the working tree).

---

## Inputs

| Variable | Type | Description |
|---|---|---|
| `MODE` | `'gate'` \| `'check'` | `gate`: run CI and post the status. `check`: only decide whether the PR may merge now. |
| `HEAD_SHA` | string | Full 40-hex PR head commit, resolved before starting (never a branch name). |
| `REPO` | string | `owner/name`, needed to post or read statuses. |
| `DRY_RUN` | boolean | `gate` only. Report merge-readiness and post nothing. |

---

## Locate the CLI

Resolve `LOCAL_CI_CLI` with the `tool-path-resolution` skill
(`skill://tool-path-resolution`), `RELATIVE_PATH=packages/development/lib/local-ci-cli.js`:
git top-level, then CWD-relative, then `${CLAUDE_PLUGIN_ROOT}/lib/local-ci-cli.js`,
then the Pi/OMP bundle `vendor/lib/local-ci-cli.js`. If no tier resolves, stop
and say the CLI could not be found; never merge on that basis.

Every call is `node "$LOCAL_CI_CLI" <subcommand>` with one JSON payload on
stdin and one JSON object on stdout. Exit 1, or `ok:false`, or `{error}` is a
refusal. Payloads over 1 MiB or malformed JSON are rejected with no effect.

---

## Procedure

### `check` (merge-readiness)

1. Fetch the commit statuses for the PR head and recent commits, for example
   `gh api repos/$REPO/commits/$HEAD_SHA/status` plus the statuses of earlier
   PR commits, as `[{context, state, description, sha}]` (`sha` = commit the
   status is on).
2. `merge` with `{headSha, statuses, repoRoot, baseRef}` (add `reviews` when known).
   `baseRef` is the PR's base branch, fetched fresh first (for example
   `git fetch origin $BASE_BRANCH`, then `origin/$BASE_BRANCH`); it is required.
3. `mergeReady:true`: report ready to merge **without waiting for hosted CI**,
   quoting the record. `mergeReady:false`: report the CLI `reason` verbatim and
   refuse. Typical reasons: no local status (name the missing run and tell the
   user to run `gate` for `HEAD_SHA`); head moved (the reason names both SHAs;
   run `gate` again for the new head); status not success; blocking review.

### `gate`

1. `gate` with `{repoRoot, headSha, baseRef, repo, dryRun}` (`baseRef` as for
   `merge`: the freshly fetched `origin/<baseRefName>`). The CLI orders: prerequisites
   (Node, git), config, run, record, post.
2. Read the result and report, in this order of precedence:
   - `prerequisite` set: say which prerequisite is missing and that nothing was
     run or posted. Do not fall back to merging.
   - `cannotAttest:true`: say the gate cannot attest (no GitHub App
     credential), that nothing was published and the merge is refused.
   - `failures` non-empty: list each with workflow, job, step, node and the
     exact head SHA (full 40 hex), plus `message`. A failing or unsupported step
     is never success; at most a failure status was posted.
   - `error` without failures (unfetchable head, unprovidable Node,
     malformed config): report it as a refusal.
   - `dryRun` and `mergeReady:true`: report readiness, state that nothing was
     posted.
   - `posted:true`, `mergeReady:true`: report the record and that the PR is
     mergeable without hosted CI.
3. Never retry with a different SHA, never post by hand, never edit the config
   to make a step pass. Never pass `config`, `path`, `runner` or any key other
   than the four above: unknown keys are rejected. A step the runner cannot mirror is a gap to report to
   the user, who may record it in `.ensemble/local-ci.yaml` `excluded_steps`.

---

## Trust and provenance

Required commands and the approval set come ONLY from `.ensemble/local-ci.yaml`
as committed at the PR's BASE branch (`git show <baseRef>:.ensemble/local-ci.yaml`),
the same principle as GitHub's `pull_request_target`. A PR that edits the gate
config or its workflows is graded by the PREVIOUS config; its change applies
after it merges. The maintainer's working tree, local edits and checked-out
branch are irrelevant.

`baseRef` is required (`config`, `run`, `merge`, `gate`) and must be a
remote-tracking ref of the PR's base branch, fetched fresh: `origin/<branch>`
or `refs/remotes/<remote>/<branch>`. Local branches, SHAs, `HEAD`, `@`, and any
revision syntax (`@{n}`, `^`, `~`, `:`, `..`) are refused, because the PR author
can move a local branch or a descendant of the head. The CLI also refuses a base
that is the head, a descendant of the head, or shares no history with it.

`steps` lists the exact commands, in order. The runner runs each itself in the
clean clone, once per required Node version, under `bash -e -o pipefail` (as
GitHub Actions does, so a failure in the middle of a step fails it). PASS is an
exit status of exactly 0 that the runner observed; a signal, a missing status or
a failed start is a failure. Nothing in the PR head (`scripts/ci-local.js`,
printed tables, its own config) is loaded, executed or believed. A head workflow
step that `steps`/`equivalents` do not cover fails the gate; a head dropping a
step from its own workflow changes nothing; a workflow file that resolves
outside the clone is refused. After the steps the run is voided if any tracked
file differs from the head's tree (compared by content, which `git status` is
not), the index changed, the HEAD moved or the clone's git config changed.
Untracked output (`node_modules`, `coverage/`) is fine.

Steps run under a minimal environment (PATH, HOME, CI, LANG, TERM, TMPDIR and a
few more). A step sees a secret only if its NAME is in the base-ref config's
`secret_names`; the value comes from the maintainer's environment or the
gitignored `.ensemble/local-ci.secrets.env`, never from the config, the head or
the payload. Values of configured secrets, and of any inherited variable whose
name contains TOKEN, SECRET, KEY, PASSWORD, CREDENTIAL or AUTH, are redacted
from everything returned. A step can still print or send a secret it was given
in a form redaction cannot recognise (encoded, split); list only secrets you
accept a trusted step handling.

The payload cannot carry config, paths, scripts or runner options (`gate`:
`repoRoot, headSha, baseRef, repo, dryRun`; `merge`: `headSha, statuses,
repoRoot, baseRef, reviews`); other keys are rejected. The status record's first
field is the first 12 hex of the git blob hash of the base-ref config, which
covers the whole command list; `merge` requires it and refuses a status recorded
under a different config blob.

---

## Other subcommands

`config` validates the base-ref file (`{repoRoot, baseRef}`) or a `{source}` text,
`record` builds/parses/verifies the status
description, `run` (`{repoRoot, headSha, baseRef}` only) runs the runner without posting, `post` posts one status,
`review` classifies reviews (bots never block), `sweep` lists unrecorded
findings and CI failures, `timing` checks the enablement note. Use them only
when a command asks; they carry the same fail-closed rules.

---

## Rollout, rollback and the pre-PR step

Enabling the gate as a required check, rolling it back, the owner approvals and
the optional pre-PR gate step (run `gate` for the branch head, then open the PR)
are in `RUNBOOK.md` beside this file. Enablement is refused until its
preconditions hold; never change branch protection from this skill.

---

## Rules

- Success exists only as a status posted by the CLI on the exact head.
- Report CLI output as given; do not soften, reinterpret or truncate SHAs.
- No credential, secret or key is ever printed; the CLI redacts, so do not
  re-read credential files.
- Hosted CI is not consulted for readiness; mention it only if asked.
