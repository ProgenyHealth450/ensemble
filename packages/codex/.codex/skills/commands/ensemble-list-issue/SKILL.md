---
name: ensemble-list-issue
description: List open Beads issues for triage via the toolchain-cli tracker abstraction (tracker.list / work-graph.plan) (Codex skill for /ensemble:list-issue)
user-invocable: true
argument-hint: '[--ranked | --robot-triage]'
model: gpt-5.1-codex
capabilities:
  required:
    - tracker.list
  optional:
    - work-graph.plan
---

# Ensemble Command: /ensemble:list-issue

This Codex skill mirrors the Ensemble slash command `/ensemble:list-issue`.
Follow the workflow below, adapt to the current repository, and keep outputs structured.

<!-- DO NOT EDIT - Generated from list-issue.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Thin passthrough with no ensemble-specific workflow: list and rank tracker issues
through the toolchain-cli tracker/work-graph capability abstraction. Integration section.

## Workflow

### Phase 1: Beads Work Discovery

**1. Resolve toolchain-cli and preflight capabilities**
   Resolve TOOLCHAIN_CLI (RELATIVE_PATH packages/development/lib/toolchain-cli.js) with the tool-path-resolution skill (skills/tool-path-resolution/SKILL.md). If it does not resolve print "ERROR: could not locate toolchain-cli" and HALT.
Run: node "$TOOLCHAIN_CLI" preflight --require tracker.list [add --non-interactive when FOREMAN_TASK_TITLE is set] --json; on a non-ok result print the error and HALT before calling either capability. work-graph.plan is optional and is NOT part of this preflight call (marking an optional capability mandatory here would make the documented fallback below unreachable, exactly the bug this file previously had) -- its availability is instead discovered by calling it directly in step 2 and treating any non-ok/unavailable result as "not available", never a HALT. This command has no side-effecting write and so never calls confirm-status/confirm-record.


**2. Run tracker listing for ranked or flat output**
   Run `node "$TOOLCHAIN_CLI" run work-graph.plan --json` for ranked/scored triage output when the caller asked for --ranked or --robot-triage, falling back to `node "$TOOLCHAIN_CLI" run tracker.list --json` (filtered to status=open) when that work-graph.plan call is unavailable or fails, or the caller asked for the flat form (default when $ARGUMENTS is empty).

- Present the result to the user as-is, printing data.orderingSource and data.dependencyAware when work-graph.plan was used. Do not create, modify, or close any issues.

## Expected Output

**Format:** tracker listing output, unmodified

**Structure:**
- **Issue List**: Whatever tracker.list or work-graph.plan returned for the requested mode (flat list or ranked triage)

## Usage

```
/ensemble:list-issue [--ranked | --robot-triage]
```
