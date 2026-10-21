---
name: ensemble-validate-requirements
description: Pre-implementation traceability gate — validates REQ-NNN coverage and TEST task pairing between PRD and TRD (Codex skill for /ensemble:validate-requirements)
user-invocable: true
argument-hint: '[prd-path] [trd-path]'
model: gpt-5.1-codex
---

# Ensemble Command: /ensemble:validate-requirements

This Codex skill mirrors the Ensemble slash command `/ensemble:validate-requirements`.
Follow the workflow below, adapt to the current repository, and keep outputs structured.

<!-- DO NOT EDIT - Generated from validate-requirements.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Run `node "$TRD_CLI" validate <trd-path> --prd <prd-path>` and report the JSON.
Tasks are checkbox lines `- [ ] **TRD-NNN**: Title` under `## Master Task List`
(heading-style ids are not tasks); PRD ids are `### REQ-NNN:` and `- AC-NNN-M:`.

## Workflow

### Phase 1: Validate

**1. Run the CLI**
   Require PRD path then TRD path, both existing; else print the usage or missing-file error and exit 1.
Resolve TRD_CLI per the tool-path-resolution skill (packages/development/lib/trd-cli.js).
Run `node "$TRD_CLI" validate "<trd>" --prd "<prd>"`; on `{"error":...}` print it and exit 1.


**2. Report**
   Print `stats`, `errors`, `warnings`, `passed` checks, and `skipped` checks (label SKIPPED, never PASSED).
If `ok` is false, print `VALIDATION_FAILED` to stderr and run `exit 1`; else exit 0.


## Expected Output

**Format:** Validation report; exit 0 without errors, 1 with errors

## Usage

```
/ensemble:validate-requirements [prd-path] [trd-path]
```
