---
document_id: PRD-2026-8d825f54
label: prd-tool-abstraction-layer
version: 1.0.1
status: Locked
date: 2026-10-21
scale_depth: STANDARD
total_requirements: 25
readiness_score: 4.0
supersedes: PRD-2026-b6939c7c (Layer 2 only: REQ-007 through REQ-016)
---

# PRD-2026-8d825f54: Tool Abstraction Layer for Ensemble

## PRD Health Summary

- **Risk flags:** REQ-005, REQ-015, REQ-016, REQ-017, REQ-020, REQ-023
- **Dependencies:** 39 cross-requirement dependencies (see Dependency Map)
- **Constitution compliance:** passed
- **Open clarifications:** 0 `[NEEDS CLARIFICATION]` markers (all 12 resolved in v1.0.1)

## Product Summary

**Problem:** Ensemble commands, agents and skills invoke external tools directly: the source-control host CLI, the branching-workflow tool, the issue tracker and work-graph tool, local CI runners, review bots, test runners and others. Teams on a different stack (for example Azure DevOps for source control, or Jira instead of Beads for tracking) cannot use those commands without forking ensemble content, and forks drift from upstream.

**Who feels the pain:** end-user teams on non-default stacks; ensemble maintainers who would otherwise special-case every tool; third parties who want to add support for a tool; autonomous (Foreman) runs that need deterministic tool selection with no human to ask.

**Solution overview:** a tool abstraction layer in which commands and skills depend on *capabilities* (for example "open a change request", "list ready work") rather than on a specific tool. Each tool category has a versioned capability contract. An *adapter*, written as a provider skill, implements a category's contract for one tool. Users choose adapters by configuration. The layer ships with default adapters that reproduce today's behavior exactly, and with real alternative adapters (two trackers and one source-control host) to prove the swap.

**Success metric (confirmed):** a team switches tracker (default tracker to an alternative) or source-control host (default host to an alternative) by changing configuration only. No ensemble command or skill is edited, and no fork is created.

## Relationship to Other Documents

- **Supersedes** the toolchain-provider half ("Layer 2") of `PRD-2026-b6939c7c-config-driven-tools`: its REQ-007 through REQ-016 (axes, resolution chain, detection, ambiguity handling, confirmation gate, provider skills, provider-neutral prose, hardcoding lint, Beads-as-sole-execution-layer, axis scope gating). Where the two documents disagree, this PRD governs. REQ-017 through REQ-022 of that PRD mix both layers; decided: they are split by layer in a follow-up `/ensemble-refine-prd` pass on `PRD-2026-b6939c7c`, with their Layer 2 portions moved here.
- **Leaves untouched** its Layer 1 (tool-grants registry, REQ-001 through REQ-006). Tool grants remain a separate concern.
- **Amends** its decision that Beads remains the sole execution layer (REQ-015 there): see REQ-020 here.

## User Analysis

| Role | Pain today | What this PRD gives them |
|---|---|---|
| End-user team on a non-default stack | Commands assume one tracker, one host, one workflow tool. Only option is forking. | Choose tools in configuration; commands work unchanged. |
| Ensemble maintainer | Every command needs tool-specific prose and special cases. | Write against capabilities once; a lint stops tool names creeping back. |
| Third-party adapter author | No supported way to add a tool. | Documented contract, authoring guide and conformance check; ship an adapter without touching core. |
| Autonomous consumer (Foreman, `--foreman`) | Cannot ask which tool to use; wrong guess has external side effects. | Deterministic resolution, preflight before side effects, machine-readable failure record. |

## Goals and Non-Goals

**Goals**
- One capability model covering every external tool category ensemble uses.
- Adapters as editable skills; no rebuild needed to change a tool.
- Zero behavior change for projects that configure nothing.
- Proven alternative adapters in the first release: two trackers (Jira Cloud, Azure Boards) and one source-control host (Azure DevOps).

**Non-Goals**
- **Tool-grant registry (Layer 1)** of `PRD-2026-b6939c7c`. Unchanged.
- **Recovery, retries, scheduling.** Ensemble stays out of these (constitution Rule 4); Foreman owns them. This layer only reports state.
- **Alternative adapters for categories other than tracker and source-control host** in the first release. Those categories are registered with a default adapter only.
- **A hosted adapter registry or any network service.** Resolution is local.
- **Command integration for the worktree-manager category** in the first release (no command uses worktrees today).
- **Signed or verified third-party adapters.** Trust relies on installed-only adapters, the governed tool boundary and a declared command allowlist (REQ-023).

## Research Context

*Context only; requirements below do not depend on these tools by name.* A source inventory (commands, agents and skills, excluding generated copies) found direct tool coupling in these categories:

| Category | Tools invoked today | Source files (approx.) |
|---|---|---|
| Source-control host / change requests | plain git (45), GitHub CLI (13), Azure DevOps CLI (7) | 45 / 13 / 7 |
| Branching workflow | git-town (11+) | 11+ |
| Work tracking and work graph | Beads `br`/`bv` (20+), jira CLI (2+), Linear CLI (3+) | 20+ |
| Local CI | act (3+) | 3+ |
| Review automation | CodeRabbit (by name, via review state) | 3 |
| Lint automation | reviewdog | 4 |
| Test runners | jest/vitest, pytest, mix, dotnet, rspec | 23+ / 17+ / 11 / 14+ / 17+ |
| E2E and quality | playwright, lighthouse, axe | 29+ |
| Containers and deploy | docker, kubectl, helm, terraform, flyctl, cloud CLIs | 18 / 7 / 6 / 11 / 5 / 17+ |
| Package/build runners | npm/npx/pnpm/yarn, internal `trd-cli` | 47 / 19-23 |
| Worktree manager | worktrunk | **0** (not invoked) |

Heaviest coupling: `implement-trd-beads`, `beads-build`, `beads-build-wave`, `implement-bead`, `refine-beads`, `fix-issue`, `pr-merge`, the `git-town` skill and `pr-review-cycle`. The internal `trd-cli` (bead-context, beads-stage, scaffold-plan, phase-status, req-status) also calls the default tracker directly. Neither `config/toolchain.yaml` nor `config/tools.yaml` exists yet; `trd-cli resolve-sdlc` already resolves a branching strategy and a pull-request backend (`gh`, `ado`, `manual`).

Business integration points (by capability): hosting source code and change requests; tracking work items and their dependencies; running CI locally; automated code review gating; running tests; deploying and operating infrastructure. Obligation common to all: credentials come from the user's environment, never from ensemble content.

## Requirements

### Capability Model

### REQ-001: Capability taxonomy covering all tool categories
**Priority:** Must

Ensemble defines a taxonomy of tool categories covering every external tool its sources invoke: source-control host and change requests, branching workflow, worktree manager, work tracking, work graph and ready-work queue, local CI, review automation, lint automation, test runner, end-to-end and quality checks, container and deployment, infrastructure as code, platform and cloud, and package/build runner. The CI category covers only tools an agent invokes to run CI locally; hosted CI definitions are repository infrastructure and out of scope.

- AC-001-1: Given the tool inventory of shared command, agent and skill sources, when each tool is checked against the taxonomy, then every tool maps to exactly one category.
- AC-001-2: Given a shared source that invokes a tool belonging to no category, when validation runs, then it fails and names the file and the unmapped tool.

### REQ-002: Capability contract per category
**Priority:** Must

Each category has a contract listing its named capabilities (for example "create change request", "list ready work"). For each capability the contract states required inputs, normalized outputs, and whether it is required or optional.

- AC-002-1: Given a category, when its contract is read, then every capability states inputs, outputs and required/optional status.
- AC-002-2: Given two adapters for the same category, when the same capability is invoked, then both return outputs in the contract's normalized shape.

### REQ-003: Additive-only contract within a major version
**Priority:** Must

Within a contract major version, new capabilities are added only as optional. A required-capability change needs a new contract major version. Adapters declare the contract version they target. Each category's contract is versioned independently of the other categories and of Ensemble's own release version.

- AC-003-1: Given an adapter targeting contract 1.x and a later 1.y contract adding a capability, when the adapter is resolved, then it still validates and the new capability is treated as unavailable.
- AC-003-2: Given an adapter targeting contract 1.x and an installed contract 2.x, when the adapter is resolved, then validation fails naming the contract versions and the capabilities the adapter lacks.
- AC-003-3: Given the tracker contract moves to a new major version, when adapters for other categories are resolved, then their validation result is unchanged.

### REQ-004: Required capabilities and documented fallbacks
**Priority:** Must

Each command and skill declares the capabilities it requires and which optional ones it can use. When an optional capability is absent from the resolved adapter, the command follows that capability's documented fallback instead of failing or silently skipping.

- AC-004-1: Given a command that requires capability X and the resolved adapter lacks X, when the command starts, then it halts before any side effect and names X and the adapter.
- AC-004-2: Given an optional capability absent from the resolved adapter, when the command reaches it, then the documented fallback runs and the output states that the fallback was used.

### Adapters

### REQ-005: Adapters are provider skills
**Priority:** Must | `[RISK: contract shape must support both agent-readable prose and machine validation]`

An adapter is a provider skill: a vocabulary block (nouns, link syntax, tool name) plus one section per implemented capability. End users can create or edit an adapter without a build toolchain, a rebuild or a release.

- AC-005-1: Given an adapter skill file, when a user edits a capability section and reruns a command, then the command uses the edited behavior with no build step.
- AC-005-2: Given an adapter skill missing its vocabulary block, when validation runs, then it fails naming the file and the missing block.

### REQ-006: Default adapters for every category
**Priority:** Must

Every category in the taxonomy ships with a default adapter reproducing ensemble's current behavior for the tool currently used.

- AC-006-1: Given each category in the taxonomy, when shipped adapters are listed, then each category has a default adapter.
- AC-006-2: Given the worktree-manager category, when its default adapter is inspected, then it covers worktree operations using plain source-control worktrees and no command invokes it yet.

### REQ-007: Third-party adapters without core changes
**Priority:** Must

A third party can ship an adapter for any category and users can install it without any change to ensemble core. Adapters are distributed either as installable marketplace packages or as files in a repo-local skills directory.

- AC-007-1: Given an adapter authored outside the ensemble repository, when it is installed and selected in configuration, then commands use it with no ensemble source change.
- AC-007-2: Given a selected adapter that is not installed, when resolution runs, then it fails naming the missing adapter and how to install it.
- AC-007-3: Given an adapter placed in a repo-local skills directory, when it is selected in configuration, then it resolves with no packaging or publishing step.

### REQ-008: Adapter conformance validation
**Priority:** Must

A validation check confirms an adapter implements every required capability of its category and contract version, uses only declared inputs and outputs, and passes boundary input validation. The check can fail: it is demonstrated against a deliberately broken adapter.

- AC-008-1: Given an adapter missing a required capability, when conformance validation runs, then it fails naming the capability.
- AC-008-2: Given a conforming adapter, when conformance validation runs, then it passes.
- AC-008-3: Given the check is applied to a deliberately broken fixture adapter in the test suite, when the suite runs, then the check fails on that fixture (the check is shown capable of failing).

### REQ-009: Provider selection by configuration with a precedence chain
**Priority:** Must

Configuration selects one adapter per category. Resolution uses a fixed precedence: project configuration, then user configuration, then detection, then the shipped default. Project and user configuration live in the locations specified by `PRD-2026-b6939c7c` (`.ensemble/toolchain.yaml` in the project and the XDG `toolchain.yaml` for the user).

- AC-009-1: Given project config selects adapter A and user config selects adapter B for a category, when resolved, then A wins.
- AC-009-2: Given no config and no detectable signal, when resolved, then the shipped default is used.

### Resolution and Safety

### REQ-010: Detection with explicit failure on ambiguity
**Priority:** Must

When no configuration selects an adapter, detection from repository signals (for example the remote host, branching-tool configuration, tracker data directory) proposes one. If detection cannot decide confidently, resolution stops and asks for an explicit choice instead of silently using the default.

- AC-010-1: Given a repository whose remote matches an installed adapter's detection signal and no config, when resolved, then that adapter is selected and the source is reported as detection.
- AC-010-2: Given a remote matching no signal and no config, when resolved in a non-interactive run, then resolution fails with an error naming the category and how to configure it.

### REQ-011: Confirm resolved provider interactively; deterministic in non-interactive runs
**Priority:** Must

In an interactive session, the resolved adapter for a category is shown and confirmed once before the first externally visible action in that category, and re-confirmed if configuration changes mid-session. An externally visible action is any write outside the local working tree: pushing a branch, creating or updating a work item or change request, posting a comment, merging, deploying. Reads and local-only changes never prompt. In non-interactive runs (Foreman, `--foreman`, CI) the precedence chain decides with no prompt and the resolved adapter and its source are logged.

- AC-011-1: Given an interactive session about to take its first write outside the local working tree in a category, when the adapter is resolved, then it is shown and the action waits for confirmation.
- AC-011-2: Given a confirmation already given, when a second action in the same category occurs, then no new prompt appears.
- AC-011-3: Given a non-interactive run, when resolution completes, then no prompt appears and the log records adapter and source.
- AC-011-4: Given configuration edited mid-session to select a different adapter, when the next action runs, then confirmation is requested again.
- AC-011-5: Given an interactive session making a read-only call or a local-only change, when the capability runs, then no confirmation prompt appears.

### REQ-012: Explain mode
**Priority:** Should

A command shows, per category, the resolved adapter and which layer decided it, in human-readable form and as structured output.

- AC-012-1: Given a project with detection-resolved adapters, when explain runs, then each category shows adapter and source (for example "detection").
- AC-012-2: Given the structured-output option, when explain runs, then the same fields appear in machine-readable form.

### REQ-013: Preflight health check before any side effect
**Priority:** Must

Every adapter declares a health check (tool installed, authenticated, reachable). Before a command takes any side effect, all health checks for the capabilities it needs run, and the command halts if any fails. Each health check has a 10-second default timeout, which an adapter may override; a check that times out counts as failed.

- AC-013-1: Given a resolved adapter whose tool is not installed, when a command starts, then it halts before creating any branch, work item or change request and names the failing check.
- AC-013-2: Given an adapter whose authentication has expired, when a command starts in a non-interactive run, then it halts with an error naming the adapter and the failed check.
- AC-013-3: Given a health check that exceeds its timeout, when a command starts, then it halts naming the check as timed out.

### REQ-014: Mid-run failure policy (report only)
**Priority:** Must

If an adapter fails after side effects have occurred, the layer stops, lists every completed side effect (branches, work items, change requests), leaves state intact, and writes a machine-readable failure record. It does not retry, resume or schedule work; recovery belongs to Foreman or the user.

- AC-014-1: Given an adapter failing after a branch and a work item were created, when the failure occurs, then the command stops and its output lists both side effects.
- AC-014-2: Given the same failure, when the failure record is read, then it is machine-readable and names the adapter, failed capability and completed side effects.
- AC-014-3: Given a failure, when the layer finishes, then it has made no retry or resume attempt.

### Command and Internal-CLI Integration

### REQ-015: Commands and skills depend on capabilities, not tools
**Priority:** Must | `[RISK: about 10 heavily coupled commands plus skills must be refactored without changing default behavior]`

Shared commands, agents and skills reference capabilities and resolved adapters. They no longer name a specific tool outside an adapter. Acceptance is asserted through the commands' real entry points, not around them.

- AC-015-1: Given the heaviest-coupled commands, when their sources are inspected, then none name a tool binary outside an adapter.
- AC-015-2: Given a command run through its entry point with an alternative adapter selected, when it reaches a tool step, then it follows the alternative adapter's capability section.

### REQ-016: Tracker swap, end to end (first alternatives: Jira Cloud and Azure Boards)
**Priority:** Must | `[RISK: work-graph behavior differs between trackers]`

With the tracker adapter changed by configuration only, every command that creates, reads, updates or closes work items works against either alternative tracker, including the internal CLIs (`trd-cli` and siblings) that currently call the default tracker directly. Those internal CLIs route through the resolved tracker adapter. The first-release Jira adapter targets Jira Cloud only.

- AC-016-1: Given tracker config set to either alternative adapter (Jira Cloud or Azure Boards), when the scripted tracker scenario (scaffold work from a TRD, claim, update, close) runs, then it completes with no default-tracker tool installed.
- AC-016-2: Given an internal CLI that previously called the default tracker directly, when the tracker adapter is swapped, then the CLI performs the same operation through the alternative adapter.
- AC-016-3: Given a command that uses work-graph capabilities, when the alternative adapter lacks one, then REQ-004's fallback or halt applies.
- AC-016-4: Given each alternative tracker adapter, when the conformance validation of REQ-008 runs against it, then it passes.

### REQ-017: Source-control host swap, end to end (first alternative: Azure DevOps)
**Priority:** Must | `[RISK: review-thread and merge semantics differ between hosts]`

With the source-control host adapter changed by configuration only, commands that open, review, gate and merge change requests work against the alternative host with that host's vocabulary. A team on the alternative vendor can change host and tracker together, because that vendor's work-item tracker ships as a tracker adapter (REQ-016).

- AC-017-1: Given host config set to the alternative adapter, when the scripted change-request scenario (push, open, check status, merge) runs, then it completes with the default host's tool not installed.
- AC-017-2: Given the same scenario, when output is read, then it uses the alternative host's vocabulary for change-request and review terms.
- AC-017-3: Given host config set to the Azure DevOps adapter and tracker config set to the Azure Boards adapter, when the scripted scenario linking a work item to a change request runs, then it completes using configuration changes only.

### REQ-018: Other categories registered with default adapters only
**Priority:** Must

In the first release, categories other than tracker and source-control host ship the taxonomy entry, contract and default adapter only. Alternatives for them are added later as additive releases.

- AC-018-1: Given the first release, when the categories other than tracker and host are inspected, then each has a contract and a default adapter and no alternative adapter.
- AC-018-2: Given a user selecting an unshipped alternative for such a category, when resolved, then resolution fails naming the category and the available adapters.

### REQ-019: Hardcoding lint
**Priority:** Must

CI fails when a shared command, agent or skill source names a tool binary outside an adapter. The lint is an error from the first release; there is no warn-only period. The lint can fail: it is demonstrated against a source containing a deliberate violation.

- AC-019-1: Given a shared source adding a tool binary outside an adapter, when the lint runs, then it fails naming file and line.
- AC-019-2: Given an adapter file naming its own tool binary, when the lint runs, then it passes.
- AC-019-3: Given the lint is applied to a fixture containing a deliberate violation in the test suite, when the suite runs, then the lint fails on that fixture.

### REQ-020: Execution layer follows the resolved tracker
**Priority:** Must | `[RISK: amends PRD-2026-b6939c7c REQ-015; affects ready-work scheduling in implementation commands]`

The earlier rule that the default tracker is always the sole dependency-graph and ready-work engine is replaced. Ready-work and dependency ordering come from the resolved tracker adapter's work-graph capabilities, or from the documented fallback when those are absent. The fallback uses the tracker's own issue links when it has them; otherwise tasks run in plan order and the output states that ordering is not dependency-aware.

- AC-020-1: Given the default tracker adapter, when implementation commands run, then ready-work comes from its work-graph capabilities as today.
- AC-020-2: Given an alternative tracker adapter lacking ready-work but providing issue links, when an implementation command needs ordering, then ordering is derived from those links and the output states the source.
- AC-020-3: Given an alternative tracker adapter providing neither ready-work nor issue links, when an implementation command needs ordering, then tasks run in plan order and the output states that ordering is not dependency-aware.

### Cross-Cutting

### REQ-021: Identical resolution across generated runtimes
**Priority:** Must

Adapter resolution behaves identically in every runtime ensemble generates content for. The first-release supported runtimes are Claude Code, OpenCode, Pi/OMP and Codex.

- AC-021-1: Given the same project config, when resolved in each supported runtime, then the same adapter and source are reported per category.
- AC-021-2: Given a runtime lacking support for a needed mechanism, when resolution runs there, then it fails explicitly rather than falling back.

### REQ-022: Credentials and input validation at the adapter boundary
**Priority:** Must

Adapter configuration never contains secrets; credentials come from the user's environment or secrets manager. All external input crossing the adapter boundary (configuration values, tool output used as capability results) is validated.

- AC-022-1: Given an adapter or config containing a literal credential, when validation runs, then it fails naming the file.
- AC-022-2: Given a tool output that does not match the contract's normalized shape, when the capability returns, then the layer rejects it with an error instead of passing it on.

### REQ-023: Governed boundary and per-adapter command allowlist
**Priority:** Must | `[RISK: security-sensitive; adapters instruct agents to run shell commands]`

An adapter is resolvable only if the user installed it. Adapter-directed commands run through the same governed tool boundary as any command and cannot widen tool grants. Each adapter declares the commands it may invoke at binary plus subcommand level, and validation fails if a capability section calls anything else.

- AC-023-1: Given an adapter capability section calling a binary outside its declared allowlist, when validation runs, then it fails naming the adapter and the binary.
- AC-023-2: Given an adapter attempting to use a tool the running command was not granted, when it runs, then the governed boundary denies it.
- AC-023-3: Given an adapter capability section calling an allowed binary with a subcommand not on its allowlist, when validation runs, then it fails naming the adapter and the subcommand.

### REQ-024: Default equivalence with no configuration
**Priority:** Must | `[RISK: large refactor must be behavior-preserving]`

A project that configures nothing behaves exactly as before: the same default adapters are selected and the same instruction sequences are produced.

- AC-024-1: Given an unconfigured project, when refactored commands are generated, then the default-toolchain equivalence snapshots match pre-refactor output.
- AC-024-2: Given an unconfigured project, when a refactored command opens a change request, then it produces the same default-host instruction sequence as before.

### REQ-025: Contract documentation, authoring guide and migration guide
**Priority:** Should

Published documentation covers the versioned contract per category, how to author and validate an adapter, and migration steps for users and forks.

- AC-025-1: Given the first release, when documentation is checked, then a contract spec and an adapter authoring guide exist.
- AC-025-2: Given a downstream fork with hardcoded tool references, when it reads the migration guide, then each lint failure class has a documented fix.

## Approvals and Decision Ownership

- **Approver:** ensemble maintainers (repo owners).
- **Acceptance criteria they will judge against:** (1) default-equivalence tests pass (REQ-024); (2) the contract is additive-only within a major (REQ-003); (3) the tracker and host swaps are demonstrated end to end by configuration only (REQ-016, REQ-017).
- **Constitution §4:** this PRD proposes an architecture change; explicit approval is required before implementation starts.

## Entry and Exit Criteria

**Entry (before work starts)**
- The decision on how this PRD relates to `PRD-2026-b6939c7c` is made and recorded there (this PRD supersedes its Layer 2).
- The full tool inventory is complete: every external tool invoked from commands, agents and skills is catalogued and assigned to a category.

**Exit (before the work is called done)**
- Default-equivalence golden tests pass with no configuration.
- The tracker swap (to Jira Cloud and to Azure Boards) and the source-control host swap (to Azure DevOps) are each demonstrated by a scripted scenario using configuration changes only.
- The hardcoding lint is enforced in CI and shown capable of failing.
- The contract spec, adapter authoring guide and migration guide are published.

## Acceptance Criteria Summary

| REQ | Description | Priority | AC Count |
|---|---|---|---|
| REQ-001 | Capability taxonomy | Must | 2 |
| REQ-002 | Contract per category | Must | 2 |
| REQ-003 | Additive-only contract versioning | Must | 3 |
| REQ-004 | Required capabilities and fallbacks | Must | 2 |
| REQ-005 | Adapters are provider skills | Must | 2 |
| REQ-006 | Default adapters for every category | Must | 2 |
| REQ-007 | Third-party adapters without core changes | Must | 3 |
| REQ-008 | Adapter conformance validation | Must | 3 |
| REQ-009 | Selection and precedence chain | Must | 2 |
| REQ-010 | Detection with explicit ambiguity failure | Must | 2 |
| REQ-011 | Confirm interactively; deterministic non-interactive | Must | 5 |
| REQ-012 | Explain mode | Should | 2 |
| REQ-013 | Preflight health check | Must | 3 |
| REQ-014 | Mid-run failure policy (report only) | Must | 3 |
| REQ-015 | Capabilities, not tools, in sources | Must | 2 |
| REQ-016 | Tracker swap end to end | Must | 4 |
| REQ-017 | Source-control host swap end to end | Must | 3 |
| REQ-018 | Other categories default-only | Must | 2 |
| REQ-019 | Hardcoding lint | Must | 3 |
| REQ-020 | Execution layer follows resolved tracker | Must | 3 |
| REQ-021 | Identical resolution across runtimes | Must | 2 |
| REQ-022 | Credentials and input validation | Must | 2 |
| REQ-023 | Governed boundary and allowlist | Must | 3 |
| REQ-024 | Default equivalence | Must | 2 |
| REQ-025 | Documentation and migration guide | Should | 2 |

## Dependency Map

- REQ-002 depends on REQ-001.
- REQ-003 depends on REQ-002.
- REQ-004 depends on REQ-002.
- REQ-005 depends on REQ-002.
- REQ-006 depends on REQ-001, REQ-002, REQ-005.
- REQ-007 depends on REQ-003, REQ-005, REQ-008.
- REQ-008 depends on REQ-002, REQ-003, REQ-005.
- REQ-009 depends on REQ-006.
- REQ-010 depends on REQ-009.
- REQ-011 depends on REQ-009, REQ-010.
- REQ-012 depends on REQ-009.
- REQ-013 depends on REQ-005, REQ-009.
- REQ-014 depends on REQ-013.
- REQ-015 depends on REQ-004, REQ-006, REQ-009.
- REQ-016 depends on REQ-015, REQ-020.
- REQ-017 depends on REQ-015.
- REQ-018 depends on REQ-006.
- REQ-019 depends on REQ-005, REQ-015.
- REQ-020 depends on REQ-004.
- REQ-021 depends on REQ-009.
- REQ-022 depends on REQ-005.
- REQ-023 depends on REQ-005, REQ-008.
- REQ-024 depends on REQ-006, REQ-015.
- REQ-025 depends on REQ-008, REQ-024.

Clusters to implement together: (REQ-001, REQ-002, REQ-003, REQ-004); (REQ-005, REQ-006, REQ-008, REQ-023); (REQ-009 to REQ-014); (REQ-015, REQ-016, REQ-017, REQ-020, REQ-024).

No circular dependencies remain. REQ-020 defines ordering semantics and depends only on REQ-004; REQ-016 depends on REQ-020 and proves it end to end.

## Notes

- **Depth:** STANDARD, chosen by the requester.
- **Primary roles (confirmed):** end-user teams, ensemble maintainers, third-party adapter authors, autonomous consumers.
- **Constraints (confirmed):** backward compatible; multi-runtime; builds on or supersedes `PRD-2026-b6939c7c` (resolved as supersede Layer 2); safe for non-interactive runs.
- **Design choices recorded from elicitation:** optional capabilities with command fallbacks; provider skills as the adapter contract; first release is the full contract plus real swaps (two trackers, one host); preflight plus report-only failure policy; additive-only contract within a major; precedence chain with interactive confirmation.
- **Worktree manager:** registered with a default adapter wrapping plain worktrees; worktrunk is not invoked in current source, so there is no command to integrate in the first release.
- **Open clarifications:** none. All 12 markers from v1.0.0 were resolved in v1.0.1 (see Changelog).
- **Readiness Gate:** PASS (4.0), up from 3.75. Completeness 4, Testability 4, Clarity 4, Feasibility 4. Clarity rose once the open markers were resolved.

## Changelog

| Version | Date | Changes |
|---|---|---|
| 1.0.1 | 2026-10-21 | Refinement pass. Resolved all 12 `[NEEDS CLARIFICATION]` markers: split REQ-017 to REQ-022 of PRD-2026-b6939c7c by layer in a follow-up refine; CI category limited to locally invoked runners (REQ-001); contract versioned independently per category (REQ-003); adapters distributable as marketplace packages or repo-local skills (REQ-007); reuse b6939c7c config locations (REQ-009); preflight timeout 10s, per-adapter override (REQ-013); Jira Cloud only (REQ-016); Azure Boards added to the first release as a second alternative tracker (REQ-016, REQ-017); lint is an error from the first release (REQ-019); ordering fallback is tracker links then plan order (REQ-020); runtime set is Claude Code, OpenCode, Pi/OMP and Codex (REQ-021); allowlist at binary plus subcommand level (REQ-023). Defined "externally visible action" as any write outside the local working tree (REQ-011). Replaced redundant AC-023-3 with a subcommand-allowlist AC. Removed the REQ-016/REQ-020 dependency cycle. Added AC-003-3, AC-007-3, AC-011-5, AC-013-3, AC-016-4, AC-017-3, AC-020-3. Readiness 3.75 to 4.0. |
