# Authoring a behavior package

- **Status:** Current.
- **Date:** 2026-09-29
- **Epic:** `br-behavior-runtime-cqrs-xl24`
- **Requirements:** REQ-BEH-001 … REQ-BEH-005, REQ-CQRS-001 … REQ-CQRS-005, REQ-SAFE-001 … REQ-SAFE-008
- **See also:** [command and event reference](./behavior-command-event-reference.md) (generated),
  [cross-repository contract](./behavior-runtime-contract-v1.md)

A behavior is **data**, not code. You add one by writing files; you do not modify the runtime, and
there is no place to put a script. This is deliberate: a manifest that could carry arbitrary code
would make every behavior a trusted component, and the whole point is that a behavior is untrusted
input to a runtime that decides what it may do.

The practical consequence for you as an author: **if the runtime will not let you express it, that
is the answer, not an obstacle to route around.** There is no escape hatch, by design.

## Package layout

```
<root>/behaviors/<name>/
  behavior.yaml          # the manifest — declarative, no code
  prompts/
    investigate.md       # prompt text, referenced by agent steps
```

`<root>` is either `.ensemble/behaviors/` in a project, or `behaviors/` inside a package such as
`packages/agent-core`. Both are discovered the same way.

Prompts live in their own files rather than inline in the manifest. Editing a prompt is then a
prompt change, not a manifest change — it does not alter the manifest digest, and it takes effect
without a rebuild (REQ-BEH-003).

## Manifest

```yaml
api_version: ensemble.sunstone.dev/v1
kind: Behavior
metadata:
  name: fix-failing-test
  version: 2.0.0
trigger:
  event_type: test.failure.observed
policy:
  mode: propose            # shadow | propose | auto
  timeout: 10m
capabilities:
  tools: [read, grep]
  mutation_classes: []
  commands: [investigation.record, fix.propose, fix.verify]
execution:
  workflow:
    entrypoint: investigate
    steps: [...]
outcomes: [behavior.completed]
```

### `policy.mode`

| Mode | Meaning |
| --- | --- |
| `shadow` | Nothing is mutated and no proposal is created. The behavior runs for observation only. |
| `propose` | May create reviewable proposals. **Never** writes to your project (REQ-SAFE-001). |
| `auto` | May apply changes, subject to every other check below. |

Mode is enforced at the mutation boundary, not merely parsed. It is also *not* the last word: a
protected path is refused even in `auto` with every mutation class granted.

### `capabilities`

Three independent grants, and they do not substitute for one another:

- `tools` — what an agent step may invoke.
- `mutation_classes` — what kinds of writes are permissible at all.
- `commands` — which catalog commands this behavior may call. A tool grant confers **no** command
  authority; if the command is not listed here, it is refused regardless of mode.

## Workflow

`execution.workflow` has an `entrypoint` and a list of `steps`. Every step has a unique `id`, an
optional `timeout`, and an optional `on_failure` naming where to go when it fails. Omitting
`on_failure` terminates the workflow as `failed` — explicit, never a silent continue.

Validation is static: an unreachable step, a dangling target, an undeclared command or an
unresolvable reference is a compile error that names the behavior *and* the step, before anything
runs.

### Step kinds

There are five. There is no sixth, and no `exec`/`shell`/`script` kind.

**`agent`** — a bounded model invocation.

```yaml
- id: investigate
  kind: agent
  prompt: prompts/investigate.md
  tools: [read, grep]
  inputs: { command: "${event.command}", output: "${event.output}" }
  expect: json               # json | text
  max_output_bytes: 65536
  attempts: 1
  timeout: 5m
  on_failure: give-up
```

**`command`** — invokes a catalog command. `command` must be listed in `capabilities.commands`.

```yaml
- id: record
  kind: command
  command: investigation.record
  args:
    command: "${event.command}"
    diagnosis: "${steps.investigate.output.diagnosis}"
    evidence: "${steps.investigate.output.evidence}"
```

**`condition`** — branches on a *structured* prior result, never on prose.

```yaml
- id: confident?
  kind: condition
  left: "${steps.investigate.output.confidence}"
  operator: equals           # equals | not_equals | in | exists | not_exists
  right: high
  then: propose
  otherwise: report-only
```

**`approval`** — asks a human. Both branches are explicit; there is no default-yes.

```yaml
- id: ask
  kind: approval
  title: Apply this fix?
  message: "${steps.propose.output.summary}"
  on_approved: apply
  on_declined: declined
```

**`outcome`** — a terminal state.

```yaml
- id: declined
  kind: outcome
  outcome: behavior.completed
  status: blocked            # succeeded | inconclusive | blocked | failed
  evidence: ["${steps.propose.output.proposalRef}"]
```

### References

`${...}` resolves against a **closed** scope with exactly four roots:

| Root | Contents |
| --- | --- |
| `event` | the triggering event's payload |
| `steps` | prior step results, e.g. `${steps.investigate.output.diagnosis}` |
| `behavior` | the behavior's own metadata |
| `workspace` | workspace facts such as the root path |

Anything else — an environment variable, a file read, an arbitrary expression — is a validation
error. A reference to a step that has not run, or that does not exist, is caught at compile time.

## What the runtime will refuse

Worth knowing before you design around it:

- **A protected path.** Test files, fixtures, guardrail sources and the constitution are refused
  regardless of mode or declared authority. The cheapest way to make a failing test pass is to edit
  the test, so no amount of declared capability buys that.
- **An undeclared command,** even if the tool grant would otherwise allow the work.
- **An uncatalogued event.** The event catalog is closed; a descriptor declaring an unknown event
  fails at registration, in your build.
- **Overclaiming.** A handler that returns `accepted` cannot emit an `applied` or `verified` event —
  the registry withholds it. A proposal cannot describe itself as a completed change.
- **Verification it could not actually perform.** A reported pass alongside a suite that failed to
  load is `inconclusive`, not a pass.

## Validating your package

There is no standalone validation CLI. Validation is a library call, and the runtime performs it at
discovery — so an invalid package fails on load rather than mid-run:

| Entry point | Module | Use |
| --- | --- | --- |
| `compile(pkg, options?)` | `agent-core/src/behavior/compiler.ts` | Compile a package — `compile({ behaviors: [manifest] }, { knownCommands })`. Two arguments, not one merged object. Returns `{ ok: false, errors }` with each error naming the behavior and step. `knownCommands` checks `capabilities.commands` against the registry; omit it during discovery, when no registry exists yet. |
| `validate(manifest, options?)` | same | Validate a single manifest without compiling. |
| `validateWorkflow(input)` | `agent-core/src/workflow/validator.ts` | Workflow-only checks: reachability, dangling targets, reference resolution. |
| `simulate(pkg, event, availableTools)` | `agent-core/src/behavior/conformance.ts` | Dry-run against a candidate event: which behaviors match, and which tool grants are missing. Invokes no agent and performs no mutation. |
| `renderStatusReport(input)` | `pi-extension/src/runtime-status.ts` | The runtime's own report — what activated, events seen, dispatch states, registered commands, approval channel, agent containment. |

The most practical check while authoring is a test that calls `compile()` over your package
directory and asserts `ok`, which is what the suites in `packages/agent-core/tests` do.

Validation reports the behavior and step for each problem. A behavior that declares
`execution.graph` but no `execution.workflow` still loads, and is explicitly reported at dispatch as
having nothing to interpret — it is never silently routed to hardcoded logic.

## Worked examples

Both are real, running packages rather than illustrations:

- `.ensemble/behaviors/fix-failing-test/` — nine steps: investigate, branch on confidence, propose,
  verify in an isolated workspace, seek approval, apply.
- `.ensemble/behaviors/constitution-learning/` — six steps, triggered only by `fix.verified` with
  `verdict: passed`, proposing a constitution amendment that a separate approved step must apply.
