---
name: "ensemble:requirement-status"
description: "On-demand requirement satisfaction report — TRD checkbox rollups plus bead status and req-verified tokens"
version: "3.0.0"
category: "implementation"
last-updated: "2026-10-23"
capabilities-required: "tracker.list, tracker.comments"
argument-hint: "[trd-path-or-slug]"
model: "sonnet"
---
<!-- DO NOT EDIT - Generated from requirement-status.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Report each requirement as SATISFIED, IN_PROGRESS, PENDING or NOT_PLANNED, plus checkbox completion
by phase. Beads are optional; without them the TRD's `- [x]` checkboxes are the evidence.

## Workflow

### Phase 1: Status

**1. Resolve the TRD and toolchain-cli**
   $ARGUMENTS is a TRD path, or a slug to match under docs/TRD/ (filename stem, lowercased, hyphenated); if empty, list docs/TRD/*.md and ask.
Resolve TRD_CLI and TOOLCHAIN_CLI (RELATIVE_PATH packages/development/lib/trd-cli.js and packages/development/lib/toolchain-cli.js) per the tool-path-resolution skill (skills/tool-path-resolution/SKILL.md).
Run: node "$TOOLCHAIN_CLI" preflight --require tracker.list --require tracker.comments [add --non-interactive when FOREMAN_TASK_TITLE is set] --json; on a non-ok result print the error and HALT before calling either capability. This command has no side-effecting write and so never calls confirm-status/confirm-record.


**2. Gather optional bead evidence**
   If the tracker.list preflight succeeded: run `node "$TOOLCHAIN_CLI" run tracker.list --json` and merge the result for open, in_progress and closed (a list, or an object whose `.issues` is the list) into file ISSUES.
Per test bead and the epic (`[trd:<slug>]`) run `node "$TOOLCHAIN_CLI" run tracker.comments --arg id=<id> --json`; merge the arrays into file COMMENTS as `[{"beadId":"<id>","comments":["<text>",...]}]`.
Verdicts come from `status:closed ... verdict:passed` comments; `req-verified:`/`ac-proven:` tokens are read when present (nothing guarantees they were written, so do not claim ACs proven without them).
On any tracker capability failure warn and use checkboxes only.


**3. Run and report**
   Run `node "$TRD_CLI" req-status "$TRD_PATH" [--issues-json ISSUES --comments-json COMMENTS]`; on `{"error":...}` print it and stop.
Print `checklist` per phase, a REQ | title | status | tests | ACs proven (`acsProven`) | note table, `summary` counts, and the `evidence` level (`verdict-verified` or `closed-only`).


## Expected Output

**Format:** Checklist rollup, requirement table, summary counts

## Usage

```
/ensemble:requirement-status [trd-path-or-slug]
```
