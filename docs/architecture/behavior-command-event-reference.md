# Behavior command and event reference

- **Status:** Generated. Do not edit by hand.
- **Source:** `packages/agent-core/src/cqrs/commands.ts`, `packages/agent-core/src/cqrs/event-authority.ts`
- **Generator:** `packages/agent-core/scripts/generate-catalog-reference.ts`
- **Drift check:** `packages/agent-core/tests/catalog-reference.test.ts`

Regenerate with `npx ts-node packages/agent-core/scripts/generate-catalog-reference.ts`.

## Commands

Every command runs through one registry. Authorization is checked in a fixed order — capability, input schema, mutation class, policy mode, approval — before any handler runs, and the same code decides for a direct tool call and a workflow step. A behavior may only invoke a command it lists in `capabilities.commands`.

| Command | Capability | Mutates | Approval | Emits |
| --- | --- | --- | --- | --- |
| `investigation.record` | `investigation.record` | no | no | `test.failure.investigated` |
| `fix.propose` | `fix.propose` | no | no | `fix.proposed`, `fix.rejected` |
| `fix.verify` | `fix.verify` | no | no | `fix.verified` |
| `fix.apply` | `fix.apply` | `artifact.write` (write) | **required** | `fix.applied`, `fix.rejected` |
| `constitution.propose` | `constitution.propose` | no | no | `constitution.proposed` |
| `constitution.apply` | `constitution.apply` | `constitution.write` (write) | **required** | `constitution.applied`, `constitution.declined` |
| `doc.verify` | `doc.verify` | no | no | `behavior.observation.recorded` |
| `verification.run` | `verification.run` | no | no | `behavior.observation.recorded` |
| `workspace.check` | `workspace.check` | no | no | `behavior.observation.recorded` |
| `decision.propose` | `decision.propose` | no | no | `decision.proposed` |

### `investigation.record` v1.0.0

Record a structured diagnosis for an observed test failure

- **Input:** `command: string`, `diagnosis: string`, `confidence: string`, `evidence: array`
- **Result:** `confidence: string`, `events: record`

### `fix.propose` v1.0.0

Create a reviewable fix proposal without changing the project

- **Input:** `issue: string`, `rationale: string`, `writes: array`, `evidence: array`
- **Result:** `proposalRef: string`, `paths: array`, `events: record`

### `fix.verify` v1.0.0

Run a verification command against a proposal in an isolated workspace

- **Input:** `proposalRef: string`, `command: string`, `timeoutMs: number`
- **Result:** `verdict: string`, `detail: string`, `framework: string`, `events: record`

### `fix.apply` v1.0.0

Apply a verified fix proposal to the workspace

- **Input:** `proposalRef: string`, `paths: array`
- **Result:** `proposalRef: string`, `paths: array`, `events: record`

### `constitution.propose` v1.0.0

Create an evidence-backed constitution amendment proposal

- **Input:** `rule: string`, `rationale: string`, `diff: string`, `sourceEvidence: array`
- **Result:** `proposalRef: string`, `events: record`

### `constitution.apply` v1.0.0

Apply an approved constitution amendment to the canonical constitution

- **Input:** `proposalRef: string`
- **Result:** `proposalRef: string`, `path: string`, `events: record`

### `doc.verify` v1.0.0

Check documented paths, npm scripts and exported symbols against the tree

- **Input:** `claims: array`, `sourceFiles: array`
- **Result:** `ok: boolean`, `checked: number`, `unresolved: array`, `events: record`

### `verification.run` v1.0.0

Run a verification command against the current tree in an isolated workspace

- **Input:** `command: string`, `timeoutMs: number`
- **Result:** `verdict: string`, `detail: string`, `framework: string`, `vacuous: boolean`, `events: record`

### `workspace.check` v1.0.0

Report unresolvable workspace symlinks and lockfile drift, without repairing them

- **Input:** `root: string`
- **Result:** `ok: boolean`, `findings: array`, `checked: record`, `events: record`

### `decision.propose` v1.0.0

Record an evidence-backed decision for the hand-authored agent brief

- **Input:** `decision: string`, `rationale: string`, `provenance: string`, `evidence: array`
- **Result:** `proposalRef: string`, `events: record`

## Events

The catalog is closed: a command may not emit an event that is not listed here, and registration fails at build time if a descriptor declares one. `producer` distinguishes events the runtime stamps from events a handler returns.

Authority is the claim strength of the event. Only `applied` and `verified` are authoritative — the registry withholds those from a handler that only reported `accepted`, so a proposal cannot describe itself as an applied change.

| Event | Schema | Authority | Producer | Payload |
| --- | --- | --- | --- | --- |
| `approval.requested` | 1.0.0 | `observed` | runtime | — |
| `behavior.abandoned` | 1.0.0 | `observed` | runtime | — |
| `behavior.blocked` | 1.0.0 | `diagnostic` | runtime | — |
| `behavior.completed` | 1.0.0 | `observed` | runtime | — |
| `behavior.observation.recorded` | 1.0.0 | `diagnostic` | handler | — |
| `behavior.outcome.recorded` | 1.0.0 | `diagnostic` | runtime | — |
| `command.rejected` | 1.0.0 | `rejected` | runtime | `command: string`, `status: string`, `reason: string` |
| `constitution.applied` | 1.0.0 | `applied` | handler | `proposalRef: string`, `path: string`, `approvedBy: string` |
| `constitution.declined` | 1.0.0 | `rejected` | handler | `proposalRef: string`, `reason: string` |
| `constitution.proposed` | 1.0.0 | `proposed` | handler | `proposalRef: string`, `rule: string`, `rationale: string`, `diff: string`, `sourceEvidence: array` |
| `decision.proposed` | 1.0.0 | `proposed` | handler | `proposalRef: string`, `decision: string`, `rationale: string`, `provenance: string`, `evidence: array`, `recordedAt: string` |
| `fix.applied` | 1.0.0 | `applied` | handler | `proposalRef: string`, `paths: array`, `approvedBy: string` |
| `fix.proposed` | 1.0.0 | `proposed` | handler | `proposalRef: string`, `issue: string`, `paths: array`, `rationale: string` |
| `fix.rejected` | 1.0.0 | `rejected` | handler | `proposalRef: string`, `reason: string` |
| `fix.verified` | 1.0.0 | `verified` | handler | `proposalRef: string`, `verdict: string`, `detail: string`, `command: string`, `rationale: string`, `evidence: array` |
| `implementation.abandoned` | 1.0.0 | `observed` | runtime | — |
| `implementation.blocked` | 1.0.0 | `observed` | runtime | — |
| `implementation.completed` | 1.0.0 | `observed` | runtime | — |
| `implementation.progressed` | 1.0.0 | `observed` | runtime | — |
| `implementation.started` | 1.0.0 | `observed` | runtime | — |
| `prd.approved` | 1.0.0 | `observed` | runtime | — |
| `prd.created` | 1.0.0 | `observed` | runtime | — |
| `prd.deprecated` | 1.0.0 | `observed` | runtime | — |
| `prd.refined` | 1.0.0 | `observed` | runtime | — |
| `pull_request.opened` | 1.0.0 | `observed` | runtime | — |
| `pull_request.proposed` | 1.0.0 | `observed` | runtime | — |
| `pull_request.updated` | 1.0.0 | `observed` | runtime | — |
| `release.approved` | 1.0.0 | `observed` | runtime | — |
| `release.completed` | 1.0.0 | `observed` | runtime | — |
| `release.proposed` | 1.0.0 | `observed` | runtime | — |
| `repository.branch.created` | 1.0.0 | `observed` | runtime | — |
| `repository.changed` | 1.0.0 | `observed` | runtime | — |
| `review.changes_requested` | 1.0.0 | `observed` | runtime | — |
| `review.completed` | 1.0.0 | `observed` | runtime | — |
| `review.requested` | 1.0.0 | `observed` | runtime | — |
| `runtime.message.emitted` | 1.0.0 | `observed` | runtime | — |
| `runtime.process.exited` | 1.0.0 | `observed` | runtime | — |
| `runtime.prompt.submitted` | 1.0.0 | `observed` | runtime | — |
| `runtime.session.cancelled` | 1.0.0 | `observed` | runtime | — |
| `runtime.session.completed` | 1.0.0 | `observed` | runtime | — |
| `runtime.session.failed` | 1.0.0 | `observed` | runtime | — |
| `runtime.session.started` | 1.0.0 | `observed` | runtime | — |
| `runtime.session.timed_out` | 1.0.0 | `observed` | runtime | — |
| `runtime.tool_call.completed` | 1.0.0 | `observed` | runtime | — |
| `runtime.tool_call.started` | 1.0.0 | `observed` | runtime | — |
| `test.failure.investigated` | 1.0.0 | `observed` | handler | `command: string`, `diagnosis: string`, `confidence: string`, `evidence: array` |
| `test.failure.observed` | 1.0.0 | `observed` | runtime | `command: string`, `output: string`, `cwd: string`, `toolName: string`, `isError: boolean`, `exitCode: number` |
| `test.passed` | 1.0.0 | `observed` | runtime | — |
| `test.regression_detected` | 1.0.0 | `observed` | runtime | — |
| `trd.approved` | 1.0.0 | `observed` | runtime | — |
| `trd.created` | 1.0.0 | `observed` | runtime | — |
| `trd.deprecated` | 1.0.0 | `observed` | runtime | — |
| `trd.implementation.completed` | 1.0.0 | `observed` | runtime | — |
| `trd.implementation.progressed` | 1.0.0 | `observed` | runtime | — |
| `trd.implementation.started` | 1.0.0 | `observed` | runtime | — |
| `trd.refined` | 1.0.0 | `observed` | runtime | — |

## Acceptance scopes

What it means for an event to be accepted. There is deliberately no `foreman` scope: Ensemble cannot make a durable-delivery claim it has no mechanism to honour, so the claim is not expressible.

| Scope | Guarantee |
| --- | --- |
| `local-session` | recorded in this process only; lost on exit; no delivery, retry, replay, recovery or approval guarantee |
| `local-outbox` | appended to the local evidence log before acknowledgement; survives process exit as a file, but is not a durable event store: no delivery, scheduling, retry, replay or recovery guarantee, and no Foreman acceptance is implied |
