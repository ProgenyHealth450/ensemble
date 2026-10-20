---
name: "ensemble:verify-requirements"
description: "Post-implementation REQ->AC->code traceability verifier - chains PRD requirements through TRD tasks to code and tests and writes a proof report"
version: "2.0.0"
category: "planning"
last-updated: "2026-10-20"
argument-hint: "--trd <trd-path> [--prd <prd-path>] [--mode auto|beads|checkbox|both] [--report-path <path>] [--no-write-report] [--run-tests]"
model: "sonnet"
---
<!-- DO NOT EDIT - Generated from verify-requirements.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Chain REQ-NNN -> AC -> impl task -> -TEST task -> files -> commits -> test result via `node "$TRD_CLI" verify <trd-path> ...`.

## Workflow

### Phase 1: Verify

**1. Preflight**
   Require `--trd <path>`; node and git are required. Resolve TRD_CLI per the tool-path-resolution skill.
Default report: `docs/req-traceability/<trd-slug>-<YYYY-MM-DD>.md` under the git toplevel; `--no-write-report` suppresses it.


**2. Beads evidence (optional)**
   Only if `br` exists and `--mode` is not `checkbox`: for beads titled `[trd:<slug>:task:TRD-NNN]` (`br list --json`; a list or an object with `.issues`),
read `br comment list <id>` and write FILE mapping task id -> `{status, verdict, req_satisfied, acs_proven, qa_agent, commit_sha}`
from `status:closed qa:<agent> verdict:passed req-satisfied:<REQ> ac-proven:<ACs>` tokens. Warn and continue on failure.


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
