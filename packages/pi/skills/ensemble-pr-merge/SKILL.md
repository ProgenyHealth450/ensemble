---
name: ensemble-pr-merge
description: >-
  Take an open PR from red to merged in the fewest rounds. Each failing/pending
  CI check and unresolved change-request thread is one finding, routed to the
  owning agent and fixed in parallel, then re-verified against live state until
  green, then merged.
disable-model-invocation: true
---
<!-- Command: ensemble-pr-merge | Version: 2.0.0 -->
<!-- Description: Drive an open PR to green and merged by dispatching one subagent per failing CI check and unresolved review thread, routed through the correct orchestrator -->

# ensemble-pr-merge

> **Mission:** Take an open PR from red to merged in the fewest rounds. Each failing/pending CI check and unresolved change-request thread is one finding, routed to the owning agent and fixed in parallel, then re-verified against live state until green, then merged.

> **Constraints:**
> - NEVER delete, skip, xfail, disable, or weaken a test to make a check pass. Every dispatched subagent inherits this constraint verbatim in its payload. Failing tests, compiler warnings, and build failures MUST be fixed at the root cause. If a test is genuinely obsolete, the subagent MUST HALT and escalate it in the round report for human confirmation.
> - NEVER force-push over commits you did not author in this run, and NEVER bypass branch protection, required reviews, or required status checks.
> - NEVER merge without a verified passing local CI status bound to the exact head SHA, as reported by the local-ci-gate skill; hosted CI is NOT waited for. Refuse to merge while a HUMAN reviewer's latest decisive review is CHANGES_REQUESTED, or while the gate reports no run, a failed run, or a stale run (head moved since the verified run). A bot account's CHANGES_REQUESTED review or unresolved bot threads are NOT a refusal. Classify reviewers by the GitHub account type field (Bot vs User), never by account name.
> - Bound remediation to --max-rounds (default 5). Exceeding it is a HALT-and-escalate outcome: the final report MUST list every still-open finding and its last known owner.
> - Each round dispatches ALL findings concurrently (one subagent per finding) and waits for every dispatch to settle before re-checking.
> - A finding is resolved only when the fix is pushed to the PR branch AND the check/review thread is independently re-verified as passing/resolved from fresh gh state in the next round -- never trust a subagent's self-report.

## Phase 1: PR Discovery

### Step 1: Resolve Target PR

Delegate to git-workflow.

**Actions:**
1. HALT if no PR is found, it is MERGED/CLOSED, or isDraft is true (mark ready for review first; do not operate on drafts).
2. Record PR_NUMBER, PR_URL, HEAD_REF, BASE_REF.

### Step 2: Baseline Findings Manifest

Same manifest shape is rebuilt at the top of every round.

**Actions:**
1. Checks: run the local-ci-gate skill for the current head; its verdict (verified pass for this exact head, or no/failed/stale run) replaces waiting on hosted checks. Pass the skill the PR's base branch ref (origin/<baseRefName>, fetched fresh) as baseRef. A failed gate run is a finding of kind check. Hosted checks are not watched to completion.
2. Reviews: gh pr view <PR_NUMBER> --json reviews,reviewDecision,latestReviews; classify each reviewer by the account type field (Bot vs User), never by name. For a HUMAN reviewer whose latest decisive review is CHANGES_REQUESTED fetch unresolved threads via gh api graphql (reviewThreads, isResolved:false) -- one entry per thread. Bot-authored CHANGES_REQUESTED reviews and bot threads are not findings that block merge.
3. If the gate reports a verified pass for this head and no human reviewer's latest decisive review is CHANGES_REQUESTED and mergeable == MERGEABLE: skip to Merge and Report.
4. Otherwise write a numbered manifest of { finding_id, kind: check|review_thread, name, raw_log_excerpt_or_comment_body, link }.

## Phase 2: Classification and Routing

### Step 1: Route Every Finding

Assign exactly one owner per finding; first matching row wins, never dual-route.

**Actions:**
1. 1. Missing/incorrect test, coverage regression, flaky test, or BDD scenario gap -> test-runner.
2. 2. Test-runner job failing for a reason other than the test itself (code under test is broken) -> test-runner triages first and re-routes to tech-lead-orchestrator via a follow-up finding next round if root cause is implementation code.
3. 3. Build/codegen/lint/typecheck/validate pipeline failure, or a review comment on implementation correctness, architecture, or a compiler warning -> tech-lead-orchestrator.
4. 4. CI/CD pipeline infrastructure itself (artifact packaging, dependency resolution, build-system config unrelated to the PR's code) -> build-orchestrator.
5. 5. Cloud infrastructure, IaC, deployment, environment config -> infrastructure-orchestrator.
6. 6. Merge conflicts, stale branch, missing approvals, branch protection, commit-message/PR-metadata issues -> git-workflow.

## Phase 3: Parallel Remediation Dispatch

### Step 1: Build Payloads

**Actions:**
1. One self-contained payload per finding (the subagent has no conversation history): { PR_NUMBER, PR_URL, HEAD_REF, finding_id, kind, name, raw_log_excerpt_or_comment_body, link, round_number, hard_constraints (this command's constraints verbatim), push_instructions: 'commit and git push to HEAD_REF directly; do not open a new PR' }.

### Step 2: Concurrent Dispatch and Barrier

**Actions:**
1. Launch every finding's Task (subagent_type=<ROUTE_AGENT>, prompt=<payload>) before waiting on any; then wait for the whole round to settle. One hung or failed subagent does not cancel siblings.
2. A subagent that reports success without a pushed commit leaves the finding open for re-verification.

## Phase 4: Verification and Round Loop

### Step 1: Re-Verify Against Live State

**Actions:**
1. Rebuild the manifest from scratch (never reuse the pre-round one): re-run the local-ci-gate skill for the new head and gh pr view --json reviews,reviewDecision,latestReviews,mergeable,mergeStateStatus.
2. Mark each prior finding resolved or still-open, and add any new finding (e.g. a regression introduced by a fix).
3. Manifest empty and mergeable == MERGEABLE: proceed to Merge and Report.
4. Findings remain and round_number < --max-rounds: increment, re-route, re-dispatch.
5. Findings remain and round_number == --max-rounds: HALT, emit the final report with each open finding, its last owner and latest log/comment state, and stop for human escalation.

## Phase 5: Merge and Report

### Step 1: Merge

Delegate to git-workflow.

**Actions:**
1. Run the local-ci-gate skill for the current head, passing the PR's base branch ref (origin/<baseRefName>, fetched fresh) as baseRef; do not restate or reimplement its logic. If it reports no run, a failed run, or a stale run, abort and run another verification round.
2. Immediately before merging re-check gh pr view <PR_NUMBER> --json mergeable,mergeStateStatus,reviewDecision,latestReviews; if not MERGEABLE or a human reviewer's latest decisive review is CHANGES_REQUESTED (bots excluded, by account type), abort and run another verification round.
3. Run the sweep BEFORE merging: local-ci-cli.js sweep, with the CLI located exactly as the local-ci-gate skill locates it (tool-path-resolution; never a hard-coded path); record each new finding or CI-failure bead through br (dedupe keys prevent duplicates).
4. If --dry-run: stop and report merge-readiness without merging.
5. Merge with gh pr merge using the repo's configured merge method (check branch protection/repo settings; do not assume); do NOT delete the source branch in this step.
6. Run the sweep AFTER merging and BEFORE deleting the source branch: local-ci-cli.js sweep, with the CLI located exactly as the local-ci-gate skill locates it (tool-path-resolution; never a hard-coded path); record each new finding or CI-failure bead through br (dedupe keys prevent duplicates).
7. Only after the post-merge sweep has run, delete the source branch unless it is long-lived.
8. Comment on the PR summarizing each remediated finding, its owner, and the round count.

### Step 2: Final Report

**Actions:**
1. Last line of stdout, valid JSON, no prose after it: { pr_number, pr_url, rounds_executed, findings_total, findings_resolved, findings_escalated, merged (bool), halted_reason (string|null) }
