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

**1. Command Registration**
   Placeholder step confirming the command is scaffolded and registered.
The interactive walkthrough, implementation grounding, execution, and
Azure DevOps sync logic are implemented in later TRD tasks.


## Expected Output

**Format:** Confirmed Playwright tests synced to Azure DevOps

**Structure:**
- **Test Files**: Playwright test specs landed for confirmed acceptance criteria
- **Azure DevOps Test Cases**: Plain-English steps synced to the target ADO Test Case/Suite

## Usage

```
/ensemble:author-playwright-tests [story-or-pr-reference]
```
