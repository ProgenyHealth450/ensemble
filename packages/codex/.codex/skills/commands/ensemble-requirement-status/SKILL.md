---
name: ensemble-requirement-status
description: On-demand requirement satisfaction report — TRD checkbox rollups plus bead status and req-verified tokens (Codex skill for /ensemble:requirement-status)
user-invocable: true
argument-hint: '[trd-path-or-slug]'
model: gpt-5.1-codex
---

# Ensemble Command: /ensemble:requirement-status

This Codex skill mirrors the Ensemble slash command `/ensemble:requirement-status`.
Follow the workflow below, adapt to the current repository, and keep outputs structured.

<!-- DO NOT EDIT - Generated from requirement-status.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Report each requirement as SATISFIED, IN_PROGRESS, PENDING or NOT_PLANNED, plus checkbox completion
by phase. Beads are optional; without them the TRD's `- [x]` checkboxes are the evidence.

## Workflow

### Phase 1: Status

**1. Resolve the TRD**
   $ARGUMENTS is a TRD path, or a slug to match under docs/TRD/ (filename stem, lowercased, hyphenated); if empty, list docs/TRD/*.md and ask.
Resolve TRD_CLI per the tool-path-resolution skill (packages/development/lib/trd-cli.js).


**2. Gather optional bead evidence**
   If `br` exists: merge `br list --json` for open, in_progress and closed (a list, or an object whose `.issues` is the list) into file ISSUES.
From `br comment list <epic-id>` (epic titled `[trd:<slug>]`) collect `req-verified:REQ-NNN` ids into VERIFIED (comma-separated).
On br failure warn and use checkboxes only.


**3. Run and report**
   Run `node "$TRD_CLI" req-status "$TRD_PATH" [--issues-json ISSUES --verified VERIFIED]`; on `{"error":...}` print it and stop.
Print `checklist` per phase, a REQ | title | status | tests | note table, and `summary` counts.


## Expected Output

**Format:** Checklist rollup, requirement table, summary counts

## Usage

```
/ensemble:requirement-status [trd-path-or-slug]
```
