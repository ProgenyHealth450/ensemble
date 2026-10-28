---
name: ensemble-refine-beads
description: >-
  Refine a Beads dependency graph before execution. The command analyzes a
  selected epic/release-train subtree by default, or the whole project when
  --scope project is explicitly supplied. It detects hierarchy gaps, dependency
  issues, PR-boundary mismatches, missing requirement/AC traceability, duplicate
  tasks, and priority/order contradictions. Analysis is read-only until the user
  approves selected fixes. All Beads updates go through the tracker.* toolchain
  capabilities, resolved via toolchain-cli (never a direct tracker-binary
  invocation). Optional dependency-graph health analysis uses the
  work-graph.graph-health capability when available. This command uses
  beads-scaffold-specialist semantics for graph audit/repair work rather than
  backend-developer. It never executes implementation work, tests, builders,
  reviewers, branches, commits, or PR creation.
disable-model-invocation: true
---
<!-- Command: ensemble-refine-beads | Version: 1.1.0 -->
<!-- Description: Approval-gated Beads graph refinement before execution -->
<!-- Capabilities: required=[tracker.list, tracker.update, tracker.comment], optional=[work-graph.graph-health, tracker.dep-add, tracker.dep-remove, tracker.sync] -->

# ensemble-refine-beads

> **Mission:** Refine a Beads dependency graph before execution. The command analyzes a selected epic/release-train subtree by default, or the whole project when --scope project is explicitly supplied. It detects hierarchy gaps, dependency issues, PR-boundary mismatches, missing requirement/AC traceability, duplicate tasks, and priority/order contradictions. Analysis is read-only until the user approves selected fixes. All Beads updates go through the tracker.* toolchain capabilities, resolved via toolchain-cli (never a direct tracker-binary invocation). Optional dependency-graph health analysis uses the work-graph.graph-health capability when available. This command uses beads-scaffold-specialist semantics for graph audit/repair work rather than backend-developer. It never executes implementation work, tests, builders, reviewers, branches, commits, or PR creation.

## Phase 1: Preflight

### Step 1: Argument Parsing

Parse scope and mode from arguments

**Actions:**
1. Parse $ARGUMENTS. If --scope project is present, set SCOPE_MODE=project and warn: "Project scope may affect unrelated epics."
2. Otherwise extract first token as SCOPE_QUERY. It may be an epic ID, release train ID, or slug pattern.
3. If no SCOPE_QUERY and SCOPE_MODE is not project, prepare to list candidate open epics/release trains and ask the user to select one.

### Step 2: Toolchain Preflight

Resolve toolchain-cli and verify tracker capability health before any tracker call

**Actions:**
1. Resolve TOOLCHAIN_CLI (RELATIVE_PATH packages/development/lib/toolchain-cli.js) with the tool-path-resolution skill (packages/development/skills/tool-path-resolution/SKILL.md). If it does not resolve print "ERROR: could not locate toolchain-cli" and HALT.
2. Run: node "$TOOLCHAIN_CLI" preflight --require tracker.list --require tracker.update --require tracker.comment --json [add --non-interactive when --foreman is present] and parse stdout as PREFLIGHT_RESULT. ok:false -> print PREFLIGHT_RESULT.error.message and HALT. Store RUN_ID = PREFLIGHT_RESULT.runId; every later toolchain-cli call in this invocation passes --run-id "$RUN_ID". tracker.sync is optional and not preflighted (a server-side tracker has no local flush step); its calls below skip silently on {ok:false}, never HALTing.

### Step 3: Scope Resolution

Resolve exactly one subtree scope or explicit project scope

**Actions:**
1. Run: node "$TOOLCHAIN_CLI" run tracker.list --run-id "$RUN_ID" --json and capture ISSUE_JSON from the result's data. This is read-only.
2. If SCOPE_MODE=project: continue with all issues and include affected epic/release-train context in every finding where possible.
3. If SCOPE_QUERY is empty: list open epic/release-train candidates from ISSUE_JSON and ask the user to select one; store selected bead ID as SCOPE_QUERY.
4. Resolve BEADS_REFINE_CLI per the tool-path-resolution skill (packages/development/skills/tool-path-resolution/SKILL.md) for packages/development/lib/beads-refine-cli.js. If none of the 4 tiers resolve OR 'which node' fails: print 'ERROR: Node.js and the beads refine CLI (lib/beads-refine-cli.js) are required. Ensure Node.js is installed and the ensemble-development plugin is present.' and exit 1. Resolved once here and reused by every later phase.
5. Run: node "$BEADS_REFINE_CLI" analyze --issues-json <ISSUE_JSON_FILE> --query <SCOPE_QUERY> only for scope validation; if zero or multiple matches, print candidates and HALT.

## Phase 2: Read-Only Graph Analysis

### Step 1: Sync Before Graph Analysis

Confirm tracker writes for this session, then flush pending tracker state before analysis reads it

**Actions:**
1. Before this command's first tracker write: run node "$TOOLCHAIN_CLI" confirm-status tracker.update --run-id "$RUN_ID" --json [add --non-interactive when --foreman is present] and parse as CONFIRM_STATUS. If CONFIRM_STATUS.data.required is true and CONFIRM_STATUS.data.confirmed is false: when --foreman is not present ask via ask "Allow the tracker adapter to write (sync/comment/update/dep changes) for this session? [yes/no]"; on yes run node "$TOOLCHAIN_CLI" confirm-record tracker.update --run-id "$RUN_ID" --json. Under --foreman, never prompt (non-interactive already passed; the CLI auto-confirms and logs).
2. Run: node "$TOOLCHAIN_CLI" run tracker.sync --run-id "$RUN_ID" --json [add --non-interactive when --foreman is present] (optional; {ok:false} -> skip silently, continue).

### Step 2: Optional Graph Health Analysis

Collect dependency-graph health signals without blocking on an unavailable adapter

**Actions:**
1. Run: node "$TOOLCHAIN_CLI" run work-graph.graph-health --run-id "$RUN_ID" --json [add --non-interactive when --foreman is present] and capture the result as GRAPH_HEALTH.
2. If the call fails or the capability is unavailable, warn and continue with tracker-derived findings only.

### Step 3: Finding Detection

Detect graph, hierarchy, PR-boundary, traceability, duplicate, and order issues

**Actions:**
1. Run: node "$BEADS_REFINE_CLI" analyze --issues-json <ISSUE_JSON_FILE> [--bv-json <GRAPH_HEALTH_FILE>] [--query <SCOPE_QUERY>|--scope project] and capture FINDINGS_JSON.
2. Findings MUST include affected bead IDs, severity, issue type, recommendation, and source (tracker, work-graph, or derived).
3. Detect cycles, stale blockers, missing blockers, contradictory priority/order recommendations, orphaned tasks, missing parent/child links, PR-boundary mismatches, missing PR metadata, missing requirement/AC traceability, missing requirement detail, duplicate or near-duplicate tasks.
4. No tracker.update, tracker.dep-add, tracker.dep-remove, tracker.close, branch, test, builder, reviewer, or implementation capability call may run in this phase.

### Step 4: Generate Repair Plan

Convert findings into approval-gated tracker repair capability calls

**Actions:**
1. Run: node "$BEADS_REFINE_CLI" plan --findings <FINDINGS_JSON_FILE> and capture REPAIR_PLAN.
2. Each repair plan entry must include finding ID, proposed tracker capability call(s), expected graph effect, verification spec, risk, and inverse calls when available.
3. If a finding requires user resolution, the repair plan entry must be marked skipped/manual and must not include executable tracker capability calls.

## Phase 3: Approval and Repair Planning

### Step 1: Present Findings and Proposed Fixes

Show consolidated findings before any mutation

**Actions:**
1. Group findings by issue type. For each finding print finding ID, severity, affected bead IDs, recommendation, proposed tracker capability call(s) from REPAIR_PLAN, and expected graph effect.
2. If no findings are detected: print "Graph is refinement-ready" and suggest /ensemble-beads-build <scope> --plan or /ensemble-beads-build; then run node "$TOOLCHAIN_CLI" run tracker.sync --run-id "$RUN_ID" --json [add --non-interactive when --foreman is present] (optional; skip silently on {ok:false}) and exit.

### Step 2: User Approval

Apply only explicitly approved fixes

**Actions:**
1. Ask user to approve none, selected fix IDs, or all non-dependency fixes.
2. If the user selects all and any fix contains tracker.dep-add or tracker.dep-remove, ask a separate explicit confirmation before dependency capability calls run.
3. For cycles or contradictory dependency recommendations, ask the user how to resolve: retry with chosen edge, skip, reverse selected edge, or abort.
4. If the user does not choose a cycle/contradiction resolution, skip or block the affected fix. Never guess.

## Phase 4: Apply Approved Repairs

### Step 1: Ordered Tracker Repair Plan

Execute approved tracker capability calls one at a time

**Actions:**
1. Run: node "$TOOLCHAIN_CLI" run tracker.sync --run-id "$RUN_ID" --json [add --non-interactive when --foreman is present] before applying fixes (optional; {ok:false} -> skip silently, continue).
2. Print the ordered repair plan.
3. For each approved fix, run exactly one tracker capability call at a time via node "$TOOLCHAIN_CLI" run <capability> --run-id "$RUN_ID" --arg <k>=<v> --json [add --non-interactive when --foreman is present]. Supported mutations include tracker.comment, tracker.update, tracker.dep-add, and tracker.dep-remove as generated by the repair plan.
4. After each successful tracker capability call, run node "$BEADS_REFINE_CLI" verify with the verification spec for that fix. Continue only if verification passes.

### Step 2: Failure Recovery

Stop on failure and ask user how to proceed

**Actions:**
1. If a tracker capability call fails, stop applying further fixes immediately.
2. Report failed command, stdout/stderr summary, fix ID, and progress count.
3. Offer recovery choices: retry failed command, skip failed fix, print/run inverse commands when possible, cancel remaining fixes, or abort.
4. Do not run remaining fixes before the user chooses a recovery option.

## Phase 5: Post-Repair Validation and Handoff

### Step 1: Sync and Revalidate

Persist successful changes and rerun graph validation

**Actions:**
1. If at least one fix succeeded, run node "$TOOLCHAIN_CLI" run tracker.sync --run-id "$RUN_ID" --json [add --non-interactive when --foreman is present] (optional; skip silently on {ok:false}).
2. Rerun node "$TOOLCHAIN_CLI" run work-graph.graph-health --run-id "$RUN_ID" --json [add --non-interactive when --foreman is present] (optional capability; if unavailable, warn and continue).
3. Summarize remaining cycles, blockers, hierarchy gaps, and risks.

### Step 2: Final Refinement Summary

Print concise summary and next steps

**Actions:**
1. Print counts: findings found, fixes approved, fixes applied, fixes skipped, failed fixes, and remaining graph issues.
2. If dependency updates were applied, list each changed dependency edge with source and target bead IDs.
3. Print next steps: /ensemble-beads-build <scope> --plan or /ensemble-beads-build <scope>.
4. Run: node "$TOOLCHAIN_CLI" run tracker.sync --run-id "$RUN_ID" --json [add --non-interactive when --foreman is present] before exit (optional; {ok:false} -> skip silently, continue).
