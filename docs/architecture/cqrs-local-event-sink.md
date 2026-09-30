# Spike 1.3: what the local event sink guarantees

- **Status:** Decided
- **Date:** 2026-09-29
- **Bead:** `br-behavior-runtime-cqrs-xl24.7`
- **Requirement:** REQ-CQRS-006, REQ-RUN-002

## The decision

Ensemble's local sink guarantees **ordering and durability of a written line, and nothing
else**. There are exactly two acceptance scopes, and neither is Foreman's:

| Scope | Guarantee |
| --- | --- |
| `local-session` | Recorded in this process only. Lost on exit. No delivery, retry, replay, recovery or approval guarantee. |
| `local-outbox` | Appended to the local evidence log before the write is acknowledged, so it survives process exit as a file. Still not a durable event store: no delivery, scheduling, retry, replay or recovery guarantee, and **no Foreman acceptance is implied**. |

These are the only two members of `AcceptanceScope` in `cqrs/event-authority.ts`. There is
deliberately **no `"foreman"` member**. Ensemble cannot produce that fact, so the type system
does not let it name one. When Foreman consumes this contract it supplies its own acceptance
vocabulary on its own side of the boundary.

## Why the type, rather than a convention

The failure being prevented is not that someone writes the wrong word in a log. It is that a
reader — human or machine — sees "accepted" and infers durability that does not exist, and then
builds a recovery story on top of it.

Before this, `LocalOutboxSink.append()` returned `void`. Nothing anywhere carried an acceptance
scope, so "the event was accepted" and "the event was written to a file in this repo" were the
same sentence. A shutdown drain existed and was observed completing, which made the illusion
more convincing rather than less.

Now every published event is accompanied by an `AcceptanceRecord` carrying the scope **and its
limits in prose**. `CommandRegistry.emit` cannot publish without one, and
`renderStatusReport` restates the limits in full on every invocation rather than abbreviating
them to a word a reader could over-read.

## Behaviour across process exit

- **In flight, process exits normally.** `session_shutdown` joins tracked dispatches
  (`drainDispatches`). This is bounded by the host's handler timeout, so it is best-effort, and
  it is the reason `local-session` promises nothing.
- **In flight, process is killed.** Whatever reached `local-outbox` is on disk. Everything else
  is gone. There is no journal, no replay, and no attempt to reconstruct.
- **Next session.** Nothing is resumed. `LocalEventMatcher` holds correlation in memory only,
  by design (TRD-016): a durable queue would imply delivery semantics and crash recovery this
  design does not provide, and implying them is worse than being explicitly in-memory.

## What is explicitly NOT built here

Per REQ-RUN-002, none of the following exist in Ensemble and none may be added without moving
the ownership boundary:

- durable activation or activation leases
- scheduling, retries, backoff, or dead-lettering
- replay or crash recovery
- production approval authority

`InvocationBudget` is the closest thing to delivery control, and it is a **local safeguard**:
it bounds invocations within one process and says nothing about another. It is not
deduplication and the code says so.

## Forwarding

Forwarding to Foreman is out of scope for this epic and is not implemented. The contract that
would make it possible is documented in
[`behavior-runtime-contract-v1.md`](./behavior-runtime-contract-v1.md). When it is implemented,
Foreman's acknowledgement introduces a new scope on Foreman's side; it does not widen either
scope above.

## Test

`agent-core/tests/command-registry.test.ts` — "local acceptance is never dressed up as Foreman
acceptance" — asserts that every published event carries `local-outbox`, that the guarantees
string states both the survival property and its limits, and that no acceptance record exposes
a Foreman-shaped field.
