---
name: "ensemble:analyze-requirements"
description: "Pre-implementation cross-artifact consistency sweep — checks PRD<->TRD alignment before coding begins"
version: "2.0.0"
category: "planning"
last-updated: "2026-10-20"
argument-hint: "[prd-path] [trd-path]"
model: "sonnet"
---
<!-- DO NOT EDIT - Generated from analyze-requirements.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Run `node "$TRD_CLI" analyze <trd-path> --prd <prd-path>`, interpret the JSON, and add a PRD-vs-TRD
contradiction scan. Task ids are checkbox lines `- [ ] **TRD-NNN**: Title` under `## Master Task List`
(not headings); PRD ids are `### REQ-NNN:` and `- AC-NNN-M:`.

## Workflow

### Phase 1: Analyze

**1. Run the CLI**
   Require PRD then TRD path, both existing; else print the error and exit 1.
Resolve TRD_CLI per the tool-path-resolution skill, run `node "$TRD_CLI" analyze "<trd>" --prd "<prd>"`;
on `{"error":...}` print it and exit 1.


**2. Contradiction scan**
   Read both documents for conflicts on one feature (sync vs async, differing limits, auth, SLAs); cite PRD and TRD lines.


**3. Report**
   Print `verdict` (count contradictions as warnings: errors -> NOT READY, >5 -> CAUTION, >0 -> MOSTLY READY, else READY),
`phases`, `dependencies`, `estimates.missing`, `traceability`, `prdWarnings`, and `validation` findings,
each with a one-line remediation.


## Expected Output

**Format:** Readiness report with verdict and findings

## Usage

```
/ensemble:analyze-requirements [prd-path] [trd-path]
```
