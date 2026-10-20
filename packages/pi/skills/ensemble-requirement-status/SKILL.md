---
name: ensemble-requirement-status
description: >-
  Report each requirement as SATISFIED, IN_PROGRESS, PENDING or NOT_PLANNED,
  plus checkbox completion by phase. Beads are optional; without them the TRD's
  `- [x]` checkboxes are the evidence.
disable-model-invocation: true
---
<!-- Command: ensemble-requirement-status | Version: 2.0.0 -->
<!-- Description: On-demand requirement satisfaction report — TRD checkbox rollups plus bead status and req-verified tokens -->

# ensemble-requirement-status

> **Mission:** Report each requirement as SATISFIED, IN_PROGRESS, PENDING or NOT_PLANNED, plus checkbox completion by phase. Beads are optional; without them the TRD's `- [x]` checkboxes are the evidence.

> **Constraints:**
> - DO NOT implement or execute any work
> - Read-only; runnable any time
> - Status comes from `trd-cli req-status`; you only gather its optional bead inputs

## Phase 1: Status

### Step 1: Resolve the TRD

$ARGUMENTS is a TRD path, or a slug to match under docs/TRD/ (filename stem, lowercased, hyphenated); if empty, list docs/TRD/*.md and ask.
Resolve TRD_CLI per the tool-path-resolution skill (packages/development/lib/trd-cli.js).

### Step 2: Gather optional bead evidence

If `br` exists: merge `br list --json` for open, in_progress and closed (a list, or an object whose `.issues` is the list) into file ISSUES.
From `br comment list <epic-id>` (epic titled `[trd:<slug>]`) collect `req-verified:REQ-NNN` ids into VERIFIED (comma-separated).
On br failure warn and use checkboxes only.

### Step 3: Run and report

Run `node "$TRD_CLI" req-status "$TRD_PATH" [--issues-json ISSUES --verified VERIFIED]`; on `{"error":...}` print it and stop.
Print `checklist` per phase, a REQ | title | status | tests | note table, and `summary` counts.
