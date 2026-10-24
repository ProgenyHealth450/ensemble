---
name: ensemble-verify-requirements
description: Post-implementation REQ->AC->code traceability verifier - chains PRD requirements through TRD tasks to code and tests and writes a proof report (Codex skill for /ensemble:verify-requirements)
user-invocable: true
argument-hint: '--trd <trd-path> [--prd <prd-path>] [--mode auto|beads|checkbox|both] [--report-path <path>] [--no-write-report] [--run-tests]'
model: gpt-5.1-codex
capabilities:
  optional:
    - tracker.list
    - tracker.comments
---

# Ensemble Command: /ensemble:verify-requirements

This Codex skill mirrors the Ensemble slash command `/ensemble:verify-requirements`.
Follow the workflow below, adapt to the current repository, and keep outputs structured.

<!-- DO NOT EDIT - Generated from verify-requirements.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Chain REQ-NNN -> AC -> impl task -> -TEST task -> files -> commits -> test result via `node "$TRD_CLI" verify <trd-path> ...`.

## Workflow

### Phase 1: Verify

**1. Preflight**
   Require `--trd <path>`; node and git are required. Resolve TRD_CLI and TOOLCHAIN_CLI (RELATIVE_PATH packages/development/lib/trd-cli.js and packages/development/lib/toolchain-cli.js) per the tool-path-resolution skill.
Default report: `docs/req-traceability/<trd-slug>-<YYYY-MM-DD>.md` under the git toplevel; `--no-write-report` suppresses it.


**2. Beads evidence (optional)**
   Only if `--mode` is not `checkbox`: run `node "$TOOLCHAIN_CLI" run tracker.list --json`. `{ok:false}` (including UNAVAILABLE) -> print a warning and skip this step entirely (checkbox parsing only, no beads evidence) -- tracker.list/tracker.comments are both optional with exactly this fallback, so neither is preflighted with `--require`. `{ok:true}` -> for beads titled `[trd:<slug>:task:TRD-NNN]` (the issue list is `data` parsed as JSON if an array, else its `.issues`), per matching bead run `node "$TOOLCHAIN_CLI" run tracker.comments --arg id=<id> --json` and write FILE mapping task id -> `{status, verdict, req_satisfied, acs_proven, qa_agent, commit_sha}`
from `status:closed qa:<agent> verdict:passed req-satisfied:<REQ> ac-proven:<ACs>` tokens. A single bead's tracker.comments call failing warns and excludes only that task id from FILE; it does not abort the step.


**3. Run and report**
   Run `node "$TRD_CLI" verify "<trd>" [--prd P] [--mode M] [--beads-evidence FILE] [--run-tests] [--report-path R]`
(omit `--report-path` under `--no-write-report`); on `{"error":...}` print it and exit 1.
Print per-REQ lines (icon, impl -> test, files, commits, test result), `summary`, `verdict`, report path.


## Expected Output

**Format:** Console summary and markdown report

## Usage

```
/ensemble:verify-requirements --trd <trd-path> [--prd <prd-path>] [--mode auto|beads|checkbox|both] [--report-path <path>] [--no-write-report] [--run-tests]
```
