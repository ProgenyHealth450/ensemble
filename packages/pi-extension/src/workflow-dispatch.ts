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
  stampEvent,
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
  /**
   * Set the moment the run BEGINS, before the interpreter is entered.
   *
   * br-mr22: records used to be written only after a run resolved, so a run
   * still executing when the session ended left no trace at all. Foreman,
   * which owns the session and collects afterwards, then saw a clean
   * termination with an empty outbox — indistinguishable from "the behavior
   * matched nothing and correctly did nothing". A silent false negative in
   * the direction that looks like success.
   */
  readonly startedAt?: string;
  /**
   * Present while a run is in flight, and cleared when it resolves. A record
   * still carrying this after the session ends IS the evidence that the run
   * was cut short — absence of an outcome is reported as abandonment rather
   * than inferred as "nothing happened".
   */
  readonly abandoned?: string;
}

export interface WorkflowDispatchOptions {
  readonly rootDir: string;
  /**
   * The repository an invocation acts on, given its triggering event.
   *
   * br-x36p: every root used to be the extension host's, so a failure observed
   * in another worktree sent the whole governed run -- the agent's isolated
   * workspace, the proposal store, the verification worktree -- at a
   * repository the failing command never ran in. Defaults to `rootDir`.
   */
  readonly rootFor?: (event: BehaviorInvocation["event"]) => string;
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

  const approvalPort: ApprovalPort | undefined = options.approval
    ? {
        async request(input) {
          const decision = await options.approval!.request({ title: input.title, message: input.message });
          return { approved: decision.approved, reason: decision.reason };
        },
      }
    : undefined;

  const catalogFor = (root: string) =>
    options.catalog ?? createCommandCatalog({ workspaceRoot: root, store: new ProposalStore(root), now: options.now });
  const commandIds = catalogFor(options.rootDir)
    .map((c) => c.id)
    .sort();

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

    // The repository THIS invocation acts on (br-x36p). Commands, the
    // interpreter and the agent port all take it from here, so one run cannot
    // straddle two repositories.
    const root = options.rootFor?.(invocation.event) ?? options.rootDir;
    const catalog = catalogFor(root);

    const registry = new CommandRegistry({
      workspaceRoot: root,
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

    // The record goes in BEFORE the interpreter is entered, not after it
    // returns (br-mr22). The session's lifetime is not ours to control:
    // Foreman launches it and collects afterwards, so a run that is still
    // executing when the session ends must leave evidence that it STARTED.
    // Writing only on resolution made "cut short" and "correctly did nothing"
    // produce byte-identical output.
    const startedAt = (options.now ?? (() => new Date().toISOString()))();
    const slot = records.length;
    const started: DispatchRecord = {
      behavior: behaviorName,
      event: invocation.event.type,
      startedAt,
      abandoned: "run began but did not resolve; the session likely ended first",
    };
    records.push(started);
    options.onRecord?.(started);
    log({ kind: "invocation-started", behavior: behaviorName, event: invocation.event.type, startedAt });

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
      workspaceRoot: root,
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

    // Replace the in-flight record in place. `abandoned` is dropped, which is
    // what makes its PRESENCE meaningful to a reader after the fact.
    const resolved: DispatchRecord = { behavior: behaviorName, event: invocation.event.type, run, startedAt };
    records[slot] = resolved;
    options.onRecord?.(resolved);

    // Publish the outcome so another behavior can react to it (br-j46q).
    //
    // Until now the interpreter computed `terminal` and `outcome`, every
    // manifest DECLARED them under `outcomes:`, the compiler validated that
    // list — and nothing ever published them. An author declared an outcome,
    // the compiler checked it, the run reached it, and the runtime dropped
    // it. Command events already re-enter the sink so a behavior can react to
    // `fix.verified`; this is the missing half of the same design.
    //
    // Mapping, and the distinctions in it are load bearing:
    //
    //   succeeded    -> behavior.completed         (authority: observed)
    //   inconclusive -> behavior.outcome.recorded  (authority: diagnostic)
    //   blocked      -> behavior.blocked           (authority: diagnostic)
    //   failed |
    //   cancelled    -> behavior.abandoned         (authority: observed)
    //
    // `inconclusive` gets its own event on purpose. It first fell through to
    // `behavior.completed`, which quietly reported "we could not tell" as
    // "it worked" — the same overclaim this session built the whole
    // vacuous-test-run behavior to catch, where `status: inconclusive` is
    // used precisely so a suite that ran nothing is never called a pass.
    // Making that mistake in the event layer would have undone it everywhere
    // downstream. `behavior.outcome.recorded` carries authority "diagnostic"
    // rather than "observed", which is exactly the weaker claim wanted here.
    //
    // The catalog has no `behavior.failed`, so a run that did not reach a
    // declared outcome is `behavior.abandoned` and carries its real terminal
    // state in the payload. Still one event per run, never two.
    if (options.publish) {
      const type =
        run.terminal === "blocked"
          ? "behavior.blocked"
          : run.terminal === "inconclusive"
            ? "behavior.outcome.recorded"
            : run.terminal === "failed" || run.terminal === "cancelled"
              ? "behavior.abandoned"
              : "behavior.completed";
      const stamped = stampEvent({
        type,
        payload: { behavior: behaviorName, terminal: run.terminal, outcome: run.outcome, reason: run.reason },
        sessionId: options.sessionId,
        executionId: options.executionId,
        correlationId: `${options.executionId}:${behaviorName}`,
        causationId: invocation.event.type,
        behaviorId: behaviorName,
        behaviorDigest: authority.digest,
      });
      if (stamped.ok) {
        await options.publish(stamped.event, acceptLocally("local-session"));
      } else {
        // Fail loudly rather than silently dropping it — a swallowed outcome
        // is the exact defect this block exists to fix.
        log({ kind: "outcome-publish-refused", behavior: behaviorName, type, reason: stamped.reason });
      }
    }
  };

  return { invoke, records, commandIds };
}
