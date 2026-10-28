---
name: ensemble-pr-merge
description: Drive an open PR to green and merged by dispatching one subagent per failing CI check and unresolved review thread, routed through the correct orchestrator (Codex skill for /ensemble:pr-merge)
user-invocable: true
argument-hint: '[pr-number-or-url] [--max-rounds=N] [--dry-run]'
model: gpt-5.1-codex
---

# Ensemble Command: /ensemble:pr-merge

This Codex skill mirrors the Ensemble slash command `/ensemble:pr-merge`.
Follow the workflow below, adapt to the current repository, and keep outputs structured.

<!-- DO NOT EDIT - Generated from pr-merge.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Take an open pull request from red to merged with the minimum number of round-trips.
Discovers every failing/pending CI check and every unresolved review change-request as
a distinct finding, classifies each by root cause (implementation code, tests, build/CI
pipeline, infrastructure/deployment, or PR mechanics), and dispatches one subagent per
finding in parallel through the orchestrator that owns that domain: the tech-lead-orchestrator
for implementation code, qa-orchestrator for test failures and test-related review comments,
build-orchestrator for CI/build-pipeline checks, infrastructure-orchestrator for
infra/deployment checks, and github-specialist for PR mechanics (conflicts, branch state,
approvals, merge). Re-verifies against live CI/review state after every round -- never
trusts a subagent's self-report -- and loops, bounded by the shared policy round cap, until every check is
green and every review thread is resolved, then merges. Hard constraint: no finding may be
resolved by deleting, skipping, or weakening a test; only real fixes to source, test, build,
or config code count as resolution. Once merge-ready, distills every finding resolved
this run into durable guardrails and, when at least one survives, opens a small, separate
housekeeping PR against the base branch that appends them to the target repo's existing
constitution (docs/standards/constitution.md, or .specify/memory/constitution.md when that
is the only one present) -- never creates one, and never touches the PR being merged's own
branch or commit history -- so create-prd, create-trd, refine-prd, and future pr-merge runs
are less likely to reproduce the same class of failure.

## Workflow

### Phase 1: PR Discovery

**1. Resolve Target PR**
   Resolve the PR to operate on and confirm it is actually mergeable-in-principle
before doing any remediation work.


- HALT if no matching PR is found, the PR is already MERGED/CLOSED, or isDraft is true (mark ready for review first, do not operate on drafts).
- Record PR_NUMBER, PR_URL, HEAD_REF, BASE_REF for the rest of the run.

   **Delegation:** @github-specialist
   Resolve --pr argument (number or URL) or, if omitted, the PR for the current branch via gh pr view --json number,url,state,headRefName,baseRefName,mergeable,mergeStateStatus,reviewDecision,isDraft.

**2. Baseline Findings Manifest**
   Build the round-0 Findings Manifest: one entry per failing/pending CI check, one
entry per unresolved review thread with a change request. This is the same manifest
shape reused at the top of every remediation round.


- Fetch checks: gh pr checks <PR_NUMBER> --json name,state,bucket,workflow,link,description. Include every check whose state is FAILURE, ERROR, CANCELLED, TIMED_OUT, or PENDING (do not skip pending -- it must still be watched to a terminal state before merge).
- Fetch review state: gh pr view <PR_NUMBER> --json reviews,reviewDecision,latestReviews. For reviewDecision == CHANGES_REQUESTED, fetch the actual unresolved review comment threads via gh api graphql (reviewThreads: isResolved:false) or gh api repos/{owner}/{repo}/pulls/{PR_NUMBER}/comments -- one Findings Manifest entry per distinct unresolved thread, not one entry for the whole review.
- If zero failing/pending checks AND reviewDecision is not CHANGES_REQUESTED AND mergeable == MERGEABLE: skip directly to the Merge phase -- there is nothing to remediate. Skipping remediation never skips the merge gate: the Merge phase still runs pr-review-cycle MODE=gate and still requires mergeable:true before merging.
- Otherwise write the Findings Manifest as a numbered list: { finding_id, kind: check|review_thread, name, raw_log_excerpt_or_comment_body, link }.

### Phase 2: Classification and Routing

**1. Classify Every Finding**
   Assign exactly one owning orchestrator per Findings Manifest entry using the fixed routing table below. Never leave a finding unrouted.

- ROUTING TABLE -- apply top to bottom, first match wins:
- 1. Review thread or check log whose primary content is a missing/incorrect/insufficient test, a test coverage regression, a flaky test, or a reqnroll/BDD scenario gap -> qa-orchestrator.
- 2. Check whose job name/workflow matches the repo's test runner (test.yml / *test* job) failing for a reason OTHER than the test itself being wrong (e.g. the code under test is broken) -> qa-orchestrator triages first; if qa-orchestrator's subagent determines root cause is implementation code, it re-routes by creating a follow-up finding for tech-lead-orchestrator in the next round rather than fixing production code itself.
- 3. Check whose job name/workflow matches build/codegen/lint/typecheck/validate pipelines (validate.yml, codex-generate.yml, opencode-generate.yml, pi-generate.yml, or any compiler/build step) OR a review comment about implementation code correctness, architecture, or a compiler warning -> tech-lead-orchestrator (the development orchestrator for this plugin).
- 4. Check whose job name/workflow is CI/CD pipeline infrastructure itself (artifact packaging, dependency resolution, matrix/build-system configuration unrelated to the PR's own code) -> build-orchestrator.
- 5. Check or comment about cloud infrastructure, IaC, deployment, environment config, or monitoring -> infrastructure-orchestrator.
- 6. Anything about merge conflicts, stale/out-of-date branch, missing required approvals, branch protection, commit message/conventional-commit format, or PR metadata (title, labels, linked issue) -> github-specialist.
- Every finding gets exactly one ROUTE_AGENT. If a finding plausibly matches two rows, pick the first (topmost) match -- do not dual-route.

### Phase 3: Parallel Remediation Dispatch

**1. Build Round Payloads**
   Construct one immutable remediation payload per Findings Manifest entry. The payload
is the entire brief the subagent receives -- it does not have this conversation's
history.


- Each payload MUST include: { PR_NUMBER, PR_URL, HEAD_REF, finding_id, kind, name, raw_log_excerpt_or_comment_body, link, round_number, hard_constraints (verbatim copy of this command's constraints: block, push_instructions: 'commit and git push to HEAD_REF directly; do not open a new PR' }.
- hard_constraints in every payload MUST restate: never delete/skip/weaken a test to make it pass; fix failing tests, compiler warnings, and build failures for real; if a test looks obsolete, HALT and report instead of deleting it.

**2. Concurrent Dispatch**
   Launch every finding's remediation subagent at once through its ROUTE_AGENT, without
waiting on any single one, then wait for the whole round to settle. This mirrors the
beads-build-wave.yaml concurrent-dispatch-then-barrier pattern.


- For each finding in the round, launch Task(subagent_type=<ROUTE_AGENT>, prompt=<remediation_payload>) WITHOUT waiting on any one. Start every finding's dispatch before waiting on any of them.
- Barrier: wait for every dispatched subagent in the round to settle. One finding's subagent failing or hanging does NOT cancel or block its siblings' dispatches -- isolate failures per finding.
- Each subagent is responsible for its own commit + push to HEAD_REF before it reports back; a subagent that reports success without a pushed commit is treated as still-open in the next round's re-verification (see constraints: never trust self-report).

### Phase 4: Verification and Round Loop

**1. Re-Verify Against Live State**
   After a round's barrier settles, re-read CI/review state from scratch -- do not reuse
the pre-round manifest -- and rebuild the Findings Manifest exactly as in PR Discovery
step 2.


- Re-run: gh pr checks <PR_NUMBER> --json name,state,bucket,workflow,link,description and gh pr view <PR_NUMBER> --json reviews,reviewDecision,latestReviews,mergeable,mergeStateStatus.
- Diff against the round's dispatched findings: mark each as resolved (no longer failing/pending, or thread now resolved) or still-open (persists) or new (appeared only after this round's fixes -- e.g. a regression introduced by a fix).
- If the manifest is now empty (zero failing/pending checks, no CHANGES_REQUESTED, mergeable == MERGEABLE): proceed to the Merge phase.
- If findings remain and round_number < ROUND_CAP (the lower of the policy cap from the pr-review-cycle skill and any --max-rounds argument): increment round_number, re-classify the new manifest (Classification and Routing phase), and re-dispatch (Parallel Remediation Dispatch phase).
- If findings remain and round_number == ROUND_CAP: HALT. Do not merge. Produce the final report (Reporting step) with every still-open finding, its last owning orchestrator, and its most recent log/comment state, and ask the author to step back and reconsider the approach rather than opening another round.

### Phase 5: Constitution Learning Capture

**1. Aggregate Guardrails and Update Constitution**
   Once the Findings Manifest is empty and merge is imminent, distill the findings
resolved across every round this run into zero or more durable, generalizable
guardrails and, when any survive, land them in the target repo's existing
constitution via a small, independent PR against BASE_REF -- never by touching
the PR being merged. This step never blocks, delays, or reverses that PR's merge
decision -- any failure inside it, including the housekeeping PR itself failing
checks or review, is logged and swallowed, not escalated.


- Skip this entire phase when --dry-run is set, or when the Findings Manifest was empty at round 0 (nothing was actually remediated this run) -- there is nothing to learn.
- Resolve the canonical constitution the same way create-prd/create-trd do: docs/standards/constitution.md when present, else .specify/memory/constitution.md, else skip this phase entirely and proceed straight to Merge and Report. This command NEVER creates a constitution file -- that is /ensemble:init-project's job, not pr-merge's.
- For each finding resolved this run (across all rounds), classify it as PATTERN (a systemic, preventable mistake a future author or agent could plausibly repeat -- e.g. a test pinning an exact version/date string instead of an invariant, a stale text anchor left behind by a rename, a missing codegen step before commit, a previously-banned pattern reintroduced) or ONE-OFF (a unique bug or typo with no generalizable rule). Only PATTERN findings produce a candidate guardrail; ONE-OFF findings produce none.
- For each PATTERN finding, draft exactly one guardrail: a short imperative rule plus a one-clause reason, stated as the general lesson -- never as a restatement of the specific bug or a reference to this PR/file (e.g. 'NEVER assert an exact version or date string in a test as proof a change shipped; assert the underlying invariant instead' rather than 'fix the version check in implement-trd-command.test.js').
- Read the full canonical constitution, at its current tip on BASE_REF, before finalizing any draft. Drop any candidate guardrail whose rule is already covered, equaled, or subsumed by existing constitution content anywhere in the document -- never append a near-duplicate rule.
- If zero guardrails survive classification and deduplication, stop here without touching the constitution file, creating a branch, or opening a PR.
- Otherwise append each surviving guardrail as a new numbered item under the constitution's non-negotiable-rules list inside its Core Principles section when that section and list exist in the recognizable init-project format; if the canonical constitution predates that structure (a migrated/legacy .specify constitution, or one hand-edited into an incompatible shape), append a new top-level `## CI/Review Remediation Guardrails` section instead rather than guessing at foreign structure. Add one Changelog row per guardrail using the constitution's existing Date/Change/Author table columns: `| <ISO date> | Guardrail: <one-line summary> | /ensemble:pr-merge (PR #<PR_NUMBER>) |`.
- NEVER commit this update to HEAD_REF or any branch of the PR being merged -- pushing a new commit there risks resetting required status checks to pending and, depending on branch protection's 'dismiss stale approvals on push' setting, invalidating the existing APPROVED review, which would then trip this command's own merge gate (constraint: only merge when reviewDecision is APPROVED) over a problem this command itself created.
- Instead: create a new branch off the current tip of BASE_REF (name it docs/constitution-guardrails-pr-<PR_NUMBER>), commit the constitution update there alone with message `docs(constitution): capture guardrail(s) from PR #<PR_NUMBER> remediation`, push it, and open a PR targeting BASE_REF via gh pr create -- delegate this sub-step to github-specialist.
- This housekeeping PR is entirely independent: do NOT wait for its CI or review, do NOT merge it as part of this run, and do NOT let its outcome affect whether the original PR_NUMBER proceeds to Merge and Report. Record its URL for the Final Report and move on immediately.
- Any error in this phase (resolution, parse, write, branch/push, or PR-creation failure) is non-fatal: log it once, do not retry, and proceed straight to Merge and Report -- a constitution-update failure must never HALT or block the original PR's merge.

### Phase 6: Merge and Report

**1. Review Merge Gate**
   Ask the one gate that owns merge readiness for review reasons -- open findings,
the security lane, the risk tier and the human approvals bound to this exact
commit -- before any merge is attempted. CI being green says nothing about any
of that, and this command never decides it for itself.


- Re-read the head first: gh pr view <PR_NUMBER> --json headRefOid,baseRefName,author,isDraft,mergeable,mergeStateStatus,reviewDecision. HEAD_SHA is that headRefOid, read now -- never a SHA carried over from an earlier round.
- Invoke the pr-review-cycle skill (packages/development/skills/pr-review-cycle/SKILL.md) with MODE=gate, BASE_SHA/HEAD_SHA for this PR's range, PR_NUMBER, PR_ID, PR_BODY, AGENT_AUTHORED and DIRECTED_BY (the body's 'Directed by:' line when an agent wrote it). The skill runs the change classifier, the second 'needs another person' assessment and the security lane, reads approvals and reviews from gh itself, and returns the gate result. Never call pr-review-cli.js from this command.
- MODE=gate with no recorded review for this head must never be given an empty ledger: when the review-state report for HEAD_SHA is missing (or was discarded because it belongs to another head), the ledger is UNAVAILABLE, the gate answers review-data-unavailable and blocks. Do not substitute []; tell the user to run pr-review-cycle MODE=local/remote for this head first, then re-run the gate.
- Read mergeable from that result. mergeable:true is REQUIRED to proceed; it is not advisory and no other evidence substitutes for it. If mergeable:false, do not merge: report every blocker by its message and nextAction (an open Important finding is named, an open security finding is named, unsatisfied approvals state how many of how many are bound to the current commit, review-data-unavailable names exactly what could not be read), then fall back to another Verification and Round Loop pass or HALT at the round cap.
- Never accept a self-report in place of this gate: a subagent's, an author's or this session's own claim that review passed, that a finding was fixed, or that someone approved is not evidence. Only the gate's result, computed from reads taken in this run, counts.
- If the gate reports SERVER-SIDE ENFORCEMENT ABSENT for the base branch, carry that notice and its recommended branch-protection rule into the Final Report verbatim. It never blocks the merge this command performs, and it is never omitted because the merge succeeded.

**2. Merge**
   Merge only once the review merge gate returns mergeable:true, every required check is green and every review thread is resolved.

- Re-confirm immediately before merging (state can change between the gate and now): gh pr view <PR_NUMBER> --json headRefOid,mergeable,mergeStateStatus,reviewDecision -- if mergeable != MERGEABLE or reviewDecision == CHANGES_REQUESTED, abort the merge and fall back to another Verification and Round Loop pass instead of forcing it.
- If headRefOid changed since the Review Merge Gate step read it, the gate's answer belongs to a commit nobody is merging: re-run the Review Merge Gate step against the new head and require mergeable:true again before merging.
- Merge only when BOTH hold on this head: the gate returned mergeable:true, and this fresh read shows mergeable == MERGEABLE with reviewDecision != CHANGES_REQUESTED. Either one alone is not enough.
- If --dry-run was passed, stop here and report merge-readiness without merging -- including the gate's mergeable value and every blocker it named.
- Merge with gh pr merge <PR_NUMBER> using this repo's configured default merge method (check branch protection / repo settings for squash vs merge vs rebase -- do not assume); delete the source branch on merge unless it is a long-lived branch.
- Post a summary comment on the PR listing every finding that was remediated, which orchestrator owned it, and how many rounds it took.

   **Delegation:** @github-specialist
   PR is fully green, gate-approved and approved by review; merge per repo convention and clean up the branch.

**3. Final Report**
   Emit a single machine-readable summary line as the last line of output.

- Schema (one line, valid JSON): { pr_number, pr_url, rounds_executed, findings_total, findings_resolved, findings_escalated, constitution_guardrails_added (number), constitution_pr_url (string|null), merged (bool), halted_reason (string|null), gate_mergeable (bool), gate_blockers (array of blocker codes, empty when mergeable), gate_tier (string|null), branch_protection_enforced (bool|null -- null when the protection read failed, never true by assumption) }.
- Print the JSON summary as the LAST line of stdout. Do not print further prose after it.

## Expected Output

**Format:** Progress narration per round, then a single JSON summary line

**Structure:**
- **Round Narration**: Per round: Findings Manifest, routing decisions, dispatch/barrier confirmation, re-verification diff
- **Merge Gate Result**: The pr-review-cycle MODE=gate answer for the merged (or refused) head: mergeable, the risk tier, every blocker by message and next action, and -- when the base branch does not require the approvals that tier needs -- the SERVER-SIDE ENFORCEMENT ABSENT notice with the recommended branch-protection rule.
- **Constitution Update**: If the target repo has a constitution and at least one resolved finding this run was a generalizable pattern: the URL of the separate housekeeping PR opened against BASE_REF with the appended guardrail(s) and Changelog row(s). Otherwise a one-line note that nothing qualified (no constitution present, or every finding was one-off). This PR is independent of the original PR's merge and is never waited on.
- **JSON Summary**: One line of valid JSON describing the final outcome: merged, escalated findings, and round count

## Usage

```
/ensemble:pr-merge [pr-number-or-url] [--max-rounds=N] [--dry-run]
```
