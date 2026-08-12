---
document_id: TRD-2026-7e107138
label: trd-create-trd-checkbox-syntax
kind: trd
prd_reference: PRD-2026-7e107138 (docs/PRD/PRD-2026-7e107138-create-trd-checkbox-syntax.md v1.0.0)
version: 1.0.0
status: Draft
date: 2026-08-12
design_readiness_score: 4.75
ensemble_implement_trd_beads:
  branch_name: feature/trd-2026-7e107138-create-trd-checkbox-syntax
  use_proposed: true
  stacked_prs: false
---

# TRD-2026-7e107138: Explicit Checkbox Syntax in create-trd's Master Task List Generation

**Source PRD:** `docs/PRD/PRD-2026-7e107138-create-trd-checkbox-syntax.md` (v1.0.0, readiness 4.75 PASS)
**Source bead:** `br-ix4`

## Reused Capabilities

None declared. `trd-graph-cli capabilities docs/TRD --json` returns an empty registry — no
foundational TRDs exist in this repository to depend on by reference. This TRD deliberately
introduces **zero new library code** — see §1.1 — so there is nothing new to register as a
foundational capability either.

## 1. Architecture Decision

### 1.1 Chosen approach — Option A: instruction-text fix that reuses `trd-cli.js` unchanged

The defect is a gap in prose instructions, not in code — `trd-parser.js`'s `TASK_LINE_RE` is
correct and stable (PRD non-goal). The fix is therefore entirely inside
`packages/development/commands/create-trd.yaml`:

1. Add an unconditional action to the **Master Task List Generation** step (Task Breakdown and
   Planning phase) and the **Test Task Generation** step stating the required `- [ ] ` /
   `- [x] ` prefix, immediately before `**TRD-NNN**` / `**TRD-NNN-TEST**`.
2. Add one action to the existing **Task Coverage Analysis** step (Adversarial Review and Design
   Gate phase) that self-checks the draft Master Task List by running the *existing*
   `trd-cli.js parse` subcommand against it, before the Design Readiness Gate score is presented.

No new module, no new regex, no new dependency. `trd-cli.js parse` already runs
`trd-parser.js`'s `TASK_LINE_RE` internally and returns `{ tasksById, warnings }` — exactly the
check this bug needs — so the self-check calls the real parser instead of re-deriving its pattern
in prose. That also closes the drift path this bug came from: if `TASK_LINE_RE` ever changes
shape, the self-check picks it up automatically on its next run, because it invokes the live code,
not a copy of it.

**Precedent for the self-check's shape:** `create-trd.yaml`'s own "Capability Reuse Check" step
already instructs the agent to run a `node` CLI and parse its JSON output
(`node "$TRD_GRAPH_CLI" capabilities docs/TRD --json`), and `create-workstream-trd.yaml` /
`implement-trd-beads.yaml` both use the identical `Resolve TRD_CLI to first existing path among:
${CLAUDE_PLUGIN_ROOT}/lib/trd-cli.js, packages/development/lib/trd-cli.js` line before calling it.
TRD-003 copies that exact resolution line rather than inventing new wording, so the pattern reads
identically everywhere it appears in this codebase.

### 1.2 Alternatives considered

**Option B — extract a standalone `trd-authoring-lint.js` module**, called directly (not via a
prose-invoked CLI) by both `create-trd`'s self-check and a future `npm run validate` pass over
committed TRDs. More robust in the abstract (a real function call instead of an LLM-followed
instruction to run one), but it would duplicate `trd-cli.js parse`'s existing job — the CLI
already returns `tasksById`/`warnings` in one call, and there is no second caller today that
needs a programmatic (non-CLI) entry point. Rejected: adds a module for a capability that already
exists one layer down.

**Option C — retroactively re-lint every existing `docs/TRD/*.md` file for the same defect in
this PR.** Rejected as scope creep, and excluded by the PRD's stated non-goals — those TRDs are
either already implemented (tasks marked `[x]`, already scaffolded into beads under whatever they
originally parsed to) or historical. Re-scanning them fixes nothing live and risks rewriting
completed history for no behavioral change.

### 1.3 The one sequencing detail that matters

`Task Coverage Analysis` runs in Phase 5 (Adversarial Review and Design Gate) — **before** Phase 6's
`TRD Document Generation` / `File Save`. At that point the Master Task List exists only in the
agent's working context, not yet as a file on disk, but `trd-cli.js parse` requires a file path.

**Resolution:** TRD-003's new action instructs the agent to write the *current draft* Master Task
List to a scratch file (this session's scratchpad, not `docs/TRD/`) purely to run the check, then
continue to Phase 6's real generation/save using the (corrected, if the check flagged anything)
content. This is not a second "save" — the scratch file is disposable and never referenced again
once Phase 6 writes the real artifact. Making this explicit in the instruction text avoids an
agent confusing the scratch write with the final save, or skipping the check because no real file
exists yet.

## 2. System Architecture

### 2.1 Components

| Component | Status | Responsibility |
|---|---|---|
| `packages/development/commands/create-trd.yaml` | modified | Master Task List Generation + Test Task Generation actions gain the checkbox instruction; Task Coverage Analysis gains the self-check action |
| `packages/development/commands/ensemble/create-trd.md` | regenerated | `npm run generate` output for the above |
| `packages/development/lib/trd-cli.js` | **unchanged**, reused | Its existing `parse` subcommand is what the self-check calls |
| `packages/development/lib/trd-parser.js` | **unchanged**, reused transitively | `TASK_LINE_RE` — the pattern the whole bug is about — is never touched |
| `packages/development/tests/create-trd-command.test.js` | modified | New `toContain` assertions for the two instruction edits, matching this file's existing convention (see the TRD-micro-UUID test already there) |
| `packages/development/tests/trd-cli.test.js` | modified | Fixture round-trip locking in the exact contract (`tasksById`/`warnings`) the new self-check instruction relies on |

### 2.2 Data flow

```
create-trd.yaml (agent-followed prose)
  Phase 3 "Master Task List Generation" / "Test Task Generation"
    → agent writes task lines with "- [ ] **TRD-NNN** ..." per the new instruction   [REQ-001]

  Phase 5 "Task Coverage Analysis" (before the Design Readiness Gate)
    → agent writes the current draft Master Task List to a scratch file
    → node "$TRD_CLI" parse <scratch-path>          (trd-cli.js → trd-parser.js :: TASK_LINE_RE)
    → { tasksById, warnings } inspected; any gap reported as a coverage issue               [REQ-002]

  Phase 6 "TRD Document Generation" / "File Save"
    → real docs/TRD/<TRD_MICRO_UUID>-<slug>.md written (unchanged mechanism)
```

**Integration point.** The self-check's only interface to existing code is the same one
`implement-trd-beads.yaml` already uses in production: `node "$TRD_CLI" parse <path>` → one JSON
object on stdout, `{tasksById, warnings}` (or `{error}`). No new interface is introduced.

**Failure protocol.** If `trd-cli.js parse` itself errors (`{error: ...}` — e.g. Node not on
PATH), the instruction directs the agent to report it as a coverage issue rather than silently
skip the check — a check that can silently no-op is exactly the shape of the original bug.

**Technology choices.** None — no new dependency, no new file. This is a documentation-in-code
(YAML instruction) change plus test coverage.

### 2.3 Deliberate limitation

The self-check only runs when the agent authoring a TRD actually follows the instruction — it is
still prose, not enforced by a build gate the way `npm run validate` enforces frontmatter
correctness in the frontmatter-escaping PRD. Accepted: unlike that PRD's YAML-parseability defect,
this defect is only reachable through the `create-trd` authoring flow itself, so the gate belongs
inside that flow's own self-review step (which is exactly where every other create-trd quality
check already lives), not in a separate CI job with nothing to scan until a TRD is saved.

## Master Task List

### PR 1: Explicit checkbox instruction and a self-check gate in create-trd

**Shippable State:** Running `/ensemble:create-trd` without an MCP workflow server now yields an
explicit, unconditional instruction to prefix every task line with `- [ ] `, and any task line
that would still fail `trd-cli.js parse` is flagged and reported to the user before the TRD's
Design Readiness Gate score is shown — instead of silently producing a TRD that scaffolds to zero
task beads downstream.

- [ ] **TRD-001** Add the unconditional checkbox-prefix instruction to the Master Task List Generation action list (0.25h) `[satisfies REQ-001]`
  - Validates PRD ACs: AC-001-1
  - Implementation AC: Given `create-trd.yaml`'s "Master Task List Generation" step, when read, then it contains an action stating every task line must begin with `- [ ] ` (or `- [x] ` for a task already complete) immediately before `**TRD-NNN**`, worded as an unconditional action — not inside the "MCP Enhancement (Optional)" phase.
  - Implementation AC: Given the same action, when read, then it states the consequence of omitting the prefix (invisible to `trd-cli.js`/`implement-trd-beads`, which creates zero task beads).

- [ ] **TRD-002** Add the matching instruction to the Test Task Generation action list for `TRD-NNN-TEST` lines (0.25h) `[satisfies REQ-001] [depends: TRD-001]`
  - Validates PRD ACs: AC-001-1
  - Implementation AC: Given `create-trd.yaml`'s "Test Task Generation" step, when read, then its actions state `TRD-NNN-TEST` lines require the identical `- [ ] ` / `- [x] ` prefix as implementation tasks.

- [ ] **TRD-003** Add a self-check action to Task Coverage Analysis that runs the existing `trd-cli.js parse` subcommand against the draft Master Task List before the Design Readiness Gate (0.75h) `[satisfies REQ-002] [depends: TRD-001, TRD-002]`
  - Validates PRD ACs: AC-002-1, AC-002-2
  - Implementation AC: Given the "Task Coverage Analysis" step, when read, then its actions include: resolve `TRD_CLI` to the first existing path among `${CLAUDE_PLUGIN_ROOT}/lib/trd-cli.js`, `packages/development/lib/trd-cli.js` (same line used in `create-workstream-trd.yaml`); write the current draft Master Task List to a scratch file (not `docs/TRD/`); run `node "$TRD_CLI" parse <scratch-path>`; and if `tasksById` omits a task the draft intends, or `warnings` contains `'No tasks found in the TRD'`, report it as a Task Coverage issue naming the offending line — before the Design Readiness Gate score is presented.
  - Implementation AC: Given a well-formed draft where every task line already carries the checkbox prefix, when the same check runs, then it reports zero issues and does not block the gate.

- [ ] **TRD-004** Regenerate `packages/development/commands/ensemble/create-trd.md` via `npm run generate` (0.25h) `[satisfies INFRA] [depends: TRD-001, TRD-002, TRD-003]`
  - Implementation AC: Given the edited `create-trd.yaml`, when `npm run generate` runs, then `create-trd.md` reflects the three new/edited instructions verbatim.

- [ ] **TRD-001-TEST** Assert the Master Task List Generation instruction is present, unconditional, and outside the MCP-gated phase (0.25h) `[verifies TRD-001] [satisfies REQ-001] [depends: TRD-001]`
  - Validates PRD ACs: AC-001-1
  - Implementation AC: Given `create-trd.yaml`'s raw text, when scanned, then it contains the literal `- [ ] ` checkbox instruction inside the "Master Task List Generation" step's actions, and that occurrence's surrounding phase is NOT "MCP Enhancement (Optional)".

- [ ] **TRD-002-TEST** Assert the Test Task Generation instruction is present (0.25h) `[verifies TRD-002] [satisfies REQ-001] [depends: TRD-002]`
  - Validates PRD ACs: AC-001-1
  - Implementation AC: Given `create-trd.yaml`'s raw text, when scanned, then the "Test Task Generation" step's actions contain the same checkbox-prefix requirement for `TRD-NNN-TEST` lines.

- [ ] **TRD-003-TEST** Assert the self-check instruction is present, and lock in the parser contract it relies on with a fixture round-trip (0.5h) `[verifies TRD-003] [satisfies REQ-002] [depends: TRD-003]`
  - Validates PRD ACs: AC-002-1, AC-002-2
  - Implementation AC: Given `create-trd.yaml`'s raw text, when scanned, then the "Task Coverage Analysis" step's actions contain the `TRD_CLI` resolution line and a `node "$TRD_CLI" parse` invocation.
  - Implementation AC: Given two fixture TRD strings — one task line missing `- [ ] `, one with it — when each is passed to `trd-cli.js`'s exported `runParse`, then the first yields an empty `tasksById` with the `'No tasks found in the TRD'` warning, and the second yields a populated `tasksById` with no such warning.

- [ ] **TRD-004-TEST** Verify regeneration is clean and the repo-wide validate gate stays green (0.25h) `[verifies TRD-004] [satisfies INFRA] [depends: TRD-004]`
  - Implementation AC: Given the PR head, when `npm run generate` is re-run, then `git status` reports no changes to `create-trd.md`.
  - Implementation AC: Given the PR head, when `npm run validate` runs, then it exits zero.

**Total: 8 tasks (4 implementation, 4 test), 2.75h.** No task exceeds 1h; none is an 8h+
breakdown candidate.

## 3. Sprint Planning

*Informational grouping only — not parsed by `implement-trd-beads`.*

### Sprint 1 (single sprint, half day)

The whole fix is one PR and fits in under three hours of estimated work.

- **Session 1** — TRD-001 → TRD-004 and their paired tests, in dependency order. PR 1 complete.

## 4. Acceptance Criteria Traceability

| REQ-NNN | Description | Priority | Implementation Tasks | Test Tasks |
|---|---|---|---|---|
| REQ-001 | Explicit, unconditional checkbox instruction | Must | TRD-001, TRD-002 | TRD-001-TEST, TRD-002-TEST |
| REQ-002 | Self-check flags non-parseable task lines before save | Should | TRD-003 | TRD-003-TEST |

**Traceability check: 2 requirements covered, 0 uncovered, 0 orphaned annotations.**
`TRD-004`/`TRD-004-TEST` use `[satisfies INFRA]` (regeneration has no direct REQ, per the
Master Task List Generation convention for infrastructure tasks) — not an orphan.

## 5. Quality Requirements

- **Testing.** Jest, matching this package's existing convention. `create-trd-command.test.js`
  already asserts `toContain`/`not.toContain` over `create-trd.yaml`'s raw text for other
  instruction requirements (e.g. the TRD micro-UUID rule) — TRD-001-TEST/TRD-002-TEST/TRD-003-TEST
  extend the same file with the same style. TRD-003-TEST's fixture round-trip belongs in
  `trd-cli.test.js`, alongside that file's existing `runParse` coverage.
- **Security.** No new dependency, no new file I/O path beyond the scratch write TRD-003
  describes (session-scoped, never committed). No change to `trd-parser.js`'s parsing surface.
- **Performance.** One extra `node` subprocess invocation per `create-trd` run, on an already-tiny
  TRD draft. Immaterial.
- **Compatibility.** No change to `trd-cli.js`'s CLI contract or `trd-parser.js`'s regex — every
  existing caller (`implement-trd-beads.yaml`, `create-workstream-trd.yaml`) is unaffected.
- **Style.** Conventional commits, `fix(create-trd):` / `test(create-trd):` scopes.

## 6. Adversarial Review Findings

### 6.1 Architecture

1. **The self-check needs a file, but nothing is saved yet at that point in the workflow.**
   *Resolution:* §1.3 — write a disposable scratch file solely to run the check; the real save
   still happens in Phase 6, unchanged.
2. **A prose-followed self-check can be skipped by the same class of failure it's meant to
   catch** (an agent not literally executing "Run: node ..."). *Resolution:* TRD-003 copies the
   exact `Resolve TRD_CLI to first existing path among: ...` / `Run: node "$TRD_CLI" ...` wording
   already proven to be followed elsewhere in this same file (Capability Reuse Check), rather than
   inventing new phrasing — consistency, not novelty, is the mitigation available here.
3. **`trd-cli.js parse` erroring outright (e.g. Node unavailable) must not silently pass the
   gate.** *Resolution:* TRD-003's AC requires treating a `{error}` response as a reportable
   coverage issue, not a skip.

### 6.2 Coverage

1. **Is a source-text `toContain` assertion a sufficient test for an instruction change, or does
   it need a live agent-behavior test?** *Resolution:* this repository's own convention already
   answers this — `create-trd-command.test.js`'s existing TRD-micro-UUID test asserts on
   `create-trd.yaml`'s raw text for exactly this class of requirement (an authoring instruction,
   not executable logic). No new testing pattern is introduced.
2. **REQ-002's self-check could go stale if `TASK_LINE_RE`'s shape changes without this
   instruction changing.** *Resolution:* it can't, by construction — TRD-003 calls
   `trd-cli.js parse` (which calls the live `trd-parser.js`) rather than re-deriving the pattern
   in prose, so any future change to `TASK_LINE_RE` is picked up automatically the next time the
   self-check runs.

### 6.3 Dependencies and estimates

1. **TRD-004 (regeneration) depends on all three instruction edits landing first.** If any edit
   were incomplete, the regenerated `.md` would encode the bug forward into the distributed
   artifact. *Resolution:* TRD-004 is explicitly last in the dependency chain, and TRD-004-TEST
   re-verifies via a clean `git status` plus a green `npm run validate`. Chain depth is 2
   (TRD-001 → TRD-003 → TRD-004); no circular dependencies exist.

### 6.4 Testability

Every Implementation AC above resolves to a `toContain`/`not.toContain` string assertion, a
`runParse` return-value assertion, or a process exit code. No subjective language ("clean",
"correct", "clear") appears unqualified.

## 7. Design Readiness Scorecard

| Dimension | Score | Notes |
|---|---|---|
| Architecture completeness | 5.0 | Both instruction edits and the self-check's interface, sequencing, and failure protocol are fully specified; zero new components. |
| Task coverage | 4.5 | Both REQs have implementation and test tasks; the sequencing hazard (§1.3) is resolved inside TRD-003 rather than needing a separate task. |
| Dependency clarity | 5.0 | A single depth-2 chain, explicit and acyclic. |
| Estimate confidence | 4.5 | Uniform 0.25–0.75h tasks; the only softer estimate is TRD-003's wording work, still bounded well under 1h. |
| **Overall** | **4.75** | **PASS** |

## 8. Next Steps

```
/ensemble:implement-trd-beads docs/TRD/TRD-2026-7e107138-create-trd-checkbox-syntax.md
```

`/ensemble:configure-team` is not warranted — 8 tasks of single-file instruction-and-test work
does not need a multi-role team configuration.
