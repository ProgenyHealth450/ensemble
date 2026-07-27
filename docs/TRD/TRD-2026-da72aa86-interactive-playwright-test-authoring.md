---
document_id: TRD-2026-da72aa86
label: trd-playwright-test-authoring
prd_reference: docs/PRD/PRD-2026-da72aa86-interactive-playwright-test-authoring.md
version: 1.4.0
status: Draft
date: 2026-07-24
design_readiness_score: 4.43
architecture_option: B - Orchestrator command delegating to @playwright-tester
prd_version: 1.0.2
---

# TRD-2026-da72aa86: Interactive Post-Implementation Playwright Test Authoring

## Document Overview

This TRD translates `PRD-2026-da72aa86` into an implementation plan for a new `/ensemble:author-playwright-tests` command: an interactive, post-implementation Playwright test-authoring session for Sonia Pareek (QA) and CRIBs developers. The session runs once a story's implementation is complete and its PR is open, grounds each proposed test in both the PRD's ACs and the real implementing code, runs confirmed tests against the CRIBs QA environment (headed or headless, Sonia's choice), places them in `cribs.e2e.tests` per existing convention, syncs their steps to an Azure DevOps Test Case/Suite as plain-English steps, and files ADO tasks for any AC the implementation doesn't actually satisfy.

**MCP enhancement:** attempted per the standard workflow — `inject_checkpoints`, `assess_complexity`, and `generate_workflow_section` are not present among available MCP tools (only concrete servers like Azure DevOps/Playwright are). Fell back to the manual equivalents: checkpoints are built into REQ-004/TRD-009, complexity/estimates are assigned directly on each task below, and the PR/Sprint structure below is hand-authored.

**v1.1.0 amendment:** pre-merge verification of PR 1-4 (all 39 tasks, `feature/trd-2026-da72aa86-interactive-playwright-test-authoring`, PR #10) found that `packages/e2e-testing/commands/author-playwright-tests.yaml` — the orchestrator this TRD's own architecture assigns "Session lifecycle, prompts, REQ-batching, delegation dispatch, final output" to — was only ever touched by TRD-001, TRD-003, TRD-006, and TRD-007. None of TRD-004/005/008-024 (grounding, resume, delegation, batching, decision loop, landing, tagging, all three ADO-sync modules, gap detection/filing, summaries, logging) ever added their step to the orchestrator's workflow. Every one of those exists as a real, unit-tested `lib/*.js` module (hence 300/300 green) — but nothing chains them together, so the shipped command today halts after the headed/headless prompt (TRD-007) and does nothing further. PR 5 (TRD-025 through TRD-030-TEST) wires the existing modules into the orchestrator's workflow (command version bumped to 2.0.0); it adds no new library logic. **Update: PR 5 is now implemented** — `author-playwright-tests.yaml` carries Phases 3-7 chaining all 19 pipeline modules in order, `tests/author-playwright-tests-workflow.test.js` (TRD-030-TEST) structurally guards against this wiring regressing again, and a fixture dry-run chained all 12 pipeline stages against real function calls with no shape mismatches. `packages/e2e-testing` is 306/306.

**v1.2.0 amendment:** `pr-state.js`'s REQ-001 trigger check (TRD-003) hardcodes `gh` (GitHub CLI) as its only PR-detection mechanism. This TRD's own consuming repo, CRIBs, is hosted on Azure DevOps Repos (`dev.azure.com/progenyhealth/CRIBs`), not GitHub — `gh pr list` cannot resolve a PR for a non-GitHub repo at all, and `checkPrState`'s existing behavior silently maps every exec failure to `{hasOpenPr: false, ...}`. The practical effect: in CRIBs, the session would **always** report "no open PR" and permanently refuse to start, regardless of whether a PR is genuinely open in Azure DevOps — a false negative on REQ-001/AC-001-1, not a `gh`-auth problem. PR 6 (TRD-031/TRD-031-TEST) adds host detection and an Azure-DevOps-native PR-check path, following this package's established "pure decision logic over already-MCP-fetched data" convention (`ado-test-suite.js`, `ado-test-case-sync.js`) since Azure DevOps MCP tools are agent-invocable only, not shell-out-able like `gh`/`git`.

**v1.3.0 amendment:** live-dogfooding PR 6 against a real, open CRIBs PR surfaced two further bugs in the same area, both found before PR 6 had even merged: (1) neither `checkPrState()` nor `checkPrStateAdo()` surfaced the PR's actual base/target branch, so `implementation-grounding.js`'s `groundImplementation()` kept falling back to its hardcoded `main`/`origin/main` default even on CRIBs — whose feature branches target `integration`, not `main` — silently diffing against the wrong base and pulling in unrelated already-integrated work as if it belonged to the PR under test; (2) `checkPrStateAdo()`'s `pr.status === 'active'` string check always failed against a live Azure DevOps MCP server response, which serializes `status` as the underlying .NET `PullRequestStatus` enum's numeric ordinal (`1` = Active) rather than the REST API's string form — meaning PR 6's own Azure DevOps path, while passing every hand-written (string-status) unit test, was still non-functional against the real server. PR 7 (TRD-032/TRD-032-TEST) fixes both: `checkPrState()`/`checkPrStateAdo()` now surface `baseBranch`, threaded through the orchestrator into every `groundImplementation()` call (including the AC-gap override re-run); `isAdoStatusActive()` accepts both the numeric and string status representations; `implementation-grounding.js`'s `resolveMergeBase()` tries an explicit `baseBranch` both bare and `origin/`-prefixed, mirroring the fallback its own hardcoded defaults already got.

**v1.4.0 amendment:** confirmed live against a real, installed CRIBs plugin (not the monorepo checkout): `implementation-grounding.js`'s `DEFAULT_TRD_CLI_PATH = path.resolve(__dirname, '../../development/lib/trd-cli.js')` assumed `packages/e2e-testing` and `packages/development` are sibling directories under a shared `packages/` root — true only in the monorepo, not once each package is published and installed independently as a separate Claude Code plugin (each lands in its own top-level plugin-cache directory). Every `groundImplementation()` call ENOENT'd resolving `trd-cli.js` before any REQ-specific logic ran, unconditionally — the three fixes from PR 6/PR 7 were all correct but moot, since grounding never got far enough to exercise any of them once actually installed. Not caught by the existing 300+ passing tests because every one of them injects `opts.parseTrd`, so `defaultParseTrd()` — the function that actually resolved the broken path — was never exercised. PR 8 (TRD-033/TRD-033-TEST) fixes this the same way `packages/e2e-testing/lib/prd-ac-parser.js` already resolved the identical "e2e-testing needs a sibling package's parser" problem for PRD parsing: a new, scoped `packages/e2e-testing/lib/trd-task-parser.js` extracting only what grounding actually needs (`tasksById` with `satisfies`/`targetFiles` per task — not trd-parser.js's full PR/Phase/Sprint/AC/synthetic-task surface), called in-process with no subprocess and no cross-package path at all. Verified by running the real `groundImplementation()` (no mocks) from an isolated directory with no sibling `development` package present at all, reproducing the installed-plugin layout exactly. Also fixed, incidentally: `extractSatisfies()`'s regex only captured the first REQ id in a multi-REQ `[satisfies REQ-005, REQ-012]` bracket — a real, common convention in this repo's own TRDs — a bug this new module inherited by porting trd-parser.js's exact regex, caught by its own test suite, and fixed in the new module (trd-parser.js itself still has it; out of scope here, worth a separate look).

## Architecture Decision

### Selected Approach: Option B — Orchestrator Command + `@playwright-tester` Delegation

A new thin orchestrator command owns the interactive loop (grounding lookup, REQ-batching/checkpoints, accept/revise/reject/manual decisions, resume detection, ADO sync, gap-filing). It delegates the actual "ground this AC in code, propose a test, run it" work per AC to the existing `@playwright-tester` agent (`packages/e2e-testing/agents/playwright-tester.md`) — the same delegation shape `playwright-test.md` already uses today. Headed-vs-headless mode is threaded through that delegation call as a parameter.

### Alternatives Considered

| Option | Summary | Pros | Cons | Decision |
|--------|---------|------|------|----------|
| A: Monolithic command | All logic (interview, grounding, execution, ADO sync) inline in one command file | Fastest to ship; closest structural mirror of `create-trd` itself | No reuse of `@playwright-tester`; every future change touches the same file; no interface boundary | Rejected |
| B: Orchestrator + delegate to `@playwright-tester` | Orchestrator owns interview/state/ADO/resume; delegates per-AC grounding+authoring+execution to the existing agent | Clean interface boundary; reuses an already-established agent/convention; orchestration and execution can evolve independently | Requires defining a delegation contract upfront | Selected |
| C: Extend `generate-playwright-tests` | Add interactivity/execution/ADO-sync/resume on top of the existing PR #9 scaffolder | Reuses existing hash-tag/file-placement code | Conflates pre-implementation stub scaffolding with post-implementation grounded authoring; inherits unrelated CRLF/frontmatter bugs | Rejected |

### Rationale

The user explicitly flagged that this process will evolve with the team's usage. Option B's clean interface boundary (delegation contract) minimizes blast radius for future changes — orchestration logic (interview flow, checkpointing, resume) and execution logic (how a test actually gets grounded, written, and run) can each change without touching the other. It also reuses `@playwright-tester`, an agent that already exists and is the standing convention for Playwright work in this org, rather than duplicating that specialization inline (Option A) or entangling this effort's evolution with a separately-evolving, currently-buggy tool (Option C).

## System Architecture

```text
Precondition: implement-trd-beads has completed a PR boundary; PR is open (REQ-001)
    |
    v
[author-playwright-tests.yaml] (orchestrator)
    - parse PRD (prd-ac-parser.js) + resolve implementing diff (implementation-grounding.js)
    - scan cribs.e2e.tests for @hash:/@ado-testcase: tags (resume-scan.js) -> skip already-confirmed ACs
    - prompt: watch headed, or run headless and report back? (default: headed)
    |
    v
[per REQ, per AC] --delegate--> [@playwright-tester]
    request:  { ac_text, grounding_diff, target_env: QA, mode: headed|headless }
    response: { proposed_test, selectors, run_result: pass|fail, authoring_failure? }
    |
    v
[ac-decision-loop.js]  Sonia: accept | request changes | reject | mark manual
    - request changes -> re-delegate with feedback
    - reject / authoring_failure with no viable alternative -> manual-ac-tracker.js
    - accept + pass -> continue
    |
    v
[spec-writer.js] write/append to cribs.e2e.tests/**/*.spec.ts
    (AuthenticatedPageTest/PageTest, [TestCategory("E2E")], TestConfiguration.*)
    |
    v
[traceability-tagger.js] tag @AC-NNN-M @hash: @PRD-doc-id
    |
    v
[ado-test-case-sync.js] --> Azure DevOps MCP (testplan_create_test_case,
    testplan_add_test_cases_to_suite) --> tag @ado-testcase:<id>
    on failure: ado-sync-resilience.js retries/troubleshoots; local file never rolled back
    |
    v
[ac-gap-detector.js] (runs during grounding, not after) --> if a real gap is confirmed:
    ac-gap-task-filer.js --> Azure DevOps MCP (wit_create_work_item, wit_add_child_work_items)
    assignee resolved from git commit author via core_get_identity_ids
    |
    v
[req-batcher.js] checkpoint summary after each REQ; [session-summary.js] final summary
```

## Component Boundaries

| Component | Location | Responsibility |
|-----------|----------|-----------------|
| Command orchestrator | `packages/e2e-testing/commands/author-playwright-tests.yaml` | Session lifecycle, prompts, REQ-batching, delegation dispatch, final output |
| Generated command | `packages/e2e-testing/commands/ensemble/author-playwright-tests.md` | Generated user-facing command doc/runtime text |
| PRD/AC parser | `packages/e2e-testing/lib/prd-ac-parser.js` | LF+CRLF-safe, Title-Case-frontmatter-safe REQ/AC extraction (deliberately independent of the buggy shared `prd-parser.js`) |
| Implementation grounding | `packages/e2e-testing/lib/implementation-grounding.js` | Resolve changed files/diff on the open PR's branch per REQ; report grounding gaps |
| Resume scan | `packages/e2e-testing/lib/resume-scan.js` | Scan spec files for per-AC `@hash:`/`@ado-testcase:` tags to detect already-confirmed ACs |
| Delegation contract | `packages/e2e-testing/lib/delegation-contract.js` | Request/response shape between orchestrator and `@playwright-tester` |
| `@playwright-tester` (extended) | `packages/e2e-testing/agents/playwright-tester.md` | Ground one AC in code, propose a test, run it headed or headless against QA |
| REQ batcher | `packages/e2e-testing/lib/req-batcher.js` | Walk ACs one REQ at a time; checkpoint between REQs |
| AC decision loop | `packages/e2e-testing/lib/ac-decision-loop.js` | Accept/request-changes/reject state machine per proposed test |
| Manual AC tracker | `packages/e2e-testing/lib/manual-ac-tracker.js` | Record manual/not-automatable ACs distinctly from confirmed tests and gaps |
| QA env guard | `packages/e2e-testing/lib/qa-env-guard.js` | Resolve/verify QA-only target URL; halt on unreachable, never fall back |
| Spec writer | `packages/e2e-testing/lib/spec-writer.js` | Write/append test files into `cribs.e2e.tests` per existing conventions |
| Traceability tagger | `packages/e2e-testing/lib/traceability-tagger.js` | Apply/preserve `@AC-NNN-M @hash: @ado-testcase:` tags |
| ADO test suite resolver | `packages/e2e-testing/lib/ado-test-suite.js` | Resolve/create the CRIBs Test Suite linked to the PRD's referenced Story |
| ADO test case sync | `packages/e2e-testing/lib/ado-test-case-sync.js` | Create/update ADO Test Cases from `test.step()` narration |
| ADO sync resilience | `packages/e2e-testing/lib/ado-sync-resilience.js` | Retry/troubleshoot sync failures; flag unsynced without blocking local landing |
| AC-gap detector | `packages/e2e-testing/lib/ac-gap-detector.js` | Detect implementation-vs-AC gaps during grounding |
| AC-gap task filer | `packages/e2e-testing/lib/ac-gap-task-filer.js` | File one ADO Task per confirmed gap, assigned to the implementing commit author |
| Session summary/logger | `packages/e2e-testing/lib/session-summary.js`, `session-logger.js` | Per-checkpoint and final human-readable summaries |
| Tests | `packages/e2e-testing/tests/*.test.js` | Unit/contract tests for every lib module above |

## Master Task List

### PR 1: Session Scaffold, Grounding, and Resume Detection

**Shippable State:** Running the new command against a story whose PR is open lists every AC for that story, whether it already has a confirmed test (and its tag), and which REQ's implementation code was found — but does not yet write, run, or sync anything.

- [x] **TRD-001**: Scaffold `author-playwright-tests.yaml` command source and generated command registration (3h) [satisfies ARCH]
  - Target Files: `packages/e2e-testing/commands/author-playwright-tests.yaml`, generated `packages/e2e-testing/commands/ensemble/author-playwright-tests.md`
  - Implementation AC:
    - Given commands are generated, when the command list is inspected, then `/ensemble:author-playwright-tests` is present with description and argument hint.

- [x] **TRD-002**: Write a new lightweight PRD REQ/AC parser, CRLF- and Title-Case-frontmatter-safe (4h) [satisfies REQ-002]
  - Validates PRD ACs: AC-002-1, AC-002-2
  - Target Files: `packages/e2e-testing/lib/prd-ac-parser.js`
  - Implementation AC:
    - Given a PRD with CRLF line endings, when parsed, then all REQ-NNN/AC-NNN-M entries are extracted correctly.
    - Given Title-Case-with-space frontmatter (`Document ID:`, `Label:`), when parsed, then both fields resolve correctly.

- [x] **TRD-002-TEST**: Unit tests for the parser against CRLF/LF and both frontmatter styles (2h) [verifies TRD-002] [satisfies REQ-002] [depends: TRD-002]
  - Validates PRD ACs: AC-002-1, AC-002-2
  - Target File: `packages/e2e-testing/tests/prd-ac-parser.test.js`

- [x] **TRD-003**: Implement the REQ-001 trigger check — verify the target branch has an open PR before allowing the session to start (3h) [satisfies REQ-001] [depends: TRD-001]
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-001-3
  - Target Files: `packages/e2e-testing/commands/author-playwright-tests.yaml`, `packages/e2e-testing/lib/pr-state.js`
  - Implementation AC:
    - Given no open PR exists for the target branch, when the command runs, then it halts with a message to run `implement-trd-beads` first.
    - Given an open PR exists, when the session authors tests, then they are committed onto that same branch/PR.

- [x] **TRD-003-TEST**: Verify halt-and-message vs. successful-start behavior (2h) [verifies TRD-003] [satisfies REQ-001] [depends: TRD-003]
  - Validates PRD ACs: AC-001-1, AC-001-2
  - Target File: `packages/e2e-testing/tests/pr-state.test.js`

- [x] **TRD-004**: Implement implementation-grounding lookup — resolve the changed files/diff on the PR branch for a given REQ (5h) [satisfies REQ-002] [depends: TRD-003]
  - Validates PRD ACs: AC-002-1, AC-002-2
  - Target Files: `packages/e2e-testing/lib/implementation-grounding.js`
  - Implementation AC:
    - Given a REQ whose implementing files can't be located, when grounding runs, then a grounding gap is reported rather than a guess.

- [x] **TRD-004-TEST**: Verify grounding-gap reporting for an unmapped REQ (2h) [verifies TRD-004] [satisfies REQ-002] [depends: TRD-004]
  - Validates PRD ACs: AC-002-2
  - Target File: `packages/e2e-testing/tests/implementation-grounding.test.js`

- [x] **TRD-005**: Implement resume-detection scan of `cribs.e2e.tests` spec files for per-AC `@hash:` tags (4h) [satisfies REQ-011] [depends: TRD-002]
  - Validates PRD ACs: AC-011-1
  - Target Files: `packages/e2e-testing/lib/resume-scan.js`
  - Implementation AC:
    - Given a spec file with 1 of 3 ACs tagged, when resume-scan runs, then only the remaining 2 ACs are treated as pending.

- [x] **TRD-005-TEST**: Verify partial-file resume correctness (2h) [verifies TRD-005] [satisfies REQ-011] [depends: TRD-005]
  - Validates PRD ACs: AC-011-1
  - Target File: `packages/e2e-testing/tests/resume-scan.test.js`

- [x] **TRD-006**: Document the no-new-infra guardrail as an explicit architecture constraint (1h) [satisfies REQ-015] [depends: TRD-001]
  - Validates PRD ACs: AC-015-1, AC-015-2
  - Target Files: `packages/e2e-testing/commands/author-playwright-tests.yaml`

### PR 2: Interactive Walkthrough, Execution, and Local Test Landing

**Shippable State:** Sonia can run a full interactive session against a story with an open PR and get real, human-confirmed Playwright tests landed in `cribs.e2e.tests` for every AC — choosing headed or headless mode, accepting/revising/rejecting proposals, and marking non-automatable ACs manual — without ADO sync or gap-filing yet.

- [x] **TRD-007**: Implement the headed-vs-headless mode prompt at session start, defaulting to headed (2h) [satisfies REQ-013] [depends: TRD-001]
  - Validates PRD ACs: AC-013-2

- [x] **TRD-008**: Define the orchestrator ↔ `@playwright-tester` delegation contract (4h) [satisfies ARCH] [depends: TRD-004, TRD-007]
  - Target Files: `packages/e2e-testing/lib/delegation-contract.js`, `packages/e2e-testing/agents/playwright-tester.yaml`
  - Implementation AC:
    - Given a delegation request (AC text, grounding diff, target env, mode), when `@playwright-tester` responds, then the response includes a proposed test, selectors used, and a run result or an explicit authoring-failure flag.

- [x] **TRD-009**: Implement the REQ-level batching loop with checkpoints (4h) [satisfies REQ-004] [depends: TRD-008]
  - Validates PRD ACs: AC-004-1, AC-004-2
  - Target Files: `packages/e2e-testing/lib/req-batcher.js`

- [x] **TRD-009-TEST**: Verify a checkpoint appears after each REQ and the session can stop cleanly there (2h) [verifies TRD-009] [satisfies REQ-004] [depends: TRD-009]
  - Validates PRD ACs: AC-004-1, AC-004-2
  - Target File: `packages/e2e-testing/tests/req-batcher.test.js`

- [x] **TRD-010**: Implement the accept/request-changes/reject decision point per proposed test (4h) [satisfies REQ-003] [depends: TRD-008]
  - Validates PRD ACs: AC-003-1, AC-003-2, AC-003-3
  - Target Files: `packages/e2e-testing/lib/ac-decision-loop.js`

- [x] **TRD-010-TEST**: Verify request-changes re-presents a revised test and true-reject routes to the manual tracker (2h) [verifies TRD-010] [satisfies REQ-003] [depends: TRD-010, TRD-012]
  - Validates PRD ACs: AC-003-2, AC-003-3
  - Target File: `packages/e2e-testing/tests/ac-decision-loop.test.js`

- [x] **TRD-011**: Extend `@playwright-tester` to run a proposed test headed (Sonia's interactive Entra login) or headless (`cribs-e2e-auth-state.json`) per session mode (5h) [satisfies REQ-005] [satisfies REQ-013] [depends: TRD-008]
  - Validates PRD ACs: AC-005-1, AC-005-2, AC-013-3, AC-013-4
  - Target Files: `packages/e2e-testing/agents/playwright-tester.md`, `packages/e2e-testing/lib/test-runner-mode.js`
  - Implementation AC:
    - Given headless mode, when a test runs, then it authenticates via the existing `cribs-e2e-auth-state.json` secure file.
    - Given a test fails on first run, when this happens, then the agent investigates and either fixes+reruns or surfaces the failure as a blocker.

- [x] **TRD-011-TEST**: Verify both headed and headless execution paths authenticate and run correctly (3h) [verifies TRD-011] [satisfies REQ-005] [satisfies REQ-013] [depends: TRD-011]
  - Validates PRD ACs: AC-005-1, AC-013-3, AC-013-4
  - Target File: `packages/e2e-testing/tests/test-runner-mode.test.js`

- [x] **TRD-012**: Implement the manual/not-automatable escape hatch (2h) [satisfies REQ-017] [depends: TRD-010]
  - Validates PRD ACs: AC-017-1
  - Target Files: `packages/e2e-testing/lib/manual-ac-tracker.js`

- [x] **TRD-013**: Implement QA-environment resolution and unreachable-environment halt (2h) [satisfies REQ-013] [depends: TRD-011]
  - Validates PRD ACs: AC-013-1, AC-013-5
  - Target Files: `packages/e2e-testing/lib/qa-env-guard.js`

- [x] **TRD-014**: Implement test placement into `cribs.e2e.tests` — correct base class, `[TestCategory("E2E")]`, `TestConfiguration.*`, append-to-existing-file behavior (4h) [satisfies REQ-006] [depends: TRD-010]
  - Validates PRD ACs: AC-006-1, AC-006-2
  - Target Files: `packages/e2e-testing/lib/spec-writer.js`

- [x] **TRD-014-TEST**: Verify a second AC under the same REQ appends to the existing file rather than creating a new one (2h) [verifies TRD-014] [satisfies REQ-006] [depends: TRD-014]
  - Validates PRD ACs: AC-006-2
  - Target File: `packages/e2e-testing/tests/spec-writer.test.js`

- [x] **TRD-015**: Implement traceability tagging, preserving existing tags for other ACs in the same file (2h) [satisfies REQ-014] [depends: TRD-014]
  - Validates PRD ACs: AC-014-1, AC-014-2
  - Target Files: `packages/e2e-testing/lib/traceability-tagger.js`

- [x] **TRD-015-TEST**: Verify existing tags survive when a new AC is appended (1h) [verifies TRD-015] [satisfies REQ-014] [depends: TRD-015]
  - Validates PRD ACs: AC-014-2
  - Target File: `packages/e2e-testing/tests/traceability-tagger.test.js`

### PR 3: Azure DevOps Test Plan Sync

**Shippable State:** Every confirmed, landed test also appears as a plain-English Test Case in an Azure DevOps Test Suite linked to the story, readable by non-coders; sync failures never block a test's local landing.

- [x] **TRD-016**: Resolve or create the story's Test Suite, linked to the PRD's referenced CRIBs work item (4h) [satisfies REQ-007] [depends: TRD-014]
  - Validates PRD ACs: AC-007-1
  - Target Files: `packages/e2e-testing/lib/ado-test-suite.js`

- [x] **TRD-017**: Implement Test Case creation/update from `test.step()` narration rendered as plain-English steps (5h) [satisfies REQ-007] [depends: TRD-016]
  - Validates PRD ACs: AC-007-1
  - Target Files: `packages/e2e-testing/lib/ado-test-case-sync.js`

- [x] **TRD-017-TEST**: Verify synced steps read as plain English matching the test's narration (2h) [verifies TRD-017] [satisfies REQ-007] [depends: TRD-017]
  - Validates PRD ACs: AC-007-1
  - Target File: `packages/e2e-testing/tests/ado-test-case-sync.test.js`

- [x] **TRD-018**: Store the ADO Test Case id as an `@ado-testcase:<id>` tag; use it to update in place on re-sync (3h) [satisfies REQ-007] [depends: TRD-017, TRD-015]
  - Validates PRD ACs: AC-007-2
  - Target Files: `packages/e2e-testing/lib/ado-test-case-sync.js`, `packages/e2e-testing/lib/traceability-tagger.js`

- [x] **TRD-018-TEST**: Verify re-sync updates the same Test Case rather than duplicating (2h) [verifies TRD-018] [satisfies REQ-007] [depends: TRD-018]
  - Validates PRD ACs: AC-007-2
  - Target File: `packages/e2e-testing/tests/ado-test-case-sync.test.js`

- [x] **TRD-019**: Implement sync resilience — retry with troubleshooting before session end; flag unsynced on unresolved failure without rollback (4h) [satisfies REQ-008] [depends: TRD-017]
  - Validates PRD ACs: AC-008-1, AC-008-2
  - Target Files: `packages/e2e-testing/lib/ado-sync-resilience.js`

- [x] **TRD-019-TEST**: Verify a simulated sync failure leaves the local test intact and flags it unsynced (2h) [verifies TRD-019] [satisfies REQ-008] [depends: TRD-019]
  - Validates PRD ACs: AC-008-1, AC-008-2
  - Target File: `packages/e2e-testing/tests/ado-sync-resilience.test.js`

### PR 4: AC-Gap Handling, Reporting, and Full Resumability

**Shippable State:** A session that finds an implementation gap files a tracked ADO Task on the story instead of silently skipping it; every session ends with a clear summary; re-running a fully-covered story is a confirmed no-op.

- [x] **TRD-020**: Implement AC-gap detection during grounding — stop short of writing a test for behavior that doesn't exist (4h) [satisfies REQ-009] [depends: TRD-004]
  - Validates PRD ACs: AC-009-1, AC-009-2
  - Target Files: `packages/e2e-testing/lib/ac-gap-detector.js`

- [x] **TRD-020-TEST**: Verify a genuine gap is flagged (not silently passed over) and Sonia's override redirects grounding (3h) [verifies TRD-020] [satisfies REQ-009] [depends: TRD-020]
  - Validates PRD ACs: AC-009-1, AC-009-2
  - Target File: `packages/e2e-testing/tests/ac-gap-detector.test.js`

- [x] **TRD-021**: Resolve the implementing commit author's ADO identity and file one Task per confirmed gap on the referenced Story (4h) [satisfies REQ-010] [depends: TRD-020]
  - Validates PRD ACs: AC-010-1, AC-010-2
  - Target Files: `packages/e2e-testing/lib/ac-gap-task-filer.js`

- [x] **TRD-021-TEST**: Verify two gaps in one session produce two independently-tracked, correctly-assigned Tasks (2h) [verifies TRD-021] [satisfies REQ-010] [depends: TRD-021]
  - Validates PRD ACs: AC-010-2
  - Target File: `packages/e2e-testing/tests/ac-gap-task-filer.test.js`

- [x] **TRD-022**: Implement the session/checkpoint completion summary (2h) [satisfies REQ-012] [depends: TRD-009, TRD-018, TRD-021]
  - Validates PRD ACs: AC-012-1
  - Target Files: `packages/e2e-testing/lib/session-summary.js`

- [x] **TRD-023**: Finalize full-session idempotence — a fully-covered story reports "already complete" with no changes (3h) [satisfies REQ-011] [depends: TRD-005, TRD-012, TRD-021]
  - Validates PRD ACs: AC-011-2
  - Target Files: `packages/e2e-testing/lib/resume-scan.js`, `packages/e2e-testing/lib/session-summary.js`

- [x] **TRD-023-TEST**: Verify a fully-covered re-run makes no file writes and no new ADO calls (2h) [verifies TRD-023] [satisfies REQ-011] [depends: TRD-023]
  - Validates PRD ACs: AC-011-2
  - Target File: `packages/e2e-testing/tests/resume-scan.test.js`

- [x] **TRD-024**: Implement human-readable console logging of every session action (2h) [satisfies REQ-016] [depends: TRD-009]
  - Validates PRD ACs: AC-016-1
  - Target Files: `packages/e2e-testing/lib/session-logger.js`

### PR 5: Orchestrator Wiring — Chain the Session Pipeline

**Shippable State:** Running `/ensemble:author-playwright-tests` against a story with an open PR actually walks every pending AC end to end — grounding, delegation, decision, landing, ADO sync, gap-filing, summary — instead of stopping after the headed/headless prompt. No new library logic; this PR only wires already-built, already-tested `lib/*.js` modules into the orchestrator command.

- [x] **TRD-025**: Wire PRD parsing, implementation grounding, gap detection, and resume-scan into the Scaffold phase, before the headed/headless prompt (3h) [satisfies REQ-002, REQ-009, REQ-011] [depends: TRD-002, TRD-004, TRD-005, TRD-020, TRD-007]
  - Target Files: `packages/e2e-testing/commands/author-playwright-tests.yaml`, generated `packages/e2e-testing/commands/ensemble/author-playwright-tests.md`
  - Implementation AC:
    - Given a story's open PR, when the Scaffold phase runs, then it calls `prd-ac-parser.js`, `implementation-grounding.js` (with `ac-gap-detector.js` run inline, not after), and `resume-scan.js`, and presents the resulting pending-AC worklist before asking headed/headless.

- [x] **TRD-026**: Add the REQ-batching loop with per-AC delegation dispatch to `@playwright-tester` (3h) [satisfies REQ-004, REQ-005, REQ-013] [depends: TRD-025, TRD-008, TRD-009, TRD-011, TRD-013]
  - Target Files: `packages/e2e-testing/commands/author-playwright-tests.yaml`, generated `packages/e2e-testing/commands/ensemble/author-playwright-tests.md`
  - Implementation AC:
    - Given the pending-AC worklist, when the loop runs, then it batches by REQ via `req-batcher.js`, and for each AC builds a request per `delegation-contract.js` (grounding diff, target env from `qa-env-guard.js`, session mode) and dispatches it to `@playwright-tester`.

- [x] **TRD-027**: Add the decision + local-landing phase (3h) [satisfies REQ-003, REQ-006, REQ-014, REQ-017] [depends: TRD-026, TRD-010, TRD-012, TRD-014, TRD-015]
  - Target Files: `packages/e2e-testing/commands/author-playwright-tests.yaml`, generated `packages/e2e-testing/commands/ensemble/author-playwright-tests.md`
  - Implementation AC:
    - Given a `@playwright-tester` response, when the decision phase runs, then it feeds the response through `ac-decision-loop.js` (re-delegating on request-changes; routing reject/no-viable-alternative to `manual-ac-tracker.js`), and on accept+pass calls `spec-writer.js` then `traceability-tagger.js` to land the test.

- [x] **TRD-028**: Add the Azure DevOps Test Plan sync phase (3h) [satisfies REQ-007, REQ-008] [depends: TRD-027, TRD-016, TRD-017, TRD-018, TRD-019]
  - Target Files: `packages/e2e-testing/commands/author-playwright-tests.yaml`, generated `packages/e2e-testing/commands/ensemble/author-playwright-tests.md`
  - Implementation AC:
    - Given a landed test, when the sync phase runs, then it resolves/creates the Test Suite (`ado-test-suite.js`), syncs the Test Case (`ado-test-case-sync.js`), and on failure invokes `ado-sync-resilience.js` without rolling back the local file.

- [x] **TRD-029**: Add the AC-gap Task-filing phase (2h) [satisfies REQ-010] [depends: TRD-025, TRD-021]
  - Target Files: `packages/e2e-testing/commands/author-playwright-tests.yaml`, generated `packages/e2e-testing/commands/ensemble/author-playwright-tests.md`
  - Implementation AC:
    - Given TRD-025's grounding confirms a genuine gap, when the gap phase runs, then it calls `ac-gap-task-filer.js` once per gap, assigned via the implementing commit author's resolved ADO identity.

- [x] **TRD-030**: Wire per-REQ checkpoints, the final session summary, action logging, and the full-session idempotence short-circuit across every phase above (2h) [satisfies REQ-011, REQ-012, REQ-016] [depends: TRD-026, TRD-027, TRD-028, TRD-029, TRD-022, TRD-023, TRD-024]
  - Target Files: `packages/e2e-testing/commands/author-playwright-tests.yaml`, generated `packages/e2e-testing/commands/ensemble/author-playwright-tests.md`
  - Implementation AC:
    - Given a fully-covered story (per TRD-025's resume-scan), when the session starts, then it reports "already complete" and exits before the REQ loop, making no writes or ADO calls.
    - Given a partially-covered story, when each REQ finishes, then `session-summary.js` prints a checkpoint and `session-logger.js` has logged every action taken.

- [x] **TRD-030-TEST**: Add a structural completeness test guarding against this regression recurring (2h) [verifies TRD-025, TRD-026, TRD-027, TRD-028, TRD-029, TRD-030] [depends: TRD-030]
  - Target File: `packages/e2e-testing/tests/author-playwright-tests-workflow.test.js`
  - Implementation AC:
    - Given `author-playwright-tests.yaml`, when parsed, then every `lib/*.js` module listed in this TRD's Component Boundaries table is referenced by name in some workflow step, in the same order as the System Architecture pipeline diagram.
    - Given the same file, when scanned, then no workflow step's description matches placeholder language (e.g. "implemented in later TRD tasks") deferring logic that this TRD claims is already delivered.

### PR 6: Azure DevOps Repo Support for the Trigger Check

**Shippable State:** Running `/ensemble:author-playwright-tests` in a repo hosted on Azure DevOps Repos (e.g. CRIBs) correctly detects an open PR and proceeds, instead of always halting with "no open PR" regardless of actual PR state.

- [x] **TRD-031**: Add git-host detection and an Azure-DevOps-native PR-check path to `pr-state.js`; wire the orchestrator to use it (4h) [satisfies REQ-001] [depends: TRD-003]
  - Target Files: `packages/e2e-testing/lib/pr-state.js`, `packages/e2e-testing/commands/author-playwright-tests.yaml`, generated `packages/e2e-testing/commands/ensemble/author-playwright-tests.md`
  - Implementation AC:
    - Given the current repo's `origin` remote resolves to `dev.azure.com` or `*.visualstudio.com`, when `detectRepoHost()` runs, then it returns `{host: 'azure-devops', organization, project, repository}` parsed from the remote URL, never guessing at a GitHub check for a non-GitHub remote.
    - Given the current repo's `origin` remote resolves to `github.com`, when `detectRepoHost()` runs, then `checkPrState()` behaves exactly as before (TRD-003, unchanged) — this is purely additive.
    - Given an Azure DevOps repo and an already-fetched PR list (the orchestrator's own Azure DevOps MCP call — this module has no MCP client, matching `ado-test-suite.js`'s established boundary), when `checkPrStateAdo(branch, prs)` runs, then it returns the exact same `{hasOpenPr, state, url, number}` shape `checkPrState()` returns for GitHub, so the rest of the pipeline never needs to know which host produced it.
    - Given the orchestrator's Trigger Check step, when the repo host is Azure DevOps, then it calls the Azure DevOps MCP server's PR-list tool with `detectRepoHost()`'s resolved organization/project/repository and feeds the response through `checkPrStateAdo()`, rather than calling `gh`.

- [x] **TRD-031-TEST**: Verify GitHub behavior is unchanged, Azure DevOps host/PR detection is correct, and unrecognized hosts never silently guess (3h) [verifies TRD-031] [satisfies REQ-001] [depends: TRD-031]
  - Target File: `packages/e2e-testing/tests/pr-state.test.js`

### PR 7: Real Base-Branch Grounding and Live Azure DevOps MCP Status Format

**Shippable State:** Grounding a CRIBs PR diffs against its real target branch (e.g. `integration`), not a hardcoded `main` guess, and the Azure DevOps trigger check actually recognizes an open PR against the live MCP server's response shape, not just a hand-written test double.

- [x] **TRD-032**: Surface each PR check's real base/target branch and thread it through grounding; accept the Azure DevOps MCP server's numeric PR status (4h) [satisfies REQ-001, REQ-002] [depends: TRD-031, TRD-004]
  - Target Files: `packages/e2e-testing/lib/pr-state.js`, `packages/e2e-testing/lib/implementation-grounding.js`, `packages/e2e-testing/commands/author-playwright-tests.yaml`, generated `packages/e2e-testing/commands/ensemble/author-playwright-tests.md`
  - Implementation AC:
    - Given a GitHub or Azure DevOps PR whose base/target branch is not `main`, when the Trigger Check runs, then `checkPrState()`/`checkPrStateAdo()` surface it as `baseBranch`, and every subsequent `groundImplementation()` call (including the AC-gap override re-run) is passed `{baseBranch}` rather than falling back to the hardcoded `main`/`origin/main` default.
    - Given an Azure DevOps PR list whose `status` field is the MCP server's numeric `PullRequestStatus` ordinal (`1` = Active) rather than the REST API's string form, when `checkPrStateAdo()` runs, then it still correctly identifies the open PR via `isAdoStatusActive()`.
    - Given an explicit `baseBranch` unfetched locally under its bare name, when `groundImplementation()` resolves its merge-base, then it falls back to `origin/<baseBranch>`, mirroring the fallback the hardcoded defaults already receive.

- [x] **TRD-032-TEST**: Verify baseBranch surfacing/threading and both ADO status representations (3h) [verifies TRD-032] [satisfies REQ-001, REQ-002] [depends: TRD-032]
  - Target Files: `packages/e2e-testing/tests/pr-state.test.js`, `packages/e2e-testing/tests/implementation-grounding.test.js`

### PR 8: Grounding Works Once Actually Installed as a Plugin

**Shippable State:** `groundImplementation()` resolves the TRD parser correctly when `packages/e2e-testing` is installed as an independent Claude Code plugin with no sibling `packages/development` directory present — not just in the monorepo checkout.

- [x] **TRD-033**: Replace the cross-package `trd-cli.js` shell-out with a scoped, in-package TRD task parser (5h) [satisfies REQ-002] [depends: TRD-004]
  - Target Files: `packages/e2e-testing/lib/trd-task-parser.js` (new), `packages/e2e-testing/lib/implementation-grounding.js`
  - Implementation AC:
    - Given `packages/e2e-testing` installed with no sibling `packages/development` directory anywhere on disk, when `groundImplementation()` runs without an injected `opts.parseTrd`, then it correctly resolves `tasksById` via the new in-package `trd-task-parser.js` — no `ENOENT`, no subprocess, no cross-package path.
    - Given a task's `[satisfies REQ-005, REQ-012]` annotation lists more than one REQ in a single bracket, when `trd-task-parser.js` extracts `satisfies`, then every REQ id is captured, not just the first.

- [x] **TRD-033-TEST**: Verify the real (non-mocked) default parseTrd path, isolated from any sibling `development` package (4h) [verifies TRD-033] [satisfies REQ-002] [depends: TRD-033]
  - Target Files: `packages/e2e-testing/tests/trd-task-parser.test.js` (new), `packages/e2e-testing/tests/implementation-grounding.test.js`
  - Implementation AC:
    - Given a real TRD file written to a temp directory, when `groundImplementation()` is called without `opts.parseTrd`, then it grounds correctly via the real default path — the exact code path 300+ mocked-`parseTrd` tests never once exercised, which is what let this ship.

## Team Configuration

> Auto-configured by `/ensemble:configure-team` — **Complex** tier. 39 tasks, 111h estimated, 5 domains detected (testing, documentation, infrastructure, security, devops), 3 cross-cutting tasks, dependency depth 10.
>
> **v1.1.0 addendum:** PR 5 (TRD-025 through TRD-030-TEST) adds 7 tasks / 18h, all pure orchestrator-wiring against the existing `author-playwright-tests.yaml`. Not yet run back through `/ensemble:configure-team` — do that before team assignment, since these tasks sit outside the domain-keyword false positives noted below (they're prompt/workflow edits, not library code, closer to `tech-lead-orchestrator`/`backend-developer` than `playwright-tester`).
>
> **v1.2.0 addendum:** PR 6 (TRD-031/TRD-031-TEST) adds 2 tasks / 7h, fixing `pr-state.js`'s GitHub-only assumption. `backend-developer` fits (plain Node.js library logic + git-remote parsing), not `playwright-tester`.
>
> **v1.3.0 addendum:** PR 7 (TRD-032/TRD-032-TEST) adds 2 tasks / 7h, found live-dogfooding PR 6 against a real CRIBs PR before PR 6 had even merged. `backend-developer` fits, same as PR 6.
>
> **v1.4.0 addendum:** PR 8 (TRD-033/TRD-033-TEST) adds 2 tasks / 9h, found live-testing the actual installed plugin against a real CRIBs PR. `backend-developer` fits.
>
> **Note:** the domain-keyword scan is tuned for web-app TRDs and misreads this one — ~20 of 39 tasks (plain Node.js library/orchestration modules: `resume-scan.js`, `ac-decision-loop.js`, `spec-writer.js`, `ado-test-case-sync.js`, `req-batcher.js`, etc.) match no domain keyword at all, while `documentation`/`infrastructure`/`security`/`devops` each fired from a single substring false positive (`document`/`infra` in "no-new-infra guardrail" TRD-006, `auth` in `cribs-e2e-auth-state.json` TRD-011/011-TEST, `logging` in "console logging" TRD-024). Builder roster below is corrected per user direction: `backend-developer` covers the undetected plain-implementation tasks; `playwright-tester` covers the genuine E2E/testing-domain tasks (TRD-008, TRD-011, TRD-014, TRD-016–021 and their test tasks).

```yaml
team:
  roles:
    - name: lead
      agent: tech-lead-orchestrator
      owns:
        - task-selection
        - architecture-review
        - final-approval
    - name: builder
      agents:
        - backend-developer
        - playwright-tester
      owns:
        - implementation
    - name: reviewer
      agent: code-reviewer
      owns:
        - code-review
    - name: qa
      agent: qa-orchestrator
      owns:
        - quality-gate
        - acceptance-criteria
```

## Sprint Planning

## Sprint 1: Scaffold and Grounding

- PR 1: Session scaffold, grounding, and resume detection.

## Sprint 2: Interactive Core

- PR 2: Interactive walkthrough, execution, and local test landing.

## Sprint 3: Traceability and Hardening

- PR 3: Azure DevOps Test Plan sync.
- PR 4: AC-gap handling, reporting, and full resumability.

## Sprint 4: Orchestrator Wiring

- PR 5: Chain the built-and-tested `lib/*.js` modules into the orchestrator command (v1.1.0 addendum — see amendment note above).

## Sprint 5: Multi-Host Repo Support

- PR 6: Azure DevOps Repos support for the REQ-001 trigger check (v1.2.0 addendum — see amendment note above).
- PR 7: real base-branch grounding and live Azure DevOps MCP status format (v1.3.0 addendum — see amendment note above).
- PR 8: grounding works once actually installed as a plugin (v1.4.0 addendum — see amendment note above).

## Acceptance Criteria Traceability

| REQ | Description | Implementation Tasks | Test Tasks |
|-----|-------------|----------------------|------------|
| REQ-001 | Post-implementation trigger | TRD-003, TRD-031, TRD-032 | TRD-003-TEST, TRD-031-TEST, TRD-032-TEST |
| REQ-002 | PRD + implementation grounding | TRD-002, TRD-004, TRD-025, TRD-032, TRD-033 | TRD-002-TEST, TRD-004-TEST, TRD-032-TEST, TRD-033-TEST |
| REQ-003 | Interactive AC walkthrough | TRD-010, TRD-027 | TRD-010-TEST |
| REQ-004 | REQ-level batching with checkpoints | TRD-009, TRD-026 | TRD-009-TEST |
| REQ-005 | In-session test confirmation run | TRD-011, TRD-026 | TRD-011-TEST |
| REQ-006 | Test placement per existing conventions | TRD-014, TRD-027 | TRD-014-TEST |
| REQ-007 | ADO Test Case step sync | TRD-016, TRD-017, TRD-018, TRD-028 | TRD-017-TEST, TRD-018-TEST |
| REQ-008 | ADO sync resilience & fallback flag | TRD-019, TRD-028 | TRD-019-TEST |
| REQ-009 | AC-gap detection | TRD-020, TRD-025 | TRD-020-TEST |
| REQ-010 | AC-gap ADO task filing | TRD-021, TRD-029 | TRD-021-TEST |
| REQ-011 | Session resumability & idempotence | TRD-005, TRD-023, TRD-025, TRD-030 | TRD-005-TEST, TRD-023-TEST |
| REQ-012 | Session completion summary | TRD-022, TRD-030 | — |
| REQ-013 | QA-environment-only execution, selectable mode | TRD-007, TRD-011, TRD-013, TRD-026 | TRD-011-TEST |
| REQ-014 | Traceability tagging | TRD-015, TRD-027 | TRD-015-TEST |
| REQ-015 | No new paid infra | TRD-006 | — |
| REQ-016 | Session action observability | TRD-024, TRD-030 | — |
| REQ-017 | Manual/not-automatable AC escape hatch | TRD-012, TRD-027 | TRD-010-TEST |

## Traceability Validation Summary

Traceability check: 17 requirements covered, 0 uncovered, 0 orphaned annotations. All 17 had implementation-task coverage since v1.0.0, but before v1.1.0's PR 5, that coverage was library-level only — REQ-002 through REQ-017 (excluding REQ-001, REQ-006, REQ-015) were not actually reachable by running the shipped command. PR 5 (TRD-025 through TRD-030) closes that by wiring the orchestrator; TRD-030-TEST guards against the wiring silently regressing again.

## Adversarial Review

### Architecture Issues and Resolutions

1. **Issue:** The delegation contract didn't distinguish "`@playwright-tester` couldn't produce a viable test" from a user reject or a confirmed AC gap.
   **Resolution:** TRD-008's contract includes an explicit `authoring_failure` outcome distinct from both; TRD-010's decision loop routes it to Sonia for a manual/gap/retry choice rather than overloading reject or gap semantics.

2. **Issue:** The ADO Test Plan sync (PR 3) and gap-task filing (PR 4) both assume a linkable ADO work item — but this repo itself has no ADO tracking.
   **Resolution:** Confirmed with the user: this TRD's own id is a micro-UUID like its source PRD (no ADO work item for the ensemble repo's own development); the ADO sync/gap-filing *feature* this tool builds targets CRIBs' ADO project, since that's where the Stories being tested actually live.

### Coverage Issues and Resolutions

1. **Issue:** PR 1's Shippable State ("lists ACs and grounding gaps") is the thinnest user-observable capability of the four PR boundaries.
   **Resolution:** Accepted as-is — it still produces a real, reviewable coverage-gap report Sonia/a developer can act on, not pure scaffolding; splitting it further would fragment the read-only grounding logic across two PRs for no benefit.

2. **Issue (found in pre-merge verification, v1.1.0):** PR 2, 3, and 4's Shippable State claims ("Sonia can run a full interactive session and get real, human-confirmed Playwright tests landed"; ADO Test Case sync; AC-gap Task filing) were not actually true of the shipped command. Every task in PR 2-4 built and unit-tested a `lib/*.js` module in isolation, but none of them wired that module into `author-playwright-tests.yaml`'s workflow — the orchestrator this TRD's own architecture assigns that responsibility to. Running the command today still halts after TRD-007's headed/headless prompt. 39/39 tasks checked and 300/300 tests green measured library correctness, not that the command actually invokes the library.
   **Resolution:** Added PR 5 (TRD-025 through TRD-030-TEST) to wire the existing modules into the orchestrator, plus a structural test (TRD-030-TEST) that fails if a future change lets the orchestrator's workflow drift back out of sync with the modules it's supposed to call. No PR 1-4 task or its Shippable State claim was altered — this is corrective, additive scope.

3. **Issue (found post-implementation, v1.2.0):** TRD-003's REQ-001 trigger check hardcodes `gh` (GitHub CLI). CRIBs — this TRD's own consuming repo — is hosted on Azure DevOps Repos, not GitHub, so `checkPrState()` always falls into its exec-failure path and reports `hasOpenPr: false` regardless of true PR state, permanently blocking the session in the one repo this TRD was written for.
   **Resolution:** Added PR 6 (TRD-031/TRD-031-TEST): `detectRepoHost()` classifies the `origin` remote, and `checkPrStateAdo()` normalizes an orchestrator-fetched Azure DevOps PR list into the same `{hasOpenPr, state, url, number}` shape `checkPrState()` already returns for GitHub — additive only, TRD-003's GitHub path is untouched.

4. **Issue (found live-testing the installed plugin, v1.4.0):** TRD-004's `groundImplementation()` resolved `packages/development/lib/trd-cli.js` via a hardcoded relative path assuming `packages/e2e-testing` and `packages/development` are sibling directories under a shared `packages/` root — true only in the monorepo checkout. Once installed as independently-published Claude Code plugins, each lands in its own top-level plugin-cache directory; the path resolves to nowhere, and grounding ENOENT'd for every REQ, unconditionally, the moment the plugin was actually installed. Every existing test injected `opts.parseTrd`, so the broken default path was never once exercised despite 300+ passing tests.
   **Resolution:** Added PR 8 (TRD-033/TRD-033-TEST): a new, scoped `packages/e2e-testing/lib/trd-task-parser.js` extracting only what grounding needs (`tasksById` with `satisfies`/`targetFiles`), called in-process — no subprocess, no cross-package path — following the exact precedent `packages/e2e-testing/lib/prd-ac-parser.js` already set for the identical problem in PRD parsing. Verified by running the real `groundImplementation()` from a directory with no sibling `development` package present at all.

### Dependency and Estimate Issues

1. **Issue:** The chain TRD-001 → TRD-003 → TRD-004 → TRD-008 → TRD-010 → TRD-012 is depth 6 (> 3).
   **Resolution:** Accepted — it reflects genuine sequential necessity (can't propose a test before grounding, can't decide manual-vs-not before the decision loop exists), not an artificial constraint.

### Testability Issues

1. **Issue:** The interactive accept/revise/reject/manual decision points are inherently interactive, hard to assert against in an automated unit test.
   **Resolution:** Test tasks (e.g. TRD-010-TEST) assert against the pure state-machine logic (given a decision input, correct routing occurs) using fixture inputs, not against a live interactive session.

## Design Readiness Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Architecture completeness | 4.3 | Components, delegation contract, and data flow are defined; the ADO-linkage question was a real gap, now resolved with the user. |
| Task coverage | 4.7 | Every PRD requirement has implementation coverage; all user-facing REQs have paired test tasks (REQ-012/015/016 are session-reporting/constraint requirements verified via their parent tasks' tests). |
| Dependency clarity | 4.5 | PR boundaries are acyclic; one depth-6 chain is flagged and accepted as genuine sequencing, not an artificial constraint. |
| Estimate confidence | 4.5 | Tasks are granular (1-5h); test:implementation hour ratios are consistent across the list. |
| **Overall** | **4.43** | **PASS — ready for implementation handoff.** |

## Next Steps

- PR 1-4 (TRD-001 through TRD-024): implemented, tested, and merged via PR #10 — no further action.
- PR 5 (TRD-025 through TRD-030-TEST): implemented directly on the same branch/PR #10, verified via `packages/e2e-testing`'s test suite plus a fixture dry-run chaining all 12 pipeline stages. Ready to merge.
- PR 6 (TRD-031/TRD-031-TEST): implemented directly on the same branch/PR #10, verified against CRIBs' actual Azure DevOps remote URL and its own test suite.
- PR 7 (TRD-032/TRD-032-TEST): implemented directly on the same branch/PR #10, found and verified live-dogfooding PR 6 against a real, open CRIBs PR.
- PR 8 (TRD-033/TRD-033-TEST): implemented directly on the same branch/PR #10 (39/39 + 7/7 + 2/2 + 2/2 + 2/2 = 52/52 tasks now complete), found and verified live-testing the actual installed plugin against a real CRIBs PR. `packages/e2e-testing` is 339/339.
- The feature is installable/usable in a consuming repo (e.g. CRIBs) once PR #10 merges — see the v1.1.0/v1.2.0/v1.3.0/v1.4.0 amendment notes under Document Overview.
