---
name: ensemble-implement-bead
description: Implement one bead by ID on a feature branch using the same branching and commit policy as beads-build and implement-trd-beads, opening its change request through the configured host adapter (Codex skill for /ensemble:implement-bead)
user-invocable: true
argument-hint: <bead-id> [--foreman]
model: gpt-5.1-codex
capabilities:
  required:
    - tracker.show
    - tracker.set-status
    - tracker.close
    - tracker.comment
    - host.change-request-create
    - workflow.branch-create
  optional:
    - tracker.sync
---

# Ensemble Command: /ensemble:implement-bead

This Codex skill mirrors the Ensemble slash command `/ensemble:implement-bead`.
Follow the workflow below, adapt to the current repository, and keep outputs structured.

<!-- DO NOT EDIT - Generated from implement-bead.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Single-bead entry to the beads execution engine. It runs exactly one bead as a
one-bead track: the same tech-lead-orchestrator quality loop and Commit Gate
that /ensemble:beads-build uses for an epic; branching and the change request
go through the workflow.*/host.* toolchain capabilities (see Preflight) rather
than beads-build's own resolve-sdlc branching/PR_BACKEND policy. Use
/ensemble:beads-build for an epic or any multi-bead scope and
/ensemble:implement-trd-beads for a TRD.

Rules shared with the other engines: all bead reads/writes go through the tracker.*
toolchain capabilities (resolved via toolchain-cli; never a direct tracker-binary
invocation); never run `git add -A`, `git add .`, `git add .beads/` or `git commit -a`;
stage explicit paths only; `.beads/` is the tracker adapter's own state
(docs/guides/beads-tracked-export.md); the bead is closed only after its work is
committed.

## Workflow

### Phase 1: Preflight

**1. Arguments and Toolchain Preflight**

- BEAD_ID = first token of $ARGUMENTS (a bare integer is fine; the tracker adapter accepts it). If absent, ask the user for it.
- Resolve TOOLCHAIN_CLI (RELATIVE_PATH packages/development/lib/toolchain-cli.js) and TRD_CLI (RELATIVE_PATH packages/development/lib/trd-cli.js) with the tool-path-resolution skill (packages/development/skills/tool-path-resolution/SKILL.md). If either does not resolve, HALT with an error naming it.
- Run: node "$TOOLCHAIN_CLI" preflight --require tracker.show --require tracker.set-status --require tracker.close --require tracker.comment --require host.change-request-create --require workflow.branch-create --json [add --non-interactive when --foreman is present] and parse stdout as PREFLIGHT_RESULT. ok:false -> print PREFLIGHT_RESULT.error.message and HALT. Store RUN_ID = PREFLIGHT_RESULT.runId; every later toolchain-cli call in this invocation passes --run-id "$RUN_ID". tracker.sync is optional and not preflighted here (PR 8 independent review item 2 / finding 2: a server-side tracker, e.g. jira, azure-boards, has no local durable-flush step); its one call site (Commit Gate and Close) is skipped silently on {ok:false}, never HALTing.
- Run: node "$TOOLCHAIN_CLI" run tracker.show --run-id "$RUN_ID" --arg id=<BEAD_ID> --json. Non-ok -> print "ERROR: Bead <BEAD_ID> not found." and HALT. data.status == closed -> print "Bead <BEAD_ID> is already closed." and HALT. Store BEAD_TITLE, BEAD_DESCRIPTION, BEAD_TYPE and the bead labels from data.

**2. Branch and Working Tree**

- Run: git status --porcelain -- . ':(exclude).beads'. Non-empty -> print the paths and HALT (commit, stash or revert first).
- CURRENT_BRANCH=`git symbolic-ref --short HEAD` (detached -> HALT). DEFAULT_BRANCH = `git symbolic-ref --short refs/remotes/origin/HEAD` without the origin/ prefix, else main.
- If CURRENT_BRANCH == DEFAULT_BRANCH: BRANCH_NAME = bead/<BEAD_ID>-<kebab-case BEAD_TITLE, non-alphanumerics to hyphens>. If it already exists run git switch <BRANCH_NAME>. Otherwise run: node "$TOOLCHAIN_CLI" run workflow.branch-create --run-id "$RUN_ID" --arg name=<BRANCH_NAME> --arg baseBranch=<DEFAULT_BRANCH> --json [add --non-interactive when --foreman is present] (resolves to the configured workflow adapter -- git-town hack or a plain git checkout -b -- internally; ok:false -> print the error and HALT). Otherwise stay on CURRENT_BRANCH.

### Phase 2: Execute

**1. Run the Bead as a One-Bead Track**

- Before this command's first tracker write: run node "$TOOLCHAIN_CLI" confirm-status tracker.set-status --run-id "$RUN_ID" --json [add --non-interactive when --foreman is present] and parse as CONFIRM_STATUS. If CONFIRM_STATUS.data.required is true and CONFIRM_STATUS.data.confirmed is false: when --foreman is not present ask via AskUserQuestion "Allow the tracker adapter to write (status/comment/close) for this session? [yes/no]"; on yes run node "$TOOLCHAIN_CLI" confirm-record tracker.set-status --run-id "$RUN_ID" --json. Under --foreman, never prompt (non-interactive already passed; the CLI auto-confirms and logs). Run: node "$TOOLCHAIN_CLI" run tracker.set-status --run-id "$RUN_ID" --arg id=<BEAD_ID> --arg status=in_progress --json [add --non-interactive when --foreman is present]; then node "$TOOLCHAIN_CLI" run tracker.comment --run-id "$RUN_ID" --arg id=<BEAD_ID> --arg text="status:in_progress agent:implement-bead branch:<branch>" --json [add --non-interactive when --foreman is present].
- Context read (mandatory, BEFORE any specialist is dispatched): run `node "$TRD_CLI" bead-context --bead <BEAD_ID>` (this command has no TRD_PATH; the bead's `## References` block supplies it; a legacy bead without one needs `--trd <path>` and is blocked if none is known) and parse the JSON as BEAD_CONTEXT. `ok:false`: do NOT implement the bead; run `node "$TOOLCHAIN_CLI" run tracker.comment --run-id "$RUN_ID" --arg id=<BEAD_ID> --arg text="blocked:missing-references <missing joined by '; '>" --json [add --non-interactive when --foreman is present]` and `node "$TOOLCHAIN_CLI" run tracker.set-status --run-id "$RUN_ID" --arg id=<BEAD_ID> --arg status=open --json [add --non-interactive when --foreman is present]`, print the missing items and HALT. `ok:true`: run `node "$TOOLCHAIN_CLI" run tracker.comment --run-id "$RUN_ID" --arg id=<BEAD_ID> --arg text="context-read: trd=<references.trd> task=<references.trdTask> prd=<references.prd> reqs=<ids>" --json [add --non-interactive when --foreman is present]` as evidence.
- Dispatch Task(subagent_type=<tech-lead-orchestrator resolved by its namespaced identifier>, prompt=<track payload>) where the payload is the beads-build-wave track payload for a single bead: goal (implement the bead, run its tests), scope { ROOT_EPIC_ID: null, LABEL: first bead label or null, STRATEGY: tdd }, track_beads [<BEAD_ID>] with BEAD_TITLE and BEAD_DESCRIPTION, the `context_contract` (the bead-context command above; already executed for this bead), `bead_context` = the entire BEAD_CONTEXT JSON (the orchestrator MUST embed it plus "read the referenced files yourself before editing" in every specialist, architect, code-reviewer and test-runner prompt, and the code-reviewer MUST check the diff against the PRD ACs in it), the quality_loop (implement, test, code-reviewer, then advisor before QA; max 2 review rounds) and the pm_clarification_guard (max 3 rounds). The orchestrator routes to the right specialist; do not pick one by keyword here.
- If tests still fail after the orchestrator reports its attempts: print the failure details and HALT. Do not close the bead or create a PR.

**2. Commit Gate and Close**

- Run: git status --porcelain -- . ':(exclude).beads'. For each listed path run `git add -- <path>` (never -A, ., or .beads/) and commit with a conventional message ending in [bead:<BEAD_ID>] (feat: for features, fix: for bugs).
- Only after the tree is clean: run node "$TOOLCHAIN_CLI" run tracker.close --run-id "$RUN_ID" --arg id=<BEAD_ID> --json [add --non-interactive when --foreman is present]; then node "$TOOLCHAIN_CLI" run tracker.comment --run-id "$RUN_ID" --arg id=<BEAD_ID> --arg text="status:closed agent:implement-bead" --json [add --non-interactive when --foreman is present]; then node "$TOOLCHAIN_CLI" run tracker.sync --run-id "$RUN_ID" --json [add --non-interactive when --foreman is present] (optional capability; {ok:false} -> skip silently, never HALT -- a server-side tracker has no local flush step). If the bead has a label and the repo tracks the export, stage only that label's beads: node "$TRD_CLI" beads-stage --label <label>, then commit "chore: beads sync"; otherwise leave .beads/ unstaged.

### Phase 3: Pull Request

**1. Open the Change Request**

- Run: git push -u origin <branch>. PR title = BEAD_TITLE; body = Bead <BEAD_ID>, description, changes summary, test plan.
- Before this command's first host write: run node "$TOOLCHAIN_CLI" confirm-status host.change-request-create --run-id "$RUN_ID" --json [add --non-interactive when --foreman is present] and parse as CONFIRM_STATUS. If CONFIRM_STATUS.data.required is true and CONFIRM_STATUS.data.confirmed is false: when --foreman is not present ask via AskUserQuestion "Allow the host adapter to open a change request for this session? [yes/no]"; on yes run node "$TOOLCHAIN_CLI" confirm-record host.change-request-create --run-id "$RUN_ID" --json. Under --foreman, never prompt (non-interactive already passed; the CLI auto-confirms and logs).
- Run: node "$TOOLCHAIN_CLI" run host.change-request-create --run-id "$RUN_ID" --arg baseBranch=<base> --arg headBranch=<branch> --arg title="<BEAD_TITLE>" --arg description="<body>" --json [add --non-interactive when --foreman is present] and parse as CR_CREATE_RESULT. ok:true -> URL = CR_CREATE_RESULT.data.url. ok:false (for example no host adapter resolves, or the confirm gate denied it) -> print the push result and tell the user to open the change request themselves; URL = "manual".
- node "$TOOLCHAIN_CLI" run tracker.comment --run-id "$RUN_ID" --arg id=<BEAD_ID> --arg text="pr:<URL or manual>" --json [add --non-interactive when --foreman is present]; print "Bead <BEAD_ID> complete. PR: <URL> | Branch: <branch>".

## Expected Output

**Format:** Pull Request

**Structure:**
- **Git Branch**: Feature branch (bead/<ID>-<slug> when created from the default branch)
- **Code Changes**: Implementation of the bead with test coverage, committed by explicit pathspec
- **Closed Bead**: Bead closed with completion comments
- **Pull Request**: PR created via the configured host adapter (manual fallback when none resolves)

## Usage

```
/ensemble:implement-bead <bead-id> [--foreman]
```
