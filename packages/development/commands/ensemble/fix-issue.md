---
name: "ensemble:fix-issue"
description: "Lightweight workflow for bug fixes and small issues"
version: "1.4.0"
category: "implementation"
last-updated: "2026-10-14"
model: "sonnet"
---
<!-- DO NOT EDIT - Generated from fix-issue.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Orchestrate a bug fix workflow from analysis to PR, delegating to specialized agents.
Resumable and checkpointed: a run's stage and outcome are recorded via issue-run-index.ts after each of the 3 named phases, so a later invocation can resume, report status, or abandon it instead of re-deriving progress from conversation history.

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

## Workflow

### Phase 1: Entry Point Resolution

**1. Start New Run or Resume Active Run**
   A `description` or `issue` argument with no active run for
the project starts a fresh run at stage analysis_planning.
With neither argument (and no --status/--abandon), resume
the project's active/paused run from its last recorded
checkpoint, after two gates. A run parked by failure asks
"Retry <stage>?" and only an explicit yes re-executes it. A
run at stage validation_delivery whose stageOutcome is
approval_wait with a REVIEW_ detail is a pending or blocked
remote review: it resumes at Remote Review Disposition,
never at Test Validation, and never re-runs Local Review
and Batch Fix or PR Creation. That step reads the PR URL
from the run's recorded `pr:` beadRef; with none recorded
it halts and tells the user to find or supply the PR URL
instead of restarting.


**2. --status -- Read-Only Run Report**
   Report the active/most-recent run's stage, outcome, and references without advancing it. No stage executes and no mutate() call is made.


**3. --abandon -- Explicit Confirmation Required**
   Terminate the project's active/paused run after explicit confirmation; history is retained.


### Phase 2: Analysis & Planning

**1. Codebase Analysis**
   Identify affected files, related tests, framework, and scope (Grep, Glob, Read).

**2. Collaborative Planning**
   Produce the fix plan, consulting the specialist agents the issue actually warrants.

**3. User Interview (Conditional)**
   If the description is ambiguous or --interactive is set, ask clarifying questions ONE AT A TIME (max 5) with AskUserQuestion. Never when --foreman is set.


**4. Record Stage Checkpoint**
   Persist this phase's outcome and advance the run via issue-run-index.ts.


### Phase 3: Execution

**1. Branch Creation**
   Create the fix branch.

**2. Task List Generation**
   Break the plan into 3-10 specific, testable tasks.

**3. Task Execution**
   Execute the tasks with agent delegation and progress tracking.

**4. Record Stage Checkpoint**
   Persist this phase's outcome and advance the run via issue-run-index.ts.


### Phase 4: Validation & Delivery

**1. Test Validation**
   Run the test suite with auto-fix retry; all tests must pass before the PR.


**2. Local Review and Batch Fix**
   Independent local review of the complete diff, triage, and one
batched fix pass -- before any commit, push, or PR creation. Invokes the shared pr-review-cycle skill,
located at
"$(git rev-parse --show-toplevel 2>/dev/null)/packages/development/skills/pr-review-cycle/SKILL.md",
in pre-publication (local) mode; that skill composes
pr-review-remediation for the actual fixes and does not
restate its triage/test/minimal-fix rules here.
Fail-closed gate: only a returned localPhase of exactly
LOCAL_REVIEW_COMPLETE proceeds to PR Creation, and only that
outcome sets prApprovedAt (COMPLETE already accounts for the
test results, so this step grades nothing itself). EVERY other
outcome -- LOCAL_REVIEW_PENDING, LOCAL_REVIEW_BLOCKED, a
missing or unparseable result, or the skill returning nothing
(for example pr-review-remediation not installed) -- leaves
prApprovedAt null, records a failure stageOutcome at the
current stage, writes the { status, headSha, ledger } report to
the exact FOREMAN_ARTIFACT_PATH first when --foreman is set and
that variable is non-empty, and only then HALTs with nothing
committed, pushed, or published. The reviewed head is a
snapshot commit of the working tree that includes untracked
files, built from a temporary index (never git stash create),
and it is re-resolved after the batch fix, before the
re-review. The tree of that post-fix snapshot (git rev-parse
'<SNAPSHOT_HEAD>^{tree}') is recorded as reviewedTreeSha, so
Remote Review Disposition can recognise the real commit PR
Creation makes -- a different SHA, the same content -- by its
tree.

**3. PR Creation**
   Commit, push, and open the pull request with GitHub CLI

**4. Remote Review Disposition**
   After the PR exists: first record its URL once as a
`pr:<url>` beadRef on the run (only when that exact entry is
not already present, and never `pr:undefined`) so a later
resume can find the PR; then invoke the shared pr-review-cycle
skill, located at
"$(git rev-parse --show-toplevel 2>/dev/null)/packages/development/skills/pr-review-cycle/SKILL.md",
in remote mode to evaluate the head-bound CodeRabbit review and
decide whether this run may report success. Pass it HEAD_SHA (git rev-parse HEAD) and
HEAD_TREE_SHA (git rev-parse 'HEAD^{tree}'): PR Creation's real
commit is not the snapshot Local Review bound its review to, so
the review is fresh only when HEAD_SHA equals the reviewed head
or HEAD_TREE_SHA equals the reviewedTreeSha Local Review
recorded -- a different tree is stale, never complete. A
pending or blocked review never completes the run
-- it returns a resumable report instead (a later bare
invocation resumes at this step, not at "done"). Only exactly
REVIEW_COMPLETE proceeds to Record Stage Checkpoint; EVERY
other outcome (REVIEW_PENDING, REVIEW_BLOCKED, null,
unrecognised, missing or unparseable) records approval_wait and
HALTs without calling complete(). On resume PR_URL is read from
the record's `pr:` beadRef. With no PR URL (PR Creation
extracted none, or the resumed record has no `pr:` beadRef) the
skill is not invoked: the step takes that same blocked path --
REVIEW_BLOCKED, approval_wait with the detail "REVIEW_BLOCKED: no PR URL recorded",
the Foreman artifact first, then HALT -- and never restarts at
Test Validation or re-runs PR Creation. Under --foreman
with FOREMAN_ARTIFACT_PATH set and non-empty, the report
{ status, headSha, ledger } is written to that exact path for
EVERY status, before any halt; with the variable unset, behavior
is unchanged. Foreman mode never prompts and never waits
indefinitely.

**5. Record Stage Checkpoint**
   Persist this phase's outcome and mark the run complete via issue-run-index.ts.
Only reached when Remote Review Disposition's status is REVIEW_COMPLETE -- a pending or blocked outcome halts there instead.


## Expected Output

**Format:** Pull Request

**Structure:**
- **Git Branch**: fix/issue-{num}-{slug} branch
- **Code Changes**: Fix with test coverage
- **Pull Request**: PR with problem, solution, changes, and test plan

## Usage

```
/ensemble:fix-issue
```
