/**
 * The single dispatch path (Story 0.1, REQ-CQRS-002, REQ-RUN-001).
 *
 * One event, one workflow run, one command registry, one authorization
 * boundary. What this replaces is not a stylistic preference: the previous
 * runtime dispatched the same `test.failure.observed` envelope down two routes
 * simultaneously — a governed invoker that refused to write under
 * `mode: propose`, and a continuation that injected a user turn so the host
 * model wrote the file anyway. Both ran. The governed one being dead for three
 * days was invisible, because every session still looked successful.
 *
 * There is no behavior name in this file, and none may be added. A behavior
 * that declares a workflow is interpreted from its package data; a behavior
 * that declares none is skipped with a reason. Those are the only two
 * outcomes, which is what makes acceptance criterion 1 checkable by grep.
 */

import {
  AcceptanceRecord,
  RuntimeStampedEvent,
  AgentPort,
  ApprovalPort,
  BehaviorAuthority,
  BehaviorInvocation,
  BehaviorInvoker,
  CommandRegistry,
  CompiledBehaviorPackage,
  ProposalStore,
  WorkflowRunResult,
  acceptLocally,
  createCommandCatalog,
  createMutationGuard,
  createPromptLoader,
  parseDuration,
  runWorkflow,
  ApprovalGate,
} from "@sunstone-partners/ensemble-agent-core";
import { InvocationBudget } from "./invocation-budget";

export interface DispatchRecord {
  readonly behavior: string;
  readonly event: string;
  /** Present when the behavior ran. */
  readonly run?: WorkflowRunResult;
  /** Present when it did not, explaining exactly which condition fired. */
  readonly skipped?: string;
}

export interface WorkflowDispatchOptions {
  readonly rootDir: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly compiled: () => readonly CompiledBehaviorPackage[];
  /** behavior name -> package directory, for prompt loading. */
  readonly packageDirFor: (behaviorName: string) => string | undefined;
  readonly agent: AgentPort;
  readonly approval?: ApprovalGate;
  readonly log?: (entry: Record<string, unknown>) => void;
  readonly onRecord?: (record: DispatchRecord) => void;
  readonly records?: DispatchRecord[];
  /**
   * Where events emitted by command handlers go.
   *
   * Feeding them back into the session sink is what makes event-driven
   * composition real: a `constitution-learning` behavior triggers on
   * `fix.verified` rather than on the original failure, so it reacts to
   * evidence instead of to a guess (§4). The obvious hazard is a behavior
   * whose own emissions re-match its own trigger; `InvocationBudget` bounds
   * that, and it is bounded rather than forbidden because the composition is
   * the point.
   */
  readonly publish?: (event: RuntimeStampedEvent, acceptance: AcceptanceRecord) => Promise<void>;
  /** Overrides the command catalog; tests supply deterministic handlers. */
  readonly catalog?: ReturnType<typeof createCommandCatalog>;
  readonly signal?: AbortSignal;
  readonly now?: () => string;
  /** Caps invocations per issue and per session (REQ-SAFE-007). */
  readonly budget?: InvocationBudget;
}

export interface WorkflowDispatcher {
  readonly invoke: BehaviorInvoker;
  readonly records: DispatchRecord[];
  /** Registered command IDs, for status output and package validation. */
  readonly commandIds: readonly string[];
}

export function createWorkflowDispatcher(options: WorkflowDispatchOptions): WorkflowDispatcher {
  const records = options.records ?? [];
  const log = options.log ?? (() => undefined);
  const budget = options.budget ?? new InvocationBudget(1, 3);
  const store = new ProposalStore(options.rootDir);

  const approvalPort: ApprovalPort | undefined = options.approval
    ? {
        async request(input) {
          const decision = await options.approval!.request({ title: input.title, message: input.message });
          return { approved: decision.approved, reason: decision.reason };
        },
      }
    : undefined;

  const catalog = options.catalog ?? createCommandCatalog({ workspaceRoot: options.rootDir, store, now: options.now });
  const commandIds = catalog.map((c) => c.id).sort();

  const invoke: BehaviorInvoker = async (invocation: BehaviorInvocation) => {
    const behaviorName = invocation.behavior.metadata.name;
    const finish = (record: DispatchRecord): void => {
      records.push(record);
      options.onRecord?.(record);
    };

    const compiled = options.compiled().find((c) => c.manifest.metadata.name === behaviorName);
    if (!compiled) {
      finish({ behavior: behaviorName, event: invocation.event.type, skipped: "no compiled package for this behavior" });
      return;
    }

    if (!compiled.workflow) {
      // Fail closed and say which condition fired. A behavior with no workflow
      // used to fall through to hardcoded test-failure logic; now there is no
      // such fallback, and pretending there is would reintroduce the branch.
      finish({
        behavior: behaviorName,
        event: invocation.event.type,
        skipped:
          `behavior declares no execution.workflow, so the shared interpreter has nothing to run. ` +
          `Behaviors are package-defined; add an execution.workflow block.`,
      });
      return;
    }

    // Bounded per issue and per session before anything runs. A behavior whose
    // own events re-match its trigger would otherwise recurse (REQ-SAFE-007).
    const payload = invocation.event.payload as Record<string, unknown>;
    const issue =
      typeof payload?.command === "string" ? payload.command : `${invocation.event.type}:${behaviorName}`;
    const decision = budget.claim(`${behaviorName}::${issue}`);
    if (!decision.allowed) {
      log({ kind: "invocation-refused", behavior: behaviorName, reason: decision.reason });
      finish({ behavior: behaviorName, event: invocation.event.type, skipped: decision.reason });
      return;
    }

    const packageDir = options.packageDirFor(behaviorName);
    if (!packageDir) {
      finish({
        behavior: behaviorName,
        event: invocation.event.type,
        skipped: "package directory is unknown, so package assets cannot be loaded",
      });
      return;
    }

    const registry = new CommandRegistry({
      workspaceRoot: options.rootDir,
      sessionId: options.sessionId,
      executionId: options.executionId,
      approval: approvalPort
        ? { request: (input) => approvalPort.request({ ...input, signal: new AbortController().signal }) }
        : undefined,
      publish: options.publish ? { publish: options.publish } : undefined,
      log,
      now: options.now,
    });
    for (const descriptor of catalog) registry.register(descriptor);

    const authority: BehaviorAuthority = {
      name: behaviorName,
      digest: compiled.manifest.metadata.packageDigest ?? compiled.digest,
      commands: compiled.commands,
      guard: createMutationGuard(compiled),
    };

    const timeoutMs = parseDuration(compiled.manifest.policy.timeout ?? "") ?? undefined;

    const run = await runWorkflow({
      behavior: behaviorName,
      behaviorDigest: authority.digest,
      workflow: compiled.workflow,
      event: invocation.event,
      registry,
      authority,
      agent: options.agent,
      approval: approvalPort,
      loadPrompt: createPromptLoader(packageDir),
      workspaceRoot: options.rootDir,
      testCommand: compiled.manifest.execution.test_command,
      timeoutMs,
      signal: options.signal,
      log,
      now: options.now,
    });

    // Recorded with an explicit local acceptance scope so no reader has to
    // infer it, and so "Ensemble accepted this" can never be misread as
    // "Foreman accepted this" (REQ-CQRS-006).
    log({
      kind: "invocation",
      behavior: behaviorName,
      terminal: run.terminal,
      outcome: run.outcome,
      acceptance: acceptLocally("local-session").scope,
    });
    finish({ behavior: behaviorName, event: invocation.event.type, run });
  };

  return { invoke, records, commandIds };
}
