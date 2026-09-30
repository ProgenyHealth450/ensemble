/**
 * The command registry: one authorization boundary, one invocation path
 * (REQ-CQRS-001, REQ-CQRS-002, REQ-CQRS-004).
 *
 * The defect this replaces is structural rather than incidental. Previously a
 * governed dispatch route authorized writes through `MutationGuard`, and an
 * ungoverned continuation route performed the same writes through the host
 * model's own tools. Both were "the runtime". A behavior running in
 * `mode: propose` was refused on one and obeyed on the other, in the same run,
 * on the same file.
 *
 * `execute()` is therefore the only way to run a command, and every check that
 * could ever say no lives inside it, in a fixed order, before the handler is
 * reached:
 *
 *   1. the command exists                       → malformed
 *   2. the behavior declares the capability      → unauthorized
 *   3. arguments satisfy the input schema        → malformed
 *   4. the mutation class is authorized by the
 *      behavior's MutationGuard (mode included)  → unauthorized
 *   5. approval, where the descriptor requires it → awaiting_approval
 *   6. the handler runs
 *   7. the result satisfies the result schema     → failed
 *   8. events are emitted, and ONLY for outcomes
 *      that earned them
 *
 * `request.via` is recorded and never consulted. A workflow step and a Pi tool
 * call reach step 1 with the same shape and traverse the same code, so "denied
 * as a tool call but allowed as a workflow step" is not expressible.
 */

import { checkSchema, formatViolations } from "./field-schema";
import {
  AnyCommandDescriptor,
  CommandDescriptor,
  CommandHandlerContext,
  CommandRequest,
  CommandResult,
  EvidenceRef,
  HandlerOutcome,
} from "./command-contract";
import { MutationGuard, MutationKind, SANCTIONED_PROTECTED_CLASS } from "../behavior/mutation-guard";
import { AcceptanceRecord, acceptLocally, lookupEvent, stampEvent } from "./event-authority";
import { RuntimeStampedEvent } from "../events";

export interface ApprovalRequester {
  request(input: { title: string; message: string }): Promise<{ approved: boolean; reason: string }>;
}

/** Where stamped events go once a handler has earned them. */
export interface CommandEventPublisher {
  publish(event: RuntimeStampedEvent, acceptance: AcceptanceRecord): Promise<void>;
}

export interface BehaviorAuthority {
  readonly name: string;
  readonly digest: string;
  /** Commands this behavior declares in `capabilities.commands`. */
  readonly commands: readonly string[];
  readonly guard: MutationGuard;
}

export interface CommandRegistryOptions {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly approval?: ApprovalRequester;
  readonly publish?: CommandEventPublisher;
  readonly log?: (entry: Record<string, unknown>) => void;
  /** Injectable for deterministic tests. */
  readonly now?: () => string;
}

interface Invocation {
  readonly request: CommandRequest;
  readonly authority?: BehaviorAuthority;
  readonly signal?: AbortSignal;
}

// Re-exported for callers that reach the catalog through this module. The
// declaration lives beside the guard check it governs, in
// `behavior/mutation-guard.ts`; importing it in that direction is the one that
// does not create a cycle.
export { SANCTIONED_PROTECTED_CLASS };

let requestSequence = 0;

export class CommandRegistry {
  private readonly descriptors = new Map<string, AnyCommandDescriptor>();
  private readonly idempotency = new Map<string, CommandResult>();

  constructor(private readonly options: CommandRegistryOptions) {}

  register<TArgs, TResult>(descriptor: CommandDescriptor<TArgs, TResult>): void {
    if (this.descriptors.has(descriptor.id)) {
      throw new Error(`command "${descriptor.id}" is already registered`);
    }
    // A descriptor that can emit an event the catalog does not know would
    // fail at emission time, in production, inside a handler that already
    // performed its effect. Catching it at registration keeps the failure in
    // the developer's build instead.
    for (const type of descriptor.emits) {
      if (!lookupEvent(type)) {
        throw new Error(
          `command "${descriptor.id}" declares emitted event "${type}", which is not in the closed catalog`,
        );
      }
    }

    // `constitution.write` is the one mutation class MutationGuard lets past
    // its protected-path refusal (br-9uqd: "WriteBoundaryMonitor must permit
    // exactly that one authorized write"). That carve-out is keyed on the
    // class alone, and a class comes from this descriptor -- never from
    // behavior data -- so today it is reachable only through
    // `constitution.apply`, which requires approval.
    //
    // "Today" is the problem. Nothing stops a later descriptor from declaring
    // the same class without `requiresApproval`, which would silently widen a
    // human-gated hole into an open one, in a file far from the guard that
    // grants it. Pin the coupling here, where the class is chosen.
    if (descriptor.mutation?.class === SANCTIONED_PROTECTED_CLASS && !descriptor.requiresApproval) {
      throw new Error(
        `command "${descriptor.id}" declares mutation class "${SANCTIONED_PROTECTED_CLASS}", which is ` +
          `permitted to write a protected path, but does not set requiresApproval; ` +
          `refusing to register an unapproved route to the constitution`,
      );
    }
    this.descriptors.set(descriptor.id, descriptor as unknown as AnyCommandDescriptor);
  }

  has(id: string): boolean {
    return this.descriptors.has(id);
  }

  get(id: string): AnyCommandDescriptor | undefined {
    return this.descriptors.get(id);
  }

  /** Registered command IDs, sorted — used by status output and validation. */
  ids(): readonly string[] {
    return [...this.descriptors.keys()].sort();
  }

  /**
   * Answers "would this command be permitted" without running it.
   *
   * Package validation (REQ-BEH-004) needs this, and so does simulation. It
   * deliberately shares the capability/mutation checks with `execute()` rather
   * than reimplementing them, because a preview that can disagree with the
   * real decision is worse than no preview.
   */
  checkAuthorization(
    commandId: string,
    authority: BehaviorAuthority | undefined,
    path?: string,
  ): { allowed: boolean; reason: string } {
    const descriptor = this.descriptors.get(commandId);
    if (!descriptor) return { allowed: false, reason: `unknown command "${commandId}"` };
    const capability = this.checkCapability(descriptor, authority);
    if (!capability.allowed) return capability;
    return this.checkMutation(descriptor, authority, path);
  }

  private checkCapability(
    descriptor: AnyCommandDescriptor,
    authority: BehaviorAuthority | undefined,
  ): { allowed: boolean; reason: string } {
    if (!authority) {
      return {
        allowed: false,
        reason: `command "${descriptor.id}" requires capability "${descriptor.requiredCapability}" but the request carries no behavior authority`,
      };
    }
    if (!authority.commands.includes(descriptor.requiredCapability)) {
      return {
        allowed: false,
        reason:
          `behavior "${authority.name}" does not declare command capability "${descriptor.requiredCapability}" ` +
          `(capabilities.commands: [${authority.commands.join(", ") || "none"}])`,
      };
    }
    return { allowed: true, reason: "capability declared" };
  }

  private checkMutation(
    descriptor: AnyCommandDescriptor,
    authority: BehaviorAuthority | undefined,
    path?: string,
  ): { allowed: boolean; reason: string } {
    if (!descriptor.mutation) return { allowed: true, reason: "non-mutating command" };
    if (!authority) {
      return { allowed: false, reason: `mutating command "${descriptor.id}" requires behavior authority` };
    }
    const decision = authority.guard.authorize({
      mutationClass: descriptor.mutation.class,
      kind: descriptor.mutation.kind as MutationKind,
      path,
    });
    return decision.allowed
      ? { allowed: true, reason: "mutation authorized" }
      : { allowed: false, reason: decision.reason };
  }

  async execute<TResult = unknown>(invocation: Invocation): Promise<CommandResult<TResult>> {
    const { request, authority, signal } = invocation;
    requestSequence += 1;
    const now = this.options.now ?? (() => new Date().toISOString());
    const causationId = request.causationId ?? `cmd-${now()}-${requestSequence}`;
    const correlationId = request.correlationId ?? causationId;

    const descriptor = this.descriptors.get(request.command);
    const base = {
      command: request.command,
      commandVersion: descriptor?.version ?? "unknown",
      correlationId,
      causationId,
    };

    const deny = async (
      status: "malformed" | "unauthorized" | "rejected" | "failed",
      reason: string,
      evidence: readonly EvidenceRef[] = [],
    ): Promise<CommandResult<TResult>> => {
      // A refusal is itself a fact worth recording, and it is the only event a
      // denied command may produce. Notably it is NOT the command's own
      // success event: REQ-CQRS-004 is that a success event follows a
      // confirmed transition, so a rejection path must never reach for one.
      const emitted = await this.emit(
        "command.rejected",
        { command: request.command, status, reason },
        { correlationId, causationId, authority },
      );
      this.log({ kind: "command-result", command: request.command, status, reason, via: request.via });
      return { ...base, status, reason, evidence, emitted } as CommandResult<TResult>;
    };

    if (!descriptor) {
      return deny("malformed", `unknown command "${request.command}"`);
    }

    if (request.idempotencyKey) {
      const cached = this.idempotency.get(`${request.command}:${request.idempotencyKey}`);
      if (cached) return cached as CommandResult<TResult>;
    }

    const capability = this.checkCapability(descriptor, authority);
    if (!capability.allowed) return deny("unauthorized", capability.reason);

    const argCheck = checkSchema(descriptor.input, request.args);
    if (!argCheck.valid) {
      return deny(
        "malformed",
        `arguments for "${descriptor.id}" do not satisfy its input schema: ${formatViolations(argCheck.violations)}`,
      );
    }

    // Path-scoped mutation pre-check. `args.path`/`args.paths` are the
    // conventional carriers; checking here means `mode: propose` refuses a
    // mutating command before its handler exists on the stack, rather than
    // relying on every handler to remember to ask.
    const paths = collectPaths(request.args);
    if (descriptor.mutation) {
      if (paths.length === 0) {
        const decision = this.checkMutation(descriptor, authority);
        if (!decision.allowed) return deny("unauthorized", decision.reason);
      }
      for (const path of paths) {
        const decision = this.checkMutation(descriptor, authority, path);
        if (!decision.allowed) return deny("unauthorized", decision.reason);
      }
    }

    if (descriptor.requiresApproval) {
      if (!this.options.approval) {
        return deny(
          "unauthorized",
          `command "${descriptor.id}" requires approval but no approval channel is configured; ` +
            `failing closed rather than proceeding unasked`,
        );
      }
      const decision = await this.options.approval.request({
        title: `Run ${descriptor.id}?`,
        message: descriptor.description,
      });
      if (!decision.approved) {
        const emitted = await this.emit(
          "command.rejected",
          { command: descriptor.id, status: "awaiting_approval", reason: decision.reason },
          { correlationId, causationId, authority },
        );
        this.log({ kind: "command-result", command: descriptor.id, status: "awaiting_approval", reason: decision.reason });
        return {
          ...base,
          status: "awaiting_approval",
          approvalRef: `${correlationId}:${descriptor.id}`,
          reason: decision.reason,
          evidence: [],
          emitted,
        } as CommandResult<TResult>;
      }
    }

    const ctx: CommandHandlerContext = {
      request,
      behavior: authority?.name,
      correlationId,
      workspaceRoot: this.options.workspaceRoot,
      authorizeMutation: (req) => {
        const decision = this.checkMutation(descriptor, authority, req.path);
        return decision.allowed ? { allowed: true } : { allowed: false, reason: decision.reason };
      },
      requestApproval: async (req) => {
        if (!this.options.approval) {
          return { approved: false, reason: "no approval channel configured; failing closed" };
        }
        return this.options.approval.request(req);
      },
      log: (entry) => this.log({ command: descriptor.id, correlationId, ...entry }),
      signal,
    };

    let outcome: HandlerOutcome<unknown>;
    try {
      outcome = await (descriptor.handler as unknown as CommandDescriptor["handler"])(
        ctx,
        request.args as never,
      );
    } catch (error) {
      // A thrown handler is a failure, never a rejection: the difference is
      // whether the system decided or merely broke, and reporting a crash as
      // a policy decision would hide a bug behind a governance message.
      return deny("failed", `handler for "${descriptor.id}" threw: ${(error as Error).message}`);
    }

    if (outcome.status === "rejected") return deny("rejected", outcome.reason, outcome.evidence ?? []);
    if (outcome.status === "failed") return deny("failed", outcome.reason, outcome.evidence ?? []);

    const resultCheck = checkSchema(descriptor.result, outcome.result);
    if (!resultCheck.valid) {
      // The handler believes it succeeded and cannot prove it in the declared
      // shape. Emitting its success event here is exactly the "agent said
      // done" failure at one remove, so it does not get one.
      return deny(
        "failed",
        `handler for "${descriptor.id}" returned a result that does not satisfy its result schema: ${formatViolations(resultCheck.violations)}`,
      );
    }

    const emitted: string[] = [];
    for (const eventType of descriptor.emits) {
      const entry = lookupEvent(eventType);
      if (!entry) continue;
      // `applied`/`verified` events assert that something happened. Only a
      // `completed` outcome has established that. An `accepted` outcome
      // produced a proposal, and a proposal is not an application.
      if ((entry.authority === "applied" || entry.authority === "verified") && outcome.status !== "completed") {
        continue;
      }
      if (entry.authority === "proposed" && outcome.status !== "accepted" && outcome.status !== "completed") {
        continue;
      }
      const payload = eventPayloadFor(eventType, outcome, request);
      if (!payload) continue;
      const published = await this.emit(eventType, payload, { correlationId, causationId, authority });
      emitted.push(...published);
    }

    const result: CommandResult<TResult> =
      outcome.status === "completed"
        ? ({
            ...base,
            status: "completed",
            result: outcome.result as TResult,
            evidence: outcome.evidence ?? [],
            emitted,
          } as CommandResult<TResult>)
        : ({
            ...base,
            status: "accepted",
            result: outcome.result as TResult,
            proposalRef: outcome.proposalRef,
            evidence: outcome.evidence ?? [],
            emitted,
          } as CommandResult<TResult>);

    this.log({
      kind: "command-result",
      command: descriptor.id,
      status: result.status,
      via: request.via,
      behavior: authority?.name,
      emitted,
    });

    if (request.idempotencyKey) {
      this.idempotency.set(`${request.command}:${request.idempotencyKey}`, result as CommandResult);
    }
    return result;
  }

  private async emit(
    type: string,
    payload: Record<string, unknown>,
    ctx: { correlationId: string; causationId: string; authority?: BehaviorAuthority },
  ): Promise<string[]> {
    const stamped = stampEvent({
      type,
      payload,
      sessionId: this.options.sessionId,
      executionId: this.options.executionId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      behaviorId: ctx.authority?.name,
      behaviorDigest: ctx.authority?.digest,
      occurredAt: this.options.now?.(),
    });
    if (!stamped.ok) {
      this.log({ kind: "event-rejected", type, reason: stamped.reason });
      return [];
    }
    if (this.options.publish) {
      // Acceptance is named at the point of recording so no downstream reader
      // has to infer it, and the only names available are local ones.
      await this.options.publish.publish(stamped.event, acceptLocally("local-outbox", stamped.event.occurredAt));
    }
    return [type];
  }

  private log(entry: Record<string, unknown>): void {
    this.options.log?.(entry);
  }
}

function collectPaths(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  if (typeof args.path === "string") paths.push(args.path);
  if (Array.isArray(args.paths)) {
    for (const p of args.paths) if (typeof p === "string") paths.push(p);
  }
  if (Array.isArray(args.writes)) {
    for (const w of args.writes) {
      const p = (w as { path?: unknown })?.path;
      if (typeof p === "string") paths.push(p);
    }
  }
  return paths;
}

/**
 * Derives an event payload from a handler outcome.
 *
 * The handler names the facts; the registry decides which of them are
 * publishable and stamps identity onto them. A handler returning a result
 * without the fields an event needs simply produces no event — silence is a
 * correct outcome, and fabricating a payload to fill the gap would be the
 * dishonesty this whole layer exists to prevent.
 */
function eventPayloadFor(
  eventType: string,
  outcome: HandlerOutcome<unknown>,
  request: CommandRequest,
): Record<string, unknown> | undefined {
  const result = (outcome as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) return undefined;
  const record = result as Record<string, unknown>;
  const declared = record.events;
  if (typeof declared === "object" && declared !== null) {
    const forType = (declared as Record<string, unknown>)[eventType];
    if (typeof forType === "object" && forType !== null) return forType as Record<string, unknown>;
    // The handler enumerated its events and this one is not among them.
    return undefined;
  }
  void request;
  return undefined;
}
