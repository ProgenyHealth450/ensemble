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

- base: a small `scripts/ci-local.js` stand-in (same contract as the real one:
  exports `STEPS`, prints a `name PASS|FAIL seconds` table, exits non-zero on a
  failed step) running one step, `unit-check`, plus a minimal workflow that
  mirrors that step.
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
