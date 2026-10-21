---
name: "ensemble:pr-merge"
description: "Drive an open PR to green and merged by dispatching one subagent per failing CI check and unresolved review thread, routed through the correct orchestrator"
version: "2.0.0"
category: "git"
last-updated: "2026-10-20"
allowed-tools: "Read, Bash, Task, Grep, Glob, TodoWrite"
argument-hint: "[pr-number-or-url] [--max-rounds=N] [--dry-run]"
model: "opus"
---
<!-- DO NOT EDIT - Generated from pr-merge.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Take an open PR from red to merged in the fewest rounds. Each failing/pending CI check and
unresolved change-request thread is one finding, routed to the owning agent and fixed in
parallel, then re-verified against live state until green, then merged.

## Workflow

### Phase 1: PR Discovery

**1. Resolve Target PR**
   Delegate to git-workflow.

- HALT if no PR is found, it is MERGED/CLOSED, or isDraft is true (mark ready for review first; do not operate on drafts).
- Record PR_NUMBER, PR_URL, HEAD_REF, BASE_REF.

   **Delegation:** @git-workflow
   Resolve --pr (number or URL) or, if omitted, the PR for the current branch via gh pr view --json number,url,state,headRefName,baseRefName,mergeable,mergeStateStatus,reviewDecision,isDraft

**2. Baseline Findings Manifest**
   Same manifest shape is rebuilt at the top of every round.

- Checks: run the local-ci-gate skill for the current head; its verdict (verified pass for this exact head, or no/failed/stale run) replaces waiting on hosted checks. A failed gate run is a finding of kind check. Hosted checks are not watched to completion.
- Reviews: gh pr view <PR_NUMBER> --json reviews,reviewDecision,latestReviews; classify each reviewer by the account type field (Bot vs User), never by name. For a HUMAN reviewer whose latest decisive review is CHANGES_REQUESTED fetch unresolved threads via gh api graphql (reviewThreads, isResolved:false) -- one entry per thread. Bot-authored CHANGES_REQUESTED reviews and bot threads are not findings that block merge.
- If the gate reports a verified pass for this head and no human reviewer's latest decisive review is CHANGES_REQUESTED and mergeable == MERGEABLE: skip to Merge and Report.
- Otherwise write a numbered manifest of { finding_id, kind: check|review_thread, name, raw_log_excerpt_or_comment_body, link }.

### Phase 2: Classification and Routing

**1. Route Every Finding**
   Assign exactly one owner per finding; first matching row wins, never dual-route.

- 1. Missing/incorrect test, coverage regression, flaky test, or BDD scenario gap -> test-runner.
- 2. Test-runner job failing for a reason other than the test itself (code under test is broken) -> test-runner triages first and re-routes to tech-lead-orchestrator via a follow-up finding next round if root cause is implementation code.
- 3. Build/codegen/lint/typecheck/validate pipeline failure, or a review comment on implementation correctness, architecture, or a compiler warning -> tech-lead-orchestrator.
- 4. CI/CD pipeline infrastructure itself (artifact packaging, dependency resolution, build-system config unrelated to the PR's code) -> build-orchestrator.
- 5. Cloud infrastructure, IaC, deployment, environment config -> infrastructure-orchestrator.
- 6. Merge conflicts, stale branch, missing approvals, branch protection, commit-message/PR-metadata issues -> git-workflow.

### Phase 3: Parallel Remediation Dispatch

**1. Build Payloads**

- One self-contained payload per finding (the subagent has no conversation history): { PR_NUMBER, PR_URL, HEAD_REF, finding_id, kind, name, raw_log_excerpt_or_comment_body, link, round_number, hard_constraints (this command's constraints verbatim), push_instructions: 'commit and git push to HEAD_REF directly; do not open a new PR' }.

**2. Concurrent Dispatch and Barrier**

- Launch every finding's Task (subagent_type=<ROUTE_AGENT>, prompt=<payload>) before waiting on any; then wait for the whole round to settle. One hung or failed subagent does not cancel siblings.
- A subagent that reports success without a pushed commit leaves the finding open for re-verification.

### Phase 4: Verification and Round Loop

**1. Re-Verify Against Live State**

- Rebuild the manifest from scratch (never reuse the pre-round one): re-run the local-ci-gate skill for the new head and gh pr view --json reviews,reviewDecision,latestReviews,mergeable,mergeStateStatus.
- Mark each prior finding resolved or still-open, and add any new finding (e.g. a regression introduced by a fix).
- Manifest empty and mergeable == MERGEABLE: proceed to Merge and Report.
- Findings remain and round_number < --max-rounds: increment, re-route, re-dispatch.
- Findings remain and round_number == --max-rounds: HALT, emit the final report with each open finding, its last owner and latest log/comment state, and stop for human escalation.

### Phase 5: Merge and Report

**1. Merge**
   Delegate to git-workflow.

- Run the local-ci-gate skill for the current head; do not restate or reimplement its logic. If it reports no run, a failed run, or a stale run, abort and run another verification round.
- Immediately before merging re-check gh pr view <PR_NUMBER> --json mergeable,mergeStateStatus,reviewDecision,latestReviews; if not MERGEABLE or a human reviewer's latest decisive review is CHANGES_REQUESTED (bots excluded, by account type), abort and run another verification round.
- Run the sweep BEFORE merging: local-ci-cli.js sweep, with the CLI located exactly as the local-ci-gate skill locates it (tool-path-resolution; never a hard-coded path); record each new finding or CI-failure bead through br (dedupe keys prevent duplicates).
- If --dry-run: stop and report merge-readiness without merging.
- Merge with gh pr merge using the repo's configured merge method (check branch protection/repo settings; do not assume); delete the source branch unless it is long-lived.
- Run the sweep AFTER merging: local-ci-cli.js sweep, with the CLI located exactly as the local-ci-gate skill locates it (tool-path-resolution; never a hard-coded path); record each new finding or CI-failure bead through br (dedupe keys prevent duplicates).
- Comment on the PR summarizing each remediated finding, its owner, and the round count.

   **Delegation:** @git-workflow
   The local-ci-gate skill reports a verified pass for the exact head and no human reviewer's latest decisive review is CHANGES_REQUESTED: merge per repo convention and clean up the branch.

**2. Final Report**

- Last line of stdout, valid JSON, no prose after it: { pr_number, pr_url, rounds_executed, findings_total, findings_resolved, findings_escalated, merged (bool), halted_reason (string|null) }

## Expected Output

**Format:** Progress narration per round, then a single JSON summary line

**Structure:**
- **Round Narration**: Per round: findings manifest, routing decisions, dispatch/barrier confirmation, re-verification diff
- **JSON Summary**: One line of valid JSON describing the final outcome: merged, escalated findings, and round count

## Usage

```
/ensemble:pr-merge [pr-number-or-url] [--max-rounds=N] [--dry-run]
```
