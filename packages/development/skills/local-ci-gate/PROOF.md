# Local CI gate: gate-can-fail proof (TRD-006)

Date: 2026-10-21

Purpose: show that the gate is not a rubber stamp. With one unchanged
configuration it must FAIL on a deliberately failing commit and PASS on the
commit that fixes it, through the real code path.

## What was run

Command (from `packages/development`, Node 22):

```
npx jest tests/local-ci-gate-can-fail.test.js
```

The test builds a real git repository in a temp directory with three commits
and one configuration (`.ensemble/local-ci.yaml`, one required workflow job,
one Node major, status context `ensemble/local-ci`):

- base: a trusted `steps` list in `.ensemble/local-ci.yaml` with one command,
  `unit-check` (`node scripts/unit-check.js`), run by the runner itself and graded
  only by its exit status, plus a minimal workflow that mirrors that command.
- F: `unit-check` made to fail (an `assert` that cannot hold).
- P: `unit-check` fixed.

It then drives, for F and then P:

- `runGateFlow` from `lib/local-ci-cli.js` (preflight, config, run, record,
  post), which calls
- the real `runGate` from `lib/local-ci-runner.js`: a real `git clone` at the
  exact head SHA, a real subprocess, the real non-zero exit;
- the real `postStatus` and `loadCredential` from `lib/local-ci-app.js`, signing
  with a throwaway RSA key generated in memory for the run. Only the network
  `fetch` is faked, by an in-memory recorder of status posts;
- the real `runMerge` to decide merge readiness from the recorded statuses.

Node binaries were not downloaded: the runner was given the Node that runs the
test, and the configured Node major is that same major, so the runner's
`node --version` check is satisfied honestly. No `npm ci` ran.

## Outcome at F (failing commit)

- The gate reported failure, naming the step `unit-check` and the exact head SHA
  of F. `mergeReady` was false.
- The only status posted was `failure`, on F's SHA, in context `ensemble/local-ci`.
- `runMerge` refused F.

## Outcome at P (passing commit, same configuration)

- The gate reported success; one `success` record was posted, on P's SHA.
- `runMerge` accepted the record for P and, given only that success record,
  refused it for F's head SHA.
- Across both runs exactly two statuses were posted: `failure` for F, then
  `success` for P.

One configuration, two outcomes: the check can fail and can pass.

## Adversarial review (2026-10-21) and what it changed

The proof above uses a cooperative head, so on its own it says nothing about a
hostile one. An independent review of the whole branch, and attacks reproduced
against the real modules, found that the first design could be made to approve a
head whose own checks fail:

- The runner believed a `name PASS` table printed by the head's own
  `scripts/ci-local.js` (and loaded that file). A head that printed PASS rows
  while `npm run lint` and `npm run test` failed was approved.
- The approval set came from the working tree, or from the caller's payload. With
  the PR branch checked out, a PR that rewrote `.ensemble/local-ci.yaml` and its
  own workflow so the required command was `true` was approved.
- A multi-command step graded by `bash -c` passed when a middle command failed,
  which hosted CI fails.
- A workflow file committed as a symlink was read from outside the clone.

These are fixed and each has a test that fails on the old behaviour
(`local-ci-adversarial`, `local-ci-trust`, `local-ci-baseref`): the runner runs a
trusted command list itself and grades only the exit status it observes, under
`bash -e -o pipefail`; the list comes only from `git show <baseRef>:.ensemble/local-ci.yaml`
(the PR's base branch), never the working tree, the clone or the payload; the
head cannot be its own base; a workflow that resolves outside the clone is refused.

A second review of the fixed branch found further holes, each reproduced against
the real modules and now fixed with a test that fails on the old behaviour:

- A PR author could pick a base that is a descendant of the head, and so one whose
  committed config they control. A base that is the head or a descendant of it is
  refused.
- `baseRef` was resolved with `git rev-parse`, so a local branch, a SHA or a
  reflog spelling could stand in for the PR's base. It must now be a
  remote-tracking ref (`origin/<branch>` or `refs/remotes/<remote>/<branch>`),
  checked with `git show-ref --verify`.
- A step could edit a tracked file, rewrite the index or the clone's git config,
  or hide changes with `assume-unchanged`/`skip-worktree`, and still pass. The
  run is voided if tracked content, the index, HEAD or the clone's git config
  differ afterwards (compared by content, since `git status` can be told to
  lie). Untracked output is allowed because honest steps write it.
- The status record bound only 8 hex of the config blob and tolerated its
  absence. It carries 12 hex and `merge` refuses a record without it.
- `secret_names` could not actually be configured, so a step that needed a
  secret had no way to receive it. Names come from the base-ref config only; values
  from the maintainer's environment or a gitignored file, and are redacted.

Residual trust: `baseRef` is taken from GitHub's `baseRefName` for the PR, which
an author chooses among existing branches. A branch protected less strictly than
`dev` and targeted by a PR would be graded by its own config. Branch protection,
not this gate, decides which branches may be targeted.

This is evidence the gate resists the specific hostile heads above. It is not a
proof that no other hostile head exists.

## Credentials

No credential appears in this note or in the repository. The signing key existed
only in memory for the duration of the test. The test asserts this file is
unchanged by the repository's `redact` (no token- or PEM-shaped text).

## Not proven

- A full real `ci:local` run against a real PR head (`npm ci`, Node 22 and
  Node 24, the repository's real suites) has NOT been done.
- The two-version Node matrix (22 and 24) that this repository's real config
  requires was NOT exercised: the stand-in config required a single Node major,
  the one running the test. The runner's per-version resolution and its "a
  version that cannot be provided fails the gate" path are covered by the
  runner's own tests, not by this proof.
- A real GitHub status post by the real GitHub App has NOT been done; the proof
  above used a fake `fetch`. No real network call was made.
- Therefore this note does not by itself justify enabling the gate on a
  protected branch; the live proof (a real PR head, a real post, and the
  branch-protection behaviour) is still open.
