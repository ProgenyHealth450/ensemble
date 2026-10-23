---
name: ensemble-pr-merge
description: Drive an open PR to green and merged by dispatching one subagent per failing CI check and unresolved review thread, routed through the correct orchestrator (Codex skill for /ensemble:pr-merge)
user-invocable: true
argument-hint: '[pr-number-or-url] [--max-rounds=N] [--dry-run] [--foreman]'
model: gpt-5.1-codex
capabilities:
  required:
    - host.change-request-view
    - host.change-request-checks
    - host.change-request-merge
  optional:
    - host.change-request-threads
---

# Ensemble Command: /ensemble:pr-merge

This Codex skill mirrors the Ensemble slash command `/ensemble:pr-merge`.
Follow the workflow below, adapt to the current repository, and keep outputs structured.

<!-- DO NOT EDIT - Generated from pr-merge.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Take an open PR from red to merged in the fewest rounds. Each failing/pending CI check and
unresolved change-request thread is one finding, routed to the owning agent and fixed in
parallel, then re-verified against live state until green, then merged.

## Workflow

### Phase 1: PR Discovery

**1. Toolchain Preflight**

- Resolve TOOLCHAIN_CLI (RELATIVE_PATH packages/development/lib/toolchain-cli.js) with the tool-path-resolution skill (packages/development/skills/tool-path-resolution/SKILL.md). If it does not resolve print "ERROR: could not locate toolchain-cli" and HALT.
- Run: node "$TOOLCHAIN_CLI" preflight --require host.change-request-view --require host.change-request-checks --require host.change-request-merge --json [add --non-interactive when --foreman is present] and parse stdout as PREFLIGHT_RESULT. ok:false -> print PREFLIGHT_RESULT.error.message and HALT. Store RUN_ID = PREFLIGHT_RESULT.runId; every later toolchain-cli call in this invocation passes --run-id "$RUN_ID". host.change-request-threads is optional and not preflighted here; its call sites below are skipped silently on {ok:false}, never HALTing.

**2. Resolve Target PR**
   Delegate to git-workflow.

- HALT if CR_VIEW is not ok (no open change request found) or its state already reports the change request merged or closed, per the host adapter's own raw state vocabulary (see that adapter's SKILL.md).
- HALT if the host adapter's own output or the git-workflow delegate's inspection shows the change request is still a draft (mark ready for review first; do not operate on drafts) -- the normalized change-request shape carries no isDraft field, so this check relies on the git-workflow delegate's own host-CLI knowledge.
- Record PR_NUMBER, PR_URL, HEAD_REF, BASE_REF from CR_VIEW's id, url, headBranch, baseBranch.

   **Delegation:** @git-workflow
   Resolve --pr (number or URL) to PR_NUMBER (extract the trailing numeric path segment from a URL); if omitted, determine the open change request for the current branch, then run: node "$TOOLCHAIN_CLI" run host.change-request-view --run-id "$RUN_ID" --arg id=<PR_NUMBER> --json and parse stdout as CR_VIEW for id, url, state, baseBranch, headBranch, checks.

**3. Baseline Findings Manifest**
   Same manifest shape is rebuilt at the top of every round.

- Checks: run the local-ci-gate skill for the current head; its verdict (verified pass for this exact head, or no/failed/stale run) replaces waiting on hosted checks. Pass the skill the repo (owner/name), PR_NUMBER, and the PR's base branch ref (origin/<baseRefName>, fetched fresh) as baseRef. A failed gate run is a finding of kind check. Hosted checks are not watched to completion.
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
- Manifest empty: proceed to Merge and Report.
- Findings remain and round_number < --max-rounds: increment, re-route, re-dispatch.
- Findings remain and round_number == --max-rounds: HALT, emit the final report with each open finding, its last owner and latest log/comment state, and stop for human escalation.

### Phase 5: Merge and Report

**1. Merge**
   Delegate to git-workflow.

- Run the local-ci-gate skill for the current head, passing the repo (owner/name), PR_NUMBER, and the PR's base branch ref (origin/<baseRefName>, fetched fresh) as baseRef; do not restate or reimplement its logic. If it reports no run, a failed run, or a stale run, abort and run another verification round.
- Immediately before merging re-check gh pr view <PR_NUMBER> --json mergeable,mergeStateStatus,reviewDecision,latestReviews; if not MERGEABLE or a human reviewer's latest decisive review is CHANGES_REQUESTED (bots excluded, by account type), abort and run another verification round.
- Run the sweep BEFORE merging: local-ci-cli.js sweep, with the CLI located exactly as the local-ci-gate skill locates it (tool-path-resolution; never a hard-coded path); record each new finding or CI-failure bead through br (dedupe keys prevent duplicates).
- If --dry-run: stop and report merge-readiness without merging.
- Merge (confirm-gated): before this command's first host write: run node "$TOOLCHAIN_CLI" confirm-status host.change-request-merge --run-id "$RUN_ID" --json [add --non-interactive when --foreman is present] and parse as CONFIRM_STATUS. If CONFIRM_STATUS.data.required is true and CONFIRM_STATUS.data.confirmed is false: when --foreman is not present ask via AskUserQuestion "Allow the host adapter to merge PR <PR_NUMBER>? [yes/no]"; on yes run node "$TOOLCHAIN_CLI" confirm-record host.change-request-merge --run-id "$RUN_ID" --json. Under --foreman, never prompt (non-interactive already passed: the CLI auto-confirms and logs).
- Merge: run node "$TOOLCHAIN_CLI" run host.change-request-merge --run-id "$RUN_ID" --arg id=<PR_NUMBER> --json [add --non-interactive when --foreman is present] (uses the host adapter's configured merge method; do not assume a specific strategy); do NOT delete the source branch in this step.
- Run the sweep AFTER merging and BEFORE deleting the source branch: local-ci-cli.js sweep, with the CLI located exactly as the local-ci-gate skill locates it (tool-path-resolution; never a hard-coded path); record each new finding or CI-failure bead through br (dedupe keys prevent duplicates).
- Only after the post-merge sweep has run, delete the source branch unless it is long-lived.
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
/ensemble:pr-merge [pr-number-or-url] [--max-rounds=N] [--dry-run] [--foreman]
```
