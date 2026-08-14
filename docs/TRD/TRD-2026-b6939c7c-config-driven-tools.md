---
document_id: TRD-2026-b6939c7c
label: trd-config-driven-tools
prd_reference: PRD-2026-b6939c7c
version: 1.0.0
status: Draft
date: 2026-08-14
design_readiness_score: 4.75
kind: trd
---

# TRD-2026-b6939c7c: Configuration-Driven Tools for Ensemble Plugins

**Source PRD:** `docs/PRD/PRD-2026-b6939c7c-config-driven-tools.md` (v1.0.1, readiness 5.0 — PASS)

## Capability Reuse Check

`node packages/development/lib/trd-graph-cli.js capabilities docs/TRD --json` returned an empty capability registry, and `overlap` found no existing foundational TRD touching tool grants, toolchain providers, or provider-skill detection. **Reused Capabilities: none** — no foundational TRD exists yet for this domain. This TRD is not marked `--foundational`: while the registries it builds are used repo-wide, they are not themselves a capability another PRD's TRD would independently need to consume (they're infrastructure for the plugin ecosystem itself, authored once here). If a future PRD needs to extend either registry's resolution engine independently of this effort, extracting it into a foundational TRD at that point is the right call.

## Architecture Decision

### Alternatives Considered

| Option | Approach | Pros | Cons |
|---|---|---|---|
| A — Simplest | Fold config loading into existing `generate-markdown.js`; copy-paste detection logic from `framework-detector` rather than modularizing | Fastest to build, fewest new files | Couples the two independent layers together; makes future axis/provider growth harder — cuts against the PRD's "additive minor release" goal |
| B — Maximally scalable | Shared generic config-resolution-chain abstraction parameterized across both layers; provider-skill manifest format for programmatic discovery; new first-class CLI commands (`ensemble-tools`, `ensemble-toolchain`) | Most robust to future growth; highly testable in isolation | More upfront engineering than the 4-axis/2-registry scope calls for; risks delaying 7.0; introduces new CLI surface the PRD never asked for |
| **C — Balanced, convention-matching (chosen)** | Two purpose-built modules (`scripts/lib/tool-registry.js`, `scripts/lib/toolchain-registry.js`), each with its own inline resolution chain; detection mirrors `packages/core/lib/detect-framework.js` exactly; provider skills use the existing plain-directory convention | Matches existing codebase idioms (lowest maintainer onboarding cost); no premature abstraction; delivers exactly what 7.0 needs; each layer independently testable | The two resolution chains have near-identical shape (first-hit-wins, deep-merge) implemented twice rather than shared — accepted as an explicit simplicity tradeoff since their source-list *order and count* genuinely differ (CLI/env/XDG/repo vs. project/XDG/detect/repo) |

**Rationale:** Option C was selected because it directly extends a pattern that already works in this codebase (`framework-detector`, `test-detector`, provider-style skills like `git-town`) rather than introducing new abstractions or a new CLI surface neither the PRD nor the existing plugin ecosystem calls for. It keeps the two registries independently testable without forcing a shared resolver class whose parameterization would itself need design and testing.

### Resolver Interface Convention (resolves Architecture Issue A1)

Both `tool-registry.js` and `toolchain-registry.js` expose their resolution results as `{ value, source }` pairs for every resolved key/axis — e.g. `{ value: 'gitlab', source: 'project:.ensemble/toolchain.yaml' }`. This is the contract `scripts/explain-config.js` (PR 7) consumes from both registries uniformly, without requiring a shared base class. Every resolver function's return type carries this shape from the first PR it lands in (`TRD-002`, `TRD-010`), not bolted on later.

### Detection Failure Path Convention (resolves Architecture Issue A2)

`detect-toolchain.js` treats "not inside a git repository at all" identically to "no detection signal matched" — both route through the REQ-010 explicit-ask path. Detection never throws an uncaught error for a missing `.git` directory; it returns an unresolved result with a `reason` string, exactly like an unrecognized remote URL.

## System Architecture

### Components

| Component | Location | Responsibility |
|---|---|---|
| Tool grants registry (data) | `config/tools.yaml` | Canonical tool vocabulary, per-runtime (OpenCode/Pi) semantics, named toolsets |
| Toolchain registry (data) | `config/toolchain.yaml` | Capability axes (`runtime`, `scm`, `gitflow`, `tracker`), provider lists, defaults, detection signals |
| Layer 1 loader/resolver | `scripts/lib/tool-registry.js` | Override-chain resolution (CLI flag → env var → XDG → repo default), toolset expansion + cycle detection, validation |
| Layer 2 loader/resolver | `scripts/lib/toolchain-registry.js` | Override-chain resolution (project file → XDG → detection → repo default), axis validation |
| Toolchain detector | `packages/core/lib/detect-toolchain.js` + `packages/core/skills/toolchain-detector/SKILL.md` | Detects `scm`/`gitflow`/`tracker` from git remote URL, git-town config, `.beads/` presence; mirrors `detect-framework.js` structurally |
| Provider skills | `packages/git/skills/scm-*`, `packages/git/skills/gitflow-*`, `packages/infrastructure/skills/tracker-*` (post-7.0) | Per-(axis,provider) CLI/vocabulary documentation, consumed by provider-neutral agent prose |
| Confirmation gate | new logic inside agent-invocation flow (session-scoped cache) | Presents resolved scm/gitflow/tracker provider once per session before first provider-driven action; re-confirms on mid-session config change |
| Explain mode | `scripts/explain-config.js` | Human-readable + `--json` resolution-source reporting across both registries |
| Validation | `scripts/validate-all.js` extensions + `schemas/tools-registry-schema.json`, `schemas/toolchain-registry-schema.json` | Fail-fast structural checks before `npm run generate` |
| CI enforcement | `scripts/lint-provider-refs.js` | Flags hardcoded provider binaries (`gh`, `glab`, `git town`, `az repos`) outside provider skills |
| Runtime translators (modified) | `scripts/generate-opencode/src/agent-translator.js`, `packages/pi/src/transformers/agent-transformer.ts` | Read Layer 1 registry instead of hardcoded `TOOL_PERMISSION_MAP`/`CLAUDE_CODE_ONLY_TOOLS` |
| Generators (modified) | `scripts/lib/agent-transformer.js`, `scripts/lib/command-transformer.js` | Expand toolsets + validate via Layer 1 registry before emitting frontmatter |

### Data Flow — Build Time (Layer 1)

```
agent/command YAML (metadata.tools: toolset or literal list)
        │
        ▼
tool-registry.js  ──resolves override chain──▶ { value, source } per tool
        │  (expand toolsets, validate against vocabulary, detect cycles)
        ▼
agent-transformer.js / command-transformer.js ──▶ generated .md (concrete tool list only)
        │
        ▼
OpenCode / Pi translators ──read same registry's per-runtime column──▶ runtime-specific artifacts
```

### Data Flow — Run Time (Layer 2)

```
agent task starts
        │
        ▼
toolchain-detector skill ──▶ detect-toolchain.js (git remote, git-town config, .beads/)
        │
        ▼
toolchain-registry.js ──resolves override chain (project → XDG → detection → repo default)──▶ { value, source } per axis
        │
        ├─ unresolved? ──▶ explicit ask (REQ-010) — never falls through silently
        │
        ▼
confirmation gate (first provider-driven action this session) ──▶ user confirms/rejects
        │
        ▼
agent loads resolved provider's skill(s) (packages/git/skills/*, packages/infrastructure/skills/tracker-*)
        │
        ▼
provider-neutral instruction + skill vocabulary block ──▶ correct CLI invocation (gh / glab / az repos / etc.)
```

### Integration Points

| Integration | Protocol/Format | Notes |
|---|---|---|
| Git remote/config | Shell `git remote -v`, `.git/config`, git-town's config file | Read-only; mirrors `detect-framework.js`'s existing shell-out pattern |
| `.beads/` presence | Filesystem check | Signals `tracker: beads` default |
| XDG config | YAML file at `$XDG_CONFIG_HOME/ensemble/{tools,toolchain}.yaml` | Reuses `packages/core/lib/config-path.js` |
| Project-local config | `.ensemble/toolchain.yaml` in consuming repo | Layer 2 only (REQ-003 explicitly excludes Layer 1 from this) |
| CI | `scripts/lint-provider-refs.js` invoked from `npm run validate` and a CI workflow step | Warn-only until the 7.0.0-beta.1 gate (REQ-022) |

## Master Task List

### PR 1: Tool grants registry, warn-only
**Shippable State:** Agent/command authors can reference named toolsets (`read-only`, `editor`, `developer`, `orchestrator`) in `metadata.tools`, and `npm run validate` warns — without yet failing — on tool names that don't resolve against the registry.

- [ ] TRD-001 Create `config/tools.yaml` with seeded vocabulary and 4 toolsets, lifted 1:1 from today's hardcoded tables [satisfies REQ-001, REQ-002] (4h)
  - Validates PRD ACs: AC-001-1, AC-002-1, AC-002-3
  - Implementation AC: Given the file is created, when every tool name used across the 32 agent YAMLs is checked against it, then all resolve without error.
- [ ] TRD-001-TEST Verify registry loads and all in-use tool names resolve [verifies TRD-001] [satisfies REQ-001] [depends: TRD-001] (2h)
- [ ] TRD-002 Implement `scripts/lib/tool-registry.js`: override-chain resolution (CLI flag → env var → XDG → repo default, deep-merged, first-hit-wins), toolset expansion with cycle detection, returns `{ value, source }` per resolved tool [satisfies REQ-001, REQ-002, REQ-003] [depends: TRD-001] (6h)
  - Validates PRD ACs: AC-002-2, AC-003-1, AC-003-2, AC-003-3
  - Implementation AC: Given a toolset cycle, when the registry loads, then it reports the cycle instead of infinite-expanding. Given a project-local `.ensemble/tools.yaml`, when resolved, then it is ignored (no such override point for Layer 1).
- [ ] TRD-002-TEST Override-chain precedence + cycle-detection unit tests [verifies TRD-002] [satisfies REQ-003] [depends: TRD-002] (4h)
- [ ] TRD-003 Add `schemas/tools-registry-schema.json`; wire warn-only validation for unregistered `metadata.tools` entries into `npm run validate` [satisfies REQ-004, REQ-019] [depends: TRD-002] (4h)
  - Validates PRD ACs: AC-004-1, AC-004-2, AC-019-1
  - Implementation AC: Given `metadata.tools: [Grpe]`, when `npm run validate` runs, then it warns naming the file and the unresolvable entry (not yet a hard failure).
- [ ] TRD-003-TEST Schema violation + typo-detection warn-mode tests [verifies TRD-003] [satisfies REQ-004] [depends: TRD-003] (2h)

### PR 2: Generators consume the registry, output unchanged
**Shippable State:** Generated agent/command markdown artifacts are produced through the tool-grants registry and remain byte-identical to today's shipped output; new agents may author `metadata.tools` using toolset names.

- [ ] TRD-004 Update `agent-transformer.js`/`command-transformer.js` to expand toolsets and validate via `tool-registry.js` before emitting frontmatter [satisfies REQ-005] [depends: TRD-002] (6h)
  - Validates PRD ACs: AC-005-2
- [ ] TRD-004-TEST Toolset-name-in, concrete-list-out frontmatter test [verifies TRD-004] [satisfies REQ-005] [depends: TRD-004] (4h)
- [ ] TRD-005 `[RISK]` Golden byte-identical regression test across all 32 agent YAMLs + 6 command sources [satisfies REQ-005] [depends: TRD-004] (5h)
  - Validates PRD ACs: AC-005-1
- [ ] TRD-005-TEST Golden-diff CI wiring + empty-diff assertion [verifies TRD-005] [satisfies REQ-005] [depends: TRD-005] (3h)

### PR 3: Runtime translators consume the registry
**Shippable State:** OpenCode and Pi runtime artifacts are generated from the shared tool-grants registry instead of hardcoded per-runtime constants, with unchanged output.

- [ ] TRD-006 Update OpenCode translator to read the registry's OpenCode column; delete `TOOL_PERMISSION_MAP` [satisfies REQ-006] [depends: TRD-002] (5h)
- [ ] TRD-006-TEST OpenCode translator unit tests against registry-driven mapping [verifies TRD-006] [satisfies REQ-006] [depends: TRD-006] (3h)
- [ ] TRD-007 Update Pi transformer to read the registry's Pi column (`keep`/`strip`); delete `CLAUDE_CODE_ONLY_TOOLS` [satisfies REQ-006] [depends: TRD-002] (5h)
  - Implementation AC: `keep`/`strip` semantics only for 7.0 — no `rename`/`map-to` support (explicitly deferred; see REQ-006 resolution).
- [ ] TRD-007-TEST Pi transformer unit tests against registry-driven mapping [verifies TRD-007] [satisfies REQ-006] [depends: TRD-007] (3h)
- [ ] TRD-008 `[RISK]` OpenCode + Pi snapshot tests asserting output identical to pre-migration snapshots [satisfies REQ-006] [depends: TRD-006, TRD-007] (4h)
  - Validates PRD ACs: AC-006-1, AC-006-2
- [ ] TRD-008-TEST Snapshot-regression CI wiring [verifies TRD-008] [satisfies REQ-006] [depends: TRD-008] (2h)

### PR 4: Toolchain registry + detector, inert
**Shippable State:** Running the toolchain detector against any repo reports its resolved scm/gitflow/tracker providers (or an explicit unresolved prompt); no agent behavior changes yet.

- [ ] TRD-009 Create `config/toolchain.yaml` declaring the 4 axes with 7.0-scoped provider lists (`scm`: github/gitlab/azure-devops; `gitflow`: git-town/vanilla; `tracker`: beads only) [satisfies REQ-007, REQ-016] (4h)
  - Validates PRD ACs: AC-007-1, AC-007-2, AC-016-1
- [ ] TRD-009-TEST Axis/default/provider-list structural tests [verifies TRD-009] [satisfies REQ-007] [depends: TRD-009] (2h)
- [ ] TRD-010 Implement `scripts/lib/toolchain-registry.js`: override-chain resolution (project file → XDG → detection → repo default), returns `{ value, source }` per axis [satisfies REQ-007, REQ-008] [depends: TRD-009] (6h)
  - Validates PRD ACs: AC-008-1, AC-008-2
- [ ] TRD-010-TEST Override-chain precedence unit tests [verifies TRD-010] [satisfies REQ-008] [depends: TRD-010] (4h)
- [ ] TRD-011 Implement `packages/core/lib/detect-toolchain.js` mirroring `detect-framework.js`: detect `scm` from git remote URL, `gitflow` from git-town config, `tracker` from `.beads/`; treats "not a git repo" as an unresolved signal (Architecture Issue A2) [satisfies REQ-009] [depends: TRD-010] (6h)
  - Validates PRD ACs: AC-009-1, AC-009-2
- [ ] TRD-011-TEST Detection-signal parsing tests (incl. not-a-git-repo case) [verifies TRD-011] [satisfies REQ-009] [depends: TRD-011] (4h)
- [ ] TRD-012 Explicit-failure path: when detection is inconclusive for an axis and no override exists, surface an error/prompt instead of silently applying the repo default [satisfies REQ-010] [depends: TRD-011] (4h)
  - Validates PRD ACs: AC-010-1, AC-010-2
- [ ] TRD-012-TEST Unresolved-signal and CI-no-git-config prompt tests [verifies TRD-012] [satisfies REQ-010] [depends: TRD-012] (2h)
- [ ] TRD-013 Create `packages/core/skills/toolchain-detector/SKILL.md` wrapping `detect-toolchain.js` for agent consumption [satisfies REQ-009] [depends: TRD-011] (3h)
- [ ] TRD-013-TEST Skill-invocation contract test [verifies TRD-013] [satisfies REQ-009] [depends: TRD-013] (2h)

### PR 5: Provider skill extraction
**Shippable State:** `scm-github`, `scm-gitlab`, `scm-azure-devops`, `gitflow-git-town`, and `gitflow-vanilla` provider skills exist with complete vocabulary blocks; agent content is unchanged and still hardcodes GitHub/git-town directly.

- [ ] TRD-014 Extract today's hardcoded GitHub/`gh` content into `packages/git/skills/scm-github/SKILL.md` with vocabulary block [satisfies REQ-012] (4h)
  - Validates PRD ACs: AC-012-1
- [ ] TRD-014-TEST Vocabulary-block contract test for scm-github [verifies TRD-014] [satisfies REQ-012] [depends: TRD-014] (2h)
- [ ] TRD-015 Re-home the existing git-town skill (content move, no behavior change) into `packages/git/skills/gitflow-git-town/SKILL.md` with vocabulary block [satisfies REQ-012] (3h)
- [ ] TRD-015-TEST Vocabulary-block contract test for gitflow-git-town [verifies TRD-015] [satisfies REQ-012] [depends: TRD-015] (2h)
- [ ] TRD-016 Author `packages/git/skills/scm-gitlab/SKILL.md` (`glab` CLI, "merge request" vocabulary) [satisfies REQ-012, REQ-013] (5h)
- [ ] TRD-016-TEST Vocabulary-block contract test for scm-gitlab [verifies TRD-016] [satisfies REQ-012] [depends: TRD-016] (3h)
- [ ] TRD-017 Author `packages/git/skills/scm-azure-devops/SKILL.md` (`az repos` CLI, work-item vocabulary, `#NNNNN` linking) [satisfies REQ-012, REQ-013] (5h)
- [ ] TRD-017-TEST Vocabulary-block contract test for scm-azure-devops [verifies TRD-017] [satisfies REQ-012] [depends: TRD-017] (3h)
- [ ] TRD-018 Author `packages/git/skills/gitflow-vanilla/SKILL.md` (plain branch/rebase/push flow) [satisfies REQ-012] (3h)
- [ ] TRD-018-TEST Vocabulary-block contract test for gitflow-vanilla [verifies TRD-018] [satisfies REQ-012] [depends: TRD-018] (2h)
- [ ] TRD-019 Define and document the shared provider-skill vocabulary-block template (change-request noun, work-item noun, CLI binary, link syntax) [satisfies REQ-012] [depends: TRD-014] (2h)
  - Validates PRD ACs: AC-012-2, AC-012-3
- [ ] TRD-019-TEST Contract test: every declared provider in `config/toolchain.yaml` has a skill with a vocabulary block [verifies TRD-019] [satisfies REQ-012] [depends: TRD-014, TRD-015, TRD-016, TRD-017, TRD-018, TRD-019] (1h)

### PR 6: Content refactor + confirmation gate + lint (warn-only)
**Shippable State:** Agents resolve their SCM/gitflow provider from toolchain config or auto-detection, confirm it with the user once per session, and drive the correct CLI and vocabulary automatically — teams on GitLab or Azure DevOps no longer need to fork plugin content to get correct behavior.

- [ ] TRD-020 Implement `scripts/lint-provider-refs.js` (modeled on `scripts/lint-model-ids.js`) in report-only mode; run it against the full repo to produce a definitive baseline list of every hardcoded provider reference — a superset of the ~14 sources named in the source plan (`fix-issue`, `beads-build`, `implement-bead`, `release`, `create-prd`, `code-reviewer`, `deep-debugger`, `github-specialist`, `ensemble-orchestrator`, `git-workflow`, `tech-lead-orchestrator`, `implement-trd`, `implement-trd-beads`, `refine-trd`) [satisfies REQ-014] (5h)
  - Implementation AC: baseline output is deterministic against a checked-in fixture (resolves Testability Issue D1).
- [ ] TRD-020-TEST Baseline-discovery determinism test against fixture [verifies TRD-020] [satisfies REQ-014] [depends: TRD-020] (3h)
- [ ] TRD-021 `[RISK]` Rewrite core orchestration agent sources identified by the baseline (`ensemble-orchestrator`, `git-workflow`, `tech-lead-orchestrator`, `implement-trd`, `implement-trd-beads`, `refine-trd`) to provider-neutral prose [satisfies REQ-013] [depends: TRD-010, TRD-014, TRD-015, TRD-020] (6h)
  - Validates PRD ACs: AC-013-1, AC-013-2
- [ ] TRD-021-TEST Default-GitHub and configured-GitLab instruction-sequence tests [verifies TRD-021] [satisfies REQ-013] [depends: TRD-021] (4h)
- [ ] TRD-022 Rewrite PR/issue workflow commands identified by the baseline (`fix-issue`, `release`, `beads-build`, `implement-bead`, `create-prd`) to provider-neutral prose [satisfies REQ-013] [depends: TRD-010, TRD-014, TRD-015, TRD-020] (6h)
- [ ] TRD-022-TEST Default-GitHub and configured-GitLab instruction-sequence tests [verifies TRD-022] [satisfies REQ-013] [depends: TRD-022] (4h)
- [ ] TRD-023 Rewrite review/debug agent sources identified by the baseline (`code-reviewer`, `deep-debugger`, `github-specialist`); `github-specialist` becomes the thin GitHub-provider specialist behind the `scm` axis [satisfies REQ-013] [depends: TRD-010, TRD-014, TRD-020] (5h)
- [ ] TRD-023-TEST Provider-neutral prose regression tests [verifies TRD-023] [satisfies REQ-013] [depends: TRD-023] (3h)
- [ ] TRD-024 Rewrite any additional sources the baseline scan found beyond the 14 named above (buffer task, sized against actual discovery count) [satisfies REQ-013] [depends: TRD-020, TRD-021, TRD-022, TRD-023] (4h)
- [ ] TRD-024-TEST Coverage test: zero remaining sources outside provider skills [verifies TRD-024] [satisfies REQ-013] [depends: TRD-024] (2h)
- [ ] TRD-025 `[RISK]` Implement the once-per-session confirmation gate: presents the resolved scm/gitflow/tracker provider before an agent's first provider-driven action, caches per session, re-confirms on mid-session config change [satisfies REQ-011] [depends: TRD-010] (6h)
  - Validates PRD ACs: AC-011-1, AC-011-2, AC-011-3
- [ ] TRD-025-TEST Session-cache + mid-session-config-change re-confirmation tests [verifies TRD-025] [satisfies REQ-011] [depends: TRD-025] (4h)
- [ ] TRD-026 Re-run `scripts/lint-provider-refs.js` (still warn-only) against the fully refactored repo to confirm zero unexpected findings against the baseline [satisfies REQ-014] [depends: TRD-021, TRD-022, TRD-023, TRD-024] (3h)
  - Validates PRD ACs: AC-014-1, AC-014-2
- [ ] TRD-026-TEST Lint pass/fail behavior tests (violation inside vs. inside a provider skill) [verifies TRD-026] [satisfies REQ-014] [depends: TRD-026] (2h)
- [ ] TRD-027 Add regression coverage asserting Beads remains the sole execution layer (dependency graph, ready-work queue) regardless of the resolved tracker provider [satisfies REQ-015] [depends: TRD-021] (3h)
  - Validates PRD ACs: AC-015-1, AC-015-2
- [ ] TRD-027-TEST `implement-trd-beads` execution-path tests under `tracker: beads` and (mocked) `tracker: azure-boards` [verifies TRD-027] [satisfies REQ-015] [depends: TRD-027] (2h)

### PR 7: Diagnostics — explain mode
**Shippable State:** Users can run an explain command with a `--json` flag to see which config layer (CLI flag, env var, XDG, project file, detection, or repo default) resolved any given tool grant or toolchain provider.

- [ ] TRD-028 Implement `scripts/explain-config.js`: consumes the `{ value, source }` shape from both registries; human-readable default (`<name>: <value> (source: <layer>)`) plus `--json` output [satisfies REQ-017] [depends: TRD-002, TRD-010] (6h)
  - Validates PRD ACs: AC-017-1, AC-017-2, AC-017-3
- [ ] TRD-028-TEST Snapshot test covering all 6 distinct resolution layers across both registries [verifies TRD-028] [satisfies REQ-017] [depends: TRD-028] (4h)

### PR 8: Fail-fast validation + schema enforcement
**Shippable State:** Malformed `config/tools.yaml` or `config/toolchain.yaml` files are caught by `npm run validate` — with the offending file and key/line named — before `npm run generate` ever runs.

- [ ] TRD-029 Extend `npm run validate` to catch structural errors (syntax, toolset cycles, undeclared references) in both registry files, with file path + key/line in every error [satisfies REQ-018] [depends: TRD-002, TRD-010] (5h)
  - Validates PRD ACs: AC-018-1, AC-018-2
- [ ] TRD-029-TEST Structural-error message content tests [verifies TRD-029] [satisfies REQ-018] [depends: TRD-029] (3h)
- [ ] TRD-030 Add `schemas/toolchain-registry-schema.json`; update `schemas/agent-yaml-schema.json`/`command-yaml-schema.json` to constrain `metadata.tools` to registry-resolvable strings [satisfies REQ-019] [depends: TRD-003] (4h)
  - Validates PRD ACs: AC-019-2
- [ ] TRD-030-TEST Schema-constraint violation tests [verifies TRD-030] [satisfies REQ-019] [depends: TRD-030] (2h)

### PR 9: Joint enforcement gate — 7.0.0-beta.1 cutover
**Shippable State:** Unregistered tool names and hardcoded provider references now hard-fail CI; an unconfigured project upgrading to 7.0.0-beta.1 behaves identically to v6; a published migration guide walks forks through every breaking change.

- [ ] TRD-031 `[RISK]` Flip Layer 1 validation from warn to hard error for unregistered tool/toolset names [satisfies REQ-004] [depends: TRD-003, TRD-021, TRD-022, TRD-023] (3h)
- [ ] TRD-031-TEST Hard-failure-on-typo regression test [verifies TRD-031] [satisfies REQ-004] [depends: TRD-031] (2h)
- [ ] TRD-032 `[RISK]` Flip `lint-provider-refs.js` from warn to error in CI [satisfies REQ-014] [depends: TRD-026] (2h)
- [ ] TRD-032-TEST CI-failure-on-new-hardcoded-reference test [verifies TRD-032] [satisfies REQ-014] [depends: TRD-032] (1h)
- [ ] TRD-033 `[RISK]` Default-toolchain equivalence snapshot tests: unconfigured project's refactored commands produce identical instructions to today's v6 hardcoded content [satisfies REQ-020] [depends: TRD-005, TRD-008, TRD-021, TRD-022, TRD-023, TRD-024] (6h)
  - Validates PRD ACs: AC-020-1, AC-020-2
- [ ] TRD-033-TEST Byte-identical + instruction-sequence equivalence assertions [verifies TRD-033] [satisfies REQ-020] [depends: TRD-033] (4h)
- [ ] TRD-034 Write the migration guide under `docs/guides/` covering validation tightening, deleted translator constants, and provider-neutral content changes [satisfies REQ-021] [depends: TRD-031, TRD-032] (4h)
  - Validates PRD ACs: AC-021-1, AC-021-2
- [ ] TRD-034-TEST Guide-exists-at-beta-tag checklist test [verifies TRD-034] [satisfies REQ-021] [depends: TRD-034] (2h)
- [ ] TRD-035 `[RISK]` Add a release-checklist/CI gate enforcing REQ-022 — blocks a `7.0.0-beta.1` tag unless both Workstream A (PR 1-3) and Workstream B (PR 4-6) content refactors are verifiably complete [satisfies REQ-022] [depends: TRD-033, TRD-034] (4h)
  - Validates PRD ACs: AC-022-1, AC-022-2
  - Implementation AC: test BOTH scenarios explicitly — (a) Workstream A complete, B incomplete → tag blocked; (b) both complete → tag proceeds and both enforcement flips land together (resolves Task Coverage Issue B2).
- [ ] TRD-035-TEST Both-scenario release-gate simulation tests (block case + pass case) [verifies TRD-035] [satisfies REQ-022] [depends: TRD-035] (2h)

## Sprint Planning

*(Informational grouping only — `implement-trd-beads` parses `### PR N:` sections above, not this section.)*

## Sprint 1: Tool Grants Registry (Workstream A)
PR 1, PR 2, PR 3 — registry, generator integration, runtime translator integration. ~59h.

## Sprint 2: Toolchain Foundation (Workstream B, part 1)
PR 4, PR 5 — toolchain registry, detection, provider skill extraction. ~59h.

## Sprint 3: Content Refactor (Workstream B, part 2)
PR 6 — the largest single PR: content refactor, confirmation gate, lint enforcement. ~51h.

## Sprint 4: Diagnostics and Validation Hardening
PR 7, PR 8 — explain mode, fail-fast validation, schema enforcement. ~24h.

## Sprint 5: Release Cutover
PR 9 — joint enforcement gate, compatibility proof, migration guide, beta-gate tooling. **Note:** `TRD-035` sits at dependency depth 6 from `TRD-001` (`TRD-001→TRD-002→TRD-021→TRD-024→TRD-033→TRD-035`) — this is an accepted characteristic of a 9-PR stacked release culminating in a single cutover gate, not a design oversight (Dependency Issue C1). Plan this sprint's start date accordingly; it cannot begin meaningfully until Sprints 1-4 are fully merged. ~24h.

**Total estimated effort:** ~217h across 35 implementation tasks + 35 test tasks (70 total).

## Quality Requirements

- **Security:** Confirmation gate (TRD-025) prevents an agent from silently acting against an unintended SCM/tracker platform; registry/schema validation (TRD-029, TRD-030) prevents malformed config from reaching generation. Runtime enforcement of tool grants remains explicitly out of scope (permitter hook's job, per PRD Non-Goals).
- **Performance:** Registry loading and detection must not add perceptible latency to `npm run validate`/`npm run generate` or to per-session agent startup; both resolvers are pure in-memory YAML parses plus (for detection) a handful of cheap shell/filesystem checks, not network calls.
- **Accessibility:** All validation, lint, and explain-mode output is plain text — no meaning conveyed by color alone — so it is equally usable in CI logs and terminals without color support.
- **Testing standards:** Jest across all touched packages, consistent with the existing test suite; golden-file and snapshot tests (TRD-005, TRD-008, TRD-033) are load-bearing and must run in CI on every PR, not just at merge to `main`.

## Acceptance Criteria Traceability

| REQ-NNN | Description | Implementation Tasks | Test Tasks |
|---|---|---|---|
| REQ-001 | Central tool grants registry | TRD-001, TRD-002 | TRD-001-TEST, TRD-002-TEST |
| REQ-002 | Composable named toolsets | TRD-001, TRD-002 | TRD-001-TEST, TRD-002-TEST |
| REQ-003 | Multi-source override resolution (Layer 1) | TRD-002 | TRD-002-TEST |
| REQ-004 | Hard validation of unknown tool/toolset names | TRD-003, TRD-031 | TRD-003-TEST, TRD-031-TEST |
| REQ-005 | Generators consume registry, output unchanged | TRD-004, TRD-005 | TRD-004-TEST, TRD-005-TEST |
| REQ-006 | Runtime translators consume registry | TRD-006, TRD-007, TRD-008 | TRD-006-TEST, TRD-007-TEST, TRD-008-TEST |
| REQ-007 | Central toolchain registry with capability axes | TRD-009, TRD-010 | TRD-009-TEST, TRD-010-TEST |
| REQ-008 | Multi-source override resolution (Layer 2) | TRD-010 | TRD-010-TEST |
| REQ-009 | Auto-detection of scm/gitflow/tracker providers | TRD-011, TRD-013 | TRD-011-TEST, TRD-013-TEST |
| REQ-010 | Explicit failure on ambiguous detection | TRD-012 | TRD-012-TEST |
| REQ-011 | Confirmation gate before acting on resolved provider | TRD-025 | TRD-025-TEST |
| REQ-012 | Provider skills per axis/provider pair | TRD-014, TRD-015, TRD-016, TRD-017, TRD-018, TRD-019 | TRD-014-TEST, TRD-015-TEST, TRD-016-TEST, TRD-017-TEST, TRD-018-TEST, TRD-019-TEST |
| REQ-013 | Content refactor to provider-neutral prose | TRD-021, TRD-022, TRD-023, TRD-024 | TRD-021-TEST, TRD-022-TEST, TRD-023-TEST, TRD-024-TEST |
| REQ-014 | CI enforcement against hardcoding creep | TRD-020, TRD-026, TRD-032 | TRD-020-TEST, TRD-026-TEST, TRD-032-TEST |
| REQ-015 | Beads remains the sole execution layer | TRD-027 | TRD-027-TEST |
| REQ-016 | 7.0 axis scope and shipped-provider gating | TRD-009 | TRD-009-TEST |
| REQ-017 | Resolution explain mode | TRD-028 | TRD-028-TEST |
| REQ-018 | Fail-fast structural validation | TRD-029 | TRD-029-TEST |
| REQ-019 | Schema-backed enforcement | TRD-003, TRD-030 | TRD-003-TEST, TRD-030-TEST |
| REQ-020 | Behaviorally inert upgrade for unconfigured projects | TRD-033 | TRD-033-TEST |
| REQ-021 | Published migration guide | TRD-034 | TRD-034-TEST |
| REQ-022 | Joint enforcement gate at 7.0 beta cutover | TRD-035 | TRD-035-TEST |

**Traceability check: 22 requirements covered, 0 uncovered, 0 orphaned annotations.**

## Design Readiness Scorecard

| Dimension | Score (1-5) | Notes |
|---|---|---|
| Architecture completeness | 5 | All components, interfaces (resolver `{value, source}` convention), and data flows defined; both self-critique issues (A1, A2) resolved in-line before output |
| Task coverage | 5 | Every REQ-NNN has ≥1 implementation task and ≥1 paired test task; every PR has a user-observable Shippable State; no orphaned `[satisfies]` annotations |
| Dependency clarity | 4 | All dependencies explicit and acyclic; one long chain (depth 6, `TRD-035`) is real and called out explicitly in Sprint Planning rather than hidden |
| Estimate confidence | 5 | No task exceeds 6h (none require further breakdown); the ambiguous discovery-vs-refactor ordering issue (B1) was resolved by resequencing PR 6 |

**Overall score: 4.75 — PASS** (≥4.0 threshold)

**Gate decision:** PASS. Proceeding to output.

---

**Next steps:**
- `/ensemble:configure-team docs/TRD/TRD-2026-b6939c7c-config-driven-tools.md` — auto-configure team roles and agent assignments
- `/ensemble:implement-trd-beads docs/TRD/TRD-2026-b6939c7c-config-driven-tools.md` — begin stacked-PR implementation
