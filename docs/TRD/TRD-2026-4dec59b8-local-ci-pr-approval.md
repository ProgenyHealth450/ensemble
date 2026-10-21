---
document_id: TRD-2026-4dec59b8
label: trd-local-ci-pr-approval
kind: trd
prd_reference: docs/PRD/PRD-2026-4dec59b8-local-ci-pr-approval.md
version: 1.0.2
status: Draft
date: 2026-10-21
design_readiness_score: 4.25
Constitution compliance: passed
---

# TRD-2026-4dec59b8: Local-CI PR Approval

Based on PRD: docs/PRD/PRD-2026-4dec59b8-local-ci-pr-approval.md (v1.0.1, Locked)

## Architecture Decision

**Chosen approach (Option C):** A `local-ci-gate` skill owns the editable procedure; a small set of pure-JS helpers in `packages/development/lib/` owns only what must be unforgeable; `pr-merge.yaml` invokes the skill.

- `packages/development/skills/local-ci-gate/SKILL.md` is the single reusable procedure and owns everything a maintainer would plausibly tune (Constitution Rule 8): the order of the run, the messages, the bead wording, and how failures are explained.
- Pure-JS modules in `packages/development/lib/` own only what grades a claim or protects a boundary (Rules 7 and 8's enforcement exception): run-record verification, bot-vs-human classification, bead dedupe keys, approval-set config validation, and GitHub App credential handling. They make no network calls except the one module whose purpose is to post a status.
- `packages/git/commands/pr-merge.yaml` calls the skill at its existing Merge phase. It does not restate gate logic.
- The gate runs in-session in the maintainer's own process. There is no daemon, scheduler or background sweep (Rule 4; REQ-012).

**Alternatives considered (user chose C):**

- **Option A -- prose-only:** fewest files, but head-binding, run-record verification and human/bot classification would be prose a model can misread, and tests could only assert wording. Rejected: the PRD's core property is that evidence cannot be reused across commits.
- **Option B -- TypeScript runtime in agent-core:** strongest typing, but adds a build/dist surface and pulls editable criteria toward code against Rule 8. Rejected: the one place a real client is tempting (App JWT signing) needs only Node's built-in `crypto`.

**Dependency decision (user approved):** no new dependency. The App's RS256 JWT is signed with Node `crypto`; the REST calls use `fetch`. This avoids the constitution's new-dependency approval gate and keeps the signing path small and auditable.

**Rationale:** Option C matches repository precedent (TRD-2026-82b6a138), keeps editable behavior out of TypeScript, and is the minimum code that makes the trust properties testable.

## Domain Analysis

| Domain | Present? | Notes |
|---|---|---|
| Skill/prompt content | Yes | New `local-ci-gate` skill; edits to `pr-merge.yaml`; per-repository config file |
| Library/CLI (Node.js) | Yes | `local-ci-*.js` modules and a `local-ci-cli.js` entry in `packages/development/lib/` |
| Data model | No | Per-run record is a status description string; the sweep ledger is bead labels. No schema/migration. |
| Infrastructure / external services | Yes | GitHub REST (statuses, App installation token); Docker + `act` on the maintainer's machine |
| Security | Yes | App private key; status forgery; untrusted review text; secrets in `act` runs |
| Packaging/generation | Yes | Pi vendor bundle (`lib-bundler.ts` `ENTRY_FILES`), Pi/Codex/markdown generators |

**Greenfield or brownfield:** brownfield.

**COMPANION_DOMAINS:** empty. No persistence-schema change, and the architecture alternatives are recorded inline, not a vendor/tool comparison.

## Companion Artifacts

No companion artifacts generated.

## Reused Capabilities

No foundational TRD capabilities matched (`trd-graph-cli capabilities docs/TRD`). Existing code reused or deliberately not reused:

- **Reused:** the `tool-path-resolution` skill (locating `local-ci-cli.js` across checkout, plugin and Pi bundle); the `pr-review-state.js` `redact()` convention; the facts shape of `pr-review-remote.js` (reviews, comments, threads, check runs with `commitSha`) for the late-finding sweep input; `act-local-ci` skill for the `act` invocation guidance.
- **Deliberately not reused as a gate:** `pr-review-remote.js` `evaluateRemoteReview`. It is fail-closed and makes bot review blocking and head-bound, which is the opposite of REQ-006. It remains correct for `fix-issue` and `implement-trd-beads`, which this TRD does not change.

## System Architecture

### Components and boundaries

1. **`SKILL.md` (local-ci-gate)** -- orchestrates a gate run: resolves the PR, fetches the head SHA, creates the clean checkout, invokes `act`, calls the CLI to build and verify the run record, publishes the status, and reports. The only component that talks to `git`, `gh`, `act` and Docker.
2. **`local-ci-config.js`** -- validates the per-repository config (approval set, excluded jobs, status context name, bot-review handling, tracker). Fails closed on unknown or missing fields (AC-017-3).
3. **`local-ci-record.js`** -- builds and parses the run record carried in the status description (head SHA, workflow set, `act` version, log digest) and verifies it against the PR head and configured set (AC-004-5, AC-004-6, AC-003-1/2).
4. **`local-ci-app.js`** -- the only network module: signs the App JWT with `crypto`, exchanges it for an installation token, posts the status. Reads the credential from the environment or a gitignored path, never logs it (REQ-018).
5. **`local-ci-review.js`** -- classifies review authors by GitHub account `type` (Bot vs User), never by name, and decides whether a review set blocks (AC-006-3, AC-006-4).
6. **`local-ci-sweep.js`** -- given fetched facts about recently merged PRs, returns the bot findings and hosted-CI failures not yet tracked, using stable dedupe keys (AC-007-2, AC-008-3).
7. **`local-ci-cli.js`** -- JSON-in/JSON-out entry point wrapping the modules above, with boundary validation (Constitution Rule 2). Added to `lib-bundler.ts` `ENTRY_FILES` so Pi installs ship it.
8. **`pr-merge.yaml`** -- calls the skill in its Merge phase, replaces the `CHANGES_REQUESTED`/required-check refusal with the gate's verdict, and runs the sweep.

### Data flow

```
pr-merge -> local-ci-gate skill
  1. gh: PR head SHA, base, reviews   -> local-ci-cli review   (classify bot vs human; human CHANGES_REQUESTED blocks)
  2. git worktree add <tmp> <headSha> -> act (approval set from config) in <tmp>
  3. act result + digest              -> local-ci-cli record   (build run record)
  4. record                           -> local-ci-app post     (JWT -> installation token -> POST status on headSha)
  5. gh: read status back             -> local-ci-cli verify   (record matches head + configured set)
  6. verified + no human block        -> gh pr merge
  7. post-merge                       -> local-ci-cli sweep    (open beads for new bot findings / CI failures)
```

### Integration points and failure handling

- **Status publish fails or no credential:** the run may complete but publishes nothing and reports it cannot attest (AC-018-2); the merge is refused.
- **`act` or Docker missing:** stop before any status is posted, naming the missing prerequisite (AC-015-2).
- **Head commit cannot be fetched:** stop, publish nothing (AC-003-4).
- **Verification mismatch (head or workflow set differs):** refuse the merge and print the mismatch (AC-004-6).
- **Unsupported `act` step:** the run fails and names the step (AC-009-2).

### Security design

- The App private key is read from an environment variable or a gitignored file; it is never written to a status, log or bead (AC-018-1). `redact()` is applied to every string the CLI emits.
- A status from any identity other than the configured App id does not satisfy verification (AC-004-4); the verifier checks the status creator, not only its name.
- Review text and comment bodies are untrusted: only structured fields (author type, state, commit, thread resolved flag) are read for classification; bodies are passed to beads as quoted data, never interpreted.
- **Known limit (accepted in the PRD):** nothing proves `act` ran; the run record makes careless or stale posts detectable, not impossible.

### Key risk, proven first

The design rests on one unproven fact: a status posted by our own App satisfies a required check pinned to that App's id on a protected branch. GitHub's documentation says a different source is rejected, but not that the owning App is accepted. TRD-001 proves this on a throwaway repository before any other task starts, and records the outcome. If it fails, the PRD's evidence decision must be revisited before PR 2.

## Master Task List

### PR 1: Prove the Trust Mechanism
**Shippable State:** A maintainer has a recorded, reproducible proof that a status posted by the maintainer-owned GitHub App satisfies a required check pinned to that App on a protected branch, and that the same status posted by a personal token does not, so the rest of the design is known to be buildable.

- [ ] **TRD-001** Create the maintainer-owned GitHub App and prove branch-protection acceptance on a throwaway repository [satisfies REQ-004] (4h)
  - Target Files: `docs/proofs/local-ci-app-pin-proof.md`
  - Validates PRD ACs: AC-004-3, AC-004-4
  - Implementation AC:
    - [ ] Given a throwaway repository with a protected branch requiring a status pinned to the new App id, when the App posts a success status on a PR head, then the PR becomes mergeable
    - [ ] Given the same protected branch, when a personal-token status with the identical name is posted, then the PR remains unmergeable and GitHub reports it was not set by the expected app
    - [ ] Given the experiment is complete, when the result is recorded, then the exact API calls, observed responses and date are written to a proof note in the repository and no credential appears in it
    - [ ] Given the experiment posts statuses with descriptions of increasing length, when the longest accepted description is found, then that limit is recorded in the proof note so TRD-003's 100-character bound is confirmed as safe or revised

- [ ] **TRD-001-TEST** App-pinned status acceptance and rejection [Verifies TRD-001] [Satisfies REQ-004] [Depends: TRD-001] (2h)
  - Target Files: `packages/development/tests/local-ci-app-pin-proof.test.js`
  - Validates PRD ACs: AC-004-3, AC-004-4
  - Test AC:
    - [ ] Scenario: owning app satisfies the pin -- Given a branch requiring a status pinned to the App, When the App posts success on the head, Then the PR is mergeable
    - [ ] Scenario: other identity rejected -- Given the same branch, When a personal token posts the same-named success, Then the PR is not mergeable
    - [ ] Scenario: stale head not accepted -- Given a success posted on commit A, When commit B is pushed, Then the PR is not mergeable until B has a status

- [ ] **TRD-002** Per-repository gate configuration validator (`local-ci-config.js`) [satisfies REQ-009] [satisfies REQ-011] [satisfies REQ-017] (3h)
  - Target Files: `packages/development/lib/local-ci-config.js`, `.ensemble/local-ci.yaml`
  - Validates PRD ACs: AC-009-1, AC-009-3, AC-011-1, AC-017-1, AC-017-2, AC-017-3
  - Implementation AC:
    - [ ] Given a config naming workflows, jobs, matrix entries, excluded jobs, the status context and the App id, when `validateConfig` runs, then it returns the normalized approval set
    - [ ] Given a config with an unknown key, a missing required key or a job both included and excluded, when it runs, then it returns `ok:false` naming each problem and never fills in another repository's defaults
    - [ ] Given no config file, when it runs, then it returns `ok:false` stating the config is missing
    - [ ] Given a repository with no bot reviewers configured, when it runs, then bot-review handling is marked skipped and the config is still valid

- [ ] **TRD-002-TEST** Gate configuration validation [Verifies TRD-002] [Satisfies REQ-009] [Satisfies REQ-011] [Satisfies REQ-017] [Depends: TRD-002] (3h)
  - Target Files: `packages/development/tests/local-ci-config.test.js`
  - Validates PRD ACs: AC-009-1, AC-009-3, AC-011-1, AC-017-1, AC-017-2, AC-017-3
  - Test AC:
    - [ ] Scenario: required checks are the approval set -- Given the Ensemble config, When validated, Then it names validate and test on Node 22 and 24
    - [ ] Scenario: excluded job recorded -- Given a codecov upload job in the excluded list, When validated, Then the exclusion appears in the normalized set
    - [ ] Scenario: edit changes behavior -- Given a maintainer removes a workflow from the file, When validated again, Then the set shrinks with no code change
    - [ ] Scenario: per-repo isolation -- Given two repository configs, When each is validated, Then neither contains the other's workflows
    - [ ] Scenario: missing config stops -- Given no config file, When validated, Then the result names the missing file and supplies no defaults
    - [ ] Scenario: no bot reviewers -- Given a repository without bot reviewers, When validated, Then bot handling is skipped without error

### PR 2: The Gate -- Run, Record, Publish, Verify
**Shippable State:** A maintainer can run the local gate on a PR and see a status on its head commit, posted by the maintainer-owned App, carrying a verifiable run record; a stale, mismatched or foreign status is rejected, and a failing or unrunnable gate publishes nothing it cannot stand behind.

- [ ] **TRD-003** Run record builder and verifier (`local-ci-record.js`) [satisfies REQ-003] [satisfies REQ-004] (4h)
  - Target Files: `packages/development/lib/local-ci-record.js`
  - Validates PRD ACs: AC-003-1, AC-003-2, AC-004-5, AC-004-6
  - Implementation AC:
    - [ ] Given an `act` version, a workflow set and a log, when `buildRecord` runs, then it returns a description of at most 100 characters of the fixed form `act <version> | set:<8-hex> | log:<12-hex>`, with the log as a digest and never the log text and with the head SHA left implicit because the status is posted on that commit
    - [ ] Given a published description, when `parseRecord` runs, then it round-trips the same fields and rejects a malformed, over-length or truncated string
    - [ ] Given a record, the PR's current head SHA, the commit the status was posted on, and the configured workflow set, when `verifyRecord` runs, then it passes only when the status's commit equals the head SHA and the set hash recomputed from configuration equals `set:`
    - [ ] Given a status posted on commit A and a PR now at commit B, when it runs, then it returns `ok:false` with `headMismatch` naming both SHAs
    - [ ] Given a configured workflow set that has changed since the status was posted, when it runs, then it returns `ok:false` with `setMismatch` naming the difference

- [ ] **TRD-003-TEST** Run record binding [Verifies TRD-003] [Satisfies REQ-003] [Satisfies REQ-004] [Depends: TRD-003] (3h)
  - Target Files: `packages/development/tests/local-ci-record.test.js`
  - Validates PRD ACs: AC-003-1, AC-003-2, AC-004-5, AC-004-6
  - Test AC:
    - [ ] Scenario: record round trip -- Given a built record, When parsed, Then the act version, set hash and log digest all match
    - [ ] Scenario: new commit invalidates -- Given a passing record for A, When the PR head becomes B, Then verification fails naming A and B
    - [ ] Scenario: force-push invalidates -- Given a record and a head replaced by an unrelated commit, When verified, Then it fails
    - [ ] Scenario: workflow set drift -- Given a record whose set differs from the configured set, When verified, Then it fails and lists the difference
    - [ ] Scenario: log never embedded -- Given a log containing a token-shaped string, When the record is built, Then only a digest appears
    - [ ] Scenario: truncated record rejected -- Given a cut-off description, When parsed, Then it returns an error rather than partial fields
    - [ ] Scenario: over-length description rejected -- Given a description longer than 100 characters, When it is built or parsed, Then it is rejected and nothing longer than the bound is ever produced

- [ ] **TRD-004** GitHub App client (`local-ci-app.js`) [satisfies REQ-004] [satisfies REQ-010] [satisfies REQ-018] [Depends: TRD-001] (5h)
  - Target Files: `packages/development/lib/local-ci-app.js`, `.gitignore`
  - Validates PRD ACs: AC-004-1, AC-004-2, AC-010-1, AC-010-2, AC-018-1, AC-018-2, AC-018-3
  - Implementation AC:
    - [ ] Given an App id and private key, when `signAppJwt` runs, then it returns an RS256 JWT built only with Node `crypto` and no added dependency
    - [ ] Given a valid JWT, when `postStatus` runs, then it exchanges for an installation token and posts the state, context and run-record description on the head SHA
    - [ ] Given no credential, when `postStatus` runs, then it posts nothing and returns `{published:false, reason:'cannot attest'}`
    - [ ] Given any thrown error or response, when output is produced, then `redact` has removed the key, JWT and token from every string
    - [ ] Given a key that is no longer valid, when `postStatus` runs, then it returns a clear authentication failure and publishes nothing
    - [ ] Given the credential is read from the environment or from `.ensemble/local-ci-app.pem`, when the repository is inspected, then `.gitignore` contains a rule that ignores `.ensemble/local-ci-app.pem` and any `*.pem`, and `git check-ignore` confirms it before the first run is allowed to read the file
    - [ ] Given a run starts, when the preflight executes, then it refuses to read any credential file that `git ls-files` reports as tracked and names the file without printing its contents

- [ ] **TRD-004-TEST** App client signing, posting and secrecy [Verifies TRD-004] [Satisfies REQ-004] [Satisfies REQ-010] [Satisfies REQ-018] [Depends: TRD-004] (4h)
  - Target Files: `packages/development/tests/local-ci-app.test.js`
  - Validates PRD ACs: AC-004-1, AC-004-2, AC-010-1, AC-010-2, AC-018-1, AC-018-2, AC-018-3
  - Test AC:
    - [ ] Scenario: success status posted -- Given a valid fake credential and a passing result, When posted, Then the request carries state success, the configured context and the run record on the head SHA
    - [ ] Scenario: failure status posted -- Given a failing result, When posted, Then the state is failure
    - [ ] Scenario: no credential publishes nothing -- Given no key, When posting is requested, Then no request is made and the result says it cannot attest
    - [ ] Scenario: key never emitted -- Given an error whose text contains the key, When output is produced, Then the key is absent
    - [ ] Scenario: JWT is verifiable -- Given the public key, When the JWT is verified, Then the signature and expiry claims are valid
    - [ ] Scenario: revoked key -- Given an authentication rejection, When posting, Then it fails closed and names the cause without the key
    - [ ] Scenario: gitignored credential path -- Given the credential file path, When checked against ignore rules, Then it is ignored by git

- [ ] **TRD-012** Isolated gate runner (clean checkout, `act`, crash-safe cleanup) [satisfies REQ-003] [satisfies REQ-009] [satisfies REQ-010] [satisfies REQ-015] [Depends: TRD-002] (5h)
  - Target Files: `packages/development/lib/local-ci-runner.js`
  - Validates PRD ACs: AC-003-3, AC-003-4, AC-009-1, AC-009-2, AC-010-1, AC-015-1, AC-015-2
  - Implementation AC:
    - [ ] Given a head SHA and the approval set, when the runner executes, then it checks that exact commit out into a temporary worktree under `.ensemble/local-ci-runs/<sha>`, runs `act` there for the configured workflows, jobs and matrix entries, and returns the result with the failing workflow, job and step named
    - [ ] Given uncommitted changes in the maintainer's working tree, when the runner executes, then those changes have no effect on the result
    - [ ] Given the head commit cannot be fetched, when the runner executes, then it returns an error naming the commit and publishes nothing
    - [ ] Given a step `act` cannot run, when the run completes, then the result is a failure that names the workflow, job and step and is never reported as a pass
    - [ ] Given `act` or Docker is unavailable, when the runner starts, then it returns a prerequisite error naming the missing tool before creating a worktree
    - [ ] Given the runner is interrupted or crashes, when it exits or a later run starts, then the worktree is removed in a finally-style cleanup, and a later run first removes worktrees under `.ensemble/local-ci-runs/` older than a threshold and stops only containers carrying this tool's label, and touches nothing else
    - [ ] Given secrets are needed by a workflow, when the runner executes, then they come from a gitignored local file or the environment and never from a tracked file, and none appear in the returned result

- [ ] **TRD-012-TEST** Isolated runner [Verifies TRD-012] [Satisfies REQ-003] [Satisfies REQ-009] [Satisfies REQ-010] [Satisfies REQ-015] [Depends: TRD-012] (4h)
  - Target Files: `packages/development/tests/local-ci-runner.test.js`
  - Validates PRD ACs: AC-003-3, AC-003-4, AC-009-1, AC-009-2, AC-010-1, AC-015-1, AC-015-2
  - Test AC:
    - [ ] Scenario: runs the pushed commit -- Given a head SHA, When the runner executes, Then the worktree is at that commit and the approval set is run there
    - [ ] Scenario: dirty tree ignored -- Given uncommitted edits locally, When the runner executes, Then the result reflects the pushed head only
    - [ ] Scenario: unfetchable head -- Given a head SHA that cannot be fetched, When the runner executes, Then it errors naming the SHA and publishes nothing
    - [ ] Scenario: unsupported step fails -- Given a workflow using an action `act` cannot run, When the runner executes, Then the result is a failure naming the step
    - [ ] Scenario: missing prerequisite -- Given Docker is stopped, When the runner starts, Then it errors naming Docker before creating any worktree
    - [ ] Scenario: crash leaves nothing behind -- Given the runner is killed mid-run, When a later run starts, Then the stale worktree and labelled container are removed and nothing else is touched
    - [ ] Scenario: foreign worktrees untouched -- Given a maintainer-created worktree outside the prefix, When cleanup runs, Then it is left alone
    - [ ] Scenario: secrets stay out -- Given a workflow that echoes a secret, When the result is returned, Then the secret value is absent

- [ ] **TRD-005** Gate skill and CLI (`local-ci-gate` skill, `local-ci-cli.js`) [satisfies REQ-001] [satisfies REQ-002] [satisfies REQ-003] [satisfies REQ-009] [satisfies REQ-010] [satisfies REQ-015] [Depends: TRD-002] [Depends: TRD-003] [Depends: TRD-004] [Depends: TRD-012] (4h)
  - Target Files: `packages/development/skills/local-ci-gate/SKILL.md`, `packages/development/lib/local-ci-cli.js`, `packages/pi/src/transformers/lib-bundler.ts`
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-002-1, AC-002-2, AC-003-3, AC-003-4, AC-009-1, AC-009-2, AC-010-1, AC-015-1, AC-015-2
  - Implementation AC:
    - [ ] Given a PR, when the skill runs, then it obtains a result from the TRD-012 runner for the exact head SHA and the configured approval set, and never runs `act` or touches the working tree itself
    - [ ] Given `act` or Docker is unavailable, when the skill starts, then it stops before posting anything and names the missing prerequisite
    - [ ] Given a runner result that names a failing or unsupported step, when the skill reports, then it names the workflow, job and step and the exact head SHA and posts a failure status or nothing, never success
    - [ ] Given dry-run mode, when the skill completes, then it reports merge-readiness and posts nothing
    - [ ] Given the CLI receives malformed or oversized JSON, when it runs, then it rejects it at the boundary without side effects
    - [ ] Given `local-ci-cli.js` is added to `ENTRY_FILES`, when the Pi bundle is built, then it is present and resolvable through `tool-path-resolution`
    - [ ] Given the skill, when it runs a gate, then it delegates checkout, `act` execution and cleanup to the runner from TRD-012 and itself only orders the steps, calls the CLI and reports

- [ ] **TRD-005-TEST** Gate run end to end [Verifies TRD-005] [Satisfies REQ-001] [Satisfies REQ-002] [Satisfies REQ-003] [Satisfies REQ-009] [Satisfies REQ-010] [Satisfies REQ-015] [Depends: TRD-005] [Depends: TRD-012] (5h)
  - Target Files: `packages/development/tests/local-ci-gate-e2e.test.js`
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-002-1, AC-002-2, AC-003-3, AC-003-4, AC-009-1, AC-009-2, AC-010-1, AC-015-1, AC-015-2
  - Test AC:
    - [ ] Scenario: passing run merges -- Given a PR whose head has a verified passing status, When the flow runs, Then the merge proceeds without waiting for hosted CI
    - [ ] Scenario: no run refuses -- Given a PR with no local status, When the flow runs, Then the merge is refused and the missing run is reported
    - [ ] Scenario: missing prerequisite -- Given Docker is stopped, When the flow starts, Then it stops naming Docker and does not fall back to merging
    - [ ] Scenario: dry run -- Given dry-run, When the flow completes, Then it reports readiness and merges and posts nothing
    - [ ] Scenario: failing step reported -- Given a failing test, When the gate runs, Then the report names workflow, job, step and head SHA
    - [ ] Scenario: runner failure never becomes success -- Given a runner result naming an unsupported step, When the skill reports, Then no success status is posted

- [ ] **TRD-006** Gate-can-fail proof (known-bad change) [satisfies REQ-005] [Depends: TRD-005] (3h)
  - Target Files: `packages/development/skills/local-ci-gate/PROOF.md`
  - Validates PRD ACs: AC-005-1, AC-005-2
  - Implementation AC:
    - [ ] Given a branch containing a deliberately failing test, when the gate runs, then it reports failure and publishes a failure status
    - [ ] Given the failing branch is reverted to a passing one, when the gate runs again, then it reports success, proving the check can both fail and pass
    - [ ] Given the proof is complete, when it is recorded, then the commands, outcomes and date are written to a proof note before the gate is enabled on any protected branch

- [ ] **TRD-006-TEST** Gate rejects a known-bad change [Verifies TRD-006] [Satisfies REQ-005] [Depends: TRD-006] [Depends: TRD-005] (3h)
  - Target Files: `packages/development/tests/local-ci-gate-can-fail.test.js`
  - Validates PRD ACs: AC-005-1, AC-005-2
  - Test AC:
    - [ ] Scenario: failing test blocks -- Given a PR with a failing test, When the gate runs, Then the status is failure and the PR is not approved
    - [ ] Scenario: fixed branch passes -- Given the same PR with the test fixed, When the gate runs, Then the status is success
    - [ ] Scenario: proof recorded -- Given the proof run, When the note is read, Then it lists both outcomes and no credential

### PR 3: Review Handling, Sweep and Merge Integration
**Shippable State:** A maintainer running `/ensemble:pr-merge` lands a PR on local evidence alone: bot reviews never hold it, a human reviewer's requested changes still do, and bot findings and post-merge hosted-CI failures are turned into beads by the next run without any background process.

- [ ] **TRD-007** Review author classification and block decision (`local-ci-review.js`) [satisfies REQ-006] (3h)
  - Target Files: `packages/development/lib/local-ci-review.js`
  - Validates PRD ACs: AC-006-1, AC-006-2, AC-006-3, AC-006-4
  - Implementation AC:
    - [ ] Given reviews with GitHub account types, when `classifyReviews` runs, then each author is Bot or User from the reported `type` field and never from the account name
    - [ ] Given a `CHANGES_REQUESTED` from a Bot and no human objection, when `decideBlock` runs, then it returns `blocked:false`
    - [ ] Given a `CHANGES_REQUESTED` from a User that is still that reviewer's standing review, when it runs, then it returns `blocked:true` naming the reviewer
    - [ ] Given a human whose latest decisive review is APPROVED or DISMISSED after an earlier request, when it runs, then it does not block
    - [ ] Given a review with an unreadable author type, when it runs, then it is treated as human (blocking direction) so an unknown can never silently pass

- [ ] **TRD-007-TEST** Bot reviews never block, human requests do [Verifies TRD-007] [Satisfies REQ-006] [Depends: TRD-007] (3h)
  - Target Files: `packages/development/tests/local-ci-review.test.js`
  - Validates PRD ACs: AC-006-1, AC-006-2, AC-006-3, AC-006-4
  - Test AC:
    - [ ] Scenario: bot request does not block -- Given a CodeRabbit-style Bot with CHANGES_REQUESTED, When decided, Then the merge is not blocked
    - [ ] Scenario: bot still reviewing -- Given a pending Bot review, When decided, Then the merge is not blocked and nothing waits
    - [ ] Scenario: human request blocks -- Given a User with CHANGES_REQUESTED, When decided, Then it is blocked and names that user
    - [ ] Scenario: name ignored -- Given a User account whose login ends in "[bot]", When classified, Then it is classified by its type field, not its name
    - [ ] Scenario: human re-approves -- Given a User who requested changes then approved, When decided, Then it does not block
    - [ ] Scenario: unreadable author is human -- Given a review with no author type, When decided, Then it blocks

- [ ] **TRD-008** Finding and CI-failure sweep (`local-ci-sweep.js`) [satisfies REQ-007] [satisfies REQ-008] [satisfies REQ-012] (5h)
  - Target Files: `packages/development/lib/local-ci-sweep.js`
  - Validates PRD ACs: AC-007-1, AC-007-2, AC-007-3, AC-008-1, AC-008-2, AC-008-3, AC-012-1, AC-012-2
  - Implementation AC:
    - [ ] Given fetched facts for recently merged PRs, when `findUntracked` runs, then it returns each unresolved Bot finding and each failed hosted-CI run not already represented by an existing bead
    - [ ] Given a finding, when its dedupe key is built, then the key is derived from the PR number, comment id or check run id and never from text, so re-running yields the same key
    - [ ] Given the same facts twice, when it runs twice, then the second run returns nothing new
    - [ ] Given no unresolved findings and no failures, when it runs, then it returns an empty result and the skill creates no beads
    - [ ] Given the module and skill, when inspected, then neither registers a timer, daemon, hook or schedule

- [ ] **TRD-008-TEST** Sweep dedupe and no background work [Verifies TRD-008] [Satisfies REQ-007] [Satisfies REQ-008] [Satisfies REQ-012] [Depends: TRD-008] (4h)
  - Target Files: `packages/development/tests/local-ci-sweep.test.js`
  - Validates PRD ACs: AC-007-1, AC-007-2, AC-007-3, AC-008-1, AC-008-2, AC-008-3, AC-012-1, AC-012-2
  - Test AC:
    - [ ] Scenario: unresolved findings become beads -- Given a merged PR with unresolved Bot threads, When swept, Then one bead per finding is returned linking its comment
    - [ ] Scenario: late finding found -- Given a finding posted after merge, When the next run sweeps, Then it is returned
    - [ ] Scenario: no duplicates -- Given findings already recorded, When swept again, Then nothing new is returned
    - [ ] Scenario: clean merge creates nothing -- Given no findings, When swept, Then the result is empty
    - [ ] Scenario: CI failure becomes a regression bead -- Given a failed hosted-CI run on a landed commit, When swept, Then a regression item linking the run is returned
    - [ ] Scenario: failure not duplicated -- Given a recorded failure, When swept again, Then nothing new
    - [ ] Scenario: hosted CI still runs on push -- Given the workflows, When their triggers are read, Then pull_request and push triggers are unchanged
    - [ ] Scenario: no background mechanism -- Given the new modules and skill, When scanned for timers, daemons and schedules, Then none exist

- [ ] **TRD-009** Integrate the gate into `pr-merge.yaml` and regenerate [satisfies REQ-001] [satisfies REQ-002] [satisfies REQ-006] [satisfies REQ-007] [satisfies REQ-008] [satisfies REQ-015] [Depends: TRD-005] [Depends: TRD-007] [Depends: TRD-008] (5h)
  - Target Files: `packages/git/commands/pr-merge.yaml`
  - Validates PRD ACs: AC-001-1, AC-002-1, AC-006-1, AC-006-3, AC-007-1, AC-008-1
  - Implementation AC:
    - [ ] Given `pr-merge.yaml`, when edited, then the NEVER-merge-on-CHANGES_REQUESTED and required-checks constraints are replaced by the gate's verdict and the human-review block, and the dry-run, max-rounds and no-test-weakening constraints are preserved unchanged
    - [ ] Given the Merge phase, when it runs, then it calls the `local-ci-gate` skill and does not restate gate logic
    - [ ] Given the sweep, when the merge flow starts, then it runs the sweep before merging and after merging, and records beads through `br`
    - [ ] Given the YAML source changed, when `npm run generate`, `npm run generate:codex` and the Pi generator run, then every generated `pr-merge` artifact reflects the change and `npm run generate:validate` passes
    - [ ] Given `fix-issue` and `implement-trd-beads`, when this change lands, then their review gates are untouched

- [ ] **TRD-009-TEST** pr-merge integration and generation parity [Verifies TRD-009] [Satisfies REQ-001] [Satisfies REQ-002] [Satisfies REQ-006] [Satisfies REQ-007] [Satisfies REQ-008] [Satisfies REQ-015] [Depends: TRD-009, TRD-007, TRD-008, TRD-005] (4h)
  - Target Files: `packages/development/tests/local-ci-pr-merge-integration.test.js`
  - Validates PRD ACs: AC-001-1, AC-002-1, AC-006-1, AC-006-3, AC-007-1, AC-008-1
  - Test AC:
    - [ ] Scenario: gate precedes merge -- Given the generated command, When its phases are read in order, Then the gate runs before the merge step
    - [ ] Scenario: bot review no longer refuses -- Given the generated constraints, When read, Then CHANGES_REQUESTED from a bot is not a refusal condition and a human one still is
    - [ ] Scenario: safety constraints preserved -- Given the generated constraints, When read, Then no-test-weakening, no force-push and max-rounds remain
    - [ ] Scenario: sweep runs around merge -- Given the generated phases, When read, Then the sweep appears before and after the merge
    - [ ] Scenario: runtimes agree -- Given the Pi, Codex and markdown outputs, When compared, Then all contain the same gate and review rules
    - [ ] Scenario: other commands untouched -- Given fix-issue and implement-trd-beads, When their generated output is compared before and after, Then it is identical

### PR 4: Rollout, Rollback and Measurement
**Shippable State:** A maintainer can enable the gate on a repository's protected branch by following a documented procedure, roll back to hosted CI and bot-review gating with a documented procedure, and has a recorded baseline of PR open-to-merge times captured before enablement.

- [ ] **TRD-013** Local gate speed and fidelity measurement [satisfies REQ-013] [satisfies REQ-009] [Depends: TRD-012] (4h)
  - Target Files: `packages/development/skills/local-ci-gate/MEASUREMENT.md`, `packages/development/lib/local-ci-timing.js`
  - Validates PRD ACs: AC-013-1, AC-013-2, AC-009-1
  - Implementation AC:
    - [ ] Given the configured approval set, when the gate runs cold (no image cache, no dependency cache) and warm, then both durations are recorded beside the hosted CI durations for the same workflows over the same period
    - [ ] Given the local and hosted results for the same head commit, when they are compared, then any job that passes in one and fails or cannot run in the other is listed as a fidelity gap
    - [ ] Given the recorded comparison, when a repository is about to enable the gate, then the runbook requires the measurement note to exist and states plainly whether the local gate is faster, slower or equal to hosted CI, with no target asserted
    - [ ] Given the comparison shows the local gate is slower than hosted CI, when the maintainer reads the note, then it states that the benefit for that repository comes from removing the bot-review wait and not from run time

- [ ] **TRD-013-TEST** Speed and fidelity measurement honesty [Verifies TRD-013] [Satisfies REQ-013] [Satisfies REQ-009] [Depends: TRD-013] (3h)
  - Target Files: `packages/development/tests/local-ci-timing.test.js`
  - Validates PRD ACs: AC-013-1, AC-013-2, AC-009-1
  - Test AC:
    - [ ] Scenario: cold and warm recorded -- Given two timed runs, When the note is produced, Then both durations appear next to the hosted figure
    - [ ] Scenario: fidelity gap listed -- Given a job that passes hosted and fails locally, When compared, Then it is listed as a gap
    - [ ] Scenario: slower is stated -- Given local slower than hosted, When the note is read, Then it says slower and does not claim a speedup from run time
    - [ ] Scenario: enablement requires the note -- Given no measurement note, When the runbook gate check runs, Then enablement is refused

- [ ] **TRD-010** Rollout and rollback runbook with protection changes [satisfies REQ-004] [satisfies REQ-014] [satisfies REQ-016] [Depends: TRD-009] [Depends: TRD-013] (4h)
  - Target Files: `packages/development/skills/local-ci-gate/RUNBOOK.md`, `packages/development/skills/local-ci-gate/SKILL.md`
  - Validates PRD ACs: AC-004-3, AC-014-1, AC-016-1
  - Implementation AC:
    - [ ] Given a repository adopting the gate, when the runbook is followed, then branch protection requires the App-pinned local status and the hosted checks are no longer required, with the exact API calls and a pre-change snapshot of the existing protection recorded
    - [ ] Given the local-ci status context has not yet reported successfully on the real repository, when the runbook is followed, then it first posts a real success status on a current head commit, because GitHub only allows a check to be required if it completed successfully in that repository within the past seven days, and only then edits branch protection
    - [ ] Given the gate was enabled, when the rollback section is followed, then protection is restored from the snapshot, hosted checks are required again, and `pr-merge` honors bot reviews as before
    - [ ] Given `fix-issue` or `implement-trd-beads` is about to open a PR, when the optional gate step is used, then the PR opens with the status already published for its head
    - [ ] Given protection changes need an admin, when the runbook is read, then it names which step each adopting repository's owner approves
    - [ ] Given the TRD-013 measurement note does not exist for the repository, when the runbook reaches enablement, then it stops and refuses to proceed

- [ ] **TRD-010-TEST** Rollback restores prior protection [Verifies TRD-010] [Satisfies REQ-004] [Satisfies REQ-014] [Satisfies REQ-016] [Depends: TRD-010] (3h)
  - Target Files: `packages/development/tests/local-ci-rollback.test.js`
  - Validates PRD ACs: AC-004-3, AC-014-1, AC-016-1
  - Test AC:
    - [ ] Scenario: enable then rollback is lossless -- Given a protection snapshot, When the gate is enabled then rolled back, Then protection equals the snapshot
    - [ ] Scenario: hosted checks required again -- Given a rolled-back repository, When a PR has no hosted CI success, Then it cannot merge
    - [ ] Scenario: PR born approved -- Given the optional gate step, When a PR is opened by fix-issue, Then its head already carries the status

- [ ] **TRD-011** Baseline capture and success-target recording [satisfies REQ-013] (4h)
  - Target Files: `packages/development/lib/local-ci-baseline.js`, `packages/development/skills/local-ci-gate/BASELINE.md`
  - Validates PRD ACs: AC-013-1, AC-013-2, AC-013-3
  - Implementation AC:
    - [ ] Given a cohort window, when the baseline script runs, then it reports median and p75 open-to-merge time and, separately, the wait attributable to hosted CI and to bot review
    - [ ] Given the gate is not yet enabled, when the baseline is captured, then the cohort and its figures are written to a recorded note before enablement
    - [ ] Given post-change data below the agreed minimum, when status is reported, then the target is stated as unproven and never as met
    - [ ] Given the baseline exists, when the target and minimum post-change cohort are decided, then they are recorded in the PRD changelog

- [ ] **TRD-011-TEST** Baseline reporting honesty [Verifies TRD-011] [Satisfies REQ-013] [Depends: TRD-011] (3h)
  - Target Files: `packages/development/tests/local-ci-baseline.test.js`
  - Validates PRD ACs: AC-013-1, AC-013-2, AC-013-3
  - Test AC:
    - [ ] Scenario: median and p75 reported -- Given a fixed set of PR timings, When the report runs, Then median and p75 match a hand computation
    - [ ] Scenario: waits split -- Given CI and bot-review durations, When reported, Then each is attributed separately
    - [ ] Scenario: insufficient data is unproven -- Given too few post-change PRs, When status is reported, Then it says unproven
    - [ ] Scenario: baseline precedes enablement -- Given the gate is not enabled, When the baseline note is read, Then it carries a capture date earlier than any enablement record

## Acceptance Criteria Traceability

| REQ | Description | Implementation Tasks | Test Tasks |
|---|---|---|---|
| REQ-001 | Local run approves a PR | TRD-005, TRD-009 | TRD-005-TEST, TRD-009-TEST |
| REQ-002 | The merge command is the entry point | TRD-005, TRD-009 | TRD-005-TEST, TRD-009-TEST |
| REQ-003 | Evidence is bound to the exact head commit | TRD-003, TRD-005, TRD-012 | TRD-003-TEST, TRD-005-TEST, TRD-012-TEST |
| REQ-004 | Evidence is published where branch protection can enforce it | TRD-001, TRD-003, TRD-004, TRD-010 | TRD-001-TEST, TRD-003-TEST, TRD-004-TEST, TRD-010-TEST |
| REQ-005 | The gate can fail | TRD-006 | TRD-006-TEST |
| REQ-006 | Bot reviews become non-blocking; human reviews still block | TRD-007, TRD-009 | TRD-007-TEST, TRD-009-TEST |
| REQ-007 | Bot review findings become tracked work | TRD-008, TRD-009 | TRD-008-TEST, TRD-009-TEST |
| REQ-008 | Hosted CI remains a safety net | TRD-008, TRD-009 | TRD-008-TEST, TRD-009-TEST |
| REQ-009 | The local run covers what hosted CI covers | TRD-002, TRD-005, TRD-012, TRD-013 | TRD-002-TEST, TRD-005-TEST, TRD-012-TEST, TRD-013-TEST |
| REQ-010 | Local run must not leak secrets | TRD-004, TRD-005, TRD-012 | TRD-004-TEST, TRD-005-TEST, TRD-012-TEST |
| REQ-011 | Behavior is user-editable, not hardcoded | TRD-002 | TRD-002-TEST |
| REQ-012 | No second dispatcher | TRD-008 | TRD-008-TEST |
| REQ-013 | Cycle-time improvement is measured, not assumed | TRD-011, TRD-013 | TRD-011-TEST, TRD-013-TEST |
| REQ-014 | Rollback to remote gating | TRD-010 | TRD-010-TEST |
| REQ-015 | Clear failure reporting | TRD-005, TRD-009, TRD-012 | TRD-005-TEST, TRD-009-TEST, TRD-012-TEST |
| REQ-016 | Applies to the PR-producing commands' boundaries | TRD-010 | TRD-010-TEST |
| REQ-017 | Per-repository configuration | TRD-002 | TRD-002-TEST |
| REQ-018 | The app credential is protected | TRD-004 | TRD-004-TEST |

## Sprint Planning

Informational only; `implement-trd-beads` does not parse this section.

## Sprint 1: Prove and build the gate
- PR 1 (TRD-001, TRD-002) -- 12h including tests. TRD-001 is the go/no-go for the App client.
- PR 2 (TRD-003, TRD-004, TRD-012, TRD-005, TRD-006) -- 40h including tests.

## Sprint 2: Integrate and roll out
- PR 3 (TRD-007 to TRD-009) -- 24h including tests.
- PR 4 (TRD-013, TRD-010, TRD-011) -- 21h including tests. TRD-013 precedes TRD-010 because the runbook refuses enablement without the measurement note.

## Architecture Self-Critique

1. **Gap, sequencing (resolved):** TRD-001 needs a real GitHub App and a throwaway repository, which only the maintainer can create, so it is human-assisted. TRD-004 now declares `[Depends: TRD-001]`, so the App client cannot be scheduled before the proof. TRD-002 and TRD-003 are pure modules and are allowed to proceed in parallel, by decision.
2. **Gap, contradiction with an existing module:** `pr-review-remote.js` classifies bots by a configured login list, while PRD AC-006-4 requires classification by GitHub account type. Resolution: TRD-007 is a separate module that reads `type`; `pr-review-remote.js` is left untouched because `fix-issue` and `implement-trd-beads` still depend on its fail-closed behavior.
3. **Gap, tracker coupling:** The sweep creates beads through `br`, which exists in this repository but not necessarily in an adopting repository such as Foreman. Resolution: the tracker is a config field (TRD-002); the sweep returns structured items, and the skill hands them to whichever tracker the config names.
4. **Missing failure path:** if the status is posted but the PR head moves before the merge call, the merge could race. Resolution: the merge step re-reads the head SHA and re-verifies immediately before calling `gh pr merge` (TRD-005, TRD-009).

## Dependency and Estimate Review

- **Longest chain:** TRD-001 -> TRD-004 -> TRD-005 -> TRD-009 -> TRD-010 -> TRD-010-TEST (depth 6, computed from declared dependencies; 31 declared edges, no forward dependencies, no cycles). The head of the chain is the human-assisted proof, which is the real schedule risk. Three orderings were deliberately left undeclared because the tasks can be built and tested independently: TRD-007 and TRD-008 on TRD-002 (both are pure modules tested with fixtures), and TRD-011 on TRD-013 (they share only a recording location).
- **Estimate risk:** TRD-012 (5h) bundles the worktree, `act` invocation and crash-safe cleanup; `act` fidelity on Node 22/24 with `npm ci` is unknown until run. Treat it as the most likely to overrun. TRD-005 was reduced to 4h by moving the runner out.
- **Estimate consistency:** the module tasks (TRD-002, 003, 007) are 3-4h; the three with I/O or external systems (TRD-004, TRD-008, TRD-012) are 5h.

## Testability Review

- Every implementation task has a paired `-TEST` task with one Scenario per validated AC group.
- TRD-001 and TRD-006 are proofs against a real protected branch and a real failing test respectively; they cannot be satisfied by mocks, which is deliberate (Constitution Rule 7).
- AC-018-3 (credential rotation) is covered by the runbook in TRD-010 and the revoked-key scenario in TRD-004-TEST; the rotation procedure itself is documented, not automated.

## Design Readiness Gate

| Dimension | Score | Note |
|---|---|---|
| Architecture completeness | 4 | Components, data flow, failure handling, security design and the runner boundary are defined; the App-acceptance behavior and the status description cap are explicitly deferred to TRD-001. |
| Task coverage | 4 | All 18 requirements have implementation and test tasks (matrix regenerated from task annotations). Nine requirements have fewer than 3 PRD ACs (REQ-001, 002, 005, 010, 011, 012, 014, 015, 016), below create-trd's BDD minimum; recorded here instead of editing the locked PRD. |
| Dependency clarity | 5 | Dependencies are now declared on every implementation task that has a prerequisite; the graph is acyclic, has no forward dependencies, and TRD-001 genuinely heads the longest chain. |
| Estimate confidence | 4 | Granular and consistent after splitting the runner out of TRD-005; `act` fidelity and clean-checkout cost remain the main uncertainty and now have a measuring task (TRD-013). |

**Overall: 4.25 (PASS).** Previous: 4.0.

## Notes

- **Total tasks:** 26 (13 implementation, 13 test). **Total estimate:** 97h (PR 1: 12h, PR 2: 40h, PR 3: 24h, PR 4: 21h). Figures are derived from the TRD parser, not hand-counted.
- **Constitution compliance:** passed (`docs/standards/constitution.md`). Rule 1 (no secrets): TRD-004 owns the credential ignore rule and a tracked-file preflight; TRD-012 keeps workflow secrets out of results. Rule 2 (input validation): TRD-005 CLI boundary and TRD-002 config validation. Rule 3 (tests accompany features): every task has a `-TEST` pair. Rule 4 (no second dispatcher): TRD-008 and REQ-012. Rule 6 (reachable from entry point): TRD-009 wires the gate into `pr-merge`. Rule 7 (a check can fail): TRD-001, TRD-006. Rule 8 (user-editable behavior in skills): the skill and config own procedure and policy. Rule 9: no test pins another actor's write order.
- **Open decision carried forward:** the numeric cycle-time target and minimum post-change cohort are set after the baseline (TRD-011), per PRD REQ-013.
- **PRD wording interpreted, not changed (PRD is locked):** PRD AC-004-5 says the status description carries the head SHA. GitHub's status description is length-capped (working limit 140 characters, unconfirmed in current documentation and checked by TRD-001), so the SHA is carried implicitly by the commit the status is posted on, and `verifyRecord` checks that commit. This preserves the intent that a result is bound to one exact commit.
- **Measured premise check (2026-10-21):** hosted required CI on this repository takes about 2.5 to 3 minutes (`test` 153-192s, `validate` 44-62s, run in parallel). A local `act` run is unlikely to be faster. TRD-013 measures this before any repository enables the gate; the speedup for a repository comes from removing the bot-review wait, not from run time.

## Changelog

| Date | Version | Change |
|---|---|---|
| 2026-10-21 | 1.0.0 | Initial TRD created from PRD-2026-4dec59b8 v1.0.1. Design readiness 4.0. |
| 2026-10-21 | 1.0.1 | Refinement (8 findings, all addressed): declared `[Depends:]` on implementation tasks so TRD-001 genuinely gates TRD-004 (previously prose only; parsed chain depth was 2, not the claimed 6); compact run record (act version, 8-hex set hash, 12-hex log digest, at most 100 characters) with the head SHA carried by the commit the status is posted on, because the status description is length-capped; split the isolated runner out of TRD-005 into new TRD-012 with crash-safe cleanup that touches only this tool's labelled leftovers; added TRD-013 to measure local gate speed and fidelity against hosted CI before any repository enables the gate (hosted CI measured at about 3 minutes, so the local gate is unlikely to be faster); added first-real-post-before-protection-edit ordering to TRD-010 for GitHub's seven-day rule on required checks; added a tracked-credential preflight to TRD-004; regenerated the traceability matrix from task annotations; corrected task count (26), hours (97) and the longest chain. Design readiness 4.0 to 4.25. |
| 2026-10-21 | 1.0.2 | Found while scaffolding beads: TRD-009 declared no dependencies although its acceptance criteria call the gate skill (TRD-005), the review decision (TRD-007) and the sweep (TRD-008), so the bead graph would have allowed the pr-merge integration to be scheduled first. Added `[Depends: TRD-005]`, `[Depends: TRD-007]` and `[Depends: TRD-008]`. Audited 16 intended orderings: 10 were already declared, 3 were this fix, and 3 (TRD-007 and TRD-008 on TRD-002, TRD-011 on TRD-013) were deliberately left undeclared because those tasks can be built and tested independently. The computed longest chain is now depth 6 (TRD-001 -> TRD-004 -> TRD-005 -> TRD-009 -> TRD-010 -> TRD-010-TEST). No forward dependencies, no cycles, 31 declared edges. |
