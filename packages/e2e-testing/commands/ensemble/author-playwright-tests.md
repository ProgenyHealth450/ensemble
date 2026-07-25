---
name: ensemble:author-playwright-tests
description: Interactive, post-implementation Playwright test-authoring session grounded in shipped code and PRD acceptance criteria
version: 1.0.0
category: testing
last-updated: 2026-07-24
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
shipped a PR boundary for the target branch. Before proceeding,
call packages/e2e-testing/lib/pr-state.js's checkPrState(branch)
with the current branch (or the story/PR reference passed as the
command argument, resolved to a branch name) to determine whether
an open PR exists.


   - Resolve the target branch: current git branch, or the branch backing the story/PR reference argument
   - Call checkPrState(branch) from packages/e2e-testing/lib/pr-state.js
   - If hasOpenPr is false: halt the session and print pr-state.js's NO_OPEN_PR_MESSAGE (run /ensemble:implement-trd-beads first) — do not proceed to grounding, execution, or sync
   - If hasOpenPr is true: proceed with the session on that same branch/PR — all authored test commits land there

**2. Command Registration**
   Placeholder step confirming the command is scaffolded and registered.
The interactive walkthrough, implementation grounding, execution, and
Azure DevOps sync logic are implemented in later TRD tasks.


### Phase 2: Execution Setup

**1. Ask Headed or Headless — Once Per Session**
   REQ-013: before running the first test in the session, ask Sonia
(in conversation — this session is interactive via Claude Code, so
"asking" means posing the question directly, not a GUI dialog)
whether she wants to watch the browser run (headed) or let it run
independently and report status back (headless). This is a single,
one-time choice for the whole session, made once here before the
first test run — do not re-ask per AC. The actual headed/headless
launch mechanics and QA-environment resolution are implemented in
later TRD tasks (TRD-011, TRD-013); this step only establishes the
session-wide mode choice.


   - Before running the first test this session, ask Sonia: "Would you like to watch these tests run (headed), or should I run them independently and report status back (headless)?"
   - If she does not specify a preference, default to headed — this session is interactive by default
   - Record the chosen mode for the remainder of the session; do not ask again for subsequent ACs/tests

## Expected Output

**Format:** Confirmed Playwright tests synced to Azure DevOps

**Structure:**
- **Test Files**: Playwright test specs landed for confirmed acceptance criteria
- **Azure DevOps Test Cases**: Plain-English steps synced to the target ADO Test Case/Suite

## Usage

```
/ensemble:author-playwright-tests [story-or-pr-reference]
```
