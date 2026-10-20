---
name: ensemble-fix-issue
description: >-
  Orchestrate a bug fix workflow from analysis to PR, delegating to specialized
  agents. Resumable and checkpointed: a run's stage and outcome are recorded via
  issue-run-index.ts after each of the 3 named phases, so a later invocation can
  resume, report status, or abandon it instead of re-deriving progress from
  conversation history.
disable-model-invocation: true
---
<!-- Command: ensemble-fix-issue | Version: 1.4.0 -->
<!-- Description: Lightweight workflow for bug fixes and small issues -->

# ensemble-fix-issue

> **Mission:** Orchestrate a bug fix workflow from analysis to PR, delegating to specialized agents. Resumable and checkpointed: a run's stage and outcome are recorded via issue-run-index.ts after each of the 3 named phases, so a later invocation can resume, report status, or abandon it instead of re-deriving progress from conversation history.

> **Constraints:**
> - GitHub only (no GitLab/Bitbucket); GitHub CLI (gh) must be installed and authenticated
> - Tests must pass unless --skip-tests is used; at most 2 auto-fix attempts for test failures
> - Interview limited to 5 questions, one at a time, and never when --foreman is set
> - Branch naming follows the fix/ convention unless --branch is given
> - --foreman runs fully non-interactively; PR creation proceeds without pausing for confirmation (--draft-pr is independent of --foreman)

## Arguments

- **`description`** (string, optional): Issue description (free text or omit if using --issue)
- **`issue`** (number, optional): GitHub issue number (e.g., --issue 34)
- **`branch`** (string, optional): Custom branch name (default auto-generated)
- **`skip-tests`** (boolean, optional, default: `false`): Skip test validation (not recommended)
- **`draft-pr`** (boolean, optional, default: `false`): Create draft PR instead of ready-for-review
- **`interactive`** (boolean, optional, default: `false`): Enable detailed user interviews during planning
- **`foreman`** (boolean, optional, default: `false`): Foreman-native non-interactive mode -- skip the user interview and always auto-commit + create the PR without pausing for confirmation. When --foreman is present and FOREMAN_ARTIFACT_PATH is set and non-empty, write the phase report to that exact path (creating parent directories) in addition to any repo-local report. Never invent or alter the path; an unset FOREMAN_ARTIFACT_PATH is not an error.
- **`status`** (boolean, optional, default: `false`): Show the active/most-recent issue run's stage, outcome, and references without advancing it.
- **`abandon`** (boolean, optional, default: `false`): Abandon the project's active/paused issue run after explicit confirmation.

## Phase 1: Entry Point Resolution

### Step 1: Start New Run or Resume Active Run

`description` or `issue` given: call IssueRunIndexStore.createRun(projectRoot, issueDescription) (issueDescription is `description`, or the body from `gh issue view` when only `issue` is given). It enforces one active run per project: on RUN_ALREADY_ACTIVE print the existing runId, tell the user to resume with no arguments (or --status, or --abandon first), and stop. Otherwise the run starts at stage analysis_planning; proceed to Analysis & Planning.

None of description/issue/--status/--abandon given: call IssueRunIndexStore.findActive(projectRoot) and resume from the recorded checkpoint, never from conversation history. Exactly one branch applies, tested in this order:
- No active run: print "No issue run found for this project. Start one with --issue <number> or a free-text description." and stop.
- stageOutcome.kind is "failure" (paused by failure): print the parked stage and failure detail and ask "Retry <stage>? [yes/no]". Only an explicit yes re-executes that stage; no or no answer stops with stage, stageOutcome and revision unchanged. Never retry automatically.
- stage is "validation_delivery", stageOutcome.kind is "approval_wait" and its detail starts with "REVIEW_": a pending or blocked remote review. Call IssueRunIndexStore.loadRun(projectRoot, runId) and jump straight to Remote Review Disposition; never re-run Test Validation, Local Review and Batch Fix, or PR Creation (a second PR must never open for the same branch). That step reads the PR URL from the run's recorded `pr:` beadRef; with none recorded it halts and tells the user to find or supply the PR URL instead of restarting.
- anything else (success, pending, or a never-run fresh run): no gate; loadRun and resume at the recorded `stage`, from that stage's first step.

### Step 2: --status -- Read-Only Run Report

Only when --status is set. Call IssueRunIndexStore.findActive(projectRoot); with no run print "No issue runs found for this project." and stop. Otherwise print the run identifier, stage, stageOutcome.kind (with detail when pending or failure), every artifacts[] and beadRefs[] entry, and state "completed" or "abandoned" explicitly. No stage executes and no mutate() call is made.

### Step 3: --abandon -- Explicit Confirmation Required

Only when --abandon is set. Call IssueRunIndexStore.findActive(projectRoot); with no active run print "No active issue run exists to abandon." and stop. Otherwise ask via ask "Abandon issue run <runId> at stage <stage>? [yes/no]"; no or no answer leaves the run unchanged with no mutate() call. On an explicit yes call IssueRunIndexStore.abandon(projectRoot, runId, reason) (reason defaults to "User abandoned run"); it sets status "abandoned" and releases active.lock. History is never deleted; a later --status still shows it.

## Phase 2: Analysis & Planning

### Step 1: Codebase Analysis

Identify affected files, related tests, framework, and scope (Grep, Glob, Read), optionally via tech-lead-orchestrator. Return a structured analysis with a scope estimate.

### Step 2: Collaborative Planning

Produce the fix plan (approach, files to modify, test strategy, edge cases), consulting only the specialists the issue warrants -- product-management-orchestrator for unclear acceptance criteria, tech-lead-orchestrator or infrastructure-orchestrator for architecture or integration impact, test-runner for test strategy.

### Step 3: User Interview (Conditional)

Only when the description is ambiguous (under 20 words, vague terms such as "doesn't work", or several interpretations) or --interactive is set. Ask clarifying questions ONE AT A TIME (max 5) with ask, waiting for each answer, and fold the answers into the approach and acceptance criteria. Never when --foreman is set: skip and proceed on best-effort assumptions.

### Step 4: Record Stage Checkpoint

Persist this phase's outcome and advance the run via issue-run-index.ts: ONE call IssueRunIndexStore.mutate(projectRoot, runId, revision, (record) => { record.artifacts.push({ type: "fix-plan", path: <fix plan output path>, recordedAt: now() }); record.stage = "execution"; record.stageOutcome = { kind: "success", recordedAt: now() }; }). A second mutate() with the same `revision` throws REVISION_CONFLICT, so batch the changes. On a thrown error halt and report it; never proceed with an unrecorded checkpoint.

## Phase 3: Execution

### Step 1: Branch Creation

Branch name is --branch if given, else fix/issue-{number}-{slugified-description} for --issue, else fix/{slugified-description}. If the branch already exists (git branch --list), ask the user to switch or pick another name; otherwise git checkout -b it.

### Step 2: Task List Generation

Break the plan into 3-10 specific, testable tasks (implementation, test updates, validation), each tied to a file or component, tracked with TodoWrite (content, activeForm, status).

### Step 3: Task Execution

For each task set TodoWrite status "in_progress", delegate via Task (backend code to backend-developer, frontend to frontend-developer, infrastructure to infrastructure-developer, anything else to tech-lead-orchestrator), then set "completed". On failure leave it "in_progress", log the error, continue, and report failures at the end.

### Step 4: Record Stage Checkpoint

Persist this phase's outcome and advance the run via issue-run-index.ts: IssueRunIndexStore.mutate(projectRoot, runId, revision, (record) => { record.stage = "validation_delivery"; record.stageOutcome = { kind: "success", recordedAt: now() }; }). On a thrown error halt and report it; never proceed with an unrecorded checkpoint.

## Phase 4: Validation & Delivery

### Step 1: Test Validation

Run the test suite with auto-fix retry; all tests must pass before the PR. Detect the framework and test command (package.json, pytest, rspec, ...), run, and parse pass/fail. On failure analyze, fix, and run once more (at most 2 attempts). If still failing: report the failures, call IssueRunIndexStore.mutate(projectRoot, runId, revision, (record) => { record.stageOutcome = { kind: "failure", detail: <failure summary>, recordedAt: now() }; }) to park the run at the CURRENT stage (validation_delivery; do not advance `stage`, so a later bare invocation asks "Retry <stage>?"), HALT without creating a PR, and give recovery instructions. With --skip-tests warn and skip execution. When tests pass (or --skip-tests) proceed to Local Review and Batch Fix; only that step sets prApprovedAt.

### Step 2: Local Review and Batch Fix

Independent local review of the complete diff, triage, and one batched fix pass -- before any commit, push, or PR creation. Invoke the shared pr-review-cycle skill, located at
"$(git rev-parse --show-toplevel 2>/dev/null)/packages/development/skills/pr-review-cycle/SKILL.md",
in pre-publication (local) mode; it composes pr-review-remediation for the fixes, so do not restate its triage/test/minimal-fix rules here.

Scope: DEFAULT_BRANCH is `git symbolic-ref --short refs/remotes/origin/HEAD` minus "origin/", else "main"; BASE_SHA is `git merge-base HEAD <DEFAULT_BRANCH>`. The reviewed head, SNAPSHOT_HEAD, is a snapshot commit of the working tree including untracked files, never `git stash create`: use a TEMPORARY index (GIT_INDEX_FILE at a not-yet-existing path: read-tree HEAD, add -A, write-tree; the real index, working tree and branches are untouched). If that tree equals HEAD's tree SNAPSHOT_HEAD is HEAD; otherwise it is `git commit-tree <tree> -p HEAD` with fixed author/committer ensemble <ensemble@localhost> and dates 2000-01-01T00:00:00Z, so the SHA is a pure function of HEAD and tree. The synthetic commit is never pushed.

Invoke the skill with MODE='local', BASE_SHA, HEAD_SHA=<SNAPSHOT_HEAD>, REVIEWED_TREE_SHA=<git rev-parse '<SNAPSHOT_HEAD>^{tree}'>, PR_ID=<repo-slug>-<branch-name> (no PR number exists yet), TEST_COMMAND=<command Test Validation detected>, SKIP_TESTS=<true under --skip-tests>, FOREMAN=<--foreman flag>. The batch fix changes the working tree, so re-resolve SNAPSHOT_HEAD after it and BEFORE the re-review (never `git rev-parse HEAD`, which cannot see uncommitted work). Tell the skill the post-fix SNAPSHOT_HEAD ends the re-review range and is headSha and reviewedHeadSha, its tree is REVIEWED_TREE_SHA (recorded as reviewedTreeSha so Remote Review Disposition can recognise PR Creation's real commit -- different SHA, same content -- by tree), and a review bound to the pre-fix snapshot or tree is stale and cannot complete. --skip-tests never skips this step: the skill records tests.skipped=true and never reports REVIEW_COMPLETE (REVIEW_PENDING, "tests skipped"), yet LOCAL_REVIEW_COMPLETE can still be reached.

Fail-closed gate on the skill's {status, localPhase, reasons, ledger, reportPath, headSha}; LOCAL_PHASE is null when nothing, an unparseable value, or no localPhase came back (for example pr-review-remediation not installed). Only LOCAL_PHASE == 'LOCAL_REVIEW_COMPLETE' (exact match) proceeds: call IssueRunIndexStore.mutate(projectRoot, runId, revision, (record) => { record.prApprovedAt = now(); }) -- the only place prApprovedAt is set -- then go to PR Creation. EVERY other outcome (LOCAL_REVIEW_PENDING, LOCAL_REVIEW_BLOCKED, null, unrecognised) leaves prApprovedAt null and calls mutate to set record.stageOutcome = { kind: "failure", detail: `local review not complete (${LOCAL_PHASE ?? 'no localPhase returned'}): ${(reasons ?? []).join('; ')}`, recordedAt: now() } (stage stays validation_delivery). Then, under --foreman with FOREMAN_ARTIFACT_PATH set and non-empty, write { status, headSha, ledger } to that exact path (create parent directories; no prompt or wait; unset path is a no-op, not an error) BEFORE halting: status is the skill's status when REVIEW_PENDING or REVIEW_BLOCKED, else REVIEW_BLOCKED; headSha is the returned one or the last SNAPSHOT_HEAD; ledger is the returned one or null. Finally HALT with nothing committed, pushed, or published, reporting the ledger, reportPath and next action.

### Step 3: PR Creation

Commit, push, and open the pull request with GitHub CLI (always `gh`; ENSEMBLE_PR_BACKEND is not consulted here). Precondition: read prApprovedAt from IssueRunIndexStore.loadRun(projectRoot, runId) directly; null denies the call outright whatever the conversation claims, and only the Local Review and Batch Fix step sets it. Commit, push and PR creation proceed by default, without pauses under --foreman; --draft-pr and --foreman are independent.
Commit message is conventional ("fix: {brief description}" or "fix(scope): ..."), referencing the issue in the body, not the title. `git add` only the files this workflow modified (never `git add .` or `-A`), commit, then `git push -u origin {branch-name}`. PR body: Problem, Solution, Changes, Test Plan, Checklist, and "Fixes #{issue-number}". PR title "Fix #{number}: {description}" with an issue number, else "Fix: {description}". Run `gh pr create [--draft when --draft-pr] --title ... --body ...` and extract the PR URL from its output. Without one (for example `gh pr create` failed) say so; Remote Review Disposition owns the no-PR-URL block.

### Step 4: Remote Review Disposition

After the PR exists, evaluate the head-bound CodeRabbit review and decide whether the run may report success.

PR_URL is the URL PR Creation extracted, or on resume the last `pr:` beadRefs[] entry with the prefix stripped; only a value matching ^https?://\S+/pull/[0-9]+$ counts, anything else (empty, undefined, no entry) is "no PR URL". Never proceed with an undefined URL, write `pr:undefined`, or re-run PR Creation.

No PR URL: skip the skill; REVIEW_STATUS is REVIEW_BLOCKED with next action "no PR URL recorded -- find the PR for this branch (gh pr view --json url -q .url, or gh pr list --head <branch> --state all --json url), or create it with gh pr create, record its URL as a pr:<url> beadRef, then re-invoke with no arguments (or --abandon)"; take the non-complete path below (detail "REVIEW_BLOCKED: no PR URL recorded"). Never restart at Test Validation.

With a PR URL: first record it once, whatever the outcome, so a later resume finds the PR: IssueRunIndexStore.mutate(projectRoot, runId, revision, (record) => { if (!record.beadRefs.includes(`pr:${prUrl}`)) record.beadRefs.push(`pr:${prUrl}`); }). Then invoke the shared pr-review-cycle skill, located at
"$(git rev-parse --show-toplevel 2>/dev/null)/packages/development/skills/pr-review-cycle/SKILL.md",
with MODE='remote', PR_ID=<the SAME repo-slug>-<branch-name> key Local Review used (never a PR-number form, so recorded local-phase facts carry forward), PR_URL, HEAD_SHA=<git rev-parse HEAD>, HEAD_TREE_SHA=<git rev-parse 'HEAD^{tree}'>, BOT_LOGINS=<configured review-bot usernames>, FOREMAN=<--foreman flag>. Pass no reviewed head or tree; the skill recovers them from the local report. PR Creation's real commit is not the snapshot Local Review bound to, so the review is fresh only when HEAD_SHA equals the recorded reviewedHeadSha or HEAD_TREE_SHA equals the recorded reviewedTreeSha; a different tree is stale (REVIEW_PENDING), never complete. Parse {status, localPhase, remotePhase, reasons, ledger, nextAction, reportPath, headSha} into REVIEW_STATUS, REVIEW_NEXT_ACTION, REVIEW_REPORT_PATH.

Foreman artifact, for EVERY status and BEFORE any halt: under --foreman with FOREMAN_ARTIFACT_PATH set and non-empty, write { status: REVIEW_STATUS, headSha, ledger } to that exact path (create parent directories; no prompt or indefinite wait) in addition to the report pr-review-cycle wrote; headSha is the returned one or else `git rev-parse HEAD`, ledger the returned one or null, and a missing, null or unrecognised status is written as REVIEW_BLOCKED. Unset path: no change, no error.

Only exactly REVIEW_COMPLETE proceeds to Record Stage Checkpoint (which alone marks the run done; do not touch stageOutcome here). EVERY other outcome (REVIEW_PENDING, REVIEW_BLOCKED, null, empty, lowercase, unrecognised, unparseable) is a block, never a pass: never call IssueRunIndexStore.complete() or call the PR merged or landed. HALT_STATUS is REVIEW_STATUS when exactly REVIEW_PENDING or REVIEW_BLOCKED, else REVIEW_BLOCKED. Call IssueRunIndexStore.mutate(projectRoot, runId, revision, (record) => { record.stageOutcome = { kind: "approval_wait", detail: `${HALT_STATUS}: ${REVIEW_NEXT_ACTION ?? 'review returned no recognised status'}`, recordedAt: now() }; }) -- `stage` stays "validation_delivery" and the detail starts with "REVIEW_" so a later bare invocation resumes here, not at "done" -- print the resumable report (status, next action, REVIEW_REPORT_PATH) and HALT.

### Step 5: Record Stage Checkpoint

Persist this phase's outcome and mark the run complete via issue-run-index.ts. Only reached when Remote Review Disposition's status is REVIEW_COMPLETE -- a pending or blocked outcome halts there instead. Call IssueRunIndexStore.complete(projectRoot, runId) to mark the run completed ("done") and release active.lock; history is never deleted and the PR reference was already recorded. On a thrown error halt and report it.
