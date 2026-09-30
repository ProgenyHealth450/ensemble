# Behavior runtime contract v1 (cross-repository proposal)

- **Status:** Proposed for Foreman review. **Nothing in Foreman has been changed.**
- **Version:** `1.0.0`
- **Date:** 2026-09-29
- **Bead:** `br-behavior-runtime-cqrs-xl24.19` (Spike 4.3)
- **Requirements:** REQ-CQRS-006, REQ-RUN-002, REQ-RUN-004

This document is the contract only. Per §7 of the implementation requirements, no durable
scheduling, lease, retry or recovery API was added to Ensemble, and Foreman was not modified.

## Ownership

| Owner | Responsibility |
| --- | --- |
| **Ensemble** | Portable behavior packages, validation, simulation, local Pi/OMP execution, local evidence. |
| **Foreman** | Durable activation, scheduling, recovery, approvals of record, audit history. |

The contract below is provider-neutral: none of these types reference a Pi/OMP concept, and the
implementing modules import no host types (REQ-RUN-004).

## 1. Behavior package

Source of truth: `agent-core/src/behavior/schema.ts`, `agent-core/src/workflow/schema.ts`.

```yaml
api_version: ensemble.sunstone.dev/v1
kind: Behavior
metadata:   { name, version, digest?, packageDigest? }
trigger:    { event_type, predicate? }
policy:     { mode: propose|auto|shadow, timeout }
capabilities:
  tools:            [...]   # what an agent step may hold
  mutation_classes: [...]   # what may be changed
  commands:         [...]   # which typed commands may be requested
execution:
  graph: <legacy, inert>
  test_command: <optional>
  workflow: { schema_version: "1.0.0", start, steps: [...] }
outcomes: [...]
```

The three capability lists are **independent axes**. Holding `bash` implies neither
`artifact.write` nor `fix.apply`. A consumer that collapses them has not implemented this
contract.

`digest` covers the manifest. `packageDigest` covers the manifest plus every referenced asset,
and is what identifies "which behavior actually ran" when prompts are editable.

### Workflow step kinds

`agent`, `command`, `condition`, `approval`, `outcome`. Sequential with simple conditionals.
An unsupported construct is **rejected, never skipped**. New primitives require a runtime
implementation and a `schema_version` bump; combinations of existing primitives are package
data.

References use `${...}` over a closed scope (`event`, `steps`, `behavior`, `workspace`).
Substitution only — no operators, no calls, no computed keys. This is deliberate: a manifest
that can compute is code, and "no behavior-specific TypeScript" would then be satisfied by
moving the TypeScript into YAML.

## 2. Command descriptor

Source of truth: `agent-core/src/cqrs/command-contract.ts`.

```ts
interface CommandDescriptor {
  id: string;               // stable, dotted, never renamed in place
  version: string;
  input: FieldSchema;       // closed: an unknown key is malformed
  result: FieldSchema;
  requiredCapability: string;
  mutation?: { class: string; kind: "write" | "delete" | "commit" };
  requiresApproval?: boolean;
  emits: readonly string[]; // must exist in the closed event catalog
}
```

Registration fails if a descriptor can emit an uncatalogued event, so the failure lands in a
developer's build rather than inside a handler that has already performed its effect.

## 3. Command result

```ts
type CommandResultStatus =
  | "completed"          // the effect happened and was confirmed
  | "accepted"           // authorized and recorded; the effect has NOT happened
  | "awaiting_approval"
  | "rejected"           // refused on policy or precondition
  | "malformed"          // did not satisfy the input schema
  | "unauthorized"       // capability, mutation class, or mode denied it
  | "failed";            // ran and did not succeed
```

`completed` and `accepted` are different words because they are different facts. A proposal is
`accepted`. Reporting it as `completed` is the defect this vocabulary exists to make
inexpressible.

Every result carries `correlationId`, `causationId`, `evidence[]`, and `emitted[]` — the event
types actually published, which may legitimately be empty.

## 4. Event authority

Source of truth: `agent-core/src/cqrs/event-authority.ts`.

Every catalogued event carries an **authority class** — `observed`, `requested`, `proposed`,
`verified`, `applied`, `rejected`, `failed`, `diagnostic` — and a **producer** class, `runtime`
or `handler`. No event is agent-produced: an agent supplies a validated payload to a typed
command, and the handler decides whether the fact occurred.

Enforced consequence: a handler that returns `accepted` cannot emit an `applied` or `verified`
event, however its result is shaped. That is REQ-CQRS-004 as a mechanism rather than a rule.

Runtime-owned fields (`id`, `sessionId`, `executionId`, `occurredAt`, `source`,
`correlationId`, `causationId`, `behaviorId`, `behaviorDigest`, `deduplicationKey`) are stamped
by the runtime and **stripped** from any supplied payload — silently, because the goal is that
the field is trustworthy, not that spoofing is reportable.

Unknown or schema-invalid events **fail closed**.

Note for implementers: `behavior/event-catalog.ts` is the adapter-INGRESS allowlist (what
`normalizeEvent` accepts from a host adapter). `cqrs/event-authority.ts` is the authoritative
EMISSION catalog and a superset. Keeping them separate means widening what handlers may assert
never widens what an adapter may inject.

## 5. Acceptance

```ts
type AcceptanceScope = "local-session" | "local-outbox";
```

There is no `"foreman"` member, by design. See
[`cqrs-local-event-sink.md`](./cqrs-local-event-sink.md). Foreman supplies its own acceptance
vocabulary on its own side; Ensemble must never be able to name it.

## 6. Invocation

```ts
interface AgentPort   { invoke(request): Promise<{ ok: true; reply } | { ok: false; reason }>; }
interface ApprovalPort{ request(input): Promise<{ approved: boolean; reason: string }>; }
```

Both are injected. The interpreter never learns how a model is reached or how a human is asked.
Ports are **required to honour the `AbortSignal`**; cancellation is part of the contract, not a
best effort.

## 7. Conformance without a durable Foreman

A consumer conforms when, with no Foreman present:

1. a package validating under §1 compiles, and one violating it is rejected with a diagnostic
   naming the behavior and the step;
2. a command invoked as a tool call and as a workflow step traverses identical authorization
   and produces an identical denial;
3. `accepted` is never reported as `completed`, and an `applied`/`verified` event is never
   emitted for a non-`completed` outcome;
4. an unknown command or event type fails closed;
5. local acceptance is never represented as Foreman acceptance.

These are exercised today by `agent-core/tests/command-registry.test.ts`,
`workflow-validator.test.ts`, `workflow-interpreter.test.ts` and `commands.test.ts`, none of
which requires a Foreman dependency.

## 8. Open questions for Foreman

1. **Forwarding.** Push from the local outbox, or pull? Ensemble has no scheduler and must not
   grow one.
2. **Approval of record.** A local `approval` step is a session-scoped human answer. Foreman's
   approval is durable and auditable. These are different facts and probably need different
   event types rather than a shared one with a scope field.
3. **Digest trust.** Foreman may want `packageDigest` pinned at activation so a package cannot
   change between approval and execution. Ensemble computes it but does not pin it.
4. **Command catalog versioning.** Ensemble's catalog is compiled in. A shared catalog needs a
   negotiation story before a behavior authored against one version runs on another.
