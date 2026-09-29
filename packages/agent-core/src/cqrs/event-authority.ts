/**
 * Event authority semantics (REQ-CQRS-004, REQ-CQRS-005, REQ-CQRS-006).
 *
 * The catalog in `behavior/event-catalog.ts` answers "does this event type
 * exist". It does not answer the question that actually matters at a mutation
 * boundary: *what kind of claim is this event making, and who is entitled to
 * make it?*
 *
 * Those are different questions, and conflating them is how a run reports a
 * fix as applied when nothing was written. The live precedent: a fix agent
 * produced a correct diagnosis and a correct patch in prose while holding no
 * tool that could edit a file. The reply parsed as a failure only because its
 * shape happened not to match — not because any contract forbade the claim.
 *
 * So every catalogued event carries an authority class:
 *
 *   observed   a fact about the world the runtime saw for itself
 *   requested  someone asked for something; nothing has changed
 *   proposed   a reviewable artifact exists; nothing has changed
 *   verified   an independent check ran and reported
 *   applied    a state transition happened and was confirmed
 *   rejected   a request was refused
 *   failed     an attempt ran and did not succeed
 *   diagnostic a record about the runtime itself
 *
 * and a producer class saying who may emit it: `runtime` (harness only) or
 * `handler` (a command handler, after confirming its transition). No event is
 * `agent`-produced. An agent supplies a validated payload to a typed command;
 * the command's handler decides whether the corresponding fact occurred.
 */

import { BehaviorEvent, RuntimeStampedEvent, stripRuntimeOwnedFields } from "../events";
import { FieldSchema, checkSchema, formatViolations } from "./field-schema";
import { HARNESS_EVENT_TYPES, SEMANTIC_EVENT_TYPES } from "../behavior/event-catalog";

export type EventAuthority =
  | "observed"
  | "requested"
  | "proposed"
  | "verified"
  | "applied"
  | "rejected"
  | "failed"
  | "diagnostic";

export type EventProducer = "runtime" | "handler";

export interface EventCatalogEntry {
  readonly type: string;
  readonly schemaVersion: string;
  readonly authority: EventAuthority;
  readonly producer: EventProducer;
  /** Schema for the semantic (non-runtime-owned) part of the payload. */
  readonly payload: FieldSchema;
}

/**
 * Authority classes for the fix/constitution lifecycle (§4 reference flow).
 * These are the events the command handlers emit, and the only ones whose
 * authority class is load-bearing. Everything else in the legacy catalog is
 * registered as `observed`/`runtime` so the catalog stays closed without
 * pretending to make claims about events nothing validates yet.
 */
const LIFECYCLE_ENTRIES: readonly EventCatalogEntry[] = [
  {
    type: "test.failure.observed",
    schemaVersion: "1.0.0",
    authority: "observed",
    producer: "runtime",
    payload: {
      type: "object",
      fields: {
        command: { type: "string" },
        output: { type: "string" },
        cwd: { type: "string" },
        toolName: { type: "string" },
        isError: { type: "boolean" },
        exitCode: { type: "number" },
      },
      optional: ["output", "cwd", "toolName", "isError", "exitCode"],
    },
  },
  {
    type: "test.failure.investigated",
    schemaVersion: "1.0.0",
    authority: "observed",
    producer: "handler",
    payload: {
      type: "object",
      fields: {
        command: { type: "string" },
        diagnosis: { type: "string" },
        confidence: { type: "string", enum: ["high", "medium", "low", "inconclusive"] },
        evidence: { type: "array", items: { type: "string" } },
      },
      optional: ["evidence"],
    },
  },
  {
    type: "fix.proposed",
    schemaVersion: "1.0.0",
    authority: "proposed",
    producer: "handler",
    payload: {
      type: "object",
      fields: {
        proposalRef: { type: "string" },
        issue: { type: "string" },
        paths: { type: "array", items: { type: "string" } },
        rationale: { type: "string" },
      },
      optional: ["rationale"],
    },
  },
  {
    type: "fix.verified",
    schemaVersion: "1.0.0",
    authority: "verified",
    producer: "handler",
    payload: {
      type: "object",
      fields: {
        proposalRef: { type: "string" },
        verdict: { type: "string", enum: ["passed", "failed", "inconclusive"] },
        detail: { type: "string" },
        command: { type: "string" },
        // The diagnosis that produced the proposal, carried forward (br-zcxb).
        //
        // Without it a downstream behavior — constitution-learning above all —
        // is asked to judge whether a fix implies a rule while holding only a
        // proposal reference, a verdict and a command line. It has the fact
        // that something was fixed and no account of WHY it broke, which is
        // the only part a rule can be drawn from.
        //
        // Optional because a proposal may legitimately carry neither, and a
        // missing diagnosis must read as "none was recorded" rather than
        // making the event unpublishable.
        rationale: { type: "string" },
        evidence: { type: "array", items: { type: "string" } },
      },
      optional: ["command", "rationale", "evidence"],
    },
  },
  {
    type: "fix.applied",
    schemaVersion: "1.0.0",
    authority: "applied",
    producer: "handler",
    payload: {
      type: "object",
      fields: {
        proposalRef: { type: "string" },
        paths: { type: "array", items: { type: "string" } },
        approvedBy: { type: "string" },
      },
      optional: ["approvedBy"],
    },
  },
  {
    type: "fix.rejected",
    schemaVersion: "1.0.0",
    authority: "rejected",
    producer: "handler",
    payload: {
      type: "object",
      fields: { proposalRef: { type: "string" }, reason: { type: "string" } },
      optional: ["proposalRef"],
    },
  },
  {
    type: "constitution.proposed",
    schemaVersion: "1.0.0",
    authority: "proposed",
    producer: "handler",
    payload: {
      type: "object",
      fields: {
        proposalRef: { type: "string" },
        rule: { type: "string" },
        rationale: { type: "string" },
        diff: { type: "string" },
        sourceEvidence: { type: "array", items: { type: "string" } },
      },
      optional: [],
    },
  },
  {
    type: "constitution.applied",
    schemaVersion: "1.0.0",
    authority: "applied",
    producer: "handler",
    payload: {
      type: "object",
      fields: {
        proposalRef: { type: "string" },
        path: { type: "string" },
        approvedBy: { type: "string" },
      },
      optional: ["approvedBy"],
    },
  },
  {
    type: "constitution.declined",
    schemaVersion: "1.0.0",
    authority: "rejected",
    producer: "handler",
    payload: {
      type: "object",
      fields: { proposalRef: { type: "string" }, reason: { type: "string" } },
      optional: [],
    },
  },
  {
    type: "behavior.blocked",
    schemaVersion: "1.0.0",
    authority: "diagnostic",
    producer: "runtime",
    payload: { type: "record", values: { type: "unknown" } },
  },
  {
    type: "behavior.outcome.recorded",
    schemaVersion: "1.0.0",
    authority: "diagnostic",
    producer: "runtime",
    payload: { type: "record", values: { type: "unknown" } },
  },
  {
    type: "command.rejected",
    schemaVersion: "1.0.0",
    authority: "rejected",
    producer: "runtime",
    payload: {
      type: "object",
      fields: {
        command: { type: "string" },
        status: { type: "string" },
        reason: { type: "string" },
      },
      optional: [],
    },
  },
];

/**
 * Builds the authoritative catalog.
 *
 * `behavior/event-catalog.ts` remains the ADAPTER-INGRESS list: the set
 * `normalizeEvent` will accept from a provider adapter translating native host
 * events. It is a guardrail file and is deliberately not extended here.
 *
 * This catalog is a superset, and it is the one that governs emission. The
 * lifecycle facts below are produced by command handlers inside the runtime
 * and never arrive from an adapter, so they belong to the emission contract
 * rather than to the ingress allowlist. Keeping the two separate means
 * widening what handlers may assert never widens what an adapter may inject.
 */
function buildCatalog(): Map<string, EventCatalogEntry> {
  const catalog = new Map<string, EventCatalogEntry>();
  const openPayload: FieldSchema = { type: "record", values: { type: "unknown" } };

  for (const type of HARNESS_EVENT_TYPES) {
    catalog.set(type, {
      type,
      schemaVersion: "1.0.0",
      authority: "observed",
      producer: "runtime",
      payload: openPayload,
    });
  }
  for (const type of SEMANTIC_EVENT_TYPES) {
    catalog.set(type, {
      type,
      schemaVersion: "1.0.0",
      authority: "observed",
      producer: "runtime",
      payload: openPayload,
    });
  }
  // Lifecycle entries override the permissive defaults above.
  for (const entry of LIFECYCLE_ENTRIES) catalog.set(entry.type, entry);
  return catalog;
}

const CATALOG = buildCatalog();

export function lookupEvent(type: string): EventCatalogEntry | undefined {
  return CATALOG.get(type);
}

export function eventTypes(): readonly string[] {
  return [...CATALOG.keys()].sort();
}

/** Every catalogued type that makes a claim a handler must prove before emitting. */
export const AUTHORITATIVE_AUTHORITIES: readonly EventAuthority[] = ["applied", "verified"];

/**
 * Acceptance scope (REQ-CQRS-006).
 *
 * Local recording is not Foreman acceptance and must never be spelled the same
 * way. There is deliberately no `"foreman"` member: Ensemble cannot produce
 * that fact, so it must not be able to name it. When Foreman consumes this
 * contract it supplies its own acceptance vocabulary on its own side of the
 * boundary.
 */
export type AcceptanceScope = "local-session" | "local-outbox";

export interface AcceptanceRecord {
  readonly scope: AcceptanceScope;
  /** Plain-language statement of what this scope does and does not guarantee. */
  readonly guarantees: string;
  readonly acceptedAt: string;
}

export const ACCEPTANCE_GUARANTEES: Record<AcceptanceScope, string> = {
  "local-session":
    "recorded in this process only; lost on exit; no delivery, retry, replay, recovery or approval guarantee",
  "local-outbox":
    "appended to the local evidence log before acknowledgement; survives process exit as a file, " +
    "but is not a durable event store: no delivery, scheduling, retry, replay or recovery guarantee, " +
    "and no Foreman acceptance is implied",
};

export function acceptLocally(scope: AcceptanceScope, at: string = new Date().toISOString()): AcceptanceRecord {
  return { scope, guarantees: ACCEPTANCE_GUARANTEES[scope], acceptedAt: at };
}

export interface StampInput {
  readonly type: string;
  /** Agent- or handler-supplied semantic content only. */
  readonly payload: Record<string, unknown>;
  readonly sessionId: string;
  readonly executionId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly behaviorId?: string;
  readonly behaviorDigest?: string;
  readonly source?: string;
  readonly occurredAt?: string;
}

export type StampResult =
  | { readonly ok: true; readonly event: RuntimeStampedEvent; readonly entry: EventCatalogEntry }
  | { readonly ok: false; readonly reason: string };

let sequence = 0;

/**
 * Validates an event against the closed catalog and stamps every
 * runtime-owned field (REQ-CQRS-005).
 *
 * Runtime-owned names are stripped from the supplied payload *first*. A
 * producer that tries to set its own `sessionId` does not get an error it
 * could probe for — it gets its value silently discarded and the real one
 * applied, because the goal is that the field is trustworthy, not that
 * spoofing is reported.
 */
export function stampEvent(input: StampInput): StampResult {
  const entry = CATALOG.get(input.type);
  if (!entry) {
    // Fail closed. An unknown type is not forwarded "just in case": the
    // catalog is the contract, and an event nothing can validate is an
    // assertion nothing can check.
    return { ok: false, reason: `unknown event type "${input.type}" is not in the closed catalog` };
  }

  const payload = stripRuntimeOwnedFields(input.payload);
  const check = checkSchema(entry.payload, payload);
  if (!check.valid) {
    return {
      ok: false,
      reason: `payload for "${input.type}" (schema ${entry.schemaVersion}) is invalid: ${formatViolations(check.violations)}`,
    };
  }

  sequence += 1;
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const event: RuntimeStampedEvent = {
    id: `evt-${occurredAt}-${sequence}`,
    type: input.type,
    source: input.source ?? "ensemble.runtime",
    occurredAt,
    payload,
    executionId: input.executionId,
    sessionId: input.sessionId,
    behaviorId: input.behaviorId,
    behaviorDigest: input.behaviorDigest,
    correlationId: input.correlationId,
    causationId: input.causationId,
    deduplicationKey: `${input.type}:${input.correlationId}:${input.causationId ?? ""}`,
  };
  return { ok: true, event, entry };
}

/** True when `event` is a plain (unstamped) behavior event the catalog knows. */
export function isCatalogued(event: BehaviorEvent): boolean {
  return CATALOG.has(event.type);
}
