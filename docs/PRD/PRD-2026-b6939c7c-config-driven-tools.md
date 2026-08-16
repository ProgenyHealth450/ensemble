---
document_id: PRD-2026-b6939c7c
label: prd-config-driven-tools
version: 1.0.1
status: Draft
date: Thu Aug 13 2026 19:00:00 GMT-0500 (Central Daylight Time)
scale_depth: STANDARD
total_requirements: 22
readiness_score: 5
design_readiness_score: null
---

# PRD-2026-b6939c7c: Configuration-Driven Tools for Ensemble Plugins

## PRD Health Summary

| Metric | Value |
|--------|-------|
| Must requirements | 21 |
| Should requirements | 1 |
| Could requirements | 0 |
| Won't requirements | 0 |
| AC coverage | 22/22 (100%) |
| Risk flags | 6 |
| Cross-requirement dependencies | 19 |
| [NEEDS CLARIFICATION] markers | 0 (resolved in v1.0.1) |

**Source:** `docs/ensemble-config-driven-tools-plan.md` — "Configuration-Driven Tools for Ensemble Plugins — v7.0.0 Plan," Mike Devenney, 2026-08-11 (v3). Baseline verified against `main` @ current HEAD (root v6.9.3; 32 agent YAMLs, 6 command sources with `allowed_tools` — both figures reconfirmed live during PRD authoring, tracking within one of the source doc's counts as work has landed since its `4967777` baseline).

## Product Summary

**Problem:** Ensemble hardcodes two different kinds of "tools" across the plugin ecosystem, and neither has a single source of truth:

1. **Tool grants** (which harness tools an agent may call — `Read`, `Bash`, etc.) are duplicated across 32 agent YAML sources, 6 command sources, two JSON schemas that don't validate tool names, and three per-runtime translators (OpenCode, Pi, Codex) that each hardcode their own mapping as code constants. Nothing keeps these five representations in agreement — a typo like `Grpe` ships silently today.
2. **Toolchain provider assumptions** (GitHub + `gh`, git-town, Beads) are welded directly into the prose of roughly 20 agent/command YAML sources. A team running GitLab or Azure DevOps gets agents that speak the wrong CLI and the wrong SDLC vocabulary (pull request vs. merge request vs. work item), and today their only recourse is forking plugin content — which doesn't scale and drifts from upstream.

**Who feels the pain:** Ensemble maintainers, who hand-sync tool grants across five hardcoded surfaces every time an agent's permissions change; and consuming teams on non-default toolchains (GitLab, Azure DevOps, non-git-town workflows), who have no supported customization path today.

**Solution overview:** Two parallel configuration layers, each generalizing a pattern Ensemble already ships successfully elsewhere:

- **Layer 1 — Tool grants registry** (`config/tools.yaml`): one canonical vocabulary, per-runtime semantics, and named composable toolsets, resolved through an override chain (CLI flag → env var → XDG config → repo default). Generators and runtime translators consume it instead of hardcoded tables.
- **Layer 2 — Toolchain provider configuration** (`config/toolchain.yaml`): capability axes (`runtime`, `scm`, `gitflow`, `tracker`), each with a provider list, a default, and detection signals — generalizing the existing `framework-detector`/provider-skill pattern (`packages/git/skills/git-town/`, `managing-jira-issues/`) from frameworks to the toolchain. Agent prose becomes provider-neutral, loading the resolved provider's skill for CLI/vocabulary specifics.

**Value proposition:** Upgrading to 7.0.0 with no added configuration is behaviorally inert (byte-identical generation, identical default toolchain). After 7.0.0, adding a new provider (GitLab, Azure DevOps) or runtime (Copilot CLI) becomes a minor release — a new skill or registry column — never another major, and never a fork.

## User Analysis

| Role | Pain today | What this PRD gives them |
|---|---|---|
| **Ensemble maintainer** (agent/command YAML author) | Hand-syncs tool grants across 5 representations; typos in tool names ship silently; adding a provider means patching ~20 files of hardcoded prose | Single registry + toolset vocabulary; hard validation catches typos at `npm run validate`; new providers are additive (a skill + registry entry), not a content rewrite |
| **Consuming team on a non-default toolchain** (GitLab, Azure DevOps, non-git-town) | Agents assume GitHub/`gh`/git-town; only option is forking plugin content, which drifts from upstream | Toolchain config (project file, XDG, or auto-detection) resolves the right provider; agents load the matching provider skill for correct CLI and vocabulary, with no fork required |

**Success metrics** (from source plan, confirmed during elicitation):
- Golden regeneration test: registry-driven generation of every shipped agent/command YAML is byte-identical to today's committed output.
- Default-toolchain equivalence test: with no config and GitHub detection, refactored commands produce the same instructions/skill loads as today's content.
- Post-7.0.0, adding a provider or runtime lands as a minor version, never a major.

## Goals and Non-Goals

**Goals:**
- Replace the five hardcoded tool-grant surfaces with one validated registry (Layer 1).
- Replace hardcoded GitHub/git-town/Beads assumptions in agent prose with a resolvable, detectable, provider-skill-backed toolchain configuration (Layer 2).
- Preserve exact v6 behavior for any project that upgrades without adding configuration.
- Make future provider/runtime additions a minor-version, additive change.

**Non-Goals (explicitly out of scope):**
- **Runtime enforcement of grants.** The permitter hook governs Bash permission expansion at runtime; this PRD's registry governs what's declared, not runtime interception. Confirmed during elicitation: a project-local override that grants excess tools to an agent (by mistake or by a malicious contributor) is the permitter hook's problem, not this registry's.
- **Codemod for third-party YAMLs.** The migration is mechanical; the migration guide covers it, no automated conversion tool is built.
- **Migrating Beads off the execution layer.** The tracker axis covers the system-of-record only; Beads keeps executing `implement-trd-beads` regardless of which tracker axis provider is configured.
- **Copilot CLI runtime generator in 7.0.** The registry architecture makes this a 7.x minor; scoping it into the major would delay everything else.
- **Hand-authored `.md` commands** (`packages/router/commands/*.md`) that don't pass through the generator — unchanged by this effort.

## Requirements

### Tool Grants Registry (Layer 1)

#### REQ-001: Central tool grants registry
A single file, `config/tools.yaml`, defines the canonical tool vocabulary, per-runtime semantics (OpenCode, Pi), and named composable toolsets. Initial values are lifted 1:1 from today's hardcoded tables so the registry is behavior-preserving by construction.
**Priority:** Must | **Complexity:** Medium

- AC-001-1: Given `config/tools.yaml` exists with the seeded vocabulary, when a generator loads it, then every tool name currently used across the 32 agent YAMLs resolves without error.
- AC-001-2: Given a tool name absent from the registry, when a generator attempts to resolve it, then the load fails with an actionable error rather than silently proceeding.

#### REQ-002: Composable named toolsets
Toolsets compose other toolsets and individual tool names, and may be used in `metadata.tools` in place of literal tool lists. Resolved during v1.0.1 refinement: a live survey of all 32 agent YAMLs' exact `metadata.tools` lists showed the source plan's original three toolsets (`read-only`, `developer`, `orchestrator`) only exactly matched 6 of 32 agents — the largest real cluster (14 agents, `[Read, Write, Edit, Bash]`) matched none of them. The registry ships four toolsets to cover the real distribution, and agents needing tools beyond their base toolset (e.g., `Grep`/`Glob`/`Skill`/`Task`) compose them explicitly alongside it rather than requiring a fifth named toolset per combination:

```yaml
toolsets:
  read-only:  [Read, Grep, Glob]
  editor:     [Read, Write, Edit, Bash]              # covers the 14-agent majority cluster
  developer:  [Read, Write, Edit, Bash, Grep, Glob]
  orchestrator: [developer, Task, TodoWrite, AskUserQuestion]
```

**Priority:** Must | **Complexity:** Low

- AC-002-1: Given a toolset `developer: [Read, Write, Edit, Bash, Grep, Glob]`, when an agent's `metadata.tools` references `developer`, then it expands to that exact concrete list at generate time.
- AC-002-2: Given a toolset that references itself directly or transitively, when the registry is loaded, then the cycle is detected and reported rather than causing infinite expansion.
- AC-002-3: Given a toolset `editor: [Read, Write, Edit, Bash]`, when an agent's `metadata.tools` references `editor`, then it expands to that exact concrete list, matching the single largest real tool-list pattern found across existing agents (14 of 32).

#### REQ-003: Multi-source override resolution for tool grants
Registry resolution follows a first-hit-wins, deep-merged override chain: `--tools-config` CLI flag → `ENSEMBLE_TOOLS_CONFIG` env var → `$XDG_CONFIG_HOME/ensemble/tools.yaml` → repo default `config/tools.yaml`. Resolved during v1.0.1 refinement: Layer 1 deliberately stays XDG-only and does **not** gain a project-local override file (unlike Layer 2's `.ensemble/toolchain.yaml`). Tool grants are a build-time, maintainer/author concern, not a per-project runtime concern — a project-local grants file would let individual repos silently diverge from the golden byte-identical generation guarantee (REQ-005), which the design is meant to prevent.
**Priority:** Must | **Complexity:** Medium

- AC-003-1: Given no CLI flag, env var, or XDG file, when a generator runs, then it uses the repo default `config/tools.yaml`.
- AC-003-2: Given both an XDG file and a `--tools-config` flag are present, when a generator runs, then the CLI flag's values win, deep-merged over the XDG file's values.
- AC-003-3: Given a project directory contains a file at a Layer-2-style project-local path (e.g. `.ensemble/tools.yaml`), when a generator resolves tool grants, then that file is ignored — no such override point exists for Layer 1.

#### REQ-004: Hard validation of unknown tool/toolset names
`[RISK: breaking change]` Any `metadata.tools` entry that doesn't resolve against the registry (tool or toolset) is a hard validation error at `npm run validate`/`generate`. Today such entries are silently accepted.
**Priority:** Must | **Complexity:** Low

- AC-004-1: Given an agent YAML with `metadata.tools: [Grpe]` (a typo), when `npm run validate` runs, then it fails with an error naming the file and the unresolvable entry.
- AC-004-2: Given an agent YAML with only registered tool/toolset names, when `npm run validate` runs, then it passes.

#### REQ-005: Generators consume the registry, output unchanged
`[RISK]` `generate-markdown.js` and related generators expand toolset references and validate against the registry, producing generated `.md` artifacts byte-identical to today's shipped output for every existing agent and command.
**Priority:** Must | **Complexity:** High

- AC-005-1: Given the current set of 32 agent YAMLs and 6 command sources, when regenerated through the registry-driven pipeline, then a golden-file diff against today's committed `.md` output is empty.
- AC-005-2: Given an agent YAML newly authored using a toolset name instead of a literal list, when generated, then the output `.md` frontmatter contains the expanded concrete tool list, never the toolset name.

#### REQ-006: Runtime translators consume the registry
`[RISK]` The OpenCode translator (`scripts/generate-opencode/src/agent-translator.js`) and the Pi transformer (`packages/pi/src/transformers/agent-transformer.ts`) read per-runtime tool semantics from the registry; the hardcoded `TOOL_PERMISSION_MAP` and `CLAUDE_CODE_ONLY_TOOLS` constants are deleted. Resolved during v1.0.1 refinement: the Pi column's `keep`/`strip` semantics (REQ-001's registry example) are sufficient for 7.0 — this is behavior-preserving only. A richer `rename`/`map-to` semantic (e.g., mapping `AskUserQuestion` to Pi's own `ask_user` tool rather than stripping it) is explicitly deferred to a future 7.x minor, once a concrete cross-tool mapping need is identified; it is not required for 7.0's behavior-preservation goal.
**Priority:** Must | **Complexity:** High

- AC-006-1: Given the current hardcoded constants' mappings, when replaced by registry lookups, then OpenCode/Pi snapshot tests produce output identical to pre-migration snapshots.
- AC-006-2: Given a tool absent from a runtime's registry column (mapped to `null` or `strip`), when translated for that runtime, then the tool is omitted from that runtime's output exactly as the old hardcoded logic would have done.

### Toolchain Provider Configuration (Layer 2)

#### REQ-007: Central toolchain registry with capability axes
A single file, `config/toolchain.yaml`, declares capability axes — `runtime`, `scm`, `gitflow`, `tracker` — each with a provider list, a default provider, and (where applicable) detection signals.
**Priority:** Must | **Complexity:** Medium

- AC-007-1: Given `config/toolchain.yaml` with the four axes as specified, when loaded, then each axis exposes its declared providers and default via the loader API.
- AC-007-2: Given an axis with no declared default, when loaded, then validation fails — every axis must have a default provider.

#### REQ-008: Multi-source override resolution for toolchain axes
Resolution follows first-hit-wins: project file `.ensemble/toolchain.yaml` in the consuming repo → user XDG `$XDG_CONFIG_HOME/ensemble/toolchain.yaml` → detection → repo default.
**Priority:** Must | **Complexity:** Medium

- AC-008-1: Given no project file, no XDG file, and no detectable signal, when an axis is resolved, then the repo default provider is used.
- AC-008-2: Given a project file specifies `scm: gitlab` and detection would otherwise signal `github`, when the axis is resolved, then the project file's value wins.

#### REQ-009: Auto-detection of scm/gitflow/tracker providers
A toolchain-detector skill (mirroring `framework-detector`) reads git remote URL, git-town config presence, and `.beads/` presence to resolve `scm`, `gitflow`, and `tracker` providers when no explicit override exists.
**Priority:** Must | **Complexity:** Medium

- AC-009-1: Given a repo whose git remote URL matches `dev.azure.com`, when detection runs with no overrides present, then the `scm` axis resolves to `azure-devops`.
- AC-009-2: Given a repo with git-town config present, when detection runs, then the `gitflow` axis resolves to `git-town`.

#### REQ-010: Explicit failure on ambiguous detection
When detection cannot confidently resolve a provider for an axis (e.g., a non-standard git remote, or a CI environment with no git config), the system surfaces an explicit error or prompt asking the user to specify the provider, rather than silently falling through to the repo default.
**Priority:** Must | **Complexity:** Low

- AC-010-1: Given a git remote URL that matches none of the declared detection signals, when detection runs and no override exists at a higher-precedence layer, then the system reports that the `scm` axis is unresolved and asks the user to specify a provider, instead of silently applying the default.
- AC-010-2: Given a CI environment with no git config available, when detection runs, then the same explicit-ask behavior applies rather than a silent default.

#### REQ-011: Confirmation gate before acting on a resolved provider
`[RISK]` Before an agent acts using a resolved `scm`, `gitflow`, or `tracker` provider (e.g., filing a change request, transitioning a work item), the agent presents the resolved provider to the user and obtains confirmation. This is a stricter guardrail than the confirmation-free `framework-detector` pattern this design otherwise mirrors, because a wrong SCM/tracker resolution has externally-visible consequences (wrong platform, wrong repo). Confirmation is required once per resolved-provider-per-session, cached for the remainder of that session, with re-confirmation triggered if the underlying toolchain config changes mid-session.
**Priority:** Must | **Complexity:** Medium

- AC-011-1: Given an agent about to file its first change request in a session with `scm` resolved to `gitlab`, when it reaches that action, then it presents "gitlab" to the user and waits for confirmation before proceeding.
- AC-011-2: Given confirmation was already given once in a session for a resolved provider, when the same agent takes a second provider-driven action later in that same session, then it does not re-prompt.
- AC-011-3: Given confirmation was given for `scm: gitlab` earlier in a session, when `.ensemble/toolchain.yaml` is edited mid-session to change `scm` to `github`, then the next provider-driven action re-prompts for confirmation.

#### REQ-012: Provider skills per axis/provider pair
One skill per (axis, provider) pair (e.g., `scm-github`, `scm-gitlab`, `gitflow-git-town`), each documenting the CLI binary, terminology, and a vocabulary block (change-request noun, work-item noun, CLI binary, link syntax) consumable by shared, provider-neutral agent prose. Resolved during v1.0.1 refinement (packaging location): `scm` and `gitflow` provider skills live under `packages/git/skills/` — git-adjacent, matching where the existing `git-town` skill already lives, with no new marketplace package required. `tracker` provider skills continue to live where their existing skills already live (`packages/infrastructure/skills/managing-jira-issues/`, `managing-linear-issues/`); `azure-boards` and any future tracker provider skills join them there rather than under `packages/git/skills/`.
**Priority:** Must | **Complexity:** Medium

- AC-012-1: Given the `scm-github` and `gitflow-git-town` skills seeded from today's hardcoded content, when an agent resolves `scm: github` and `gitflow: git-town`, then it loads both skills from `packages/git/skills/` and has access to their vocabulary blocks.
- AC-012-2: Given any axis and any provider declared in `config/toolchain.yaml`'s shipped provider list, when queried, then a corresponding skill with a vocabulary block exists (no axis/provider combination ships without its skill).
- AC-012-3: Given the 7.1.0 `azure-boards` tracker provider skill ships, when its location is checked, then it lives under `packages/infrastructure/skills/`, not `packages/git/skills/`.

#### REQ-013: Content refactor to provider-neutral prose
`[RISK]` The approximately 20 agent/command YAML sources that currently hardcode GitHub/`gh`/git-town prose are rewritten to be provider-neutral (e.g., "create a change request using the resolved scm provider — load its skill"), resolving via the toolchain config at run time.
**Priority:** Must | **Complexity:** High

- AC-013-1: Given the refactored `fix-issue` command run against a project with default (unconfigured) toolchain, when it needs to open a change request, then it produces the same `gh pr create` instruction sequence as today's hardcoded version.
- AC-013-2: Given the same refactored `fix-issue` command run against a project configured for `scm: gitlab`, when it needs to open a change request, then it produces a `glab mr create` instruction sequence using GitLab's "merge request" vocabulary, with no code change to the command source itself.

#### REQ-014: CI enforcement against hardcoding creep
`scripts/lint-provider-refs.js` (modeled on `scripts/lint-model-ids.js`) fails CI when a shared agent/command source references a provider binary (`gh`, `glab`, `git town`, `az repos`) outside of a provider skill.
**Priority:** Must | **Complexity:** Medium

- AC-014-1: Given a shared agent YAML that adds a new hardcoded `gh pr create` instruction outside a provider skill, when `lint-provider-refs.js` runs, then it fails, naming the offending file and line.
- AC-014-2: Given a provider skill file itself contains `gh pr create`, when `lint-provider-refs.js` runs, then it passes — provider skills are the sanctioned location for provider-specific binaries.

#### REQ-015: Beads remains the sole execution layer
The `tracker` axis governs only the system-of-record that `implement-trd-beads` links to and reports into; Beads (`br`/`bv`) remains the sole dependency-graph and ready-work-queue execution engine regardless of which tracker provider is configured.
**Priority:** Must | **Complexity:** Low

- AC-015-1: Given `tracker` resolved to `azure-boards` (post-7.1), when `implement-trd-beads` executes a task graph, then the dependency resolution and ready-work queue still run through Beads, with Azure Boards receiving only status/link updates.
- AC-015-2: Given `tracker` resolved to its default `beads` provider, when a task completes, then no separate system-of-record update is attempted (Beads is both executor and record in that configuration).

#### REQ-016: 7.0 axis scope and shipped-provider gating
For 7.0.0, the `runtime`, `scm`, and `gitflow` axes ship with full provider support as scoped in this PRD; the `tracker` axis ships its config surface and the `beads` provider only, with `azure-boards` committed as the 7.1.0 fast follow. Each axis's `providers:` list in the shipped `config/toolchain.yaml` includes only providers with a skill actually shipped in that release — unshipped providers are not listed as selectable until their skill ships alongside them. Resolved during v1.0.1 refinement (timing beyond 7.1.0): `jira` and `linear` tracker providers ship together in 7.2.0, seeded from the already-shipped `managing-jira-issues`/`managing-linear-issues` skills. `github-issues` follows in a later 7.x minor once its skill is built from scratch, since (unlike jira/linear) no existing skill seeds it.
**Priority:** Must | **Complexity:** Medium

- AC-016-1: Given the 7.0.0 release, when `config/toolchain.yaml`'s `tracker` axis is inspected, then its `providers:` list contains only `beads`.
- AC-016-2: Given the 7.1.0 release ships the `azure-boards` provider skill, when `config/toolchain.yaml`'s `tracker` axis is inspected at that version, then `azure-boards` appears in the `providers:` list alongside `beads`.
- AC-016-3: Given the 7.2.0 release, when `config/toolchain.yaml`'s `tracker` axis is inspected, then its `providers:` list includes `jira` and `linear` alongside `beads` and `azure-boards`, while `github-issues` does not yet appear (it ships in a later, unscheduled 7.x minor).

### Diagnostics & Operability

#### REQ-017: Resolution explain mode
With four override layers each for Layer 1 and Layer 2, a debug/explain mode reports which layer resolved each tool grant or toolchain provider. Output is human-readable by default (`<name>: <resolved-value> (source: <layer>)`, e.g. `scm: gitlab (source: project .ensemble/toolchain.yaml)`), with a `--json` flag producing the equivalent structured output for machine consumption. Ships in 7.0.
**Priority:** Should | **Complexity:** Medium

- AC-017-1: Given a project with `scm` resolved via detection (no explicit override), when the explain mode is invoked for that axis, then it prints `scm: <provider> (source: detection)` in human-readable form.
- AC-017-2: Given the same query invoked with `--json`, when the explain mode runs, then it emits a structured object with equivalent name/value/source fields instead of the human-readable line.
- AC-017-3: Given each of the six distinct resolution layers across both registries (CLI flag, env var, XDG, project file, detection, repo default), when exercised in a snapshot test, then each layer has at least one asserted explain-output example.

### Validation & Enforcement

#### REQ-018: Fail-fast structural validation
Structural errors in `config/tools.yaml` or `config/toolchain.yaml` — syntax errors, toolset composition cycles, references to undeclared tools/providers — are caught and reported by `npm run validate`, before `npm run generate` runs. Every such failure reports the offending file path and the specific key or line responsible.
**Priority:** Must | **Complexity:** Medium

- AC-018-1: Given `config/tools.yaml` contains a toolset that references an undeclared tool name, when `npm run validate` runs, then it fails with the file path and the specific toolset/key involved, before `npm run generate` is ever invoked.
- AC-018-2: Given both files are well-formed and internally consistent, when `npm run validate` runs, then it passes and `npm run generate` proceeds normally.

#### REQ-019: Schema-backed enforcement
`metadata.tools` and the two new registry files are validated via JSON Schema (`schemas/agent-yaml-schema.json`, `command-yaml-schema.json`, and new registry schemas), not ad hoc code checks alone.
**Priority:** Must | **Complexity:** Low

- AC-019-1: Given a `config/tools.yaml` that violates its schema (e.g., a toolset value that isn't an array), when validated, then the JSON Schema validator reports the violation.
- AC-019-2: Given `schemas/agent-yaml-schema.json` updated to constrain `metadata.tools` entries to registry-resolvable strings, when an agent YAML with a free-form unregistered string is validated, then schema validation flags it.

### Compatibility & Migration

#### REQ-020: Behaviorally inert upgrade for unconfigured projects
`[RISK]` A project that upgrades to 7.0.0 without adding any `config/tools.yaml`, `config/toolchain.yaml`, or `.ensemble/toolchain.yaml` override behaves identically to v6: the same generated agent/command artifacts (Layer 1) and the same GitHub + `gh`, git-town, Beads toolchain (Layer 2).
**Priority:** Must | **Complexity:** High

- AC-020-1: Given an unconfigured project on v6.9.x, when its agents are regenerated under 7.0.0 with no config added, then the generated `.md` artifacts are byte-identical to the v6.9.x versions (golden test, ties to REQ-005).
- AC-020-2: Given the same unconfigured project, when a refactored command needs to file a change request, then it produces the same `gh pr create`-based instructions as v6 (default-toolchain equivalence snapshot, ties to REQ-013).

#### REQ-021: Published migration guide
A migration guide under `docs/guides/` covers the breaking changes (validation tightening, deleted translator constants, provider-neutral content) before `7.0.0-beta.1` ships.
**Priority:** Must | **Complexity:** Low

- AC-021-1: Given a downstream fork with custom agent YAMLs that fail the new hard validation, when they consult the migration guide, then it documents the specific error classes (unregistered tool names, provider-ref lint violations) and how to fix each.
- AC-021-2: Given `7.0.0-beta.1` is tagged, when checked, then the migration guide already exists in `docs/guides/` as of that tag (not added later in the beta cycle).

#### REQ-022: Joint enforcement gate at the 7.0 beta cutover
Individual PRs for Workstream A (tool grants registry) and Workstream B (toolchain providers) may continue to merge to `dev`/`main` independently as 6.x minors, consistent with the source plan's rollout table. However, `7.0.0-beta.1` — the release that flips hard validation and `lint-provider-refs` from warn to error — cannot be cut until **both** workstreams' content refactors are complete. This resolves a conflict identified during PRD review: the two layers are product-level tightly coupled (a partial rollout leaves either maintainers or non-default-toolchain teams still unserved), even though their PR-level engineering can proceed in parallel.
**Priority:** Must | **Complexity:** Medium

- AC-022-1: Given only Workstream A's PRs (A1-A3) are complete and Workstream B's content refactor (B3) is not, when a `7.0.0-beta.1` tag is attempted, then release tooling/checklist blocks it pending B3 completion.
- AC-022-2: Given both Workstream A (through A3) and Workstream B (through B3) are complete, when `7.0.0-beta.1` is cut, then both the Layer 1 hard-validation flip and the Layer 2 `lint-provider-refs` warn→error flip land in the same release.

## Acceptance Criteria Summary

| REQ-NNN | Description | Priority | Complexity | AC Count |
|---|---|---|---|---|
| REQ-001 | Central tool grants registry | Must | Medium | 2 |
| REQ-002 | Composable named toolsets | Must | Low | 3 |
| REQ-003 | Multi-source override resolution (Layer 1) | Must | Medium | 3 |
| REQ-004 | Hard validation of unknown tool/toolset names | Must | Low | 2 |
| REQ-005 | Generators consume registry, output unchanged | Must | High | 2 |
| REQ-006 | Runtime translators consume registry | Must | High | 2 |
| REQ-007 | Central toolchain registry with capability axes | Must | Medium | 2 |
| REQ-008 | Multi-source override resolution (Layer 2) | Must | Medium | 2 |
| REQ-009 | Auto-detection of scm/gitflow/tracker providers | Must | Medium | 2 |
| REQ-010 | Explicit failure on ambiguous detection | Must | Low | 2 |
| REQ-011 | Confirmation gate before acting on resolved provider | Must | Medium | 3 |
| REQ-012 | Provider skills per axis/provider pair | Must | Medium | 3 |
| REQ-013 | Content refactor to provider-neutral prose | Must | High | 2 |
| REQ-014 | CI enforcement against hardcoding creep | Must | Medium | 2 |
| REQ-015 | Beads remains the sole execution layer | Must | Low | 2 |
| REQ-016 | 7.0 axis scope and shipped-provider gating | Must | Medium | 3 |
| REQ-017 | Resolution explain mode | Should | Medium | 3 |
| REQ-018 | Fail-fast structural validation | Must | Medium | 2 |
| REQ-019 | Schema-backed enforcement | Must | Low | 2 |
| REQ-020 | Behaviorally inert upgrade for unconfigured projects | Must | High | 2 |
| REQ-021 | Published migration guide | Must | Low | 2 |
| REQ-022 | Joint enforcement gate at 7.0 beta cutover | Must | Medium | 2 |

## Dependency Map

| REQ | Depends On | Blocked By | Notes |
|---|---|---|---|
| REQ-002 | REQ-001 | — | Toolsets are defined within the registry |
| REQ-003 | REQ-001 | — | Resolution chain operates over the registry |
| REQ-004 | REQ-001, REQ-002 | — | Validation needs the vocabulary and toolsets to check against |
| REQ-005 | REQ-001, REQ-002, REQ-004 | — | Generators expand + validate before emitting |
| REQ-006 | REQ-001 | — | Translators read the same registry columns |
| REQ-008 | REQ-007 | — | Resolution chain operates over the axes |
| REQ-009 | REQ-007 | — | Detection resolves declared axes |
| REQ-010 | REQ-009 | — | Explicit-failure path triggers when detection is inconclusive |
| REQ-011 | REQ-009, REQ-010 | — | Confirmation applies to whatever gets resolved (detected or explicit) |
| REQ-012 | REQ-007 | — | Skills are keyed by declared axis/provider pairs |
| REQ-013 | REQ-008, REQ-012 | — | Provider-neutral prose resolves via config and loads skills |
| REQ-014 | REQ-013 | — | Lint enforces the refactor stays in place |
| REQ-016 | REQ-007, REQ-012 | — | Scope gating depends on axes and skill availability |
| REQ-017 | REQ-003, REQ-008 | — | Explain mode surfaces both resolution chains |
| REQ-018 | REQ-001, REQ-007 | — | Validates both registry files |
| REQ-019 | REQ-018 | — | Schema checks are part of validation |
| REQ-020 | REQ-005, REQ-006, REQ-013, REQ-016 | — | Compatibility spans both layers' generated/runtime output |
| REQ-021 | REQ-020 | — | Guide documents the compatibility boundary and what breaks it |
| REQ-022 | REQ-005, REQ-006, REQ-013, REQ-014, REQ-020, REQ-021 | — | Beta gate depends on both workstreams' substantive work being done |

No circular dependencies identified.

## Readiness Scorecard

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Completeness | 5 | Both layers, diagnostics, validation, and compatibility/migration are all covered; non-goals explicitly bounded |
| Testability | 5 | Every Must has 2+ ACs; the one Should (REQ-017) has 3; golden/snapshot test strategy specified per risk-flagged requirement |
| Clarity | 5 | All 3 [NEEDS CLARIFICATION] markers resolved in v1.0.1 (toolset granularity grounded in a live 32-agent survey, tracker-provider timing staggered, provider-skill packaging location decided); two previously-dropped source-doc open questions (Layer 1 project-local override scope, Pi mapping richness) were also resolved explicitly rather than left silent |
| Feasibility | 5 | Built directly on existing, working Ensemble patterns (`framework-detector`, `test-detector`, provider-style skills); default behavior is preserved by construction |

**Overall score: 5.0 — PASS** (≥4.0 threshold)

**Readiness score: 4.75 → 5.0 (improved)**

**Gate decision:** PASS. All open items resolved; no [NEEDS CLARIFICATION] markers remain. Ready for TRD handoff.

---

**Next step:** `/ensemble:create-trd docs/PRD/PRD-2026-b6939c7c-config-driven-tools.md`

## Changelog

### v1.0.1 — 2026-08-14
Refinement pass via `/ensemble:refine-prd`, resolving all 3 `[NEEDS CLARIFICATION]` markers plus 2 source-doc open questions that had been dropped from v1.0.0:

- **REQ-002** (toolset granularity): grounded in a live survey of all 32 agent YAMLs' exact `metadata.tools` lists — the original 3 toolsets only exactly matched 6 of 32 agents. Added a 4th toolset, `editor: [Read, Write, Edit, Bash]`, covering the largest real cluster (14 of 32 agents); documented that agents needing additional tools compose them explicitly alongside a base toolset. Added AC-002-3.
- **REQ-003** (Layer 1 override scope — previously-dropped open question): explicitly resolved as XDG-only, no project-local override file, with rationale (build-time/maintainer concern vs. Layer 2's per-project runtime concern; avoids undercutting the golden byte-identical generation guarantee). Added AC-003-3.
- **REQ-006** (Pi mapping richness — previously-dropped open question): explicitly resolved that `keep`/`strip` semantics are sufficient for 7.0; a richer `rename`/`map-to` semantic is deferred to a future 7.x minor pending a concrete need.
- **REQ-012** (provider-skill packaging location): resolved as `packages/git/skills/` for `scm`/`gitflow` provider skills (matching where `git-town`'s skill already lives); `tracker` provider skills continue under `packages/infrastructure/skills/` alongside the existing `jira`/`linear` skills. Added AC-012-3.
- **REQ-016** (tracker-provider timing beyond 7.1.0): resolved as staggered — `jira`/`linear` ship together in 7.2.0 (seeded from existing skills), `github-issues` follows in a later, unscheduled 7.x minor (no existing skill to seed it). Added AC-016-3.
- PRD Health summary and Readiness Scorecard updated to reflect 0 remaining `[NEEDS CLARIFICATION]` markers; readiness score improved 4.75 → 5.0 (Clarity 4 → 5).
- Version bumped 1.0.0 → 1.0.1; Document ID and Label unchanged.
