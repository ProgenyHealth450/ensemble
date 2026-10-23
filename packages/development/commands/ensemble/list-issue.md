---
name: "ensemble:list-issue"
description: "List open Beads issues for triage via the toolchain-cli tracker abstraction (tracker.list / work-graph.plan)"
version: "2.0.0"
category: "implementation"
last-updated: "2026-10-23"
capabilities-required: "tracker.list"
capabilities-optional: "work-graph.plan"
argument-hint: "[--ranked | --robot-triage]"
model: "haiku"
---
<!-- DO NOT EDIT - Generated from list-issue.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Thin passthrough with no ensemble-specific workflow: list and rank tracker issues
through the toolchain-cli tracker/work-graph capability abstraction. Integration section.

## Workflow

### Phase 1: Beads Work Discovery

**1. Resolve toolchain-cli and preflight capabilities**
   Resolve TOOLCHAIN_CLI (RELATIVE_PATH packages/development/lib/toolchain-cli.js) with the tool-path-resolution skill (skills/tool-path-resolution/SKILL.md). If it does not resolve print "ERROR: could not locate toolchain-cli" and HALT.
Run: node "$TOOLCHAIN_CLI" preflight --require tracker.list --require work-graph.plan [add --non-interactive when FOREMAN_TASK_TITLE is set] --json; on a non-ok result print the error and HALT before calling either capability. This command has no side-effecting write and so never calls confirm-status/confirm-record.


**2. Run tracker listing for ranked or flat output**
   Run `node "$TOOLCHAIN_CLI" run work-graph.plan --json` for ranked/scored triage output when the caller asked for --ranked or --robot-triage, falling back to `node "$TOOLCHAIN_CLI" run tracker.list --json` (filtered to status=open) when work-graph.plan was not among the preflighted optional capabilities, fails, or the caller asked for the flat form (default when $ARGUMENTS is empty).

- Present the result to the user as-is, printing data.orderingSource and data.dependencyAware when work-graph.plan was used. Do not create, modify, or close any issues.

## Expected Output

**Format:** tracker listing output, unmodified

**Structure:**
- **Issue List**: Whatever tracker.list or work-graph.plan returned for the requested mode (flat list or ranked triage)

## Usage

```
/ensemble:list-issue [--ranked | --robot-triage]
```
