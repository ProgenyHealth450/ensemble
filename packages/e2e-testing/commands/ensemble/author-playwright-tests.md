---
name: ensemble:author-playwright-tests
description: Interactive, post-implementation Playwright test-authoring session grounded in shipped code and PRD acceptance criteria
version: 2.1.0
category: testing
last-updated: 2026-07-27
argument-hint: [story-or-pr-reference]
---
<!-- DO NOT EDIT - Generated from author-playwright-tests.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Walk a story's PRD acceptance criteria one at a time with a QA engineer after
implement-trd-beads has shipped a PR boundary, grounding each proposed Playwright
test in the real implementing code rather than PRD prose alone, running it against
the target application's QA environment, and syncing confirmed tests to an Azure
DevOps Test Case/Suite as plain-English steps.

## Workflow

### Phase 1: Scaffold

**1. Trigger Check — Open PR Required**
   REQ-001: this session may only start once implement-trd-beads has
shipped a PR boundary for the target branch. TRD-031: the target
repo may be hosted on GitHub or Azure DevOps Repos (e.g. CRIBs) —
detect which before checking, never assume gh/GitHub.


   - Resolve the target branch: current git branch, or the branch backing the story/PR reference argument
   - Call detectRepoHost() from packages/e2e-testing/lib/pr-state.js
   - If host is "github" or "unknown": call checkPrState(branch) from the same module (unchanged gh-based behavior)
   - If host is "azure-devops": call the Azure DevOps MCP server's PR-list tool (e.g. repo_list_pull_requests_by_repo_or_project) with detectRepoHost()'s resolved organization/project/repository, then call checkPrStateAdo(branch, prs) from the same module to get the normalized result
   - If hasOpenPr is false: halt the session and print pr-state.js's NO_OPEN_PR_MESSAGE (run /ensemble:implement-trd-beads first) — do not proceed to grounding, execution, or sync
   - If hasOpenPr is true: proceed with the session on that same branch/PR — all authored test commits land there

**2. Parse PRD, Ground Every REQ, Flag Gaps, and Resume-Scan**
   TRD-025 (satisfies REQ-002, REQ-009, REQ-011): build the story's
full coverage picture before asking anything else. This is what
makes PR 1's promise real — "lists every AC for that story,
whether it already has a confirmed test, and which REQ's
implementation code was found."


   - Call parsePrdAcs(prdText) from packages/e2e-testing/lib/prd-ac-parser.js to get {documentId, label, reqs: [{id, acs: [{id, text}]}]}
   - For each REQ, call groundImplementation(reqId, trdPath) from packages/e2e-testing/lib/implementation-grounding.js. A {grounded: false, gap: true, reason} result is a structural grounding gap — report it plainly, do not treat it as an AC-gap (that is a distinct concept, see next action)
   - For each AC under a grounded REQ, judge (agent reasoning, not a function call) whether the grounded diff actually produces that AC's stated Given/When/Then outcome. If it does not, call flagAcGap(acId, {reqId, groundingResult, reason}) from packages/e2e-testing/lib/ac-gap-detector.js, present the flagged gap to Sonia, and record her call via resolveGapReview(acId, decision, details) — decision "confirmed" routes to Phase 6 (AC-Gap Task Filing) immediately, not deferred to session end; decision "override" re-runs groundImplementation with details.correctedTargetFiles and re-judges before moving on
   - Scan cribs.e2e.tests' existing *.spec.ts/*.cs files on disk and call scanAcCoverage(specTexts, expectedAcIds) from packages/e2e-testing/lib/resume-scan.js to split every expected AC into confirmed/manual/gap/pending
   - Print the combined coverage report: every AC's status (confirmed / manual / gap / pending) alongside its REQ's grounding result — this is PR 1's own Shippable State and must be shown even if the session goes on to do nothing else

**3. Full-Session Idempotence Short-Circuit**
   TRD-030/TRD-023 (satisfies REQ-011, AC-011-2): a fully-covered
story makes no changes and ends here — never reaches the
headed/headless prompt or the REQ loop below.


   - Call isStoryFullyCovered(expectedAcIds, specTexts) from packages/e2e-testing/lib/resume-scan.js (same inputs as the coverage scan above)
   - If true: print buildSessionSummary({alreadyComplete: true}) from packages/e2e-testing/lib/session-summary.js and end the session now — make no file writes, no delegation calls, and no Azure DevOps calls of any kind
   - If false: continue to the Execution Setup phase below with only the pending ACs from the coverage scan

### Phase 2: Execution Setup

**1. Ask Headed or Headless — Once Per Session**
   REQ-013: before running the first test in the session, ask Sonia
(in conversation — this session is interactive via Claude Code, so
"asking" means posing the question directly, not a GUI dialog)
whether she wants to watch the browser run (headed) or let it run
independently and report status back (headless). This is a single,
one-time choice for the whole session, made once here before the
first test run — do not re-ask per AC.


   - Before running the first test this session, ask Sonia: "Would you like to watch these tests run (headed), or should I run them independently and report status back (headless)?"
   - If she does not specify a preference, default to headed — this session is interactive by default
   - Record the chosen mode for the remainder of the session; do not ask again for subsequent ACs/tests

**2. Resolve and Verify the QA Environment**
   TRD-013/TRD-026 (satisfies REQ-013): safety-critical — never let a
test run against anything but the designated QA environment.


   - Call resolveQaEnvUrl(opts) from packages/e2e-testing/lib/qa-env-guard.js with an explicit opts.url or opts.envVar naming where the target app's QA URL is configured — never hardcode or guess one
   - Call checkQaEnvReachable(url) from the same module. If reachable is false, halt the session here: report the unreachable environment to Sonia and do not run, propose, or land any test this session — never fall back to another URL
   - If reachable is true, carry this resolved URL forward as targetEnv for every delegation request in the REQ loop below

### Phase 3: REQ Batching and Delegation

**1. Batch by REQ, Skip Already-Complete REQs**
   TRD-026 (satisfies REQ-004, REQ-013): REQ-004's checkpointing
starts here — a REQ that is already fully confirmed is never
re-processed, even mid-session on a resumed run.


   - Call batchByReq(parsedAcs, confirmedAcIds) from packages/e2e-testing/lib/req-batcher.js, using Phase 1's parsed ACs and its resume-scan confirmed set, to get one {reqId, acs, allDone, checkpointSummary} entry per REQ, in order
   - For each REQ where allDone is true: print its checkpointSummary and move to the next REQ without delegating anything
   - For each REQ where allDone is false: proceed to the next step for each of its still-pending ACs (excluding any already marked manual or ac-gap by Phase 1's resume-scan)

**2. Delegate Each Pending AC to @playwright-tester**
   TRD-026 (satisfies REQ-005, REQ-013): the per-AC delegation this
TRD's whole architecture is built around (TRD-008's contract).


   - Build a request {acText, groundingDiff, targetEnv, mode} and validate it with validateDelegationRequest(req) from packages/e2e-testing/lib/delegation-contract.js — acText is this AC's own text (not the whole REQ), groundingDiff is Phase 1's groundImplementation() result for its REQ, targetEnv is Phase 2's resolved QA URL, mode is Phase 2's chosen headed/headless
   - Delegate the validated request to @playwright-tester (packages/e2e-testing/agents/playwright-tester.md), which grounds the AC, authors a test, and runs it per its own TRD-011 mode-aware logic (test-runner-mode.js's resolveRunConfig)
   - Validate the response with validateDelegationResponse(res) from delegation-contract.js — it always carries either a pass/fail runResult or an explicit authoringFailure, never neither
   - Log the outcome via logAction({type: "run-result", acId, mode, runResult}) from packages/e2e-testing/lib/session-logger.js

   **Delegation:** @playwright-tester
   Ground one AC in code, propose a Playwright test, and run it headed or headless against the resolved QA environment, per packages/e2e-testing/lib/delegation-contract.js.

### Phase 4: Decision and Local Landing

**1. Present the Proposed Test and Record Sonia's Decision**
   TRD-027 (satisfies REQ-003, REQ-017): the accept/request-changes/
reject decision point, per proposed test.


   - Present the proposed test (and its run result) to Sonia; call recordDecision(decision, {acId, proposedTest, changeDescription, iterationCount}) from packages/e2e-testing/lib/ac-decision-loop.js with exactly one of "accept" | "request-changes" | "reject"
   - outcome "revise": re-delegate to @playwright-tester with changeDescription folded into a fresh request for the same AC (loop back to the REQ Batching and Delegation phase, step 2, incrementing iterationCount)
   - outcome "manual-escape-hatch" (an outright reject), or an accepted delegation whose runResult was an authoringFailure with no viable alternative: call markManual(acId, reason) from packages/e2e-testing/lib/manual-ac-tracker.js, log via logAction({type: "manual-ac-marked", acId, reason}), and move to the next AC — never silently drop it
   - outcome "accepted" with a passed runResult: continue to the next step to land the test

**2. Land the Confirmed Test**
   TRD-027 (satisfies REQ-006, REQ-014): write/append the test file
and apply its traceability tag — AC-006-2's existing-file append
must be checked before scaffolding a redundant new one.


   - Determine whether an existing cribs.e2e.tests file already covers this AC's REQ (e.g. from Phase 1's resume-scan); call writeOrAppendSpecFile(filePath, specDetails) from packages/e2e-testing/lib/spec-writer.js — it scaffolds a new file when none exists, or appends a [Test] method to the existing one, never both
   - Call tagTestMethod(fileContent, {acId, acText, reqId, documentId}) from packages/e2e-testing/lib/traceability-tagger.js to turn spec-writer.js's plain anchor comment into the full `@hash:`/doc-id/`@REQ` traceability tag
   - Log via logAction({type: "test-written", acId, testName, filePath, mode: "created"|"appended"}) from packages/e2e-testing/lib/session-logger.js

### Phase 5: Azure DevOps Test Plan Sync

**1. Resolve or Create the Story's Test Suite**
   TRD-028 (satisfies REQ-007): once per story, not once per AC.


   - Fetch the story's existing Test Suites (e.g. via the Azure DevOps MCP server's testplan_list_test_suites-equivalent tool) and call resolveOrCreateTestSuite({workItemId, storyTitle, existingSuites}) from packages/e2e-testing/lib/ado-test-suite.js
   - If action is "create": call the MCP test-suite-creation tool with the decision's suiteName linked to workItemId, then call recordCreatedSuite(decision, mcpResponse) to get the tracked {suiteId, suiteName, workItemId}; if action is "resolve", the suiteId is already known — no MCP call needed

**2. Sync Each Landed Test's Steps as a Test Case**
   TRD-028 (satisfies REQ-007, REQ-008): AC-007-2's update-in-place
behavior on re-sync, and REQ-008's retry/flag-without-rollback
resilience, both apply here.


   - For each just-landed, tagged test: extract its ordered plain-text step descriptions (from its narration/comments) and check findAdoTestCaseTag(fileContent, acId) from packages/e2e-testing/lib/traceability-tagger.js for an already-synced id
   - Call planTestCaseSync({acId, acText, steps, suiteId, existingAdoTestCaseId}) from packages/e2e-testing/lib/ado-test-case-sync.js, then call the MCP Test-Case create/update tool (testplan_create_test_case / add-to-suite equivalent) accordingly
   - On success: call recordSyncedTestCase(decision, mcpResponse), then addAdoTestCaseTag(fileContent, acId, testCaseId) from traceability-tagger.js to persist the id for future re-syncs; log via logAction({type: "sync-result", acId, ...syncedRecord})
   - On failure: call recordSyncAttempt(state, {success: false, error}) from packages/e2e-testing/lib/ado-sync-resilience.js. Decision "retry": troubleshoot per its note and retry this step for the same AC. Decision "flag-unsynced": call flagUnsynced(acId, state), log it, and move on — the local test file landed in the previous phase is NEVER rolled back regardless of sync outcome

### Phase 6: AC-Gap Task Filing

**1. File One ADO Task Per Confirmed Gap**
   TRD-029 (satisfies REQ-010): fires as soon as Phase 1's gap review
resolves "confirmed" for an AC — do not batch every gap to the
end of the session; AC-010-2 requires one Task per gap, never
bundled, and this module's own shape enforces that (no batching
parameter exists).


   - For each AC whose Phase 1 resolveGapReview() call resolved to "gap-confirmed": call resolveImplementingAuthor(groundingResult.files) from packages/e2e-testing/lib/ac-gap-task-filer.js (never throws — an unresolved author still proceeds, unassigned)
   - Resolve that git identity to an Azure DevOps identity via the MCP server's core_get_identity_ids-equivalent tool, then call planGapTaskFiling({acId, reqId, gapReason, storyWorkItemId, author}) to shape the Task request
   - Call the MCP work-item-creation tool (wit_create_work_item + wit_add_child_work_items equivalent) linking the new Task under the PRD-referenced Story, then call recordFiledGapTask(decision, mcpResponse)
   - Log via logAction({type: "gap-task-filed", ...gapRecord}) from packages/e2e-testing/lib/session-logger.js

### Phase 7: Checkpoints and Session Summary

**1. Per-REQ Checkpoint**
   TRD-030 (satisfies REQ-004, REQ-012): printed once every AC in the
current REQ has been decided (confirmed, manual, or gap) —
Sonia may stop here and resume later via Phase 1's resume-scan.


   - Once a REQ's ACs are all decided, call buildSessionSummary({scope: "checkpoint", reqId, testsWritten, testsConfirmed, manualAcs, adoTestCasesSynced, gapTasksFiled}) from packages/e2e-testing/lib/session-summary.js, using this REQ's own accumulated items, and print it
   - Ask Sonia whether to continue to the next REQ or stop the session here — either is a clean, resumable stopping point

**2. Final Session Summary**
   TRD-030 (satisfies REQ-012, REQ-016): printed once every REQ has
been processed (or the session is stopped early).


   - Call buildSessionSummary({scope: "session", testsWritten, testsConfirmed, manualAcs, adoTestCasesSynced, gapTasksFiled}) from packages/e2e-testing/lib/session-summary.js, using the whole session's accumulated items across every REQ, and print it as the session's closing message
   - Every action taken anywhere in this workflow (test-written, run-result, sync-result, gap-task-filed, manual-ac-marked) must already have been logged via logAction as it happened (packages/e2e-testing/lib/session-logger.js) — this final summary is a rollup, not the only record of what occurred

## Expected Output

**Format:** Confirmed Playwright tests synced to Azure DevOps

**Structure:**
- **Test Files**: Playwright test specs landed for confirmed acceptance criteria
- **Azure DevOps Test Cases**: Plain-English steps synced to the target ADO Test Case/Suite
- **AC-Gap Tasks**: One ADO Task per confirmed implementation gap, filed on the referenced Story
- **Session/Checkpoint Summaries**: Human-readable counts of tests written/confirmed/manual/synced/gap-filed, printed after each REQ and at session end

## Usage

```
/ensemble:author-playwright-tests [story-or-pr-reference]
```
