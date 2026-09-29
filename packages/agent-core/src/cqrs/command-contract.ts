/**
 * Typed command contracts (REQ-CQRS-001, REQ-CQRS-003).
 *
 * A command is a *request for a state transition*. It is not the transition.
 * The distinction is the whole point of the catalog: a request that was
 * validated, queued, or turned into a proposal must never be reported with the
 * same word as one whose effect actually happened. Before this existed the
 * runtime had exactly two outcomes — a thrown error, or an object that read
 * like success — and a fix that was merely *proposed* was indistinguishable
 * from one that was applied.
 *
 * Nothing here imports a Pi/OMP type, by rule (REQ-RUN-004). Adapters translate.
 */

import { FieldSchema } from "./field-schema";
import { MutationKind } from "../behavior/mutation-guard";

/**
 * The full result vocabulary required by REQ-CQRS-003.
 *
 * `completed` is reserved for "the effect happened and was confirmed".
 * `accepted` means the request was authorized and recorded but the effect is
 * not yet observable — a proposal, for instance. They are different words
 * because they are different facts.
 */
export type CommandResultStatus =
  | "completed"
  | "accepted"
  | "awaiting_approval"
  | "rejected"
  | "malformed"
  | "unauthorized"
  | "failed";

/** Evidence attached to a result: what was examined, and where it can be re-read. */
export interface EvidenceRef {
  readonly kind: string;
  readonly ref: string;
  readonly detail?: string;
}

export interface CommandResultBase {
  readonly command: string;
  readonly commandVersion: string;
  /** Correlates request and result; stamped by the registry, never by a caller. */
  readonly correlationId: string;
  /** The request that caused this result. */
  readonly causationId: string;
  readonly evidence: readonly EvidenceRef[];
  /**
   * Event types the registry actually emitted for this result. Empty is
   * normal and meaningful: a rejected command that emits nothing says so.
   */
  readonly emitted: readonly string[];
}

export type CommandResult<TResult = unknown> =
  | (CommandResultBase & { readonly status: "completed"; readonly result: TResult })
  | (CommandResultBase & {
      readonly status: "accepted";
      readonly result: TResult;
      /** Stable handle a later command can act on (REQ-CQRS-003). */
      readonly proposalRef?: string;
    })
  | (CommandResultBase & {
      readonly status: "awaiting_approval";
      readonly approvalRef: string;
      readonly reason: string;
    })
  | (CommandResultBase & { readonly status: "rejected"; readonly reason: string })
  | (CommandResultBase & { readonly status: "malformed"; readonly reason: string })
  | (CommandResultBase & { readonly status: "unauthorized"; readonly reason: string })
  | (CommandResultBase & { readonly status: "failed"; readonly reason: string });

/** True only for statuses whose effect is known to have occurred. */
export function isEffectful(result: CommandResult): boolean {
  return result.status === "completed";
}

/** True for statuses that describe a refusal rather than an outcome. */
export function isDenial(result: CommandResult): boolean {
  return (
    result.status === "rejected" || result.status === "malformed" || result.status === "unauthorized"
  );
}

/**
 * What a handler returns. Deliberately narrower than `CommandResult`: the
 * handler decides the domain outcome, the registry owns identity, correlation,
 * evidence plumbing and event emission. A handler cannot stamp its own
 * correlation ID or claim an event was emitted (REQ-CQRS-004).
 */
export type HandlerOutcome<TResult> =
  | { readonly status: "completed"; readonly result: TResult; readonly evidence?: readonly EvidenceRef[] }
  | {
      readonly status: "accepted";
      readonly result: TResult;
      readonly proposalRef?: string;
      readonly evidence?: readonly EvidenceRef[];
    }
  | { readonly status: "rejected"; readonly reason: string; readonly evidence?: readonly EvidenceRef[] }
  | { readonly status: "failed"; readonly reason: string; readonly evidence?: readonly EvidenceRef[] };

export interface CommandRequest {
  /** Command ID, e.g. `fix.propose`. */
  readonly command: string;
  readonly args: Record<string, unknown>;
  /**
   * How the request arrived. Recorded for REQ-RUN-003 correlation and
   * deliberately NOT consulted for authorization: a tool call and a workflow
   * step must be authorized identically (REQ-CQRS-002), so letting the route
   * influence the decision would reintroduce the very split Phase 0 removes.
   */
  readonly via: "tool-call" | "workflow-step" | "direct";
  /** Behavior on whose authority the request is made. */
  readonly behavior?: string;
  /** Optional caller-supplied correlation, e.g. the triggering event's ID. */
  readonly correlationId?: string;
  readonly causationId?: string;
  /** Idempotency handle. Repeat requests with the same key return the first result. */
  readonly idempotencyKey?: string;
}

/**
 * Services a handler may use. Everything a handler is allowed to *do* to the
 * outside world arrives through here, so a handler's blast radius is readable
 * from its signature rather than from its imports.
 */
export interface CommandHandlerContext {
  readonly request: CommandRequest;
  readonly behavior?: string;
  readonly correlationId: string;
  /** Root of the workspace this command acts on. */
  readonly workspaceRoot: string;
  /**
   * Authorizes a mutation through the single chokepoint. A handler that
   * mutates without calling this is a bug the registry cannot catch, which is
   * why mutating descriptors declare their class and the registry pre-checks
   * it before the handler ever runs.
   */
  authorizeMutation(request: { mutationClass: string; path?: string; kind: MutationKind }):
    | { allowed: true }
    | { allowed: false; reason: string };
  /** Requests a human decision. Absent host ⇒ denial, never an implicit yes. */
  requestApproval(request: { title: string; message: string }): Promise<{ approved: boolean; reason: string }>;
  /** Structured log line for REQ-RUN-003 correlation. */
  log(entry: Record<string, unknown>): void;
  readonly signal?: AbortSignal;
}

export interface CommandDescriptor<TArgs = Record<string, unknown>, TResult = unknown> {
  /** Stable ID, e.g. `fix.propose`. Namespaced by dot; never renamed in place. */
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly input: FieldSchema;
  readonly result: FieldSchema;
  /**
   * Capability a behavior must declare in `capabilities.commands` to call this.
   * Separate from tool grants by rule (REQ-SAFE-003): holding `bash` never
   * implies holding `fix.apply`.
   */
  readonly requiredCapability: string;
  /**
   * Set only when the handler changes state. The registry authorizes the class
   * through `MutationGuard` *before* invoking the handler, so `mode: propose`
   * stops a mutating command at the boundary rather than inside it.
   */
  readonly mutation?: { readonly class: string; readonly kind: MutationKind };
  /** When true, the registry obtains approval before the handler runs. */
  readonly requiresApproval?: boolean;
  /** Event types this command may cause. Anything outside this list is refused. */
  readonly emits: readonly string[];
  readonly handler: (ctx: CommandHandlerContext, args: TArgs) => Promise<HandlerOutcome<TResult>>;
}

/** Erased descriptor, for storage in a heterogeneous registry. */
export type AnyCommandDescriptor = CommandDescriptor<never, unknown>;
