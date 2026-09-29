# Ensemble Behavior Runtime: CQRS and Declarative Workflow Requirements

- **Status:** Proposed implementation requirements
- **Date:** 2026-09-29
- **Repository:** Ensemble
- **Audience:** Claude Code and maintainers implementing the behavior runtime
- **Related architecture:** [Ensemble Behavior Runtime and Pi/OMP Harness](./ensemble-behavior-runtime-plan.md)
- **Related runtime TRD:** `docs/TRD/TRD-2026-0fc1c1d0-behavior-runtime-pi-harness.md`
- **Ownership boundary:** Ensemble owns portable behavior packages, validation, simulation, and local Pi/OMP execution. Foreman owns durable production activation, scheduling, recovery, approvals, and audit history.

## 1. Purpose and implementation direction

Evolve Ensemble from a collection of host-specific commands and a test-failure-specific automation path into a **behavior-driven local harness**. Behaviors define how the system responds to typed events. Skills and commands remain useful entry points, but they are not the behavior runtime and must not be the privileged state-mutation mechanism.

The implementation SHALL use CQRS principles with a small, explicit command catalog and an append-only event contract:

```text
skill / UI command / runtime event
              |
              v
       typed command request
              |
              v
   handler validates policy and evidence
              |
      authorized state transition
              |
              v
       resulting fact/event
              |
              v
 declarative behavior workflow reacts
              |
              +--> prompt / analysis / decision
              +--> another typed command request
```

The event describes an observed fact or a transition that actually occurred. It is not an unrestricted instruction to mutate state. A command expresses requested intent; its handler validates authority and invariants, performs the allowed effect, and emits the corresponding result event only after the outcome is known.

This document refines the existing behavior-runtime architecture plan. If a requirement here conflicts with the test-failure-specific orchestration or the idea that every new behavior needs custom TypeScript, follow this document for the behavior execution model. Preserve the existing Ensemble/Foreman ownership boundary and the existing command, agent, and skill formats.

## 2. Required architectural decisions

### 2.1 Behaviors are data-driven workflows, not one-off runtime branches

A behavior package SHALL define its trigger, workflow steps, prompts, declared capabilities, policy, and possible outcomes. The harness SHALL interpret a constrained, versioned workflow representation. A behavior-specific trigger or step sequence must not require adding a special `if (testFailure)` branch to the Pi extension or runner.

The first interpreter should be intentionally small: support sequential steps, event/payload references, bounded agent invocation, typed command calls, conditions on validated results, approval waits, and terminal outcomes. Do not add arbitrary JavaScript, shell snippets, or model-evaluated policies to the manifest. New workflow primitives require runtime implementation and a schema/runtime-version change; combinations of existing primitives belong in package data.

### 2.2 Configuration edits and runtime code changes are distinct

The system SHALL distinguish these cases:

- **Package-only change:** prompt text, skill text, trigger predicates, workflow ordering, supported condition values, timeout values within policy bounds, and behavior-specific labels. Validate and load these from the behavior package at activation/invocation; changing them must not require editing or rebuilding TypeScript.
- **Runtime/code change:** a new command handler or side effect, a new event schema or invariant, a new workflow primitive, a new enforcement boundary, or a change to the shared protocol. These require code, tests, and appropriate semantic/API version updates.

“Compile behavior package” may mean validating and compiling data into an in-memory execution plan. It MUST NOT imply that prompt/workflow authors must modify TypeScript or rebuild Ensemble for changes expressible by the supported package schema.

### 2.3 CQRS roles must remain separate

- **Skill:** agent-facing instructions and UX that help form a valid request. A skill may explain when to call a typed tool; its prose is not an authorization boundary.
- **Command:** a typed request for an operation or state transition. Commands have schemas, preconditions, required capability, mutation classification, and a handler.
- **Event:** an immutable record of an observed fact or completed/accepted transition. Event names and payloads come from a closed, versioned catalog.
- **Behavior:** a declarative reaction to matching events, consisting of bounded analysis and typed command requests.
- **Handler:** code-owned enforcement point that validates the request and performs an authorized effect.
- **Prompt:** replaceable guidance for an agent step. It may affect reasoning/output, but cannot grant tools, mutation rights, approvals, or policy exceptions.

Skills and agents MUST NOT write directly to event stores, claim that a mutation succeeded, choose runtime-owned identity/approval fields, or emit arbitrary event types. They may provide validated semantic payloads and evidence references through typed tools.

## 3. Functional requirements

### 3.1 Behavior package and workflow contract

**REQ-BEH-001 — Versioned behavior package.** Each behavior SHALL have a stable name, package/API version, deterministic digest, description, typed trigger, declarative workflow, policy, capability declarations, and declared outcome/event types. Package discovery and validation remain deterministic and report invalid/skipped packages explicitly.

**REQ-BEH-002 — Declarative workflow steps.** The workflow schema SHALL support, at minimum:

1. `agent`: run a bounded Pi/OMP invocation using a package-owned prompt/template, validated context, and an explicit tool grant;
2. `command`: invoke one registered typed command handler with schema-validated arguments;
3. `condition`: branch only on structured, validated prior results—not arbitrary model prose;
4. `approval`: request an explicit human decision through a configured approval adapter;
5. `outcome`: conclude with a typed result and evidence references.

Steps SHALL have stable IDs, declared inputs/outputs, timeout/cancellation behavior, and explicit failure handling. Initial implementation may support only sequential steps plus simple conditionals; it must reject unsupported constructs rather than silently skipping them.

**REQ-BEH-003 — Prompt and skill loading.** Prompt and skill files SHALL be referenced from the package, loaded without a TypeScript rebuild, and included in the behavior digest or an equivalent immutable package digest. Missing or malformed required prompt references fail activation with a visible diagnostic. Optional prompt files may use an explicitly documented fallback.

**REQ-BEH-004 — Package validation.** Validate step references, argument/result bindings, command names and schemas, event types, tool grants, mutation classes, timeout bounds, and declared outcomes before invocation. Fail closed for unknown commands, event types, workflow primitives, or capabilities. Diagnostics identify behavior and step, without suppressing unrelated valid packages.

**REQ-BEH-005 — Compatibility.** Existing commands, agents, skills, generated Pi artifacts, and optional hook adapters remain supported. Behavior workflow migration must not redefine those artifacts as event handlers or require removing them.

### 3.2 Commands, handlers, and events

**REQ-CQRS-001 — Typed command registry.** Add a provider-neutral registry of code-owned command descriptors. Each descriptor SHALL define a stable command ID/version, input schema, result schema, required capability, mutation class (if mutating), handler, and emitted event types. The Pi adapter exposes these descriptors as governed tools; workflow steps call the same registry, not a separate privileged implementation.

**REQ-CQRS-002 — Single enforcement path.** Every effectful operation initiated by a behavior—whether from a tool call or workflow step—MUST pass through the same authorization and validation boundary. There SHALL be no parallel “continuation,” direct model edit, shell-redirection, or special runner path that can perform a behavior mutation outside its declared command handler.

**REQ-CQRS-003 — Request/result distinction.** A command result SHALL distinguish accepted, rejected, malformed, unauthorized, awaiting approval, failed, and completed states as applicable. It must not describe a proposed or queued operation as completed. Results include evidence or a stable proposal reference when relevant.

**REQ-CQRS-004 — Emit events from authoritative handlers.** A command handler SHALL emit a success/result event only after confirming the corresponding transition occurred. Rejection/failure may produce a distinct diagnostic outcome event if permitted by the catalog. An agent saying “done” is not evidence that the command succeeded.

**REQ-CQRS-005 — Closed event catalog.** Events have versioned schemas and source/authority classifications. Runtime-owned fields (event ID, session/execution IDs, timestamp, source, causation/correlation, behavior identity/digest) are populated by the runtime. Agent-provided payloads are schema-validated. Unknown or context-incompatible events fail closed.

**REQ-CQRS-006 — Local versus Foreman acceptance.** Local command/event results SHALL distinguish local recording/acceptance from Foreman acceptance. Ensemble’s local outbox/evidence sink is not a durable Foreman event store and cannot claim durable scheduling, retries, replay, recovery, or production approval guarantees. The shared contract remains versioned and provider-neutral.

### 3.3 State mutation, authorization, and safety

**REQ-SAFE-001 — Proposal is non-mutating.** `policy.mode: propose` SHALL never apply candidate source, constitution, behavior, or policy changes to the user’s project. It may create a reviewable proposal through a typed proposal handler, with a stable reference and evidence.

**REQ-SAFE-002 — Explicit apply command.** Applying a proposal SHALL require an explicit typed apply command, a valid approval where policy requires one, and revalidation of the proposal against current workspace state. Approval and application are separate facts. A prompt or skill cannot manufacture approval.

**REQ-SAFE-003 — Capability separation.** Tool grants and mutation classes remain independent. Possessing `bash`, `edit`, or a custom tool SHALL NOT imply write authority. The behavior’s effective grants are enforced at the real Pi tool-call boundary and by command handlers; no prompt instruction is counted as enforcement.

**REQ-SAFE-004 — Shell and external effects.** Do not claim that post-tool file monitoring is preventive isolation. A monitor may be defense-in-depth and may report/revert supported protected-path changes, but commands requiring arbitrary shell access or external side effects need an OS/process sandbox or must not be exposed to that behavior. Document exactly what is and is not prevented.

**REQ-SAFE-005 — Workspace isolation and rollback.** Behavior mutations SHALL execute in an isolated worktree or equivalent isolated workspace wherever practical. Do not use whole-tree checkout/reset as routine rollback in the interactive user workspace. If any in-place mutation is retained, capture and restore only explicitly owned paths, detect concurrent changes, refuse stale candidates, and surface failed/partial rollback as a high-severity outcome. Never silently overwrite concurrent user edits.

**REQ-SAFE-006 — Fail-closed verification.** An auto-apply path may accept a change only when the configured verifier proves the intended target and required suite ran and passed. Unknown output, zero tests, missing runner, timeout, verifier error, or inability to attribute a result is `inconclusive` or failed—not passed. Verification adapters should return structured results; do not rely on a single generic regex as the authority across all test frameworks.

**REQ-SAFE-007 — Bounded execution.** Every behavior invocation and agent step has a bounded timeout, retry/attempt budget, cancellation path, output-size bound, and explicit failure outcome. No unbounded recursion, event-trigger loop, or automatic child-behavior cycle is allowed. Per-session duplicate suppression is a local safeguard, not a durable delivery guarantee.

**REQ-SAFE-008 — Constitution lifecycle.** A constitution change is first a typed proposal with rationale, source evidence, affected rule, and diff. It must not be written directly by an investigator or automatically accepted merely because a test was fixed. Approval/PR opening and canonical constitution application are separate, auditable operations.

### 3.4 Runtime and observability

**REQ-RUN-001 — One workflow engine.** Local Pi/OMP sessions SHALL use one workflow interpreter and one command registry. Test-failure behavior, PR behavior, and future behaviors are packages interpreted by that engine; Pi-specific APIs remain in the adapter.

**REQ-RUN-002 — Explicit local scope.** Local dispatch remains session/local execution only. Do not add production-looking durable activation, lease, scheduler, retry, or recovery APIs to Ensemble; those are Foreman responsibilities.

**REQ-RUN-003 — Correlation and logs.** Record the triggering event, behavior ID/digest, workflow step, command request/result, proposal/approval references, verification result, and terminal outcome with causation/correlation IDs. Status output must distinguish discovered, validated, matched, invoked, pending, completed, failed, and skipped states. Avoid logging secrets or unrestricted prompt/tool contents.

**REQ-RUN-004 — Adapter independence.** Shared schemas, workflow validation/interpreter contracts, command descriptors, and event semantics must not import Pi/OMP-specific types. Pi/OMP adapters translate native events/tools to the provider-neutral contract.

## 4. Reference workflow: test failure and constitution learning

The first behavior is a representative package, not a privileged special case. Its intended flow is:

```text
test.failure.observed
  -> investigate (read-only agent step; capture diagnosis/evidence)
  -> fix.propose (typed command; create candidate/proposal, do not edit project)
  -> optional isolated verification of the candidate
  -> outcome: fix.proposed | investigation.inconclusive | behavior.blocked

fix.verified / fix.applied (only when authoritative evidence exists)
  -> constitution-learning behavior may investigate recurrence/prevention
  -> constitution.propose (typed proposal; no direct constitution write)
  -> human approval / PR workflow
  -> constitution change applied or declined (separate recorded outcome)
```

A single behavior package may combine investigation and proposal steps, but the constitution-learning reaction SHOULD be independently packageable and trigger only on a verified/accepted fix event, not merely on the initial test failure. This demonstrates event-driven composition while preventing speculative constitution edits.

The event translator may recognize host test-runner activity as an observation source. Detection errors must not themselves grant mutation authority. Where runner identification or failure evidence is ambiguous, record a diagnostic or skip automation; do not trigger an apply path.

## 5. Implementation backlog and exit gates

Do the work in the following order. Keep each phase independently testable; do not begin with a broad rewrite of generated commands or all existing packages.

### Phase 0 — Resolve current runtime split and prove boundaries

**Story 0.1: Establish one behavior execution path.**
- Inventory the current continuation queue, `BehaviorRunner`, `AutofixLoop`, matcher, and event translator.
- Identify every path that can write files or execute shell/network operations.
- Remove/disable duplicate test-failure repair dispatch so one event cannot start two competing fix agents.
- Produce a migration note mapping existing behavior fields to this contract.

**Spike 0.2: Prove Pi/OMP enforcement options.**
- Determine whether Pi/OMP can provide per-invocation tools and a reliable approval/cancellation boundary.
- Test whether OS-level isolation/worktree execution is viable for the local harness.
- Document residual risks; do not label a post-tool monitor a sandbox.

**Tests:** regression test that one failure event starts at most one workflow; a propose-mode event cannot alter project files through native tools, shell redirects, subprocesses, or a continuation; concurrent user edit is preserved; process cancellation terminates child work.

**Exit gate:** one dispatch path is demonstrated and propose mode is proven non-mutating in an end-to-end hostile-tool test. If Pi cannot enforce the required boundary, keep mutation disabled pending a sandbox or safer adapter design.

### Phase 1 — Define versioned command/event contracts

**Story 1.1: Add command descriptors and handler registry.**
- Implement input/result schemas and registration/lookup.
- Centralize capability checks, mutation authorization, approval requirements, idempotency/deduplication where needed, and error mapping.
- Adapt the current governed tools to use the registry.

**Story 1.2: Complete event authority semantics.**
- Define observed, requested, proposed, verified, applied, rejected, and failed facts as separate event/result types where applicable.
- Stamp runtime-owned metadata and validate producer/transition rules.
- Ensure tool-call and workflow-step invocation use the same handlers.

**Spike 1.3: Local event sink semantics.**
- Decide what the local sink guarantees across process exit; document acceptance and forwarding behavior.
- Keep production durability/recovery explicitly outside Ensemble.

**Tests:** schema contract tests; unauthorized command denied regardless of invocation path; no emitted success event before successful handler result; unknown command/event rejected; local acceptance is never represented as Foreman acceptance; stable causation metadata across command/result events.

**Exit gate:** a test command can be proposed through one registered handler and yields a truthful typed result/event without direct agent writes.

### Phase 2 — Implement constrained workflow interpreter

**Story 2.1: Validate and compile package workflow data.**
- Add step schema and static validation for IDs, references, command bindings, event types, grants, timeout, and failure branches.
- Preserve package digests and deterministic output.

**Story 2.2: Interpret bounded steps.**
- Implement agent, command, condition, approval, and outcome steps.
- Add cancellation, step timeouts, structured outputs, and explicit terminal states.
- Keep the interpreter provider-neutral; implement Pi/OMP invocation through adapters.

**Story 2.3: Load editable package assets.**
- Load prompt/skill files and workflow data at activation/invocation.
- Demonstrate prompt/workflow edits take effect without rebuilding TypeScript while invalid changes fail validation.

**Tests:** fixture-driven workflows; deterministic condition handling; unsupported step rejected; prompt replacement visible without code rebuild; timeout/cancel/no-orphan tests; recursion and duplicate-event limits; workflow-step command denial matches direct tool-call denial.

**Exit gate:** a minimal behavior with two agent/command steps runs solely from a package and the shared interpreter; no behavior-name-specific branch exists in runtime code.

### Phase 3 — Port the test-failure vertical slice and constitution proposal

**Story 3.1: Port test-failure investigation.**
- Express detection, investigation, fix proposal, structured evidence, and outcome in behavior data plus shared typed commands.
- Remove test-specific workflow logic from the Pi adapter after parity tests pass.

**Story 3.2: Separate proposal, verification, approval, and application.**
- Provide explicit proposal artifacts and structured verifier results.
- Keep `propose` non-mutating; apply only through an authorized handler and isolated workspace after required approval.

**Story 3.3: Add constitution-learning behavior.**
- Trigger only from verified evidence; output an evidence-backed constitution proposal, not a direct write.

**Tests:** end-to-end failure → investigation → proposal; no project change in propose mode; inaccurate model success claim rejected by independent verification; zero/unrecognized tests cannot pass; unrelated concurrent edits survive; constitution proposal is never auto-applied; duplicate or recursive trigger bounded.

**Exit gate:** the reference flow is package-defined, reviewable, reproducible from fixtures, and does not mutate canonical project/constitution state without the explicit apply workflow.

### Phase 4 — Authoring, compatibility, and handoff

**Story 4.1: Improve authoring diagnostics and simulation.**
- Add package validation/preview and fixture-based simulation for event matching, workflow branches, and command authorization.
- Provide a status report with behavior digest, active package path, workflow state, and concrete skip/error reasons.

**Story 4.2: Preserve legacy integrations.**
- Run generated artifact snapshots and compatibility suites for commands/skills/agents.
- Keep host hooks optional and normalize through shared event schemas.

**Spike 4.3: Publish cross-repository contract proposal.**
- Document the provider-neutral package, event, command-result, and invocation contracts for future Foreman consumption.
- Coordinate only the contract with Foreman; do not implement durable Foreman behavior in Ensemble.

**Tests:** generated-output regression; same event fixtures produce equivalent normalized matches across local adapters; package validation/simulation have no side effects; Foreman contract conformance tests without a durable Foreman dependency.

**Exit gate:** maintainers can add or alter a behavior using package files and fixtures alone when existing primitives suffice; code changes are required only for genuinely new trusted runtime capabilities.

## 6. System-wide acceptance criteria

The implementation is acceptable only when all of the following hold:

1. A new behavior composed from existing triggers, workflow steps, prompts, and commands requires no behavior-specific TypeScript branch or npm rebuild.
2. A new side effect or invariant requires a new reviewed, typed handler and tests; prompt text cannot create that authority.
3. Skills/tools submit command requests; handlers authorize and perform effects; events report validated facts/results.
4. Every behavior mutation uses the same authorization/approval boundary regardless of how it was initiated.
5. `propose` mode demonstrably cannot mutate the user’s working tree, including through Pi native tools or shell execution.
6. Concurrent workspace edits are not lost through snapshot, rollback, or verification.
7. No verifier ambiguity, zero-test run, timeout, or malformed result is accepted as success.
8. A test-failure event cannot start overlapping fix paths or unbounded recursive behavior runs.
9. Constitution changes are evidence-backed proposals and are applied only through a separate authorized, auditable transition.
10. Behavior package prompt and workflow edits are loaded without recompiling Ensemble; package/schema errors fail clearly and fail closed.
11. Local execution and evidence claims are accurately distinguished from Foreman’s durable production guarantees.
12. Existing command/skill/agent generation remains compatible unless a separate migration is explicitly approved.

## 7. Non-goals and implementation guardrails

- Do not turn behavior manifests into arbitrary code or an unrestricted workflow DSL.
- Do not treat an LLM prompt, a skill, a behavior name, or a tool allowlist alone as a mutation sandbox.
- Do not make a generic `emit_event` available to behavior prompts as a way to assert privileged facts.
- Do not silently merge the continuation path and candidate-application path; choose one governed route and remove or strictly isolate the other.
- Do not add durable production scheduling, activation leases, retries, recovery, or approval authority to Ensemble; those belong to Foreman.
- Do not modify Foreman as part of this Ensemble implementation unless a separate, explicit task requests it.
- Do not broaden the first migration into rewriting all legacy skills, commands, or provider adapters.

## 8. Definition of done for Claude

Before implementation, Claude SHALL inspect the current checked-out branch and report any difference between this specification and the actual tree. Implement in the phase order above, preserving unrelated user changes. For each phase, add focused tests for its exit gate, run the relevant package tests/build and the repository validation checks, and report what passed, what remains unproven, and any residual safety limitation. Do not claim the harness is governed or safe merely because the manifest validates or a corrective monitor can revert some file writes.
