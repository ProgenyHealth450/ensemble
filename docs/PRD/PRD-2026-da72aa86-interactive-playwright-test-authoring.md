---
document_id: PRD-2026-da72aa86
label: prd-playwright-test-authoring
version: 1.0.2
status: Draft
date: 2026-07-24
scale_depth: STANDARD
total_requirements: 17
readiness_score: 4.65
---

# PRD-2026-da72aa86: Interactive Post-Implementation Playwright Test Authoring

## PRD Health Summary

| Metric | Value |
|--------|-------|
| Must requirements | 14 |
| Should requirements | 3 |
| Could requirements | 0 |
| Won't requirements | 0 |
| AC coverage | 17/17 (100%) |
| Risk flags | 6 |
| Cross-requirement dependencies | 18 |
| [NEEDS CLARIFICATION] markers | 0 (all 3 resolved in v1.0.1 refine-prd pass) |

## Product Summary

**Problem:** Playwright tests for CRIBs stories are hand-written after a story merges, by memory of the PRD's acceptance criteria rather than by walking them one at a time. Coverage drifts from the ACs, is inconsistent across stories, and gives non-code reviewers no way to see what a test actually checks. Sonia Pareek (QA) and CRIBs developers both feel this gap today.

**Solution:** An interactive, `create-trd`-style test-authoring session that runs *after* `implement-trd-beads` has produced real implementation code for a story. An agent proposes a real (non-stub) Playwright test per acceptance criterion, grounded in both the PRD's AC text and the actual implementing code, running headed against the QA environment under Sonia's own Entra login so she can watch and confirm each test passes. Confirmed tests are placed in `cribs.e2e.tests` per existing conventions, and their step-level narration is synced to an Azure DevOps Test Case/Suite as plain-English steps. When the agent finds an AC the implementation doesn't actually satisfy, it stops short of writing a test for behavior that doesn't exist and instead files a gap task.

**Value proposition:** Every Must/Should AC gets a real, human-confirmed test the same day the code is grounded, traceable to both the PRD and an ADO Test Suite a non-coder can read — instead of a best-effort pass that drifts further from the PRD the longer it's deferred.

**Target users:** QA engineer (Sonia) and the implementing developer, as the two sides of the interactive session.

**Non-goals (v1):**
- No test *refinement* UI (adding/removing/tweaking steps before merge) — that is a separate, not-yet-built future tool. This PRD's session only authors and confirms tests; it does not edit them after the fact.
- Never executes against production — QA environment only.
- Does not attempt drift detection between an already-tested AC and a PRD requirement that changed later (that is `check-playwright-drift`'s job, not this session's).

**Accepted v1 risk:** REQ-008 and the manual/gap-flagging paths (REQ-009, REQ-017) assume a future "refine tests" tool will eventually give Sonia a place to resolve unsynced or flagged items. That tool does not exist yet. If it is never built, those items have no resolution path beyond what's noted in this PRD. This is accepted as a known v1 gap, not something this effort solves.

## User Analysis

- **QA engineer (Sonia)**: drives the interactive session, reviews/accepts/revises/rejects each proposed test, confirms pass/fail, decides when an AC is manual-only, confirms real AC gaps.
- **Implementing developer**: the commit author on the branch `implement-trd-beads` produced; grounds the agent's proposals and is the assignee if an AC-gap task is filed.

## Goals and Non-Goals

**Goals:**
- Produce at least one real, confirmed-passing Playwright test per Must/Should AC, authored interactively and grounded in real implementation code.
- Sync confirmed tests' steps to an Azure DevOps Test Suite as plain-English test case steps.
- Surface AC-vs-implementation gaps as ADO tasks instead of silently writing tests around them.
- Support resuming an interrupted session without re-doing already-confirmed work.

**Non-Goals:** see Product Summary above.

## Requirements by Feature Area

### Interactive Test-Authoring Session

### REQ-001: Post-Implementation Trigger
**Priority:** Must | **Complexity:** Low

- AC-001-1: Given a TRD whose `implement-trd-beads` run has completed at least one shippable PR boundary, when the session is invoked against that TRD/PRD pair, then it begins grounding tests in the code present on that PR's branch.
- AC-001-2: Given a TRD with no completed `implement-trd-beads` execution yet, when the session is invoked, then it halts and tells the user to run `implement-trd-beads` first.
- AC-001-3: Given the story's implementation is already complete and its PR is open (per `implement-trd-beads`'s PR-stack model — one PR boundary at a time), when the session runs, then the tests it authors are committed onto that same feature branch and become part of that same PR, not a separate one.

### REQ-002: PRD + Implementation Grounding
**Priority:** Must | **Complexity:** Medium | **[RISK: if the agent mis-identifies which changed files implement a REQ, it could ground a test in the wrong code without anyone noticing]**

- AC-002-1: Given a PRD's REQ/AC text and a completed implementation on the feature branch, when the session starts a given AC, then the agent reads both the AC's Given/When/Then text and the actual changed files/diff implementing that REQ before proposing a test.
- AC-002-2: Given an AC whose implementing code cannot be located, when the session reaches that AC, then the agent reports a grounding gap rather than guessing at a test.

### REQ-003: Interactive AC Walkthrough
**Priority:** Must | **Complexity:** Medium | **[RISK: unbounded request-changes iterations on one AC could stall the whole session with no forward progress]**

- AC-003-1: Given an AC ready for authoring, when the agent proposes a Playwright test grounded in the real code, then it presents the test and requires one of three explicit choices — accept, request changes, or reject — before moving on. This is verifiable directly from the session transcript.
- AC-003-2: Given Sonia requests changes to a proposed test, when she describes the change, then the agent revises the test and re-presents it rather than silently finalizing the original.
- AC-003-3: Given Sonia rejects a proposed test outright (not a request for changes, but declining the approach entirely), when this happens, then the AC falls into REQ-017's manual/not-automatable escape hatch rather than being left silently uncovered.

### REQ-004: REQ-Level Batching with Checkpoints
**Priority:** Must | **Complexity:** Low

- AC-004-1: Given a story with multiple REQs, when all ACs under one REQ are finished, then the session pauses, prints a summary of what was done for that REQ, and asks whether to continue to the next REQ.
- AC-004-2: Given Sonia stops at a checkpoint, when the session ends, then progress made so far is preserved for a later resume (per REQ-011).

### REQ-017: Manual / Not-Automatable AC Escape Hatch
**Priority:** Should | **Complexity:** Low

- AC-017-1: Given an AC that cannot reasonably be automated (e.g. a visual/manual check), when Sonia marks it as manual-only during the walkthrough, then the session records it as manual-only — distinct from both a confirmed test and an AC gap — rather than dropping it silently or forcing a test.

### Test Execution & Safety

### REQ-005: In-Session Test Confirmation Run
**Priority:** Must | **Complexity:** Medium | **[RISK: QA environment data/state drift between runs could cause a confirmed test to later flake in the nightly regression pipeline]**

- AC-005-1: Given a test Sonia has accepted, when the session runs it against the QA environment, then its pass/fail result is shown to Sonia before the session moves to the next AC.
- AC-005-2: Given a confirmed test fails on first run, when this happens, then the agent investigates (selector/timing/data issue), fixes and reruns, or surfaces the failure to Sonia as a blocker for that AC.

### REQ-013: QA-Environment-Only Execution with Selectable Watch Mode
**Priority:** Must | **Complexity:** Medium | **[RISK: pointing at the wrong environment could mutate real claim/case data]**

- AC-013-1: Given the session is about to run a test, when it resolves the target URL, then it always resolves to the designated QA environment (the same one the nightly regression pipeline targets) and never to production.
- AC-013-2: Given a session starts, when it's about to run its first test, then the agent asks Sonia whether she wants to watch (headed) or let it run independently and report status back (headless) — defaulting to headed since the session is interactive by default.
- AC-013-3: Given headed mode is chosen, when Playwright launches, then it runs headed using Sonia's own interactive Entra ID login, so she can watch the run in real time.
- AC-013-4: Given headless mode is chosen, when Playwright launches, then it authenticates using the existing stored `cribs-e2e-auth-state.json` secure file (the same mechanism the unattended nightly suite uses, since no human is present for an interactive login) and reports the pass/fail result back to Sonia the same as REQ-005 would for a headed run.
- AC-013-5: Given the QA environment is unreachable, when the session detects this, then it halts test execution for that AC rather than falling back to any other environment.

### Test Placement & Traceability

### REQ-006: Test Placement per Existing E2E Conventions
**Priority:** Must | **Complexity:** Low

- AC-006-1: Given a new test file is created, when it's written to `cribs.e2e.tests`, then it uses `AuthenticatedPageTest` or `PageTest` as appropriate, carries `[TestCategory("E2E")]`, and uses `TestConfiguration.*` for URLs/IDs per CLAUDE.md.
- AC-006-2: Given an existing spec file already covers other ACs for the same REQ, when a new AC's test is added, then it's added to that file rather than creating a redundant new file per AC.

### REQ-014: Traceability Tagging
**Priority:** Must | **Complexity:** Low

- AC-014-1: Given a test file is generated, when it's saved, then it carries a comment/attribute tagging the REQ-NNN, AC-NNN-M, and the PRD's Document ID, so later drift-detection tooling can match test to requirement.
- AC-014-2: Given a test file already carries tags for other ACs under the same REQ, when a new AC's tag is added, then the existing tags for those other ACs are preserved unmodified.

### Azure DevOps Test Plan Sync

### REQ-007: ADO Test Case Step Sync
**Priority:** Must | **Complexity:** Medium | **[RISK: if a test file is hand-edited outside this tool, the synced ADO Test Case could silently drift from what the test actually does]**

- AC-007-1: Given a test has been confirmed passing, when the session syncs it, then a Test Case is created/updated in Azure DevOps with each `test.step()` description rendered as a plain-English step, added to a Test Suite linked to the story's work item.
- AC-007-2: Given a test is later modified in a subsequent session, when it's re-synced, then the same ADO Test Case is updated in place — identified by an `@ado-testcase:<id>` tag stored in the spec file's comment block alongside its `@AC-NNN-M @hash:` tag — rather than a duplicate being created or a title-match lookup being attempted.

### REQ-008: ADO Sync Resilience & Fallback Flag
**Priority:** Must | **Complexity:** Low

- AC-008-1: Given an ADO sync call fails, when this happens, then the local test file still lands successfully and is never rolled back.
- AC-008-2: Given a sync failure, when the session attempts remediation, then it retries with troubleshooting before the session ends; if still unresolved, the test is flagged as unsynced with a note that a future refine-tests session (or manual sync) is needed. See Accepted v1 risk above.

### AC-Gap Handling

### REQ-009: AC-Gap Detection
**Priority:** Must | **Complexity:** Medium | **[RISK: a false-positive gap finding files noise tasks and erodes trust in the tool]**

- AC-009-1: Given the agent grounds a test in the real implementation and finds the code does not produce the AC's stated outcome, when this is detected, then the agent stops short of writing a test asserting behavior that doesn't exist and flags the AC as a gap instead.
- AC-009-2: Given an AC gap is flagged, when Sonia reviews it, then she can confirm the gap is real (triggering REQ-010) or override it as a false read by pointing the agent at the correct code path.

### REQ-010: AC-Gap ADO Task Filing
**Priority:** Must | **Complexity:** Medium

- AC-010-1: Given a confirmed AC gap, when the session files it, then a Task is created on the User Story the PRD references, assigned to the git commit author on the implementing branch, describing the gap and suggesting a `refine-trd` → `implement-trd-beads` cycle.
- AC-010-2: Given multiple AC gaps are found in one session, when tasks are filed, then each gets its own Task (not bundled into one), so each can be tracked/closed independently.

### Resumability & Reporting

### REQ-011: Session Resumability & Idempotence
**Priority:** Must | **Complexity:** Medium

- AC-011-1: Given a session is interrupted before all ACs are processed, when the command is re-run against the same PRD/TRD, then it detects which ACs already have a confirmed, landed test by scanning for a per-AC hash tag inside spec files (mirroring `generate-playwright-tests`' `@hash:` convention) — not by file existence — and continues with the rest.
- AC-011-2: Given every AC for a story already has a confirmed test (or is marked manual/gap), when the command is re-run, then it reports the story as already complete and makes no changes.

### REQ-012: Session Completion Summary
**Priority:** Should | **Complexity:** Low

- AC-012-1: Given a session or REQ-checkpoint ends, when it wraps up, then it prints counts of tests written, tests confirmed passing, manual/not-automatable ACs, ADO test cases synced, and AC-gap tasks filed.

### Non-Functional

### REQ-015: No New Paid Infra
**Priority:** Must | **Complexity:** Low

- AC-015-1: Given the session needs to sync to ADO or run tests, when it executes, then it uses only the Azure DevOps MCP server, Playwright, and Claude Code already available in this environment — no new service is provisioned.
- AC-015-2: Given the session needs a capability no currently-available MCP server/tool provides, when this gap is hit, then the session reports the gap explicitly rather than silently working around it with an ad hoc script or new dependency.

### REQ-016: Session Action Observability
**Priority:** Should | **Complexity:** Low

- AC-016-1: Given a session runs, when any action occurs (test written, run result, sync result, gap task filed, manual-AC marked), then it's logged as human-readable console output a human can review after the session ends — v1 targets Sonia watching live, not a downstream consumer, so no structured (JSON) format is required.

## Dependency Map

| REQ | Depends On | Notes |
|-----|-----------|-------|
| REQ-001 | — | Entry gate for the whole session |
| REQ-002 | REQ-001 | Grounding requires a completed implementation to read |
| REQ-003 | REQ-002 | Can't propose a test without grounding first |
| REQ-004 | REQ-003 | Batching wraps the per-AC walkthrough |
| REQ-017 | REQ-003 | Escape hatch offered during the walkthrough |
| REQ-005 | REQ-003, REQ-013 | Only runs accepted tests, only against QA |
| REQ-006 | REQ-003 | Placement applies to accepted tests |
| REQ-014 | REQ-006 | Tag applies to placed tests |
| REQ-007 | REQ-005 | Only syncs confirmed-passing tests |
| REQ-008 | REQ-007 | Resilience wraps the sync step |
| REQ-009 | REQ-002 | Gap detection happens during grounding |
| REQ-010 | REQ-009 | Only files tasks for confirmed gaps |
| REQ-011 | REQ-006, REQ-014 | Resume needs to detect landed, tagged tests |
| REQ-012 | REQ-004, REQ-007, REQ-010 | Summary reports on all three outputs |

**Implementation clusters** (implement together): {REQ-001–REQ-004, REQ-017} core interactive loop · {REQ-005, REQ-013} execution & safety · {REQ-006, REQ-014} placement & tagging · {REQ-007, REQ-008} ADO sync · {REQ-009, REQ-010} gap handling · {REQ-011, REQ-012} resume & reporting.

No circular dependencies.

## Readiness Scorecard

| Dimension | Score (1-5) | Notes |
|-----------|:-:|-------|
| Completeness | 4.5 | All feature areas covered; all 3 `[NEEDS CLARIFICATION]` markers resolved, two Must AC-coverage gaps (REQ-014, REQ-015) closed, dependency count corrected |
| Testability | 4.8 | Every Must requirement now has 2+ GWT ACs; the true-reject path (AC-003-3) closes the last untested branch of the interaction contract |
| Clarity | 4.7 | Trigger timing, ADO test-case linking, and log format are now concrete decisions instead of open questions |
| Feasibility | 4.6 | Builds entirely on existing MCP servers (Azure DevOps, Playwright), existing e2e conventions, git, and beads — no new infra |
| **Overall** | **4.65** | **PASS** (up from 4.25) |

**Gate decision: PASS.** Recommended next step: `/ensemble:create-trd docs/PRD/PRD-2026-da72aa86-interactive-playwright-test-authoring.md`.

## Changelog

- **v1.0.2** (2026-07-24) — `create-trd` Architecture Design surfaced that REQ-013's headed-only mandate conflicted with the chosen orchestrator+delegate architecture's need for an unattended/headless mode. Revised REQ-013 to ask Sonia headed-vs-headless at session start (defaulting to headed), with headless reusing the existing `cribs-e2e-auth-state.json` mechanism since no human is present to log in interactively. Complexity raised Low → Medium to reflect the added mode branch.
- **v1.0.1** (2026-07-24) — `refine-prd` pass: resolved all 3 `[NEEDS CLARIFICATION]` markers (AC-001, trigger fires once the story's PR is open, per `implement-trd-beads`'s PR-stack model, with tests committed onto that same branch/PR; AC-007, ADO Test Case linked via an `@ado-testcase:<id>` tag in the spec file; AC-016, human-readable console logging for v1). Added AC-014-2 and AC-015-2 to close Must-requirement AC-coverage gaps. Added AC-003-3 to define true-reject handling (falls into the REQ-017 manual escape hatch). Added risk flags to REQ-002, REQ-003, REQ-007. Corrected PRD Health Summary's dependency count (16 → 18) and risk-flag count (3 → 6). Fixed REQ-NNN headings from H4 to H3 per convention. Readiness score 4.25 → 4.65.
- **v1.0.0** (2026-07-24) — Initial draft via `create-prd`.
