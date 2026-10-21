---
document_id: PRD-2026-4dec59b8
label: prd-local-ci-pr-approval
version: 1.0.3
status: Locked
date: 2026-10-21
scale_depth: STANDARD
total_requirements: 18
readiness_score: 4.5
design_readiness_score: null
---

# PRD-2026-4dec59b8: Local-CI PR Approval

## PRD Health Summary

- **Risk flags:** REQ-003, REQ-004, REQ-005, REQ-008, REQ-018
- **Dependencies:** 23 cross-requirement dependencies (see Dependency Map)
- **Unresolved clarification markers:** 0
- **Constitution compliance:** passed (`docs/standards/constitution.md`, Non-Negotiable Rules 1-9)

## Product Summary

**Problem:** A pull request cannot land until two remote systems finish: the hosted CI run and, in repositories that use it, the CodeRabbit review. Maintainers wait on both, and each remediation push restarts the wait, so PRs take far too long to land. The existing cycle-time work (PRD-2026-82b6a138) reduced avoidable review rounds but kept remote CodeRabbit review authoritative and blocking, so the wait itself remains. CodeRabbit is not active on the Ensemble repository (no reviews or comments in its last 30 PRs, no `.coderabbit.yaml`); the blocking review wait is felt in the Foreman repository, which shares the same merge command.

**Who feels it:** Maintainers and developers in repositories that land PRs through the shared `/ensemble:pr-merge` command, and the PR-producing commands (`/ensemble:fix-issue`, `/ensemble:implement-trd-beads`). Ensemble is the first adopter; Foreman is the repository where the CodeRabbit wait is felt.

**Solution:** Change what approves a PR. The approval signal becomes a local run of the repository's required CI checks through a local CI runner, executed against a clean checkout of the exact PR head commit, and published to GitHub as a status posted by a maintainer-owned GitHub App so branch protection can pin to it. The status carries a run record (runner identity, workflow-set hash, log digest; the head SHA is the commit the status is posted on) that the merge flow verifies. Bot reviews, including CodeRabbit, stop gating the merge; a human reviewer's `CHANGES_REQUESTED` still blocks. Findings and post-merge hosted-CI failures are captured as tracked work by the next merge-flow run. Hosted CI keeps running on every push as a safety net but is no longer required to merge.

**Success:** Median PR open-to-merge time falls materially against a baseline cohort captured before the change, with no increase in defects reaching the base branch that the previous gate would have caught. The numeric target is set after the baseline is measured (REQ-013), not invented in advance.

**Decisions made (do not relitigate in refinement):**

- CodeRabbit's role is **async, non-blocking follow-up**; bot reviews never block, a human `CHANGES_REQUESTED` still blocks.
- Local-run evidence is a **status posted by a maintainer-owned GitHub App**, bound to the head SHA and carrying a run record. (Verified: a personal-token or `gh` status cannot satisfy a check pinned to the GitHub Actions app.)
- Hosted CI **keeps running but is not required to merge**.
- The local run executes in a **clean checkout of the PR head SHA**, not the working tree.
- The approval set **mirrors today's required checks** (`validate`, `test` on Node 22 and 24); a required step the local runner cannot run or does not mirror **fails the gate**.
- Late bot findings and post-merge hosted-CI failures are captured **by the next merge-flow run as beads**; no daemon.
- The feature is **repository-agnostic**, with per-repository configuration; each adopting repository's owner approves its own protection change.

**Relationship to prior work:** This PRD deliberately reverses one decision in `PRD-2026-82b6a138` ("CodeRabbit remains enabled and authoritative for remote review; only a review for the current head can satisfy the remote-review condition"). That reversal is intentional and scoped by REQ-006 and REQ-007. The base/head identity, finding ledger and `REVIEW_COMPLETE/PENDING/BLOCKED` contract of `PRD-2026-82b6a138` are retained wherever they do not make remote review blocking.

**Out of scope (Won't, this release):** Replacing CodeRabbit with another review provider; changing CodeRabbit's review profile; changes to Foreman's own workflow definitions (adopting the shared merge command in the Foreman repository is a separate rollout there); HerdR changes; a general PR dashboard; remote or self-hosted CI runners; weakening any test, assertion or required check to make a local run pass; cryptographic proof that the local CI steps actually ran.

## Approvals and Decision Ownership

- **Approver:** Each adopting repository's owner approves that repository's branch-protection change. The Ensemble repository owner approves the shared merge command, skill and GitHub App design.
- **Acceptance criteria the approver judges against:** REQ-001 through REQ-018 below; in particular that a PR can land on local evidence alone (REQ-001, REQ-002), that the evidence cannot be reused across commits or posted by an unauthorized identity (REQ-003, REQ-004, REQ-018), and that the gate demonstrably fails when it should (REQ-005).

## Entry and Exit Criteria

**Entry (must be true before work starts):**

- The repository's local CI entry point (for this repository, `npm run ci:local`), git, and each required Node version are available on the maintainer's machine.
- The maintainer can change branch-protection settings on the target branches.
- Existing unrelated working-tree changes remain untouched.
- A GitHub App owned by the maintainers exists and is installed on each adopting repository; creating and installing it is in scope for this work.

**Exit (observable conditions that end the work):**

- A PR on `dev` can be merged with the local run as the sole approval condition, with hosted CI and CodeRabbit not required.
- A PR whose local run fails, or whose evidence is for a different commit, cannot be merged by the supported flow.
- CodeRabbit findings that arrive after landing appear as tracked follow-up work.
- A baseline cohort of PR open-to-merge times has been captured before the gate is enabled, and the cycle-time target is not claimed met until a post-change cohort proves it.

## Requirements

### Local CI as the approval signal

### REQ-001: Local run approves a PR (Must)

A maintainer can land a PR when the repository's CI workflows have passed in a local run for that PR's current head commit, without waiting for hosted CI or remote review to complete.

- AC-001-1: Given an open PR whose head commit has a passing local run, when the maintainer invokes the supported merge flow, then the PR is merged without waiting for hosted CI or CodeRabbit.
- AC-001-2: Given an open PR whose head commit has no local run, when the maintainer invokes the supported merge flow, then the merge is refused and the missing local run is reported.

### REQ-002: The merge command is the entry point (Must)

The existing PR merge flow (`/ensemble:pr-merge`) is the supported path that triggers the local run, publishes its result, and merges; no separate manual procedure is required.

- AC-002-1: Given an open PR, when the maintainer runs the merge flow with no extra steps, then the local run executes, its result is published, and the merge proceeds only if it passed.
- AC-002-2: Given the merge flow is run in dry-run mode, when it completes, then it reports merge-readiness from the local run without merging.

### REQ-003: Evidence is bound to the exact head commit (Must) [RISK: a result for an old commit approving a new one would let unreviewed code land]

A local-run result is valid only for the exact head commit it ran against, and the run itself executes against that exact commit and nothing else.

- AC-003-1: Given a passing local run for commit A, when a new commit B is pushed to the PR, then the PR no longer counts as approved until a local run passes for B.
- AC-003-2: Given a passing local run for commit A, when the PR head is force-pushed to a different commit, then the earlier result does not approve the new head.
- AC-003-3: Given the maintainer's working tree has uncommitted or unpushed changes, when a local run is requested, then the run still executes against a clean checkout of the PR's head commit and the working-tree changes have no effect on the result.
- AC-003-4: Given the PR head commit cannot be fetched, when a local run is requested, then it stops without publishing any status and names the commit it could not obtain.

### REQ-004: Evidence is published where branch protection can enforce it (Must) [RISK: verified -- the required checks on `dev` are pinned to the GitHub Actions app (app id 15368); a status posted with a personal token or the `gh` CLI is not from that app and will not satisfy them, leaving the PR unmergeable]

The local run's result is published to GitHub as a status on the head commit, posted by a maintainer-owned GitHub App under a name that branch protection can pin to that app.

- AC-004-1: Given a passing local run, when its result is published, then the head commit shows a success status under the agreed name, posted by the maintainer-owned app.
- AC-004-2: Given a failing local run, when its result is published, then the head commit shows a failure status and the PR cannot be merged by the supported flow.
- AC-004-3: Given branch protection on the target branch requires the local-run status pinned to the maintainer-owned app, when a PR has only a hosted-CI success and no local status, then it cannot merge; and when it has a passing status from the app, then it can.
- AC-004-4: Given a passing status for the agreed name posted by any identity other than the maintainer-owned app (for example a personal token), when merge readiness is evaluated, then it does not satisfy the requirement.
- AC-004-5: Given a published status, when its description is read, then it carries the run record: the runner identity, a hash of the workflow set run, and a digest of the run log, and the head SHA is established by the commit the status is posted on.
- AC-004-6: Given a status whose run record does not match the PR's current head SHA or the repository's configured workflow set, when the merge flow evaluates it, then the merge is refused and the mismatch is reported.

### REQ-005: The gate can fail (Must) [RISK: a gate that cannot fail manufactures false confidence]

The local approval gate is demonstrably capable of rejecting a bad change.

- AC-005-1: Given a PR containing a deliberately failing test, when the local run executes, then it reports failure and the PR is not approved.
- AC-005-2: Given the gate is exercised against a known-bad change before being enabled, when that is recorded, then there is evidence the gate rejected it.

### REQ-006: Bot reviews become non-blocking; human reviews still block (Must)

Review decisions from bot accounts, including `CHANGES_REQUESTED` and unresolved bot review threads, no longer prevent a PR from merging through the supported flow. A human reviewer's `CHANGES_REQUESTED` continues to block.

- AC-006-1: Given a PR with a passing local run and an outstanding `CHANGES_REQUESTED` review from a bot account such as CodeRabbit, when the maintainer invokes the merge flow, then the PR merges.
- AC-006-2: Given a PR with a passing local run and a bot review still in progress, when the maintainer invokes the merge flow, then the PR merges without waiting.
- AC-006-3: Given a PR with an outstanding `CHANGES_REQUESTED` review from a human reviewer, when the maintainer invokes the merge flow, then the merge is refused and names the reviewer, until that reviewer dismisses the request or approves.
- AC-006-4: Given a review author, when the merge flow classifies it, then the classification uses the account type GitHub reports (bot or user) and not the account name.

### REQ-007: Bot review findings become tracked work (Must)

Findings that bot reviewers (such as CodeRabbit) raise on a PR, before or after it lands, are captured as follow-up beads so they are not lost when review no longer gates the merge.

- AC-007-1: Given a PR merged while bot reviewers had unresolved actionable findings, when the merge completes, then each is recorded as a bead linking back to the original comment.
- AC-007-2: Given bot findings posted after a PR has merged, when the merge flow next runs, then it sweeps recently merged PRs and records any finding not already tracked as a bead, without creating duplicates for findings already recorded.
- AC-007-3: Given no unresolved bot findings, when the merge completes, then no beads are created.

### REQ-008: Hosted CI remains a safety net (Must) [RISK: unrequired hosted CI can fail unnoticed after landing]

Hosted CI continues to run on every push and on the base branch, but is not required to merge, and its failures are surfaced as tracked work rather than silently ignored.

- AC-008-1: Given a PR merged on local evidence, when hosted CI later fails for that commit or the resulting base-branch commit, then the next merge-flow run records a regression bead linked to the failing run.
- AC-008-2: Given a push to a PR, when hosted CI triggers, then it runs as it does today.
- AC-008-3: Given a hosted-CI failure already recorded as a bead, when the merge flow next runs, then it does not create a duplicate.

### Fidelity, scope and safety of the local run

### REQ-009: The local run covers what hosted CI covers (Must)

The local run executes the same workflows and jobs that hosted CI would, so a local pass is a meaningful predictor of a hosted pass.

- AC-009-1: Given the repository's test workflow with its Node version matrix, when the local run executes, then every matrix entry that is a required gate today is run locally, which for this repository means `validate` and `test` on Node 22 and Node 24.
- AC-009-2: Given a required workflow step that the local CI runner cannot run or does not mirror (an unsupported action, a missing runner feature, or a step absent from the configured list), when the local run encounters it, then the run fails, the failing step is named, and the PR is not approved on the strength of a partial run.
- AC-009-3: Given a job that cannot be represented locally (for example one that only uploads coverage to an external service), when the approval set is defined, then such jobs are explicitly excluded and the exclusion is recorded.

### REQ-010: Local run must not leak secrets (Must)

Running CI locally never commits, publishes or logs credentials.

- AC-010-1: Given secrets are needed for a local run, when it executes, then they come from gitignored local configuration or the environment and never from tracked files.
- AC-010-2: Given the local run publishes a status or log, when the output is inspected, then it contains no token or secret value.

### REQ-011: Behavior is user-editable, not hardcoded (Should)

What the local run executes and how its result is judged is defined in files a maintainer can edit without a toolchain, a rebuild or a release.

- AC-011-1: Given a maintainer wants to change which workflows form the approval set, when they edit the documented configuration or skill file, then the next run honors the change with no code change.

### REQ-012: No second dispatcher (Must)

The feature adds no durable scheduler, background daemon or competing dispatcher; it runs in the maintainer's own session.

- AC-012-1: Given the feature is installed, when no maintainer invokes it, then nothing runs in the background.
- AC-012-2: Given the late-finding and post-merge-failure sweeps, when no merge-flow run occurs, then no sweep occurs; detection happens only as part of a run a maintainer starts.

### Measurement and rollout

### REQ-013: Cycle-time improvement is measured, not assumed (Must)

The reduction in PR open-to-merge time is measured against a fresh, comparable baseline cohort and reported with median and p75, and the target is not claimed met until post-change data proves it.

- AC-013-1: Given a baseline cohort and a post-change cohort of comparable PRs, when results are reported, then median and p75 open-to-merge time are shown for both, along with the wait attributable to hosted CI and to CodeRabbit separately.
- AC-013-2: Given insufficient post-change data, when status is reported, then the target is stated as unproven rather than met.
- AC-013-3: Given the gate has not yet been enabled, when the baseline is captured, then the baseline cohort and its median and p75 are recorded before enablement, and the numeric target and minimum post-change cohort size and duration are set from that baseline and recorded in this PRD.

### REQ-014: Rollback to remote gating (Should)

A maintainer can revert to requiring hosted CI and CodeRabbit as merge gates quickly if the local gate proves unreliable.

- AC-014-1: Given the local gate has been enabled, when the maintainer follows the documented rollback, then branch protection requires the hosted checks again and the merge flow honors CodeRabbit as before.

### REQ-015: Clear failure reporting (Should)

When a local run fails or cannot approve, the maintainer is told why and what to do next.

- AC-015-1: Given a failing local run, when the merge flow stops, then it reports the failing workflow, job and step and the exact head commit.
- AC-015-2: Given the local CI runner's prerequisites (the repository's local CI entry point, git, or a required Node version) are unavailable, when the merge flow is invoked, then it stops with a message naming the missing prerequisite rather than falling back to merging without evidence.

### REQ-016: Applies to the PR-producing commands' boundaries (Could)

The PR-producing commands (`/ensemble:fix-issue`, `/ensemble:implement-trd-beads`) can run the local approval gate before publishing a PR so the PR is born already approved.

- AC-016-1: Given one of those commands is about to open a PR, when it runs the local gate and it passes, then the PR is opened with the approval status already published for its head commit.

### REQ-017: Per-repository configuration (Must)

What the gate runs, which statuses branch protection pins, and where tracked work is recorded are configured per repository so the same merge flow serves repositories with different CI, with or without CodeRabbit.

- AC-017-1: Given a repository with its own approval set, when the merge flow runs there, then it runs that repository's configured workflows and no other repository's.
- AC-017-2: Given a repository with no CodeRabbit or other bot reviewers, when the merge flow runs there, then review handling is skipped without error and the local gate alone decides.
- AC-017-3: Given a repository with no configuration, when the merge flow is invoked, then it stops and names the missing configuration rather than assuming defaults from another repository.

### REQ-018: The app credential is protected (Must) [RISK: the app's private key is the trust root; anyone holding it can post a passing status without running the gate]

The credential that lets the maintainer-owned app post results is held only where the gate runs and is never committed, logged or published.

- AC-018-1: Given the app credential, when the repository, run logs and published statuses are inspected, then the credential does not appear in any of them.
- AC-018-2: Given the credential is absent, when a local run is requested, then the run may execute but publishes nothing and reports that it cannot attest.
- AC-018-3: Given the credential is suspected to be exposed, when the maintainer follows the documented rotation procedure, then the old credential stops working and the app can post again with a new one.
## Dependency Map

| REQ | Depends On | Blocked By | Notes |
|---|---|---|---|
| REQ-001 | REQ-003, REQ-004, REQ-009 | REQ-004 | Cannot approve without bound, enforceable evidence |
| REQ-002 | REQ-001 | - | Entry point for the whole flow |
| REQ-003 | - | - | Foundation for trust |
| REQ-004 | REQ-003, REQ-018 | Branch-protection change | `dev` required checks are currently pinned to the GitHub Actions app |
| REQ-005 | REQ-001, REQ-004 | - | Must precede enabling the gate |
| REQ-006 | REQ-001 | - | Only safe once REQ-001 is enforced |
| REQ-007 | REQ-006 | - | Compensates for the review no longer gating |
| REQ-008 | REQ-001 | - | Compensates for hosted CI no longer gating |
| REQ-009 | - | - | Determines gate fidelity |
| REQ-010 | REQ-009 | - | Local runs may need credentials |
| REQ-011 | REQ-009 | - | Approval set is user-editable |
| REQ-012 | - | - | Constraint on all requirements |
| REQ-013 | REQ-001, REQ-006 | - | Needs both gates changed to measure |
| REQ-014 | REQ-001, REQ-006 | - | Reverses both gates |
| REQ-015 | REQ-001, REQ-009 | - | Failure UX |
| REQ-016 | REQ-001, REQ-004 | - | Optional earlier application |
| REQ-017 | REQ-009 | - | Makes the approval set and tracker per-repository |
| REQ-018 | REQ-004 | - | Protects the credential REQ-004's trust depends on |

**Implementation clusters:** (REQ-003, REQ-004, REQ-005, REQ-018) must land together before REQ-001 is enabled; (REQ-006, REQ-007, REQ-008) must land together so removing a gate never ships without its compensating follow-up.

**Circular dependencies:** none.

## Self-Critique Findings (auto-applied)

1. **Gap, security:** Skipping hosted CI makes the maintainer's machine the trust root. Addressed by REQ-003 (head-bound, clean checkout), REQ-004 (app identity and run record), REQ-005 (gate can fail) and REQ-018 (credential protection). Residual risk accepted and recorded under Notes.
2. **Contradiction:** `PRD-2026-82b6a138` requires CodeRabbit to remain authoritative. Resolved by stating the reversal under "Relationship to prior work" and scoping it in REQ-006.
3. **Ambiguity:** "Using act to run the ci locally" did not say which workflows. Resolved by REQ-009 (mirror today's required checks; unsupported steps fail) and REQ-017 (per-repository configuration).
4. **Missing edge case:** Required checks on `dev` are bound to the GitHub Actions app. Resolved by REQ-004 requiring a maintainer-owned app and re-pinning protection to it.
5. **Testability:** "Waiting WAY too long" has no number. Resolved by REQ-013: capture a baseline first, set the target afterward.
6. **Scope:** CodeRabbit is not active on Ensemble, so the stated pain does not occur there. Resolved by making the feature repository-agnostic (REQ-017) and describing bot review handling generally (REQ-006, REQ-007).

## Implementation Readiness Gate

| Dimension | Score | Note |
|---|---|---|
| Completeness | 5 | Gate, evidence, bot and human review handling, post-merge follow-up, hosted-CI safety net, rollback, measurement, per-repository configuration and credential protection are all covered. |
| Testability | 4 | Every Must and Should requirement has Given/When/Then criteria, including a gate-can-fail check. AC-004-3/004-4 are specified but unproven against a real protected branch. |
| Clarity | 5 | All open questions are resolved and recorded as decisions. |
| Feasibility | 4 | A local CI runner already exists on the integration branch and the app-pinning constraint is documented; the remaining uncertainty is runner fidelity against the Node 22/24 matrix and the cost of a clean checkout plus `npm ci` per run. |

**Overall: 4.5 (PASS).** No clarification markers remain.

## Notes

- **Ambiguity scan complete: 0 items remain.** All 9 markers raised at creation were resolved during refinement on 2026-10-21.
- **Observed repository facts at authoring time (inputs, not requirements):** the `dev` branch requires `validate`, `test (22)` and `test (24)`, each pinned to the GitHub Actions app (app id 15368), with no required reviews; the `main` branch requires `release-gate` and `source-branch` with stale-review dismissal and zero required approvals; both enforce for administrators. The existing merge command refuses to merge while a review decision is `CHANGES_REQUESTED`. In the last 30 PRs on the Ensemble repository, CodeRabbit left no reviews or comments and the only bot reviewer was `github-actions[bot]`.
- **Verified against GitHub documentation (2026-10-21):** a protected branch can require a check from a specific GitHub App and rejects one set by another source ("Required status check ... was not set by the expected GitHub App"); check runs can be created only by a GitHub App, while a personal token can only use the classic commit-status API; required checks must pass on the latest head SHA; a required check must have completed within the past seven days. This was not tested by posting a status to a protected branch; AC-004-3 and AC-004-4 must be proven against a real branch before the gate is enabled.
- **Residual risk accepted:** the app identity proves who posted a result, and the run record makes a careless or stale post detectable, but nothing proves the local CI steps actually ran. A maintainer holding the app credential could post success without running the gate. This is bounded by REQ-018 and out of scope to eliminate (see Out of scope).
- Depth was set to STANDARD by default; no depth question was asked.

## Changelog

| Date | Version | Change |
|---|---|---|
| 2026-10-21 | 1.0.0 | Initial draft from the user's request and three recorded design decisions. |
| 2026-10-21 | 1.0.1 | Refinement: resolved all 9 clarification markers. Scope made repository-agnostic after finding CodeRabbit inactive on Ensemble. Evidence now posted by a maintainer-owned GitHub App with a run record; run executes in a clean checkout of the head SHA; approval set mirrors today's required checks with unsupported steps failing the gate; human `CHANGES_REQUESTED` still blocks while bot reviews do not; late findings and post-merge CI failures are captured as beads by the next merge-flow run; success target deferred until a baseline is measured. Added REQ-017 (per-repository configuration) and REQ-018 (app credential protection); added AC-012-2. Readiness 4.0 to 4.5. PRD locked. |
| 2026-10-21 | 1.0.2 | Wording-only change, no requirement added, removed or re-prioritised: replaced `act` and "container runtime" with runner-neutral terms ("local CI runner", "the repository's local CI entry point") in the Solution, decisions, Entry criteria, AC-004-5, AC-009-2, AC-015-2, the readiness note and the residual-risk note. Reason: `dev` already ships a tested clean-clone runner (`npm run ci:local`, PR #184) and the user chose to wrap it instead of building an `act` runner, so a PRD naming `act` contradicted the implementation and the beads that quote these criteria. AC-004-5 now names the runner identity instead of an `act` version. The user's original request ("using act") is kept as history in the self-critique. Requirement and AC counts are unchanged (18 and 47). |
| 2026-10-21 | 1.0.3 | Baseline recorded per AC-013-3; no requirement added, removed or re-prioritised. Measured on this repository over its last 30 PRs merged to `dev` (2026-10-12 to 2026-10-21): open-to-merge median 105.9 min and p75 683.5 min; hosted CI wait median 2.6 min (about 2.5% of the median); CodeRabbit left no review on any of the 30, so bot-review wait is unmeasurable here. **Decision (maintainer): no numeric target and no minimum post-change cohort is set for this repository.** The data leaves nothing material to reduce here, so a target would be unfalsifiable; status stays `unproven` by design (AC-013-2). The target, minimum cohort size and duration are to be set per adopting repository, from a baseline captured there with `packages/development/skills/local-ci-gate/BASELINE.md`'s procedure, before that repository enables the gate. Figures are reproducible from `baseline-cohort.json`. |
