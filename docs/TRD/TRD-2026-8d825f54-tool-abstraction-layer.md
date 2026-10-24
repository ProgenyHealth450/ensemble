---
document_id: TRD-2026-8d825f54
label: trd-tool-abstraction-layer
prd_reference: docs/PRD/PRD-2026-8d825f54-tool-abstraction-layer.md
version: 1.0.1
status: Draft
date: 2026-10-21
design_readiness_score: 4.0
kind: trd
Constitution compliance: passed
ensemble_implement_trd_beads:
  branch_name: feature/trd-2026-8d825f54-tool-abstraction-layer-pr-1
  use_proposed: true
  stacked_prs: true
---

# TRD-2026-8d825f54: Tool Abstraction Layer for Ensemble

**Source PRD:** `docs/PRD/PRD-2026-8d825f54-tool-abstraction-layer.md` (v1.0.1, readiness 4.0, PASS, Locked)

## Capability Reuse Check

`node packages/development/lib/trd-graph-cli.js capabilities docs/TRD --json` returned an empty registry and `overlap` found no foundational TRD for this domain. **Reused Capabilities: none.** `TRD-2026-b6939c7c-config-driven-tools` (Draft, nothing implemented) describes an earlier Layer 2 toolchain design; this TRD supersedes its Layer 2 tasks (TRD-009 to TRD-030 there) and leaves its Layer 1 tool-grants tasks (TRD-001 to TRD-008) untouched. No task here depends on a task there.

## Architecture Decision

### Alternatives Considered

| Option | Approach | Pros | Cons |
|---|---|---|---|
| A: Prose-only adapters | Adapter is a skill; the agent follows its prose and normalizes tool output itself | Smallest build; fully editable | Cannot route internal CLIs deterministically (REQ-016), cannot validate output (REQ-022), cannot deny at runtime (REQ-023); behavior varies per model |
| **B: Manifest plus runner (chosen)** | Adapter is a skill directory: `SKILL.md` (vocabulary and agent-facing prose) plus a declarative `adapter.yaml` (capability command templates, output mapping, allowlist, health check, detection signals, required env names). A core resolver library and `toolchain-cli` execute capabilities deterministically | Meets PRD (adapter is a skill), Rule 8 (editable without rebuild), Rule 5 (enforcement in code), REQ-016 (CLIs call the same library) | New resolver, runner, manifest schema and output-mapping engine to build and test |
| C: Executable plugin adapters | Separately packaged executables speaking a versioned JSON protocol | Arbitrary logic; strongest isolation | Contradicts the PRD's skills-as-contract decision; fails Rule 8; needs per-OS packaging and a protocol |

**Rationale:** B is the only option that makes every PRD guarantee a code-enforced property while keeping adapters user-editable data. The requester selected B at the architecture gate.

### Interpretations and Resolved Design Issues

- **I1: plain version control.** The PRD taxonomy has no plain `git` category, yet about 45 sources invoke it. Plain `git` operations (status, commit, push, log, diff, merge-base) are `vcs.*` capabilities of the `workflow` category, whose default adapter is `plain-git`; the `git-town` adapter extends it. Recommend a PRD refine pass to name this explicitly.
- **I2: ambiguity versus no signal (PRD REQ-009 AC-2 vs REQ-010 AC-2).** "No detectable signal" means no signal source exists at all (no remote, no marker files); the shipped default is used. "Ambiguous" means two or more installed adapters match, or a signal source exists (for example a remote URL) but matches no installed adapter; resolution fails explicitly in non-interactive runs and asks in interactive runs.
- **I3: AC-023-2 (governed boundary denies).** The runner is invoked through the shell tool, so a command that was not granted the shell tool cannot run any adapter; an adapter therefore cannot widen grants. The runner additionally denies any command outside the adapter's binary-plus-subcommand allowlist. Denial of raw shell commands typed by an agent outside the runner remains host-enforced (hooks on Claude Code; none in this repo for Pi, OpenCode or Codex); the lint (REQ-019) keeps commands from issuing raw tool calls. This residual is recorded in the Threat Model.
- **I4: confirmation session identity.** No stable session id is exposed uniformly across runtimes. TRD-017 begins with a spike that records which id each runtime exposes (`ENSEMBLE_SESSION_ID`, host session variables); the passive confirmation record is keyed by `(sessionKey, category, adapter, configHash)` and falls back to the run id when no session id exists.
- **I5: repo-local adapters are untrusted by default.** A cloned repository can ship `.ensemble/adapters/`. Repo-local adapters resolve in every mode (satisfying AC-007-3) but a non-interactive run additionally requires the adapter name in the user's `trustedRepoAdapters` list; an interactive run shows the adapter's allowlist at first-use confirmation.
- **I6: no new runtime dependency.** The output-mapping engine uses a small dotted-path projection (`$.a.b[0]`, `|` alternation for "array or object"), not a JSONPath library, because constitution section 4 requires approval for new dependencies.
- **I7: work-graph selection.** `work-graph` is its own category with default `auto`: use the work-graph capabilities of the resolved tracker adapter when its manifest provides them; otherwise use the built-in `work-graph-links-fallback` adapter (tracker dependency links, then plan order stated as not dependency-aware). One manifest may implement several categories.
- **I8: PRD BDD floor.** Fourteen PRD requirements (REQ-001, 002, 004, 005, 006, 009, 010, 012, 015, 018, 021, 022, 024, 025) have two ACs, below the command's three-scenario floor. The test tasks specify exactly one scenario per AC; recommend a PRD refine pass to add edge or error ACs.
- **I10: packaging.** `packages/development` depends only on `js-yaml` and its libraries require only siblings, so the resolver library, category contracts, default selection, schemas and tool inventory all ship inside `packages/development` (`lib/toolchain/` and `toolchain/`). A standalone plugin install and the Pi vendor bundle therefore contain everything; other packages call `toolchain-cli` through `TOOLCHAIN_CLI` rather than importing it.
- **I9: preflight is enforced in code.** `toolchain-cli run` refuses a side-effecting capability unless a passing preflight record exists for the supplied `--run-id`; the command prose cannot silently skip preflight.

## System Architecture

### Components

| Component | Location | Responsibility |
|---|---|---|
| Category contracts | `packages/development/toolchain/categories/<category>.yaml` | Per-category versioned contract (14 categories): capabilities, required or optional, inputs, normalized output schema reference, `sideEffect` flag, documented fallback |
| Default selection | `packages/development/toolchain/toolchain.default.yaml` | Shipped default adapter per category |
| Schemas | `packages/development/toolchain/schemas/toolchain-config-schema.json`, `adapter-manifest-schema.json`, `category-contract-schema.json`, `packages/development/toolchain/schemas/normalized/*.json` | Structural validation (Ajv in-process, as `scripts/lib/schema-validator.js`) |
| Resolver library | `packages/development/lib/toolchain/` (`config.js`, `contracts.js`, `adapters.js`, `detect.js`, `resolve.js`, `preflight.js`, `runner.js`, `mapping.js`, `ledger.js`, `confirm.js`, `validate.js`) | Config precedence, adapter discovery, detection, preflight, allowlisted execution, output normalization, failure record, confirmation record |
| CLI | `packages/development/lib/toolchain-cli.js` | JSON CLI over the library: `resolve`, `explain`, `preflight`, `run`, `confirm-status`, `confirm-record`, `validate`; resolved by the tool-path-resolution skill as `TOOLCHAIN_CLI` |
| Adapters | `packages/<pkg>/skills/adapter-<category>-<name>/{SKILL.md,adapter.yaml}` | One per tool; repo-local ones live in `.ensemble/adapters/`, user ones in `$XDG_CONFIG_HOME/ensemble/adapters/` |
| Built-in adapter | `packages/development/lib/toolchain/builtin/work-graph-links-fallback` | Ordering from tracker links, else plan order |
| Command surface | command YAML `capabilities: {required: [], optional: []}` | Validated by `schemas/command-yaml-schema.json`; commands call `toolchain-cli` instead of tool binaries |
| Lint | `scripts/lint-provider-refs.js` | Fails CI on a tool binary outside an adapter; wired into `npm run validate` |
| State | `.ensemble/state/toolchain/` | `ledger-<runId>.jsonl`, `failure-<runId>.json`, `confirmations/<hash>.json` (passive records only; no retry, resume or scheduling) |

### Data Flow

1. A command starts and calls `toolchain-cli preflight --require <capabilities> [--non-interactive]`. The library loads config (project `.ensemble/toolchain.yaml`, then user XDG `toolchain.yaml`, then detection from adapter-declared signals, then `packages/development/toolchain/toolchain.default.yaml`), plus compatibility inputs (`ENSEMBLE_PR_BACKEND`, `ENSEMBLE_BRANCHING_STRATEGY`), and returns `{category -> {adapter, source}}`.
2. Preflight runs each needed adapter's health checks (10 s default, per-adapter override). Any failure halts before any side effect and exits non-zero naming the check. A pass writes a preflight record and returns a `runId`.
3. Interactive session and the next call is a write outside the working tree: `toolchain-cli confirm-status` reports whether `(sessionKey, category, adapter, configHash)` is confirmed; if not, the command asks via `AskUserQuestion` (rewritten to `ask` on Pi/OMP) and calls `confirm-record`. Non-interactive runs skip the prompt and log adapter and source.
4. `toolchain-cli run <category.capability> --arg k=v --run-id R`: the runner validates args against the contract, builds an argv array from the manifest template (no shell), checks it against the allowlist (binary plus subcommand), executes with a timeout, maps stdout to the normalized shape via the manifest's `parse` block, validates the shape against `packages/development/toolchain/schemas/normalized/*.json`, appends side-effecting calls to the ledger, and prints `{ok, capability, adapter, data}`.
5. If a required capability is missing the command halts before side effects; if an optional one is missing the runner returns `{ok:false, unavailable:true, fallback:"<id>"}` and the command follows the contract's documented fallback.
6. On adapter failure after side effects, the runner stops, writes `failure-<runId>.json` (adapter, capability, completed side effects from the ledger, redacted), also to `FOREMAN_ARTIFACT_PATH` when set, and never retries or resumes.
7. Internal CLIs in `packages/development` (`trd-cli`, `beads-label`, `complexity-analyzer`) call the same library in-process; `packages/e2e-testing/lib/pr-state.js` calls `toolchain-cli` through `TOOLCHAIN_CLI`. None exec tracker or host binaries directly.

### Interfaces and Formats

- **Adapter manifest (`adapter.yaml`):** `adapter`, `version`, `categories[]`, `contract` (per category, `major.minor`), `binaries[]`, `allowlist[]` (`{bin, sub[]}`), `env[]` (required variable names only), `health[]` (`{id, run[], timeoutMs}`), `detect[]` (`{signal: remote_url_matches|file_exists|dir_exists|git_config_set, ...}`), `capabilities{<category.capability>: {run[], parse{format, root, map{}, statusMap{}}}}`.
- **Normalized work item:** `{id, title, description, type, status(open|in_progress|closed), priority, labels[], dependencies[{id,type}], dependents[], comments[], externalRef}`.
- **Normalized change request:** `{id, url, state, baseBranch, headBranch, checks[]}`.
- **Runner envelope:** `{ok, capability, adapter, source, data}` or `{ok:false, error:{code, message}}`; codes include `UNAVAILABLE`, `NOT_ALLOWED`, `HEALTH_FAILED`, `PREFLIGHT_REQUIRED`, `BAD_OUTPUT`, `AMBIGUOUS_PROVIDER`.
- **Contract versioning:** per category `major.minor`; additive-only within a major; adapters declare targeted contract; validation compares majors.

### Error and Failure-Recovery Paths

Missing or unauthenticated tool: preflight halts, nothing created. Mid-run failure: stop, write failure record, no retry (constitution Rule 4). Malformed tool output: reject with `BAD_OUTPUT`, never pass through. Ambiguous detection: explicit error in non-interactive runs. Hung tool: timeout then failure record.

### Integration Points

| Integration | Protocol/Format | Notes |
|---|---|---|
| Adapter binaries (tracker, host, workflow, CI, test runners) | argv arrays through `execFile`, no shell | Allowlisted per adapter; credentials from environment variable names the manifest declares, never values |
| User and project config | YAML files `.ensemble/toolchain.yaml`, `$XDG_CONFIG_HOME/ensemble/toolchain.yaml` | Locations as in `PRD-2026-b6939c7c`; reuse `packages/development/lib/toolchain/config-path.js` |
| Runtime delivery | Pi vendoring through lib-bundler; Codex and OpenCode copiers extended | Resolution is code, so adapter discovery does not depend on each runtime's skill discovery |
| CI | `npm run validate` runs schema checks, adapter conformance, lint | Lint is an error from the first release |

## Threat Model

**Trigger:** the PRD adds a new third-party integration surface (adapters that run shell commands against external trackers and hosts), handles credentials for them, and reaches external network services (REQ-007, REQ-022, REQ-023; components: runner, adapter discovery, manifest).

### Assets

- Credentials for trackers and hosts: environment variables and tool login state on the user's machine.
- Repository contents and push rights; change requests and work items on external systems.
- Integrity of provider selection (writing to the wrong system has external consequences).
- Availability of a command run (a hung adapter blocks it).

### Trust Boundaries

1. Repo-local config or adapter (untrusted clone) to the runner.
2. Manifest command template and args to the process spawner.
3. External tool output to the normalizer and then to the agent.
4. Third-party adapter package to the user's machine.
5. Failure record to disk and to `FOREMAN_ARTIFACT_PATH`.

### Threats and Mitigations

| Boundary | STRIDE | Threat | L/I | Mitigation | Mitigating task |
|---|---|---|---|---|---|
| 1 | Elevation of privilege | A cloned repo ships `.ensemble/adapters/evil` or a `.ensemble/toolchain.yaml` selecting it, so commands run attacker commands | M/H | Repo-local adapters need user-level trust in non-interactive runs; interactive first use shows the allowlist and asks | TRD-006, TRD-017 |
| 2 | Tampering | Argument values (issue titles, branch names) inject extra flags or shell metacharacters | H/H | argv arrays only, no shell; per-argument validation against contract types; reject leading `-` where a value is expected | TRD-010, TRD-011 |
| 2 | Elevation of privilege | Adapter command exceeds its declared binaries or subcommands | M/H | Static allowlist validation plus runtime allowlist check on every call at binary-plus-subcommand level | TRD-008, TRD-011 |
| 3 | Spoofing | Tool output crafted (for example a work item title) to pass instructions to the agent or malformed data downstream | M/M | Output validated against normalized JSON schemas; unmatched shape rejected as `BAD_OUTPUT`; free text carried as data fields only | TRD-012 |
| 1/2 | Information disclosure | Credentials written into config, adapter files, ledger or failure records | M/H | Credential scan in validation; manifests hold env variable names only; failure record redacts configured and well-known secret patterns | TRD-008, TRD-015 |
| 2 | Repudiation/Tampering | Side effects occur with no record of what completed | L/M | Append-only ledger of side-effecting calls feeding the failure record | TRD-015 |
| 2 | Denial of service | A hung tool stalls a run | M/L | Per-call and health-check timeouts (10 s default for health) | TRD-011, TRD-014 |
| 4 | Spoofing | A resolved adapter silently differs from the user's expectation, causing writes to the wrong system | M/H | Explicit failure on ambiguity; interactive confirmation before first external write; non-interactive logs adapter and source | TRD-016, TRD-017 |
| 2 | Elevation of privilege | A command skips preflight and writes before checks pass | M/M | Runner refuses side-effecting capabilities without a passing preflight record for the run | TRD-014 |

### Residual Risks

- Raw shell commands typed by an agent outside the runner are denied only by the host (Claude Code hooks); Pi, OpenCode and Codex have no gate in this repo. Mitigated by the lint and command refactors; accepted, revisit when those hosts expose tool-call gates. Owner: Ensemble maintainers.
- Confirmation caching depends on a session id the runtimes may not expose (I4); the fallback is the run id, which can prompt more often. Revisit after the TRD-017 spike.
- A third-party adapter's allowlist is declared by that adapter's author; the user must still judge the adapter before installing it. Signed adapters are an explicit PRD non-goal.

## Master Task List

### PR 1: Contract and config foundation
**Shippable State:** A user can run a command that prints, for each of the 14 tool categories, which adapter is selected and whether it came from project config, user config, detection or the shipped default.

- [ ] **TRD-001** Define the 14-category taxonomy (host, workflow, worktree, tracker, work-graph, ci-local, review, lint, test-runner, e2e-quality, container-deploy, iac, platform-cloud, package-runner) and the category-contract schema; create `packages/development/toolchain/schemas/category-contract-schema.json`, skeleton `packages/development/toolchain/categories/<category>.yaml` files (capabilities with inputs, outputs, required/optional, `sideEffect`, fallback id) and `packages/development/lib/toolchain/contracts.js` (`loadContracts()`, `validateContract()`) [satisfies REQ-001, REQ-002] (6h)
  - Validates PRD ACs: AC-002-1
  - Implementation AC:
    - [ ] Given the repo after this task, when `ls packages/development/toolchain/categories/*.yaml` runs, then exactly 14 files exist named for the 14 categories listed above.
    - [ ] Given any `packages/development/toolchain/categories/<category>.yaml`, when `validateContract()` in `packages/development/lib/toolchain/contracts.js` runs, then every capability has non-empty `inputs`, `outputs` and a boolean `required` field, or the validator returns an error naming the file and capability.
    - [ ] Given a contract fixture with a capability missing `outputs`, when `validateContract()` runs, then it returns an error naming that capability (unit test in `scripts/tests/toolchain-contracts.test.js`).
- [ ] **TRD-001-TEST** Verify every capability states inputs, outputs and required/optional status [verifies TRD-001] [satisfies REQ-002] [depends: TRD-001] (2h)
  - Validates PRD ACs: AC-002-1
  - Test AC:
    - [ ] Scenario: Contract capabilities are fully stated -- Given a category, When its contract is read through `loadContracts()`, Then every capability states inputs, outputs and required/optional status and a capability missing any of them fails validation.

- [ ] **TRD-002** Implement per-category contract versioning in `packages/development/lib/toolchain/contracts.js`: each contract carries `version: major.minor`, an additive-only rule (within a major, capabilities and optional fields may be added, never removed or retyped), and `checkCompat(adapterTarget, contract)` returning `{ok, unavailableCapabilities, missingCapabilities, errors}` [satisfies REQ-003] [depends: TRD-001] (5h)
  - Validates PRD ACs: AC-003-1, AC-003-2, AC-003-3
  - Implementation AC:
    - [ ] Given an adapter targeting `1.0` and a contract at `1.1` that adds capability `x`, when `checkCompat` runs, then `ok` is true and `unavailableCapabilities` contains `x`.
    - [ ] Given an adapter targeting `1.x` and an installed contract `2.0`, when `checkCompat` runs, then `ok` is false and the error text names both version strings and every capability the adapter lacks.
    - [ ] Given the tracker contract version is bumped to `2.0` in a test fixture, when `checkCompat` runs for the host and workflow categories, then their results are identical to the results before the bump.
    - [ ] Given a contract diff that removes a capability within the same major, when the additive-only check in `scripts/tests/toolchain-contract-version.test.js` runs, then it fails naming the removed capability.
- [ ] **TRD-002-TEST** Verify additive-only contract versioning behavior [verifies TRD-002] [satisfies REQ-003] [depends: TRD-002] (3h)
  - Validates PRD ACs: AC-003-1, AC-003-2, AC-003-3
  - Test AC:
    - [ ] Scenario: Minor contract bump keeps adapter valid -- Given an adapter targeting contract 1.x and a later 1.y contract adding a capability, When the adapter is resolved, Then it still validates and the new capability is treated as unavailable.
    - [ ] Scenario: Major contract mismatch fails -- Given an adapter targeting contract 1.x and an installed contract 2.x, When the adapter is resolved, Then validation fails naming the contract versions and the capabilities the adapter lacks.
    - [ ] Scenario: Tracker major bump is isolated -- Given the tracker contract moves to a new major version, When adapters for other categories are resolved, Then their validation result is unchanged.

- [ ] **TRD-003** Create `packages/development/toolchain/schemas/toolchain-config-schema.json`, `packages/development/toolchain/toolchain.default.yaml` (one default adapter per category; `work-graph` is `auto`) and the loader `packages/development/lib/toolchain/config.js` (`resolveCategory(category, ctx)` returning `{value, source}`) with precedence project `.ensemble/toolchain.yaml` > user `$XDG_CONFIG_HOME/ensemble/toolchain.yaml` (path via a new `packages/development/lib/toolchain/config-path.js` that mirrors the XDG logic of `packages/core/lib/config-path.js` without importing it, so the development package stays self-contained) > detection (hook, injected until TRD-016) > shipped default; read compat inputs `ENSEMBLE_PR_BACKEND` and `ENSEMBLE_BRANCHING_STRATEGY` as config-level inputs; schema also allows a user-level `trustedRepoAdapters` list [satisfies REQ-009] [depends: TRD-001] (6h)
  - Validates PRD ACs: AC-009-1, AC-009-2
  - Implementation AC:
    - [ ] Given project config selects `a` and user config selects `b` for `tracker`, when `resolveCategory('tracker')` runs, then it returns `{value:'a', source:'project'}`.
    - [ ] Given no config files and no detection signal, when `resolveCategory('tracker')` runs, then it returns the `tracker` value from `packages/development/toolchain/toolchain.default.yaml` with `source:'default'`.
    - [ ] Given a config file with an unknown category key, when the loader validates it against `packages/development/toolchain/schemas/toolchain-config-schema.json`, then it throws an error naming the file and the key.
    - [ ] Given `ENSEMBLE_PR_BACKEND=azure-devops` and no config files, when `resolveCategory('host')` runs, then the value is `azure-devops` with `source:'env-compat'`; this is covered in `scripts/tests/toolchain-config.test.js`.
- [ ] **TRD-003-TEST** Verify provider selection precedence chain [verifies TRD-003] [satisfies REQ-009] [depends: TRD-003] (3h)
  - Validates PRD ACs: AC-009-1, AC-009-2
  - Test AC:
    - [ ] Scenario: Project config beats user config -- Given project config selects adapter A and user config selects adapter B for a category, When resolved, Then A wins.
    - [ ] Scenario: Shipped default fallback -- Given no config and no detectable signal, When resolved, Then the shipped default is used.

- [ ] **TRD-004** Implement `packages/development/lib/toolchain-cli.js` with `resolve` and `explain` subcommands (human table by default, `--json` envelope `{ok, data:{category:{adapter, source}}}`), exporting its functions and guarding `main` with `require.main === module` as `trd-cli.js` does [satisfies REQ-012] [depends: TRD-003] (5h)
  - Validates PRD ACs: AC-012-1, AC-012-2
  - Implementation AC:
    - [ ] Given a temp project whose remote URL is matched by a detection hook for `host`, when `toolchain-cli explain` runs, then the `host` row shows the adapter name and source `detection`.
    - [ ] Given the same project, when `toolchain-cli explain --json` runs, then stdout parses as JSON and contains, for every one of the 14 categories, the same `adapter` and `source` values as the human output.
    - [ ] Given a 1,000-file fixture repo with project config, when `toolchain-cli resolve --json` (no health checks) runs five times, then the median completes in under 500 ms
    - [ ] Given an unknown subcommand, when `toolchain-cli` runs, then it exits non-zero with a JSON error `{ok:false,error:{code,message}}` when `--json` is set; unit tests live in `scripts/tests/toolchain-cli.test.js`.
- [ ] **TRD-004-TEST** Verify explain output in human and machine-readable form [verifies TRD-004] [satisfies REQ-012] [depends: TRD-004] (3h)
  - Validates PRD ACs: AC-012-1, AC-012-2
  - Test AC:
    - [ ] Scenario: Explain shows adapter and source -- Given a project with detection-resolved adapters, When explain runs, Then each category shows adapter and source (for example "detection").
    - [ ] Scenario: Explain structured output -- Given the structured-output option, When explain runs, Then the same fields appear in machine-readable form.

### PR 2: Adapter manifest, discovery, validation
**Shippable State:** A user or third party can drop an adapter skill into a repo-local, user or installed location, select it in configuration, and get a clear pass or named-failure result when validating it, with a missing-adapter error that says how to install it.

- [ ] **TRD-005** Create `packages/development/toolchain/schemas/adapter-manifest-schema.json` for `adapter.yaml` (`adapter`, `version`, `categories[]`, per-category `contract`, `binaries[]`, `allowlist[{bin,sub[]}]`, `env[]` names only, `health[{id,run[],timeoutMs}]`, `detect[]`, `capabilities{}`, optional per-capability `variants{<selectorArg>: {<value>: run[]}}`) and `packages/development/lib/toolchain/validate.js` `validateManifest(dir)` plus `checkVocabularyBlock(skillMdPath)` requiring a `## Vocabulary` block in the adapter `SKILL.md` [satisfies REQ-005] [depends: TRD-001] (7h)
  - Validates PRD ACs: AC-005-2
  - Implementation AC:
    - [ ] Given an adapter directory whose `SKILL.md` has no `## Vocabulary` heading, when `validateManifest` runs, then it returns an error containing the `SKILL.md` path and the text `Vocabulary`.
    - [ ] Given an `adapter.yaml` missing `allowlist`, when `validateManifest` runs, then the error names the file and the missing property.
    - [ ] Given a capability whose `variants` selector arg is not declared as a contract input, when `validateManifest` runs, then the error names the capability and the selector.
    - [ ] Given a valid manifest and `SKILL.md`, when `validateManifest` runs, then it returns no errors (tests in `scripts/tests/toolchain-manifest.test.js`).
- [ ] **TRD-005-TEST** Verify a missing vocabulary block fails validation [verifies TRD-005] [satisfies REQ-005] [depends: TRD-005] (2h)
  - Validates PRD ACs: AC-005-2
  - Test AC:
    - [ ] Scenario: Missing vocabulary block -- Given an adapter skill missing its vocabulary block, When validation runs, Then it fails naming the file and the missing block.

- [ ] **TRD-006** Implement adapter discovery in `packages/development/lib/toolchain/adapters.js` (`discoverAdapters(ctx)`, `loadAdapter(name, ctx)`): search order repo-local `.ensemble/adapters/`, user `$XDG_CONFIG_HOME/ensemble/adapters/` (via `packages/development/lib/toolchain/config-path.js`), then installed package roots (`packages/*/skills/adapter-*`); reading `adapter.yaml` and `SKILL.md` fresh on every call with no cache or build; selecting an uninstalled adapter returns `NOT_INSTALLED` naming the adapter and an install hint; repo-local adapters resolve in all modes but in non-interactive mode need the name in the user's `trustedRepoAdapters` [satisfies REQ-005, REQ-007] [RISK] [depends: TRD-003, TRD-005] (7h)
  - Validates PRD ACs: AC-005-1, AC-007-1, AC-007-2, AC-007-3
  - Implementation AC:
    - [ ] Given an adapter dir under a temp `XDG_CONFIG_HOME/ensemble/adapters/` selected in user config, when `loadAdapter` runs, then it resolves with `origin:'user'` and no file under `packages/` is modified.
    - [ ] Given a selected adapter name found in no search location, when `loadAdapter` runs, then the error code is `NOT_INSTALLED` and the message contains the adapter name and an install instruction.
    - [ ] Given `.ensemble/adapters/foo/adapter.yaml` and `foo` selected in project config, when `loadAdapter` runs interactively, then it resolves with `origin:'repo-local'`; when run non-interactively and `foo` is not in `trustedRepoAdapters`, then it fails with an error naming `foo` and the trust setting.
    - [ ] Given an adapter whose `adapter.yaml` capability `run` template is edited between two calls in one process, when `loadAdapter` runs twice, then the second result reflects the edit (test in `scripts/tests/toolchain-adapters.test.js`).
- [ ] **TRD-006-TEST** Verify adapter discovery and no-build edit behavior [verifies TRD-006] [satisfies REQ-005, REQ-007] [depends: TRD-006] (4h)
  - Validates PRD ACs: AC-005-1, AC-007-1, AC-007-2, AC-007-3
  - Test AC:
    - [ ] Scenario: Edited capability takes effect without a build -- Given an adapter skill file, When a user edits a capability section and reruns a command, Then the command uses the edited behavior with no build step.
    - [ ] Scenario: External adapter used without source change -- Given an adapter authored outside the ensemble repository, When it is installed and selected in configuration, Then commands use it with no ensemble source change.
    - [ ] Scenario: Missing adapter error -- Given a selected adapter that is not installed, When resolution runs, Then it fails naming the missing adapter and how to install it.
    - [ ] Scenario: Repo-local adapter resolves -- Given an adapter placed in a repo-local skills directory, When it is selected in configuration, Then it resolves with no packaging or publishing step.

- [ ] **TRD-007** Implement the conformance validator `validateConformance(adapter, contract)` in `packages/development/lib/toolchain/validate.js`: every `required` capability of each declared category must exist in the manifest, declared inputs and outputs must match the contract, and contract compatibility uses `checkCompat` from TRD-002; add `toolchain-cli validate <adapter-dir>` wiring in `packages/development/lib/toolchain-cli.js` [satisfies REQ-008, REQ-003] [depends: TRD-002, TRD-005, TRD-006] (6h)
  - Validates PRD ACs: AC-008-1, AC-008-2
  - Implementation AC:
    - [ ] Given a manifest for category `tracker` lacking required capability `tracker.show`, when `validateConformance` runs, then it fails and the error contains `tracker.show`.
    - [ ] Given a manifest implementing every required capability at a compatible contract version, when `validateConformance` runs, then it returns `{ok:true, errors:[]}`.
    - [ ] Given a manifest targeting a different major contract, when `validateConformance` runs, then it fails with the `checkCompat` message naming both versions (tests in `scripts/tests/toolchain-conformance.test.js`).
- [ ] **TRD-007-TEST** Verify conformance validation pass and fail [verifies TRD-007] [satisfies REQ-008] [depends: TRD-007] (3h)
  - Validates PRD ACs: AC-008-1, AC-008-2
  - Test AC:
    - [ ] Scenario: Missing required capability fails -- Given an adapter missing a required capability, When conformance validation runs, Then it fails naming the capability.
    - [ ] Scenario: Conforming adapter passes -- Given a conforming adapter, When conformance validation runs, Then it passes.

- [ ] **TRD-008** Implement static validation in `packages/development/lib/toolchain/validate.js`: `validateAllowlist(manifest)` checks that the first element of every capability and health `run` argv is a declared binary and that its subcommand appears in that binary's `allowlist[].sub`; `scanCredentials(files)` rejects literal credentials (well-known token prefixes, `password|secret|token` keys with literal values) in `adapter.yaml`, `SKILL.md` and toolchain config, permitting env var names [satisfies REQ-022, REQ-023] [RISK] [depends: TRD-005] (6h)
  - Validates PRD ACs: AC-022-1, AC-023-1, AC-023-3
  - Implementation AC:
    - [ ] Given a capability whose `run[0]` is `curl` while `binaries` lacks `curl`, when `validateAllowlist` runs, then the error names the adapter and the binary `curl`.
    - [ ] Given a capability calling `br` with subcommand `delete` while the allowlist for `br` lists only `show` and `list`, when `validateAllowlist` runs, then the error names the adapter and the subcommand `delete`.
    - [ ] Given an `adapter.yaml` containing `token: ghp_` followed by 36 alphanumerics, when `scanCredentials` runs, then the error contains that file path; given `env: [GITHUB_TOKEN]` only, then no error.
    - [ ] Given a toolchain config file with a literal `password: hunter2`, when `scanCredentials` runs, then it fails naming the config file (tests in `scripts/tests/toolchain-allowlist.test.js`).
- [ ] **TRD-008-TEST** Verify allowlist and credential validation [verifies TRD-008] [satisfies REQ-022, REQ-023] [depends: TRD-008] (4h)
  - Validates PRD ACs: AC-022-1, AC-023-1, AC-023-3
  - Test AC:
    - [ ] Scenario: Literal credential rejected -- Given an adapter or config containing a literal credential, When validation runs, Then it fails naming the file.
    - [ ] Scenario: Undeclared binary rejected -- Given an adapter capability section calling a binary outside its declared allowlist, When validation runs, Then it fails naming the adapter and the binary.
    - [ ] Scenario: Unlisted subcommand rejected -- Given an adapter capability section calling an allowed binary with a subcommand not on its allowlist, When validation runs, Then it fails naming the adapter and the subcommand.

- [ ] **TRD-009** Add fixture adapters under `scripts/tests/fixtures/toolchain/`: `good-adapter/` (conforming, with `SKILL.md` and `adapter.yaml`) and `broken-adapter/` (deliberately missing a required capability, an undeclared binary and a literal credential), plus a suite in `scripts/tests/toolchain-fixtures.test.js` that runs the validators over both and asserts the broken one fails [satisfies REQ-008] [depends: TRD-007, TRD-008] (3h)
  - Validates PRD ACs: AC-008-3
  - Implementation AC:
    - [ ] Given `scripts/tests/fixtures/toolchain/broken-adapter/`, when the validators in `validate.js` run on it, then the result is failure and the errors list at least the missing capability, the undeclared binary and the credential file.
    - [ ] Given `scripts/tests/fixtures/toolchain/good-adapter/`, when the same validators run, then the result is success with zero errors.
    - [ ] Given the validators are replaced by an always-pass stub in a mutation check inside the test file, when the suite runs, then the broken-fixture assertion fails, proving the check can fail.
- [ ] **TRD-009-TEST** Verify the conformance check is shown capable of failing [verifies TRD-009] [satisfies REQ-008] [depends: TRD-009] (2h)
  - Validates PRD ACs: AC-008-3
  - Test AC:
    - [ ] Scenario: Check fails on broken fixture -- Given the check is applied to a deliberately broken fixture adapter in the test suite, When the suite runs, Then the check fails on that fixture (the check is shown capable of failing).

### PR 3: Runner
**Shippable State:** A user running a command with a configured adapter gets tool calls executed without a shell, normalized output validated against the contract, missing-tool and timed-out health checks that halt before any side effect, and a machine-readable failure record listing completed side effects.

- [ ] **TRD-010** Implement template substitution and argument validation in `packages/development/lib/toolchain/runner.js` (`buildArgv(runTemplate, args, contract)`): `{name}` placeholders replaced inside argv array elements only, each arg validated against its contract input type (string, integer, enum, path), no shell interpretation, values rejected when they begin with `-` where a value is expected, and, when a capability declares `variants`, template selection by the selector arg with any value outside the declared variant keys rejected as `NOT_ALLOWED` [satisfies REQ-022, REQ-023] [RISK] [depends: TRD-001] (6h)
  - Implementation AC:
    - [ ] Given template `["br","show","{id}"]` and `id="--help"`, when `buildArgv` runs, then it throws `INVALID_ARG` naming `id`; given `id="bd-12"`, then it returns `["br","show","bd-12"]`.
    - [ ] Given an arg value `a; rm -rf /` or containing `$(x)`, when `buildArgv` runs, then the value appears unchanged as a single argv element and no shell is invoked (asserted by the argv array length in `scripts/tests/toolchain-runner-args.test.js`).
    - [ ] Given a capability with `variants` keyed `jest` and `pytest` and selector value `rspec`, when `buildArgv` runs, then it throws `NOT_ALLOWED` and builds no argv; with `jest` it returns only the jest argv.
    - [ ] Given a placeholder with no supplied arg and no contract default, when `buildArgv` runs, then it throws `INVALID_ARG` naming the placeholder; given an arg of the wrong type for an integer input, then it throws naming the arg.

- [ ] **TRD-011** Implement the execution core in `packages/development/lib/toolchain/runner.js` (`runCapability(adapter, capability, args, opts)`): `child_process.execFile` with `shell:false`, per-call timeout (default 60000 ms), runtime check that argv[0] is a declared binary and the subcommand is in the allowlist before spawn, returning the envelope `{ok, capability, adapter, source, data}` or `{ok:false, error:{code,message}}` with codes `NOT_ALLOWED`, `TIMEOUT`, `TOOL_FAILED`; the runner is the only path a tool is spawned and it adds no tool grants [satisfies REQ-023] [RISK] [depends: TRD-008, TRD-010] (7h)
  - Validates PRD ACs: AC-023-2
  - Implementation AC:
    - [ ] Given a manifest altered after validation so a capability runs binary `rm`, when `runCapability` executes it, then it returns `{ok:false, error:{code:'NOT_ALLOWED'}}` and no process is spawned (spawn stub call count 0).
    - [ ] Given a tool that sleeps longer than `timeoutMs` 200, when `runCapability` runs, then it returns code `TIMEOUT` within 1000 ms and the child process is killed.
    - [ ] Given `runCapability` source in `packages/development/lib/toolchain/runner.js`, when `grep -n "shell:\s*true\|exec(" ` runs on it, then there are zero matches; a command not granted the shell tool cannot call the runner, documented in the module header per interpretation I3.
- [ ] **TRD-011-TEST** Verify the governed boundary denies out-of-allowlist tool use [verifies TRD-011] [satisfies REQ-023] [depends: TRD-011] (3h)
  - Validates PRD ACs: AC-023-2
  - Test AC:
    - [ ] Scenario: Boundary denies ungranted tool -- Given an adapter attempting to use a tool the running command was not granted, When it runs, Then the governed boundary denies it.

- [ ] **TRD-012** Implement the output mapping engine `packages/development/lib/toolchain/mapping.js` (`mapOutput(stdout, parse)`: `format` json|lines|text, dotted-path projection `$.a.b[0]` with `|` alternation for array-or-object per I6, `map` field projection, `statusMap` value translation) and normalized-shape validation in runner via Ajv against `packages/development/toolchain/schemas/normalized/*.json`; on mismatch return `BAD_OUTPUT` and never pass the data on [satisfies REQ-002, REQ-022] [depends: TRD-001, TRD-010] (7h)
  - Validates PRD ACs: AC-002-2, AC-022-2
  - Implementation AC:
    - [ ] Given JSON stdout `{"issues":[{"key":"A-1","fields":{"summary":"x"}}]}` and map `id:$.issues[0].key`, `title:$.issues[0].fields.summary`, when `mapOutput` runs, then it returns `{id:'A-1', title:'x'}`.
    - [ ] Given a tool status string `"In Progress"` and `statusMap {"In Progress":"in_progress"}`, when `mapOutput` runs, then `status` equals `in_progress`; an unmapped value yields `BAD_OUTPUT` naming the value.
    - [ ] Given tool stdout missing required field `id` of `packages/development/toolchain/schemas/normalized/work-item.json`, when `runCapability` completes, then it returns `{ok:false, error:{code:'BAD_OUTPUT'}}` and `data` is absent.
    - [ ] Given two fixture adapters for the same capability with different raw output formats, when each runs, then both `data` objects validate against the same normalized schema (tests in `scripts/tests/toolchain-mapping.test.js`).
- [ ] **TRD-012-TEST** Verify normalized outputs and rejection of malformed output [verifies TRD-012] [satisfies REQ-002, REQ-022] [depends: TRD-012] (4h)
  - Validates PRD ACs: AC-002-2, AC-022-2
  - Test AC:
    - [ ] Scenario: Two adapters return the same shape -- Given two adapters for the same category, When the same capability is invoked, Then both return outputs in the contract's normalized shape.
    - [ ] Scenario: Malformed tool output rejected -- Given a tool output that does not match the contract's normalized shape, When the capability returns, Then the layer rejects it with an error instead of passing it on.

- [ ] **TRD-013** Implement required versus optional capability handling in `packages/development/lib/toolchain/resolve.js` (`requireCapabilities(adapter, required, optional)` and runner `UNAVAILABLE` handling): a missing required capability halts before any side effect with an error naming the capability and adapter; a missing optional capability returns `{ok:false, unavailable:true, fallback:'<id>'}` using the contract's documented fallback, and the envelope message states the fallback was used [satisfies REQ-004] [depends: TRD-007, TRD-011, TRD-012] (5h)
  - Validates PRD ACs: AC-004-1, AC-004-2
  - Implementation AC:
    - [ ] Given required `tracker.close` and an adapter lacking it, when `requireCapabilities` runs, then it throws `UNAVAILABLE` whose message contains `tracker.close` and the adapter name, before any `runCapability` call (spawn count 0).
    - [ ] Given optional `work-graph.ready` absent from the adapter, when the runner is invoked for it, then it returns `unavailable:true` with `fallback` equal to the id in the contract and a `message` containing the text `fallback`.
    - [ ] Given a capability present in the adapter, when `requireCapabilities` runs, then no error and no unavailable flag are returned (tests in `scripts/tests/toolchain-capabilities.test.js`).
- [ ] **TRD-013-TEST** Verify required and optional capability handling [verifies TRD-013] [satisfies REQ-004] [depends: TRD-013] (3h)
  - Validates PRD ACs: AC-004-1, AC-004-2
  - Test AC:
    - [ ] Scenario: Missing required capability halts -- Given a command that requires capability X and the resolved adapter lacks X, When the command starts, Then it halts before any side effect and names X and the adapter.
    - [ ] Scenario: Optional capability falls back -- Given an optional capability absent from the resolved adapter, When the command reaches it, Then the documented fallback runs and the output states that the fallback was used.

- [ ] **TRD-014** Implement preflight in `packages/development/lib/toolchain/preflight.js` (`runPreflight({categories, runId, nonInteractive})`): run each adapter `health[]` check through the runner concurrently, so the added start-up delay is the slowest single check rather than the sum, with default `timeoutMs` 10000 overridable per adapter, treat timeout as failure naming the check as timed out, halt with `HEALTH_FAILED` naming adapter and check id, write `.ensemble/state/toolchain/preflight-<runId>.json` on pass; `runCapability` for any contract capability with `sideEffect:true` returns `PREFLIGHT_REQUIRED` unless a passing record exists for the supplied run id (I9) [satisfies REQ-013] [RISK] [depends: TRD-006, TRD-011] (7h)
  - Validates PRD ACs: AC-013-1, AC-013-2, AC-013-3
  - Implementation AC:
    - [ ] Given a health check whose binary is not installed, when `runPreflight` runs, then it returns `HEALTH_FAILED` naming the check id and writes no preflight record, and no branch, work item or change request capability was invoked.
    - [ ] Given a health check `auth` that exits non-zero with `nonInteractive:true`, when `runPreflight` runs, then the error names the adapter and the `auth` check.
    - [ ] Given a health check that sleeps 500 ms and `timeoutMs` 100, when `runPreflight` runs, then the error states the check `timed out` and the call returns within 1000 ms; with no override the timeout used is 10000 ms.
    - [ ] Given three health checks that each sleep 400 ms, when `runPreflight` runs, then it returns in under 1000 ms (sequential execution would take about 1200 ms)
    - [ ] Given a side-effecting capability and no preflight record for run id `R`, when `toolchain-cli run` executes with `--run-id R`, then it exits non-zero with `PREFLIGHT_REQUIRED` and spawns nothing (tests in `scripts/tests/toolchain-preflight.test.js`).
- [ ] **TRD-014-TEST** Verify preflight halts before side effects [verifies TRD-014] [satisfies REQ-013] [depends: TRD-014] (4h)
  - Validates PRD ACs: AC-013-1, AC-013-2, AC-013-3
  - Test AC:
    - [ ] Scenario: Missing tool halts preflight -- Given a resolved adapter whose tool is not installed, When a command starts, Then it halts before creating any branch, work item or change request and names the failing check.
    - [ ] Scenario: Expired authentication halts non-interactive run -- Given an adapter whose authentication has expired, When a command starts in a non-interactive run, Then it halts with an error naming the adapter and the failed check.
    - [ ] Scenario: Health check timeout halts -- Given a health check that exceeds its timeout, When a command starts, Then it halts naming the check as timed out.

- [ ] **TRD-015** Implement the side-effect ledger and failure record in `packages/development/lib/toolchain/ledger.js`: append each completed `sideEffect:true` call to `.ensemble/state/toolchain/ledger-<runId>.jsonl`; on adapter failure after side effects write `failure-<runId>.json` (`{adapter, capability, completedSideEffects[], error}`) with configured and well-known secret patterns redacted, also copying to `FOREMAN_ARTIFACT_PATH` when set; records are appended one line per `fs.appendFileSync` call so concurrent runs never interleave a record, `.ensemble/state/` is added to the root `.gitignore`, and the runner stops and makes no retry or resume attempt [satisfies REQ-014] [depends: TRD-011] (6h)
  - Validates PRD ACs: AC-014-1, AC-014-2, AC-014-3
  - Implementation AC:
    - [ ] Given a fixture adapter whose `worktree.create` and `tracker.create` succeed and `host.change-request.create` fails, when the run ends, then the command output lists both completed side effects and the failed capability.
    - [ ] Given that failure, when `failure-<runId>.json` is read, then it parses as JSON and has non-empty `adapter`, `capability` and a `completedSideEffects` array of length 2; with `FOREMAN_ARTIFACT_PATH` set, an identical file exists there.
    - [ ] Given the failing tool wrote `ghp_` plus 36 alphanumerics to stderr, when the failure record is written, then that string does not appear in the file.
    - [ ] Given a run that wrote ledger, failure and confirmation records, when `git status --porcelain` runs, then no path under `.ensemble/state/` is listed because `.ensemble/state/` is in `.gitignore`
    - [ ] Given two runs with different run ids appending ledger lines concurrently, when both finish, then each `ledger-<runId>.jsonl` parses line by line as JSON with no interleaved record
    - [ ] Given the failing capability, when the run ends, then the spawn stub was called exactly once for it and no later capability was invoked (tests in `scripts/tests/toolchain-ledger.test.js`).
- [ ] **TRD-015-TEST** Verify the report-only failure policy [verifies TRD-015] [satisfies REQ-014] [depends: TRD-015] (3h)
  - Validates PRD ACs: AC-014-1, AC-014-2, AC-014-3
  - Test AC:
    - [ ] Scenario: Output lists side effects -- Given an adapter failing after a branch and a work item were created, When the failure occurs, Then the command stops and its output lists both side effects.
    - [ ] Scenario: Failure record is machine-readable -- Given the same failure, When the failure record is read, Then it is machine-readable and names the adapter, failed capability and completed side effects.
    - [ ] Scenario: No retry or resume -- Given a failure, When the layer finishes, Then it has made no retry or resume attempt.
### PR 4: Detection and confirmation
**Shippable State:** A user running a command in an unconfigured repository whose remote matches an installed adapter sees that adapter selected and its source named, is asked once per session before the first external write, and gets a clear error naming the category when a non-interactive run cannot resolve a provider.

- [ ] **TRD-016** Detection engine in `packages/development/lib/toolchain/detect.js`: evaluate each installed adapter's manifest `detect[]` signals (`remote_url_matches`, `file_exists`, `dir_exists`, `git_config_set`), apply the I2 rules (no signal source = shipped default; two or more matching adapters, or a signal source matching no installed adapter = ambiguous), and in non-interactive mode throw `AMBIGUOUS_PROVIDER` naming the category and the config key to set [satisfies REQ-010] [depends: TRD-003, TRD-006] (6h)
  - Validates PRD ACs: AC-010-1, AC-010-2
  - Implementation AC:
    - [ ] Given a temp git repo whose `origin` URL matches the `remote_url_matches` signal of a fixture adapter and no `.ensemble/toolchain.yaml`, when `detect.js` resolves the category, then it returns that adapter with source `detection`
    - [ ] Given a repo with remote `https://example.invalid/x.git` matching no installed adapter's signal and no config, when resolved with non-interactive set, then it throws `AMBIGUOUS_PROVIDER` whose message contains the category name and `.ensemble/toolchain.yaml`
    - [ ] Given a directory with no remote and no marker files, when resolved, then the shipped default adapter is returned with source `default` and no error (I2)
    - [ ] Given two installed fixture adapters both matching the remote, when resolved non-interactively, then `AMBIGUOUS_PROVIDER` lists both adapter names; unit tests in `packages/development/tests/toolchain/detect.test.js` cover all four cases
- [ ] **TRD-016-TEST** Test AC for detection engine [verifies TRD-016] [satisfies REQ-010] [depends: TRD-016] (3h)
  - Validates PRD ACs: AC-010-1, AC-010-2
  - Test AC:
    - [ ] Scenario: Detection selects matching adapter -- Given a repository whose remote matches an installed adapter's detection signal and no config, When the category is resolved, Then that adapter is selected and the reported source is `detection`
    - [ ] Scenario: Unmatched remote fails non-interactively -- Given a remote matching no signal and no config, When the category is resolved in a non-interactive run, Then resolution fails with an error naming the category and how to configure it
- [ ] **TRD-017** Confirmation record in `packages/development/lib/toolchain/confirm.js`: begin with a spike (recorded in a comment block in `confirm.js` and a table in the module header) of which session id each runtime exposes (`ENSEMBLE_SESSION_ID`, host variables), key passive records one file per key under `.ensemble/state/toolchain/confirmations/<sha256 of (sessionKey, category, adapter, configHash)>.json`, written by temp file plus rename so concurrent writers never lose a record, with run-id fallback, detect non-interactive mode only from an explicit signal (`--non-interactive`, `ENSEMBLE_NON_INTERACTIVE=1`, `FOREMAN_TASK_TITLE` set or `CI=true`), never from the absence of a TTY because the CLI always runs in agent shells, skip confirmation for read-only and local-only capabilities (contract `sideEffect` flag), and show a repo-local adapter's allowlist at first-use confirmation (I5) [satisfies REQ-011] [RISK: runtimes may expose no session id (I4); fallback prompts more often] [depends: TRD-014, TRD-016] (7h)
  - Validates PRD ACs: AC-011-1, AC-011-2, AC-011-3, AC-011-4, AC-011-5
  - Implementation AC:
    - [ ] Given an interactive session and an unconfirmed `tracker` adapter with an external-write capability, when `confirmStatus()` is called, then it returns `{confirmed:false, adapter, source}` and after `recordConfirmation()` a second call for the same category returns `{confirmed:true}`
    - [ ] Given a recorded confirmation, when the adapter selection in config changes so `configHash` differs, then `confirmStatus()` returns `{confirmed:false}` again
    - [ ] Given non-interactive mode (`--non-interactive` or `ENSEMBLE_NON_INTERACTIVE=1`), when status is requested, then it returns `{confirmed:true, prompt:false}` and a log line containing the adapter name and source is emitted
    - [ ] Given an interactive session where `toolchain-cli` runs with no TTY attached and no explicit non-interactive signal, when status is requested for an unconfirmed adapter, then it returns `{confirmed:false}`; the absence of a TTY alone never counts as non-interactive
    - [ ] Given two processes recording confirmations for different categories at the same instant, when both finish, then both confirmation files exist and each parses as JSON
    - [ ] Given a capability whose contract marks `sideEffect:false` or local-only, when status is requested interactively, then `{required:false}` is returned; given a repo-local adapter, the status payload includes its `allowlist[]` for display; unit tests in `packages/development/tests/toolchain/confirm.test.js`
- [ ] **TRD-017-TEST** Test AC for confirmation behavior [verifies TRD-017] [satisfies REQ-011] [depends: TRD-017] (4h)
  - Validates PRD ACs: AC-011-1, AC-011-2, AC-011-3, AC-011-4, AC-011-5
  - Test AC:
    - [ ] Scenario: First external write waits for confirmation -- Given an interactive session about to take its first write outside the local working tree in a category, When the adapter is resolved, Then it is shown and the action waits for confirmation
    - [ ] Scenario: Confirmation is not repeated -- Given a confirmation already given, When a second action in the same category occurs, Then no new prompt appears
    - [ ] Scenario: Non-interactive run does not prompt -- Given a non-interactive run, When resolution completes, Then no prompt appears and the log records adapter and source
    - [ ] Scenario: Config edit re-triggers confirmation -- Given configuration edited mid-session to select a different adapter, When the next action runs, Then confirmation is requested again
    - [ ] Scenario: Read-only call needs no confirmation -- Given an interactive session making a read-only call or a local-only change, When the capability runs, Then no confirmation prompt appears
- [ ] **TRD-018** Complete `packages/development/lib/toolchain-cli.js` surface: add `preflight`, `run`, `confirm-status`, `confirm-record`, `validate` beside `resolve`/`explain`, all emitting the JSON envelope `{ok, capability, adapter, source, data}` or `{ok:false, error:{code,message}}` and non-zero exit on error, with `--non-interactive`, `--run-id`, `--arg k=v` flags [satisfies REQ-021] [depends: TRD-004, TRD-011, TRD-014, TRD-016, TRD-017] (6h)
  - Implementation AC:
    - [ ] Given `node packages/development/lib/toolchain-cli.js preflight --require tracker.show`, when health checks pass, then stdout is JSON containing `ok:true` and a `runId`, and exit code is 0
    - [ ] Given a failing health check, when `preflight` runs, then exit code is non-zero and `error.code` is `HEALTH_FAILED` naming the check id
    - [ ] Given an unknown subcommand, when invoked, then it exits 2 with a usage message listing the seven subcommands
    - [ ] Given a `run` of a side-effecting capability without a prior preflight for `--run-id`, when invoked, then `error.code` is `PREFLIGHT_REQUIRED`; subprocess tests in `packages/development/tests/toolchain-cli.test.js` cover each subcommand's envelope

### PR 5: Runtime delivery
**Shippable State:** A user on Claude Code, OpenCode, Pi or Codex gets the same adapter and source reported for the same project config, and command definitions can declare the capabilities they require so a missing one stops the command before it changes anything.

- [ ] **TRD-019** Vendor the toolchain library and CLI into the Pi bundle: extend `ENTRY_FILES` in `packages/pi/src/transformers/lib-bundler.ts` with `toolchain-cli.js` and make the require-closure walk (`resolveRequireClosure`) also bundle `packages/development/lib/toolchain/**` and the data directory `packages/development/toolchain/` (categories, default selection, schemas) into `vendor/lib`; add a `TOOLCHAIN_CLI` row to the cheat sheet in `packages/development/skills/tool-path-resolution/SKILL.md` (`packages/development/lib/toolchain-cli.js` / `vendor/lib/toolchain-cli.js`) and to the Pi copy `packages/pi/skills/tool-path-resolution/SKILL.md` [satisfies REQ-021] [depends: TRD-018] (6h)
  - Implementation AC:
    - [ ] Given the Pi generator is run, when `packages/pi/vendor/lib` is listed, then it contains `toolchain-cli.js`, every `toolchain/*.js` module it requires and the `toolchain/` data directory, and `node packages/pi/vendor/lib/toolchain-cli.js resolve --json` exits 0 from a directory outside the repo
    - [ ] Given `packages/pi/tests/lib-bundler.test.ts` is extended, when a new `require` is added to a toolchain module without being bundled, then the test fails naming the missing file
    - [ ] Given `packages/development/skills/tool-path-resolution/SKILL.md`, when the cheat sheet is read, then it has a `TOOLCHAIN_CLI` row with the relative path and vendor suffix
- [ ] **TRD-020** Extend the Codex and OpenCode generators to ship adapters: `scripts/generate-codex/index.js` (skill discovery currently globs `packages/*/skills/SKILL.md`, line ~233) and `scripts/generate-opencode/src/skill-copier.ts` (currently copies only `SKILL.md` and `REFERENCE.md`) must copy `adapter-*/SKILL.md` directories with their `adapter.yaml`, and the vendored toolchain library, into `.codex/skills/` and `.opencode/skill/` [satisfies REQ-021] [depends: TRD-006, TRD-018] (7h)
  - Implementation AC:
    - [ ] Given a fixture skill dir `adapter-tracker-fixture/{SKILL.md,adapter.yaml}`, when `node scripts/generate-codex/index.js` runs, then `adapter.yaml` exists beside `SKILL.md` in the Codex output skill directory
    - [ ] Given the same fixture, when the OpenCode generator runs, then `adapter.yaml` exists in the `.opencode/skill/` output and `opencode.json` `skills.paths` includes the directory
    - [ ] Given a skill with no `adapter.yaml`, when either generator runs, then output is byte-identical to before this change (existing generator tests under `scripts/tests/` pass unchanged)
    - [ ] Given the generated Codex and OpenCode bundles, when `node <bundle>/toolchain-cli.js resolve --json` is run, then it exits 0
- [ ] **TRD-021** Cross-runtime resolution parity harness in `scripts/tests/toolchain-runtime-parity.test.js`: for each of `claude`, `opencode`, `pi`, `codex`, run `toolchain-cli resolve --json` from that runtime's built bundle against one fixture project config, compare per-category `{adapter, source}`, and simulate a runtime lacking a required mechanism (missing vendored library) to assert an explicit failure [satisfies REQ-021] [depends: TRD-019, TRD-020] (6h)
  - Validates PRD ACs: AC-021-1, AC-021-2
  - Implementation AC:
    - [ ] Given one fixture `.ensemble/toolchain.yaml`, when the harness resolves via the four runtime entry points, then the 14-category `{adapter, source}` maps are deep-equal across all four
    - [ ] Given a runtime bundle with `toolchain/` removed, when its CLI is invoked, then the harness observes a non-zero exit and an error naming the missing mechanism, never a default-adapter fallback
    - [ ] Given the harness is wired into the root `npx jest scripts/tests` run (the step `.github/workflows/validate.yml` and `scripts/ci-local.js` execute), when one runtime returns a different source for one category, then the test fails naming runtime and category
- [ ] **TRD-021-TEST** Test AC for cross-runtime parity [verifies TRD-021] [satisfies REQ-021] [depends: TRD-021] (2h)
  - Validates PRD ACs: AC-021-1, AC-021-2
  - Test AC:
    - [ ] Scenario: Same adapter and source in every runtime -- Given the same project config, When resolved in each supported runtime, Then the same adapter and source are reported per category
    - [ ] Scenario: Unsupported runtime fails explicitly -- Given a runtime lacking support for a needed mechanism, When resolution runs there, Then it fails explicitly rather than falling back
- [ ] **TRD-022** Command YAML `capabilities: {required: [], optional: []}` field: add the property to `schemas/command-yaml-schema.json` (alongside `allowed_tools`, line ~49) with items matching `^[a-z-]+\.[a-z-]+$`, validate that each id exists in a category contract (`packages/development/toolchain/categories/*.yaml`) in the validator used by `scripts/validate-all.js`, and pass the field through the generators for Claude (`scripts/generate-markdown`), OpenCode (`scripts/generate-opencode/src/command-translator.ts`), Pi (`packages/pi/src/transformers/command-transformer.ts`) and Codex (`scripts/generate-codex/index.js`) [satisfies REQ-004, REQ-015] [depends: TRD-001, TRD-013, TRD-019, TRD-020] (7h)
  - Implementation AC:
    - [ ] Given a command YAML with `capabilities: {required: [tracker.show], optional: [work-graph.ready]}`, when `node scripts/validate-all.js` runs, then it passes
    - [ ] Given a command YAML naming `tracker.nonexistent`, when validation runs, then it fails naming the command file and the unknown capability id
    - [ ] Given a command with the field, when each of the four generators runs, then the generated artifact contains both lists in that runtime's format, and a command without the field generates byte-identical output to before
    - [ ] Given tests in `packages/development/tests` or `scripts/tests` for schema and passthrough, when run, then each of the four generators has at least one assertion

### PR 6: Tracker contract and default adapter
**Shippable State:** A user's implementation tooling reads and updates work items through a swappable tracker layer, with the existing Beads tracker behaving exactly as before, including ready-work ordering and TRD bead counts.

- [ ] **TRD-023** Tracker and work-graph contracts v1: write `packages/development/toolchain/categories/tracker.yaml` (capabilities `show`, `list`, `create`, `update`, `close`, `comment`, `comments`, `dep-add`, `dep-remove`, `label`, `sync`, `stage-export` [optional]) and `packages/development/toolchain/categories/work-graph.yaml` (`ready`, `plan`, `graph-health`, each optional with documented fallback `work-graph-links-fallback`), mark `sideEffect` per capability, and add `packages/development/toolchain/schemas/normalized/work-item.json` matching the normalized work item `{id, title, description, type, status(open|in_progress|closed), priority, labels[], dependencies[{id,type}], dependents[], comments[], externalRef}` [satisfies REQ-002, REQ-020] [depends: TRD-001, TRD-002] (5h)
  - Implementation AC:
    - [ ] Given `packages/development/toolchain/categories/tracker.yaml`, when validated against `packages/development/toolchain/schemas/category-contract-schema.json`, then it passes with version `1.0` and writes (`create`, `update`, `close`, `comment`, `dep-add`, `dep-remove`, `label`, `sync`) flagged `sideEffect:true`
    - [ ] Given a work-item object with `status:"blocked"`, when validated against `packages/development/toolchain/schemas/normalized/work-item.json`, then validation fails naming `status`; given a valid item it passes
    - [ ] Given `packages/development/toolchain/categories/work-graph.yaml`, when loaded, then `ready`, `plan`, `graph-health` are optional with a `fallback` field of `work-graph-links-fallback`; schema tests in `scripts/tests/toolchain-contracts.test.js`
- [ ] **TRD-024** Default tracker adapter `packages/development/skills/adapter-tracker-beads/{SKILL.md,adapter.yaml}` (manifest with `categories: [tracker, work-graph]`, `allowlist` for `br` subcommands show/list/create/update/close/comment/dep/label/sync and `bv` for `--robot-plan`/`--robot-next`/insights, `health` for `br --version` and `bv --version`): tracker capabilities `show` (`br show <id> --json`), `list` (`br list --all --limit 0 --json`, accepting both bare array and `{issues:[...]}` wrapping as in `trd-cli.js` `getBeadCounts`), `create`, `update`, `close`, `comment`, `comments`, `dep-add`, `dep-remove`, `label` (`br label add <ids> -l <label> --json`), `sync`; work-graph `ready`, `plan`, `graph-health` via `bv`; `parse` blocks map br JSON to the normalized work item [satisfies REQ-006, REQ-020] [RISK: br and bv JSON shapes vary across versions (0.2.x wraps list output)] [depends: TRD-008, TRD-011, TRD-012, TRD-023] (7h)
  - Validates PRD ACs: AC-020-1
  - Implementation AC:
    - [ ] Given `adapter.yaml`, when the conformance validator (TRD-007) and allowlist validator (TRD-008) run, then both pass and every capability's `run[]` binary and subcommand is within `allowlist[]`
    - [ ] Given a stubbed `br` returning `{issues:[{id:"b-1",title:"[trd:x:1] t",status:"open",labels:[]}]}` and a bare-array variant, when `tracker.list` runs, then both produce the same normalized array with `status:"open"`
    - [ ] Given a stubbed `bv` printing a robot-plan JSON, when `work-graph.ready` runs, then `data` is the ordered list of normalized ready items the same as the current `bv` output order
    - [ ] Given `SKILL.md`, when the vocabulary-block check (TRD-005) runs, then it passes and the file lists the capability names and the env var names (none needed for local `br`)
- [ ] **TRD-024-TEST** Test AC for default tracker adapter [verifies TRD-024] [satisfies REQ-020] [depends: TRD-024] (3h)
  - Validates PRD ACs: AC-020-1
  - Test AC:
    - [ ] Scenario: Default adapter ready-work from work-graph -- Given the default tracker adapter, When implementation commands run, Then ready-work comes from its work-graph capabilities as today
- [ ] **TRD-025** Route internal CLIs through the tracker runner in-process: replace direct `execFileSync('br', ['show', id, '--json'])` in `packages/development/lib/trd-cli.js` (`bead-context`, line ~340) and `execSync('br list --all --json')` in `getBeadCounts` (line ~851, keeping the `[trd:<slug>:` title filter and the all-zero return on failure), `runBr` in `packages/development/lib/beads-label.js` (`ensureLabel` list and 50-id `label add` batches, keeping `IDS_PER_CALL`), and `exec('br', ['show', id, '--json'])` in `packages/development/lib/complexity-analyzer.js` (line ~285, keeping null on unreadable bead) with calls to `packages/development/lib/toolchain` runner `tracker.show`, `tracker.list`, `tracker.label` [satisfies REQ-016] [depends: TRD-024, TRD-014, TRD-017] (7h)
  - Validates PRD ACs: AC-016-2
  - Implementation AC:
    - [ ] Given `grep -nE "execFileSync\('br'|execSync\('br |exec\('br'" packages/development/lib/{trd-cli,beads-label,complexity-analyzer}.js`, when run, then it returns no matches
    - [ ] Given the default tracker adapter and a stubbed `br`, when `getBeadCounts('x')` and `ensureLabel({label,match})` run, then they return the same values as before the change (existing tests `packages/development/tests/` for trd-cli, beads-label, complexity-analyzer pass unmodified)
    - [ ] Given tracker config selecting a fixture adapter and no `br` on `PATH`, when `trd-cli bead-context <id>` runs, then it returns the item from the fixture adapter
    - [ ] Given the tracker adapter cannot be resolved, when `getBeadCounts` runs, then it returns `{total:0,open:0,in_progress:0,closed:0}` as today and `trd-cli bead-context` exits non-zero with the resolver error
- [ ] **TRD-025-TEST** Test AC for internal CLI routing [verifies TRD-025] [satisfies REQ-016] [depends: TRD-025] (3h)
  - Validates PRD ACs: AC-016-2
  - Test AC:
    - [ ] Scenario: Internal CLI works through swapped tracker -- Given an internal CLI that previously called the default tracker directly, When the tracker adapter is swapped to a fixture adapter, Then the CLI performs the same operation through the alternative adapter
- [ ] **TRD-026** `tracker.stage-export` capability for `packages/development/lib/beads-stage.js`: define the optional capability in the tracker contract (returns export text for the tracked file or `unavailable`), declare it in `adapter-tracker-beads/adapter.yaml` reading `.beads/issues.jsonl`, and make `stageBeadsExport` obtain the export through the runner instead of assuming a Beads file path, keeping the pure scoping (`titleMatches`, `parseRecords`) and the git `hash-object`/`update-index` staging unchanged [satisfies REQ-016] [depends: TRD-024, TRD-025] (4h)
  - Implementation AC:
    - [ ] Given the default adapter and a repo tracking `.beads/issues.jsonl` with two TRDs' beads, when `stageBeadsExport` runs for one slug, then the index holds only that TRD's records, matching the pre-change result in the existing `beads-stage` tests
    - [ ] Given a tracker adapter that does not declare `stage-export`, when `stageBeadsExport` runs, then it returns `{staged:false, unavailable:true}` with the contract fallback id and modifies neither index nor working file
    - [ ] Given `adapter.yaml` of the default adapter, when the allowlist validator runs, then `stage-export` passes with no subcommand outside `allowlist[]`
### PR 7: Work-graph fallback and tracker command refactors
**Shippable State:** A user whose tracker offers no ready-work command still gets ordered implementation runs, with the output saying whether ordering came from issue links or plan order, and the core tracker commands (list, requirement status, complexity, onboarding, retro, refine, implement, build) run their tracker steps through the configured tracker.

- [ ] **TRD-027** Add built-in adapter `work-graph-links-fallback` at `packages/development/lib/toolchain/builtin/work-graph-links-fallback/` (`adapter.yaml` plus module). It implements `work-graph.ready` and `work-graph.plan`: it calls `tracker.list` and `tracker.show` through the runner, computes ready items from `dependencies[]` links when the tracker provides them (source `tracker-links`), else returns items in plan order (source `plan-order`, `dependencyAware:false`). Every result carries `orderingSource` so commands print it. Selection follows I7: tracker adapter's own work-graph capabilities win, else this fallback [satisfies REQ-016, REQ-020, REQ-004] [depends: TRD-011, TRD-013, TRD-023, TRD-024] (6h)
  - Validates PRD ACs: AC-016-3, AC-020-2, AC-020-3
  - Implementation AC:
    - [ ] Given a tracker adapter whose manifest lacks `work-graph.ready` but whose `tracker.show` returns `dependencies[]`, when `toolchain-cli run work-graph.ready` runs, then `data.orderingSource` is `tracker-links` and only items with all dependencies closed are returned
    - [ ] Given a tracker adapter with neither `work-graph.ready` nor dependency data, when `work-graph.plan` runs for three items, then items return in the supplied plan order with `orderingSource: "plan-order"` and `dependencyAware: false`
    - [ ] Given a command declares `work-graph.ready` as required and the tracker lacks it, when the fallback is also absent from the registry, then the runner halts with `UNAVAILABLE` before any side effect, and unit tests in `scripts/tests/work-graph-fallback.test.js` cover all three branches
- [ ] **TRD-027-TEST** Verify the work-graph fallback behaviors for alternative trackers [verifies TRD-027] [satisfies REQ-016, REQ-020, REQ-004] [depends: TRD-027] (3h)
  - Validates PRD ACs: AC-016-3, AC-020-2, AC-020-3
  - Test AC:
    - [ ] Scenario: Missing work-graph capability triggers fallback or halt -- Given a command using work-graph capabilities and an alternative tracker adapter lacking one of them, When the command resolves that capability, Then the documented fallback is applied if the capability is optional and the run halts with `UNAVAILABLE` before side effects if it is required
    - [ ] Scenario: Ordering derived from links -- Given an alternative tracker adapter without ready-work but returning issue links, When an implementation command needs ordering, Then ordering is derived from those links and the output states `tracker-links` as the source
    - [ ] Scenario: Plan order without dependency awareness -- Given an alternative tracker adapter returning neither ready-work nor links, When an implementation command needs ordering, Then tasks run in plan order and the output states that ordering is not dependency-aware
- [ ] **TRD-028** Refactor read-only tracker commands in `packages/development/commands/`: `list-issue.yaml` (replace the `br list --status=open --json` / `bv --robot-triage` step with `tracker.list` and `work-graph.plan` optional with fallback to the flat list; delete the br/bv install prose), `requirement-status.yaml` (replace `br list --json` merge and per-bead `br comment list <id>` with `tracker.list` and `tracker.comments`; delete the "On br failure" prose, keep the checkbox fallback), `analyze-complexity.yaml` (replace `br show --json` with `tracker.show`), `onboard.yaml` (replace the `br create` loop with `tracker.create`), `retro.yaml` (tracker part: replace `br list --all --json` and `br create` with `tracker.list` and `tracker.create`). Add `capabilities:` blocks: list-issue `{required:[tracker.list], optional:[work-graph.plan]}`; requirement-status `{required:[tracker.list, tracker.comments]}`; analyze-complexity `{required:[tracker.show]}`; onboard `{required:[tracker.create]}`; retro `{required:[tracker.list], optional:[tracker.create]}` [satisfies REQ-015] [depends: TRD-019, TRD-022, TRD-024, TRD-027] (6h)
  - Implementation AC:
    - [ ] Given the five edited YAMLs, when `grep -nE '\b(br|bv) ' packages/development/commands/{list-issue,requirement-status,analyze-complexity,onboard,retro}.yaml` runs, then it returns zero lines for tracker-binary invocations
    - [ ] Given each edited YAML, when `node scripts/validate-all.js` validates it against `schemas/command-yaml-schema.json`, then the `capabilities` block matches the declarations listed in this task and validation exits 0
    - [ ] Given `retro.yaml`, when its non-tracker steps (git log gathering, report writing) are compared with the pre-refactor file, then those steps are unchanged line for line
    - [ ] Given TRD-028 is the first command refactor, when it starts, then before any command YAML is edited it commits `scripts/tests/fixtures/default-equivalence/BASE_REF` holding the 40-character id of the pre-refactor commit that TRD-049 reads goldens from.
    - [ ] Given each edited command, when its body is read, then it opens with `toolchain-cli preflight --require` listing exactly the ids in its `capabilities.required`, calls `toolchain-cli confirm-status` before its first write outside the local working tree in a category and, when it reports `confirmed:false` in an interactive session, asks through `AskUserQuestion` then calls `confirm-record`, and under `--foreman` passes `--non-interactive` and never prompts
- [ ] **TRD-028-TEST** Verify the read-only tracker command refactors [verifies TRD-028] [satisfies REQ-015] [depends: TRD-028] (3h)
  - Test AC:
    - [ ] Scenario: No tracker binary remains -- Given the five edited command YAMLs (list-issue, requirement-status, analyze-complexity, onboard, retro), When searched for tracker binary invocations, Then no line invokes a tracker binary.
    - [ ] Scenario: Capabilities declarations validate -- Given each edited YAML, When `node scripts/validate-all.js` runs, Then its `capabilities` block validates against the command schema.
    - [ ] Scenario: Non-tracker retro steps unchanged -- Given `retro.yaml`, When its git-log gathering and report-writing steps are compared with the pre-refactor file, Then they are identical line for line.
    - [ ] Scenario: Command preamble present -- Given each edited command, When its body is read, Then it opens with a preflight listing exactly its required capabilities and calls confirm-status before its first external write.
- [ ] **TRD-029** Refactor tracker lifecycle commands: `refine-beads.yaml` (replace the `which br`/`br list` verify steps with `toolchain-cli preflight --require tracker.list,tracker.update,tracker.dep-add,tracker.dep-remove,tracker.comment`; replace `br sync --flush-only` with `tracker.sync`; replace `bv --robot-insights/--robot-alerts/--robot-suggest` with optional `work-graph.graph-health`; replace each `br comments add / update / dep add / dep remove / close` repair command with the matching `tracker.*` run call; the "Ordered br Repair Plan" prints capability calls, not br commands; delete the BV_AVAILABLE probe prose), `implement-bead.yaml` tracker parts (replace `br show`, `br update --status=in_progress ... comment add`, `br update --status=closed`, `br comment add` with `tracker.show`, `tracker.update`, `tracker.close`, `tracker.comment`; keep `trd-cli bead-context` call), `beads-build-wave.yaml` (replace `br sync`, `bv --robot-plan` / `br ready` with `tracker.sync` and `work-graph.ready`/`work-graph.plan`; delete the which-br/which-bv checks). Add `capabilities:` blocks: refine-beads `{required:[tracker.list, tracker.update, tracker.comment, tracker.sync], optional:[work-graph.graph-health, tracker.dep-add, tracker.dep-remove]}`; implement-bead `{required:[tracker.show, tracker.update, tracker.close, tracker.comment]}`; beads-build-wave `{required:[tracker.show, tracker.list, tracker.sync, work-graph.ready], optional:[work-graph.plan]}` [satisfies REQ-015, REQ-016] [depends: TRD-022, TRD-024, TRD-025, TRD-027] (7h)
  - Implementation AC:
    - [ ] Given the three edited YAMLs, when `grep -nE '\b(br|bv) (show|list|update|close|comment|comments|dep|sync|ready)|--robot-' ` runs on them, then it returns zero lines
    - [ ] Given `beads-build-wave.yaml`, when its output contract is read, then the JSON summary fields emitted at the end are identical to the pre-refactor contract and only the scheduling source lines changed
    - [ ] Given `refine-beads.yaml`, when a repair plan entry is printed, then it names a `tracker.*` capability and arguments and no tracker binary command
    - [ ] Given each edited command, when its body is read, then it opens with `toolchain-cli preflight --require` listing exactly the ids in its `capabilities.required`, calls `toolchain-cli confirm-status` before its first write outside the local working tree in a category and, when it reports `confirmed:false` in an interactive session, asks through `AskUserQuestion` then calls `confirm-record`, and under `--foreman` passes `--non-interactive` and never prompts
- [ ] **TRD-029-TEST** Verify the tracker lifecycle command refactors [verifies TRD-029] [satisfies REQ-015, REQ-016] [depends: TRD-029] (3h)
  - Test AC:
    - [ ] Scenario: No tracker binary remains -- Given refine-beads, implement-bead and beads-build-wave, When searched for tracker subcommand and robot-flag invocations, Then no match remains.
    - [ ] Scenario: Wave output contract unchanged -- Given `beads-build-wave.yaml`, When its end-of-run JSON summary fields are compared with the pre-refactor contract, Then the fields are identical and only the scheduling source lines changed.
    - [ ] Scenario: Repair plan names capabilities -- Given `refine-beads.yaml`, When a repair plan entry is printed, Then it names a tracker capability and arguments and no tracker binary command.
    - [ ] Scenario: Command preamble present -- Given each edited command, When its body is read, Then it opens with a preflight listing exactly its required capabilities and calls confirm-status before its first external write.
- [ ] **TRD-030** Refactor `packages/development/commands/beads-build.yaml` and the skill `packages/development/skills/implement-trd-beads-reference/SKILL.md`: replace `br show <ROOT_EPIC_ID>`, `br list --status=open|in_progress|closed --json`, `br list --label`, `br sync --flush-only`, `br comment add`, `br close` and the `bv --robot-plan --format toon` schedule with `tracker.show`, `tracker.list`, `tracker.sync`, `tracker.comment`, `tracker.close`, `work-graph.ready` and `work-graph.plan`; delete the "br must exist" HALT prose and install-URL strings and the BV_AVAILABLE prose; keep the `node "$TRD_CLI" bead-context` call. Add `capabilities: {required:[tracker.show, tracker.list, tracker.sync, tracker.comment, tracker.close, work-graph.ready], optional:[work-graph.plan]}` to beads-build.yaml [satisfies REQ-015, REQ-016] [depends: TRD-022, TRD-024, TRD-025, TRD-027] (6h)
  - Implementation AC:
    - [ ] Given `beads-build.yaml` and the reference skill, when searched for `br ` and `bv ` invocations and `--robot-` flags, then zero tracker-binary matches remain
    - [ ] Given the `--plan` flag path, when `PLAN_ONLY=true`, then the printed plan states its ordering source from `data.orderingSource`
    - [ ] Given the `capabilities` block, when `node scripts/validate-all.js` runs, then schema validation passes
    - [ ] Given each edited command, when its body is read, then it opens with `toolchain-cli preflight --require` listing exactly the ids in its `capabilities.required`, calls `toolchain-cli confirm-status` before its first write outside the local working tree in a category and, when it reports `confirmed:false` in an interactive session, asks through `AskUserQuestion` then calls `confirm-record`, and under `--foreman` passes `--non-interactive` and never prompts
- [ ] **TRD-030-TEST** Verify the beads-build and reference-skill refactor [verifies TRD-030] [satisfies REQ-015, REQ-016] [depends: TRD-030] (3h)
  - Test AC:
    - [ ] Scenario: No tracker binary remains -- Given `beads-build.yaml` and the reference skill, When searched for tracker invocations and robot flags, Then no tracker-binary match remains.
    - [ ] Scenario: Plan states its ordering source -- Given the `--plan` path with `PLAN_ONLY=true`, When the plan is printed, Then it states its ordering source from `data.orderingSource`.
    - [ ] Scenario: Capabilities validate -- Given the `capabilities` block, When `node scripts/validate-all.js` runs, Then schema validation passes.
    - [ ] Scenario: Command preamble present -- Given the edited command, When its body is read, Then it opens with a preflight listing exactly its required capabilities and calls confirm-status before its first external write.
- [ ] **TRD-031** Refactor `packages/development/commands/implement-trd-beads.yaml`: replace the gates that run `br list --status=open --json`, the TRD epic search, `br sync --flush-only`, scaffold creation (`br create`, `br dep add` with title-prefix caching), `br list --all --limit 0 --json` closed counts, `br comment add` quality-gate record, and `br close` story/epic closure with `tracker.list`, `tracker.sync`, `tracker.create`, `tracker.dep-add`, `tracker.comment`, `tracker.close`; replace `bv --robot-plan/--robot-insights/--robot-triage` with optional `work-graph.plan` and `work-graph.graph-health`; keep `trd-cli beads-stage` and `trd-cli status` calls; delete the br/bv install-URL prose. Add `capabilities: {required:[tracker.list, tracker.create, tracker.dep-add, tracker.comment, tracker.close, tracker.sync], optional:[work-graph.plan, work-graph.graph-health, tracker.stage-export]}` [satisfies REQ-015, REQ-016] [depends: TRD-026, TRD-030] (7h)
  - Implementation AC:
    - [ ] Given `implement-trd-beads.yaml`, when searched for `br (list|create|dep|comment|close|sync|show)` and `bv `, then zero matches remain
    - [ ] Given the scaffold step, when the plan creates epic, stories, tasks and dependency edges, then each uses a `tracker.create` or `tracker.dep-add` call with the same title prefixes (`[trd:<slug>]`) as before
    - [ ] Given the YAML, when `node scripts/validate-all.js` runs, then the `capabilities` declaration validates
    - [ ] Given each edited command, when its body is read, then it opens with `toolchain-cli preflight --require` listing exactly the ids in its `capabilities.required`, calls `toolchain-cli confirm-status` before its first write outside the local working tree in a category and, when it reports `confirmed:false` in an interactive session, asks through `AskUserQuestion` then calls `confirm-record`, and under `--foreman` passes `--non-interactive` and never prompts
- [ ] **TRD-031-TEST** Verify the implement-trd-beads refactor [verifies TRD-031] [satisfies REQ-015, REQ-016] [depends: TRD-031] (3h)
  - Test AC:
    - [ ] Scenario: No tracker binary remains -- Given `implement-trd-beads.yaml`, When searched for tracker subcommands and the viewer binary, Then zero matches remain.
    - [ ] Scenario: Scaffold keeps title prefixes -- Given the scaffold step, When it plans the epic, stories, tasks and dependency edges, Then each uses a create or dep-add capability call with the same `[trd:<slug>]` title prefixes as before.
    - [ ] Scenario: Capabilities validate -- Given the YAML, When `node scripts/validate-all.js` runs, Then the `capabilities` declaration validates.
    - [ ] Scenario: Command preamble present -- Given the edited command, When its body is read, Then it opens with a preflight listing exactly its required capabilities and calls confirm-status before its first external write.

### PR 8: Alternative trackers
**Shippable State:** A user can set their tracker to Jira Cloud or Azure Boards and run the scaffold, claim, update and close flow with the default tracker's tool not installed.

- [ ] **TRD-032** Add Jira Cloud tracker adapter `packages/infrastructure/skills/adapter-tracker-jira/{SKILL.md,adapter.yaml}`. Manifest: `adapter: jira`, `categories:[tracker, work-graph]`, `binaries:[jira]`, allowlist `{bin: jira, sub: [issues, comments]}` (matching the existing vocabulary in `packages/infrastructure/skills/jira/SKILL.md`: `jira issues read|list|search|create|update|transitions`, `jira comments create|list`); `env:` names only (`ATLASSIAN_CLOUD_ID`, `ATLASSIAN_AUTH_TOKEN`, `ATLASSIAN_SITE_URL`, as listed in that SKILL.md lines 42-44); `health:[{id: jira-installed, run:[jira, --version]}, {id: jira-auth, run:[jira, issues, list, --limit, "1"], timeoutMs: 10000}]`; `detect:` none (Jira has no repo signal, so selection is by config); capabilities `tracker.show -> jira issues read {id}`, `tracker.list`, `tracker.create`, `tracker.update` (status through `jira issues update --status`), `tracker.close` (update to a Done status), `tracker.comment -> jira comments create {id} --body {text}`, `tracker.comments -> jira comments list {id}`; each with `parse` mapping Jira fields to the normalized work item and a `statusMap` to open/in_progress/closed. Work-graph capabilities and `tracker.dep-add` are omitted because the documented jira vocabulary has no issue-link command, so the fallback applies. SKILL.md carries the Jira vocabulary (issue, transition, sprint) [satisfies REQ-016] [depends: TRD-005, TRD-007, TRD-008, TRD-012, TRD-023, TRD-027] (7h)
  - Implementation AC:
    - [ ] Given `packages/infrastructure/skills/adapter-tracker-jira/adapter.yaml`, when `toolchain-cli validate` runs it, then schema, vocabulary-block, allowlist and credential-scan checks pass and the `env` list contains names only
    - [ ] Given recorded `jira issues read` JSON in a fixture, when `tracker.show` output is mapped, then the result validates against `packages/development/toolchain/schemas/normalized/work-item.json` and the status maps through `statusMap`
    - [ ] Given a `tracker.update` call whose id arg begins with `-`, when run, then the runner rejects it with `NOT_ALLOWED` or argument-validation error before executing
    - [ ] Given `jira --help` output for `issues` and `comments` recorded during this task in the adapter's `fixtures/jira-help.txt` fixture, when each allowlist entry is compared against it, then every entry names a subcommand that exists in the recorded output, so no allowlist entry rests on assumed CLI syntax
- [ ] **TRD-032-TEST** Verify the Jira Cloud tracker adapter [verifies TRD-032] [satisfies REQ-016] [depends: TRD-032] (2h)
  - Test AC:
    - [ ] Scenario: Adapter validates with names-only env -- Given the Jira adapter directory, When `toolchain-cli validate` runs, Then schema, vocabulary, allowlist and credential-scan checks pass and `env` lists names only.
    - [ ] Scenario: Recorded output normalizes -- Given a recorded `jira issues read` JSON fixture, When `tracker.show` output is mapped, Then the result validates against the normalized work-item schema and status maps through `statusMap`.
    - [ ] Scenario: Flag-like id rejected -- Given a `tracker.update` call whose id begins with `-`, When it runs, Then the runner rejects it before executing.
    - [ ] Scenario: Allowlist matches the real CLI -- Given the recorded CLI help fixture, When each allowlist entry is compared against it, Then every entry names an existing subcommand.
- [ ] **TRD-033** Add Azure Boards tracker adapter `packages/infrastructure/skills/adapter-tracker-azure-boards/{SKILL.md,adapter.yaml}`. Manifest: `binaries:[az]`, allowlist `{bin: az, sub: ["boards work-item show", "boards work-item create", "boards work-item update", "boards query", "boards work-item relation add", "devops configure", "account show"]}` (binary-plus-subcommand level, not `az` alone); `env:` names only (`AZURE_DEVOPS_EXT_PAT`, optional because `az login` also authenticates); organization and project come from `az devops configure --defaults`, not environment variables (Microsoft's Azure DevOps CLI documentation lists no organization or project variable); Azure DevOps Services (cloud) only, because the CLI extension does not support Azure DevOps Server; `health:` `az --version`, `az extension show --name azure-devops`, `az devops configure --list` (organization and project defaults present), `az boards query --wiql "SELECT [System.Id] FROM WorkItems" --top 1` (10 s); `detect:` `remote_url_matches: dev.azure.com|visualstudio.com`; capabilities `tracker.show`, `tracker.create`, `tracker.update`, `tracker.close` (state Closed/Done), `tracker.list` (WIQL), `tracker.comment` (`az boards work-item update --discussion`), `tracker.dep-add` (`relation add --relation-type Predecessor`), each with `parse` (`--output json` roots, `fields.System.*` to normalized fields) and `statusMap` for New/Active/Closed. Uses Azure Boards vocabulary (work item, state, iteration) in SKILL.md. Work-graph ready capability omitted; links give the fallback (`dependencies[]` from relations) [satisfies REQ-016, REQ-017] [depends: TRD-005, TRD-007, TRD-008, TRD-012, TRD-023, TRD-027, TRD-032] (7h)
  - Implementation AC:
    - [ ] Given `adapter.yaml` for Azure Boards, when the static allowlist validator runs, then every capability template's `az` subcommand pair appears in the allowlist and the file contains no PAT value
    - [ ] Given a recorded `az boards work-item show --output json` fixture with a Predecessor relation, when `tracker.show` is mapped, then `dependencies[]` contains `{id, type}` and validates against the normalized work-item schema
    - [ ] Given `az repos` as a subcommand, when a tracker capability template tries to use it, then validation fails with `NOT_ALLOWED` (host subcommands belong to the host adapter)
    - [ ] Given `az boards --help`, `az boards work-item --help` and `az boards query --help` output recorded during this task in the adapter's `fixtures/az-boards-help.txt` fixture, when each allowlist entry is compared against it, then every entry names a subcommand that exists in the recorded output, so no allowlist entry rests on assumed CLI syntax
- [ ] **TRD-033-TEST** Verify the Azure Boards tracker adapter [verifies TRD-033] [satisfies REQ-016, REQ-017] [depends: TRD-033] (2h)
  - Test AC:
    - [ ] Scenario: Allowlist and credentials clean -- Given the Azure Boards `adapter.yaml`, When the static allowlist validator and credential scan run, Then every `az` subcommand pair is in the allowlist and no token value appears.
    - [ ] Scenario: Relations normalize to dependencies -- Given a recorded `az boards work-item show` fixture with a Predecessor relation, When `tracker.show` is mapped, Then `dependencies[]` holds `{id, type}` and validates against the work-item schema.
    - [ ] Scenario: Host subcommands rejected -- Given a tracker capability template using `az repos`, When validation runs, Then it fails because host subcommands belong to the host adapter.
    - [ ] Scenario: Allowlist matches the real CLI -- Given the recorded CLI help fixture, When each allowlist entry is compared against it, Then every entry names an existing subcommand.
- [ ] **TRD-034** Add scripted tracker swap scenario `scripts/tests/tracker-swap-scenario.test.js` running scaffold work from a TRD (using the TRD fixture), claim, update, close against the Jira and Azure Boards adapters with stub `jira` and `az` executables on a PATH that has no `br`/`bv`; plus a conformance run (TRD-007 validator) over both manifests; plus a swap check that `trd-cli bead-context`, `beads-label` and `complexity-analyzer` produce the same operation through each adapter; plus a command-entry check that `beads-build` with the alternative adapter selected reaches its tracker step and follows that adapter's capability section [satisfies REQ-015, REQ-016] [depends: TRD-025, TRD-031, TRD-032, TRD-033] (6h)
  - Validates PRD ACs: AC-015-2, AC-016-1, AC-016-4
  - Implementation AC:
    - [ ] Given a PATH containing only stub `jira` (then only stub `az`) and no `br`, when the scenario runs with tracker config set to that adapter, then scaffold, claim, update and close each exit 0 and the ledger lists four side effects
    - [ ] Given each alternative manifest, when `toolchain-cli validate --conformance tracker` runs, then exit code is 0
    - [ ] Given the `beads-build` entry point with the Azure Boards adapter selected, when it reaches the claim step, then the stub `az` receives `boards work-item update` and no `br` call occurs
- [ ] **TRD-034-TEST** Verify tracker swap end to end [verifies TRD-034] [satisfies REQ-015, REQ-016] [depends: TRD-034] (3h)
  - Validates PRD ACs: AC-015-2, AC-016-1, AC-016-4
  - Test AC:
    - [ ] Scenario: Alternative adapter followed through command entry -- Given a command run through its entry point with an alternative adapter selected, When it reaches a tool step, Then it follows the alternative adapter's capability section
    - [ ] Scenario: Tracker scenario with no default tool -- Given tracker config set to Jira Cloud or Azure Boards, When the scripted scenario (scaffold work from a TRD, claim, update, close) runs, Then it completes with no default-tracker tool installed
    - [ ] Scenario: Conformance for each alternative -- Given each alternative tracker adapter, When the conformance validation of REQ-008 runs against it, Then it passes

### PR 9: Host and workflow
**Shippable State:** A user can open, check and merge a change request through GitHub or Azure DevOps by configuration alone, and the branching workflow (git-town or plain git) is selected by configuration, with unconfigured projects behaving as before.

- [ ] **TRD-035** Add `host` and `workflow` category contracts to `packages/development/toolchain/categories/host.yaml` and `packages/development/toolchain/categories/workflow.yaml` (v1.0) and the normalized change-request schema `packages/development/toolchain/schemas/normalized/change-request.json` (`{id, url, state, baseBranch, headBranch, checks[]}`). Host capabilities: `host.auth-status`, `host.change-request.create|view|list|checks|threads|merge`, optional `host.change-request.link-work-item`. Workflow capabilities (per I1): `workflow.branch-create`, `workflow.sync`, `workflow.propose`, `workflow.ship`, and plain-git `vcs.status|commit|push|log|diff|merge-base|remote-url`; mark side-effecting ones with `sideEffect: true` [satisfies REQ-002, REQ-001] [depends: TRD-001, TRD-002, TRD-023] (5h)
  - Implementation AC:
    - [ ] Given `packages/development/toolchain/categories/host.yaml` and `workflow.yaml`, when validated against `packages/development/toolchain/schemas/category-contract-schema.json`, then both pass and `host.change-request.merge`, `workflow.sync` and `vcs.push` carry `sideEffect: true`
    - [ ] Given the change-request schema, when a sample with missing `state` is validated, then it fails and a complete sample passes in `scripts/tests/change-request-schema.test.js`
    - [ ] Given the workflow contract, when read, then `vcs.*` capabilities are listed under `workflow` with default adapter `plain-git`
- [ ] **TRD-036** Add the default host adapter `packages/git/skills/adapter-host-github/{SKILL.md,adapter.yaml}` and workflow adapters `adapter-workflow-git-town` and `adapter-workflow-plain-git` in `packages/git/skills/`. GitHub manifest: `binaries:[gh]`, allowlist `{bin: gh, sub: ["pr create","pr view","pr list","pr checks","pr merge","auth status","api"]}`, `env:[GH_TOKEN]` names only, `health:` `gh --version` and `gh auth status`, `detect: remote_url_matches github.com`, capability templates mapping the `gh pr ... --json` output to the change-request schema. git-town manifest: allowlist `git-town` subcommands `hack, append, sync, propose, ship, status`, health `git-town --version`, `detect: git_config_set git-town.main-branch`; plain-git: allowlist `git` subcommands `status, commit, push, log, diff, merge-base, remote, switch, branch`. SKILL.md keeps the existing vocabulary of `packages/git/skills/git-town/SKILL.md` for the git-town adapter [satisfies REQ-006, REQ-024] [depends: TRD-005, TRD-008, TRD-012, TRD-035] (7h)
  - Implementation AC:
    - [ ] Given the three adapter manifests, when `toolchain-cli validate` runs, then all pass the schema, allowlist and credential-scan checks and `packages/development/toolchain/toolchain.default.yaml` names `github` and `plain-git` as the defaults for host and workflow
    - [ ] Given a recorded `gh pr view --json` fixture, when `host.change-request.view` is mapped, then output validates against `packages/development/toolchain/schemas/normalized/change-request.json`
    - [ ] Given `gh pr merge` is not in an altered allowlist copy, when `host.change-request.merge` runs against it, then the runner returns `NOT_ALLOWED`
- [ ] **TRD-036-TEST** Verify the default host and workflow adapters [verifies TRD-036] [satisfies REQ-006, REQ-024] [depends: TRD-036] (2h)
  - Test AC:
    - [ ] Scenario: Manifests validate and defaults are named -- Given the GitHub, git-town and plain-git manifests, When `toolchain-cli validate` runs, Then all pass and the default selection names `github` and `plain-git`.
    - [ ] Scenario: Recorded output normalizes -- Given a recorded `gh pr view --json` fixture, When `host.change-request.view` is mapped, Then the output validates against the normalized change-request schema.
    - [ ] Scenario: Merge denied outside allowlist -- Given an altered allowlist copy without the merge subcommand, When `host.change-request.merge` runs against it, Then the runner returns `NOT_ALLOWED`.
- [ ] **TRD-037** Compat inputs and resolver delegation: in `packages/development/lib/trd-cli.js` the `resolve-sdlc` command delegates host/workflow resolution to `packages/development/lib/toolchain` resolver, with `ENSEMBLE_PR_BACKEND` (`gh`/`ado`) mapped to host and `ENSEMBLE_BRANCHING_STRATEGY` mapped to workflow as config inputs, keeping `packages/development/lib/pr-strategy.js` result shape (`prBackend`, `needsResolution`, `defaultBranch`) so existing callers are unchanged [satisfies REQ-009, REQ-024] [depends: TRD-003, TRD-004, TRD-036] (5h)
  - Implementation AC:
    - [ ] Given `ENSEMBLE_PR_BACKEND=ado` and no toolchain config, when `trd-cli resolve-sdlc` runs, then the output reports host `azure-devops` with source `env-compat` and the same `prBackend` field as before
    - [ ] Given no environment variable and no config, when `trd-cli resolve-sdlc` runs, then it reports the shipped default `github` and `plain-git`/`git-town` selections exactly as the pre-refactor output for the existing `packages/development/tests` resolve-sdlc cases
    - [ ] Given the existing tests that call `resolve-sdlc`, when run with the development package's jest suite (`npm test --workspace packages/development`), then they pass unmodified
- [ ] **TRD-038** Route `packages/e2e-testing/lib/pr-state.js` (its `defaultExec` calling `execFileSync('gh', ...)` and `git remote get-url origin`) through the host adapter by shelling out to `node "$TOOLCHAIN_CLI" run host.change-request.list` (resolved with the tool-path-resolution skill, because `packages/e2e-testing` cannot import `packages/development`), and `validate-git-town` health (`packages/git/skills/git-town/scripts/validate-git-town.sh`, called from `trd-cli.js` and `pr-strategy.js`) through the workflow adapter health check; keep `checkPrState()` return shape and keep the injectable `exec` option for tests [satisfies REQ-015] [depends: TRD-019, TRD-036, TRD-037] (5h)
  - Implementation AC:
    - [ ] Given `pr-state.js`, when searched for `execFileSync` and the string `'gh'`, then no direct host binary invocation remains
    - [ ] Given `packages/e2e-testing/lib/pr-state.js`, when searched for a `require(` of any `packages/development` path, then none is found
    - [ ] Given a host adapter that returns two open change requests, when `checkPrState()` runs, then `hasOpenPr` is true with the same fields as before, and exec failure still surfaces as an explicit error rather than silently returning false
    - [ ] Given the existing `packages/e2e-testing` pr-state tests, when run, then they pass with the `exec` injection unchanged
- [ ] **TRD-039** Refactor host and workflow parts of commands and skills: `packages/git/commands/pr-merge.yaml` (replace `gh pr view --json number,url,s...` resolution, `gh pr checks <N> --json ...`, `gh pr view --json reviews,reviewDecision,latestReviews`, the manifest rebuild, the pre-merge `gh pr view --json mergeable,mergeStateStatus,reviewDecision` re-check, and `gh pr merge` with `host.change-request.view|checks|threads|merge`; delete gh flag prose; keep the NEVER-merge-while-failing rules), `packages/development/commands/fix-issue.yaml` (replace the `gh` prerequisite line and PR-creation step with `host.change-request.create`), `packages/development/commands/implement-bead.yaml` host/workflow parts (replace the `VALIDATE_GIT_TOWN_SH` resolution, `git remote get-url origin`, the `gh pr create` / `az repos pr create` backend branch with `toolchain-cli preflight` plus `workflow.branch-create`, `workflow.propose`, `host.change-request.create`), the `packages/assessment/skills/assess-config/SKILL.md` auth checks (replace `gh auth status`, `az devops project show` with `host.auth-status`), and `packages/git/skills/git-town/SKILL.md` (state that git-town is the `git-town` workflow adapter and point to capabilities). New `capabilities:`: pr-merge `{required:[host.change-request.view, host.change-request.checks, host.change-request.merge], optional:[host.change-request.threads]}`; fix-issue `{required:[host.change-request.create, vcs.commit, vcs.push]}`; implement-bead adds `host.change-request.create, workflow.branch-create` to required (tracker ones from TRD-029 retained) [satisfies REQ-015] [depends: TRD-022, TRD-029, TRD-036, TRD-037] (7h)
  - Implementation AC:
    - [ ] Given `pr-merge.yaml`, `fix-issue.yaml` and `implement-bead.yaml`, when searched for `gh pr`, `az repos` and `git town`, then zero invocations remain
    - [ ] Given `pr-merge.yaml`, when its NEVER-merge rules are diffed against the pre-refactor file, then those rules are unchanged
    - [ ] Given the three YAMLs, when `node scripts/validate-all.js` runs, then the declared `capabilities` blocks validate against `schemas/command-yaml-schema.json`
    - [ ] Given each edited command, when its body is read, then it opens with `toolchain-cli preflight --require` listing exactly the ids in its `capabilities.required`, calls `toolchain-cli confirm-status` before its first write outside the local working tree in a category and, when it reports `confirmed:false` in an interactive session, asks through `AskUserQuestion` then calls `confirm-record`, and under `--foreman` passes `--non-interactive` and never prompts
- [ ] **TRD-039-TEST** Verify the host and workflow command refactors [verifies TRD-039] [satisfies REQ-015] [depends: TRD-039] (3h)
  - Test AC:
    - [ ] Scenario: No host or workflow binary remains -- Given pr-merge, fix-issue and implement-bead, When searched for the GitHub pull-request invocation, the Azure repos invocation and the branching-tool invocation, Then zero invocations remain.
    - [ ] Scenario: Merge safety rules unchanged -- Given `pr-merge.yaml`, When its NEVER-merge rules are diffed against the pre-refactor file, Then the rules are unchanged.
    - [ ] Scenario: Capabilities validate -- Given the three YAMLs, When `node scripts/validate-all.js` runs, Then each declared `capabilities` block validates.
    - [ ] Scenario: Command preamble present -- Given each edited command, When its body is read, Then it opens with a preflight listing exactly its required capabilities and calls confirm-status before its first external write.
- [ ] **TRD-040** Add Azure DevOps host adapter `packages/infrastructure/skills/adapter-host-azure-devops/{SKILL.md,adapter.yaml}`. Manifest: `binaries:[az]`, allowlist `{bin: az, sub: ["repos pr create","repos pr show","repos pr list","repos pr update","repos pr set-vote","repos pr work-item add","account show","devops configure"]}`; `env:` names only (`AZURE_DEVOPS_EXT_PAT`, optional because `az login` also authenticates); organization and project come from `az devops configure --defaults`, not environment variables (Microsoft's Azure DevOps CLI documentation lists no organization or project variable); Azure DevOps Services (cloud) only, because the CLI extension does not support Azure DevOps Server; `health:` `az --version`, `az extension show --name azure-devops`, `az devops configure --list` (organization and project defaults present), `az repos pr list --top 1` (10 s); `detect: remote_url_matches dev.azure.com|visualstudio.com`; capabilities `host.change-request.create`, `view`, `list`, `checks` (policy evaluations), `merge` (`repos pr update --status completed`), `host.change-request.link-work-item` (`repos pr work-item add`); `parse` maps `pullRequestId`, `status` (`active`/`completed`/`abandoned` via `statusMap`), `sourceRefName`, `targetRefName` with refs/heads/ prefix stripped; SKILL.md uses Azure DevOps vocabulary (pull request, policy, completion) [satisfies REQ-017] [depends: TRD-005, TRD-008, TRD-012, TRD-035, TRD-036] (7h)
  - Implementation AC:
    - [ ] Given `adapter.yaml`, when validated, then schema, allowlist and credential-scan checks pass and every `az` template uses a pair from the allowlist
    - [ ] Given a recorded `az repos pr show` JSON fixture with `status: active`, when `host.change-request.view` is mapped, then `state` is `open` and `headBranch` has no `refs/heads/` prefix and the result validates against `packages/development/toolchain/schemas/normalized/change-request.json`
    - [ ] Given a manifest copy lacking `repos pr update`, when `host.change-request.merge` runs, then the runner returns `NOT_ALLOWED`
    - [ ] Given `az repos pr --help` output recorded during this task in the adapter's `fixtures/az-repos-pr-help.txt` fixture, when each allowlist entry is compared against it, then every entry names a subcommand that exists in the recorded output, so no allowlist entry rests on assumed CLI syntax
- [ ] **TRD-040-TEST** Verify the Azure DevOps host adapter [verifies TRD-040] [satisfies REQ-017] [depends: TRD-040] (2h)
  - Test AC:
    - [ ] Scenario: Adapter validates -- Given the Azure DevOps `adapter.yaml`, When schema, allowlist and credential-scan checks run, Then all pass and every `az` template uses an allowlisted pair.
    - [ ] Scenario: Pull request normalizes -- Given a recorded `az repos pr show` fixture with `status: active`, When `host.change-request.view` is mapped, Then `state` is `open`, `headBranch` has no `refs/heads/` prefix and the result validates against the change-request schema.
    - [ ] Scenario: Merge denied without update subcommand -- Given a manifest copy lacking `repos pr update`, When `host.change-request.merge` runs, Then the runner returns `NOT_ALLOWED`.
    - [ ] Scenario: Allowlist matches the real CLI -- Given the recorded CLI help fixture, When each allowlist entry is compared against it, Then every entry names an existing subcommand.
- [ ] **TRD-041** Add scripted host swap scenario `scripts/tests/host-swap-scenario.test.js`: push (`vcs.push`), open, check status, merge against the Azure DevOps adapter with stub `az` and no `gh` on PATH; assert the output uses Azure DevOps vocabulary ("pull request", "policy"), not GitHub terms (via the adapter's vocabulary block); and a second scenario with host `azure-devops` and tracker `azure-boards` linking a work item to a change request using config only (`host.change-request.link-work-item`) [satisfies REQ-017] [depends: TRD-033, TRD-036, TRD-040] (6h)
  - Validates PRD ACs: AC-017-1, AC-017-2, AC-017-3
  - Implementation AC:
    - [ ] Given a PATH with stub `az` and without `gh`, when the scenario runs with host config `azure-devops`, then push, create, view and merge each exit 0
    - [ ] Given the scenario output, when scanned for the GitHub-only terms listed in the host vocabulary block (for example "pull request review decision"), then none appear and the Azure DevOps terms do appear
    - [ ] Given config only (`.ensemble/toolchain.yaml` setting host `azure-devops` and tracker `azure-boards`), when the link scenario runs, then `az repos pr work-item add` is invoked and no source file changes are needed
- [ ] **TRD-041-TEST** Verify host swap end to end [verifies TRD-041] [satisfies REQ-017] [depends: TRD-041] (3h)
  - Validates PRD ACs: AC-017-1, AC-017-2, AC-017-3
  - Test AC:
    - [ ] Scenario: Change-request scenario without default host tool -- Given host config set to the alternative adapter, When the scripted change-request scenario (push, open, check status, merge) runs, Then it completes with the default host's tool not installed
    - [ ] Scenario: Alternative vocabulary in output -- Given the same scenario, When output is read, Then it uses the alternative host's vocabulary for change-request and review terms
    - [ ] Scenario: Host and tracker both Azure DevOps -- Given host config set to the Azure DevOps adapter and tracker config set to the Azure Boards adapter, When the scripted scenario linking a work item to a change request runs, Then it completes using configuration changes only
### PR 10: Long-tail categories
**Shippable State:** A user can run worktree, local-CI and review-gate operations on an unconfigured project through the same configuration-driven mechanism as trackers and hosts, with test, end-to-end, lint, container, infrastructure, cloud and package-runner steps also resolved from configuration, and asking for a tool that does not ship for those categories yields a clear error listing what is available.

- [ ] **TRD-042** Contracts and default adapters for worktree, ci-local and review: fill `packages/development/toolchain/categories/worktree.yaml` (create, list, remove, prune; sideEffect flags), `ci-local.yaml` (run-workflow, list-jobs), `review.yaml` (get-review-state, list-open-threads, request-review optional); ship `adapter-worktree-plain-git` (plain `git worktree`, no command invokes it yet) in `packages/git/skills/`, `adapter-ci-local-act` wrapping `packages/git/skills/act-local-ci/scripts/run-act.js` and `act` in `packages/git/skills/`, and `adapter-review-coderabbit` (review state read through the host adapter's change-request checks, no direct tool call) in `packages/quality/skills/`; each directory has `SKILL.md` with a vocabulary block and an `adapter.yaml` [satisfies REQ-001, REQ-006] [depends: TRD-001, TRD-002, TRD-005, TRD-007, TRD-008, TRD-012, TRD-035] (7h)
  - Validates PRD ACs: AC-006-2
  - Implementation AC:
    - [ ] Given `packages/development/toolchain/categories/worktree.yaml`, when the category-contract schema check runs, then it passes and every capability lists inputs, outputs and required or optional status
    - [ ] Given `packages/git/skills/adapter-worktree-plain-git/adapter.yaml`, when its allowlist is read, then it permits only binary `git` with subcommand `worktree` and each capability template starts with `git worktree`
    - [ ] Given the three new adapter directories, when the TRD-007 conformance validator and TRD-008 allowlist validator run over them, then all three pass with zero findings
    - [ ] Given a search of `packages/*/commands/**/*.yaml` for `worktree.` capability names, when it runs, then it returns zero matches (no command uses the worktree category yet)
- [ ] **TRD-042-TEST** Verify the worktree default adapter uses plain source-control worktrees and is not yet used by any command [verifies TRD-042] [satisfies REQ-006] [depends: TRD-042] (2h)
  - Validates PRD ACs: AC-006-2
  - Test AC:
    - [ ] Scenario: Worktree default adapter covers worktree operations -- Given the worktree-manager category, When the shipped default adapter `adapter-worktree-plain-git` is inspected through `toolchain-cli explain` and its `adapter.yaml`, Then its create, list, remove and prune capabilities all run `git worktree` subcommands and a scan of `packages/*/commands` finds no `worktree.*` capability reference
- [ ] **TRD-043** Contracts and default adapters for test-runner, e2e-quality and lint: `packages/development/toolchain/categories/test-runner.yaml` (run: file, framework, config, coverage in; normalized `{success, passed, failed, skipped, total, duration, failures[]}` out, matching the shape printed by `packages/xunit/skills/run-test.sh`), `e2e-quality.yaml` (run-e2e, audit-performance optional, audit-accessibility optional), `lint.yaml` (report-findings); ship `adapter-test-runner-default` with one `variants` entry per framework that runs the shipped per-language runner (`packages/jest/skills/run-test.js`, `packages/pytest/skills/run-test.py`, `packages/exunit/skills/run-test.exs`, `packages/xunit/skills/run-test.sh`, `packages/rspec/skills/run-test.rb`), `adapter-e2e-quality-playwright` (playwright, lighthouse, axe from `packages/e2e-testing/skills/{writing-playwright-tests,a11y-perf-checks}`) and `adapter-lint-reviewdog`; add the `variants` (select command template by an argument value) key to `packages/development/toolchain/schemas/adapter-manifest-schema.json` and the runner [satisfies REQ-001, REQ-006, REQ-018] [depends: TRD-001, TRD-005, TRD-007, TRD-008, TRD-010, TRD-011, TRD-012] (7h)
  - Implementation AC:
    - [ ] Given `adapter-test-runner-default/adapter.yaml` with `framework=pytest`, when TRD-007 conformance validation runs, then it passes and the selected template is the `python3` run of the pytest `run-test.py`
    - [ ] Given `packages/pytest/skills/run-test.py`, which currently returns `passed: 0, failed: 0, total: 0` unconditionally, when run against a fixture with 2 passing and 1 failing test, then its JSON reports `passed: 2, failed: 1, total: 3, success: false` so the normalized shape is truthful (a unit test in `packages/pytest` or `scripts/tests` asserts this)
    - [ ] Given a manifest `variants` block, when the runner receives `framework=jest`, then it builds the jest argv array only and a `framework` value outside the declared variant keys returns error code `NOT_ALLOWED` with no process spawned (unit tests in `packages/development/lib/toolchain/__tests__/runner.test.js`)
    - [ ] Given each new adapter directory, when the TRD-008 allowlist validator runs, then every binary and subcommand used by a capability template appears in that adapter's `allowlist` and the run exits 0
- [ ] **TRD-044** Contracts and default adapters for container-deploy, iac, platform-cloud and package-runner: `packages/development/toolchain/categories/container-deploy.yaml` (build-image, deploy; docker, kubectl, helm, flyctl as named in `packages/infrastructure/skills/{kubernetes,helm,flyio}/SKILL.md`), `iac.yaml` (plan, apply, destroy; terraform), `platform-cloud.yaml` (get-resource, deploy-service; aws CLI per `packages/infrastructure/skills/aws/SKILL.md`), `package-runner.yaml` (run-script, install; npm); ship `adapter-container-deploy-docker-kubectl`, `adapter-iac-terraform`, `adapter-platform-cloud-aws`, `adapter-package-runner-npm` under `packages/infrastructure/skills/` (package-runner under `packages/core/skills/`), each with `SKILL.md` vocabulary block and `adapter.yaml` marking `deploy`, `apply`, `destroy` as `sideEffect: true` [satisfies REQ-001, REQ-006, REQ-018] [depends: TRD-001, TRD-005, TRD-007, TRD-008, TRD-012] (7h)
  - Implementation AC:
    - [ ] Given the four new contract files, when the category-contract schema check runs, then it passes and every capability states inputs, outputs and required or optional status
    - [ ] Given each new `adapter.yaml`, when TRD-007 conformance and TRD-008 allowlist validation run, then all four pass with exit code 0
    - [ ] Given `iac.apply` and `container-deploy.deploy`, when `toolchain-cli run` is called without a passing preflight record for the run id, then it fails with `PREFLIGHT_REQUIRED` because the contract marks them `sideEffect: true`
    - [ ] Given the four adapters' `env` lists, when the credential scan of TRD-008 runs, then it finds only variable names (for example `AWS_PROFILE`) and zero literal values
- [ ] **TRD-045** Refactor ci, review and test prose to capabilities: replace tool binaries in the implement-trd-beads test step (`packages/development/commands/implement-trd-beads.yaml`), `packages/development/skills/pr-review-cycle/SKILL.md`, `packages/quality/skills/pr-review-remediation/SKILL.md` and `packages/git/skills/act-local-ci/SKILL.md` with `toolchain-cli preflight/run` calls on `test-runner.run`, `ci-local.run-workflow` and `review.get-review-state`, declare them in each command's `capabilities:` field, and move tool-specific prose into the matching adapter `SKILL.md` [satisfies REQ-015] [depends: TRD-022, TRD-042, TRD-043, TRD-036] (6h)
  - Implementation AC:
    - [ ] Given `packages/development/commands/implement-trd-beads.yaml`, when `npm run validate` runs, then the command schema accepts its `capabilities:` block and no test-runner binary (jest, pytest, mix, dotnet, rspec) appears outside an adapter
    - [ ] Given `pr-review-cycle/SKILL.md` and `pr-review-remediation/SKILL.md`, when searched for the review bot and CI runner names, then zero matches remain outside `adapter-review-coderabbit` and `adapter-ci-local-act`
    - [ ] Given an unconfigured project, when the refactored test step is rendered, then it calls `toolchain-cli run test-runner.run` whose default adapter resolves to the same per-language runner scripts as before (checked by the TRD-049 snapshot)
    - [ ] Given the Claude, OpenCode, Pi and Codex generators, when `npm run generate` runs, then it exits 0 and the generated files for these commands contain the same capability calls
    - [ ] Given each edited command, when its body is read, then it opens with `toolchain-cli preflight --require` listing exactly the ids in its `capabilities.required`, calls `toolchain-cli confirm-status` before its first write outside the local working tree in a category and, when it reports `confirmed:false` in an interactive session, asks through `AskUserQuestion` then calls `confirm-record`, and under `--foreman` passes `--non-interactive` and never prompts
- [ ] **TRD-046** Unshipped-alternative error and default-only invariant for every category other than tracker and host (workflow keeps its plain-git and git-town pair under I1; work-graph keeps its fallback): resolver returns error code `UNKNOWN_ADAPTER` naming the category and the shipped adapter names when config selects an adapter not shipped; `scripts/lib/default-only-check.js` fails `npm run validate` if a restricted category has more than one shipped adapter or none [satisfies REQ-018] [depends: TRD-003, TRD-006, TRD-042, TRD-043, TRD-044, TRD-036, TRD-027] (4h)
  - Validates PRD ACs: AC-018-1, AC-018-2
  - Implementation AC:
    - [ ] Given the shipped tree, when `default-only-check` lists adapters per category for worktree, ci-local, review, lint, test-runner, e2e-quality, container-deploy, iac, platform-cloud and package-runner, then each has exactly one adapter and one contract file in `packages/development/toolchain/categories/`
    - [ ] Given a fixture adding a second adapter directory for the `iac` category, when the check runs, then it exits 1 naming `iac` and both adapter names
    - [ ] Given `.ensemble/toolchain.yaml` selecting `iac: pulumi`, when `toolchain-cli resolve` runs, then it exits non-zero with `UNKNOWN_ADAPTER`, the message names `iac` and lists `terraform` (unit test in `packages/development/lib/toolchain/__tests__/resolve.test.js`)
- [ ] **TRD-046-TEST** Verify categories other than tracker and host ship default-only and reject unshipped selections [verifies TRD-046] [satisfies REQ-018] [depends: TRD-046] (3h)
  - Validates PRD ACs: AC-018-1, AC-018-2
  - Test AC:
    - [ ] Scenario: Other categories have contract and one default only -- Given the first release tree, When the categories other than tracker and host are inspected, Then each has a contract file in `packages/development/toolchain/categories/` and exactly one default adapter directory and no alternative adapter
    - [ ] Scenario: Unshipped alternative fails naming category and available adapters -- Given a user config selecting an unshipped adapter for the `iac` category, When `toolchain-cli resolve` runs, Then resolution fails with `UNKNOWN_ADAPTER`, naming `iac` and the available adapter `terraform`

### PR 11: Lint, equivalence, documentation
**Shippable State:** Maintainers get CI that fails when a tool binary or an unmapped tool appears in a shared command, agent or skill, users who configure nothing see unchanged command behavior, and adapter authors, users and downstream forks have published contract, authoring and migration documentation.

- [ ] **TRD-047** Create `scripts/lint-provider-refs.js` modeled on `scripts/lint-model-ids.js`: exported `findSourceFiles(root)`, `findViolations(content, binaries)`, `lintRoot(root)` returning `[{file, line, binary, class}]`, and `main()` guarded by `if (require.main === module)`; scans `packages/*/{commands,agents,skills}/**` (`.yaml`, `.md`) excluding `adapter-*` directories and generated trees (`packages/pi`, `packages/full`, `packages/codex`, `packages/opencode`), matches tool binaries from adapter `binaries[]` plus a seed `packages/development/toolchain/tool-inventory.yaml`, exits 1 from the first release with each violation class (`BINARY_IN_COMMAND`, `BINARY_IN_AGENT`, `BINARY_IN_SKILL`) and `file:line`, plus `MISSING_PREFLIGHT` (a command with non-empty `capabilities.required` that lacks a `toolchain-cli preflight --require` line listing exactly those ids) and `MISSING_BASH_GRANT` (a command declaring capabilities whose `allowed_tools`, when present, omits `Bash`); commit fixture `scripts/tests/fixtures/provider-refs/violation/packages/bad/commands/bad.yaml`; append `&& node scripts/lint-provider-refs.js` to the `validate` script in root `package.json` [satisfies REQ-015, REQ-019] [depends: TRD-008, TRD-028, TRD-029, TRD-030, TRD-031, TRD-039, TRD-045, TRD-036] (7h)
  - Validates PRD ACs: AC-015-1, AC-019-1, AC-019-2, AC-019-3
  - Implementation AC:
    - [ ] Given the repository after the command refactors, when `node scripts/lint-provider-refs.js` runs from the root, then it exits 0 for `implement-trd-beads`, `beads-build`, `beads-build-wave`, `implement-bead`, `refine-beads`, `fix-issue` and `pr-merge` and `skills/git-town`, and prints the count of files scanned
    - [ ] Given a temp ROOT whose `packages/x/commands/y.yaml` contains a line `gh pr create` on line 7, when `lintRoot(tmpRoot)` runs, then it returns one violation with `file` ending `y.yaml`, `line` 7, `binary` `gh` and `class` `BINARY_IN_COMMAND`
    - [ ] Given a temp ROOT whose `packages/x/skills/adapter-host-gh/SKILL.md` names `gh pr create`, when `lintRoot(tmpRoot)` runs, then it returns zero violations
    - [ ] Given a temp command declaring `capabilities.required: [tracker.show]` with no preflight line, when `lintRoot` runs, then it returns class `MISSING_PREFLIGHT` naming the file; given `allowed_tools: [Read]` alongside any declared capability, then it returns `MISSING_BASH_GRANT`; given a correct preflight line and `Bash` granted, then it returns neither
    - [ ] Given `require('./lint-provider-refs')` from a test, when it loads, then no scan runs and no `process.exit` is called (the `require.main` guard), and `npm run validate` fails when the fixture tree is scanned as ROOT
- [ ] **TRD-047-TEST** Verify the hardcoding lint passes clean sources, flags violations, exempts adapters and fails on its fixture [verifies TRD-047] [satisfies REQ-015, REQ-019] [depends: TRD-047] (4h)
  - Validates PRD ACs: AC-015-1, AC-019-1, AC-019-2, AC-019-3
  - Test AC:
    - [ ] Scenario: Heaviest-coupled commands name no tool binary -- Given the sources of `implement-trd-beads`, `beads-build`, `beads-build-wave`, `implement-bead`, `refine-beads`, `fix-issue`, `pr-merge`, `git-town` and `pr-review-cycle`, When `lintRoot(repoRoot)` runs in `scripts/tests/lint-provider-refs.test.js`, Then it reports no violation for any of those files
    - [ ] Scenario: Added tool binary fails naming file and line -- Given a temp ROOT with a shared command source that adds `br list` on line 12, When the lint runs, Then it exits 1 and its output contains the file path and `:12`
    - [ ] Scenario: Adapter naming its own binary passes -- Given a temp ROOT with an `adapter-*` skill file naming its own tool binary, When the lint runs, Then it exits 0 for that file
    - [ ] Scenario: Lint fails on the committed deliberate-violation fixture -- Given the fixture `scripts/tests/fixtures/provider-refs/violation`, When the test suite runs the lint with that directory as ROOT, Then it exits 1 and names `bad.yaml`
- [ ] **TRD-048** Taxonomy coverage check: complete `packages/development/toolchain/tool-inventory.yaml` (tool binary to exactly one of the 14 categories, plus `ignoredCommands` for generic shell words) and add `scripts/lib/taxonomy-coverage.js` plus `scripts/check-taxonomy-coverage.js` (guarded by `require.main`, exported `checkCoverage(root)`): a tool mapped to two categories fails, a command-position token in a shared source's fenced shell block that is neither in the inventory nor in `ignoredCommands` fails with class `UNMAPPED_TOOL`, naming file and tool, and every category in `packages/development/toolchain/categories/` must have exactly one default in `packages/development/toolchain/toolchain.default.yaml` whose adapter directory exists; wire into `npm run validate` [satisfies REQ-001, REQ-006] [depends: TRD-001, TRD-003, TRD-042, TRD-043, TRD-044, TRD-024, TRD-036, TRD-047] (5h)
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-006-1
  - Implementation AC:
    - [ ] Given the shipped tree, when `checkCoverage(repoRoot)` runs, then every tool in `packages/development/toolchain/tool-inventory.yaml` maps to exactly one category and the result has zero errors
    - [ ] Given a temp ROOT with a command containing a fenced block starting `frobnicate --go`, when `checkCoverage(tmpRoot)` runs, then it returns an error with `class` `UNMAPPED_TOOL`, the file path and tool `frobnicate`
    - [ ] Given a temp inventory listing `docker` under both `container-deploy` and `iac`, when the check runs, then it errors naming `docker` and both categories
    - [ ] Given `packages/development/toolchain/toolchain.default.yaml` missing the `lint` default or naming a nonexistent adapter directory, when the check runs, then it errors naming the category
- [ ] **TRD-048-TEST** Verify taxonomy coverage and default adapter presence checks can fail [verifies TRD-048] [satisfies REQ-001, REQ-006] [depends: TRD-048] (3h)
  - Validates PRD ACs: AC-001-1, AC-001-2, AC-006-1
  - Test AC:
    - [ ] Scenario: Every inventoried tool maps to exactly one category -- Given the tool inventory of shared command, agent and skill sources, When `checkCoverage` checks each tool against the taxonomy, Then every tool maps to exactly one category and a duplicated mapping in a fixture is reported
    - [ ] Scenario: Unmapped tool fails naming file and tool -- Given a shared source fixture that invokes a tool belonging to no category, When validation runs, Then it fails and names the file and the unmapped tool
    - [ ] Scenario: Every category has a default adapter -- Given each of the 14 categories in the taxonomy, When shipped adapters are listed from `packages/development/toolchain/toolchain.default.yaml` and the adapter directories, Then each category has a default adapter and a fixture removing one default makes the check fail
- [ ] **TRD-049** Default-equivalence snapshot tests: add `scripts/lib/instruction-sequence.js` (extracts the ordered `[binary, subcommand]` tool-step sequence from a pre-refactor command body, and from a post-refactor body by resolving each `toolchain-cli run` or `preflight` capability call through the default adapter manifest's argv template), commit goldens captured from the pre-refactor git ref recorded by TRD-028 in `scripts/tests/fixtures/default-equivalence/BASE_REF` (the commit before TRD-028 landed) into `scripts/tests/fixtures/default-equivalence/*.json`, and add `scripts/tests/default-equivalence.test.js` covering `list-issue`, `requirement-status`, `analyze-complexity`, `onboard`, `retro`, `refine-beads`, `implement-bead`, `beads-build-wave`, `beads-build`, `implement-trd-beads`, `pr-merge`, `fix-issue` and the test, review and CI steps refactored in TRD-045, with no configuration present [satisfies REQ-024] [depends: TRD-028, TRD-029, TRD-030, TRD-031, TRD-039, TRD-045, TRD-037] (7h)
  - Validates PRD ACs: AC-024-1, AC-024-2
  - Implementation AC:
    - [ ] Given `BASE_REF` and an unconfigured temp project, when the test extracts pre-refactor sequences with `git show <BASE_REF>:<path>` and post-refactor sequences from the current tree for each listed command, then each pair is deeply equal and the test lists any differing step by index
    - [ ] Given the `pr-merge` and `implement-bead` change-request steps, when sequences are extracted post-refactor, then the host steps equal the golden default-host sequence (`gh pr create` then `gh pr view` then `gh pr merge` in the golden order)
    - [ ] Given a mutated copy of one default adapter template (a changed subcommand), when the test runs against it, then it fails naming the command and step index
    - [ ] Given `scripts/tests/fixtures/default-equivalence/`, when `git ls-files` lists it, then one golden JSON per covered command is committed and `BASE_REF` holds a 40-character commit id
- [ ] **TRD-049-TEST** Verify default-toolchain equivalence for refactored commands and the change-request sequence [verifies TRD-049] [satisfies REQ-024] [depends: TRD-049] (3h)
  - Validates PRD ACs: AC-024-1, AC-024-2
  - Test AC:
    - [ ] Scenario: Refactored commands match pre-refactor snapshots -- Given an unconfigured project with no `.ensemble/toolchain.yaml`, When the refactored commands are generated, Then the default-toolchain instruction-sequence snapshots equal the pre-refactor goldens for every covered command
    - [ ] Scenario: Opening a change request yields the same default-host sequence -- Given an unconfigured project, When a refactored command opens a change request, Then it produces the same default-host instruction sequence (same binaries, subcommands and order) as the pre-refactor golden
- [ ] **TRD-050** Documentation: generate `docs/toolchain/contracts/<category>.md` for the 14 categories plus `docs/toolchain/contracts/README.md` from `packages/development/toolchain/categories/*.yaml` via `scripts/generate-contract-docs.js` (exported `renderContract`, `require.main` guard; capabilities with inputs, outputs, required or optional, sideEffect, fallback, contract version); write `docs/guides/adapter-authoring.md` (skill directory layout, `adapter.yaml` fields, vocabulary block, allowlist, health checks, conformance via `toolchain-cli validate`, repo-local and user locations) and `docs/guides/toolchain-migration.md` (one section per lint class `BINARY_IN_COMMAND`, `BINARY_IN_AGENT`, `BINARY_IN_SKILL`, `MISSING_PREFLIGHT`, `MISSING_BASH_GRANT`, `UNMAPPED_TOOL` with a before and after example, plus `ENSEMBLE_PR_BACKEND` and `ENSEMBLE_BRANCHING_STRATEGY` mapping to config); add Unreleased entries to root `CHANGELOG.md` and `CHANGELOG.md` of `packages/core`, `packages/development`, `packages/git`, `packages/quality`, `packages/e2e-testing`, `packages/infrastructure`, and link the guides from root `README.md` and `packages/core/README.md` [satisfies REQ-025] [depends: TRD-004, TRD-018, TRD-047, TRD-048, TRD-042, TRD-043, TRD-044] (6h)
  - Validates PRD ACs: AC-025-1, AC-025-2
  - Implementation AC:
    - [ ] Given `packages/development/toolchain/categories/`, when `node scripts/generate-contract-docs.js --check` runs, then it exits 0 only if each of the 14 `docs/toolchain/contracts/<category>.md` files matches regenerated output and exits 1 naming a stale file
    - [ ] Given `docs/guides/adapter-authoring.md`, when read, then it documents the sections `Layout`, `Manifest fields`, `Allowlist`, `Health checks`, `Validate` and names `toolchain-cli validate` and the locations `.ensemble/adapters/` and `$XDG_CONFIG_HOME/ensemble/adapters/`
    - [ ] Given the exported lint classes of `scripts/lint-provider-refs.js` and `scripts/lib/taxonomy-coverage.js`, when each class code is searched in `docs/guides/toolchain-migration.md`, then each appears as a heading followed by a before and after example
    - [ ] Given the root `CHANGELOG.md`, when its `## [Unreleased]` section is read, then it contains an `### Added` entry for the tool abstraction layer and the guides, and each touched package CHANGELOG has a matching entry
- [ ] **TRD-050-TEST** Verify the contract spec, authoring guide and migration guide exist and cover every lint failure class [verifies TRD-050] [satisfies REQ-025] [depends: TRD-050] (2h)
  - Validates PRD ACs: AC-025-1, AC-025-2
  - Test AC:
    - [ ] Scenario: Contract spec and authoring guide exist -- Given the first release tree, When documentation is checked in `scripts/tests/toolchain-docs.test.js`, Then `docs/toolchain/contracts/` holds one file per category from `packages/development/toolchain/categories/` and `docs/guides/adapter-authoring.md` exists and is non-empty
    - [ ] Scenario: Migration guide documents a fix for each lint failure class -- Given a downstream fork with hardcoded tool references, When it reads `docs/guides/toolchain-migration.md`, Then every class exported by the lint (`BINARY_IN_COMMAND`, `BINARY_IN_AGENT`, `BINARY_IN_SKILL`, `MISSING_PREFLIGHT`, `MISSING_BASH_GRANT`, `UNMAPPED_TOOL`) has a section with a documented fix, and adding a new class to the export without a section fails the test

## Quality Requirements

- **Coverage:** unit tests at least 60% and integration tests at least 50% for `packages/development/lib/toolchain/` and `packages/development/lib/toolchain-cli.js` (constitution section 3). Tests run under root `npx jest scripts/tests` and workspace `npm test`.
- **Security:** no literal credentials in config, manifests or records (TRD-008, TRD-015); no shell invocation anywhere in the runner (TRD-010, TRD-011); output validated before use (TRD-012); OWASP injection and credential-handling considerations are covered by the Threat Model above.
- **Performance:** resolution and detection without health checks complete in under 500 ms (median of five runs) on a 1,000-file repository; preflight health checks run concurrently, so a command's added start-up delay is bounded by its slowest single check (10 s hard cap).
- **Default behavior:** an unconfigured project produces the same instruction sequences as before the refactors (TRD-049).
- **Operability:** every failure carries a typed code (`NOT_ALLOWED`, `HEALTH_FAILED`, `PREFLIGHT_REQUIRED`, `BAD_OUTPUT`, `AMBIGUOUS_PROVIDER`, `UNKNOWN_ADAPTER`, `NOT_INSTALLED`, `UNAVAILABLE`, `TIMEOUT`, `TOOL_FAILED`, `INVALID_ARG`) naming the category, adapter and capability; `toolchain-cli explain` reports provider and source (TRD-004).
- **Documentation:** contract spec per category, adapter authoring guide and migration guide, plus changelog entries (TRD-050).
- **Approvals:** this TRD proposes an architecture change; constitution section 4 requires explicit approval before implementation starts. The requester selected the manifest-plus-runner architecture; no new runtime dependency is introduced (I6).

## Design Readiness Review

### Architecture Self-Critique

Issues found in the draft and their resolutions (all applied above):

1. **Capability-name drift.** The tracker contract (TRD-023) named `dep` and `comment`, while the command refactors used `dep-add`, `dep-remove` and `comments`. Resolution: the contract now defines `comment`, `comments`, `dep-add`, `dep-remove`, and TRD-024 maps them.
2. **Missing manifest feature.** The test-runner adapter needs one capability to select among five frameworks. Resolution: an optional `variants` key in the manifest schema (TRD-005) and runner (TRD-010); values outside the declared variants are rejected as `NOT_ALLOWED`.
3. **Unreachable preflight and confirmation.** No command refactor called `confirm-status`, and three did not call `preflight`, so REQ-011 and REQ-013 would not be reachable from the command entry point (constitution Rule 6). Resolution: every refactored command gains a preamble acceptance criterion, and the lint adds `MISSING_PREFLIGHT` and `MISSING_BASH_GRANT` classes (TRD-047, documented by TRD-050).
4. **Unpinned golden baseline.** TRD-049's pre-refactor goldens had no committed baseline. Resolution: TRD-028, the first refactor, commits `BASE_REF` before editing any command.
5. **Assumed adapter CLI syntax.** The jira and Azure CLI subcommand names were not verified against the tools. Resolution: TRD-032, TRD-033 and TRD-040 each record the CLI help output as a fixture and assert every allowlist entry exists in it.
6. **PRD interpretations.** Nine interpretations (I1 to I9 in the Architecture Decision) resolve PRD gaps and one contradiction (REQ-009 AC-2 versus REQ-010 AC-2). A PRD refine pass is recommended to fold I1, I2 and I8 back into the PRD.

### Task Coverage Analysis

Every PRD requirement has an implementation task and a test task; every one of the 64 PRD ACs is owned by exactly one implementation task and restated as exactly one scenario in its test task; no task cites a nonexistent REQ; all 11 PRs carry a user-observable `**Shippable State:**`. `node packages/development/lib/trd-cli.js parse` on the Master Task List returns `ok: true`, 87 tasks (50 implementation, 37 test) and no warnings.

### Dependency and Estimate Review

- The dependency graph is acyclic with no forward references across PRs; the longest chain is 15 tasks and 94h (ending at TRD-050-TEST). PR 6 to PR 8 (trackers) and PR 9 (host and workflow) can proceed in parallel once PR 5 lands, which shortens the practical critical path.
- Total estimate 414h (307h implementation, 107h test). No task is 8h or longer.
- Lower-confidence estimates: TRD-043 (five test-runner frameworks plus a fix to the pytest runner, 7h), TRD-020 (Codex and OpenCode generators handle only the old skill layout, 7h) and TRD-025 (internal CLI routing with unchanged behavior, 7h). If any exceeds 7h it should be split before starting.
- Implicit dependency: TRD-017 starts with a spike on session identity; its outcome can change how often users are prompted but not the interfaces.

### Testability Review

Every Implementation AC states an observable pass or fail with concrete file, code or exit status; none uses unmeasured words. Every `-TEST` task carries one `Scenario:` per PRD AC it validates. Checks that gate acceptance are shown capable of failing: a deliberately broken adapter fixture (TRD-009), a deliberate-violation lint fixture (TRD-047), a taxonomy fixture (TRD-048) and a mutated default-adapter template (TRD-049) (constitution Rule 7).

PRD BDD floor: fourteen PRD requirements (REQ-001, 002, 004, 005, 006, 009, 010, 012, 015, 018, 021, 022, 024, 025) have two ACs, below the command's three-scenario floor. Their test tasks specify one scenario per AC; recommend a PRD refine pass to add edge or error ACs.

### Refinement 1.0.1

Eight findings from the first review pass, all applied:

1. **Packaging.** The resolver lived in `packages/core`, but `packages/development` (where `toolchain-cli` and `trd-cli` live) depends only on `js-yaml`, so a standalone plugin install could not load it. The library, category contracts, default selection, schemas and tool inventory now ship inside `packages/development` (`lib/toolchain/` and `toolchain/`); `packages/e2e-testing` calls `toolchain-cli` through `TOOLCHAIN_CLI` (I10; TRD-038).
2. **Non-interactive detection.** TRD-017 treated "no TTY" as non-interactive, but `toolchain-cli` always runs inside agent shells, so every interactive session would have skipped confirmation. Only explicit signals count now.
3. **Stale runner references.** TRD-021 and TRD-037 named `npm test` and `node --test`; the suites run under root `npx jest scripts/tests` and the development package's jest.
4. **State not ignored.** `.ensemble/state/` is added to `.gitignore` (TRD-015).
5. **Concurrent writes.** Confirmations are one file per key written by temp file plus rename, and ledger lines are single appends (TRD-015, TRD-017).
6. **Missing paired tests.** Nine test tasks added (TRD-028, 029, 030, 031, 032, 033, 036, 039, 040 `-TEST`) for the command refactors and the alternative and default adapters, verifying each task's own Implementation ACs.
7. **Serial chain.** TRD-029 and TRD-030 no longer depend on each other or on TRD-028; critical path shortened from 17 tasks (106h) to 15 tasks (94h).
8. **Preflight latency.** Health checks run concurrently (TRD-014) and resolution has a 500 ms median budget (TRD-004); both recorded under Quality Requirements.

Design Readiness re-score: unchanged at 4.0. The packaging and detection defects are fixed, but the residual risks recorded in the Threat Model (raw-shell denial on non-Claude hosts, session identity) and the lower-confidence estimates remain.

### Design Readiness Scorecard

| Dimension | Score | Basis |
|---|---|---|
| Architecture completeness | 4 | Components, data flow, formats, error paths, threat model all specified; residual risks are raw-shell denial on non-Claude hosts and the session-id dependency |
| Task coverage | 5 | 25 of 25 REQs and 64 of 64 ACs covered with tests; parser accepts all tasks |
| Dependency clarity | 4 | Explicit and acyclic; a 17-task longest chain |
| Estimate confidence | 3 | Several tasks touch generators and CLIs not read in full; adapter CLI syntax is verified by tasks, not yet known |
| **Overall** | **4.0** | **PASS (4.0+)** |

## Acceptance Criteria Traceability

| REQ-NNN | Description | Implementation Tasks | Test Tasks |
|---|---|---|---|
| REQ-001 | Capability taxonomy covering all tool categories | TRD-001, TRD-035, TRD-042, TRD-043, TRD-044, TRD-048 | TRD-048-TEST |
| REQ-002 | Capability contract per category | TRD-001, TRD-012, TRD-023, TRD-035 | TRD-001-TEST, TRD-012-TEST |
| REQ-003 | Additive-only contract within a major version | TRD-002, TRD-007 | TRD-002-TEST |
| REQ-004 | Required capabilities and documented fallbacks | TRD-013, TRD-022, TRD-027 | TRD-013-TEST, TRD-027-TEST |
| REQ-005 | Adapters are provider skills | TRD-005, TRD-006 | TRD-005-TEST, TRD-006-TEST |
| REQ-006 | Default adapters for every category | TRD-024, TRD-036, TRD-042, TRD-043, TRD-044, TRD-048 | TRD-036-TEST, TRD-042-TEST, TRD-048-TEST |
| REQ-007 | Third-party adapters without core changes | TRD-006 | TRD-006-TEST |
| REQ-008 | Adapter conformance validation | TRD-007, TRD-009 | TRD-007-TEST, TRD-009-TEST |
| REQ-009 | Provider selection by configuration with a precedence chain | TRD-003, TRD-037 | TRD-003-TEST |
| REQ-010 | Detection with explicit failure on ambiguity | TRD-016 | TRD-016-TEST |
| REQ-011 | Confirm resolved provider interactively; deterministic in non-interactive runs | TRD-017 | TRD-017-TEST |
| REQ-012 | Explain mode | TRD-004 | TRD-004-TEST |
| REQ-013 | Preflight health check before any side effect | TRD-014 | TRD-014-TEST |
| REQ-014 | Mid-run failure policy (report only) | TRD-015 | TRD-015-TEST |
| REQ-015 | Commands and skills depend on capabilities, not tools | TRD-022, TRD-028, TRD-029, TRD-030, TRD-031, TRD-034, TRD-038, TRD-039, TRD-045, TRD-047 | TRD-028-TEST, TRD-029-TEST, TRD-030-TEST, TRD-031-TEST, TRD-034-TEST, TRD-039-TEST, TRD-047-TEST |
| REQ-016 | Tracker swap, end to end (first alternatives: Jira Cloud and Azure Boards) | TRD-025, TRD-026, TRD-027, TRD-029, TRD-030, TRD-031, TRD-032, TRD-033, TRD-034 | TRD-025-TEST, TRD-027-TEST, TRD-029-TEST, TRD-030-TEST, TRD-031-TEST, TRD-032-TEST, TRD-033-TEST, TRD-034-TEST |
| REQ-017 | Source-control host swap, end to end (first alternative: Azure DevOps) | TRD-033, TRD-040, TRD-041 | TRD-033-TEST, TRD-040-TEST, TRD-041-TEST |
| REQ-018 | Other categories registered with default adapters only | TRD-043, TRD-044, TRD-046 | TRD-046-TEST |
| REQ-019 | Hardcoding lint | TRD-047 | TRD-047-TEST |
| REQ-020 | Execution layer follows the resolved tracker | TRD-023, TRD-024, TRD-027 | TRD-024-TEST, TRD-027-TEST |
| REQ-021 | Identical resolution across generated runtimes | TRD-018, TRD-019, TRD-020, TRD-021 | TRD-021-TEST |
| REQ-022 | Credentials and input validation at the adapter boundary | TRD-008, TRD-010, TRD-012 | TRD-008-TEST, TRD-012-TEST |
| REQ-023 | Governed boundary and per-adapter command allowlist | TRD-008, TRD-010, TRD-011 | TRD-008-TEST, TRD-011-TEST |
| REQ-024 | Default equivalence with no configuration | TRD-036, TRD-037, TRD-049 | TRD-036-TEST, TRD-049-TEST |
| REQ-025 | Contract documentation, authoring guide and migration guide | TRD-050 | TRD-050-TEST |

## Changelog

| Version | Date | Changes |
|---|---|---|
| 1.0.1 | 2026-10-21 | Refinement pass. Moved the resolver library, contracts, default selection, schemas and tool inventory into `packages/development` so standalone installs and the Pi bundle contain them (I10, TRD-019, TRD-038); removed TTY-based non-interactive detection (TRD-017); corrected stale test-runner references (TRD-021, TRD-037); ignored `.ensemble/state/` and made confirmation and ledger writes concurrency-safe (TRD-015, TRD-017); added nine paired test tasks (TRD-028, 029, 030, 031, 032, 033, 036, 039, 040 `-TEST`); decoupled TRD-029 and TRD-030 (critical path 17 to 15 tasks, 106h to 94h); concurrent preflight health checks and a 500 ms resolution budget (TRD-014, TRD-004, Quality Requirements). Tasks 78 to 87, hours 390 to 414, readiness 4.0 unchanged. |
