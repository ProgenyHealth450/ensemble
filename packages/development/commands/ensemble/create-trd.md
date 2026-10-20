---
name: "ensemble:create-trd"
description: "Create Technical Requirements Document from PRD with architecture design and adversarial review"
version: "3.4.0"
category: "planning"
last-updated: "2026-09-19"
argument-hint: "[prd-path] [--team] [--foundational] [--list] [--foreman]"
model: "opus"
---
<!-- DO NOT EDIT - Generated from create-trd.yaml -->
<!-- To modify this file, edit the YAML source and run: npm run generate -->


Create a TRD from a PRD: validate the PRD, design architecture with alternatives, break work into traceable tasks and PR boundaries, self-review with a Design Readiness Gate, run the Constitution Gate, and save to docs/TRD/. Team configuration is handled by /ensemble:configure-team.
Foreman subject contract (--foreman): FOREMAN_TASK_TITLE / FOREMAN_TASK_DESCRIPTION carry the dispatched task; when FOREMAN_TASK_TITLE is set, print it before writing anything and plan exactly that task. FOREMAN_SOURCE_PRD_PATH, when set, is the only PRD you may read (an input, not an output path). Confirm its subject matches FOREMAN_TASK_TITLE, else STOP and quote both subjects. If it is set but missing on disk, STOP and report the path. If neither a prd-path argument nor FOREMAN_SOURCE_PRD_PATH exists, STOP and report that no PRD was delivered. NEVER choose a PRD by recency, glob, or plausibility. Outside Foreman these variables are absent.

## Arguments

- **`foreman`** (boolean, optional, default: `false`): Foreman-native non-interactive mode: skip questions that only gather optional human preference. Auto-select the PRD for --list only when exactly one candidate exists (otherwise HALT with the candidate list), proceed past the CONCERNS-band (3.0-3.9) PRD readiness warning, and auto-pick Option C for the architecture. Hard FAIL gates (PRD readiness < 3.0, Design Readiness Gate FAIL, Constitution Gate failures) still HALT. Never implements; the command stops after producing the TRD. When --foreman is present and FOREMAN_ARTIFACT_PATH is set and non-empty, write the phase report to that exact path (creating parent directories) in addition to any repo-local report. Never invent or alter the path; an unset FOREMAN_ARTIFACT_PATH is not an error.

## Workflow

### Phase 1: PRD Ingestion and Validation

**1. Select PRD**
   Resolve the PRD from the argument, --list, or FOREMAN_SOURCE_PRD_PATH

- If FOREMAN_SOURCE_PRD_PATH is set it is THE PRD (overrides --list); apply the Foreman subject contract above.
- If --list: resolve PRD_CLI per the tool-path-resolution skill (packages/development/skills/tool-path-resolution/SKILL.md) for packages/development/lib/prd-cli.js, run `node "$PRD_CLI" list --type prd` and parse {ok,type,items}; on failure print the error and HALT. Show a table (ID/Name, Status, Score, Version, Last Modified) and ask the user to pick one via AskUserQuestion (id `prd_select`). Under --foreman see the parameter rules: one candidate auto-selects, otherwise print `ERROR: --list with --foreman requires an unambiguous PRD. Candidates: <list>. Pass a specific prd-path instead.` and HALT. Map the selected slug to docs/PRD/<file>.md; HALT if it does not exist.
- Read the PRD. With --foundational and no full PRD, accept a short capability brief, skip PRD-structure validation and the readiness gate, and register capabilities instead of REQ-NNN IDs.

**2. Requirements Validation**
   Check PRD completeness and the BDD scenario floor

- Unless --foundational with a brief: verify the PRD has Product Summary, User Analysis, Goals, Technical Requirements, Acceptance Criteria; REQ-NNN numbering is consistent; acceptance criteria are testable Given/When/Then with AC-NNN-M sub-items; constraints and non-goals are documented. Build the REQ registry for traceability.
- Flag any functional REQ-NNN with fewer than 3 AC-NNN-M sub-items (happy path, edge, error) as insufficient BDD coverage in the readiness scorecard.

**3. Implementation Readiness Gate Check**
   Check the PRD's own readiness gate and review history

- Read PRD frontmatter Readiness Score. >= 4.0 proceed; 3.0-3.9 (CONCERNS) warn and ask whether to proceed (--foreman: log and proceed); < 3.0 HALT and recommend /ensemble:refine-prd (even under --foreman); absent: proceed noting the PRD was not gate-checked.
- REFINE CHECK. refine-prd is the only command that writes a `## Changelog` (or `## Version History`) section into a PRD. If the PRD has none, or it has no entry, print `WARNING: <path> has no refine-prd changelog entry. This PRD has not been reviewed.` and ask via AskUserQuestion whether to run /ensemble:refine-prd first (recommended) or proceed. Advisory, not a HALT. --foreman: log and proceed.
- PRD-CHANGED CHECK. If a TRD already exists for this PRD (a docs/TRD file whose `prd_reference` resolves to this PRD path, or whose TRD_MICRO_UUID matches) and the PRD frontmatter `version` is higher than the version that TRD was built from, the correct action is to RE-CREATE the TRD from the current PRD, which is this command. It is NOT to run /ensemble:refine-trd on the existing one -- that refines the wrong document. Overwrite the existing TRD path rather than creating a second TRD for the same PRD.

### Phase 2: Architecture Design

**1. Domain Analysis**
   Map requirements to technical domains and detect companion artifact domains

- Map REQ-NNN requirements to technical domains, identify needed architectural patterns, and determine greenfield vs brownfield.
- Record COMPANION_DOMAINS: `data-model` when requirements change persistence (entities, schemas, tables, migrations, backfills, durable state); `research` when requirements need comparative technology/vendor/integration decisions that deserve independent review. Not for incidental data mentions, routine brownfield description, or an already-selected stack. Empty means no companion files are created.

**2. Capability Reuse Check**
   Reuse existing foundational work instead of duplicating it (dedup-by-reference)

- Resolve TRD_GRAPH_CLI per the tool-path-resolution skill for packages/development/lib/trd-graph-cli.js (HALT with an error if unresolved). Run `node "$TRD_GRAPH_CLI" capabilities docs/TRD --json` (an absent docs/TRD means an empty registry) and, for implicit matches, `node "$TRD_GRAPH_CLI" overlap docs/TRD`.
- If a foundational TRD already provides a needed capability, generate no duplicate tasks: add `[depends: <foundational-slug>#TRD-NNN]` (or `#PR-N`) on the dependent task and record it under `## Reused Capabilities` (capability -> foundational TRD label + document id). Reference by slug/document id only, never by label.
- If a capability is clearly reusable but no foundational TRD exists, recommend `/ensemble:create-trd <prd> --foundational`.

**3. Architecture Alternatives**
   Present architecture options for selection when the choice is genuinely open

- For a greenfield or ambiguous PRD, present 2-3 options (simplest; most scalable; best fit for the existing codebase or balanced) with pros, cons, complexity and risk, and ask the user to choose or combine. If the PRD or codebase already dictates the approach, state it and skip the options.
- --foreman: auto-select Option C (best fit / balanced) and print `Foreman mode: auto-selected Option C (<summary>)`.

**4. System Architecture Design**
   Design the chosen approach

- Define component boundaries, data flow, integration points, and technology choices with rationale; describe the component relationships.
- If the PRD touches auth, PII, payments, file upload, external network exposure or new third-party integrations, invoke the `threat-model` skill and add its `## Threat Model` section.

### Phase 3: Task Breakdown and Planning

**1. Master Task List Generation**
   Generate task list with TRD-NNN IDs and traceability annotations

- Generate sequential TRD-NNN IDs.
- Every task line MUST begin with a GitHub checkbox -- `- [ ] ` (or `- [x] ` if already complete) -- immediately before **TRD-NNN**; without it trd-cli.js and implement-trd-beads create zero task beads.
- Each task includes: description, hour estimate (Nh), [satisfies REQ-NNN] annotation (use [satisfies INFRA] or [satisfies ARCH] when there is no direct REQ), a `Validates PRD ACs:` field listing the AC-NNN-M items covered, and an `Implementation AC:` checklist of Given/When/Then items.

**2. Test Task Generation (BDD)**
   Generate a paired BDD/Reqnroll test task for every user-facing implementation task

- For every user-facing TRD-NNN task generate a TRD-NNN-TEST task. Every TRD-NNN-TEST line MUST begin with the same checkbox-prefix requirement as implementation tasks -- `- [ ] ` (or `- [x] ` if already complete) -- immediately before **TRD-NNN-TEST**. implement-trd-beads routes any task whose id matches `-TEST` through the reqnroll BDD path.
- Test tasks carry `[verifies TRD-NNN] [satisfies REQ-NNN] [depends: TRD-NNN]` annotations and a `Validates PRD ACs: AC-NNN-M, ...` field.
- Under each test task add a `Test AC:` checklist with one single-line `- [ ] Scenario: <title> -- Given <...>, When <...>, Then <...>` item per AC-NNN-M in its Validates PRD ACs, indented strictly deeper than the `Test AC:` label (items at the same or shallower indent are silently dropped by the parser). This is the only place scenario text goes; no separate `## Scenarios` heading. Because each functional REQ has >=3 ACs, each test task carries >=3 scenario items.
- implement-trd-beads later scaffolds these as .feature files via reqnroll-cli and delegates reqnroll-binding-specialist (see packages/reqnroll/skills/reqnroll/SKILL.md); this command only specifies titles and Given/When/Then text.

**3. Dependency Mapping and PR Boundary Design**
   Organize tasks into shippable PR stack boundaries based on dependency order

- Add [depends: TRD-NNN] annotations, keep the graph acyclic, and flag 8h+ tasks for breakdown.
- Group tasks under `### PR N:` headings (not Phase/Sprint) -- each a shippable vertical slice that is independently reviewable, passes its tests in isolation, and leaves no user-visible route returning 404/500 because of later PRs.
- Immediately after each `### PR N:` heading write a `**Shippable State:**` line: one sentence describing the user-observable capability after the PR merges. Infrastructure-only statements ('scaffolding complete') are not acceptable. This section is machine-parsed by implement-trd-beads to create stacked PRs.

### Phase 4: Adversarial Review and Design Gate

**1. Architecture Self-Critique**
   Find real architecture gaps

- Look for components that must communicate but lack an interface or protocol/data format, missing error/failure-recovery paths, and decisions without rationale. Record issues found with resolutions and fix them in the draft; if there are none, say so.

**2. Task Coverage Analysis**
   Verify PRD requirement coverage and PR shippability

- Check every PRD REQ-NNN has a task with [satisfies REQ-NNN] and a test task, that no task cites a nonexistent REQ-NNN, and every `### PR N:` has a meaningful `**Shippable State:**`.
- Resolve TRD_CLI per the tool-path-resolution skill (packages/development/skills/tool-path-resolution/SKILL.md) for packages/development/lib/trd-cli.js. If none of the 4 tiers resolve OR `which node` fails: print "ERROR: Node.js and the TRD CLI (lib/trd-cli.js) are required. Ensure Node.js is installed and the ensemble-development or ensemble-pi plugin bundle is present." and HALT.
- Write the draft Master Task List to a scratch file (session scratchpad, NOT docs/TRD/) and run: node "$TRD_CLI" parse <scratch-path>. Parse {ok, trd:{tasksById, warnings}}.
- If ok is false, tasksById is missing an intended task, or warnings contains 'No tasks found in the TRD', report a Task Coverage issue naming the offending lines (a missing checkbox prefix) before presenting the Design Readiness score.

**3. Dependency and Estimate Review**
   Check dependency risks and estimate confidence

- Check for dependency chains deeper than 3, circular or implicit dependencies, inconsistent or optimistic estimates; report real issues with resolutions.

**4. Testability Review**
   Verify acceptance criteria can be objectively verified

- Check Implementation ACs have specific pass/fail criteria (no unmeasured 'fast', 'good'), and that every TRD-NNN-TEST `Test AC:` has one `- [ ] Scenario:` item per AC-NNN-M in its Validates PRD ACs with none unlinked.

**5. Design Readiness Gate**
   Score the TRD and determine readiness

- Score 1-5: architecture completeness, task coverage (REQ -> implementation + test tasks), dependency clarity, estimate confidence. Overall = average. Present the Design Readiness Scorecard.
- PASS (4.0+): continue. CONCERNS (3.0-3.9): list concerns and ask whether to proceed or loop back (--foreman: log and proceed). FAIL (<3.0): fix the weakest dimensions before output (unaffected by --foreman).

### Phase 5: Constitution Gate

**1. Constitution Gate**
   Pre-save check against the project constitution

- Before writing anything, check the in-memory draft against docs/standards/constitution.md (fall back to .specify/memory/constitution.md; if neither exists HALT with CONSTITUTION_CONFIG_ERROR). On a violation HALT in every mode, including --foreman: list each failing article id, the failing draft section, the finding, and a remediation hint; do not create docs/TRD/, save the TRD, or print a next step. Under --foreman also write the failure report to FOREMAN_ARTIFACT_PATH. On pass, record `Constitution compliance: passed` in the TRD frontmatter.

### Phase 6: Output Management

**1. TRD Document Generation**
   Generate the TRD with frontmatter and structured sections

- Derive the TRD document micro UUID from the source PRD so the artifacts share one 8-hex correlation id: parse PRD-YYYY-<micro_uuid> from the PRD filename or frontmatter Document ID and set TRD_MICRO_UUID to it. Only if the PRD has a legacy sequence id or none, generate a new 8-hex micro UUID. Do NOT scan for highest TRD sequence number or increment NNN.
- Label: take the PRD's `label: prd-<stem>` (or derive from its title) and set TRD_LABEL = trd-<stem>. Display-only; never a reference key.
- Frontmatter: Document ID (TRD-YYYY-<TRD_MICRO_UUID>), Label, `prd_reference`, version 1.0.0, status Draft, date, Design Readiness Score, kind (default `trd`), and Constitution compliance: passed.
- The PRD reference is emitted as the frontmatter key `prd_reference`, spelled exactly that way, and its VALUE IS THE PRD'S FILE PATH -- `prd_reference: docs/PRD/PRD-YYYY-<micro_uuid>-<slug>.md`. It is not the PRD's document id. `trd-parser.js` resolves this key through `looksLikePath()`, which accepts a value only when it contains `/` or ends in `.md`; an id value is silently discarded and the TRD reads as having no PRD, with no error. Emit the path.
- --foundational: set `kind: foundational`, make the PRD reference optional, and add a `capabilities:` frontmatter list of machine-matchable capability tokens this TRD provides (e.g. order-domain) for other TRDs' Capability Reuse Check.
- Sections: Architecture Decision (chosen approach and alternatives), System Architecture, Master Task List (TRD-NNN and TRD-NNN-TEST tasks under `### PR N:` headings, each followed by its **Shippable State:** line), optional informational `## Sprint Planning` (not parsed by implement-trd-beads), Quality Requirements, Design Readiness Scorecard.
- File: docs/TRD/TRD-YYYY-<TRD_MICRO_UUID>-<slug>.md (no sequence number).
- Companion artifacts, only for domains in COMPANION_DOMAINS: write `<trd-stem>-data-model.md` and/or `<trd-stem>-research.md` beside the TRD (same TRD_MICRO_UUID and slug; reruns overwrite the same paths; never create placeholder files for undetected domains). Each notes `Generated by /ensemble:create-trd`, the source TRD/PRD ids, a back-link to the TRD and the relevant REQ/AC refs; use `[NEEDS CLARIFICATION: <missing detail and source REQ/AC>]` instead of inventing detail. data-model covers entities, relationships, ownership, migration/backfill, validation, privacy/security, open questions; research covers decision context, options, criteria, recommendation, tradeoffs, rejected alternatives and must not contradict the TRD's Architecture Decision. Link only existing companions from a `## Companion Artifacts` section.

**2. Acceptance Criteria Traceability**
   Generate and validate the traceability matrix

- Unless --foundational with a brief: add `## Acceptance Criteria Traceability` with columns | REQ-NNN | Description | Implementation Tasks | Test Tasks |, covering every Must/Should requirement.
- Warn (do NOT halt) for any REQ with no task coverage or any [satisfies] referencing a REQ missing from the PRD, then print 'Traceability check: N requirements covered, M uncovered, K orphaned annotations'.

**3. File Save and Next Steps**
   Save the TRD and suggest the follow-up

- Save the TRD and companions only after the Constitution Gate passes. Print the file path, task count, design readiness score, TRD_MICRO_UUID, and `Companion artifacts generated:` with each path (or exactly `No companion artifacts generated.`).
- --foreman with FOREMAN_ARTIFACT_PATH set: the phase report lists the TRD path and every companion path (or `No companion artifacts generated.`).
- Suggest: '/ensemble:refine-trd docs/TRD/TRD-YYYY-<TRD_MICRO_UUID>-slug.md' only after constitution compliance passes. This is the ONLY next step printed: a fresh TRD has not been reviewed, and refine-trd is the review.
- Do NOT print /ensemble:implement-trd-beads, /ensemble:implement-trd or /ensemble:configure-team as a next step; implementation is offered by refine-trd's closing go/no-go.
- If --team was passed, run /ensemble:configure-team on the saved TRD path after the save.

## Expected Output

**Format:** Technical Requirements Document (TRD)

**Structure:**
- **Architecture Decision**: Chosen approach with alternatives, rationale, tradeoffs
- **Master Task List**: TRD-NNN tasks with [satisfies REQ-NNN], Validates PRD ACs, Implementation AC checklists, and paired TRD-NNN-TEST tasks
- **System Architecture**: Components, data flow, integration points, technology choices
- **Acceptance Criteria Traceability**: Matrix linking REQ-NNN to implementation and test tasks
- **Quality Requirements**: Security, performance, accessibility, testing standards
- **Design Readiness Scorecard**: Scores for architecture completeness, task coverage, dependency clarity, estimate confidence

## Usage

```
/ensemble:create-trd [prd-path] [--team] [--foundational] [--list] [--foreman]
```
